// Differential test: the deployed secure-db (OLD) vs the edited file (NEW), same requests, same fake database.
// Compares every response (status + body) and every upstream database call (method, url, body).
// Usage: node tools/secure-db-regression/diff-test.mjs <old.ts> <new.ts> [groups-allowed-to-differ,...]
//   e.g. git show HEAD:supabase/functions/secure-db/index.ts > /tmp/old.ts
//        node tools/secure-db-regression/diff-test.mjs /tmp/old.ts supabase/functions/secure-db/index.ts unlisted-tables
// Exit code 1 if any request outside the allowed groups behaves differently.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldPath, newPath, allowDiffArg] = process.argv.slice(2);
const allowDiff = new Set((allowDiffArg || '').split(',').filter(Boolean));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-db-diff-'));

// ---------- fake database ----------
const FUTURE = new Date(Date.now() + 36e5).toISOString();
const sessions = { tokOwner: 'a1', tokMgr: 'a2', tokSuper: 'sa', tokOther: 'b1', tokExpired: 'a1' };
const admins = {
  a1: { id: 'a1', parent_admin_id: null, role: 'admin', status: 'active' },
  a2: { id: 'a2', parent_admin_id: 'a1', role: 'manager', status: 'active' },
  sa: { id: 'sa', parent_admin_id: null, role: 'super_admin', status: 'active' },
  b1: { id: 'b1', parent_admin_id: null, role: 'admin', status: 'active' },
};
const companiesOf = { a1: ['c1'], b1: ['c9'] };
const sitesOf = { c1: ['s1', 's2'], c9: ['s9'] };
const employeesOf = { c1: ['e1', 'e2'], c9: ['e9'] };
const bigPunches = Array.from({ length: 2500 }, (_, i) => ({ id: 'p' + String(i).padStart(5, '0'), emp_id: 'e1', type: i % 2 ? 'OUT' : 'IN', punched_at: new Date(2026, 9, 1, 0, 0, i).toISOString(), site_id: 's1' }));
const tables = {
  punches: bigPunches,
  employees: [{ id: 'e1', name: 'A', company_id: 'c1', site_id: 's1', pin: '1234' }, { id: 'e2', name: 'B', company_id: 'c1', site_id: 's2', pin: '2222' }],
  shifts: [{ id: 'sh1', employee_id: 'e1', shift_date: '2026-10-19', start_time: '08:00:00', end_time: '16:00:00', label_id: null }],
  visitors: [{ id: 'v1', site_id: 's1', checked_out_at: null }],
  companies: [{ id: 'c1', admin_id: 'a1', name: 'Co', punch_label_mode: 'off' }],
  admins: [{ id: 'a1', name: 'Owner', email: 'o@x.ca', password: 'HASH', role: 'admin', status: 'active' }],
  work_labels: [{ id: 'l1', company_id: 'c1', name: 'Counter', color: '#4f8ef7', active: true, sort_order: 0 }],
  announcements: [{ id: 'n1', title: 'T', body: 'B', created_at: '2026-10-01' }],
  admin_sessions: [{ token: 'SECRET-TOKEN', admin_id: 'sa', expires_at: FUTURE }],
  email_codes: [{ id: 'k1', email: 'x@y.z', purpose: 'password_reset', code_hash: 'HASH' }],
  audit_log: [{ id: 'au1', event: 'write' }],
};

function parse(u) {
  const url = new URL(u);
  const m = /\/rest\/v1\/([^?]+)/.exec(url.pathname);
  return { kind: m ? 'rest' : (url.pathname.includes('/functions/v1/') ? 'fn' : 'other'), name: m ? m[1] : url.pathname, q: url.searchParams, raw: url.search.slice(1) };
}
let upstream = [];
function makeFetch() {
  return async (u, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const p = parse(String(u));
    upstream.push({ method, url: String(u).replace('https://fake.supabase.co', ''), body: init.body ? String(init.body).slice(0, 400) : null, prefer: (init.headers && init.headers.Prefer) || null });
    const j = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (p.kind === 'fn') return j({ success: true, sent: true });
    if (p.kind === 'rest' && p.name.startsWith('rpc/')) {
      if (p.name === 'rpc/issue_email_code') return j({ ok: true, exists: true, code: '123456', email: 'x@y.z', name: 'N' });
      return j({ ok: true });
    }
    if (p.kind !== 'rest') return j({});
    const t = p.name;
    const eq = (k) => (p.q.get(k) || '').replace(/^eq\./, '');
    if (t === 'admin_sessions' && p.q.has('token') && method === 'GET') {
      const tok = eq('token'); const aid = sessions[tok];
      return j(aid ? [{ admin_id: aid, expires_at: tok === 'tokExpired' ? new Date(Date.now() - 1e3).toISOString() : FUTURE }] : []);
    }
    if (t === 'admins' && method === 'GET' && p.q.get('select') && p.q.get('select').startsWith('id,parent_admin_id')) {
      const a = admins[eq('id')]; return j(a ? [a] : []);
    }
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'scheduling_addon') return j([{ scheduling_addon: eq('id') === 'a1' }]);
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'id' && p.q.has('parent_admin_id')) return j([{ id: 'a2' }]);
    if (t === 'companies' && method === 'GET' && p.q.has('admin_id')) return j((companiesOf[eq('admin_id')] || []).map(id => ({ id, admin_id: eq('admin_id') })));
    if (t === 'companies' && method === 'GET' && p.q.get('select') === 'admin_id,punch_label_mode') return j([{ admin_id: 'a1', punch_label_mode: 'off' }]);
    if (t === 'sites' && method === 'GET' && p.q.has('id') && p.q.get('select') === 'id') return j(['s1', 's2', 's9'].includes(eq('id')) ? [{ id: eq('id') }] : []);
    if (t === 'sites' && method === 'GET' && p.q.get('select') === 'company_id') return j([{ company_id: 'c1' }]);
    if (t === 'sites' && method === 'GET' && p.q.has('company_id')) { const cs = (p.q.get('company_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return j(cs.flatMap(c => (sitesOf[c] || []).map(id => ({ id })))); }
    if (t === 'employees' && method === 'GET' && p.q.has('company_id') && p.q.get('select') === 'id') { const cs = (p.q.get('company_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return j(cs.flatMap(c => (employeesOf[c] || []).map(id => ({ id })))); }
    if (t === 'work_labels' && method === 'GET' && p.q.get('select') === 'id') return j(p.q.has('id') ? (eq('id') === 'l1' ? [{ id: 'l1' }] : []) : [{ id: 'l1' }]);
    if (method === 'POST' && t === 'audit_log') return new Response(null, { status: 201 });
    if (method === 'GET' && tables[t]) {
      let rows = tables[t]; const off = parseInt(p.q.get('offset') || '0', 10); const lim = parseInt(p.q.get('limit') || String(rows.length), 10);
      const total = rows.length; rows = rows.slice(off, off + lim);
      const hdr = (init.headers && init.headers.Prefer === 'count=exact') ? { 'content-range': `${off}-${off + rows.length - 1}/${total}` } : {};
      return j(rows, 200, hdr);
    }
    if (method === 'POST' || method === 'PATCH') { let b = {}; try { b = JSON.parse(init.body || '{}'); } catch { } return j(Array.isArray(b) ? b : [{ id: 'new', ...b }], method === 'POST' ? 201 : 200); }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return j([]);
  };
}

// ---------- load a version of the function ----------
async function load(file, tag) {
  const src = fs.readFileSync(file, 'utf8');
  const out = path.join(scratch, `h_${tag}.ts`);
  fs.writeFileSync(out, "globalThis.Deno={env:{get:(k)=>({SUPABASE_URL:'https://fake.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'svc-key'}[k])},serve:(h)=>{globalThis.__H=h;}};\n" + src.replace(/^import .*$/gm, ''));
  globalThis.__H = null;
  await import(pathToFileURL(out).href + '?v=' + Date.now());
  return globalThis.__H;
}

// ---------- request corpus ----------
const S1 = 's1';
const R = (group, name, payload) => ({ group, name, payload });
const own = { sessionToken: 'tokOwner' }, mgr = { sessionToken: 'tokMgr' }, sup = { sessionToken: 'tokSuper' }, other = { sessionToken: 'tokOther' };
const cases = [
  // kiosk
  R('kiosk', 'read punches', { table: 'punches', method: 'GET', filter: 'order=punched_at.asc', kioskSiteId: S1 }),
  R('kiosk', 'read employees', { table: 'employees', method: 'GET', filter: '', kioskSiteId: S1 }),
  R('kiosk', 'read shifts narrowed', { table: 'shifts', method: 'GET', filter: 'employee_id=eq.00000000-0000-0000-0000-0000000000e1&shift_date=gte.2026-10-19&order=shift_date.asc,start_time.asc', kioskSiteId: S1 }),
  R('kiosk', 'read visitors', { table: 'visitors', method: 'GET', filter: 'checked_out_at=is.null', kioskSiteId: S1 }),
  R('kiosk', 'read labels', { table: 'work_labels', method: 'GET', filter: '', kioskSiteId: S1 }),
  R('kiosk', 'read with unknown site', { table: 'punches', method: 'GET', filter: '', kioskSiteId: 'nope' }),
  R('kiosk', 'read companies (not allowed)', { table: 'companies', method: 'GET', filter: '', kioskSiteId: S1 }),
  R('kiosk', 'punch IN', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', emp_name: 'A', company_id: 'c1', type: 'IN', punch_date: '2026-10-19', punch_time: '10:00:00', site_id: S1 } }),
  R('kiosk', 'punch OUT with break flag', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', type: 'OUT', is_break: true, site_id: S1 } }),
  R('kiosk', 'punch with own label', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', type: 'IN', site_id: S1, label_id: 'l1' } }),
  R('kiosk', 'punch with foreign label', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', type: 'IN', site_id: S1, label_id: '00000000-0000-0000-0000-000000000001' } }),
  R('kiosk', 'punch for another site', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', type: 'IN', site_id: 's2' } }),
  R('kiosk', 'missed punch request', { table: 'missed_punch_requests', method: 'POST', kioskSiteId: S1, body: { site_id: S1, emp_id: 'e1' } }),
  R('kiosk', 'visitor check-in', { table: 'visitors', method: 'POST', kioskSiteId: S1, body: { site_id: S1, name: 'V' } }),
  R('kiosk', 'visitor check-out', { table: 'visitors', method: 'PATCH', kioskSiteId: S1, filter: `id=eq.v1&site_id=eq.${S1}`, body: { checked_out_at: '2026-10-19T20:00:00Z' } }),
  R('kiosk', 'kiosk writes employees (refused)', { table: 'employees', method: 'POST', kioskSiteId: S1, body: { name: 'x', site_id: S1 } }),
  R('kiosk', 'kiosk deletes punch (refused)', { table: 'punches', method: 'DELETE', kioskSiteId: S1, filter: 'id=eq.p1' }),
  // anonymous
  R('anon', 'read admins', { table: 'admins', method: 'GET', filter: 'limit=1' }),
  R('anon', 'pre-auth admin lookup', { table: 'admins', method: 'GET', filter: 'email=eq.o@x.ca' }),
  R('anon', 'read punches', { table: 'punches', method: 'GET', filter: '' }),
  R('anon', 'read announcements (public)', { table: 'announcements', method: 'GET', filter: 'order=created_at.desc' }),
  R('anon', 'write announcements', { table: 'announcements', method: 'POST', body: { title: 'x', body: 'y' } }),
  R('anon', 'insert punch', { table: 'punches', method: 'POST', body: { emp_id: 'e1', type: 'IN' } }),
  // admin reads
  R('admin', 'owner reads punches (paged 2500)', { table: 'punches', method: 'GET', filter: 'order=punched_at.asc&limit=3000', ...own }),
  R('admin', 'owner reads punches (date range, no limit)', { table: 'punches', method: 'GET', filter: 'punched_at=gte.2026-10-01&order=punched_at.asc', ...own }),
  R('admin', 'owner reads employees', { table: 'employees', method: 'GET', filter: 'active=eq.true', ...own }),
  R('admin', 'owner reads companies', { table: 'companies', method: 'GET', filter: '', ...own }),
  R('admin', 'owner reads admins (hash stripped)', { table: 'admins', method: 'GET', filter: 'id=eq.a1', ...own }),
  R('admin', 'owner reads shifts', { table: 'shifts', method: 'GET', filter: 'shift_date=gte.2026-10-19&order=start_time.asc', ...own }),
  R('admin', 'owner reads labels', { table: 'work_labels', method: 'GET', filter: 'order=sort_order.asc', ...own }),
  R('admin', 'manager reads punches', { table: 'punches', method: 'GET', filter: 'order=punched_at.asc', ...mgr }),
  R('admin', 'super admin reads companies', { table: 'companies', method: 'GET', filter: '', ...sup }),
  R('admin', 'expired token reads punches', { table: 'punches', method: 'GET', filter: '', sessionToken: 'tokExpired' }),
  R('admin', 'bad token reads punches', { table: 'punches', method: 'GET', filter: '', sessionToken: 'nope' }),
  // admin writes
  R('admin', 'owner inserts punch', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'IN', is_manual: true }, ...own }),
  R('admin', 'owner inserts punch with label', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'IN', label_id: 'l1' }, ...own }),
  R('admin', 'owner edits punch', { table: 'punches', method: 'PATCH', filter: 'id=eq.p00001', body: { type: 'OUT', punch_time: '12:00:00' }, ...own }),
  R('admin', 'owner deletes punch', { table: 'punches', method: 'DELETE', filter: 'id=eq.p00001', ...own }),
  R('admin', 'owner inserts shift', { table: 'shifts', method: 'POST', body: { employee_id: 'e1', company_id: 'c1', shift_date: '2026-10-20', start_time: '08:00', end_time: '16:00' }, ...own }),
  R('admin', 'owner inserts employee', { table: 'employees', method: 'POST', body: { name: 'N', company_id: 'c1', site_id: 's1' }, ...own }),
  R('admin', 'owner writes other tenant company (refused)', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c9', type: 'IN' }, ...own }),
  R('admin', 'owner writes other tenant employee (refused)', { table: 'punches', method: 'POST', body: { emp_id: 'e9', company_id: 'c1', type: 'IN' }, ...own }),
  R('admin', 'owner sets plan (refused)', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { plan: 'business' }, ...own }),
  R('admin', 'owner creates label (add-on on)', { table: 'work_labels', method: 'POST', body: { company_id: 'c1', name: 'Kitchen', color: '#14b8a6' }, ...own }),
  R('admin', 'manager creates label (refused)', { table: 'work_labels', method: 'POST', body: { company_id: 'c1', name: 'x' }, ...mgr }),
  R('admin', 'other tenant creates label (add-on off)', { table: 'work_labels', method: 'POST', body: { company_id: 'c9', name: 'x' }, ...other }),
  R('admin', 'owner writes announcements (refused)', { table: 'announcements', method: 'POST', body: { title: 'x', body: 'y' }, ...own }),
  R('admin', 'super admin writes announcements', { table: 'announcements', method: 'POST', body: { title: 'x', body: 'y' }, ...sup }),
  // actions
  R('actions', 'portal reset', { action: 'portal_request_reset', body: { email: 'e@x.ca' } }),
  R('actions', 'admin reset', { action: 'request_reset_code', body: { email: 'e@x.ca' } }),
  R('actions', 'registration code', { action: 'request_registration_code', body: { email: 'n@x.ca', name: 'N' } }),
  R('actions', 'trial without session', { action: 'start_scheduling_trial' }),
  // malformed
  R('misc', 'empty object', {}),
  R('misc', 'missing method', { table: 'punches' }),
  // tables the app does not use (these are the ones allowed to differ: they were open, they must now be closed)
  R('unlisted-tables', 'anon reads admin_sessions', { table: 'admin_sessions', method: 'GET', filter: 'limit=1' }),
  R('unlisted-tables', 'anon reads email_codes', { table: 'email_codes', method: 'GET', filter: 'limit=1' }),
  R('unlisted-tables', 'anon reads audit_log', { table: 'audit_log', method: 'GET', filter: 'limit=1' }),
  R('unlisted-tables', 'owner reads admin_sessions', { table: 'admin_sessions', method: 'GET', filter: '', ...own }),
  R('unlisted-tables', 'owner inserts admin_sessions (session forging)', { table: 'admin_sessions', method: 'POST', body: { token: 'forged', admin_id: 'a1', expires_at: FUTURE }, ...own }),
  R('unlisted-tables', 'manager forges owner session', { table: 'admin_sessions', method: 'POST', body: { token: 'forged2', admin_id: 'a1', expires_at: FUTURE }, ...mgr }),
  R('unlisted-tables', 'owner deletes admin_sessions', { table: 'admin_sessions', method: 'DELETE', filter: 'admin_id=eq.sa', ...own }),
  R('unlisted-tables', 'super admin reads admin_sessions', { table: 'admin_sessions', method: 'GET', filter: '', ...sup }),
  R('unlisted-tables', 'unknown table', { table: 'whatever', method: 'GET', filter: '' }),
];

async function run(handler) {
  const results = [];
  for (const c of cases) {
    upstream = [];
    globalThis.fetch = makeFetch();
    const req = new Request('https://fn/secure-db', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.payload) });
    let status, body;
    try { const r = await handler(req); status = r.status; const t = await r.text(); try { body = JSON.parse(t); } catch { body = t; } }
    catch (e) { status = 'THROW'; body = String(e.message || e); }
    // the audit log write is fire-and-forget and order-independent; keep it but sort for stability
    results.push({ ...c, status, body: JSON.stringify(body).slice(0, 600), calls: upstream.filter(u => !/audit_log/.test(u.url)).map(u => `${u.method} ${u.url} ${u.body || ''}`) });
  }
  return results;
}

const hOld = await load(oldPath, 'old');
const oldRes = await run(hOld);
const hNew = await load(newPath, 'new');
const newRes = await run(hNew);

let same = 0, diff = 0, unexpected = 0;
for (let i = 0; i < cases.length; i++) {
  const o = oldRes[i], n = newRes[i];
  const identical = o.status === n.status && o.body === n.body && JSON.stringify(o.calls) === JSON.stringify(n.calls);
  if (identical) { same++; continue; }
  diff++;
  const ok = allowDiff.has(o.group);
  if (!ok) unexpected++;
  console.log(`${ok ? 'EXPECTED DIFF' : '!! UNEXPECTED DIFF'} [${o.group}] ${o.name}\n   old: ${o.status} ${o.body.slice(0, 110)}   (${o.calls.length} upstream calls)\n   new: ${n.status} ${n.body.slice(0, 110)}   (${n.calls.length} upstream calls)`);
}
console.log(`\n${cases.length} requests: ${same} identical, ${diff} different (${unexpected} unexpected)`);
// Also report what the corpus actually exercised, so a silent "everything 401" run cannot pass as a success
const bucket = {};
for (const r of newRes) { const k = `${r.group}:${r.status}`; bucket[k] = (bucket[k] || 0) + 1; }
console.log('status mix (new):', JSON.stringify(bucket));
process.exit(unexpected ? 1 : 0);
