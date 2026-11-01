// stripe-handler: who may open a billing portal or start a checkout (security audit 2026-11-01).
// Runs the real function file with its web imports stubbed, a fake database and a fake Stripe.
// Usage: node tools/stripe-handler-test.mjs [path-to-index.ts]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(HERE, '..', 'supabase', 'functions', 'stripe-handler', 'index.ts');
const FUTURE = new Date(Date.now() + 36e5).toISOString(), PAST = new Date(Date.now() - 36e5).toISOString();

const tables = {
  admin_sessions: [
    { token: 'tokOwner', admin_id: 'a1', expires_at: FUTURE },
    { token: 'tokCo', admin_id: 'a2', expires_at: FUTURE },
    { token: 'tokOther', admin_id: 'b1', expires_at: FUTURE },
    { token: 'tokExpired', admin_id: 'a1', expires_at: PAST },
    { token: 'tokGone', admin_id: 'a3', expires_at: FUTURE },
  ],
  admins: [
    { id: 'a1', email: 'owner@acme.test', parent_admin_id: null, status: 'active', plan: 'free', stripe_customer_id: 'cus_A1', extra_seats: 0, scheduling_addon: false, stripe_subscription_id: null },
    { id: 'a2', email: 'co@acme.test', parent_admin_id: 'a1', status: 'active', plan: 'free', stripe_customer_id: null },
    { id: 'b1', email: 'owner@other.test', parent_admin_id: null, status: 'active', plan: 'free', stripe_customer_id: 'cus_B1' },
    { id: 'a3', email: 'gone@acme.test', parent_admin_id: null, status: 'suspended', plan: 'free', stripe_customer_id: null },
  ],
};
const updates = [];
const makeBuilder = (name) => {
  const conds = []; let op = 'select', patch = null;
  const b = {
    select() { return b; }, eq(k, v) { conds.push([k, v]); return b; }, is(k, v) { conds.push([k, v]); return b; },
    update(p) { op = 'update'; patch = p; return b; }, upsert() { return b; }, insert() { return b; },
    async maybeSingle() { const r = (tables[name] || []).filter(x => conds.every(([k, v]) => x[k] === v)); return { data: r[0] ?? null }; },
    then(res) { if (op === 'update') updates.push({ name, patch, conds }); return Promise.resolve({ data: null }).then(res); },
  };
  return b;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-test-'));
const src = fs.readFileSync(file, 'utf8')
  .replace(/^import \{ serve \}.*$/m, 'const serve = (h) => { globalThis.__H = h; };')
  .replace(/^import \{ createClient \}.*$/m, 'const createClient = () => globalThis.__FAKE_SB;')
  .replace(/^import \{ crypto \}.*$/m, 'const crypto = globalThis.__WC;');
const out = path.join(scratch, 'h.ts');
fs.writeFileSync(out, "globalThis.Deno={env:{get:(k)=>({STRIPE_SECRET_KEY:'sk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x',SUPABASE_URL:'https://fake.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'svc-key',RESEND_API_KEY:'re_x'}[k])}};\n" + src);
globalThis.__FAKE_SB = { from: makeBuilder };
globalThis.__WC = webcrypto;
const stripeCalls = []; const mailCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/')) {
    const body = decodeURIComponent(String(init.body || ''));
    stripeCalls.push({ path: u.replace('https://api.stripe.com/v1/', ''), body });
    return new Response(JSON.stringify({ id: 'cus_new', url: 'https://stripe.test/session' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('resend.com')) { mailCalls.push(u); return new Response('{}', { status: 200 }); }
  return new Response('{}', { status: 200 });
};
await import(pathToFileURL(out).href + '?v=' + Date.now());
const handler = globalThis.__H;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
async function call(action, body, headers = {}) {
  stripeCalls.length = 0; mailCalls.length = 0; updates.length = 0;
  const res = await handler(new Request(`https://fn/stripe-handler/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  let j = null; try { j = await res.json(); } catch { /* not json */ }
  return { status: res.status, json: j, stripe: [...stripeCalls], mail: [...mailCalls], updates: [...updates] };
}

console.log('\n── checkout ──');
let r = await call('checkout', { plan: 'starter', adminId: 'a1', adminEmail: 'a@b.c' });
ok('no session: refused, Stripe never called', r.status === 401 && r.stripe.length === 0);
r = await call('checkout', { plan: 'starter', sessionToken: 'tokExpired' });
ok('expired session: refused', r.status === 401 && r.stripe.length === 0);
r = await call('checkout', { plan: 'starter', sessionToken: 'tokGone' });
ok('suspended account: refused', r.status === 401 && r.stripe.length === 0);
r = await call('checkout', { plan: 'starter', sessionToken: 'x&admin_id=neq.0' });
ok('malformed token: refused', r.status === 401 && r.stripe.length === 0);
r = await call('checkout', { plan: 'starter', sessionToken: 'tokCo' });
ok('a co-admin cannot change the subscription', r.status === 403 && r.stripe.length === 0);
r = await call('checkout', { plan: 'starter', sessionToken: 'tokOwner' });
const sess = r.stripe.find(s => s.path === 'checkout/sessions');
ok('owner: a checkout session is created', r.status === 200 && r.json.url === 'https://stripe.test/session' && !!sess);
ok('it charges the starter price', sess && sess.body.includes('line_items[0][price]=price_1TM5NRIhFqyQNAEWBIazJeAo'));
ok('for the signed-in owner\'s own Stripe customer', sess && sess.body.includes('customer=cus_A1') && sess.body.includes('metadata[adminId]=a1'));
r = await call('checkout', { plan: 'starter', sessionToken: 'tokOwner', adminId: 'b1', adminEmail: 'evil@x.test' });
const s2 = r.stripe.find(s => s.path === 'checkout/sessions');
ok('a different adminId in the request is ignored', s2 && s2.body.includes('customer=cus_A1') && !s2.body.includes('cus_B1') && !s2.body.includes('metadata[adminId]=b1'));
r = await call('checkout', { plan: 'business', priceId: 'price_1TM5NMIhFqyQNAEWo4s8iSpb', sessionToken: 'tokOwner' });
const s3 = r.stripe.find(s => s.path === 'checkout/sessions');
ok('a cheaper price cannot be attached to the business plan', s3 && s3.body.includes('line_items[0][price]=price_1TM5NPIhFqyQNAEWLuYZjimL') && !s3.body.includes('o4s8iSpb') && s3.body.includes('metadata[plan]=business'));
r = await call('checkout', { plan: 'enterprise-free', sessionToken: 'tokOwner' });
ok('an unknown plan is refused', r.status === 400 && r.stripe.length === 0);
for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  r = await call('checkout', { plan: bad, sessionToken: 'tokOwner' });
  ok(`plan name "${bad}" is refused`, r.status === 400 && r.stripe.length === 0);
}
r = await call('checkout', { plan: 'growth', sessionToken: 'tokOwner', successUrl: 'https://evil.example/steal', cancelUrl: 'https://www.punchclock.ca.evil.example/' });
const s4 = r.stripe.find(s => s.path === 'checkout/sessions');
ok('redirect URLs off our domain are replaced', s4 && s4.body.includes('success_url=https://www.punchclock.ca?checkout=success') && s4.body.includes('cancel_url=https://www.punchclock.ca?checkout=cancelled') && !s4.body.includes('evil'));
r = await call('checkout', { plan: 'growth', sessionToken: 'tokOwner', successUrl: 'https://www.punchclock.ca?checkout=success&plan=growth' });
ok('our own redirect URL is kept', r.stripe.find(s => s.path === 'checkout/sessions').body.includes('success_url=https://www.punchclock.ca?checkout=success&plan=growth'));
r = await call('checkout', { plan: 'extra_seat', sessionToken: 'tokOwner' });
ok('add-ons still work (extra seat)', r.status === 200 && r.stripe.find(s => s.path === 'checkout/sessions').body.includes('price_1TM5NMIhFqyQNAEWRPqJ23ZY'));
r = await call('checkout', { plan: 'scheduling_addon', sessionToken: 'tokOwner' });
ok('add-ons still work (scheduling)', r.status === 200 && r.stripe.find(s => s.path === 'checkout/sessions').body.includes('price_1TM5NMIhFqyQNAEWo4s8iSpb'));

console.log('\n── billing portal ──');
r = await call('portal', { adminId: 'b1' });
ok('no session: another customer\'s portal cannot be opened by id', r.status === 401 && r.stripe.length === 0);
r = await call('portal', { sessionToken: 'tokOwner' });
ok('owner: their own portal', r.status === 200 && r.json.url === 'https://stripe.test/session' && r.stripe[0].body.includes('customer=cus_A1'));
r = await call('portal', { sessionToken: 'tokOwner', adminId: 'b1' });
ok('adminId of another customer is ignored', r.stripe[0].body.includes('customer=cus_A1') && !r.stripe[0].body.includes('cus_B1'));
r = await call('portal', { sessionToken: 'tokCo' });
ok('a co-admin cannot open the owner\'s portal', r.status === 403 && r.stripe.length === 0);
r = await call('portal', { sessionToken: 'tokOwner', returnUrl: 'https://evil.example' });
ok('return URL off our domain is replaced', r.stripe[0].body.includes('return_url=https://www.punchclock.ca') && !r.stripe[0].body.includes('evil'));
r = await call('portal', { sessionToken: 'tokGone' });
ok('suspended account: refused', r.status === 401);

console.log('\n── test email ──');
r = await call('test_payment_email', {});
ok('anonymous caller cannot make us mail the owner', r.status === 401 && r.mail.length === 0);
r = await call('test_payment_email', {}, { authorization: 'Bearer wrong' });
ok('wrong bearer is refused', r.status === 401 && r.mail.length === 0);
r = await call('test_payment_email', {}, { authorization: 'Bearer svc-key' });
ok('the service key may', r.status === 200 && r.mail.length === 1);

console.log('\n── unrelated paths are unchanged ──');
r = await call('whatever', {});
ok('unknown action still a 400', r.status === 400);
const w = await handler(new Request('https://fn/stripe-handler/webhook', { method: 'POST', body: '{}' }));
ok('webhook without a signature is still refused (not by the session gate)', w.status >= 400 && w.status < 500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
