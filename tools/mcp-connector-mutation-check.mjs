// Do the AI connector's tests really bite? This breaks one security rule at a time in a COPY of the two functions
// (the real files are never touched) and runs tools/mcp-connector-test.mjs against the broken copy. Every broken rule
// must make the suite fail. Run it after changing supabase/functions/mcp or the mcp_* actions in secure-db: a
// "pattern not found" means a rule's code changed and its entry below needs updating; a "MISSED" means a rule has no
// test that notices when it is gone.
//   node tools/mcp-connector-mutation-check.mjs          (about 2 minutes)
//   ONLY="single use" node tools/mcp-connector-mutation-check.mjs   (just the entries whose name contains that text)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mutation-'));
fs.mkdirSync(dir, { recursive: true });
const files = { mcp: path.join(repo, 'supabase/functions/mcp/index.ts'), sdb: path.join(repo, 'supabase/functions/secure-db/index.ts') };
const M = [
  ['mcp', 'code is single use', "mcp_auth_codes?code_hash=eq.${await sha256hex(code)}&used_at=is.null&expires_at", "mcp_auth_codes?code_hash=eq.${await sha256hex(code)}&expires_at"],
  ['mcp', 'code expiry', "&used_at=is.null&expires_at=gt.${q(nowIso())}`,\n      { used_at: nowIso() }, true);\n    const row", "&used_at=is.null`,\n      { used_at: nowIso() }, true);\n    const row"],
  ['mcp', 'PKCE verifier compared', "|| !safeEq(await s256(verifier), row.code_challenge)", ""],
  ['mcp', 'empty verifier refused', "if (!verifier || !VERIFIER_RE.test(verifier)) return oauthErr('invalid_request', 'code_verifier is required');", ""],
  ['mcp', 'code bound to app', "row.client !== app || ", ""],
  ['mcp', 'code bound to return address', "row.redirect_uri !== p.get('redirect_uri')", "false"],
  ['mcp', 'callback belongs to the same app', "if (!redirectAllowed(app, redirectUri)) return text(", "if (!(REDIRECTS.claude(redirectUri || '') || REDIRECTS.chatgpt(redirectUri || ''))) return text("],
  ['mcp', 'client host allowlist', "return APP_HOSTS[u.hostname] ?? null;", "return APP_HOSTS[u.hostname] ?? 'claude';"],
  ['mcp', 'client must be https', "u.protocol !== 'https:' || ", ""],
  ['mcp', 'live check at exchange', "    if (!who.ok) {\n      audit(who.why === 'gone' ? null : adminId, 'mcp_connect_refused', `${app}:${who.why}`);\n      return badCode();\n    }", ""],
  ['mcp', 'refresh reuse detection', "if (Date.now() - new Date(t.used_at).getTime() > REFRESH_GRACE_MS) {", "if (false) {"],
  ['mcp', 'refresh rotation', "&kind=eq.refresh&used_at=is.null&expires_at=gt.${q(nowIso())}`,\n      { used_at: nowIso() }, true);", "&kind=eq.refresh&expires_at=gt.${q(nowIso())}`,\n      { used_at: null }, true);"],
  ['mcp', 'refresh bound to app', "if (!gr.ok || !grantRow || grantRow.client !== app) return bad();", "if (!gr.ok || !grantRow) return bad();"],
  ['mcp', 'refresh re-checks the person', "    if (!who.ok) {\n      if (who.why === 'error') return oauthErr('server_error', 'Please try again', 503);", "    if (false) {\n      if (who.why === 'error') return oauthErr('server_error', 'Please try again', 503);"],
  ['mcp', 'refresh expiry', "if (!t || !t.used_at || new Date(t.expires_at).getTime() <= Date.now()) return bad();", "if (!t) return bad();"],
  // the token's shape and its kind are each checked; either alone stops a refresh token used as an access token, so both are removed together
  ['mcp', 'a refresh token is not an access token (shape and kind checks together)', [
    ["&kind=eq.access&expires_at=gt.${q(nowIso())}&select=grant_id&limit=1`);\n  if (!t.ok) return 'unavailable';", "&expires_at=gt.${q(nowIso())}&select=grant_id&limit=1`);\n  if (!t.ok) return 'unavailable';"],
    ["if (!m || !SECRET_RE.access.test(m[1])) return null;", "if (!m) return null;"]]],
  ['mcp', 'refresh refused on a cancelled connection', "mcp_grants?id=eq.${grantId}&revoked_at=is.null&select=id,admin_id,client&limit=1", "mcp_grants?id=eq.${grantId}&select=id,admin_id,client&limit=1"],
  ['mcp', 'plan checked on every tool call', "if (!(await planIncluded(session.ownerId))) {", "if (false) {"],
  ['mcp', 'plan must be Growth or higher', "if (typeof rank === 'number' && rank >= 2) return true;", "if (typeof rank === 'number' && rank >= 1) return true;"],
  ['mcp', 'unreadable plan means no', "const rank = r.ok ? await r.json().catch(() => null) : null;", "const rank = r.ok ? await r.json().catch(() => null) : 4;"],
  ['mcp', 'only the listed companies are grandfathered', "cos.rows.some((c) => GRANDFATHERED_COMPANIES.includes(String(c.name)))", "cos.rows.length > 0"],
  ['mcp', 'access expiry',"&kind=eq.access&expires_at=gt.${q(nowIso())}&select=grant_id", "&kind=eq.access&select=grant_id"],
  ['mcp', 'revoked connection refused', "mcp_grants?id=eq.${grantId}&revoked_at=is.null&select=id,admin_id,client,last_used_at", "mcp_grants?id=eq.${grantId}&select=id,admin_id,client,last_used_at"],
  ['mcp', 'live person check per call', "if (!who.ok) return who.why === 'error' ? 'unavailable' : null;", ""],
  ['mcp', 'owner switch checked', "if (o.ai_apps_enabled !== true) return { ok: false, why: 'ai_apps_off' };", ""],
  ['mcp', 'super admin refused', "if (a.role === 'super_admin') return { ok: false, why: 'super_admin' };", ""],
  ['mcp', 'person must be active', "if (a.status !== 'active' || lapsed(a)) return { ok: false, why: 'deactivated' };", "if (lapsed(a)) return { ok: false, why: 'deactivated' };"],
  ['mcp', 'owner must be active', "if (!o || o.status !== 'active' || lapsed(o)) return { ok: false, why: 'deactivated' };", "if (!o || lapsed(o)) return { ok: false, why: 'deactivated' };"],
  ['mcp', 'temporary access end date (person)', "if (a.status !== 'active' || lapsed(a)) return { ok: false, why: 'deactivated' };", "if (a.status !== 'active') return { ok: false, why: 'deactivated' };"],
  ['mcp', 'temporary access end date (owner)', "if (!o || o.status !== 'active' || lapsed(o)) return { ok: false, why: 'deactivated' };", "if (!o || o.status !== 'active') return { ok: false, why: 'deactivated' };"],
  ['mcp', 'tokens stored hashed', "{ token_hash: await sha256hex(access), grant_id", "{ token_hash: access, grant_id"],
  ['mcp', 'revoke deletes tokens', "  await db('DELETE', `mcp_tokens?grant_id=eq.${grantId}`);\n}", "}"],
  ['mcp', 'origin check', "if (method !== 'GET' && origin && !ORIGINS.has(origin)) {", "if (false) {"],
  ['mcp', 'state not logged', "has_state: p.has('state'),", "state: p.get('state'),"],
  ['mcp', 'db outage is not a 401', "if (!t.ok) return 'unavailable';", ""],
  ['mcp', 'db outage on refresh is not theft', "if (!first.ok) return oauthErr('server_error', 'Please try again', 503);", ""],
  ['mcp', 'old connections pruned', "for (const o of old.rows) if (", "for (const o of []) if ("],
  ['mcp', 'resource (audience) checked at authorize', "if (resource !== null && !sameResource(resource)) return fail('invalid_target', 'Unknown resource');", ""],
  ['mcp', 'PKCE S256 required at authorize', "if (p.get('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(codeChallenge)) {", "if (false) {"],
  ['mcp', 'state size capped', "if (state !== null && state.length > MAX_STATE) return text(", "if (false) return text("],
  ['mcp', 'body size capped', "if (size > MAX_BODY) { tooBig = true; chunks = []; }", ""],
  ['mcp', 'declared body size capped', "let tooBig = Number(req.headers.get('content-length') || '0') > MAX_BODY;", "let tooBig = false;"],
  ['mcp', 'oversized upload read to the end before answering', "if (!reader) return tooBig ? null : '';", "if (!reader || tooBig) return tooBig ? null : '';"],
  ['mcp', 'endless upload cut off', "if (size > DRAIN_MAX) { await reader.cancel().catch(() => {}); break; }", ""],
  ['sdb', 'request signature checked', "  if (diff !== 0) return null;\n  try {\n    const bin = atob(payload", "  try {\n    const bin = atob(payload"],
  ['sdb', 'request expiry', "|| p.exp <= Math.floor(Date.now() / 1000)) return null;\n    const allowed", ") return null;\n    const allowed"],
  ['sdb', 'second callback lock', "|| !allowed(p.r)) return null;", ") return null;"],
  ['sdb', 'purpose-bound signature', "new TextEncoder().encode(`req.${payload}`)", "new TextEncoder().encode(`code.${payload}`)"],
  ['sdb', 'app name is own property', "Object.prototype.hasOwnProperty.call(MCP_REDIRECTS, p.c) ? MCP_REDIRECTS[p.c] : null", "(MCP_REDIRECTS as any)[p.c] ? (() => true) : null"],
  ['sdb', 'pending invitation refused', "const current = (row: any): boolean => row.status === 'active' && (", "const current = (row: any): boolean => (true) && ("],
  ['sdb', 'temporary access end date', "(!row.expires_at || new Date(row.expires_at).getTime() > Date.now());", "(true);"],
  ['sdb', 'owner must be current too', "active: current(me) && current(owner),", "active: current(me),"],
  ['sdb', 'consent refused when off', "const refused = me.superAdmin ? 'super_admin' : !me.enabled ? 'ai_apps_off' : null;", "const refused = me.superAdmin ? 'super_admin' : null;"],
  ['sdb', 'super admin refused at consent', "const refused = me.superAdmin ? 'super_admin' : !me.enabled", "const refused = false ? 'super_admin' : !me.enabled"],
  ['sdb', 'super admin gets no company list', "if (me.superAdmin) return jsonResp({ ok: true, app: rq.app, refused });", ""],
  ['sdb', 'code stored hashed', "code_hash: codeHash, admin_id: me.id", "code_hash: code, admin_id: me.id"],
  ['sdb', 'consent rate limit', "if (recent === null || recent.length > MCP_CONSENTS_PER_HOUR) {", "if (false) {"],
  ['sdb', 'rate-limited code not kept', "await svcWrite('DELETE', `mcp_auth_codes?code_hash=eq.${codeHash}`);", ""],
  ['sdb', 'decision validated', "if (action === 'mcp_consent' && b.decision !== 'allow') return errResp('Invalid decision', 400);", ""],
  ['sdb', 'switch is owner only', "if (me.kind !== 'owner' || me.superAdmin || caller.role !== 'admin') return errResp('Only the account owner", "if (false) return errResp('Only the account owner"],
  ['sdb', 'switch value must be boolean', "if (typeof b.enabled !== 'boolean') return errResp('Invalid value', 400);", ""],
  ['sdb', 'switch off cancels connections', "cancelled = await mcpRevokeGrants(`admin_id=in.(${ids.join(',')})`, 'ai_apps_off');", "cancelled = 3;"],
  ['sdb', 'switch off drops pending codes', "await svcWrite('DELETE', `mcp_auth_codes?admin_id=in.(${ids.join(',')})`);", ""],
  ['sdb', 'list scoped to caller', "const people = me.kind === 'owner' ? await mcpAccountAdmins(me.ownerId) : [{ id: me.id, name: me.name }];", "const people = await mcpAccountAdmins(me.ownerId);"],
  ['sdb', 'list hides cancelled', "&revoked_at=is.null&select=id,admin_id,client,created_at,last_used_at", "&select=id,admin_id,client,created_at,last_used_at"],
  ['sdb', 'disconnect: others only for the owner', "if (me.kind !== 'owner' || me.superAdmin) return notFound();", ""],
  ['sdb', 'disconnect: same account only', "if (!(await mcpAccountAdmins(me.ownerId)).some((p) => p.id === grant.admin_id)) return notFound();", ""],
  ['sdb', 'disconnect deletes tokens', "if (ids.length) await svcWrite('DELETE', `mcp_tokens?grant_id=in.(${ids.join(',')})`);", ""],
  ['sdb', 'manager site scope on consent page', "const own = rows.filter((s: { company_id: string }) => coIds.has(s.company_id));", "const own = rows;"],
  ['sdb', 'super admin list refused', "if (me.superAdmin) return jsonResp({ ok: true, refused: 'super_admin', enabled: false", "if (false) return jsonResp({ ok: true, refused: 'super_admin', enabled: false"],
  ['sdb', 'session required for the card actions', "  if (!caller) return errResp('Unauthorized', 401);\n  const me = await mcpPerson(caller);\n  if (!me || !me.active) return errResp('Unauthorized', 401);\n\n  if (action === 'mcp_list_grants') {", "  const me = (caller ? await mcpPerson(caller) : null) || { id: '', name: '', kind: 'owner', ownerId: '00000000-0000-4000-8000-000000000000', enabled: true, superAdmin: false, active: true } as McpPerson;\n\n  if (action === 'mcp_list_grants') {"],
];
let caught = 0; const missed = [];
for (const [which, name, from, to] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  let src = fs.readFileSync(files[which], 'utf8').replace(/\r\n/g, '\n');
  const pairs = Array.isArray(from) ? from : [[from, to]];
  if (!pairs.every(([f]) => src.includes(f))) { console.log('  ??      pattern not found: ' + name); missed.push(name + ' (pattern not found)'); continue; }
  for (const [f, t] of pairs) src = src.replace(f, t);
  const out = path.join(dir, which === 'mcp' ? 'mcp.ts' : 'sdb.ts');
  fs.writeFileSync(out, src);
  const env = { ...process.env, [which === 'mcp' ? 'MCP_SRC' : 'SECURE_DB_SRC']: out };
  const r = spawnSync(process.execPath, [path.join(repo, 'tools/mcp-connector-test.mjs')], { env, encoding: 'utf8', timeout: 90000 });
  const fails = (r.stdout.match(/^  FAIL .*$/gm) || []);
  if (r.status !== 0) { caught++; console.log(`  caught  ${name}  (${fails.length || 'crash'}: ${(fails[0] || (r.stderr || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, 100)})`); }
  else { missed.push(name); console.log('  MISSED  ' + name); }
}
console.log(`\n${caught} of ${M.length} broken rules were caught` + (missed.length ? `\nNOT caught: ${missed.join('; ')}` : ''));
process.exit(missed.length ? 1 : 0);
