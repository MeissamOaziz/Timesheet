// Offline check of punch-alerts' forgot-to-clock-out copy for the EMPLOYEE (added 2026-11-24).
// A stubbed database holds one company and three employees still clocked in for 20 hours:
//   e1 has an active portal login  -> gets the email (and the push, with data.type 'forgot_out')
//   e2 has a portal login that is not active -> push only, no email
//   e3 has no portal login         -> push only, no email
// Names with markup must arrive escaped. A second run (sent_alerts says "already sent") sends nothing.
// The gate itself is covered by function-gate-test.mjs. Nothing leaves this process.
// Usage: node tools/secure-db-regression/punch-alerts-employee-test.mjs   (from the repo root; Node 22+)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVICE = 'svc-key-0123456789';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-emp-'));
let failures = 0;
const ok = (c, name, extra = '') => { if (!c) failures++; console.log(`${c ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

const IN_AT = new Date(Date.now() - 20 * 3600e3).toISOString();
const E = (n) => `00000000-0000-4000-8000-0000000000e${n}`;
let mails = [], pushes = [], dedupeSeen = new Set(), dedupeOn = true;
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  const body = init.body ? JSON.parse(init.body) : null;
  if (/api\.resend\.com/.test(url)) { mails.push(body); return json({ id: 'm' }); }
  if (/functions\/v1\/send-push/.test(url)) { pushes.push(body); return json({ ok: true }); }
  if (/internal_secrets/.test(url)) return json([{ value: 'c'.repeat(64) }]);
  if (/\/rest\/v1\/companies/.test(url)) return json([{ id: 'c1', name: 'Acme <b>Co</b>', admin_id: 'a1', alerts_enabled: true, alert_forgot_out: true, alert_overtime: false, track_overtime: false, punch_rounding: 0, forgot_out_hours: 14, ot_daily_hours: 8, digest_timezone: 'America/Toronto' }]);
  if (/\/rest\/v1\/employees/.test(url)) return json([
    { id: E(1), name: 'Max <script>x</script>', company_id: 'c1', site_id: 's1' },
    { id: E(2), name: 'Invited', company_id: 'c1', site_id: 's1' },
    { id: E(3), name: 'No Portal', company_id: 'c1', site_id: 's1' },
  ]);
  if (/\/rest\/v1\/punches/.test(url)) return json([1, 2, 3].map((n) => ({ id: `p${n}`, emp_id: E(n), company_id: 'c1', type: 'IN', punch_date: IN_AT.slice(0, 10), punched_at: IN_AT })));
  if (/\/rest\/v1\/admins\?id=in/.test(url)) return json([{ id: 'a1', email: 'owner@example.test', name: 'Owner', role: 'admin', status: 'active', expires_at: null, parent_admin_id: null }]);
  if (/\/rest\/v1\/admins/.test(url)) return json([]);
  if (/\/rest\/v1\/employee_portal/.test(url)) {
    // The function must ask for active logins only; answer like PostgREST would.
    const activeOnly = /status=eq\.active/.test(url);
    const rows = [{ employee_id: E(1), email: 'max@example.test', status: 'active' }, { employee_id: E(2), email: 'invited@example.test', status: 'invited' }];
    return json(rows.filter((r) => !activeOnly || r.status === 'active').map(({ employee_id, email }) => ({ employee_id, email })));
  }
  if (/\/rest\/v1\/sent_alerts/.test(url)) {
    const k = `${body.alert_type}|${body.ref_key}`;
    if (dedupeOn && dedupeSeen.has(k)) return json([]);
    dedupeSeen.add(k);
    return json([body]);
  }
  return json([]);
};

const src = fs.readFileSync('supabase/functions/punch-alerts/index.ts', 'utf8');
const out = path.join(scratch, 'punch-alerts.ts');
fs.writeFileSync(out,
  `globalThis.Deno={env:{get:(k)=>({SUPABASE_URL:'https://fake.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'${SERVICE}',RESEND_API_KEY:'re_test'}[k])},serve:(h)=>{globalThis.__H=h;}};\n` +
  src.replace(/^import .*$/gm, ''));
await import(pathToFileURL(out).href);
const h = globalThis.__H;
const run = () => h(new Request('https://fn/x', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE}` }, body: '{}' }));

let r = await run();
let j = await r.json();
await new Promise((res) => setTimeout(res, 50));
const empMails = mails.filter((m) => m.to?.[0] !== 'owner@example.test');
ok(r.status === 200 && j.ok, 'run answers ok', JSON.stringify(j));
ok(empMails.length === 1 && empMails[0].to[0] === 'max@example.test', 'only the employee with an active portal login is emailed', JSON.stringify(empMails.map((m) => m.to)));
ok(j.empEmailed === 1, 'the count is reported');
const html = empMails[0]?.html || '';
ok(!/<script>/.test(html) && /&lt;script&gt;/.test(html), 'the employee name is escaped');
ok(!/<b>Co<\/b>/.test(html) && /&lt;b&gt;Co&lt;\/b&gt;/.test(html), 'the company name is escaped');
ok(/employee\.html#missed/.test(html), 'the email links to the missed-punch form');
ok(/Report my clock-out time/.test(html) && /Signaler mon heure de sortie/.test(html), 'both languages');
const when = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(IN_AT));
ok(html.includes(when), 'the clock-in time is in the company time zone', when);
ok(!/[\r\n]/.test(empMails[0]?.subject || ''), 'the subject has no line breaks');
const empPushes = pushes.filter((p) => p.employee_ids);
ok(empPushes.length === 3 && empPushes.every((p) => p.data?.type === 'forgot_out'), 'every employee gets the push, typed forgot_out', JSON.stringify(empPushes.map((p) => p.data)));
ok(mails.some((m) => m.to?.[0] === 'owner@example.test'), 'the owner still gets the alert email');

mails = []; pushes = [];
r = await run(); j = await r.json();
await new Promise((res) => setTimeout(res, 50));
ok(mails.length === 0 && pushes.length === 0, 'a second run sends nothing (same open punch)', JSON.stringify({ mails: mails.length, pushes: pushes.length }));

console.log(failures ? `\n${failures} FAILED` : '\nall punch-alerts employee checks passed');
process.exit(failures ? 1 : 0);
