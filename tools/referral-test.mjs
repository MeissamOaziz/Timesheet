// Referral program: the server side (docs/referral-program.md).
// Runs the REAL stripe-handler and secure-db files, with their web imports stubbed, against one in-memory database
// that enforces the unique rules of migration 20261201_referral_program.sql, and a fake Stripe that keeps customer
// balances, cards and invoices. Nothing touches the network.
// Usage: node tools/referral-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto, createHmac, randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FN = (n) => path.join(HERE, '..', 'supabase', 'functions', n, 'index.ts');
const DAY = 86_400_000, NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const STARTER = 'price_1TM5NRIhFqyQNAEWBIazJeAo', GROWTH = 'price_1TM5NPIhFqyQNAEW2itq6QuX', SCHED = 'price_1TM5NMIhFqyQNAEWo4s8iSpb';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x ? '  ' + x : ''}`); };

// ── in-memory database ───────────────────────────────────────────────────────────────────────────
const UNIQUE = { referrals: [['referred_admin_id']], referral_rewards: [['referral_id', 'half']], referral_codes: [['admin_id'], ['code']], processed_webhook_events: [['id']] };
const DEFAULTS = {
  referrals: () => ({ id: randomUUID(), status: 'pending', void_reason: null, discount_used_at: null, first_invoice_id: null, first_paid_at: null, second_invoice_id: null, second_paid_at: null, referred_cards: [], created_at: iso(Date.now()) }),
  referral_rewards: () => ({ id: randomUUID(), status: 'waiting', void_reason: null, stripe_txn_id: null, currency: 'cad', earned_at: iso(Date.now()), delivered_at: null }),
  referral_codes: () => ({ created_at: iso(Date.now()) }),
};
let db;
function reset() {
  db = { admins: [], admin_sessions: [], companies: [], referral_promotions: [], referral_codes: [], referrals: [], referral_rewards: [], processed_webhook_events: [], audit_log: [], internal_secrets: [] };
  stripe = { cards: {}, balance: {}, invoices: {}, calls: [], idem: {}, failPost: false, n: 0 };
  db.referral_promotions.push({ id: 'dec2026', enabled: true, starts_at: iso(NOW - 10 * DAY), ends_at: iso(NOW + 10 * DAY), discount_percent: 10, reward_cents: 1949, currency: 'cad', first_payment_days: 90, second_payment_min_days: 25, second_payment_max_days: 75, max_rewards_per_referrer: 10 });
}
function insertRow(table, row) {
  const full = { ...(DEFAULTS[table]?.() ?? {}), ...row };
  for (const cols of UNIQUE[table] ?? []) {
    if (db[table].some((r) => cols.every((c) => r[c] === full[c]))) return { error: { code: '23505', message: 'duplicate key' } };
  }
  if (table === 'referrals' && full.referrer_admin_id === full.referred_admin_id) return { error: { code: '23514', message: 'check' } };
  db[table].push(full);
  return { row: full };
}
const admin = (id, o = {}) => { const a = { id, name: id, email: `${id}@${id}.test`, parent_admin_id: null, role: 'admin', status: 'active', plan: 'free', extra_seats: 0, scheduling_addon: false, stripe_customer_id: null, stripe_subscription_id: null, created_at: iso(NOW - DAY), ...o }; db.admins.push(a); return a; };
const session = (token, admin_id) => db.admin_sessions.push({ token, admin_id, expires_at: iso(NOW + 36e5) });
const referral = (referrer, referred, o = {}) => insertRow('referrals', { promotion_id: 'dec2026', referrer_admin_id: referrer, referred_admin_id: referred, code: 'ABCDEFGH', created_at: iso(NOW - DAY), ...o }).row;

// Session tokens are looked up by a database function since 2026-11-20 (only their hash is stored).
const sessionLookup = (token) => db.admin_sessions.filter((x) => x.token === token).map((x) => ({ admin_id: x.admin_id, expires_at: x.expires_at }));
// supabase-js look-alike (stripe-handler)
function sbFrom(table) {
  const conds = []; let op = 'select', patch = null, row = null, wantRows = false;
  const match = (r) => conds.every((f) => f(r));
  const run = () => {
    if (op === 'insert') { const r = insertRow(table, row); return r.error ? { data: null, error: r.error } : { data: [r.row], error: null }; }
    if (op === 'upsert') { const i = db[table].findIndex((r) => r.id === row.id); if (i >= 0) Object.assign(db[table][i], row); else db[table].push({ ...row }); return { data: null, error: null }; }
    const rows = db[table].filter(match);
    if (op === 'update') { rows.forEach((r) => Object.assign(r, patch)); return { data: wantRows ? rows.map((r) => ({ ...r })) : null, error: null }; }
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const b = {
    select() { if (op !== 'select') wantRows = true; return b; },
    eq(k, v) { conds.push((r) => r[k] === v); return b; },
    is(k, v) { conds.push((r) => (r[k] ?? null) === v); return b; },
    in(k, vs) { conds.push((r) => vs.includes(r[k])); return b; },
    update(p) { op = 'update'; patch = p; return b; },
    insert(r) { op = 'insert'; row = r; return b; },
    upsert(r) { op = 'upsert'; row = r; return b; },
    async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}

// PostgREST look-alike (secure-db)
function rest(method, url, init) {
  const u = new URL(url); const table = u.pathname.split('/rest/v1/')[1];
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  if (table === 'rpc/_admin_session_lookup') return J(sessionLookup(JSON.parse(init.body).p_token));
  if (table.startsWith('rpc/')) return J({ message: 'unknown function' }, 404);
  if (!db[table]) return J({ message: 'no table' }, 404);
  const conds = []; let limit = Infinity, order = null;
  for (const [k, v] of u.searchParams) {
    if (k === 'select') continue;
    if (k === 'limit') { limit = Number(v); continue; }
    if (k === 'order') { order = v; continue; }
    if (v.startsWith('eq.')) conds.push((r) => String(r[k]) === v.slice(3));
    else if (v === 'is.null') conds.push((r) => (r[k] ?? null) === null);
    else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(','); conds.push((r) => set.includes(String(r[k]))); }
    else return J({ message: 'unsupported filter ' + v }, 400);
  }
  const rep = /return=representation/.test(init?.headers?.Prefer || '');
  if (method === 'POST') {
    const r = insertRow(table, JSON.parse(init.body));
    if (r.error) return J(r.error, 409);
    return rep ? J([r.row], 201) : new Response(null, { status: 201 });
  }
  let rows = db[table].filter((r) => conds.every((f) => f(r)));
  if (method === 'PATCH') { rows.forEach((r) => Object.assign(r, JSON.parse(init.body))); return rep ? J(rows) : new Response(null, { status: 204 }); }
  if (order) { const [col, dir] = order.split('.'); rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (dir === 'desc' ? -1 : 1)); }
  return J(rows.slice(0, limit));
}

// ── fake Stripe ──────────────────────────────────────────────────────────────────────────────────
let stripe;
function stripeApi(method, url, init) {
  const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  const u = new URL(url); const p = u.pathname.replace('/v1/', '');
  const body = Object.fromEntries(new URLSearchParams(String(init?.body || '')));
  stripe.calls.push({ method, path: p + u.search, body });
  let m;
  if (method === 'GET' && (m = /^customers\/([^/]+)\/payment_methods$/.exec(p))) return J({ data: (stripe.cards[m[1]] ?? []).map((f) => ({ card: { fingerprint: f } })) });
  if ((m = /^customers\/([^/]+)\/balance_transactions$/.exec(p))) {
    if (method === 'GET') return J({ data: stripe.balance[m[1]] ?? [] });
    if (stripe.failPost) return J({ error: { message: 'Stripe is down' } }, 500);
    const key = init.headers['Idempotency-Key'];
    if (key && stripe.idem[key]) return J(stripe.idem[key]);
    const txn = { id: 'cbtxn_' + (++stripe.n), amount: Number(body.amount), currency: body.currency, metadata: { type: body['metadata[type]'], referral_reward_id: body['metadata[referral_reward_id]'], referral_id: body['metadata[referral_id]'] }, description: body.description };
    (stripe.balance[m[1]] ??= []).push(txn); if (key) stripe.idem[key] = txn;
    return J(txn);
  }
  if (method === 'GET' && p === 'invoices') return J({ data: stripe.invoices[u.searchParams.get('customer')] ?? [] });
  if (method === 'POST' && p === 'checkout/sessions') return J({ id: 'cs_1', url: 'https://stripe.test/session' });
  if (method === 'POST' && p === 'customers') return J({ id: 'cus_new' });
  return J({ error: { message: 'unexpected ' + p } }, 400);
}
const credits = (cus) => (stripe.balance[cus] ?? []).map((t) => t.amount);
const sum = (a) => a.reduce((x, y) => x + y, 0);

const mails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), method = (init.method || 'GET').toUpperCase();
  if (u.startsWith('https://api.stripe.com/')) return stripeApi(method, u, init);
  if (u.includes('/rest/v1/')) return rest(method, u, init);
  if (u.includes('resend.com')) { const m = JSON.parse(init.body); mails.push({ to: m.to[0], subject: m.subject, html: m.html }); return new Response('{}', { status: 200 }); }
  return new Response('{}', { status: 200 });
};

// ── load the two functions ───────────────────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'referral-test-'));
globalThis.__FAKE_SB = { from: sbFrom, async rpc(fn, args) { return fn === '_admin_session_lookup' ? { data: sessionLookup(args.p_token), error: null } : { data: null, error: { message: 'unknown function' } }; } }; globalThis.__WC = webcrypto;
async function loadStripeHandler(env) {
  const src = fs.readFileSync(FN('stripe-handler'), 'utf8')
    .replace(/^import \{ serve \}.*$/m, 'const serve = (h) => { globalThis.__H = h; };')
    .replace(/^import \{ createClient \}.*$/m, 'const createClient = () => globalThis.__FAKE_SB;')
    .replace(/^import \{ crypto \}.*$/m, 'const crypto = globalThis.__WC;');
  const out = path.join(scratch, `sh-${randomUUID()}.ts`);
  fs.writeFileSync(out, `globalThis.Deno={env:{get:(k)=>(${JSON.stringify(env)})[k]}};\n` + src);
  await import(pathToFileURL(out).href);
  return globalThis.__H;
}
const ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', RESEND_API_KEY: 're_x', REFERRAL_COUPON_ID: 'coupon_ref10' };
const _log = console.log, _err = console.error; let _muted = 0;
const quiet = async (f) => { if (!_muted++) console.log = console.error = () => {}; try { return await f(); } finally { if (!--_muted) { console.log = _log; console.error = _err; } } };
const SH = await loadStripeHandler(ENV);
const { REFERRAL_COUPON_ID: _drop, ...ENV_NO_COUPON } = ENV;
const SH_NO_COUPON = await loadStripeHandler(ENV_NO_COUPON);
const sdbOut = path.join(scratch, 'sdb.ts');
fs.writeFileSync(sdbOut, "globalThis.Deno={env:{get:(k)=>({SUPABASE_URL:'https://fake.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'svc-key'}[k])},serve:(h)=>{globalThis.__S=h;}};\n" + fs.readFileSync(FN('secure-db'), 'utf8').replace(/^import .*$/gm, ''));
await import(pathToFileURL(sdbOut).href);
const SDB = globalThis.__S;

let evN = 0;
async function webhook(type, object, { id, handler = SH } = {}) {
  const payload = JSON.stringify({ id: id || 'evt_' + (++evN), type, created: Math.floor(Date.now() / 1000), data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', 'whsec_x').update(`${t}.${payload}`).digest('hex');
  return quiet(async () => (await handler(new Request('https://fn/stripe-handler/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body: payload }))).status);
}
const invoice = (id, customer, { price = STARTER, total = 1949, paidAt = NOW, reason = 'subscription_cycle' } = {}) => ({
  id, customer, status: 'paid', total, amount_paid: total, currency: 'cad', billing_reason: reason,
  status_transitions: { paid_at: Math.floor(paidAt / 1000) }, lines: { data: [{ price: { id: price } }] },
});
const paid = (inv, opts) => webhook('invoice.payment_succeeded', inv, opts);
async function action(handler, name, body, headers = {}) {
  stripe.calls.length = 0;
  return quiet(async () => { const r = await handler(new Request(`https://fn/stripe-handler/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })); return { status: r.status, json: await r.json().catch(() => null), calls: [...stripe.calls] }; });
}
async function sdb(body) {
  const r = await quiet(() => SDB(new Request('https://fn/secure-db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  return { status: r.status, json: await r.json().catch(() => null) };
}
// The usual pair: R refers N. R pays for Starter with card fpR; N has its own card.
function pair({ referrerPlan = 'starter', refOpts = {} } = {}) {
  reset();
  admin('R', { plan: referrerPlan, stripe_customer_id: referrerPlan === 'free' ? null : 'cus_R' });
  admin('N', { stripe_customer_id: 'cus_N' });
  stripe.cards.cus_R = ['fpR']; stripe.cards.cus_N = ['fpN'];
  return referral('R', 'N', refOpts);
}
const refRow = () => db.referrals[0];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── the reward: two halves, month one and month two ──');
{
  pair();
  ok('first paid month answers 200', (await paid(invoice('in_1', 'cus_N', { total: 1754, reason: 'subscription_create', paidAt: NOW }))) === 200);
  ok('referral moves to first_paid and keeps the invoice', refRow().status === 'first_paid' && refRow().first_invoice_id === 'in_1');
  ok('half 1 is $9.75, credited on the referrer\'s Stripe balance', JSON.stringify(credits('cus_R')) === '[-975]', JSON.stringify(credits('cus_R')));
  ok('the reward row is delivered and holds the Stripe transaction', db.referral_rewards.length === 1 && db.referral_rewards[0].status === 'delivered' && db.referral_rewards[0].stripe_txn_id === 'cbtxn_1');
  ok('the credit names its reward row (metadata)', stripe.balance.cus_R[0].metadata.referral_reward_id === db.referral_rewards[0].id);
  ok('nothing is credited to the referred account', credits('cus_N').length === 0);
  ok('the owner is told by email', mails.some((m) => m.to === 'meissam.h.p@gmail.com' && /Referral credit CAD 9\.75/.test(m.subject)));
  const toR = mails.filter((m) => m.to === 'R@R.test');
  ok('the referrer gets their own email, in English and French', toR.length === 1 && /Referral credit: \$9\.75 \| Crédit de parrainage : 9,75 \$/.test(toR[0].subject)
    && /added to your account/.test(toR[0].html) && /ajouté à votre compte/.test(toR[0].html), JSON.stringify(toR.map((m) => m.subject)));
  ok('the email does not name the referred business', !/N@N\.test|>N</.test(toR[0].html));
  ok('the credit is tagged for the books (marketing, referral_credit)', stripe.balance.cus_R[0].metadata.type === 'referral_credit' || stripe.calls.some((c) => c.body?.['metadata[type]'] === 'referral_credit'));

  await paid(invoice('in_1', 'cus_N', { total: 1754, reason: 'subscription_create' }), { id: 'evt_same' });
  await paid(invoice('in_1', 'cus_N', { total: 1754, reason: 'subscription_create' }), { id: 'evt_same' });
  await paid(invoice('in_1', 'cus_N', { total: 1754, reason: 'subscription_create' }));
  ok('the same payment delivered again (same or new event id) pays nothing more', credits('cus_R').length === 1 && db.referral_rewards.length === 1);
  ok('and does not email the referrer again', mails.filter((m) => m.to === 'R@R.test').length === 1);

  await paid(invoice('in_x', 'cus_N', { paidAt: NOW + 10 * DAY }));
  ok('a second invoice 10 days later is not a second month', refRow().status === 'first_paid' && credits('cus_R').length === 1);
  await paid(invoice('in_up', 'cus_N', { price: GROWTH, total: 2000, paidAt: NOW + 30 * DAY, reason: 'subscription_update' }));
  ok('a plan-change invoice is not a second month', refRow().status === 'first_paid' && credits('cus_R').length === 1);
  await paid(invoice('in_addon', 'cus_N', { price: SCHED, total: 1495, paidAt: NOW + 30 * DAY }));
  ok('an add-on charged alone is not a second month', refRow().status === 'first_paid');

  await paid(invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }));
  ok('second paid month completes the referral', refRow().status === 'completed' && refRow().second_invoice_id === 'in_2');
  ok('half 2 is $9.74', JSON.stringify(credits('cus_R')) === '[-975,-974]', JSON.stringify(credits('cus_R')));
  ok('the two halves add up to $19.49 exactly', sum(credits('cus_R')) === -1949);
  await paid(invoice('in_3', 'cus_N', { paidAt: NOW + 62 * DAY }));
  await paid(invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }));
  ok('month three and a replay of month two pay nothing more', credits('cus_R').length === 2 && db.referral_rewards.length === 2);
}

console.log('\n── what does not count ──');
{
  pair();
  await paid(invoice('in_0', 'cus_N', { total: 0, reason: 'subscription_create' }));
  ok('a $0 invoice is not a payment', refRow().status === 'pending' && db.referral_rewards.length === 0);
  await paid(invoice('in_a', 'cus_N', { price: SCHED, total: 1495 }));
  ok('an add-on alone is not a first month', refRow().status === 'pending');
  await paid(invoice('in_r', 'cus_R'));
  ok('the referrer\'s own payments do nothing to the referral', refRow().status === 'pending' && credits('cus_R').length === 0);

  pair(); stripe.cards.cus_N = ['fpX', 'fpR'];
  await paid(invoice('in_1', 'cus_N'));
  ok('same card as the referrer: void, no reward', refRow().status === 'void' && refRow().void_reason === 'same_card' && db.referral_rewards.length === 0 && credits('cus_R').length === 0);
  await paid(invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }));
  ok('a void referral never earns later', db.referral_rewards.length === 0);

  pair({ refOpts: { created_at: iso(NOW - 91 * DAY) } });
  await paid(invoice('in_1', 'cus_N'));
  ok('first payment more than 90 days after sign-up: void', refRow().status === 'void' && refRow().void_reason === 'first_payment_late' && credits('cus_R').length === 0);

  pair();
  await paid(invoice('in_1', 'cus_N'));
  await paid(invoice('in_late', 'cus_N', { paidAt: NOW + 80 * DAY }));
  ok('cancelled, then back after 80 days: half 2 is never earned, half 1 stays', refRow().void_reason === 'second_payment_late' && JSON.stringify(credits('cus_R')) === '[-975]' && db.referral_rewards[0].status === 'delivered');

  pair();
  await paid(invoice('in_1', 'cus_N'));
  ok('cancels before month two (no further invoice): only half 1', refRow().status === 'first_paid' && sum(credits('cus_R')) === -975);
}

console.log('\n── a referrer on the Free plan ──');
{
  pair({ referrerPlan: 'free' });
  await paid(invoice('in_1', 'cus_N'));
  ok('half 1 is recorded as waiting, no Stripe credit yet', db.referral_rewards[0].status === 'waiting' && Object.keys(stripe.balance).length === 0);
  const wmail = mails.filter((m) => m.to === 'R@R.test').pop();
  ok('a Free referrer is emailed that the credit waits for their upgrade, with its expiry date', !!wmail && /Free plan/.test(wmail.html) && /forfait Gratuit/.test(wmail.html) && /until [A-Z][a-z]+ \d{1,2}, \d{4}/.test(wmail.html), wmail && wmail.html.slice(0, 200));
  await paid(invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }));
  ok('half 2 waits too', db.referral_rewards.length === 2 && db.referral_rewards.every((r) => r.status === 'waiting'));
  // the referrer upgrades
  db.admins.find((a) => a.id === 'R').stripe_customer_id = 'cus_R';
  await webhook('checkout.session.completed', { customer: 'cus_R', subscription: 'sub_R', metadata: { adminId: 'R', plan: 'starter' } });
  ok('on upgrade both halves land on their balance', sum(credits('cus_R')) === -1949 && credits('cus_R').length === 2 && db.referral_rewards.every((r) => r.status === 'delivered'), JSON.stringify(credits('cus_R')));
  await paid(invoice('in_R1', 'cus_R'));
  ok('their own next invoice does not credit again', credits('cus_R').length === 2);

  pair({ referrerPlan: 'free' }); db.admins.find((a) => a.id === 'R').stripe_customer_id = 'cus_R';
  await paid(invoice('in_1', 'cus_N'));
  ok('a Free referrer who once opened a checkout (has a Stripe customer, no plan): still waiting', db.referral_rewards[0].status === 'waiting' && credits('cus_R').length === 0);

  pair({ referrerPlan: 'free' });
  await paid(invoice('in_1', 'cus_N'));
  const R =db.admins.find((a) => a.id === 'R'); R.stripe_customer_id = 'cus_R'; R.plan = 'starter'; stripe.cards.cus_R = ['fpN'];
  await paid(invoice('in_R1', 'cus_R'));
  ok('referrer later pays with the referred account\'s card: the waiting credit is void', db.referral_rewards[0].status === 'void' && db.referral_rewards[0].void_reason === 'same_card' && credits('cus_R').length === 0 && refRow().status === 'void');
}

console.log('\n── waiting credits expire after 12 months ──');
{
  pair({ referrerPlan: 'free' });
  await paid(invoice('in_1', 'cus_N'));
  db.referral_rewards[0].earned_at = iso(NOW - 366 * DAY);
  const R = db.admins.find((a) => a.id === 'R'); R.stripe_customer_id = 'cus_R'; R.plan = 'starter';
  await webhook('checkout.session.completed', { customer: 'cus_R', subscription: 'sub_R', metadata: { adminId: 'R', plan: 'starter' } });
  ok('upgrading 13 months later: the old waiting credit is expired, nothing credited', db.referral_rewards[0].status === 'void' && db.referral_rewards[0].void_reason === 'expired' && credits('cus_R').length === 0);

  pair({ referrerPlan: 'free' });
  await paid(invoice('in_1', 'cus_N'));
  db.referral_rewards[0].earned_at = iso(NOW - 300 * DAY);
  const R2 = db.admins.find((a) => a.id === 'R'); R2.stripe_customer_id = 'cus_R'; R2.plan = 'starter';
  await webhook('checkout.session.completed', { customer: 'cus_R', subscription: 'sub_R', metadata: { adminId: 'R', plan: 'starter' } });
  ok('upgrading after 10 months: still credited', db.referral_rewards[0].status === 'delivered' && sum(credits('cus_R')) === -975);

  pair({ referrerPlan: 'free' });
  await paid(invoice('in_1', 'cus_N'));
  db.referral_rewards[0].earned_at = iso(NOW - 400 * DAY);
  await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('reconcile closes expired waiting credits', db.referral_rewards[0].status === 'void' && db.referral_rewards[0].void_reason === 'expired');

  pair();
  await paid(invoice('in_1', 'cus_N'));
  db.referral_rewards[0].earned_at = iso(NOW - 400 * DAY);
  await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('a credit already on the Stripe balance never expires', db.referral_rewards[0].status === 'delivered' && sum(credits('cus_R')) === -975);
}

console.log('\n── failures, races and the reconcile action ──');
{
  pair(); stripe.failPost = true;
  ok('Stripe down while crediting: the webhook still answers 200', (await paid(invoice('in_1', 'cus_N'))) === 200);
  ok('the half is recorded, waiting', refRow().status === 'first_paid' && db.referral_rewards[0].status === 'waiting' && credits('cus_R').length === 0);
  stripe.failPost = false;
  let r = await action(SH, 'referral_reconcile', {});
  ok('reconcile without the service key is refused', r.status === 401 && credits('cus_R').length === 0);
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('reconcile with the service key delivers it', r.status === 200 && r.json.ok && JSON.stringify(credits('cus_R')) === '[-975]' && db.referral_rewards[0].status === 'delivered');
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('a second reconcile changes nothing', credits('cus_R').length === 1 && !r.calls.some((c) => c.method === 'POST'));

  // The nightly job (pg_cron) sends the cron_secret of internal_secrets, not the service key.
  const CRON = 'c'.repeat(64);
  db.internal_secrets.push({ key: 'cron_secret', value: CRON });
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer ' + CRON });
  ok('the nightly job\'s cron secret is accepted', r.status === 200 && r.json.ok === true);
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer ' + 'd'.repeat(64) });
  ok('a wrong secret is refused', r.status === 401 && r.calls.length === 0);
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer ' + CRON.slice(0, 63) });
  ok('a secret one character short is refused', r.status === 401);
  r = await action(SH, 'test_payment_email', {}, { authorization: 'Bearer ' + CRON });
  ok('the cron secret opens nothing else (test email stays service-key only)', r.status === 401);

  // A night with nothing to do: an empty database, then one where every referral is settled.
  const snapshot = () => JSON.stringify({ db, balance: stripe.balance });
  reset(); db.internal_secrets.push({ key: 'cron_secret', value: CRON });
  let before = snapshot();
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer ' + CRON });
  ok('reconcile with nothing to do: empty database, nothing written, no Stripe write', r.status === 200 && r.json.referrals === 0 && r.json.waiting === 0 && r.json.errors === 0
    && snapshot() === before && !r.calls.some((c) => c.method === 'POST'), JSON.stringify(r.json));
  pair(); db.internal_secrets.push({ key: 'cron_secret', value: CRON });
  await paid(invoice('in_1', 'cus_N')); await paid(invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }));
  pair2: {
    admin('V', { stripe_customer_id: 'cus_V' }); stripe.cards.cus_V = ['fpR'];
    referral('R', 'V'); await paid(invoice('in_v', 'cus_V'));   // same card: void
  }
  before = snapshot();
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer ' + CRON });
  ok('reconcile with everything settled (one complete, one void): nothing changes', r.status === 200 && r.json.errors === 0 && snapshot() === before && !r.calls.some((c) => c.method === 'POST'), JSON.stringify(r.json));

  // the credit was created at Stripe but our row was never updated
  pair(); stripe.failPost = true; await paid(invoice('in_1', 'cus_N')); stripe.failPost = false;
  stripe.balance.cus_R = [{ id: 'cbtxn_lost', amount: -975, metadata: { referral_reward_id: db.referral_rewards[0].id } }];
  r = await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('a credit that already exists at Stripe is adopted, not created twice', credits('cus_R').length === 1 && db.referral_rewards[0].stripe_txn_id === 'cbtxn_lost' && !r.calls.some((c) => c.method === 'POST'));

  // the status moved but the reward row was never written
  pair(); Object.assign(refRow(), { status: 'first_paid', first_invoice_id: 'in_1', first_paid_at: iso(NOW) });
  await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('reconcile writes a missing half', db.referral_rewards.length === 1 && JSON.stringify(credits('cus_R')) === '[-975]');

  // no webhook ever arrived
  pair(); stripe.invoices.cus_N = [invoice('in_2', 'cus_N', { paidAt: NOW + 31 * DAY }), invoice('in_1', 'cus_N', { paidAt: NOW })];
  await action(SH, 'referral_reconcile', {}, { authorization: 'Bearer svc-key' });
  ok('reconcile rebuilds a whole referral from Stripe\'s invoices', refRow().status === 'completed' && refRow().first_invoice_id === 'in_1' && sum(credits('cus_R')) === -1949 && credits('cus_R').length === 2);

  pair();
  await Promise.all([paid(invoice('in_1', 'cus_N')), paid(invoice('in_1', 'cus_N')), paid(invoice('in_1', 'cus_N'))]);
  ok('three deliveries of one payment at the same time: one half, one credit', db.referral_rewards.length === 1 && credits('cus_R').length === 1);

  pair(); db.referral_promotions[0].max_rewards_per_referrer = 1;
  admin('N2', { stripe_customer_id: 'cus_N2' }); stripe.cards.cus_N2 = ['fpN2']; referral('R', 'N2');
  await paid(invoice('in_1', 'cus_N')); await paid(invoice('in_b1', 'cus_N2'));
  const second = db.referrals.find((x) => x.referred_admin_id === 'N2');
  ok('cap of 1 rewarded referral per referrer: the second is void', second.status === 'void' && second.void_reason === 'referrer_cap' && credits('cus_R').length === 1);

  // The owner's cap: 10 rewarded referrals per referrer.
  pair();
  for (let i = 2; i <= 11; i++) { admin('M' + i, { stripe_customer_id: 'cus_M' + i }); stripe.cards['cus_M' + i] = ['fpM' + i]; referral('R', 'M' + i); }
  db.referrals.find((x) => x.referred_admin_id === 'N').status = 'void';
  db.referrals.find((x) => x.referred_admin_id === 'N').void_reason = 'same_card';
  insertRow('referral_rewards', { referral_id: db.referrals[0].id, referrer_admin_id: 'R', half: 1, amount_cents: 975, status: 'void', void_reason: 'same_card' });
  for (let i = 2; i <= 11; i++) await paid(invoice('in_m' + i, 'cus_M' + i));
  const capped = db.referrals.filter((x) => /^M/.test(x.referred_admin_id));
  ok('cap 10: ten referred accounts earn (a voided one before them does not count)', capped.filter((x) => x.status === 'first_paid').length === 10 && capped.filter((x) => x.void_reason === 'referrer_cap').length === 0 && credits('cus_R').length === 10, JSON.stringify(capped.map((x) => x.status)));
  admin('M12', { stripe_customer_id: 'cus_M12' }); stripe.cards.cus_M12 = ['fpM12']; referral('R', 'M12');
  await paid(invoice('in_m12', 'cus_M12'));
  ok('a voided reward does not use up the cap, the 11th rewarded one is refused', db.referrals.find((x) => x.referred_admin_id === 'M12').void_reason === 'referrer_cap' && credits('cus_R').length === 10);
  ok('the capped referral\'s second month earns nothing either', (await paid(invoice('in_m12b', 'cus_M12', { paidAt: NOW + 31 * DAY })), credits('cus_R').length === 10));

  pair(); db.referral_promotions[0].enabled = false;
  await paid(invoice('in_1', 'cus_N'));
  ok('switching the promotion off still honours referrals already recorded', sum(credits('cus_R')) === -975);
}

console.log('\n── checkout: the 10% coupon ──');
{
  pair(); session('tokN', 'N'); session('tokR', 'R');
  let r = await action(SH, 'checkout', { plan: 'starter', sessionToken: 'tokN' });
  let s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('a referred account\'s plan checkout carries the coupon', r.status === 200 && s.body['discounts[0][coupon]'] === 'coupon_ref10' && s.body['metadata[referralId]'] === refRow().id);
  ok('and no promotion-code box (Stripe allows one or the other)', !('allow_promotion_codes' in s.body));
  r = await action(SH, 'checkout', { plan: 'growth', sessionToken: 'tokR' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('an account without a referral is unchanged', !('discounts[0][coupon]' in s.body) && s.body.allow_promotion_codes === 'true');
  r = await action(SH, 'checkout', { plan: 'scheduling_addon', sessionToken: 'tokN' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('add-ons never carry the coupon', !('discounts[0][coupon]' in s.body));
  r = await action(SH_NO_COUPON, 'checkout', { plan: 'starter', sessionToken: 'tokN' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('no coupon configured: checkout as before', r.status === 200 && !('discounts[0][coupon]' in s.body) && s.body.allow_promotion_codes === 'true');
  db.referral_promotions[0].enabled = false;
  r = await action(SH, 'checkout', { plan: 'starter', sessionToken: 'tokN' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('promotion switched off: no coupon', !('discounts[0][coupon]' in s.body) && s.body.allow_promotion_codes === 'true');
  db.referral_promotions[0].enabled = true;

  await webhook('checkout.session.completed', { customer: 'cus_N', subscription: 'sub_N', metadata: { adminId: 'N', plan: 'starter', referralId: refRow().id } });
  ok('a completed checkout marks the discount as used', !!refRow().discount_used_at && db.admins.find((a) => a.id === 'N').plan === 'starter');
  r = await action(SH, 'checkout', { plan: 'growth', sessionToken: 'tokN' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('the coupon is not offered a second time', !('discounts[0][coupon]' in s.body));

  pair(); session('tokN', 'N'); stripe.invoices.cus_N = [{ id: 'in_old', amount_paid: 1949 }];
  r = await action(SH, 'checkout', { plan: 'starter', sessionToken: 'tokN' });
  s = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('an account that already paid before: no coupon, referral void', !('discounts[0][coupon]' in s.body) && refRow().void_reason === 'prior_payment');

  pair(); session('tokN', 'N');
  db.referrals = new Proxy([], { get() { throw new Error('database down'); } });
  r = await action(SH, 'checkout', { plan: 'starter', sessionToken: 'tokN' });
  ok('a failing referral lookup never blocks a checkout', r.status === 200 && r.json.url === 'https://stripe.test/session');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── secure-db: referral_info (the account\'s own code) ──');
{
  reset();
  admin('own', { plan: 'starter' }); admin('co', { parent_admin_id: 'own', role: 'co_admin' }); admin('mgr', { parent_admin_id: 'own', role: 'manager' }); admin('sa', { role: 'super_admin' });
  session('tOwn', 'own'); session('tCo', 'co'); session('tMgr', 'mgr'); session('tSa', 'sa');
  let r = await sdb({ action: 'referral_info' });
  ok('no session: refused', r.status === 401);
  r = await sdb({ action: 'referral_info', sessionToken: 'tMgr' });
  ok('a manager: refused', r.status === 403);
  r = await sdb({ action: 'referral_info', sessionToken: 'tSa' });
  ok('the super admin: refused', r.status === 403);
  r = await sdb({ action: 'referral_info', sessionToken: 'tOwn' });
  const code = r.json?.code;
  ok('the owner gets an 8-character code', r.status === 200 && /^[A-HJKMNP-Z2-9]{8}$/.test(code || ''), JSON.stringify(r.json));
  ok('asked again, it is the same code', (await sdb({ action: 'referral_info', sessionToken: 'tOwn' })).json.code === code && db.referral_codes.length === 1);
  r = await sdb({ action: 'referral_info', sessionToken: 'tCo' });
  ok('a co-admin sees the account\'s code, not one of their own', r.json.code === code && r.json.is_owner === false && db.referral_codes.length === 1);
  admin('x1'); admin('x2'); admin('x3');
  const a = referral('own', 'x1', { status: 'first_paid' }), b2 = referral('own', 'x2', { status: 'completed' }); referral('own', 'x3');
  insertRow('referral_rewards', { referral_id: a.id, referrer_admin_id: 'own', half: 1, amount_cents: 975, status: 'delivered' });
  insertRow('referral_rewards', { referral_id: b2.id, referrer_admin_id: 'own', half: 1, amount_cents: 975, status: 'delivered' });
  insertRow('referral_rewards', { referral_id: b2.id, referrer_admin_id: 'own', half: 2, amount_cents: 974, status: 'waiting' });
  r = await sdb({ action: 'referral_info', sessionToken: 'tOwn' });
  ok('totals: 1 signed up, 1 paid a first month, 1 complete', JSON.stringify(r.json.referred) === '{"pending":1,"first_paid":1,"completed":1}', JSON.stringify(r.json.referred));
  ok('credit: $19.50 applied, $9.74 waiting', r.json.credit.delivered_cents === 1950 && r.json.credit.waiting_cents === 974);
  ok('the panel is told when the waiting credit expires (12 months after it was earned)', Math.abs(Date.parse(r.json.credit.waiting_first_expires_at) - (Date.now() + 365 * DAY)) < 2 * DAY, r.json.credit.waiting_first_expires_at);
  db.referral_rewards.find((x) => x.status === 'waiting').earned_at = iso(NOW - 370 * DAY);
  r = await sdb({ action: 'referral_info', sessionToken: 'tOwn' });
  ok('an expired waiting credit is no longer counted', r.json.credit.waiting_cents === 0 && r.json.credit.waiting_first_expires_at === null);
  ok('nothing identifies the referred accounts', !/x1|x2|x3|\.test/.test(JSON.stringify(r.json)));
  for (const t of ['referrals', 'referral_codes', 'referral_rewards', 'referral_promotions']) {
    r = await sdb({ table: t, method: 'GET', filter: '', sessionToken: 'tOwn' });
    ok(`the table path refuses ${t}`, r.status === 403);
  }
}

console.log('\n── secure-db: referral_check (sign-up form) ──');
{
  reset();
  admin('own'); admin('gone', { status: 'suspended' });
  db.referral_codes.push({ admin_id: 'own', code: 'ABCD2345' }, { admin_id: 'gone', code: 'WXYZ6789' });
  let r = await sdb({ action: 'referral_check', body: { code: 'ABCD2345' } });
  ok('a real code is valid, with no session', r.status === 200 && r.json.valid === true && r.json.open === true);
  ok('the answer does not say whose code it is', !/own/.test(JSON.stringify(r.json)));
  ok('typed in lower case with a dash and spaces', (await sdb({ action: 'referral_check', body: { code: ' abcd-2345 ' } })).json.valid === true);
  ok('an unknown code is not valid', (await sdb({ action: 'referral_check', body: { code: 'ZZZZ2222' } })).json.valid === false);
  ok('the code of a suspended account is not valid', (await sdb({ action: 'referral_check', body: { code: 'WXYZ6789' } })).json.valid === false);
  for (const bad of ['', 'ABC', 'ABCD2345&select=*', 'eq.ABCD2345', 'ABCD234O', null, { a: 1 }]) {
    r = await sdb({ action: 'referral_check', body: { code: bad } });
    ok(`malformed input ${JSON.stringify(bad)} is not valid`, r.status === 200 && r.json.valid === false);
  }
  db.referral_promotions[0].enabled = false;
  r = await sdb({ action: 'referral_check', body: { code: 'ABCD2345' } });
  ok('promotion switched off: nothing is valid', r.json.valid === false && r.json.open === false);
  Object.assign(db.referral_promotions[0], { enabled: true, starts_at: iso(NOW + DAY), ends_at: iso(NOW + 30 * DAY) });
  ok('before the first day: nothing is valid', (await sdb({ action: 'referral_check', body: { code: 'ABCD2345' } })).json.valid === false);
  Object.assign(db.referral_promotions[0], { starts_at: iso(NOW - 40 * DAY), ends_at: iso(NOW - DAY) });
  ok('after the last day: nothing is valid', (await sdb({ action: 'referral_check', body: { code: 'ABCD2345' } })).json.valid === false);
}

console.log('\n── secure-db: referral_apply (one code, new accounts, before any payment) ──');
{
  const setup = () => {
    reset();
    admin('own', { email: 'boss@acme-roofing.ca', plan: 'starter' }); db.referral_codes.push({ admin_id: 'own', code: 'ABCD2345' });
    admin('g1', { email: 'jean.tremblay@gmail.com' }); db.referral_codes.push({ admin_id: 'g1', code: 'GGGG2222' });
    admin('new', { email: 'marie@boulangerie.test' }); session('tNew', 'new');
    admin('newco', { parent_admin_id: 'new', role: 'co_admin' }); session('tNewCo', 'newco');
  };
  const apply = (token, code) => sdb({ action: 'referral_apply', sessionToken: token, body: { code } });
  setup();
  let r = await sdb({ action: 'referral_apply', body: { code: 'ABCD2345' } });
  ok('no session: refused', r.status === 401 && db.referrals.length === 0);
  r = await apply('tNewCo', 'ABCD2345');
  ok('a co-admin cannot attach a code', r.json.code === 'not_owner' && db.referrals.length === 0);
  r = await apply('tNew', 'ZZZZ2222');
  ok('an unknown code is refused', r.json.ok === false && r.json.code === 'invalid' && db.referrals.length === 0);
  r = await apply('tNew', 'abcd-2345');
  ok('a valid code is attached to the new account', r.json.ok === true && db.referrals.length === 1 && db.referrals[0].referrer_admin_id === 'own' && db.referrals[0].referred_admin_id === 'new' && db.referrals[0].status === 'pending');
  r = await apply('tNew', 'GGGG2222');
  ok('one code per account: a second one is refused', r.json.code === 'already_used' && db.referrals.length === 1);
  r = await sdb({ action: 'referral_info', sessionToken: 'tNew' });
  ok('the new account has its own code too (it can refer others)', /^[A-HJKMNP-Z2-9]{8}$/.test(r.json.code) && r.json.code !== 'ABCD2345' && r.json.mine?.status === 'pending' && r.json.can_enter === false);

  setup(); session('tOwn', 'own'); db.admins.find((a) => a.id === 'own').plan = 'free';
  ok('your own code is refused', (await apply('tOwn', 'ABCD2345')).json.code === 'own_code' && db.referrals.length === 0);
  setup(); db.admins.find((a) => a.id === 'new').email = 'jeantremblay+pc@googlemail.com';
  ok('the same Gmail mailbox written differently is the same person', (await apply('tNew', 'GGGG2222')).json.code === 'own_code' && db.referrals.length === 0);
  setup(); db.admins.find((a) => a.id === 'new').email = 'paie@ACME-roofing.ca';
  ok('same company email domain as the referrer: refused', (await apply('tNew', 'ABCD2345')).json.code === 'same_domain' && db.referrals.length === 0);
  setup(); db.admins.find((a) => a.id === 'new').email = 'marie.roy@gmail.com';
  ok('two different people on gmail.com can refer each other', (await apply('tNew', 'GGGG2222')).json.ok === true);

  setup(); db.admins.find((a) => a.id === 'new').plan = 'starter';
  ok('an account on a paid plan cannot add a code', (await apply('tNew', 'ABCD2345')).json.code === 'already_paid' && db.referrals.length === 0);
  setup(); db.admins.find((a) => a.id === 'new').stripe_subscription_id = 'sub_1';
  ok('nor one that has a subscription', (await apply('tNew', 'ABCD2345')).json.code === 'already_paid');
  setup(); db.admins.find((a) => a.id === 'new').created_at = iso(NOW - 30 * DAY);
  ok('an account created before the promotion is not eligible', (await apply('tNew', 'ABCD2345')).json.code === 'not_eligible' && db.referrals.length === 0);
  r = await sdb({ action: 'referral_info', sessionToken: 'tNew' });
  ok('and is not offered the field', r.json.can_enter === false);
  setup(); db.referral_promotions[0].enabled = false;
  ok('promotion switched off: refused', (await apply('tNew', 'ABCD2345')).json.code === 'closed' && db.referrals.length === 0);
  setup(); Object.assign(db.referral_promotions[0], { starts_at: iso(NOW - 40 * DAY), ends_at: iso(NOW - 5 * DAY) }); db.admins.find((a) => a.id === 'new').created_at = iso(NOW - 10 * DAY);
  ok('a December account can still add its code in January, before paying', (await apply('tNew', 'ABCD2345')).json.ok === true);
  setup();
  const both = await Promise.all([apply('tNew', 'ABCD2345'), apply('tNew', 'GGGG2222')]);
  ok('two codes sent at the same moment: exactly one is kept', db.referrals.length === 1 && both.filter((x) => x.json.ok).length === 1);
  setup(); db.admins.find((a) => a.id === 'own').status = 'suspended';
  ok('the code of a suspended referrer is refused', (await apply('tNew', 'ABCD2345')).json.code === 'invalid');
}

console.log('\n── switched on early: enabled = true before 1 December (the go-live plan) ──');
{
  // The real dec2026 row, enabled, seen from 21 November 2026 (today is earlier than starts_at).
  reset();
  Object.assign(db.referral_promotions[0], { enabled: true, starts_at: iso(NOW + 10 * DAY), ends_at: iso(NOW + 41 * DAY) });
  admin('own', { email: 'boss@acme-roofing.ca', plan: 'starter', stripe_customer_id: 'cus_own' }); db.referral_codes.push({ admin_id: 'own', code: 'ABCD2345' });
  admin('early', { email: 'marie@boulangerie.test', created_at: iso(NOW - 60_000), stripe_customer_id: 'cus_early' });
  session('tEarly', 'early');
  let r = await sdb({ action: 'referral_check', body: { code: 'ABCD2345' } });
  ok('before starts_at, enabled: the sign-up check says not valid', r.json.valid === false && r.json.open === false);
  r = await sdb({ action: 'referral_apply', sessionToken: 'tEarly', body: { code: 'ABCD2345' } });
  ok('before starts_at, enabled: an account created today cannot attach a code', r.json.ok === false && r.json.code === 'not_eligible' && db.referrals.length === 0, JSON.stringify(r.json));
  r = await sdb({ action: 'referral_info', sessionToken: 'tEarly' });
  ok('before starts_at, enabled: the panel offers no code box', r.json.can_enter === false && r.json.promo.open === false);
  r = await action(SH, 'checkout', { plan: 'starter', sessionToken: 'tEarly' });
  const s0 = r.calls.find((c) => c.path === 'checkout/sessions');
  ok('before starts_at, enabled: checkout gives no discount (promotion-code box as today)', r.status === 200 && !('discounts[0][coupon]' in s0.body) && s0.body.allow_promotion_codes === 'true');
  // On 1 December itself, an account created that day can.
  db.referral_promotions[0].starts_at = iso(NOW - DAY);
  r = await sdb({ action: 'referral_apply', sessionToken: 'tEarly', body: { code: 'ABCD2345' } });
  ok('once starts_at has passed, the same kind of account can (nobody has to act that day)', r.json.ok === true && db.referrals.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
