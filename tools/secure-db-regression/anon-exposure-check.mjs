// Database exposure check: the public anon key must reach nothing except the allowlisted RPCs and public image URLs.
// Read-only. Prints names and counts only, never data. Exit code 1 if anything is exposed.
//
//   SUPABASE_SERVICE_ROLE_KEY=<service key> node tools/secure-db-regression/anon-exposure-check.mjs
//   (offline test of the catalog checks: SNAPSHOT_JSON_FILE=<file holding the output of select public.security_audit_snapshot()>)
//
// What it asserts
//   Anonymous probes (always run, anon key read from index.html):
//     - GET /rest/v1/<table> returns no rows for every table named in supabase/migrations (401 permission denied is the target)
//     - the Storage list API returns no objects for the avatars and logos buckets, and the buckets are private (a bare public address does not open)
//   Catalog snapshot (needs the service key; calls public.security_audit_snapshot(), service_role only):
//     - no public table, view or sequence carries a privilege for anon, authenticated or PUBLIC
//     - every public table has row level security enabled
//     - the set of public functions executable by anon equals tools/secure-db-regression/anon-function-allowlist.txt
//     - authenticated can execute no public function
//     - default privileges for postgres do not hand future tables, sequences or functions to anon/authenticated/PUBLIC
//     - no SELECT policy on storage.objects (that is what allowed listing the buckets)
//     - the `http` extension is not installed
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const URL_ = /SUPA_URL\s*=\s*'([^']+)'/.exec(html)[1];
const ANON = /SUPA_KEY\s*=\s*'([^']+)'/.exec(html)[1];
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };
const pass = (msg) => console.log('ok    ' + msg);

// Tables named in migrations (create table [if not exists] public.<name>)
const migDir = new URL('supabase/migrations/', root);
const tables = new Set();
for (const f of fs.readdirSync(migDir)) {
  if (!f.endsWith('.sql')) continue;
  const sql = fs.readFileSync(new URL(f, migDir), 'utf8');
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) tables.add(m[1].toLowerCase());
}
// A few tables predate the migration folder
for (const t of ['admin_sessions', 'admins', 'announcements', 'audit_log', 'auth_attempts', 'availability', 'companies', 'email_codes', 'employee_portal',
  'employee_push_tokens', 'employees', 'holidays', 'internal_secrets', 'invitations', 'join_requests', 'kiosk_devices', 'manager_sites',
  'missed_punch_requests', 'portal_sessions', 'processed_webhook_events', 'punches', 'punches_archive', 'report_recipients', 'sent_alerts',
  'shifts', 'sites', 'survey_invites', 'survey_responses', 'time_off', 'visitors', 'visitors_archive', 'work_labels']) tables.add(t);

const H = { apikey: ANON, Authorization: `Bearer ${ANON}` };

// 1. anonymous table reads
let leaks = 0, probed = 0;
for (const t of [...tables].sort()) {
  const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  const txt = await r.text();
  if (r.status === 404) continue; // not a table in this project (e.g. a name from an old migration)
  probed++;
  let rows = null; try { const j = JSON.parse(txt); rows = Array.isArray(j) ? j.length : null; } catch { /* error body */ }
  if (rows > 0) { leaks++; fail(`anon GET ${t} returned ${rows} row(s)`); }
  else if (r.status !== 401) fail(`anon GET ${t} answered ${r.status}, expected 401 (no table privilege for anon)`);
}
if (!leaks && probed) pass(`anon GET: ${probed} tables probed, no rows returned`);

// 2. storage listing
for (const b of ['avatars', 'logos']) {
  const r = await fetch(`${URL_}/storage/v1/object/list/${b}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 5 }) });
  const j = await r.json().catch(() => null);
  if (Array.isArray(j) && j.length) fail(`anon can list the ${b} bucket (${j.length}+ objects)`);
  else pass(`anon cannot list the ${b} bucket`);
}
// 2b. the buckets are private: a bare public address answers "Bucket not found" (a public bucket answers "Object not found")
for (const b of ['avatars', 'logos']) {
  const r = await fetch(`${URL_}/storage/v1/object/public/${b}/zz-exposure-check-no-such-object.png`);
  const j = await r.json().catch(() => null);
  const msg = String((j && (j.message || j.error)) || '');
  if (/bucket not found/i.test(msg)) pass(`the ${b} bucket is private (a public address does not open)`);
  else fail(`the ${b} bucket looks PUBLIC: HTTP ${r.status} "${msg.slice(0, 60)}" (expected "Bucket not found"; images are shown through signed urls)`);
}

// 3. catalog snapshot
const SNAPSHOT_FILE = process.env.SNAPSHOT_JSON_FILE || '';
if (!SERVICE && !SNAPSHOT_FILE) {
  console.log('skip  catalog checks: set SUPABASE_SERVICE_ROLE_KEY to run them (allowlist, grants, default privileges, RLS)');
} else {
  let snap = null;
  if (SNAPSHOT_FILE) snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  else {
    const r = await fetch(`${URL_}/rest/v1/rpc/security_audit_snapshot`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) fail(`security_audit_snapshot() failed: HTTP ${r.status}`); else snap = await r.json();
  }
  if (snap) {
    const s = snap;
    const allow = fs.readFileSync(new URL('tools/secure-db-regression/anon-function-allowlist.txt', root), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const live = s.anon_executable_functions;
    const extra = live.filter((n) => !allow.includes(n)), missing = allow.filter((n) => !live.includes(n));
    if (extra.length) fail(`anon can execute functions that are not on the allowlist: ${extra.join(', ')}`);
    if (missing.length) fail(`allowlisted functions anon cannot execute (browser would break): ${missing.join(', ')}`);
    if (!extra.length && !missing.length) pass(`anon-executable functions equal the allowlist (${allow.length})`);

    const none = (key, what) => { if (s[key].length) fail(`${what}: ${s[key].join(', ')}`); else pass(`${what}: none`); };
    none('relations_with_anon_authenticated_or_public_privileges', 'public tables/views/sequences with anon, authenticated or PUBLIC privileges');
    none('tables_without_rls', 'public tables without row level security');
    none('authenticated_executable_functions', 'public functions executable by authenticated');
    none('default_privileges_open_to_anon_authenticated_or_public', 'default privileges (postgres) open to anon/authenticated/PUBLIC');
    none('storage_select_policies', 'SELECT policies on storage.objects');
    if (s.extensions.includes('http')) fail('the http extension is installed'); else pass('http extension not installed');
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll exposure checks passed');
process.exit(failures ? 1 : 0);
