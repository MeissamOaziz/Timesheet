// send-contact: old vs new, same inputs, fake Resend and fake audit_log. No email is ever sent.
//   git show HEAD:supabase/functions/send-contact/index.ts > /tmp/sc-old.ts
//   node tools/secure-db-regression/send-contact-diff-test.mjs /tmp/sc-old.ts supabase/functions/send-contact/index.ts
// Part 1: ordinary form submissions (landing, in-app support) and the server's own notifications must
//         produce byte-identical emails in both versions.
// Part 2: a caller without the service key can neither choose recipients nor use the internal types,
//         and every field it controls comes out escaped.
// Part 3: rate limits (per sender, overall), and that a failing counter never blocks a real customer.
// Part 4: the service key keeps its powers and is never rate limited.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldPath, newPath] = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-diff-'));
const SERVICE = 'service-key-for-test';
const ANON = 'anon-key-for-test';
let mail = [];
let auditRows = [];
let auditFails = false;

async function load(file, tag) {
  const src = fs.readFileSync(file, 'utf8').replace(/^import .*$/gm, '');
  const out = path.join(scratch, `sc_${tag}.ts`);
  fs.writeFileSync(out,
    `globalThis.Deno={env:{get:(k)=>({RESEND_API_KEY:'resend-test',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'${SERVICE}'}[k])},serve:(h)=>{globalThis.__H=h;}};\n` + src);
  globalThis.__H = null;
  await import(pathToFileURL(out).href + '?v=' + Date.now());
  return globalThis.__H;
}

globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (url.startsWith('https://api.resend.com/')) {
    mail.push({ to: JSON.parse(init.body).to, from: JSON.parse(init.body).from, subject: JSON.parse(init.body).subject, reply_to: JSON.parse(init.body).reply_to, html: JSON.parse(init.body).html });
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  }
  if (url.startsWith('https://db.test/rest/v1/audit_log')) {
    if (auditFails) return new Response('boom', { status: 500 });
    if ((init.method || 'GET') === 'POST') { auditRows.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
    const q = new URL(url).searchParams;
    const rows = auditRows.filter(r => r.event === q.get('event').replace('eq.', '')
      && (!q.get('filter') || r.filter === decodeURIComponent(q.get('filter').replace(/^eq\./, '')))
      && (!q.get('table_name') || r.table_name === q.get('table_name').replace('eq.', '')));
    return new Response(JSON.stringify(rows.map((_, i) => ({ id: i }))), { status: 200 });
  }
  throw new Error('unexpected fetch ' + url);
};

async function call(handler, payload, key) {
  mail = [];
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await handler(new Request('https://fn/send-contact', { method: 'POST', headers, body: JSON.stringify(payload) }));
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, json: j, sent: mail.slice() };
}

const hOld = await load(oldPath, 'old');
const hNew = await load(newPath, 'new');
let bad = 0;
const check = (ok, label) => { if (!ok) bad++; console.log(ok ? 'ok   ' : '!! FAIL', label); };

// ---------- Part 1 ----------
console.log('--- Part 1: ordinary traffic, old vs new');
const ordinary = [
  ['landing sales form', { type: 'sales', name: 'Vikas Singh', email: 'v@x.ca', subject: 'sales', message: 'Hello,\nhow much for 12 staff?' }, null],
  ['landing trial help', { type: 'sales', name: 'Ann', email: 'a@x.ca', subject: 'trial', message: 'I need a hand' }, null],
  ['in-app support', { type: 'support', name: 'Boss Man', email: 'boss@x.ca', subject: 'technical', message: 'Kiosk is stuck', adminId: '11111111-2222-3333-4444-555555555555' }, null],
  ['in-app support, odd subject', { type: 'support', name: 'Boss', email: 'boss@x.ca', subject: 'Something else', message: 'Hi' }, null],
  ['time-off notice (server)', { type: 'time_off', name: 'Emp One', email: 'noreply@punchclock.ca', subject: 'Time off request', message: 'Emp One asked for Oct 30', recipients: ['owner@x.ca', 'mgr@x.ca'] }, SERVICE],
  ['missed punch notice (server)', { type: 'missed_punch', name: 'Emp Two', email: 'noreply@punchclock.ca', subject: 'Missed punch', message: 'Forgot to clock out', recipients: ['owner@x.ca'] }, SERVICE],
  ['new account notice (server)', { type: 'new_account_notification', name: 'New', email: 'noreply@punchclock.ca', subject: 'New account', message: 'new@x.ca signed up' }, SERVICE],
];
for (const [name, payload, key] of ordinary) {
  auditRows = [];
  const o = await call(hOld, payload, key), n = await call(hNew, payload, key);
  const same = o.status === n.status && JSON.stringify(o.sent) === JSON.stringify(n.sent) && o.sent.length >= 1;
  check(same, `identical: ${name} (${o.sent.length} email${o.sent.length === 1 ? '' : 's'})`);
}

// ---------- Part 2 ----------
console.log('--- Part 2: callers without the service key');
auditRows = [];
let r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 'sales', message: 'hi', recipients: ['victim@x.ca'] }, ANON);
check(r.status === 200 && r.sent[0].to.length === 1 && r.sent[0].to[0] === 'support@punchclock.ca', 'recipients ignored: mail goes to the support inbox');
for (const t of ['time_off', 'missed_punch', 'new_account_notification', 'whatever']) {
  r = await call(hNew, { type: t, name: 'A', email: 'a@x.ca', subject: 's', message: 'm', recipients: ['victim@x.ca'] }, ANON);
  check(r.status === 403 && r.sent.length === 0, `type "${t}" refused with the public key, nothing sent`);
  r = await call(hNew, { type: t, name: 'A', email: 'a@x.ca', subject: 's', message: 'm' }, null);
  check(r.status === 403 && r.sent.length === 0, `type "${t}" refused with no key, nothing sent`);
}
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 's', message: 'm' }, 'wrong-key');
check(r.status === 200, 'a wrong key is just a public caller (still allowed to use the form)');
r = await call(hNew, { type: 'sales', name: 'A', email: 'not-an-email', subject: 's', message: 'm' }, null);
check(r.status === 400 && r.sent.length === 0, 'invalid sender address refused');
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 's', message: 'x'.repeat(5001) }, null);
check(r.status === 400 && r.sent.length === 0, 'message over 5000 characters refused');
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 's' }, null);
check(r.status === 400, 'missing message refused');

const XSS = '<img src=x onerror=alert(1)>';
auditRows = [];
r = await call(hNew, { type: 'support', name: XSS, email: 'a@x.ca', subject: XSS, message: `${XSS} & <b>bold</b>`, adminId: XSS }, null);
const all = r.sent.map(m => m.html).join('\n');
check(r.status === 200 && r.sent.length === 2, 'hostile fields still produce the two normal emails');
check(!all.includes('<img src=x') && !all.includes('<b>bold'), 'markup in name, subject, message and admin id is escaped in both emails');
check(!all.includes(XSS) && all.includes('&lt;img'), 'escaped text is still shown (not silently dropped)');
check(r.sent[0].subject.indexOf('\n') < 0, 'subject header has no line breaks');
auditRows = [];
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 'x\r\nBcc: evil@x.ca', message: 'm' }, null);
check(r.sent.every(m => !/[\r\n]/.test(m.subject)), 'line breaks in a subject cannot inject a header');
auditRows = [];
r = await call(hNew, { type: 'sales', name: 'A'.repeat(500), email: 'a@x.ca', subject: 's', message: 'm' }, null);
check(!r.sent[0].html.includes('A'.repeat(101)), 'a 500-character name is cut to 100');
auditRows = [];
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 's', message: 'a &lt; b' }, null);
check(r.sent[0].html.includes('a &amp;lt; b'), 'text that looks like an entity is shown literally');

// ---------- Part 3 ----------
console.log('--- Part 3: rate limits');
auditRows = [];
const results = [];
for (let i = 0; i < 7; i++) results.push((await call(hNew, { type: 'sales', name: 'A', email: 'Spam@X.ca', subject: 's', message: 'm' }, null)).status);
check(JSON.stringify(results) === JSON.stringify([200, 200, 200, 200, 200, 429, 429]), `one sender: 5 allowed then refused (${results.join(',')})`);
r = await call(hNew, { type: 'sales', name: 'A', email: 'spam@x.ca', subject: 's', message: 'm' }, null);
check(r.status === 429 && r.sent.length === 0, 'refused request sends nothing (no support mail, no acknowledgement)');
r = await call(hNew, { type: 'sales', name: 'B', email: 'other@x.ca', subject: 's', message: 'm' }, null);
check(r.status === 200, 'a different sender is unaffected');

auditRows = [];
for (let i = 0; i < 120; i++) auditRows.push({ event: 'contact_form', table_name: 'send-contact', filter: `u${i}@x.ca` });
r = await call(hNew, { type: 'sales', name: 'B', email: 'fresh@x.ca', subject: 's', message: 'm' }, null);
check(r.status === 429 && r.sent.length === 0, 'overall cap (120 an hour) refuses everyone, nothing sent');
r = await call(hNew, { type: 'time_off', name: 'E', email: 'noreply@punchclock.ca', subject: 's', message: 'm', recipients: ['o@x.ca'] }, SERVICE);
check(r.status === 200 && r.sent.length === 1, 'server notifications still go through while the public cap is hit');

auditRows = []; auditFails = true;
r = await call(hNew, { type: 'sales', name: 'A', email: 'a@x.ca', subject: 's', message: 'm' }, null);
check(r.status === 200 && r.sent.length === 2, 'if the counter cannot be read, the customer is still served');
auditFails = false;

// ---------- Part 4 ----------
console.log('--- Part 4: the service key');
auditRows = [];
r = await call(hNew, { type: 'time_off', name: 'E', email: 'noreply@punchclock.ca', subject: 's', message: 'm', recipients: ['o@x.ca', 'm@x.ca', 'not-an-address'] }, SERVICE);
check(r.status === 200 && JSON.stringify(r.sent[0].to) === JSON.stringify(['o@x.ca', 'm@x.ca']) && r.sent.length === 1, 'recipients honoured (invalid ones dropped), no acknowledgement for internal types');
check(auditRows.length === 0, 'server calls leave no rate-limit rows');
let okAll = true;
for (let i = 0; i < 10; i++) okAll = okAll && (await call(hNew, { type: 'missed_punch', name: 'E', email: 'noreply@punchclock.ca', subject: 's', message: 'm', recipients: ['o@x.ca'] }, SERVICE)).status === 200;
check(okAll, '10 server calls in a row are never rate limited');
r = await call(hNew, { type: 'time_off', name: 'E', email: 'noreply@punchclock.ca', subject: 's', message: 'm', recipients: ['not-an-address'] }, SERVICE);
check(r.status === 200 && r.sent[0].to[0] === 'support@punchclock.ca', 'only invalid recipients: falls back to the support inbox');

console.log(bad ? `\n${bad} PROBLEM(S)` : '\nALL GOOD');
process.exit(bad ? 1 : 0);
