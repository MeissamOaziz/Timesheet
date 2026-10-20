// send-verification: old vs new, same inputs, fake Resend. No email is ever sent.
//   git show HEAD:supabase/functions/send-verification/index.ts > /tmp/sv-old.ts
//   node tools/secure-db-regression/send-verification-diff-test.mjs /tmp/sv-old.ts supabase/functions/send-verification/index.ts
// Part 1: ordinary input must produce a byte-identical email (recipient, subject, HTML) in both versions.
// Part 2: hostile input must come out escaped / rejected in the new version.
// Part 3: dry-run must never reach Resend, and only works with the service key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldPath, newPath] = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-diff-'));
const SERVICE = 'service-key-for-test';
let resendCalls = [];

async function load(file, tag) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*$/gm, '');
  const out = path.join(scratch, `sv_${tag}.ts`);
  fs.writeFileSync(out, `globalThis.Deno={env:{get:(k)=>({RESEND_API_KEY:'resend-test',SUPABASE_SERVICE_ROLE_KEY:'${SERVICE}'}[k])}};\nconst serve=(h)=>{globalThis.__H=h;};\n` + src);
  globalThis.__H = null;
  await import(pathToFileURL(out).href + '?v=' + Date.now());
  return globalThis.__H;
}
async function call(handler, payload, headers = {}) {
  resendCalls = [];
  globalThis.fetch = async (u, init) => {
    resendCalls.push({ url: String(u), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'fake-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const req = new Request('https://fn/send-verification', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  const r = await handler(req);
  let j; try { j = await r.json(); } catch { j = null; }
  const sent = resendCalls.map(c => ({ to: c.body.to, subject: c.body.subject, html: c.body.html }));
  return { status: r.status, json: j, sent };
}

const hOld = await load(oldPath, 'old');
const hNew = await load(newPath, 'new');

// ---------- Part 1: identical for ordinary input ----------
const logo = 'https://uziwymrwaeojhqaagqcm.supabase.co/storage/v1/object/public/logos/c1.png';
const shifts = [
  { day: 'Tuesday, Oct 20', startTime: '13:00', endTime: '22:00', note: '', label: 'Counter', labelColor: '#4f8ef7' },
  { day: 'Thursday, Oct 22', startTime: '14:00', endTime: '22:00', note: 'Close up', label: '', labelColor: '' },
];
const ordinary = [
  ['registration code', { email: 'a@x.ca', name: 'Ann', code: '123456' }],
  ['password reset code', { email: 'a@x.ca', name: 'Ann Lee', code: '654321', purpose: 'password_reset' }],
  ['join approved', { email: 'a@x.ca', name: 'Ann', type: 'join_approved', adminName: 'Boss Man' }],
  ['join denied', { email: 'a@x.ca', name: 'Ann', type: 'join_request_denied', companyName: 'Acme Fence', adminName: 'Boss' }],
  ['schedule en', { email: 'a@x.ca', name: 'Gabor Torok', type: 'schedule', weekLabel: 'Oct 19 - Oct 25', shifts, lang: 'en' }],
  ['schedule fr', { email: 'a@x.ca', name: 'Gabor Torok', type: 'schedule', weekLabel: '19 oct. - 25 oct.', shifts, lang: 'fr' }],
  ['schedule empty', { email: 'a@x.ca', name: 'Gabor', type: 'schedule', weekLabel: 'Oct 19 - Oct 25', shifts: [], lang: 'en' }],
  ['employee invite with logo', { email: 'a@x.ca', name: 'Ann', type: 'employee_invite', portalUrl: 'https://www.punchclock.ca/employee.html?token=abc123', lang: 'en', companyName: 'Acme Fence', logoUrl: logo }],
  ['employee invite no logo fr', { email: 'a@x.ca', name: 'Ann', type: 'employee_invite', portalUrl: 'https://www.punchclock.ca/employee.html?token=abc123', lang: 'fr', companyName: '', logoUrl: '' }],
  ['invitation manager', { email: 'a@x.ca', name: 'a@x.ca', type: 'invitation', inviterName: 'Boss', companyName: 'Acme Fence', role: 'manager', token: '11111111-2222-3333-4444-555555555555' }],
  ['invitation co-admin', { email: 'a@x.ca', name: 'a@x.ca', type: 'invitation', inviterName: 'Boss', companyName: 'Acme Fence', role: 'co_admin', token: '11111111-2222-3333-4444-555555555555' }],
  ['new account notice', { email: 'n@x.ca', name: 'New Person', type: 'new_account_notification', userEmail: 'new@x.ca', plan: 'Free', regType: 'New Company', timestamp: '10/19/2026, 8:00:00 PM' }],
];
let bad = 0;
console.log('--- Part 1: ordinary input, old vs new');
for (const [name, payload] of ordinary) {
  const o = await call(hOld, payload), n = await call(hNew, payload);
  const same = o.status === n.status && JSON.stringify(o.sent) === JSON.stringify(n.sent) && o.sent.length === 1;
  if (!same) { bad++; console.log('!! DIFFERENT', name, o.status, n.status, o.sent.length, n.sent.length); }
  else console.log('identical  ', name.padEnd(28), `(${o.sent[0].html.length} chars)`);
}

// removed (unused) types must now be refused rather than quietly rendered
console.log('--- removed types');
for (const t of ['join_request', 'co_admin_invite', 'co_admin_invite_v2', 'co_admin_invite_accepted']) {
  const n = await call(hNew, { email: 'a@x.ca', name: 'A', type: t });
  const ok = n.status === 400 && n.sent.length === 0;
  if (!ok) bad++;
  console.log(ok ? 'refused    ' : '!! NOT REFUSED', t, n.status);
}

// ---------- Part 2: hostile input ----------
console.log('--- Part 2: hostile input (new version)');
const XSS = '<img src=x onerror=alert(1)>';
const hostile = [
  ['markup in a name', { email: 'a@x.ca', name: XSS, code: '123456' }, h => h.includes('&lt;img') && !h.includes('<img src=x')],
  ['markup in a shift note', { email: 'a@x.ca', name: 'A', type: 'schedule', weekLabel: XSS, lang: 'en', shifts: [{ day: XSS, startTime: '08:00', endTime: '09:00', note: XSS }] }, h => !h.includes('<img src=x') && h.includes('&lt;img')],
  ['markup in company and inviter', { email: 'a@x.ca', name: 'a@x.ca', type: 'invitation', inviterName: XSS, companyName: XSS, role: 'co_admin', token: 'abc' }, h => !h.includes('<img src=x')],
  ['quote breaking out of a link', { email: 'a@x.ca', name: 'A', type: 'invitation', inviterName: 'B', companyName: 'C', role: 'co_admin', token: '"><script>alert(1)</script>' }, h => !h.includes('<script>') && h.includes('invite=')],
  ['foreign link in an invite', { email: 'a@x.ca', name: 'A', type: 'employee_invite', portalUrl: 'https://evil.example/steal?token=1', lang: 'en', companyName: 'C' }, h => !h.includes('evil.example') && h.includes('www.punchclock.ca/employee.html')],
  ['javascript link', { email: 'a@x.ca', name: 'A', type: 'employee_invite', portalUrl: 'javascript:alert(1)', lang: 'en', companyName: 'C' }, h => !h.includes('javascript:')],
  ['foreign logo', { email: 'a@x.ca', name: 'A', type: 'employee_invite', portalUrl: 'https://www.punchclock.ca/employee.html?token=a', lang: 'en', companyName: 'C', logoUrl: 'https://evil.example/pixel.png' }, h => !h.includes('evil.example') && !h.includes('<img')],
];
for (const [name, payload, check] of hostile) {
  const n = await call(hNew, payload);
  const ok = n.status === 200 && n.sent.length === 1 && check(n.sent[0].html);
  if (!ok) bad++;
  console.log(ok ? 'neutralised' : '!! NOT NEUTRALISED', name);
}
let n = await call(hNew, { email: 'a@x.ca', name: 'A', type: 'join_approved', adminName: 'x', weekLabel: 'x' });
n = await call(hNew, { email: 'a@x.ca', name: 'A', type: 'schedule', weekLabel: 'Line1\r\nBcc: evil@x.ca', lang: 'en', shifts: [] });
{ const ok = n.sent.length === 1 && !/[\r\n]/.test(n.sent[0].subject); if (!ok) bad++; console.log(ok ? 'neutralised' : '!! NOT NEUTRALISED', 'newline in a subject header'); }
n = await call(hNew, { email: 'not-an-email', name: 'A', code: '123456' });
{ const ok = n.status === 400 && n.sent.length === 0; if (!ok) bad++; console.log(ok ? 'refused    ' : '!! NOT REFUSED', 'invalid recipient address'); }

// ---------- Part 3: dry run ----------
console.log('--- Part 3: dry run');
const dryPayload = { email: 'a@x.ca', name: 'Ann', type: 'schedule', weekLabel: 'Oct 19 - Oct 25', shifts, lang: 'en' };
n = await call(hNew, dryPayload, { 'x-dry-run': '1', authorization: `Bearer ${SERVICE}` });
{ const ok = n.status === 200 && n.json && n.json.dry === true && n.json.to === 'a@x.ca' && n.json.html.includes('Counter') && n.sent.length === 0; if (!ok) bad++; console.log(ok ? 'works      ' : '!! BROKEN', 'dry run with the service key returns the email and sends nothing'); }
n = await call(hNew, dryPayload, { 'x-dry-run': '1', authorization: 'Bearer public-anon-key' });
{ const ok = n.status === 401 && n.sent.length === 0; if (!ok) bad++; console.log(ok ? 'refused    ' : '!! NOT REFUSED', 'dry run with the public key (and nothing is sent)'); }
n = await call(hNew, dryPayload, { 'x-dry-run': '1' });
{ const ok = n.status === 401 && n.sent.length === 0; if (!ok) bad++; console.log(ok ? 'refused    ' : '!! NOT REFUSED', 'dry run with no key (and nothing is sent)'); }

console.log(bad ? `\n${bad} PROBLEM(S)` : '\nALL GOOD');
process.exit(bad ? 1 : 0);
