// Live smoke test for secure-db. Read-only calls plus writes that must be REFUSED (nothing is created).
// Prints a stable signature (no timestamps) so two runs can be diffed before/after a deploy:
//   node tools/secure-db-regression/live-smoke.mjs > before.json ; (deploy) ; node ... > after.json ; diff before.json after.json
// Punch counts move as people clock in and out, so ignore small changes in 'n' on the kiosk punch lines.
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const URL_ = /SUPA_URL\s*=\s*'([^']+)'/.exec(html)[1];
const KEY = /SUPA_KEY\s*=\s*'([^']+)'/.exec(html)[1];
const HAW1 = 'd3eaa156-0ed0-45ad-969e-0a97ed2ee62e', WIN1 = '97dbd2d2-a465-442c-bb56-5c4c49b04cc2';
const OAZIZ = 'bc8372da-6aed-4de6-acf0-b97224ed8bcc', THRIVE = 'e59d1153-5ea7-409b-95dd-6ff7e560c6bc';

async function sdb(payload) {
  const r = await fetch(`${URL_}/functions/v1/secure-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
  });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t.slice(0, 80); }
  return { status: r.status, body: j };
}
async function rpc(name, args) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sig = {};
const sum = (rows) => Array.isArray(rows) ? { n: rows.length } : { raw: rows };

for (const [label, site] of [['HAW1', HAW1], ['WIN1', WIN1], ['OAZIZ', OAZIZ], ['THRIVE', THRIVE]]) {
  // Kiosk reads, exactly as the punch screen makes them
  const p = await sdb({ table: 'punches', method: 'GET', filter: 'order=punched_at.desc', kioskSiteId: site });
  sig[`${label} kiosk punches`] = { status: p.status, ...(Array.isArray(p.body) ? { n: p.body.length, newestIsLast: p.body.length ? p.body[0].punched_at >= p.body[p.body.length - 1].punched_at : null } : { raw: p.body }) };
  const b = await rpc('get_kiosk_bootstrap', { p_site_id: site });
  sig[`${label} bootstrap`] = { status: b.status, ok: !!(b.body && b.body.ok), employees: (b.body && b.body.employees ? b.body.employees.length : null) };
  const l = await sdb({ table: 'work_labels', method: 'GET', filter: '', kioskSiteId: site });
  sig[`${label} kiosk labels`] = { status: l.status, ...sum(l.body) };
  const s = await sdb({ table: 'shifts', method: 'GET', filter: 'shift_date=eq.2026-10-19&order=shift_date.asc,start_time.asc', kioskSiteId: site });
  sig[`${label} kiosk shifts`] = { status: s.status, ...sum(s.body) };
}
// Protected reads without any session must not leak
for (const t of ['admins', 'companies', 'employees', 'admin_sessions', 'email_codes']) {
  const r = await sdb({ table: t, method: 'GET', filter: 'limit=1' });
  sig[`anon read ${t}`] = { status: r.status, leaked: Array.isArray(r.body) && r.body.length > 0 };
}
// Writes that must be refused (and therefore write nothing)
let r = await sdb({ table: 'punches', method: 'POST', body: { emp_id: '00000000-0000-0000-0000-000000000000', type: 'IN' } });
sig['anon punch insert, no kiosk, no session'] = { status: r.status };
r = await sdb({ table: 'employees', method: 'POST', body: { name: 'x' } });
sig['anon employee insert'] = { status: r.status };
r = await sdb({ table: 'punches', method: 'POST', kioskSiteId: HAW1, body: { emp_id: '00000000-0000-0000-0000-000000000000', type: 'IN', label_id: '00000000-0000-0000-0000-000000000001' } });
sig['kiosk punch with foreign label'] = { status: r.status };
r = await sdb({ table: 'punches', method: 'PATCH', filter: 'id=eq.00000000-0000-0000-0000-000000000000', body: { type: 'OUT' } });
sig['anon punch update'] = { status: r.status };
r = await sdb({ table: 'punches', method: 'DELETE', filter: 'id=eq.00000000-0000-0000-0000-000000000000' });
sig['anon punch delete'] = { status: r.status };
// Malformed input
r = await sdb({});
sig['empty request'] = { status: r.status };
r = await fetch(`${URL_}/functions/v1/secure-db`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` }, body: 'not json' });
sig['bad json'] = { status: r.status };
// Actions that exist today (all answer ok:true or refuse; none writes anything for an unknown address)
r = await sdb({ action: 'portal_request_reset', body: { email: 'nobody-here@example.invalid' } });
sig['portal reset, unknown address'] = { status: r.status, body: r.body };
r = await sdb({ action: 'start_scheduling_trial' });
sig['trial, no session'] = { status: r.status };
// A session-less call to the action this work adds must be refused (404/400 before, 401 after)
r = await sdb({ action: 'send_email', body: { type: 'schedule' } });
sig['send_email, no session'] = { status: r.status };

console.log(JSON.stringify(sig, null, 1));
