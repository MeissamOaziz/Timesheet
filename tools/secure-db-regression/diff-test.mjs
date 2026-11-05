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
const E_LOCKED = '00000000-0000-4000-8000-0000000000e4';
const E_OWN = '00000000-0000-4000-8000-0000000000e1', E_NOMAIL = '00000000-0000-4000-8000-0000000000e2', E_OTHER = '00000000-0000-4000-8000-0000000000e9', E_THROTTLED = '00000000-0000-4000-8000-0000000000e3';
const T_OK = '11111111-1111-4111-8111-111111111111', T_OTHER = '11111111-1111-4111-8111-111111111112', T_EXPIRED = '11111111-1111-4111-8111-111111111113', T_USED = '11111111-1111-4111-8111-111111111114';
const J_OK = '22222222-2222-4222-8222-222222222221', J_PENDING = '22222222-2222-4222-8222-222222222222', J_OTHER = '22222222-2222-4222-8222-222222222223', J_DENIED = '22222222-2222-4222-8222-222222222224';
const PAST = new Date(Date.now() - 864e5).toISOString();
const empRows = {
  [E_OWN]: { id: E_OWN, name: 'Ann Lee', email: 'Ann@x.ca', company_id: 'c1', site_id: 's1', pin: '1234' },
  [E_NOMAIL]: { id: E_NOMAIL, name: 'No Mail', email: null, company_id: 'c1', site_id: 's1', pin: '2222' },
  [E_THROTTLED]: { id: E_THROTTLED, name: 'Busy Bee', email: null, company_id: 'c1', site_id: 's1', pin: '3333' },
  [E_OTHER]: { id: E_OTHER, name: 'Other Tenant', email: 'o@other.ca', company_id: 'c9', site_id: 's9', pin: '9999' },
};
empRows.e1 = { id: 'e1', company_id: 'c1', site_id: 's1' }; empRows.e9 = { id: 'e9', company_id: 'c9', site_id: 's9' };
const invRows = {
  [T_OK]: { token: T_OK, email: 'inv@x.ca', role: 'manager', company_id: 'c1', status: 'pending', expires_at: FUTURE },
  [T_OTHER]: { token: T_OTHER, email: 'inv@other.ca', role: 'co_admin', company_id: 'c9', status: 'pending', expires_at: FUTURE },
  [T_EXPIRED]: { token: T_EXPIRED, email: 'old@x.ca', role: 'co_admin', company_id: 'c1', status: 'pending', expires_at: PAST },
  [T_USED]: { token: T_USED, email: 'used@x.ca', role: 'co_admin', company_id: 'c1', status: 'accepted', expires_at: FUTURE },
};
const portalRows = {
  [E_OWN]: { employee_id: E_OWN, email: 'ann@x.ca', invite_token: 'tok abc/123', token_expires_at: FUTURE, status: 'invited' },
  [E_NOMAIL]: { employee_id: E_NOMAIL, email: 'nomail@x.ca', invite_token: null, token_expires_at: FUTURE, status: 'active' },
  [E_OTHER]: { employee_id: E_OTHER, email: 'o@other.ca', invite_token: 'zzz', token_expires_at: FUTURE, status: 'invited' },
};
const joinRows = {
  [J_OK]: { id: J_OK, requester_email: 'new@x.ca', requester_name: 'New Person', target_admin_id: 'a1', status: 'approved' },
  [J_PENDING]: { id: J_PENDING, requester_email: 'p@x.ca', requester_name: 'Pending', target_admin_id: 'a1', status: 'pending' },
  [J_OTHER]: { id: J_OTHER, requester_email: 'x@other.ca', requester_name: 'X', target_admin_id: 'b1', status: 'approved' },
  [J_DENIED]: { id: J_DENIED, requester_email: 'd@x.ca', requester_name: '', target_admin_id: 'a1', status: 'denied' },
};
const adminProfile = {
  a1: { name: 'Owner Name', email: 'o@x.ca', plan: 'starter', created_at: '2026-01-01T00:00:00Z' },
  a2: { name: 'Manager Name', email: 'm@x.ca', plan: 'free', created_at: '2026-02-01T00:00:00Z' },
  sa: { name: 'Super', email: 's@x.ca', plan: 'free', created_at: '2025-01-01T00:00:00Z' },
  b1: { name: 'Other Owner', email: 'b@y.ca', plan: 'free', created_at: '2026-03-01T00:00:00Z' },
  a3: { name: 'Brand New', email: 'new-account@x.ca', plan: 'free', created_at: new Date().toISOString() },
};
// Scheduling trial: t1 is inside its free trial, x1 used it up, d1 has never started one
sessions.tokTrial = 't1'; sessions.tokTrialOver = 'x1'; sessions.tokNoTrial = 'd1';
admins.t1 = { id: 't1', parent_admin_id: null, role: 'admin', status: 'active' };
admins.x1 = { id: 'x1', parent_admin_id: null, role: 'admin', status: 'active' };
admins.d1 = { id: 'd1', parent_admin_id: null, role: 'admin', status: 'active' };
companiesOf.t1 = ['c7']; companiesOf.x1 = ['c6'];
sitesOf.c7 = ['s7']; sitesOf.c6 = ['s6'];
sessions.tokNew = 'a3'; admins.a3 = { id: 'a3', parent_admin_id: null, role: 'admin', status: 'active' };
// Private images: an account whose company id is a real uuid (uploads are filed under <company uuid>/)
const CO_IMG = '55555555-5555-4555-8555-555555555551', CO_FOREIGN = '55555555-5555-4555-8555-555555555552', SITE_UUID = '66666666-6666-4666-8666-666666666661';
sessions.tokImg = 'im1'; admins.im1 = { id: 'im1', parent_admin_id: null, role: 'admin', status: 'active' }; companiesOf.im1 = [CO_IMG];
const PUB = 'https://fake.supabase.co/storage/v1/object/public';
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

// ---- rows for the notify / period-summary / survey / role cases (added 2026-11-01) ----
const NOW_ISO = new Date().toISOString(), HOUR_AGO = new Date(Date.now() - 36e5).toISOString();
const MPR_OK = '33333333-3333-4333-8333-333333333331', MPR_S2 = '33333333-3333-4333-8333-333333333332', MPR_OLD = '33333333-3333-4333-8333-333333333333', MPR_DUP = '33333333-3333-4333-8333-333333333334', MPR_APPR = '33333333-3333-4333-8333-333333333335', MPR_OTHER = '33333333-3333-4333-8333-333333333336', MPR_E2 = '33333333-3333-4333-8333-333333333337';
const mprRows = {
  [MPR_OK]: { id: MPR_OK, company_id: 'c1', site_id: 's1', emp_id: 'e1', status: 'pending', created_at: NOW_ISO },
  [MPR_S2]: { id: MPR_S2, company_id: 'c1', site_id: 's2', emp_id: 'e1', status: 'pending', created_at: NOW_ISO },
  [MPR_OLD]: { id: MPR_OLD, company_id: 'c1', site_id: 's1', emp_id: 'e1', status: 'pending', created_at: HOUR_AGO },
  [MPR_DUP]: { id: MPR_DUP, company_id: 'c1', site_id: 's1', emp_id: 'e1', status: 'pending', created_at: NOW_ISO },
  [MPR_APPR]: { id: MPR_APPR, company_id: 'c1', site_id: 's1', emp_id: 'e1', status: 'approved', created_at: HOUR_AGO },
  [MPR_OTHER]: { id: MPR_OTHER, company_id: 'c9', site_id: 's9', emp_id: 'e9', status: 'approved', created_at: HOUR_AGO },
  [MPR_E2]: { id: MPR_E2, company_id: 'c1', site_id: 's2', emp_id: 'e2', status: 'approved', created_at: HOUR_AGO },
};
const TO_OK = '44444444-4444-4444-8444-444444444441', TO_ADMIN = '44444444-4444-4444-8444-444444444442';
const toRows = {
  [TO_OK]: { id: TO_OK, company_id: 'c1', site_id: 's1', emp_id: E_OWN, status: 'pending', requested_by: 'employee', created_at: NOW_ISO },
  [TO_ADMIN]: { id: TO_ADMIN, company_id: 'c1', site_id: 's1', emp_id: E_OWN, status: 'pending', requested_by: 'admin', created_at: NOW_ISO },
};
const TOK_S_OK = 'aa11bb22cc33dd44aa11bb22cc33dd44', TOK_S_SENT = 'aa11bb22cc33dd44aa11bb22cc33dd45', TOK_S_OLD = 'aa11bb22cc33dd44aa11bb22cc33dd46', TOK_S_DUP = 'aa11bb22cc33dd44aa11bb22cc33dd47';
const INV_DUP = 'inv-dup';
const surveyInvites = {
  [TOK_S_OK]: { id: 'inv-ok', status: 'responded', responded_at: NOW_ISO },
  [TOK_S_SENT]: { id: 'inv-sent', status: 'sent', responded_at: null },
  [TOK_S_OLD]: { id: 'inv-old', status: 'responded', responded_at: HOUR_AGO },
  [TOK_S_DUP]: { id: INV_DUP, status: 'responded', responded_at: NOW_ISO },
};
admins.a4 = { id: 'a4', parent_admin_id: 'a1', role: 'manager', status: 'active' };   // a second manager under a1
admins.a5 = { id: 'a5', parent_admin_id: 'a1', role: 'admin', status: 'active' };     // a co-admin under a1
sessions.tokCoAdmin = 'a5';
empRows.e2 = { id: 'e2', company_id: 'c1', site_id: 's2' };

// ---- manager write scope (added 2026-11-05) ----
// a2 is a manager of site s1 only (see the manager_sites rule below). f1 is a second owner whose company cF has switched
// "managers can schedule staff from all sites" on; its manager fm runs sF1 only.
admins.f1 = { id: 'f1', parent_admin_id: null, role: 'admin', status: 'active' };
admins.fm = { id: 'fm', parent_admin_id: 'f1', role: 'manager', status: 'active' };
sessions.tokFlagOwn = 'f1'; sessions.tokFlagMgr = 'fm';
companiesOf.f1 = ['cF']; sitesOf.cF = ['sF1', 'sF2']; employeesOf.cF = ['eF1', 'eF2'];
empRows.eF1 = { id: 'eF1', company_id: 'cF', site_id: 'sF1' }; empRows.eF2 = { id: 'eF2', company_id: 'cF', site_id: 'sF2' };
const siteCompanyOf = { s1: 'c1', s2: 'c1', s9: 'c9', sF1: 'cF', sF2: 'cF' };
const sr = (id, o) => ({ id, company_id: 'c1', ...o });
const scopeRows = {
  punches: { pS1: sr('pS1', { emp_id: 'e1', site_id: 's1' }), pS2: sr('pS2', { emp_id: 'e1', site_id: 's2' }),
    pNoneE1: sr('pNoneE1', { emp_id: 'e1', site_id: null }), pNoneE2: sr('pNoneE2', { emp_id: 'e2', site_id: null }),
    pF2: { id: 'pF2', company_id: 'cF', emp_id: 'eF2', site_id: 'sF2' } },
  time_off: { toS1: sr('toS1', { emp_id: 'e1', site_id: 's1' }), toS2: sr('toS2', { emp_id: 'e2', site_id: 's2' }) },
  missed_punch_requests: { mS1: sr('mS1', { emp_id: 'e1', site_id: 's1' }), mS2: sr('mS2', { emp_id: 'e2', site_id: 's2' }) },
  shifts: { shS1: sr('shS1', { employee_id: 'e1', site_id: 's1' }), shS2: sr('shS2', { employee_id: 'e2', site_id: 's2' }),
    shF2: { id: 'shF2', company_id: 'cF', employee_id: 'eF2', site_id: 'sF2' } },
  visitors: { vS1: sr('vS1', { site_id: 's1' }), vS2: sr('vS2', { site_id: 's2' }) },
  availability: { avE1: { id: 'avE1', employee_id: 'e1' }, avE2: { id: 'avE2', employee_id: 'e2' } },
  employee_portal: { epE1: { id: 'epE1', employee_id: 'e1' }, epE2: { id: 'epE2', employee_id: 'e2' } },
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
    const dryHdr = !!(init.headers && init.headers['x-dry-run']);
    upstream.push({ method, url: String(u).replace('https://fake.supabase.co', ''), body: init.body ? String(init.body).slice(0, 60000) : null, prefer: (init.headers && init.headers.Prefer) || null, dry: dryHdr });
    const j = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (/\/storage\/v1\/object\/sign\//.test(String(u))) {
      // batch endpoint: POST /object/sign/<bucket> {expiresIn, paths}; a path containing "missing" cannot be signed
      const bucket = String(u).split('/object/sign/')[1]; let b = {}; try { b = JSON.parse(init.body); } catch { }
      return j((b.paths || []).map(pth => pth.includes('missing') ? { error: 'Object not found', path: pth, signedURL: null } : { error: null, path: pth, signedURL: `/object/sign/${bucket}/${pth}?token=T${b.expiresIn}` }));
    }
    if (p.kind === 'fn') { if (dryHdr) { let b = {}; try { b = JSON.parse(init.body); } catch { } return j({ success: true, dry: true, to: b.email, subject: 'S', html: '<html>' + (b.type || '') + '</html>' }); } return j({ success: true, sent: true }); }
    if (p.kind === 'rest' && p.name.startsWith('rpc/')) {
      if (p.name === 'rpc/get_kiosk_bootstrap_v2') return j({ ok: true, site: { id: SITE_UUID, company_id: 'cK' }, company: { id: 'cK', name: 'Kiosk Co', logo_url: PUB + '/logos/kiosk-logo-1.png' },
        employees: [{ id: 'k1', name: 'K One', photo_url: PUB + '/avatars/kiosk-photo-1.png', has_pin: true }, { id: 'k2', name: 'K Two', photo_url: null, has_pin: false }] });
      if (p.name === 'rpc/issue_email_code') return j({ ok: true, exists: true, code: '123456', email: 'x@y.z', name: 'N' });
      if (p.name === 'rpc/kiosk_recent_punches') { let b = {}; try { b = JSON.parse(init.body); } catch { } return b.p_site_id === 's8' ? j({ message: 'function not found' }, 404) : j(tables.punches.slice(0, 12)); }
      // plan helpers: tenant b1 is a Free account past its preview, everyone else is paid
      if (p.name === 'rpc/_resolve_portal_session') { let b = {}; try { b = JSON.parse(init.body); } catch { } return j(b.p_token === 'ptokE1' ? E_OWN : b.p_token === 'ptokOther' ? E_OTHER : null); }
      if (p.name === 'rpc/has_paid_features') { let b = {}; try { b = JSON.parse(init.body); } catch { } return j(b.p_admin !== 'b1'); }
      if (p.name === 'rpc/company_has_paid_features') { let b = {}; try { b = JSON.parse(init.body); } catch { } return j(b.p_company !== 'c9'); }
      if (p.name === 'rpc/admin_plan_rank') { let b = {}; try { b = JSON.parse(init.body); } catch { } return j(b.p_admin === 'b1' ? 0 : 3); }
      return j({ ok: true });
    }
    if (p.kind !== 'rest') return j({});
    const t = p.name;
    const eq = (k) => (p.q.get(k) || '').replace(/^eq\./, '');
    // ---- manager write scope (added 2026-11-05): what a write would hit, the employees behind it, site -> company, the flag ----
    if (method === 'GET' && scopeRows[t] && /^id,(emp_id|employee_id|site_id)/.test(p.q.get('select') || '')) {
      let rows = Object.values(scopeRows[t]);
      const listOf = (v) => v.startsWith('in.(') ? v.slice(4, -1).split(',') : [v.replace(/^eq\./, '')];
      if (p.q.get('id')) { const ids = listOf(p.q.get('id')); rows = rows.filter(r => ids.includes(r.id)); }
      for (const k of ['emp_id', 'employee_id']) { if (p.q.get(k)) { const ids = listOf(p.q.get(k)); rows = rows.filter(r => ids.includes(r[k])); } }
      if (eq('emp_id') === 'eBig') rows = Array.from({ length: 1001 }, (_, i) => ({ id: 'b' + i, emp_id: 'eBig', site_id: 's1', company_id: 'c1' }));
      const lim = parseInt(p.q.get('limit') || '0', 10);
      return j(lim ? rows.slice(0, lim) : rows);
    }
    if (t === 'employees' && method === 'GET' && p.q.get('select') === 'id,site_id,company_id' && p.q.has('id')) {
      const ids = (p.q.get('id') || '').replace(/^in\.\(|\)$/g, '').split(',');
      return j(ids.map(id => empRows[id]).filter(Boolean).map(r => ({ id: r.id, site_id: r.site_id, company_id: r.company_id })));
    }
    if (t === 'sites' && method === 'GET' && p.q.get('select') === 'id,company_id' && p.q.has('id')) {
      const ids = (p.q.get('id') || '').replace(/^in\.\(|\)$/g, '').split(',');
      return j(ids.filter(id => siteCompanyOf[id]).map(id => ({ id, company_id: siteCompanyOf[id] })));
    }
    if (t === 'companies' && method === 'GET' && p.q.has('managers_see_all_sites')) return j(eq('admin_id') === 'f1' ? [{ id: 'cF' }] : []);
    if (t === 'admin_sessions' && p.q.has('token') && method === 'GET') {
      const tok = eq('token'); const aid = sessions[tok];
      return j(aid ? [{ admin_id: aid, expires_at: tok === 'tokExpired' ? new Date(Date.now() - 1e3).toISOString() : FUTURE }] : []);
    }
    if (t === 'admins' && method === 'GET' && p.q.get('select') && p.q.get('select').startsWith('id,parent_admin_id')) {
      const a = admins[eq('id')]; return j(a ? [a] : []);
    }
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'scheduling_addon') return j([{ scheduling_addon: eq('id') === 'a1' }]);
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'scheduling_trial_ends_at') return j([{ scheduling_trial_ends_at: eq('id') === 't1' ? FUTURE : eq('id') === 'x1' ? PAST : null }]);
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'scheduling_addon,scheduling_trial_ends_at') return j([{ scheduling_addon: eq('id') === 'a1', scheduling_trial_ends_at: eq('id') === 't1' ? FUTURE : eq('id') === 'x1' ? PAST : null }]);
    if (t === 'admins' && method === 'GET' && p.q.get('select') === 'id' && p.q.has('parent_admin_id')) return j([{ id: 'a2' }]);
    if (t === 'companies' && method === 'GET' && p.q.has('admin_id')) return j((companiesOf[eq('admin_id')] || []).map(id => ({ id, admin_id: eq('admin_id'), name: 'Acme Fence' })));
    if (t === 'companies' && method === 'GET' && p.q.get('select') === 'admin_id,punch_label_mode') return j(eq('id') === 'c7' ? [{ admin_id: 't1', punch_label_mode: 'optional' }] : eq('id') === 'c6' ? [{ admin_id: 'x1', punch_label_mode: 'optional' }] : [{ admin_id: 'a1', punch_label_mode: 'off' }]);
    if (t === 'sites' && method === 'GET' && p.q.has('id') && p.q.get('select') === 'id') return j(['s1', 's2', 's8', 's9', 's7', 's6', 'sImg'].includes(eq('id')) ? [{ id: eq('id') }] : []);
    if (t === 'sites' && method === 'GET' && p.q.get('select') === 'company_id') return j([{ company_id: eq('id') === 's7' ? 'c7' : eq('id') === 's6' ? 'c6' : 'c1' }]);
    if (t === 'sites' && method === 'GET' && p.q.has('company_id')) { const cs = (p.q.get('company_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return j(cs.flatMap(c => (sitesOf[c] || []).map(id => ({ id })))); }
    if (t === 'employees' && method === 'GET' && (p.q.has('imgtest') || p.q.get('site_id') === 'eq.sImg')) return j([
      { id: 'i1', name: 'One', photo_url: `${PUB}/avatars/${CO_IMG}/photo-aaa.png`, company_id: CO_IMG }, { id: 'i2', name: 'Two', photo_url: `${PUB}/avatars/legacy-2.png` },
      { id: 'i3', name: 'Three', photo_url: null }, { id: 'i4', name: 'Four', photo_url: 'https://evil.example/x.png' }, { id: 'i5', name: 'Five', photo_url: `${PUB}/avatars/missing-5.png` }]);
    if ((t === 'employees' || t === 'companies') && method === 'GET' && (p.q.get('photo_url') || p.q.get('logo_url') || '').includes('legacy-used')) return j([{ id: 'u1' }]);
    if ((t === 'employees' || t === 'companies') && method === 'GET' && (p.q.has('photo_url') || p.q.has('logo_url'))) return j([]);
    if (t === 'employees' && method === 'GET' && p.q.has('company_id') && p.q.get('select') === 'id') { const cs = (p.q.get('company_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return j(cs.flatMap(c => (employeesOf[c] || []).map(id => ({ id })))); }
    if (t === 'work_labels' && method === 'GET' && p.q.get('select') === 'id') return j(p.q.has('id') ? (eq('id') === 'l1' ? [{ id: 'l1' }] : []) : [{ id: 'l1' }]);
    if (method === 'POST' && t === 'audit_log') {
      // like the real table: a bigint id comes back when the caller asks for the representation
      if (init.headers && init.headers.Prefer === 'return=representation') return j([{ id: 4242 }], 201);
      return new Response(null, { status: 201 });
    }
    const pick = (map, key) => { const r = map[key]; return r ? [r] : []; };
    if (t === 'invitations' && method === 'GET' && p.q.has('token')) return j(pick(invRows, eq('token')));
    if (t === 'employee_portal' && method === 'GET' && p.q.has('employee_id')) return j(pick(portalRows, eq('employee_id')));
    if (t === 'join_requests' && method === 'GET' && p.q.has('id')) return j(pick(joinRows, eq('id')));
    if (t === 'employees' && method === 'GET' && p.q.has('id') && p.q.get('select') !== 'id') return j(pick(empRows, eq('id')));
    if (t === 'companies' && method === 'GET' && p.q.has('id') && !p.q.has('admin_id')) return j([{ id: eq('id'), name: 'Acme Fence', logo_url: PUB + '/logos/c1.png' }]);
    if (t === 'admins' && method === 'GET' && p.q.has('id') && /^name/.test(p.q.get('select') || '')) return j(pick(adminProfile, eq('id')));
    if (t === 'audit_log' && method === 'GET' && (p.q.get('table_name') || '').includes(MPR_DUP)) return j([{ id: 9 }]);
    if (t === 'audit_log' && method === 'GET' && (p.q.get('table_name') || '').includes('invite:' + INV_DUP)) return j([{ id: 9 }]);
    if (t === 'audit_log' && method === 'GET' && p.q.has('admin_id')) {
      // per-admin send history: b1 has used up both ceilings, a2 has sent 100 schedules, the super admin has sent plenty
      const who = (p.q.get('admin_id') || '').replace('eq.', '');
      const rows = (n, ev) => Array.from({ length: n }, (_, i) => ({ id: i, event: ev }));
      if (who === 'b1') return j([...rows(30, 'email_sent:invitation'), ...rows(300, 'email_sent:schedule')]);
      if (who === 'a2') return j(rows(100, 'email_sent:schedule'));
      if (who === 'sa') return j([...rows(100, 'email_sent:invitation'), ...rows(300, 'email_sent:schedule')]);
      return j([]);
    }
    if (t === 'audit_log' && method === 'GET' && p.q.has('event')) return j((p.q.get('filter') || '').includes(E_LOCKED) ? [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }] : (p.q.get('filter') || '').includes(E_THROTTLED) ? [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] : []);
    // ---- rows for the notify / period-summary / survey / role cases (added 2026-11-01) ----
    if (t === 'admins' && method === 'GET' && (p.q.has('marker') || (p.q.get('select') || '').includes('stripe_customer_id'))) {
      return j([{ id: 'a1', name: 'N', email: 'o@x.ca', password: 'H', invite_token: 'T', invite_expires_at: FUTURE, onboarding_emails_sent: 3, stripe_customer_id: 'cus', stripe_subscription_id: 'sub', unsub_token: 'u' },
        { id: 'a2', name: 'M', email: 'm@x.ca', password: 'H', invite_token: 'T2', onboarding_emails_sent: 1, stripe_customer_id: 'cus2', unsub_token: 'u2' }]);
    }
    if (t === 'admins' && method === 'GET' && /^id,role,parent_admin_id/.test(p.q.get('select') || '')) {
      // which rows a write would hit: the id in the filter, limited to the caller's scope (or=(id.eq.X,id.eq.Y,parent_admin_id.eq.P))
      const orv = p.q.get('or') || ''; const ids = [...orv.matchAll(/id\.eq\.([\w]+)/g)].map(m => m[1]); const par = (/parent_admin_id\.eq\.([\w]+)/.exec(orv) || [])[1];
      let rows = Object.values(admins);
      if (p.q.has('id')) rows = rows.filter(r => r.id === eq('id'));
      if (p.q.has('parent_admin_id')) rows = rows.filter(r => r.parent_admin_id === eq('parent_admin_id'));
      if (orv) rows = rows.filter(r => ids.includes(r.id) || (par && r.parent_admin_id === par));
      return j(rows.map(r => ({ id: r.id, role: r.role, parent_admin_id: r.parent_admin_id })));
    }
    if (t === 'manager_sites' && method === 'GET' && p.q.has('manager_id')) return j(eq('manager_id') === 'a2' ? [{ site_id: 's1' }] : eq('manager_id') === 'fm' ? [{ site_id: 'sF1' }] : []);
    if (t === 'punches' && method === 'GET' && p.q.has('id') && p.q.has('company_id')) return j(eq('id') === 'pOwn' ? [{ id: 'pOwn' }] : []);
    if (t === 'employees' && method === 'GET' && p.q.get('select') === 'id,site_id' && p.q.has('id')) return j(pick(empRows, eq('id')).map(r => ({ id: r.id, site_id: r.site_id })));
    if (t === 'missed_punch_requests' && method === 'GET' && p.q.has('id')) return j(pick(mprRows, eq('id')));
    if (t === 'time_off' && method === 'GET' && p.q.has('id') && p.q.get('select') === '*') return j(pick(toRows, eq('id')));
    if (t === 'survey_invites' && method === 'GET' && p.q.has('token')) return j(pick(surveyInvites, eq('token')));
    if (t === 'survey_responses' && method === 'GET' && p.q.has('invite_id')) return j([{ email: 'cust@x.ca', company_name: 'Cust Co', reason: 'price', liked: 'a', disliked: 'b', wanted_feature: 'c', rating: 3 }]);
    if (t === 'join_requests' && method === 'GET' && !p.q.has('id')) return j(Object.values(joinRows));
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

// ---------- kiosk PIN proofs (same algorithm as the function: HMAC-SHA256 over emp.site.exp, key derived from the service key) ----------
import { webcrypto } from 'node:crypto';
async function mintProof(emp, site, ttlMs = 60000) {
  const exp = Date.now() + ttlMs;
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('kiosk-pin-proof-v1:svc-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${emp}.${site}.${exp}`))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${exp}.${sig}`;
}
const PROOF_E1_S1 = await mintProof('e1', 's1');
const PROOF_E1_EXPIRED = await mintProof('e1', 's1', -1000);
const PROOF_E1_FOR_S2 = await mintProof('e1', 's2');
const PROOF_TAMPERED = PROOF_E1_S1.slice(0, -3) + 'AAA';

// ---------- request corpus ----------
const S1 = 's1';
const R = (group, name, payload, expect) => ({ group, name, payload, expect });
const own = { sessionToken: 'tokOwner' }, mgr = { sessionToken: 'tokMgr' }, sup = { sessionToken: 'tokSuper' }, other = { sessionToken: 'tokOther' };
const cases = [
  // kiosk
  R('kiosk_recent', 'read punches (now served by kiosk_recent_punches: intended difference)', { table: 'punches', method: 'GET', filter: 'order=punched_at.asc', kioskSiteId: S1 }, r => r.status === 200 && Array.isArray(r.rawBody)),
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
  R('preauth', 'pre-auth admin lookup (now only says the address exists)', { table: 'admins', method: 'GET', filter: 'email=eq.o@x.ca' }),
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

  // send_email: the new action. Old code refuses (no such action); the new code must do exactly what each line says.
  R('send_email', 'no session', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN } }, r => r.status === 401 && r.fn.length === 0),
  R('send_email', 'unknown type', { action: 'send_email', body: { type: 'whatever' }, ...own }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'schedule to own employee', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'Oct 19 - Oct 25', lang: 'fr', shifts: [{ day: 'Tuesday', startTime: '13:00', endTime: '22:00', note: 'n', label: 'Counter', labelColor: '#4f8ef7' }] }, ...own },
    r => r.status === 200 && r.fn.length === 1 && !r.fn[0].dry && r.fn[0].body.email === 'ann@x.ca' && r.fn[0].body.name === 'Ann Lee' && r.fn[0].body.type === 'schedule' && r.fn[0].body.lang === 'fr' && r.fn[0].body.shifts.length === 1),
  R('send_email', 'schedule: recipient comes from the database, not the browser', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, email: 'attacker@evil.example', to: 'attacker@evil.example', weekLabel: 'w', shifts: [] }, ...own },
    r => r.status === 200 && r.fn[0].body.email === 'ann@x.ca' && !JSON.stringify(r.fn[0].body).includes('evil.example')),
  R('send_email', 'schedule to another tenant employee', { action: 'send_email', body: { type: 'schedule', employee_id: E_OTHER, weekLabel: 'w', shifts: [] }, ...own }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'schedule to employee with no email', { action: 'send_email', body: { type: 'schedule', employee_id: E_NOMAIL, weekLabel: 'w', shifts: [] }, ...own }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'schedule with a non-uuid employee id', { action: 'send_email', body: { type: 'schedule', employee_id: 'e1" or 1=1', shifts: [] }, ...own }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'schedule: manager may send for their company', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'w', shifts: [] }, ...mgr }, r => r.status === 200 && r.fn.length === 1),
  R('send_email', 'schedule: super admin may send anywhere', { action: 'send_email', body: { type: 'schedule', employee_id: E_OTHER, weekLabel: 'w', shifts: [] }, ...sup }, r => r.status === 200 && r.fn[0].body.email === 'o@other.ca'),
  R('send_email', 'schedule: oversized and hostile shifts are bounded', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'x'.repeat(500), shifts: Array.from({ length: 200 }, () => ({ day: 'd'.repeat(400), startTime: '<script>', endTime: '99:99x', note: 'n'.repeat(900), label: 'l'.repeat(300), labelColor: 'red;background:url(x)' })) }, ...own },
    r => r.status === 200 && r.fn[0].body.shifts.length === 60 && r.fn[0].body.weekLabel.length === 60 && r.fn[0].body.shifts.every(x => x.day.length <= 60 && x.note.length <= 200 && x.label.length <= 60 && x.startTime === '' && x.endTime === '' && x.labelColor === '')),
  R('send_email', 'schedule dry run returns the email and flags the call', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'w', shifts: [], dry_run: true }, ...own },
    r => r.status === 200 && r.obj.dry === true && r.obj.to === 'ann@x.ca' && r.fn.length === 1 && r.fn[0].dry === true),
  R('send_email', 'invitation: own pending', { action: 'send_email', body: { type: 'invitation', token: T_OK }, ...own },
    r => r.status === 200 && r.fn[0].body.email === 'inv@x.ca' && r.fn[0].body.role === 'manager' && r.fn[0].body.token === T_OK && r.fn[0].body.inviterName === 'Owner Name' && r.fn[0].body.companyName === 'Acme Fence'),
  R('send_email', 'invitation: another tenant', { action: 'send_email', body: { type: 'invitation', token: T_OTHER }, ...own }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'invitation: expired', { action: 'send_email', body: { type: 'invitation', token: T_EXPIRED }, ...own }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'invitation: already used', { action: 'send_email', body: { type: 'invitation', token: T_USED }, ...own }, r => r.status === 404 && r.fn.length === 0),
  R('send_email', 'invitation: unknown token', { action: 'send_email', body: { type: 'invitation', token: '99999999-9999-4999-8999-999999999999' }, ...own }, r => r.status === 404 && r.fn.length === 0),
  R('send_email', 'invitation: malformed token', { action: 'send_email', body: { type: 'invitation', token: "x' or '1'='1" }, ...own }, r => r.status === 400 && r.fn.length === 0),
  R('images-email', 'employee invite: builds the link itself, logo is a 30 day signed url', { action: 'send_email', body: { type: 'employee_invite', employee_id: E_OWN, lang: 'en', portalUrl: 'https://evil.example/phish', email: 'attacker@evil.example' }, ...own },
    r => r.status === 200 && r.fn[0].body.email === 'ann@x.ca' && r.fn[0].body.portalUrl === 'https://www.punchclock.ca/employee.html?token=tok%20abc%2F123' && !JSON.stringify(r.fn[0].body).includes('evil.example') && /\/object\/sign\/logos\/c1\.png\?token=T2592000$/.test(r.fn[0].body.logoUrl) && r.fn[0].body.companyName === 'Acme Fence'),
  R('send_email', 'employee invite: nothing pending', { action: 'send_email', body: { type: 'employee_invite', employee_id: E_NOMAIL }, ...own }, r => r.status === 409 && r.fn.length === 0),
  R('send_email', 'employee invite: another tenant', { action: 'send_email', body: { type: 'employee_invite', employee_id: E_OTHER }, ...own }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'join approved', { action: 'send_email', body: { type: 'join_approved', request_id: J_OK }, ...own },
    r => r.status === 200 && r.fn[0].body.type === 'join_approved' && r.fn[0].body.email === 'new@x.ca' && r.fn[0].body.adminName === 'Owner Name'),
  R('send_email', 'join approved: still pending', { action: 'send_email', body: { type: 'join_approved', request_id: J_PENDING }, ...own }, r => r.status === 409 && r.fn.length === 0),
  R('send_email', 'join approved: another tenant', { action: 'send_email', body: { type: 'join_approved', request_id: J_OTHER }, ...own }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'join approved: super admin', { action: 'send_email', body: { type: 'join_approved', request_id: J_OTHER }, ...sup }, r => r.status === 200 && r.fn[0].body.email === 'x@other.ca'),
  R('send_email', 'join denied (empty name falls back to the address)', { action: 'send_email', body: { type: 'join_denied', request_id: J_DENIED }, ...own },
    r => r.status === 200 && r.fn[0].body.type === 'join_request_denied' && r.fn[0].body.name === 'd@x.ca' && r.fn[0].body.companyName === 'Acme Fence'),
  R('send_email', 'join denied: but the request was approved', { action: 'send_email', body: { type: 'join_denied', request_id: J_OK }, ...own }, r => r.status === 409 && r.fn.length === 0),
  R('send_email', 'new account notice: brand new account', { action: 'send_email', body: { type: 'new_account_notification' }, sessionToken: 'tokNew' },
    r => r.status === 200 && r.fn[0].body.email === 'meissam.h.p@gmail.com' && r.fn[0].body.userEmail === 'new-account@x.ca' && r.fn[0].body.plan === 'Free'),
  R('send_email', 'new account notice: an old account cannot replay it', { action: 'send_email', body: { type: 'new_account_notification' }, ...own }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'new account notice: recipient cannot be chosen', { action: 'send_email', body: { type: 'new_account_notification', email: 'attacker@evil.example' }, sessionToken: 'tokNew' }, r => r.status === 200 && r.fn[0].body.email === 'meissam.h.p@gmail.com'),

  // send_email from a kiosk (no admin session): the one thing a person at a terminal may ask for.
  R('send_email', 'kiosk: schedule to the address on file, PIN correct', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OWN, pin: '1234', email: 'attacker@evil.example', weekLabel: 'w', shifts: [] } },
    r => r.status === 200 && r.fn.length === 1 && r.fn[0].body.email === 'ann@x.ca' && !JSON.stringify(r.fn[0].body).includes('evil.example')),
  R('send_email', 'kiosk: no address on file, they type one (sent once)', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_NOMAIL, pin: '2222', email: 'Typed@Me.ca', weekLabel: 'w', shifts: [] } },
    r => r.status === 200 && r.fn[0].body.email === 'typed@me.ca'),
  R('send_email', 'kiosk: no address anywhere', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_NOMAIL, pin: '2222', weekLabel: 'w', shifts: [] } }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'kiosk: typed address is not an address', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_NOMAIL, pin: '2222', email: 'a@b.c<script>alert(1)</script>', weekLabel: 'w', shifts: [] } }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'kiosk: wrong PIN', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OWN, pin: '0000', weekLabel: 'w', shifts: [] } }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'kiosk: missing PIN', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'w', shifts: [] } }, r => r.status === 400 && r.fn.length === 0),
  R('send_email', 'kiosk: employee from another site', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OTHER, pin: '9999', weekLabel: 'w', shifts: [] } }, r => r.status === 403 && r.fn.length === 0),
  R('send_email', 'kiosk: unknown site', { action: 'send_email', kioskSiteId: 'nope', body: { type: 'schedule', employee_id: E_OWN, pin: '1234', weekLabel: 'w', shifts: [] } }, r => r.status === 401 && r.fn.length === 0),

  // kiosk punches now come from kiosk_recent_punches (last 36 h + each person's latest punch).
  R('kiosk_recent', 'kiosk reads punches through the recent-punches function', { table: 'punches', method: 'GET', filter: 'order=punched_at.desc&limit=2000', kioskSiteId: 's1' },
    r => r.status === 200 && Array.isArray(r.rawBody) && r.rawBody.length === 12
      && r.calls.some(c => /POST \/rest\/v1\/rpc\/kiosk_recent_punches/.test(c) && c.includes('"p_site_id":"s1"') && c.includes('"p_hours":36'))
      && !r.calls.some(c => /GET \/rest\/v1\/punches\?/.test(c))),
  R('kiosk_recent', 'the client cannot widen it: another site id in the filter is ignored', { table: 'punches', method: 'GET', filter: 'site_id=eq.s2&order=punched_at.desc', kioskSiteId: 's1' },
    r => r.status === 200 && r.calls.some(c => c.includes('"p_site_id":"s1"')) && !r.calls.some(c => c.includes('s2"'))),
  R('kiosk_recent', 'function unavailable: falls back to the old read of the latest 1000', { table: 'punches', method: 'GET', filter: 'order=punched_at.desc&limit=2000', kioskSiteId: 's8' },
    r => r.status === 200 && r.calls.some(c => /GET \/rest\/v1\/punches\?.*site_id=eq\.s8/.test(c) && c.includes('limit=1000'))),
  R('kiosk_recent', 'no site, no data', { table: 'punches', method: 'GET', filter: 'order=punched_at.desc', kioskSiteId: 'nope' }, r => r.status === 401),
  R('kiosk_recent', 'an admin session still reads punches the normal way', { table: 'punches', method: 'GET', filter: 'order=punched_at.desc&limit=100', ...own },
    r => r.status === 200 && !r.calls.some(c => /kiosk_recent_punches/.test(c))),
  // holidays: the Québec holiday button sends all 8 rows in one bulk insert.
  R('holidays', 'bulk insert into own company', { table: 'holidays', method: 'POST', body: [{ admin_id: 'a1', company_id: 'c1', site_id: null, holiday_date: '2026-01-01', name: "New Year's Day", name_fr: "Jour de l'An", note: '' }, { admin_id: 'a1', company_id: 'c1', site_id: null, holiday_date: '2026-12-25', name: 'Christmas Day', name_fr: 'Noël', note: '' }], ...own },
    r => r.status === 201 && JSON.parse(r.calls.find(c => /POST .*\/holidays/.test(c)).split('/holidays')[1].replace(/^\S*\s/, '')).length === 2),
  R('holidays', 'bulk insert with one row for another tenant is refused', { table: 'holidays', method: 'POST', body: [{ admin_id: 'a1', company_id: 'c1', holiday_date: '2026-01-01', name: 'x' }, { admin_id: 'a1', company_id: 'c9', holiday_date: '2026-01-02', name: 'y' }], ...own },
    r => r.status === 403 && !r.calls.some(c => /POST .*\/holidays/.test(c))),
  // demote_manager: the caller comes from the session, never from the request body.
  R('demote_manager', 'no session', { action: 'demote_manager', body: { manager_id: E_OWN } }, r => r.status === 401 && r.calls.length === 0),
  R('demote_manager', 'a manager may not demote', { action: 'demote_manager', body: { manager_id: E_OWN }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /rpc\/demote/.test(c))),
  R('demote_manager', 'malformed manager id', { action: 'demote_manager', body: { manager_id: "x' or '1'='1" }, ...own }, r => r.status === 400 && !r.calls.some(c => /rpc\/demote/.test(c))),
  R('demote_manager', 'missing manager id', { action: 'demote_manager', body: {}, ...own }, r => r.status === 400 && !r.calls.some(c => /rpc\/demote/.test(c))),
  R('demote_manager', 'owner: caller id is the session, a forged one is ignored', { action: 'demote_manager', body: { manager_id: E_OTHER, p_caller_id: 'b1', caller_id: 'b1' }, ...own },
    r => { const c = r.calls.filter(x => /rpc\/demote/.test(x)); if (r.status !== 200 || c.length !== 1) return false; const b = JSON.parse(c[0].split('demote_manager_to_employee ')[1]); return b.p_caller_id === 'a1' && b.p_manager_id === E_OTHER && Object.keys(b).length === 2; }),
  R('send_email', 'kiosk: rate limited after 5 in an hour', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_THROTTLED, pin: '3333', email: 't@x.ca', weekLabel: 'w', shifts: [] } }, r => r.status === 429 && r.fn.length === 0),
  R('send_email', 'kiosk: cannot send any other kind of email', { action: 'send_email', kioskSiteId: 's1', body: { type: 'invitation', token: T_OK, pin: '1234' } }, r => r.status === 401 && r.fn.length === 0),
  R('send_email', 'kiosk: cannot ask for a dry run', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OWN, pin: '1234', dry_run: true, weekLabel: 'w', shifts: [] } }, r => r.status === 200 && r.fn.length === 1 && r.fn[0].dry === false && !r.obj.html),
  R('send_email', 'kiosk: shifts are bounded like the admin path', { action: 'send_email', kioskSiteId: 's1', body: { type: 'schedule', employee_id: E_OWN, pin: '1234', weekLabel: 'x'.repeat(300), shifts: Array.from({ length: 100 }, () => ({ day: 'd'.repeat(300), startTime: '25:99', endTime: '<b>', note: 'n'.repeat(500) })) } },
    r => r.status === 200 && r.fn[0].body.shifts.length === 60 && r.fn[0].body.weekLabel.length === 60 && r.fn[0].body.shifts.every(x => x.startTime === '' && x.endTime === '' && x.note.length <= 200)),
  R('email-rate-limit', 'admin rate limit: other emails, 30 an hour', { action: 'send_email', body: { type: 'invitation', token: T_OTHER }, sessionToken: 'tokOther' }, r => r.status === 429 && r.fn.length === 0),
  R('email-rate-limit', 'admin rate limit: schedules, 300 an hour', { action: 'send_email', body: { type: 'schedule', employee_id: E_OTHER, weekLabel: 'w', shifts: [] }, sessionToken: 'tokOther' }, r => r.status === 429 && r.fn.length === 0),
  R('send_email', 'admin rate limit: 100 schedules sent does not block an invitation', { action: 'send_email', body: { type: 'invitation', token: T_OK }, ...mgr }, r => r.status === 200 && r.fn.length === 1),
  R('send_email', 'admin rate limit: 100 schedules sent does not block more schedules', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, weekLabel: 'w', shifts: [] }, ...mgr }, r => r.status === 200 && r.fn.length === 1),
  R('send_email', 'admin rate limit: super admin is exempt', { action: 'send_email', body: { type: 'invitation', token: T_OTHER }, ...sup }, r => r.status === 200 && r.fn.length === 1),
  R('send_email', 'admin rate limit: a dry run is never counted or refused', { action: 'send_email', body: { type: 'invitation', token: T_OTHER, dry_run: true }, sessionToken: 'tokOther' }, r => r.status === 200 && r.fn.length === 1 && r.fn[0].dry === true),
  // plan limits on company settings and payroll recipients (b1 = Free, past its preview; a1 = paid)
  R('plan-limits', 'free: cannot switch overtime on', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', track_overtime: true }, ...other }, r => r.status === 403 && /not included in your plan/.test(r.body) && !r.calls.some(c => c.startsWith('PATCH'))),
  R('plan-limits', 'free: switching overtime off is fine', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', track_overtime: false }, ...other }, r => r.status === 200),
  R('plan-limits', 'free: cannot set evening hours', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', evening_start: '17:00', evening_end: null, evening_days: null }, ...other }, r => r.status === 403),
  R('plan-limits', 'free: clearing evening hours is fine', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', evening_start: null, evening_end: null, evening_days: null }, ...other }, r => r.status === 200),
  R('plan-limits', 'free: cannot switch lunch breaks on', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', track_lunch_breaks: true }, ...other }, r => r.status === 403),
  R('plan-limits', 'free: cannot switch visitor check-in on', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', visitor_checkin_enabled: true }, ...other }, r => r.status === 403),
  R('plan-limits', 'free: a grandfathered company keeps overtime', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'Connoisseur Culture', track_overtime: true }, ...other }, r => r.status === 200),
  R('plan-limits', 'free: a normal save with nothing gated', { table: 'companies', method: 'PATCH', filter: 'id=eq.c9', body: { name: 'X', address: 'Y', punch_rounding: 5 }, ...other }, r => r.status === 200),
  R('plan-limits', 'free: cannot add a payroll recipient', { table: 'report_recipients', method: 'POST', body: { company_id: 'c9', email: 'acct@x.ca' }, ...other }, r => r.status === 403),
  R('plan-limits', 'paid: overtime, evening, lunch and visitor all allowed', { table: 'companies', method: 'PATCH', filter: 'id=eq.c1', body: { name: 'X', track_overtime: true, evening_start: '17:00', track_lunch_breaks: true, visitor_checkin_enabled: true }, ...own }, r => r.status === 200),
  R('plan-limits', 'paid: can add a payroll recipient', { table: 'report_recipients', method: 'POST', body: { company_id: 'c1', email: 'acct@x.ca' }, ...own }, r => r.status === 201 || r.status === 200),
  // free 14-day Scheduling trial: an end date on the owner's account, no flag to switch off
  R('trial', 'trial running: owner creates a label', { table: 'work_labels', method: 'POST', body: { company_id: 'c7', name: 'Job 1' }, sessionToken: 'tokTrial' }, r => r.status === 201 || r.status === 200),
  R('trial', 'trial used up: owner cannot create a label', { table: 'work_labels', method: 'POST', body: { company_id: 'c6', name: 'Job 1' }, sessionToken: 'tokTrialOver' }, r => r.status === 403),
  R('trial', 'never started: owner cannot create a label', { table: 'work_labels', method: 'POST', body: { company_id: 'c9', name: 'x' }, ...other }, r => r.status === 403),
  R('trial', 'trial running: a terminal sees the labels', { table: 'work_labels', method: 'GET', filter: '', kioskSiteId: 's7' }, r => r.status === 200 && Array.isArray(r.obj) && r.obj.length > 0),
  R('trial', 'trial used up: a terminal sees no labels', { table: 'work_labels', method: 'GET', filter: '', kioskSiteId: 's6' }, r => r.status === 200 && Array.isArray(r.obj) && r.obj.length === 0),
  R('trial-start', 'start trial: no session', { action: 'start_scheduling_trial' }, r => r.status === 401),
  R('trial-start', 'start trial: a manager cannot', { action: 'start_scheduling_trial', ...mgr }, r => r.status === 403),
  R('trial-start', 'start trial: already paid', { action: 'start_scheduling_trial', ...own }, r => r.status === 400),
  R('trial-start', 'start trial: already running', { action: 'start_scheduling_trial', sessionToken: 'tokTrial' }, r => r.status === 400),
  R('trial-start', 'start trial: used up, not offered again', { action: 'start_scheduling_trial', sessionToken: 'tokTrialOver' }, r => r.status === 400),
  R('trial-start', 'start trial: first time, the server sets 14 days', { action: 'start_scheduling_trial', sessionToken: 'tokNoTrial' },
    r => { if (r.status !== 200 || !r.obj || !r.obj.endsAt) return false; const d = (Date.parse(r.obj.endsAt) - Date.now()) / 864e5; const w = r.calls.find(c => c.startsWith('PATCH') && /admins/.test(c)); return d > 13.9 && d < 14.1 && !!w && /scheduling_trial_ends_at=is\.null/.test(w) && Object.keys(JSON.parse(w.split(' ').slice(2).join(' '))).join() === 'scheduling_trial_ends_at'; }),
  // time off and the employee portal are paid features (b1 = Free past its preview, a1 = paid)
  R('plan-limits', 'free: cannot create a time-off entry', { table: 'time_off', method: 'POST', body: { company_id: 'c9', employee_id: 'e9', start_date: '2026-12-01', end_date: '2026-12-02', status: 'approved' }, ...other }, r => r.status === 403 && /not included in your plan/.test(r.body)),
  R('plan-limits', 'free: approving or denying an existing request is not blocked', { table: 'time_off', method: 'PATCH', filter: 'id=eq.t1', body: { status: 'denied' }, ...other }, r => r.status === 200),
  R('plan-limits', 'paid: can create a time-off entry', { table: 'time_off', method: 'POST', body: { company_id: 'c1', employee_id: 'e1', start_date: '2026-12-01', end_date: '2026-12-02', status: 'approved' }, ...own }, r => r.status === 201 || r.status === 200),
  R('plan-limits', 'free: cannot invite an employee to the portal', { table: 'employee_portal', method: 'POST', body: { employee_id: 'e9', email: 'x@y.ca', status: 'invited' }, ...other }, r => r.status === 403),
  R('plan-limits', 'free: can still revoke portal access', { table: 'employee_portal', method: 'PATCH', filter: 'employee_id=eq.e9', body: { status: 'revoked' }, ...other }, r => r.status === 200),
  R('plan-limits', 'paid: can invite an employee to the portal', { table: 'employee_portal', method: 'POST', body: { employee_id: 'e1', email: 'x@y.ca', status: 'invited' }, ...own }, r => r.status === 201 || r.status === 200),
  R('plan-limits', 'free company: the portal invitation email is refused', { action: 'send_email', body: { type: 'employee_invite', employee_id: E_OTHER, lang: 'en' }, ...sup }, r => r.status === 403 && r.fn.length === 0 && /paid plans/.test(r.body)),
  R('send_email', 'kiosk: nothing at all (no site, no session)', { action: 'send_email', body: { type: 'schedule', employee_id: E_OWN, pin: '1234' } }, r => r.status === 401 && r.fn.length === 0),
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
  // ---- hardening (2026-11-01): the bypasses found in the security audit. Old code let them through; new code must refuse. ----
  R('hardening', 'lowercase post inserts an admin without a session', { table: 'admins', method: 'post', body: { email: 'evil@x.ca', role: 'super_admin' } }, r => r.status === 401 && !r.calls.some(c => /^POST .*\/rest\/v1\/admins/.test(c))),
  R('hardening', 'lowercase get reads admins without a session', { table: 'admins', method: 'get', filter: 'limit=100' }, r => (r.status === 401 || r.status === 403) && !r.calls.some(c => /rest\/v1\/admins\?limit=100/.test(c))),
  R('hardening', 'lowercase delete wipes punches without a session', { table: 'punches', method: 'delete', filter: 'id=neq.0' }, r => r.status === 401 && !r.calls.some(c => /^DELETE /.test(c))),
  R('hardening', 'put is not a supported verb', { table: 'punches', method: 'put', filter: 'id=eq.p1', body: {} , ...own }, r => r.status === 405 && !r.calls.some(c => /^PUT /.test(c))),
  R('hardening', 'odd verb is refused', { table: 'punches', method: 'TRACE', filter: '', ...own }, r => r.status === 405),
  R('hardening', 'mixed-case verb from a signed-in owner behaves exactly like GET', { table: 'employees', method: 'GeT', filter: 'active=eq.true', ...own }, r => r.status === 200 && r.calls.some(c => /GET .*employees\?active=eq\.true.*company_id=in\.\(c1\)/.test(c) || /company_id/.test(c))),
  R('hardening', 'unknown action cannot ride into the table path', { action: 'bogus', table: 'admins', method: 'post', body: { email: 'evil@x.ca' } }, r => r.status === 400 && !r.calls.some(c => /rest\/v1\/admins/.test(c))),
  R('hardening', 'hash in filter cannot drop the tenant scope', { table: 'punches', method: 'GET', filter: 'id=neq.0#', ...other }, r => r.status === 400 && r.calls.length <= 3 && !r.calls.some(c => /rest\/v1\/punches/.test(c))),
  R('hardening', 'hash in a delete filter', { table: 'employees', method: 'DELETE', filter: 'id=neq.0#', ...other }, r => r.status === 400 && !r.calls.some(c => /^DELETE /.test(c))),
  R('hardening', 'newline in filter', { table: 'punches', method: 'GET', filter: 'id=eq.1\nx=y', ...own }, r => r.status === 400),
  R('hardening', 'embed through select is dropped', { table: 'employees', method: 'GET', filter: 'select=*,employee_portal(*)&active=eq.true', ...own }, r => r.status === 200 && !r.calls.some(c => /employee_portal\(/.test(c))),
  R('hardening', 'embed through an encoded select key is dropped', { table: 'employees', method: 'GET', filter: '%73elect=*,employee_portal(*)&active=eq.true', ...own }, r => r.status === 200 && !r.calls.some(c => /employee_portal\(|%73elect/.test(c))),
  R('hardening', 'embed through an encoded select value is dropped', { table: 'employees', method: 'GET', filter: 'select=%2A%2Cemployee_portal%28%2A%29', ...own }, r => r.status === 200 && !r.calls.some(c => /employee_portal|%28/.test(c))),
  R('hardening', 'ordering by a related table is dropped', { table: 'employees', method: 'GET', filter: 'order=employee_portal(password_hash).asc&active=eq.true', ...own }, r => r.status === 200 && !r.calls.some(c => /employee_portal\(/.test(c))),
  R('hardening', 'a normal order still works', { table: 'punches', method: 'GET', filter: 'order=punched_at.desc,id.asc&limit=5', ...own }, r => r.status === 200 && r.calls.some(c => /order=punched_at\.desc,id\.asc/.test(c))),
  R('hardening', 'a plain column list in select still works', { table: 'employees', method: 'GET', filter: 'select=id,name&active=eq.true', ...own }, r => r.status === 200 && r.calls.some(c => /select=id,name/.test(c))),
  R('hardening', 'table name with query syntax', { table: 'admins?select=*', method: 'GET', filter: '', ...own }, r => r.status === 400 && r.calls.length <= 3),
  R('hardening', 'table name that points at an rpc', { table: 'rpc/issue_email_code', method: 'POST', body: {}, ...own }, r => r.status === 400),
  R('hardening', 'session token with query syntax is not a session', { table: 'punches', method: 'GET', filter: '', sessionToken: 'x&admin_id=neq.0' }, r => r.status === 401 && !r.calls.some(c => /x&admin_id/.test(c))),
  R('hardening', 'kiosk site id with query syntax', { table: 'punches', method: 'GET', filter: '', kioskSiteId: 's1&company_id=neq.0' }, r => r.status === 401 && r.calls.length === 0),
  R('hardening', 'kiosk punch for an employee of another company', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e9', emp_name: 'Other', company_id: 'c9', type: 'IN', site_id: S1 } }, r => r.status === 403 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('hardening', 'kiosk punch with another company id for a real employee', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', company_id: 'c9', type: 'IN', site_id: S1 } }, r => r.status === 403 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('hardening', 'kiosk punch with no employee at all', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { type: 'IN', site_id: S1 } }, r => r.status === 403 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('hardening', 'kiosk punch: company is filled in from the employee', { table: 'punches', method: 'POST', kioskSiteId: S1, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => (r.status === 201 || r.status === 200) && r.calls.some(c => /^POST .*punches.*"company_id":"c1"/.test(c))),
  R('hardening', 'kiosk missed punch for another company employee', { table: 'missed_punch_requests', method: 'POST', kioskSiteId: S1, body: { site_id: S1, emp_id: 'e9' } }, r => r.status === 403),
  // ---- kiosk PIN proof (2026-11-01) ----
  R('kiosk-pin', 'verify: right PIN returns a proof', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '1234' } }, r => r.status === 200 && r.obj.ok === true && typeof r.obj.proof === 'string' && !JSON.stringify(r.obj).includes('1234')),
  R('kiosk-pin', 'verify: a right PIN removes its own attempt row, so successes never count against the limit', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '1234' } }, r => r.status === 200 && r.obj.ok === true && r.audit.some(a => /^POST .*audit_log/.test(a)) && r.audit.some(a => /^DELETE .*audit_log\?id=eq\.4242/.test(a))),
  R('kiosk-pin', 'verify: a wrong PIN keeps its attempt row', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '0000' } }, r => r.status === 200 && r.obj.ok === false && r.audit.some(a => /^POST .*audit_log/.test(a)) && !r.audit.some(a => /^DELETE /.test(a))),
  R('kiosk-pin', 'verify: wrong PIN', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '0000' } }, r => r.status === 200 && r.obj.ok === false && !r.obj.proof),
  R('kiosk-pin', 'verify: employee of another site', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OTHER, pin: '9999' } }, r => r.status === 200 && r.obj.ok === false && !r.obj.proof),
  R('kiosk-pin', 'verify: right PIN at the wrong site', { action: 'kiosk_verify_pin', kioskSiteId: 's2', body: { employee_id: E_OWN, pin: '1234' } }, r => r.status === 200 && r.obj.ok === false && !r.obj.proof),
  R('kiosk-pin', 'verify: too many wrong PINs locks the employee', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_LOCKED, pin: '1234' } }, r => r.status === 429 && r.obj.locked === true && !r.obj.proof),
  R('kiosk-pin', 'verify: no site', { action: 'kiosk_verify_pin', body: { employee_id: E_OWN, pin: '1234' } }, r => r.status === 401),
  R('kiosk-pin', 'verify: a signed-in admin is not a kiosk', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '1234' }, ...own }, r => r.status === 401),
  R('kiosk-pin', 'verify: malformed employee id', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: "x' or '1'='1", pin: '1234' } }, r => r.status === 400),
  R('kiosk-pin', 'verify: malformed pin', { action: 'kiosk_verify_pin', kioskSiteId: S1, body: { employee_id: E_OWN, pin: '12ab' } }, r => r.status === 400),
  R('kiosk-pin', 'strict: punch without a proof is refused', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => r.status === 401 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('kiosk-pin', 'strict: proof for another site is refused', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_FOR_S2, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => r.status === 401 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('kiosk-pin', 'strict: expired proof is refused', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_EXPIRED, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => r.status === 401),
  R('kiosk-pin', 'strict: tampered proof is refused', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_TAMPERED, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => r.status === 401),
  R('kiosk-pin', 'strict: a proof for one employee does not work for another', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { emp_id: 'e9', type: 'IN', site_id: S1 } }, r => r.status === 403 && !r.calls.some(c => /^POST .*punches/.test(c))),
  R('kiosk-pin', 'strict: punch with a valid proof', { table: 'punches', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { emp_id: 'e1', type: 'IN', site_id: S1 } }, r => (r.status === 201 || r.status === 200) && r.calls.some(c => /^POST .*punches/.test(c))),
  R('kiosk-pin', 'strict: missed-punch request needs the proof too', { table: 'missed_punch_requests', method: 'POST', kioskV: 2, kioskSiteId: S1, body: { site_id: S1, emp_id: 'e1' } }, r => r.status === 401),
  R('kiosk-pin', 'strict: missed-punch request with a proof', { table: 'missed_punch_requests', method: 'POST', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { site_id: S1, emp_id: 'e1' } }, r => r.status === 201 || r.status === 200),
  R('kiosk-pin', 'strict: visitor check-in needs no PIN', { table: 'visitors', method: 'POST', kioskV: 2, kioskSiteId: S1, body: { site_id: S1, name: 'V' } }, r => r.status === 201 || r.status === 200),
  R('kiosk-pin', 'strict: terminal employee list has no PIN and no email', { table: 'employees', method: 'GET', filter: '', kioskV: 2, kioskSiteId: S1 }, r => r.status === 200 && Array.isArray(r.obj) && r.obj.length > 0 && r.obj.every(e => !('pin' in e) && !('email' in e) && e.has_pin === true)),
  R('kiosk-pin', 'transition: a client that has not announced v2 still gets the old data', { table: 'employees', method: 'GET', filter: '', kioskSiteId: S1 }, r => r.status === 200 && r.obj.some(e => 'pin' in e)),
  R('kiosk-pin', 'an admin still sees the PINs of their own employees', { table: 'employees', method: 'GET', filter: 'active=eq.true', ...own }, r => r.status === 200 && r.obj.some(e => 'pin' in e)),
  // ---- notify / period summary / survey (2026-11-01): the browsers no longer call the mail functions; they ask here ----
  // missed-punch report just filed at a terminal
  R('notify', 'kiosk: report just filed, with the employee PIN proof', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { kind: 'missed_punch', request_id: MPR_OK, mode: 'submitted' } },
    r => r.status === 200 && r.obj.ok === true && r.fn.length === 1 && r.fn[0].url.endsWith('/notify-missed-punch') && r.fn[0].body.requestId === MPR_OK && r.fn[0].body.mode === 'submitted' && Object.keys(r.fn[0].body).length === 2),
  R('notify', 'kiosk: no proof', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, body: { kind: 'missed_punch', request_id: MPR_OK, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: proof for another site', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_FOR_S2, body: { kind: 'missed_punch', request_id: MPR_OK, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: tampered proof', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_TAMPERED, body: { kind: 'missed_punch', request_id: MPR_OK, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: report filed at another site', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { kind: 'missed_punch', request_id: MPR_S2, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: an old report cannot be replayed', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { kind: 'missed_punch', request_id: MPR_OLD, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: cannot trigger a decision notice', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { kind: 'missed_punch', request_id: MPR_APPR, mode: 'decision' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'kiosk: a notice already sent is not sent twice', { action: 'notify_request', kioskV: 2, kioskSiteId: S1, pinToken: PROOF_E1_S1, body: { kind: 'missed_punch', request_id: MPR_DUP, mode: 'submitted' } }, r => r.status === 200 && r.obj.skipped === 'already_sent' && r.fn.length === 0),
  R('notify', 'nobody: no credentials at all', { action: 'notify_request', body: { kind: 'missed_punch', request_id: MPR_OK, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'bad kind', { action: 'notify_request', ...own, body: { kind: 'x', request_id: MPR_OK } }, r => r.status === 400 && r.fn.length === 0),
  R('notify', 'bad request id', { action: 'notify_request', ...own, body: { kind: 'missed_punch', request_id: "1' or '1'='1" } }, r => r.status === 400 && r.fn.length === 0),
  R('notify', 'unknown request', { action: 'notify_request', ...own, body: { kind: 'missed_punch', request_id: '33333333-3333-4333-8333-3333333333ff' } }, r => r.status === 404 && r.fn.length === 0),
  // decisions by an admin
  R('notify', 'owner: decision notice for an approved request of their company', { action: 'notify_request', ...own, body: { kind: 'missed_punch', request_id: MPR_APPR, mode: 'decision' } }, r => r.status === 200 && r.fn.length === 1 && r.fn[0].url.endsWith('/notify-missed-punch') && r.fn[0].body.mode === 'decision'),
  R('notify', 'another tenant admin cannot trigger it', { action: 'notify_request', ...other, body: { kind: 'missed_punch', request_id: MPR_APPR, mode: 'decision' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'owner cannot trigger another tenant request', { action: 'notify_request', ...own, body: { kind: 'missed_punch', request_id: MPR_OTHER, mode: 'decision' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'manager: request at a site they run', { action: 'notify_request', ...mgr, body: { kind: 'missed_punch', request_id: MPR_APPR, mode: 'decision' } }, r => r.status === 200 && r.fn.length === 1),
  R('notify', 'manager: request at a site they do not run', { action: 'notify_request', ...mgr, body: { kind: 'missed_punch', request_id: MPR_E2, mode: 'decision' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'super admin may', { action: 'notify_request', ...sup, body: { kind: 'missed_punch', request_id: MPR_OTHER, mode: 'decision' } }, r => r.status === 200 && r.fn.length === 1),
  // time off from the employee portal
  R('notify', 'portal: request just filed by this employee', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'submitted', portal_token: 'ptokE1' } }, r => r.status === 200 && r.fn.length === 1 && r.fn[0].url.endsWith('/notify-time-off') && r.fn[0].body.requestId === TO_OK),
  R('notify', 'portal: session of another employee', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'submitted', portal_token: 'ptokOther' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'portal: unknown session', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'submitted', portal_token: 'nope' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'portal: no session', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'submitted' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'portal: an admin-entered absence is not an employee request', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_ADMIN, mode: 'submitted', portal_token: 'ptokE1' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'portal: cannot ask for a decision notice', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'decision', portal_token: 'ptokE1' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'portal token with query syntax', { action: 'notify_request', body: { kind: 'time_off', request_id: TO_OK, mode: 'submitted', portal_token: 'x&y=z' } }, r => r.status === 403 && r.fn.length === 0),
  R('notify', 'admin: time off decision for own company', { action: 'notify_request', ...own, body: { kind: 'time_off', request_id: TO_OK, mode: 'decision' } }, r => r.status === 200 && r.fn.length === 1 && r.fn[0].url.endsWith('/notify-time-off')),
  // survey team copy
  R('survey', 'answered survey: team copy built from the saved response', { action: 'survey_notify', body: { token: TOK_S_OK, email: 'evil@x.ca', reason: 'INJECTED' } },
    r => r.status === 200 && r.fn.length === 1 && r.fn[0].url.endsWith('/churn-survey') && r.fn[0].body.email === 'cust@x.ca' && r.fn[0].body.reason === 'price' && !JSON.stringify(r.fn[0].body).includes('INJECTED')),
  R('survey', 'unanswered survey', { action: 'survey_notify', body: { token: TOK_S_SENT } }, r => r.status === 403 && r.fn.length === 0),
  R('survey', 'survey answered long ago', { action: 'survey_notify', body: { token: TOK_S_OLD } }, r => r.status === 403 && r.fn.length === 0),
  R('survey', 'unknown token', { action: 'survey_notify', body: { token: 'ffffffffffffffffffffffffffffffff' } }, r => r.status === 403 && r.fn.length === 0),
  R('survey', 'malformed token', { action: 'survey_notify', body: { token: "x' or '1'='1" } }, r => r.status === 400 && r.fn.length === 0),
  R('survey', 'copy already sent', { action: 'survey_notify', body: { token: TOK_S_DUP } }, r => r.status === 200 && r.obj.skipped === 'already_sent' && r.fn.length === 0),
  // payroll test mail and per-employee hours mail
  R('period', 'no session', { action: 'send_period_summary', body: { mode: 'manual', emp_id: 'e1', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 401 && r.fn.length === 0),
  R('period', 'owner: test summary for own company', { action: 'send_period_summary', ...own, body: { mode: 'test_recipients', company_id: 'c1' } },
    r => r.status === 200 && r.obj.success === true && r.fn.length === 1 && r.fn[0].url.endsWith('/send-period-summary') && r.fn[0].body.test_recipients === true && r.fn[0].body.company_id === 'c1'),
  R('period', 'owner: another tenant company', { action: 'send_period_summary', ...own, body: { mode: 'test_recipients', company_id: 'c9' } }, r => r.status === 403 && r.fn.length === 0),
  R('period', 'manager cannot send the payroll test', { action: 'send_period_summary', ...mgr, body: { mode: 'test_recipients', company_id: 'c1' } }, r => r.status === 403 && r.fn.length === 0),
  R('period', 'owner: hours for an own employee', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e1', start_date: '2026-10-01', end_date: '2026-10-14' } },
    r => r.status === 200 && r.obj.manual_sent === true && r.fn.length === 1 && r.fn[0].body.manual === true && r.fn[0].body.emp_id === 'e1' && r.fn[0].body.start_date === '2026-10-01'),
  R('period', 'owner: employee of another tenant', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e9', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 403 && r.fn.length === 0),
  R('period', 'manager: employee at their site', { action: 'send_period_summary', ...mgr, body: { mode: 'manual', emp_id: 'e1', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 200 && r.fn.length === 1),
  R('period', 'manager: employee at another site', { action: 'send_period_summary', ...mgr, body: { mode: 'manual', emp_id: 'e2', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 403 && r.fn.length === 0),
  R('period', 'manual without dates', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e1' } }, r => r.status === 400 && r.fn.length === 0),
  R('period', 'dates reversed', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e1', start_date: '2026-10-14', end_date: '2026-10-01' } }, r => r.status === 400 && r.fn.length === 0),
  R('period', 'ten year range', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e1', start_date: '2016-10-01', end_date: '2026-10-14' } }, r => r.status === 400 && r.fn.length === 0),
  R('period', 'employee id with query syntax', { action: 'send_period_summary', ...own, body: { mode: 'manual', emp_id: 'e1&company_id=neq.0', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 400 && r.fn.length === 0),
  R('period', 'unknown mode', { action: 'send_period_summary', ...own, body: { mode: 'all' } }, r => r.status === 400 && r.fn.length === 0),
  R('period', 'hourly cap per admin', { action: 'send_period_summary', ...other, body: { mode: 'manual', emp_id: 'e9', start_date: '2026-10-01', end_date: '2026-10-14' } }, r => r.status === 429 && r.fn.length === 0),
  // ---- role rules (2026-11-01): who inside an account may do what ----
  R('roles', 'manager cannot change the owner email', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { email: 'attacker@evil.ca' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'manager cannot suspend the owner', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { status: 'suspended' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'manager cannot promote self', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { role: 'admin' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'manager cannot edit another manager', { table: 'admins', method: 'PATCH', filter: 'id=eq.a4', body: { name: 'x' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'manager cannot edit a co-admin', { table: 'admins', method: 'PATCH', filter: 'id=eq.a5', body: { status: 'suspended' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'manager cannot delete admins', { table: 'admins', method: 'DELETE', filter: 'id=eq.a4', ...mgr }, r => r.status === 403 && !r.calls.some(c => /^DELETE /.test(c))),
  R('roles', 'manager cannot delete the owner', { table: 'admins', method: 'DELETE', filter: 'id=eq.a1', ...mgr }, r => r.status === 403 && !r.calls.some(c => /^DELETE /.test(c))),
  R('roles', 'manager cannot insert an admin row', { table: 'admins', method: 'POST', body: { email: 'x@y.ca', name: 'x', role: 'admin', parent_admin_id: 'a1' }, ...mgr }, r => r.status === 403 && !r.calls.some(c => /^POST /.test(c))),
  R('roles', 'manager can still rename self and mute alerts', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { name: 'Mgr', mute_manager_alerts: true, mute_approval_emails: false }, ...mgr }, r => r.status === 200),
  R('roles', 'manager can still mark the announcement as seen', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { last_seen_announcement_at: '2026-11-01T00:00:00Z' }, ...mgr }, r => r.status === 200),
  R('roles', 'manager can still record the login time', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { last_login: '2026-11-01T00:00:00Z' }, ...mgr }, r => r.status === 200),
  R('roles', 'owner edits a manager (name, role, status)', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { name: 'Mgr', role: 'admin', status: 'suspended' }, ...own }, r => r.status === 200),
  R('roles', 'owner cannot make anyone a super admin', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { role: 'super_admin' }, ...own }, r => r.status === 403),
  R('roles', 'owner cannot invent a role', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { role: 'owner' }, ...own }, r => r.status === 403),
  R('roles', 'owner cannot change a team member email', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { email: 'x@y.ca' }, ...own }, r => r.status === 403),
  R('roles', 'owner cannot re-parent a team member to another tenant', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { parent_admin_id: 'b1' }, ...own }, r => r.status === 403),
  R('roles', 'owner cannot set a status the app does not offer', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { status: 'pending_invite' }, ...own }, r => r.status === 403),
  R('roles', 'owner renames self', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { name: 'Owner' }, ...own }, r => r.status === 200),
  R('roles', 'owner cannot change own role or email', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { role: 'manager' }, ...own }, r => r.status === 403),
  R('roles', 'owner cannot change own email', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { email: 'new@x.ca' }, ...own }, r => r.status === 403),
  R('roles', 'owner removes a team member', { table: 'admins', method: 'DELETE', filter: 'id=eq.a4', ...own }, r => r.status === 204 || r.status === 200),
  R('roles', 'owner cannot delete own account from the app', { table: 'admins', method: 'DELETE', filter: 'id=eq.a1', ...own }, r => r.status === 403 && !r.calls.some(c => /^DELETE /.test(c))),
  R('roles', 'owner cannot insert an admin row', { table: 'admins', method: 'POST', body: { email: 'x@y.ca', name: 'x', role: 'admin', parent_admin_id: 'a1' }, ...own }, r => r.status === 403),
  R('roles', 'co-admin cannot change the owner', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { name: 'x' }, sessionToken: 'tokCoAdmin' }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('roles', 'co-admin cannot delete the owner', { table: 'admins', method: 'DELETE', filter: 'id=eq.a1', sessionToken: 'tokCoAdmin' }, r => r.status === 403 && !r.calls.some(c => /^DELETE /.test(c))),
  R('roles', 'co-admin edits a manager', { table: 'admins', method: 'PATCH', filter: 'id=eq.a4', body: { name: 'x', status: 'suspended' }, sessionToken: 'tokCoAdmin' }, r => r.status === 200),
  R('roles', 'co-admin removes a manager', { table: 'admins', method: 'DELETE', filter: 'id=eq.a4', sessionToken: 'tokCoAdmin' }, r => r.status === 204 || r.status === 200),
  R('roles', 'co-admin renames self', { table: 'admins', method: 'PATCH', filter: 'id=eq.a5', body: { name: 'Co' }, sessionToken: 'tokCoAdmin' }, r => r.status === 200),
  R('roles', 'another tenant cannot reach a1 team (scoped away, nothing changes)', { table: 'admins', method: 'PATCH', filter: 'id=eq.a2', body: { name: 'x' }, ...other }, r => r.status === 200 && r.calls.some(c => /^PATCH .*or=/.test(c))),
  R('roles', 'super admin edits anything', { table: 'admins', method: 'PATCH', filter: 'id=eq.a1', body: { email: 'x@y.ca', plan: 'starter' }, ...sup }, r => r.status === 200),
  R('roles', 'manager cannot create a site', { table: 'sites', method: 'POST', body: { company_id: 'c1', name: 'New' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot edit a site', { table: 'sites', method: 'PATCH', filter: 'id=eq.s1', body: { name: 'New' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot delete a site', { table: 'sites', method: 'DELETE', filter: 'id=eq.s1', ...mgr }, r => r.status === 403),
  R('roles', 'owner creates a site', { table: 'sites', method: 'POST', body: { company_id: 'c1', name: 'New' }, ...own }, r => r.status === 201),
  R('roles', 'manager cannot edit company settings', { table: 'companies', method: 'PATCH', filter: 'id=eq.c1', body: { name: 'Mine now' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot delete a company', { table: 'companies', method: 'DELETE', filter: 'id=eq.c1', ...mgr }, r => r.status === 403),
  R('roles', 'owner edits company settings', { table: 'companies', method: 'PATCH', filter: 'id=eq.c1', body: { name: 'Co', address: 'x' }, ...own }, r => r.status === 200),
  R('roles', 'co-admin creates a company: it belongs to the account owner', { table: 'companies', method: 'POST', body: { name: 'New Co', admin_id: 'a5' }, sessionToken: 'tokCoAdmin' }, r => r.status === 201 && r.calls.some(c => /^POST .*"admin_id":"a1"/.test(c))),
  // ---- manager write scope (added 2026-11-05): a manager's writes must land on rows at their own sites ----
  ...(() => {
    const fm = { sessionToken: 'tokFlagMgr' };
    const ok = r => r.status === 200 || r.status === 201 || r.status === 204;
    const no = (m) => r => r.status === 403 && !r.calls.some(c => new RegExp('^' + m + ' /rest/v1/(?!rpc/|audit_log)').test(c));
    const G = 'mgr-scope';
    return [
      R(G, 'manager edits a punch at own site', { table: 'punches', method: 'PATCH', filter: 'id=eq.pS1', body: { punch_time: '09:00:00' }, ...mgr }, ok),
      R(G, 'manager cannot edit a punch at another site', { table: 'punches', method: 'PATCH', filter: 'id=eq.pS2', body: { punch_time: '09:00:00' }, ...mgr }, no('PATCH')),
      R(G, 'manager cannot move a punch to another site', { table: 'punches', method: 'PATCH', filter: 'id=eq.pS1', body: { site_id: 's2' }, ...mgr }, no('PATCH')),
      R(G, 'manager cannot delete a punch at another site', { table: 'punches', method: 'DELETE', filter: 'id=eq.pS2', ...mgr }, no('DELETE')),
      R(G, 'manager cannot bulk-delete when one punch is at another site', { table: 'punches', method: 'DELETE', filter: 'id=in.(pS1,pS2)', ...mgr }, no('DELETE')),
      R(G, 'manager deletes a punch at own site', { table: 'punches', method: 'DELETE', filter: 'id=eq.pS1', ...mgr }, ok),
      R(G, 'manager cannot delete thousands of rows with one broad filter', { table: 'punches', method: 'DELETE', filter: 'emp_id=eq.eBig', ...mgr }, no('DELETE')),
      R(G, 'manager adds a punch at own site', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'IN' }, ...mgr }, ok),
      R(G, 'manager adds a punch without a site: the employee own site counts', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c1', type: 'IN' }, ...mgr }, ok),
      R(G, 'manager cannot add a punch at another site', { table: 'punches', method: 'POST', body: { emp_id: 'e2', company_id: 'c1', site_id: 's2', type: 'IN' }, ...mgr }, no('POST')),
      R(G, 'manager cannot add a punch for an employee of another site without naming a site', { table: 'punches', method: 'POST', body: { emp_id: 'e2', company_id: 'c1', type: 'IN' }, ...mgr }, no('POST')),
      R(G, 'manager cannot file an own-site employee punch under another site', { table: 'punches', method: 'POST', body: { emp_id: 'e1', company_id: 'c1', site_id: 's2', type: 'IN' }, ...mgr }, no('POST')),
      R(G, 'manager adds an IN and an OUT together (array body)', { table: 'punches', method: 'POST', body: [{ emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'IN' }, { emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'OUT' }], ...mgr }, ok),
      R(G, 'manager cannot sneak a second-site row into an array body', { table: 'punches', method: 'POST', body: [{ emp_id: 'e1', company_id: 'c1', site_id: 's1', type: 'IN' }, { emp_id: 'e2', company_id: 'c1', site_id: 's2', type: 'OUT' }], ...mgr }, no('POST')),
      R(G, 'manager edits a site-less punch of an own-site employee', { table: 'punches', method: 'PATCH', filter: 'id=eq.pNoneE1', body: { punch_time: '10:00:00' }, ...mgr }, ok),
      R(G, 'manager cannot edit a site-less punch of another site employee', { table: 'punches', method: 'PATCH', filter: 'id=eq.pNoneE2', body: { punch_time: '10:00:00' }, ...mgr }, no('PATCH')),
      R(G, 'manager decides a time-off request at own site', { table: 'time_off', method: 'PATCH', filter: 'id=eq.toS1', body: { status: 'approved' }, ...mgr }, ok),
      R(G, 'manager cannot decide a time-off request at another site', { table: 'time_off', method: 'PATCH', filter: 'id=eq.toS2', body: { status: 'approved' }, ...mgr }, no('PATCH')),
      R(G, 'manager cannot delete time off at another site', { table: 'time_off', method: 'DELETE', filter: 'id=eq.toS2', ...mgr }, no('DELETE')),
      R(G, 'manager adds time off for an own-site employee', { table: 'time_off', method: 'POST', body: { company_id: 'c1', site_id: 's1', emp_id: 'e1', kind: 'vacation', status: 'approved' }, ...mgr }, ok),
      R(G, 'manager cannot add time off for another site', { table: 'time_off', method: 'POST', body: { company_id: 'c1', site_id: 's2', emp_id: 'e2', kind: 'vacation', status: 'approved' }, ...mgr }, no('POST')),
      R(G, 'manager decides a missed punch at own site', { table: 'missed_punch_requests', method: 'PATCH', filter: 'id=eq.mS1', body: { status: 'approved' }, ...mgr }, ok),
      R(G, 'manager cannot decide a missed punch at another site', { table: 'missed_punch_requests', method: 'PATCH', filter: 'id=eq.mS2', body: { status: 'denied' }, ...mgr }, no('PATCH')),
      R(G, 'manager schedules an own-site employee at own site', { table: 'shifts', method: 'POST', body: { company_id: 'c1', site_id: 's1', employee_id: 'e1', shift_date: '2026-11-10' }, ...mgr }, ok),
      R(G, 'manager cannot schedule another site employee (flag off)', { table: 'shifts', method: 'POST', body: { company_id: 'c1', site_id: 's2', employee_id: 'e2', shift_date: '2026-11-10' }, ...mgr }, no('POST')),
      R(G, 'manager cannot schedule another site employee at own site (flag off)', { table: 'shifts', method: 'POST', body: { company_id: 'c1', site_id: 's1', employee_id: 'e2', shift_date: '2026-11-10' }, ...mgr }, no('POST')),
      R(G, 'manager cannot delete a shift at another site', { table: 'shifts', method: 'DELETE', filter: 'id=eq.shS2', ...mgr }, no('DELETE')),
      R(G, 'manager deletes a shift at own site', { table: 'shifts', method: 'DELETE', filter: 'id=eq.shS1', ...mgr }, ok),
      R(G, 'flag on: manager schedules staff of another site', { table: 'shifts', method: 'POST', body: { company_id: 'cF', site_id: 'sF2', employee_id: 'eF2', shift_date: '2026-11-10' }, ...fm }, ok),
      R(G, 'flag on: manager edits a shift at another site', { table: 'shifts', method: 'PATCH', filter: 'id=eq.shF2', body: { start_time: '09:00:00' }, ...fm }, ok),
      R(G, 'flag on: the flag does NOT widen punches', { table: 'punches', method: 'POST', body: { emp_id: 'eF2', company_id: 'cF', site_id: 'sF2', type: 'IN' }, ...fm }, no('POST')),
      R(G, 'flag on: the flag does NOT widen punch edits', { table: 'punches', method: 'PATCH', filter: 'id=eq.pF2', body: { punch_time: '09:00:00' }, ...fm }, no('PATCH')),
      R(G, 'manager cannot delete a visitor row of another site', { table: 'visitors', method: 'DELETE', filter: 'id=eq.vS2', ...mgr }, no('DELETE')),
      R(G, 'manager edits a visitor row of own site', { table: 'visitors', method: 'PATCH', filter: 'id=eq.vS1', body: { checked_out_at: '2026-11-05T12:00:00Z' }, ...mgr }, ok),
      R(G, 'manager cannot invite an employee of another site to the portal', { table: 'employee_portal', method: 'POST', body: { employee_id: 'e2', email: 'x@y.ca', invite_token: 'tok', status: 'invited' }, ...mgr }, no('POST')),
      R(G, 'manager invites an own-site employee to the portal', { table: 'employee_portal', method: 'POST', body: { employee_id: 'e1', email: 'x@y.ca', invite_token: 'tok', status: 'invited' }, ...mgr }, ok),
      R(G, 'manager cannot revoke another site portal access', { table: 'employee_portal', method: 'DELETE', filter: 'id=eq.epE2', ...mgr }, no('DELETE')),
      R(G, 'manager cannot edit another site availability', { table: 'availability', method: 'PATCH', filter: 'id=eq.avE2', body: { note: 'x' }, ...mgr }, no('PATCH')),
      R(G, 'owner is not restricted: punch at any site', { table: 'punches', method: 'PATCH', filter: 'id=eq.pS2', body: { punch_time: '09:00:00' }, ...own }, ok),
      R(G, 'owner is not restricted: delete a shift anywhere', { table: 'shifts', method: 'DELETE', filter: 'id=eq.shS2', ...own }, ok),
      R(G, 'co-admin is not restricted: time off at any site', { table: 'time_off', method: 'PATCH', filter: 'id=eq.toS2', body: { status: 'approved' }, sessionToken: 'tokCoAdmin' }, ok),
      R(G, 'super admin is not restricted', { table: 'punches', method: 'PATCH', filter: 'id=eq.pS2', body: { punch_time: '09:00:00' }, ...sup }, ok),
    ];
  })(),
  R('roles', 'a company cannot be handed to a co-admin', { table: 'companies', method: 'PATCH', filter: 'id=eq.c1', body: { admin_id: 'a5' }, ...own }, r => r.status === 403),
  R('roles', 'manager cannot add payroll recipients', { table: 'report_recipients', method: 'POST', body: { company_id: 'c1', email: 'x@y.ca' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot remove payroll recipients', { table: 'report_recipients', method: 'DELETE', filter: 'id=eq.r1', ...mgr }, r => r.status === 403),
  R('roles', 'recipient created_by must be on the account', { table: 'report_recipients', method: 'POST', body: { company_id: 'c1', email: 'x@y.ca', created_by: 'b1' }, ...own }, r => r.status === 403),
  R('roles', 'manager cannot invite', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'a2', company_id: 'c1', email: 'n@x.ca', role: 'admin', site_ids: [] }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot cancel an invitation', { table: 'invitations', method: 'DELETE', filter: 'id=eq.i1', ...mgr }, r => r.status === 403),
  R('roles', 'owner invites a manager to own sites', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'a1', company_id: 'c1', email: 'n@x.ca', role: 'manager', site_ids: ['s1', 's2'] }, ...own }, r => r.status === 201),
  R('roles', 'owner invites a manager to someone else site', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'a1', company_id: 'c1', email: 'n@x.ca', role: 'manager', site_ids: ['s1', 's9'] }, ...own }, r => r.status === 403),
  R('roles', 'invitation site_ids must be a list', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'a1', company_id: 'c1', email: 'n@x.ca', role: 'manager', site_ids: 's9' }, ...own }, r => r.status === 403),
  R('roles', 'invitation for a super admin', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'a1', company_id: 'c1', email: 'n@x.ca', role: 'super_admin', site_ids: [] }, ...own }, r => r.status === 403),
  R('roles', 'invitation sent in the name of someone else', { table: 'invitations', method: 'POST', body: { token: T_OK, inviter_admin_id: 'b1', company_id: 'c1', email: 'n@x.ca', role: 'admin', site_ids: [] }, ...own }, r => r.status === 403),
  R('roles', 'owner cancels an invitation', { table: 'invitations', method: 'DELETE', filter: 'id=eq.i1', ...own }, r => r.status === 204 || r.status === 200),
  R('roles', 'invitations are not edited in place', { table: 'invitations', method: 'PATCH', filter: 'id=eq.i1', body: { role: 'admin' }, ...own }, r => r.status === 403),
  R('roles', 'manager cannot assign managers to sites', { table: 'manager_sites', method: 'POST', body: { manager_id: 'a2', site_id: 's2' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot unassign managers', { table: 'manager_sites', method: 'DELETE', filter: 'manager_id=eq.a2', ...mgr }, r => r.status === 403),
  R('roles', 'owner assigns a manager to an own site', { table: 'manager_sites', method: 'POST', body: { manager_id: 'a2', site_id: 's2' }, ...own }, r => r.status === 201),
  R('roles', 'owner cannot assign a manager to another tenant site', { table: 'manager_sites', method: 'POST', body: { manager_id: 'a2', site_id: 's9' }, ...own }, r => r.status === 403),
  R('roles', 'manager reads own site assignments (scoped to the account sites)', { table: 'manager_sites', method: 'GET', filter: 'manager_id=eq.a2', ...mgr }, r => r.status === 200 && r.calls.some(c => /manager_sites\?.*site_id=in\.\(s1,s2\)/.test(c))),
  R('roles', 'another tenant deletes manager assignments by site: scoped to its own sites', { table: 'manager_sites', method: 'DELETE', filter: 'site_id=eq.s1', ...other }, r => r.calls.some(c => /^DELETE .*site_id=in\.\(s9\)/.test(c))),
  R('roles', 'manager cannot delete employees', { table: 'employees', method: 'DELETE', filter: 'id=eq.e1', ...mgr }, r => r.status === 403),
  R('roles', 'manager edits an employee at their site', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { name: 'A', active: false }, ...mgr }, r => r.status === 200),
  R('roles', 'manager cannot edit an employee at another site', { table: 'employees', method: 'PATCH', filter: 'id=eq.e2', body: { name: 'B' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot move an employee to another site', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { site_id: 's2' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager adds an employee at their site', { table: 'employees', method: 'POST', body: { name: 'N', company_id: 'c1', site_id: 's1' }, ...mgr }, r => r.status === 201),
  R('roles', 'manager cannot add an employee at another site', { table: 'employees', method: 'POST', body: { name: 'N', company_id: 'c1', site_id: 's2' }, ...mgr }, r => r.status === 403),
  R('roles', 'manager cannot add an employee with no site', { table: 'employees', method: 'POST', body: { name: 'N', company_id: 'c1' }, ...mgr }, r => r.status === 403),
  R('roles', 'owner deletes an employee', { table: 'employees', method: 'DELETE', filter: 'id=eq.e1', ...own }, r => r.status === 204 || r.status === 200),
  R('roles', 'kiosk devices: revoke', { table: 'kiosk_devices', method: 'PATCH', filter: 'id=eq.d1', body: { revoked: true }, ...own }, r => r.status === 200),
  R('roles', 'kiosk devices: no other column', { table: 'kiosk_devices', method: 'PATCH', filter: 'id=eq.d1', body: { site_id: 's2' }, ...own }, r => r.status === 403),
  R('roles', 'kiosk devices: no insert', { table: 'kiosk_devices', method: 'POST', body: { site_id: 's1', device_id: 'abcdefgh' }, ...own }, r => r.status === 403),
  R('roles', 'kiosk devices: no delete', { table: 'kiosk_devices', method: 'DELETE', filter: 'id=eq.d1', ...own }, r => r.status === 403),
  R('roles', 'portal access: cannot write a password hash', { table: 'employee_portal', method: 'PATCH', filter: 'employee_id=eq.e1', body: { password_hash: '$2a$10$x' }, ...own }, r => r.status === 403),
  R('roles', 'portal access: cannot activate by hand', { table: 'employee_portal', method: 'PATCH', filter: 'employee_id=eq.e1', body: { status: 'active' }, ...own }, r => r.status === 403),
  R('roles', 'a punch reference must be a punch of the account (own)', { table: 'missed_punch_requests', method: 'PATCH', filter: 'id=eq.m1', body: { status: 'approved', punch_id: 'pOwn' }, ...own }, r => r.status === 200),
  R('roles', 'a punch reference must be a punch of the account (foreign)', { table: 'missed_punch_requests', method: 'PATCH', filter: 'id=eq.m1', body: { status: 'approved', punch_id: 'pForeign' }, ...own }, r => r.status === 403),
  // ---- join requests (stored XSS source) ----
  R('joinreq', 'an admin cannot insert join requests', { table: 'join_requests', method: 'POST', body: { requester_id: 'a1', target_admin_id: 'a1', requester_name: '<img src=x onerror=alert(1)>', requester_email: 'x@y.ca', target_admin_email: 'o@x.ca' }, ...own }, r => r.status === 403 && !r.calls.some(c => /^POST /.test(c))),
  R('joinreq', 'a manager cannot insert join requests', { table: 'join_requests', method: 'POST', body: { requester_name: 'x' }, ...mgr }, r => r.status === 403),
  R('joinreq', 'super admin: markup in the name is refused', { table: 'join_requests', method: 'POST', body: { requester_name: '<img src=x onerror=alert(1)>', requester_email: 'x@y.ca', target_admin_email: 'o@x.ca' }, ...sup }, r => r.status === 400 && !r.calls.some(c => /^POST /.test(c))),
  R('joinreq', 'super admin: a 5000 character name is refused', { table: 'join_requests', method: 'POST', body: { requester_name: 'x'.repeat(5000), requester_email: 'x@y.ca' }, ...sup }, r => r.status === 400),
  R('joinreq', 'super admin: an address with markup is refused', { table: 'join_requests', method: 'POST', body: { requester_name: 'Ok', requester_email: 'a<script>@y.ca' }, ...sup }, r => r.status === 400),
  R('joinreq', 'super admin: a well formed request', { table: 'join_requests', method: 'POST', body: { requester_name: 'Ok Person', requester_email: 'ok@y.ca', target_admin_email: 'o@x.ca' }, ...sup }, r => r.status === 201),
  R('joinreq', 'owner approves a request aimed at them', { table: 'join_requests', method: 'PATCH', filter: `id=eq.${J_PENDING}`, body: { status: 'approved' }, ...own }, r => r.status === 200 && r.calls.some(c => /^PATCH .*or=\(target_admin_id\.eq\.a1/.test(c))),
  R('joinreq', 'owner cannot rewrite the request text', { table: 'join_requests', method: 'PATCH', filter: `id=eq.${J_PENDING}`, body: { requester_name: '<b>x</b>' }, ...own }, r => r.status === 403),
  R('joinreq', 'owner reads requests: only those aimed at their account', { table: 'join_requests', method: 'GET', filter: 'status=eq.pending', ...own }, r => r.status === 200 && r.calls.some(c => /join_requests\?.*or=\(target_admin_id\.eq\.a1,target_admin_id\.eq\.a1,requester_id\.eq\.a1\)/.test(c))),
  // ---- private images (avatars / logos buckets): signed urls out, stored form in ----
  R('images', 'owner reads employees: photos come back signed, in ONE storage call, other values untouched', { table: 'employees', method: 'GET', filter: 'imgtest=eq.1', ...sup },
    r => r.status === 200 && r.obj[0].photo_url.includes(`/object/sign/avatars/${CO_IMG}/photo-aaa.png?token=T14400`) && r.obj[1].photo_url.includes('/object/sign/avatars/legacy-2.png?token=T14400') && r.obj[2].photo_url === null
      && r.obj[3].photo_url === 'https://evil.example/x.png' && r.obj[4].photo_url === `${PUB}/avatars/missing-5.png` && r.calls.filter(c => /^POST .*\/storage\/v1\/object\/sign\/avatars/.test(c)).length === 1),
  R('images', 'the same read again: every object (also the unsignable one) is served from the cache: no storage call', { table: 'employees', method: 'GET', filter: 'imgtest=eq.1', ...sup },
    r => r.status === 200 && r.obj[0].photo_url.includes('token=T14400') && r.calls.filter(c => /object\/sign/.test(c)).length === 0),
  R('images', 'a terminal reading its employees gets signed photos too', { table: 'employees', method: 'GET', filter: '', kioskV: 2, kioskSiteId: 'sImg' },
    r => r.status === 200 && r.obj[0].photo_url.includes('/object/sign/avatars/') && r.obj.every(e => !('pin' in e))),
  R('images', 'terminal bootstrap: company logo and employee photos signed, no photo for k2', { action: 'kiosk_bootstrap', kioskV: 2, kioskSiteId: SITE_UUID },
    r => r.status === 200 && r.obj.ok === true && r.obj.company.logo_url.includes('/object/sign/logos/kiosk-logo-1.png?token=T14400') && r.obj.employees[0].photo_url.includes('/object/sign/avatars/kiosk-photo-1.png?token=T14400') && r.obj.employees[1].photo_url === null
      && r.calls.filter(c => /^POST .*rpc\/get_kiosk_bootstrap_v2/.test(c)).length === 1),
  R('images', 'terminal bootstrap needs a site', { action: 'kiosk_bootstrap', kioskV: 2 }, r => r.status === 401 && r.calls.length === 0),
  R('images', 'terminal bootstrap: a signed-in admin is not a terminal', { action: 'kiosk_bootstrap', kioskV: 2, kioskSiteId: SITE_UUID, ...own }, r => r.status === 401 && r.calls.every(c => !/get_kiosk_bootstrap/.test(c))),
  R('images', 'terminal bootstrap: site id is not query syntax', { action: 'kiosk_bootstrap', kioskV: 2, kioskSiteId: 'x&select=*' }, r => r.status === 401),
  R('images', 'write: a signed url of an own object is stored in its public form, the answer is signed again', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { name: 'A', photo_url: `https://fake.supabase.co/storage/v1/object/sign/avatars/${CO_IMG}/photo-new.png?token=abc` }, sessionToken: 'tokImg' },
    r => r.status === 200 && r.calls.some(c => /^PATCH /.test(c) && c.includes(`"photo_url":"${PUB}/avatars/${CO_IMG}/photo-new.png"`) && !c.includes('token=')) && r.obj[0].photo_url.includes('/object/sign/avatars/')),
  R('images', 'write: an object in another company folder is refused', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: `${PUB}/avatars/${CO_FOREIGN}/photo.png` }, sessionToken: 'tokImg' }, r => r.status === 403 && !r.calls.some(c => /^PATCH /.test(c))),
  R('images', 'write: an address outside our storage is refused', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: 'https://evil.example/x.png' }, sessionToken: 'tokImg' }, r => r.status === 400 && !r.calls.some(c => /^PATCH /.test(c))),
  R('images', 'write: a path with .. is refused', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: `${PUB}/avatars/${CO_IMG}/../${CO_FOREIGN}/p.png` }, sessionToken: 'tokImg' }, r => r.status === 400),
  R('images', 'write: the wrong bucket is refused (logo as a photo)', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: `${PUB}/logos/${CO_IMG}/l.png` }, sessionToken: 'tokImg' }, r => r.status === 400),
  R('images', 'write: an older flat object the account does not use is refused', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: `${PUB}/avatars/legacy-other.png` }, sessionToken: 'tokImg' }, r => r.status === 403),
  R('images', 'write: an older flat object the account already uses is accepted (re-saving an employee)', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { name: 'A', photo_url: `https://fake.supabase.co/storage/v1/object/sign/avatars/legacy-used-1.png?token=zzz` }, sessionToken: 'tokImg' },
    r => r.status === 200 && r.calls.some(c => /^PATCH /.test(c) && c.includes(`"photo_url":"${PUB}/avatars/legacy-used-1.png"`))),
  R('images', 'write: clearing the photo', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: '' }, sessionToken: 'tokImg' }, r => r.status === 200 && r.calls.some(c => /^PATCH /.test(c) && c.includes('"photo_url":null'))),
  R('images', 'write: own company logo', { table: 'companies', method: 'PATCH', filter: `id=eq.${CO_IMG}`, body: { logo_url: `${PUB}/logos/${CO_IMG}/logo-x.png` }, sessionToken: 'tokImg' }, r => r.status === 200 && r.obj[0].logo_url.includes('/object/sign/logos/')),
  R('images', 'write: another company logo folder', { table: 'companies', method: 'PATCH', filter: `id=eq.${CO_IMG}`, body: { logo_url: `${PUB}/logos/${CO_FOREIGN}/logo-x.png` }, sessionToken: 'tokImg' }, r => r.status === 403),
  R('images', 'write: super admin may use any folder', { table: 'employees', method: 'PATCH', filter: 'id=eq.e1', body: { photo_url: `${PUB}/avatars/${CO_FOREIGN}/p.png` }, ...sup }, r => r.status === 200),
  // ---- admin rows: what comes back ----
  R('admins-out', 'team list: no invite token, no bookkeeping, no billing or unsubscribe on other rows', { table: 'admins', method: 'GET', filter: 'marker=eq.1&parent_admin_id=eq.a1', ...own },
    r => r.status === 200 && r.obj.length === 2 && r.obj.every(x => !('password' in x) && !('invite_token' in x) && !('invite_expires_at' in x) && !('onboarding_emails_sent' in x)) && r.obj.find(x => x.id === 'a1').stripe_customer_id === 'cus' && !('stripe_customer_id' in r.obj.find(x => x.id === 'a2')) && !('unsub_token' in r.obj.find(x => x.id === 'a2'))),
  R('admins-out', 'a request that merely mentions the caller id in another clause does not unlock other rows', { table: 'admins', method: 'GET', filter: 'marker=eq.1&name=neq.id=eq.a1', ...own },
    r => r.status === 200 && !('stripe_customer_id' in r.obj.find(x => x.id === 'a2'))),
  // ---- the pre-login admin lookup ----
  R('preauth', 'anon: by e-mail only says the address exists', { table: 'admins', method: 'GET', filter: 'email=eq.o@x.ca&select=stripe_customer_id' }, r => r.status === 200 && r.obj.every(x => Object.keys(x).join() === 'email')),
  R('preauth', 'anon: by id gives only the sign-in columns', { table: 'admins', method: 'GET', filter: 'id=eq.a1&select=id,name,email,role,plan,status,parent_admin_id,extra_seats,stripe_customer_id,stripe_subscription_id,scheduling_addon' },
    r => r.status === 200 && r.obj.every(x => Object.keys(x).every(k => ['id', 'name', 'email', 'role', 'plan', 'status', 'parent_admin_id', 'extra_seats', 'scheduling_addon', 'scheduling_trial_ends_at'].includes(k)))),
  R('preauth', 'anon: a compound lookup is still refused', { table: 'admins', method: 'GET', filter: 'email=eq.o@x.ca&role=eq.admin' }, r => r.status === 401),
  R('preauth', 'anon: a bulk read is still refused', { table: 'admins', method: 'GET', filter: 'status=eq.active' }, r => r.status === 401),
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
    results.push({ ...c, status, body: JSON.stringify(body).slice(0, 600), rawBody: body, audit: upstream.filter(u => /audit_log/.test(u.url)).map(u => `${u.method} ${u.url}`), calls: upstream.filter(u => !/audit_log/.test(u.url)).map(u => `${u.method} ${u.url} ${u.dry ? '[dry] ' : ''}${u.body || ''}`), fn: upstream.filter(u => /functions\/v1/.test(u.url)).map(u => ({ url: u.url, dry: u.dry, body: (() => { try { return JSON.parse(u.body); } catch { return null; } })() })), obj: (body && typeof body === 'object') ? body : null });
  }
  return results;
}

const hOld = await load(oldPath, 'old');
const oldRes = await run(hOld);
const hNew = await load(newPath, 'new');
const newRes = await run(hNew);

let expectFail = 0, expectPass = 0;
for (let i = 0; i < cases.length; i++) {
  if (!cases[i].expect) continue;
  let ok = false;
  try { ok = !!cases[i].expect(newRes[i]); } catch (e) { ok = false; }
  if (ok) expectPass++; else { expectFail++; console.log(`!! EXPECTATION FAILED [${cases[i].group}] ${cases[i].name}\n   got ${newRes[i].status} ${newRes[i].body.slice(0, 160)} fn=${JSON.stringify(newRes[i].fn).slice(0, 200)}`); }
}
if (expectPass + expectFail) console.log(`expectations: ${expectPass} passed, ${expectFail} failed`);
const norm = (x) => String(x).replace(/\d{13}\.[\w-]{20,}/g, 'PROOF').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'ISO');
let same = 0, diff = 0, unexpected = 0;
for (let i = 0; i < cases.length; i++) {
  const o = oldRes[i], n = newRes[i];
  const identical = o.status === n.status && norm(o.body) === norm(n.body) && norm(JSON.stringify(o.calls)) === norm(JSON.stringify(n.calls));
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
process.exit(unexpected || expectFail ? 1 : 0);
