// Attack-first test for the AI connector: the sign-in service + MCP server (supabase/functions/mcp) together with
// the secure-db actions the consent page and the "AI apps" card use.
//
//   node tools/mcp-connector-test.mjs
//       Runs both functions' code in this process against an in-memory database that enforces the same table
//       rules as the real one (hash shape, single use, foreign keys). Nothing is deployed, nothing real is touched.
//   MCP_URL=https://<project>.supabase.co/functions/v1/mcp node tools/mcp-connector-test.mjs
//       Harmless probes of a deployed copy: discovery, and requests that must be REFUSED. Nothing is created,
//       nobody is signed in, no account is read.
// No tokens, codes or verifiers are printed.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LIVE = process.env.MCP_URL ? process.env.MCP_URL.replace(/\/+$/, '') : null;
const BASE = 'https://test-project.supabase.co';
const RESOURCE = LIVE || `${BASE}/functions/v1/mcp`;
const CONNECT_PAGE = 'https://www.punchclock.ca/connect.html';
const out = console.log.bind(console);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; out('  ok   ' + name); }
  else { fail++; out('  FAIL ' + name + (detail !== '' ? '  -> ' + String(detail).slice(0, 300) : '')); }
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const jsonPost = (o, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(o) });
function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

const CLAUDE_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CHATGPT_ID = 'https://chatgpt.com/oauth/client.json';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_CB = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CB2 = 'https://chatgpt.com/connector/oauth/abc123_XYZ';
const APP = { claude: { id: CLAUDE_ID, cb: CLAUDE_CB }, chatgpt: { id: CHATGPT_ID, cb: CHATGPT_CB } };

// ════════════════════════════════════════════════════════════════════════════════════════════
// In-memory database behind a small PostgREST look-alike (local mode only)
// ════════════════════════════════════════════════════════════════════════════════════════════
const T = { admins: [], admin_sessions: [], companies: [], sites: [], manager_sites: [], mcp_grants: [], mcp_tokens: [], mcp_auth_codes: [], audit_log: [] };
const dbLog = [];            // every database call the functions made: "METHOD table?query"
let dbDown = false;          // simulate the database not answering
let planDown = false;        // simulate only the plan lookup not answering
const logLines = [];         // everything the functions wrote to their log
const secrets = new Set();   // every raw code and token handed out during the run (to prove none is stored or logged)

const HEX64 = /^[0-9a-f]{64}$/, CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const REASONS = ['user', 'owner', 'password_change', 'deactivated', 'ai_apps_off', 'token_reuse', 'support'];
function constraintError(table, r) {
  const adminExists = (aid) => T.admins.some((a) => a.id === aid);
  if (table === 'mcp_auth_codes') {
    if (!HEX64.test(r.code_hash || '')) return 'code_hash shape';
    if (!['claude', 'chatgpt'].includes(r.client)) return 'client';
    if (typeof r.redirect_uri !== 'string' || r.redirect_uri.length < 1 || r.redirect_uri.length > 400) return 'redirect_uri';
    if (!CHALLENGE.test(r.code_challenge || '')) return 'code_challenge';
    if (!r.expires_at) return 'expires_at';
    if (!adminExists(r.admin_id)) return 'fk admin';
  }
  if (table === 'mcp_grants') {
    if (!['claude', 'chatgpt'].includes(r.client)) return 'client';
    if (r.scope !== 'punchclock.read') return 'scope';
    if ((r.revoked_at == null) !== (r.revoked_reason == null)) return 'revoked pair';
    if (r.revoked_reason != null && !REASONS.includes(r.revoked_reason)) return 'reason';
    if (!adminExists(r.admin_id)) return 'fk admin';
  }
  if (table === 'mcp_tokens') {
    if (!HEX64.test(r.token_hash || '')) return 'token_hash shape';
    if (!['access', 'refresh'].includes(r.kind)) return 'kind';
    if (r.used_at != null && r.kind !== 'refresh') return 'used only refresh';
    if (!r.expires_at) return 'expires_at';
    if (!T.mcp_grants.some((x) => x.id === r.grant_id)) return 'fk grant';
  }
  return null;
}
function withDefaults(table, r) {
  const now = new Date().toISOString();
  if (table === 'mcp_auth_codes') return { created_at: now, used_at: null, ...r };
  if (table === 'mcp_grants') return { id: randomUUID(), scope: 'punchclock.read', created_at: now, last_used_at: null, revoked_at: null, revoked_reason: null, ...r };
  if (table === 'mcp_tokens') return { created_at: now, used_at: null, ...r };
  if (table === 'audit_log') return { id: T.audit_log.length + 1, at: now, ...r };
  return { ...r };
}
const PK = { mcp_auth_codes: 'code_hash', mcp_tokens: 'token_hash', mcp_grants: 'id' };
const asTime = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : NaN);
function cmp(a, b) {
  const ta = asTime(a), tb = asTime(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}
function test1(row, col, expr) {
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot), val = expr.slice(dot + 1);
  const v = row[col];
  switch (op) {
    case 'eq': return v != null && String(v) === val;
    case 'neq': return v == null || String(v) !== val;
    case 'is': return val === 'null' ? v == null : String(v) === val;
    case 'in': return v != null && val.slice(1, -1).split(',').includes(String(v));
    case 'gt': return v != null && cmp(v, val) > 0;
    case 'gte': return v != null && cmp(v, val) >= 0;
    case 'lt': return v != null && cmp(v, val) < 0;
    case 'lte': return v != null && cmp(v, val) <= 0;
    default: throw new Error('fake db: unsupported operator ' + op);
  }
}
function pickRows(rows, params) {
  let res = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'or') {
      const parts = v.slice(1, -1).split(',').map((p) => { const i = p.indexOf('.'); return [p.slice(0, i), p.slice(i + 1)]; });
      res = res.filter((r) => parts.some(([c, e]) => test1(r, c, e)));
    } else res = res.filter((r) => test1(r, k, v));
  }
  return res;
}
function shape(rows, params) {
  let res = rows.slice();
  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split(',')[0].split('.');
    res.sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a[col], b[col]));
  }
  const off = parseInt(params.get('offset') || '0', 10);
  if (off) res = res.slice(off);
  if (params.has('limit')) res = res.slice(0, parseInt(params.get('limit'), 10));
  const sel = params.get('select');
  if (sel && sel !== '*') { const cols = sel.split(','); res = res.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))); }
  return res;
}
const jr = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(u, init = {}) {
  const url = new URL(String(u));
  const m = /^\/rest\/v1\/(.+)$/.exec(url.pathname);
  if (url.origin !== BASE || !m) return jr({});
  const method = (init.method || 'GET').toUpperCase();
  const table = m[1];
  dbLog.push(`${method} ${table}${url.search}`);
  if (dbDown) return jr({ message: 'upstream unavailable' }, 503);
  const wantRows = (init.headers?.Prefer || '').includes('return=representation');
  if (table === 'rpc/admin_plan_rank') {
    if (planDown) return jr({ message: 'plan lookup unavailable' }, 500);
    const a = T.admins.find((x) => x.id === JSON.parse(init.body).p_admin);
    if (!a) return jr(null);
    if (a.role === 'super_admin') return jr(4);
    const plan = (a.parent_admin_id ? T.admins.find((x) => x.id === a.parent_admin_id)?.plan : a.plan) || 'free';
    return jr({ unlimited: 4, business: 3, growth: 2, starter: 1 }[plan] ?? 0);
  }
  if (table.startsWith('rpc/')) return jr({ ok: true });
  const rows = T[table];
  if (!rows) return method === 'GET' ? jr([]) : jr({ message: 'no such table' }, 404);
  if (method === 'GET') return jr(shape(pickRows(rows, url.searchParams), url.searchParams));
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    const made = (Array.isArray(body) ? body : [body]).map((r) => withDefaults(table, r));
    for (const r of made) {
      const bad = constraintError(table, r);
      if (bad) return jr({ message: 'violates check constraint: ' + bad }, 400);
      if (PK[table] && rows.some((x) => x[PK[table]] === r[PK[table]])) return jr({ message: 'duplicate key' }, 409);
    }
    rows.push(...made);
    return wantRows ? jr(made, 201) : new Response(null, { status: 201 });
  }
  if (method === 'PATCH') {
    const hit = pickRows(rows, url.searchParams);
    const patch = JSON.parse(init.body);
    for (const r of hit) {
      const bad = constraintError(table, { ...r, ...patch });
      if (bad) return jr({ message: 'violates check constraint: ' + bad }, 400);
    }
    for (const r of hit) Object.assign(r, patch);
    return wantRows ? jr(hit.map((r) => ({ ...r }))) : new Response(null, { status: 204 });
  }
  if (method === 'DELETE') {
    const hit = new Set(pickRows(rows, url.searchParams));
    T[table] = rows.filter((r) => !hit.has(r));
    return new Response(null, { status: 204 });
  }
  return jr({ message: 'method' }, 405);
}

// ── people and companies ─────────────────────────────────────────────────────────────────────
const OWNER = randomUUID(), COADMIN = randomUUID(), MGR = randomUUID(), PENDING = randomUUID(), OTHER = randomUUID(), SUPER = randomUUID(), GF = randomUUID(), STARTER = randomUUID();
const C1 = randomUUID(), C2 = randomUUID(), C9 = randomUUID(), CG = randomUUID(), CS = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), S3 = randomUUID(), S9 = randomUUID();
const FUTURE = new Date(Date.now() + 36e5).toISOString(), PAST = new Date(Date.now() - 1000).toISOString();
function seed() {
  const A = (aid, name, o = {}) => ({ id: aid, name, email: name.toLowerCase().replace(/\W/g, '') + '@example.test', password: 'HASH-' + aid, role: 'admin', status: 'active', plan: 'free', parent_admin_id: null, ai_apps_enabled: false, ...o });
  T.admins = [
    A(OWNER, 'Olivia Owner', { plan: 'growth' }),
    A(COADMIN, 'Carl Coadmin', { parent_admin_id: OWNER }),
    A(MGR, 'Mia <b>Manager</b>', { parent_admin_id: OWNER, role: 'manager' }),
    A(PENDING, 'Pat Pending', { parent_admin_id: OWNER, status: 'pending_invite' }),
    A(OTHER, 'Rita Rival'),
    A(SUPER, 'Platform', { role: 'super_admin', plan: 'unlimited' }),
    A(GF, 'Gina Grandfathered'),
    A(STARTER, 'Sam Starter', { plan: 'starter' }),
  ];
  T.companies = [
    { id: C1, admin_id: OWNER, name: 'Acme Fence' }, { id: C2, admin_id: OWNER, name: 'Acme Decks' },
    { id: C9, admin_id: OTHER, name: 'Rival Roofing' }, { id: CG, admin_id: GF, name: 'Oaziz Extracts' }, { id: CS, admin_id: STARTER, name: 'Starter Co' },
  ];
  T.sites = [
    { id: S1, company_id: C1, name: 'Main yard' }, { id: S2, company_id: C1, name: 'North shop' },
    { id: S3, company_id: C2, name: 'Deck shop' }, { id: S9, company_id: C9, name: 'Rival HQ' },
  ];
  // The manager runs one site of their own account. The second row is a planted assignment to another tenant's site.
  T.manager_sites = [{ manager_id: MGR, site_id: S1 }, { manager_id: MGR, site_id: S9 }];
  const S = (token, admin_id, expires_at = FUTURE) => ({ token, admin_id, expires_at });
  T.admin_sessions = [S('tokOwner', OWNER), S('tokCo', COADMIN), S('tokMgr', MGR), S('tokPending', PENDING), S('tokOther', OTHER),
    S('tokSuper', SUPER), S('tokGf', GF), S('tokStarter', STARTER), S('tokExpired', OWNER, PAST)];
}
const admin = (aid) => T.admins.find((a) => a.id === aid);

// ── the two functions ────────────────────────────────────────────────────────────────────────
let mcpCall, sdb;
const SERVICE_KEY = 'local-test-key-' + randomBytes(16).toString('hex');
if (LIVE) {
  mcpCall = (path, init = {}) => fetch(RESOURCE + path, { redirect: 'manual', ...init });
} else {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  globalThis.fetch = fakeFetch;
  console.log = (...a) => { logLines.push(a.map(String).join(' ')); };
  const served = [];
  globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: (h) => { served.push(h); } };
  // MCP_SRC / SECURE_DB_SRC point at other copies of the two files (used to check that these tests fail on broken code).
  const src = (envName, rel) => (process.env[envName] ? pathToFileURL(process.env[envName]).href : new URL(rel, import.meta.url).href);
  const mod = await import(src('MCP_SRC', '../supabase/functions/mcp/index.ts'));
  await import(src('SECURE_DB_SRC', '../supabase/functions/secure-db/index.ts'));
  const secureDb = served[served.length - 1];
  mcpCall = (path, init = {}) => mod.handler(new Request('https://edge.internal/mcp' + path, init));
  sdb = async (payload) => {
    const r = await secureDb(new Request('https://edge.internal/secure-db', jsonPost({ kioskV: 2, ...payload })));
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  seed();
}
const rpc = (token, method, params, rid = 1) =>
  mcpCall('', jsonPost({ jsonrpc: '2.0', id: rid, method, ...(params ? { params } : {}) }, { Authorization: 'Bearer ' + token }));
const authorizeUrl = (o) => '/authorize?' + new URLSearchParams(o).toString();
async function startSignIn(app, challenge, extra = {}) {
  const r = await mcpCall(authorizeUrl({ response_type: 'code', client_id: APP[app].id, redirect_uri: APP[app].cb, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: RESOURCE, ...extra }));
  const loc = r.headers.get('location') || '';
  return { status: r.status, loc, request: loc.startsWith(CONNECT_PAGE + '#r=') ? loc.slice((CONNECT_PAGE + '#r=').length) : null };
}
// The whole happy path: app asks, person allows on the consent page, app trades the code for tokens.
async function connect(app, sessionToken) {
  const { verifier, challenge } = pkce();
  const { request } = await startSignIn(app, challenge);
  const consent = await sdb({ action: 'mcp_consent', sessionToken, body: { request, decision: 'allow' } });
  if (consent.status !== 200) return { consent };
  const back = new URL(consent.body.redirect);
  const code = back.searchParams.get('code');
  secrets.add(code);
  const tr = await mcpCall('/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: APP[app].cb, client_id: APP[app].id, resource: RESOURCE }));
  const tok = await tr.json().catch(() => null);
  if (tok?.access_token) { secrets.add(tok.access_token); secrets.add(tok.refresh_token); }
  return { consent, back, code, verifier, status: tr.status, tok };
}
const refreshWith = async (app, rt) => {
  const r = await mcpCall('/token', form({ grant_type: 'refresh_token', refresh_token: rt, client_id: APP[app].id }));
  const body = await r.json().catch(() => null);
  if (body?.access_token) { secrets.add(body.access_token); secrets.add(body.refresh_token); }
  return { status: r.status, body };
};
const pingStatus = async (access) => (await rpc(access, 'ping')).status;
const grantOf = (accessOrRefresh) => T.mcp_tokens.find((t) => t.token_hash === sha256hex(accessOrRefresh))?.grant_id;
const grantRow = (gid) => T.mcp_grants.find((x) => x.id === gid);
const liveGrants = (aid) => T.mcp_grants.filter((x) => x.admin_id === aid && !x.revoked_at);
// A request signed the way the mcp function signs it, for the cases the function itself would never produce.
function forgeRequest(payload, key = SERVICE_KEY, kind = 'req') {
  const body = b64url(Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, ...payload })));
  return `${body}.${b64url(createHmac('sha256', 'mcp-connector-v1:' + key).update(`${kind}.${body}`).digest())}`;
}

out(`\nAI connector: ${LIVE ? 'LIVE probes of ' + RESOURCE : 'local code, in-memory database'}\n`);

// ════════════════════════════════════════════════════════════════════════════════════════════
out('Discovery');
{
  const r = await mcpCall('', jsonPost({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
  const www = r.headers.get('www-authenticate') || '';
  check('no token -> 401', r.status === 401, r.status);
  check('401 points at the protected-resource document', www.includes(`resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"`), www);
  check('GET without token -> 401 too', (await mcpCall('', { method: 'GET' })).status === 401);
  const prm = await (await mcpCall('/.well-known/oauth-protected-resource')).json();
  check('resource equals the address a person pastes', prm.resource === RESOURCE, prm.resource);
  check('one authorization server, the same address', JSON.stringify(prm.authorization_servers) === JSON.stringify([RESOURCE]));
  for (const doc of ['oauth-authorization-server', 'openid-configuration']) {
    const md = await (await mcpCall('/.well-known/' + doc)).json();
    check(`${doc}: issuer, endpoints, S256 only, public clients`, md.issuer === RESOURCE && md.authorization_endpoint === RESOURCE + '/authorize'
      && md.token_endpoint === RESOURCE + '/token' && md.revocation_endpoint === RESOURCE + '/revoke'
      && JSON.stringify(md.code_challenge_methods_supported) === '["S256"]' && JSON.stringify(md.token_endpoint_auth_methods_supported) === '["none"]'
      && md.client_id_metadata_document_supported === true && md.authorization_response_iss_parameter_supported === true, JSON.stringify(md));
    check(`${doc}: no self-registration offered`, !('registration_endpoint' in md));
  }
  check('self-registration endpoint is gone', (await mcpCall('/register', jsonPost({ redirect_uris: [CLAUDE_CB] }))).status === 404);
  check('unknown path -> 404', (await mcpCall('/admin')).status === 404);
  check('a browser page on another site cannot POST', (await mcpCall('/token', { ...form({ grant_type: 'refresh_token' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' } })).status === 403);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nAuthorize: who may ask, and where the answer may go');
{
  const { challenge } = pkce();
  const base = { response_type: 'code', client_id: CLAUDE_ID, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123' };
  const stays = async (name, o) => { const r = await mcpCall(authorizeUrl({ ...base, ...o })); check(name, r.status === 400 && !r.headers.get('location'), `${r.status} ${r.headers.get('location')}`); };
  await stays('unknown app (some other site) -> stays here', { client_id: 'https://evil.example/client.json' });
  await stays('look-alike host claude.ai.evil.example', { client_id: 'https://claude.ai.evil.example/oauth/x' });
  await stays('user-info trick https://claude.ai@evil.example', { client_id: 'https://claude.ai@evil.example/oauth/x' });
  await stays('plain http client address', { client_id: 'http://claude.ai/oauth/x' });
  await stays('client address with a port', { client_id: 'https://claude.ai:8443/oauth/x' });
  await stays('a made-up registered id (c_...) is no longer accepted', { client_id: 'c_' + 'A'.repeat(30) });
  await stays('missing client', { client_id: '' });
  await stays('return address on another site', { redirect_uri: 'https://evil.example/cb' });
  await stays('return address on localhost (Claude Code is not in v1)', { redirect_uri: 'http://localhost:33418/callback' });
  await stays('return address that only starts like Claude\'s', { redirect_uri: CLAUDE_CB + '.evil.example' });
  await stays('Claude client with ChatGPT\'s return address', { redirect_uri: CHATGPT_CB });
  await stays('ChatGPT client with Claude\'s return address', { client_id: CHATGPT_ID, redirect_uri: CLAUDE_CB });
  await stays('ChatGPT per-connection address with a path trick', { client_id: CHATGPT_ID, redirect_uri: 'https://chatgpt.com/connector/oauth/../../evil' });
  await stays('oversized state', { state: 'x'.repeat(2001) });

  const errBack = async (name, o, want) => {
    const r = await mcpCall(authorizeUrl({ ...base, ...o }));
    const loc = r.headers.get('location') || '';
    const u = loc ? new URL(loc) : null;
    check(name, r.status === 302 && loc.startsWith(CLAUDE_CB + '?') && u.searchParams.get('error') === want && u.searchParams.get('state') === 'st-123'
      && u.searchParams.get('iss') === RESOURCE && !u.searchParams.has('code'), `${r.status} ${loc.slice(0, 120)}`);
  };
  await errBack('no PKCE challenge -> error sent to the app, no code', { code_challenge: '' }, 'invalid_request');
  await errBack('PKCE "plain" -> refused', { code_challenge_method: 'plain' }, 'invalid_request');
  await errBack('response_type=token -> refused', { response_type: 'token' }, 'unsupported_response_type');
  await errBack('another resource -> refused', { resource: 'https://evil.example/mcp' }, 'invalid_target');

  const before = dbLog.length;
  for (const [app, cb] of [['claude', CLAUDE_CB], ['claude', 'https://claude.com/api/mcp/auth_callback'], ['chatgpt', CHATGPT_CB], ['chatgpt', CHATGPT_CB2]]) {
    const s = await startSignIn(app, challenge, { redirect_uri: cb });
    check(`${app} via ${new URL(cb).pathname.slice(0, 32)} -> sent to our consent page, request in the fragment`, s.status === 302 && !!s.request && !s.loc.includes('?'), s.loc.slice(0, 80));
  }
  check('nobody is approved here: no code in the redirect', !(await startSignIn('claude', challenge)).loc.includes('code='));
  if (!LIVE) check('anonymous sign-in requests never touch the database', dbLog.length === before, dbLog.slice(before).join(' | '));
  check('POST /authorize -> 405', (await mcpCall('/authorize', form({}))).status === 405);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nToken endpoint: refusals that need no account');
{
  const { verifier } = pkce();
  const code = 'pcc_ac_' + b64url(randomBytes(32)), rt = 'pcc_rt_' + b64url(randomBytes(32)), at = 'pcc_at_' + b64url(randomBytes(32));
  const post = async (o) => { const r = await mcpCall('/token', form(o)); return { status: r.status, body: await r.json().catch(() => null) }; };
  const good = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id: CLAUDE_ID };
  let r = await post({ ...good, client_id: 'https://evil.example/c.json' });
  check('unknown client -> 401 invalid_client', r.status === 401 && r.body?.error === 'invalid_client');
  const { code_verifier: _dropped, ...noVerifier } = good;
  r = await post(noVerifier);
  check('missing verifier -> refused', r.status === 400 && r.body?.error === 'invalid_request');
  r = await post({ ...good, code_verifier: '' });
  check('empty verifier -> refused', r.status === 400 && r.body?.error === 'invalid_request');
  r = await post({ ...good, code_verifier: 'short' });
  check('too-short verifier -> refused', r.status === 400 && r.body?.error === 'invalid_request');
  r = await post(good);
  check('a well-formed code nobody issued -> invalid_grant', r.status === 400 && r.body?.error === 'invalid_grant' && !r.body.access_token);
  r = await post({ ...good, code: "x' or '1'='1" });
  check('a malformed code -> invalid_grant', r.status === 400 && r.body?.error === 'invalid_grant');
  r = await post({ ...good, resource: 'https://evil.example/mcp' });
  check('another resource -> invalid_target', r.status === 400 && r.body?.error === 'invalid_target');
  r = await post({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLAUDE_ID });
  check('a refresh token nobody issued -> invalid_grant', r.status === 400 && r.body?.error === 'invalid_grant');
  r = await post({ grant_type: 'refresh_token', refresh_token: '', client_id: CLAUDE_ID });
  check('an empty refresh token -> invalid_grant', r.status === 400 && r.body?.error === 'invalid_grant');
  r = await post({ grant_type: 'client_credentials', client_id: CLAUDE_ID });
  check('machine-to-machine grant -> unsupported', r.status === 400 && r.body?.error === 'unsupported_grant_type');
  r = await post({ grant_type: 'password', username: 'a', password: 'b', client_id: CLAUDE_ID });
  check('password grant -> unsupported', r.status === 400 && r.body?.error === 'unsupported_grant_type');
  check('an access token nobody issued -> 401', await pingStatus(at) === 401);
  check('a malformed bearer -> 401', await pingStatus('abc') === 401);
  check('revoking a token nobody issued -> plain 200', (await mcpCall('/revoke', form({ token: rt }))).status === 200);
  check('an oversized body -> 413', (await mcpCall('/token', form({ grant_type: 'refresh_token', pad: 'x'.repeat(70000) }))).status === 413);
  if (!LIVE) {
    // An upload sent piece by piece: how much of it the function read, and whether it cut the upload off.
    const upload = (pieces, declared) => {
      const seen = { pulled: 0, cancelled: false };
      const kb = new TextEncoder().encode('x'.repeat(1024));
      const body = new ReadableStream({
        pull(c) { if (seen.pulled >= pieces) c.close(); else { seen.pulled++; c.enqueue(kb); } },
        cancel() { seen.cancelled = true; },
      }, { highWaterMark: 0 });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(declared ? { 'Content-Length': String(declared) } : {}) };
      return { seen, init: { method: 'POST', headers, body, duplex: 'half' } };
    };
    for (const path of ['/token', '/revoke']) {
      const u = upload(70, 70 * 1024);
      const s = (await mcpCall(path, u.init)).status;
      check(`oversized upload to ${path} -> 413, read to the end first`, s === 413 && u.seen.pulled === 70 && !u.seen.cancelled, `${s} ${u.seen.pulled}`);
    }
    let u = upload(70, 70 * 1024);
    r = (await mcpCall('', u.init)).status;
    check('oversized upload to the MCP endpoint without a connection -> 401, read to the end first', r === 401 && u.seen.pulled === 70 && !u.seen.cancelled, `${r} ${u.seen.pulled}`);
    u = upload(3, 0);
    r = (await mcpCall('/register', u.init)).status;
    check('an upload to an address that does not exist -> 404, read to the end first', r === 404 && u.seen.pulled === 3, `${r} ${u.seen.pulled}`);
    u = upload(4096, 0);
    r = (await mcpCall('', u.init)).status;
    check('an endless upload without a connection is cut off after 1 MB -> 401', r === 401 && u.seen.cancelled && u.seen.pulled <= 1026, `${r} ${u.seen.pulled} ${u.seen.cancelled}`);
    u = upload(70, 0);
    r = (await mcpCall('/token', u.init)).status;
    check('oversized upload that declares no size -> 413', r === 413 && u.seen.pulled === 70, `${r} ${u.seen.pulled}`);
    u = upload(1, 70 * 1024);
    check('a small upload that declares an oversized one -> 413', (await mcpCall('/token', u.init)).status === 413);
    u = upload(4096, 0);
    r = (await mcpCall('/token', u.init)).status;
    check('an endless upload is cut off after 1 MB -> 413', r === 413 && u.seen.cancelled && u.seen.pulled <= 1026, `${r} ${u.seen.pulled} ${u.seen.cancelled}`);
    u = upload(64, 0);
    r = (await mcpCall('/token', u.init)).status;
    check('an upload of exactly the limit is read, not called too large', r !== 413 && u.seen.pulled === 64, `${r} ${u.seen.pulled}`);
  }
}

if (LIVE) {
  out(`\n${pass} passed, ${fail} failed (live probes only; the full suite runs locally)\n`);
  process.exit(fail ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nConsent page: the signed request cannot be altered or made up');
{
  const { challenge } = pkce();
  const { request } = await startSignIn('claude', challenge);
  const info = (req, sessionToken = 'tokOwner') => sdb({ action: 'mcp_consent_info', sessionToken, body: { request: req } });
  const refusedReq = async (name, req) => { const r = await info(req); check(name, r.status === 400 && r.body?.code === 'request_invalid', `${r.status} ${JSON.stringify(r.body)}`); };
  check('a real request is recognised', (await info(request)).status === 200);
  await refusedReq('one character changed', request.slice(0, 10) + (request[10] === 'A' ? 'B' : 'A') + request.slice(11));
  await refusedReq('signature removed', request.split('.')[0]);
  await refusedReq('signed with another key', forgeRequest({ c: 'claude', r: CLAUDE_CB, ch: challenge, s: null }, 'not-the-key'));
  await refusedReq('expired', forgeRequest({ c: 'claude', r: CLAUDE_CB, ch: challenge, s: null, exp: Math.floor(Date.now() / 1000) - 5 }));
  await refusedReq('a value signed for another purpose', forgeRequest({ c: 'claude', r: CLAUDE_CB, ch: challenge, s: null }, SERVICE_KEY, 'code'));
  await refusedReq('correctly signed but naming a foreign return address (second lock)', forgeRequest({ c: 'claude', r: 'https://evil.example/cb', ch: challenge, s: null }));
  await refusedReq('correctly signed, Claude with ChatGPT\'s address', forgeRequest({ c: 'claude', r: CHATGPT_CB, ch: challenge, s: null }));
  await refusedReq('correctly signed, unknown app', forgeRequest({ c: 'constructor', r: CLAUDE_CB, ch: challenge, s: null }));
  await refusedReq('correctly signed, bad challenge', forgeRequest({ c: 'claude', r: CLAUDE_CB, ch: 'x', s: null }));
  await refusedReq('missing', undefined);
  await refusedReq('not a string', { a: 1 });
  const ok = await info(forgeRequest({ c: 'claude', r: CLAUDE_CB, ch: challenge, s: null }));
  check('(control) the same forgery with nothing wrong in it is accepted, so the refusals above are real', ok.status === 200);
}

out('\nConsent page: who may allow');
{
  const { challenge } = pkce();
  const { request } = await startSignIn('claude', challenge);
  const allow = (sessionToken, extra = {}) => sdb({ action: 'mcp_consent', sessionToken, body: { request, decision: 'allow', ...extra } });
  const info = (sessionToken) => sdb({ action: 'mcp_consent_info', sessionToken, body: { request } });
  const noCodes = () => T.mcp_auth_codes.length === 0;

  let r = await sdb({ action: 'mcp_consent', body: { request, decision: 'allow' } });
  check('not signed in -> 401, nothing written', r.status === 401 && noCodes());
  r = await allow('tokExpired');
  check('expired session -> 401', r.status === 401 && noCodes());
  r = await allow('no-such-token');
  check('made-up session -> 401', r.status === 401 && noCodes());
  r = await allow('tokPending');
  check('invitation not accepted yet -> 401', r.status === 401 && noCodes());
  // temporary access that has run out (the website checks the end date only when signing in)
  admin(OWNER).ai_apps_enabled = true; admin(COADMIN).expires_at = PAST;
  r = await allow('tokCo');
  check('temporary account past its end date -> 401, even with the switch on', r.status === 401 && noCodes());
  admin(COADMIN).expires_at = null; admin(OWNER).expires_at = PAST;
  r = await allow('tokCo');
  check('...and when it is the owner\'s account that ran out', r.status === 401 && noCodes());
  admin(OWNER).expires_at = FUTURE;
  check('(control) an end date still in the future is fine', (await info('tokCo')).status === 200);
  admin(OWNER).expires_at = null; admin(OWNER).ai_apps_enabled = false;
  r = await allow('tokOwner');
  check('owner while "Allow AI apps" is off (the default) -> refused', r.status === 403 && r.body?.code === 'ai_apps_off' && noCodes(), JSON.stringify(r.body));
  r = await allow('tokCo');
  check('co-admin while it is off -> refused', r.status === 403 && noCodes());
  r = await allow('tokMgr');
  check('manager while it is off -> refused', r.status === 403 && noCodes());
  r = await allow('tokSuper');
  check('super admin -> refused, always', r.status === 403 && r.body?.code === 'super_admin' && noCodes());
  admin(SUPER).ai_apps_enabled = true;
  r = await allow('tokSuper');
  check('super admin even with the switch forced on -> refused', r.status === 403 && noCodes());
  r = await info('tokSuper');
  check('super admin: the consent page gets no company list', r.status === 200 && r.body.refused === 'super_admin' && !('companies' in r.body));
  admin(SUPER).ai_apps_enabled = false;
  r = await sdb({ action: 'mcp_consent', sessionToken: 'tokOwner', body: { request, decision: 'maybe' } });
  check('a decision that is neither allow nor deny -> 400', r.status === 400 && noCodes());
  check('refusals are logged', T.audit_log.some((a) => a.event === 'mcp_consent_refused' && a.admin_id === OWNER));

  r = await sdb({ action: 'mcp_consent', body: { request, decision: 'deny' } });
  const deny = r.body?.redirect ? new URL(r.body.redirect) : null;
  check('Cancel (no session needed) -> back to the app with access_denied, state and iss, no code', r.status === 200 && deny && r.body.redirect.startsWith(CLAUDE_CB + '?')
    && deny.searchParams.get('error') === 'access_denied' && deny.searchParams.get('state') === 'st-123' && deny.searchParams.get('iss') === RESOURCE && !deny.searchParams.has('code') && noCodes());

  // what the page shows
  r = await info('tokOwner');
  check('owner sees their own companies, told it is off', r.status === 200 && r.body.app === 'claude' && r.body.role === 'owner' && r.body.refused === 'ai_apps_off'
    && JSON.stringify(r.body.companies) === '["Acme Decks","Acme Fence"]' && r.body.sites === null && r.body.plan_included === true, JSON.stringify(r.body));
  r = await info('tokMgr');
  check('manager sees only their own site and its company; a planted assignment to another tenant\'s site is ignored',
    r.body.role === 'manager' && JSON.stringify(r.body.sites) === '["Main yard"]' && JSON.stringify(r.body.companies) === '["Acme Fence"]', JSON.stringify(r.body));
  check('no other tenant\'s name anywhere in it', !JSON.stringify(r.body).includes('Rival'));
  check('plan: Free -> not included', (await info('tokOther')).body.plan_included === false);
  check('plan: Starter -> not included', (await info('tokStarter')).body.plan_included === false);
  check('plan: grandfathered company on Free -> included', (await info('tokGf')).body.plan_included === true);
  check('plan: co-admin inherits the owner\'s Growth', (await info('tokCo')).body.plan_included === true);
  check('the answer carries no e-mail, password or id', !/@example\.test|HASH-|"id"/.test(JSON.stringify((await info('tokOwner')).body)));
}

out('\nThe owner\'s switch');
{
  const set = (sessionToken, enabled) => sdb({ action: 'set_ai_apps', sessionToken, body: { enabled } });
  check('not signed in -> 401', (await sdb({ action: 'set_ai_apps', body: { enabled: true } })).status === 401);
  check('manager -> 403', (await set('tokMgr', true)).status === 403);
  check('co-admin -> 403', (await set('tokCo', true)).status === 403);
  check('super admin -> 403', (await set('tokSuper', true)).status === 403);
  check('still off for everyone after those', T.admins.every((a) => a.ai_apps_enabled === false));
  check('"true" as text -> 400', (await set('tokOwner', 'true')).status === 400 && admin(OWNER).ai_apps_enabled === false);
  check('missing value -> 400', (await sdb({ action: 'set_ai_apps', sessionToken: 'tokOwner', body: {} })).status === 400);
  let r = await sdb({ action: 'set_ai_apps', sessionToken: 'tokOwner', body: { enabled: true, admin_id: OTHER, owner_id: OTHER } });
  check('owner switches it on: their own row only, whatever id the request names', r.status === 200 && r.body.enabled === true && admin(OWNER).ai_apps_enabled === true && admin(OTHER).ai_apps_enabled === false);
  check('logged', T.audit_log.some((a) => a.event === 'ai_apps_on' && a.admin_id === OWNER));
  // the table path must not offer a second way in
  r = await sdb({ table: 'admins', method: 'PATCH', filter: `id=eq.${OTHER}`, body: { ai_apps_enabled: true }, sessionToken: 'tokOther' });
  check('the switch cannot be set through the table path', r.status === 403 && admin(OTHER).ai_apps_enabled === false, `${r.status} ${JSON.stringify(r.body)}`);
  for (const tbl of ['mcp_grants', 'mcp_tokens', 'mcp_auth_codes', 'mcp_calls']) {
    r = await sdb({ table: tbl, method: 'GET', filter: '', sessionToken: 'tokOwner' });
    check(`table ${tbl} is not readable through secure-db`, r.status === 403);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nConnecting (switch on for the Acme account only)');
let owner, mgr, co;
{
  owner = await connect('claude', 'tokOwner');
  const back = owner.back;
  check('Allow -> back to Claude\'s own address with code, state and iss', owner.consent.status === 200 && owner.consent.body.redirect.startsWith(CLAUDE_CB + '?')
    && /^pcc_ac_[A-Za-z0-9_-]{43}$/.test(owner.code) && back.searchParams.get('state') === 'st-123' && back.searchParams.get('iss') === RESOURCE);
  check('code traded for tokens', owner.status === 200 && owner.tok.token_type === 'Bearer' && owner.tok.expires_in === 3600 && owner.tok.scope === 'punchclock.read'
    && /^pcc_at_/.test(owner.tok.access_token) && /^pcc_rt_/.test(owner.tok.refresh_token), owner.status);
  const codeRow = T.mcp_auth_codes.find((c) => c.code_hash === sha256hex(owner.code));
  check('the code is stored as a hash, bound to the person, app, address and challenge, valid 60 s, and marked used',
    !!codeRow && codeRow.admin_id === OWNER && codeRow.client === 'claude' && codeRow.redirect_uri === CLAUDE_CB && !!codeRow.used_at
    && Date.parse(codeRow.expires_at) - Date.now() <= 60_000);
  const g1 = grantRow(grantOf(owner.tok.access_token));
  check('one connection row: this person, this app, read-only', !!g1 && g1.admin_id === OWNER && g1.client === 'claude' && g1.scope === 'punchclock.read' && !g1.revoked_at);
  await new Promise((res) => setTimeout(res, 10));
  check('connection logged', T.audit_log.some((a) => a.event === 'mcp_connected' && a.admin_id === OWNER) && T.audit_log.some((a) => a.event === 'mcp_consent' && a.admin_id === OWNER));

  mgr = await connect('chatgpt', 'tokMgr');
  check('manager connects ChatGPT under the owner\'s switch', mgr.status === 200 && grantRow(grantOf(mgr.tok.access_token)).admin_id === MGR && grantRow(grantOf(mgr.tok.access_token)).client === 'chatgpt');
  co = await connect('claude', 'tokCo');
  check('co-admin connects Claude', co.status === 200 && grantRow(grantOf(co.tok.access_token)).admin_id === COADMIN);

  // identity comes from the session, never from the request
  const { challenge } = pkce();
  const { request } = await startSignIn('claude', challenge);
  const n = T.mcp_auth_codes.length;
  const forged = await sdb({ action: 'mcp_consent', sessionToken: 'tokMgr', sessionId: OWNER, body: { request, decision: 'allow', admin_id: OWNER, adminId: OWNER, person: OWNER } });
  check('a request naming somebody else still makes a code for the signed-in person only', forged.status === 200 && T.mcp_auth_codes.length === n + 1 && T.mcp_auth_codes[n].admin_id === MGR);
  secrets.add(new URL(forged.body.redirect).searchParams.get('code'));

  let r = await connect('claude', 'tokOther');
  check('another account whose switch is off cannot connect', r.consent.status === 403 && !T.mcp_grants.some((x) => x.admin_id === OTHER));
  r = await connect('claude', 'tokSuper');
  check('super admin cannot connect', r.consent.status === 403 && !T.mcp_grants.some((x) => x.admin_id === SUPER));
}

out('\nThe code: single use, bound, short-lived');
{
  const fresh = async (sessionToken = 'tokOwner', app = 'claude') => {
    const { verifier, challenge } = pkce();
    const { request } = await startSignIn(app, challenge);
    const c = await sdb({ action: 'mcp_consent', sessionToken, body: { request, decision: 'allow' } });
    const code = new URL(c.body.redirect).searchParams.get('code');
    secrets.add(code);
    return { code, verifier, app };
  };
  const trade = async (f, o = {}) => {
    const r = await mcpCall('/token', form({ grant_type: 'authorization_code', code: f.code, code_verifier: f.verifier, redirect_uri: APP[f.app].cb, client_id: APP[f.app].id, ...o }));
    const body = await r.json().catch(() => null);
    if (body?.access_token) { secrets.add(body.access_token); secrets.add(body.refresh_token); }
    return { status: r.status, body };
  };
  const grants = () => T.mcp_grants.length;
  const n = grants();
  const codeRowOf = (f) => T.mcp_auth_codes.find((c) => c.code_hash === sha256hex(f.code));

  let r = await trade({ ...owner, app: 'claude' });
  check('the code that was already used -> refused', r.status === 400 && r.body.error === 'invalid_grant' && grants() === n);

  let f = await fresh();
  r = await trade(f, { code_verifier: pkce().verifier });
  check('wrong verifier -> refused', r.status === 400 && r.body.error === 'invalid_grant' && grants() === n);
  r = await trade(f);
  check('...and that attempt used the code up: the right verifier is now refused too', r.status === 400 && grants() === n);

  f = await fresh();
  r = await trade(f, { code_verifier: '' });
  check('empty verifier -> refused before the code is even looked at', r.status === 400 && r.body.error === 'invalid_request' && !codeRowOf(f).used_at);
  r = await trade(f, { client_id: CHATGPT_ID });
  check('a Claude code presented by the ChatGPT client (same return address) -> refused', r.status === 400 && grants() === n);
  f = await fresh();
  r = await trade(f, { client_id: CHATGPT_ID, redirect_uri: CHATGPT_CB });
  check('a Claude code presented as ChatGPT with ChatGPT\'s address -> refused', r.status === 400 && grants() === n);

  f = await fresh();
  r = await trade(f, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' });
  check('another (even allowed) return address than the one approved -> refused', r.status === 400 && grants() === n);

  f = await fresh();
  codeRowOf(f).expires_at = PAST;
  r = await trade(f);
  check('expired code -> refused', r.status === 400 && grants() === n);

  f = await fresh();
  admin(OWNER).ai_apps_enabled = false;
  r = await trade(f);
  await new Promise((res) => setTimeout(res, 10));
  check('owner switched AI apps off between Allow and the exchange -> refused', r.status === 400 && grants() === n && T.audit_log.some((a) => a.event === 'mcp_connect_refused'));
  admin(OWNER).ai_apps_enabled = true;

  f = await fresh('tokMgr', 'chatgpt');
  admin(MGR).status = 'suspended';
  r = await trade(f);
  check('person suspended between Allow and the exchange -> refused', r.status === 400 && grants() === n);
  admin(MGR).status = 'active';

  f = await fresh('tokCo');
  admin(COADMIN).role = 'super_admin';
  r = await trade(f);
  check('person became super admin in between -> refused', r.status === 400 && grants() === n);
  admin(COADMIN).role = 'admin';

  f = await fresh();
  r = await trade(f);
  check('an untouched code with the right verifier -> tokens (control)', r.status === 200 && grants() === n + 1);
  await mcpCall('/revoke', form({ token: r.body.refresh_token }));
}

out('\nConsent rate limit');
{
  const { challenge } = pkce();
  const { request } = await startSignIn('claude', challenge);
  admin(GF).ai_apps_enabled = true;
  let last;
  for (let i = 0; i < 21; i++) {
    last = await sdb({ action: 'mcp_consent', sessionToken: 'tokGf', body: { request, decision: 'allow' } });
    if (last.body?.redirect) secrets.add(new URL(last.body.redirect).searchParams.get('code'));
  }
  const mine = () => T.mcp_auth_codes.filter((c) => c.admin_id === GF);
  check('the 21st Allow within an hour -> 429, and its code is not kept', last.status === 429 && last.body.code === 'rate_limited' && mine().length === 20, `${last.status} ${mine().length}`);
  await new Promise((res) => setTimeout(res, 10));
  check('logged', T.audit_log.some((a) => a.event === 'mcp_consent_rate_limited' && a.admin_id === GF));
  for (const c of mine()) c.created_at = new Date(Date.now() - 2 * 3600_000).toISOString();
  last = await sdb({ action: 'mcp_consent', sessionToken: 'tokGf', body: { request, decision: 'allow' } });
  check('an hour later it works again', last.status === 200);
  secrets.add(new URL(last.body.redirect).searchParams.get('code'));
  check('another person is not slowed down by it', (await connect('claude', 'tokCo')).status === 200);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nCalling the server');
{
  const init = await rpc(owner.tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const ib = await init.json();
  check('initialize', init.status === 200 && ib.result.protocolVersion === '2025-06-18' && ib.result.serverInfo.name === 'punchclock-crew');
  const tl = await (await rpc(owner.tok.access_token, 'tools/list')).json();
  check('every tool has a title and a read-only label', tl.result.tools.length >= 1 && tl.result.tools.every((t) => t.title && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false));
  const tc = await (await rpc(owner.tok.access_token, 'tools/call', { name: 'ping', arguments: {} })).json();
  check('ping answers, with no account data', tc.result.isError === false && /^pong\./.test(tc.result.content[0].text) && !/Acme|Olivia|@/.test(JSON.stringify(tc)));
  check('unknown tool -> error', (await (await rpc(owner.tok.access_token, 'tools/call', { name: 'run_sql' })).json()).error?.code === -32602);
  check('unknown method -> error', (await (await rpc(owner.tok.access_token, 'resources/list')).json()).error?.code === -32601);
  check('notification -> 202', (await mcpCall('', jsonPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: 'Bearer ' + owner.tok.access_token }))).status === 202);
  check('GET with a valid token -> 405', (await mcpCall('', { method: 'GET', headers: { Authorization: 'Bearer ' + owner.tok.access_token } })).status === 405);
  check('a refresh token is not an access token', await pingStatus(owner.tok.refresh_token) === 401);
  check('a one-time code is not an access token', await pingStatus(owner.code) === 401);
  check('a token in the address instead of the header is ignored', (await mcpCall('?access_token=' + owner.tok.access_token, jsonPost({ jsonrpc: '2.0', id: 1, method: 'ping' }))).status === 401);

  dbDown = true;
  check('database not answering -> 503, not "your token is dead"', await pingStatus(owner.tok.access_token) === 503);
  const rf = await refreshWith('claude', owner.tok.refresh_token);
  check('...and a refresh during the outage is not mistaken for theft', rf.status === 503);
  dbDown = false;
  check('afterwards the same token works and the connection is intact', await pingStatus(owner.tok.access_token) === 200 && !grantRow(grantOf(owner.tok.access_token)).revoked_at);

  // live checks on every call
  const flip = async (name, on, off) => { on(); const s = await pingStatus(mgr.tok.access_token); off(); check(name, s === 401, s); };
  await flip('manager suspended -> next call refused', () => { admin(MGR).status = 'suspended'; }, () => { admin(MGR).status = 'active'; });
  await flip('owner suspended -> the manager\'s calls refused too', () => { admin(OWNER).status = 'suspended'; }, () => { admin(OWNER).status = 'active'; });
  await flip('owner\'s switch off -> refused at once', () => { admin(OWNER).ai_apps_enabled = false; }, () => { admin(OWNER).ai_apps_enabled = true; });
  await flip('person made super admin -> refused', () => { admin(MGR).role = 'super_admin'; }, () => { admin(MGR).role = 'manager'; });
  await flip('temporary access ran out -> refused', () => { admin(MGR).expires_at = PAST; }, () => { admin(MGR).expires_at = null; });
  await flip('the owner\'s temporary access ran out -> refused', () => { admin(OWNER).expires_at = PAST; }, () => { admin(OWNER).expires_at = null; });
  check('back to normal -> works again', await pingStatus(mgr.tok.access_token) === 200);
  const big = await mcpCall('', jsonPost({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70000) }, { Authorization: 'Bearer ' + mgr.tok.access_token }));
  check('a connected app sending an oversized request -> 413', big.status === 413, big.status);

  // The plan, read on every tool call. A cancelled subscription puts the account back on Free (stripe-handler does
  // exactly that): from the next call on, no tool answers, for the owner and for everyone under them.
  const tool = async (access) => (await (await rpc(access, 'tools/call', { name: 'ping', arguments: {} })).json()).result;
  const refused = (r) => r?.isError === true && /Growth plan/.test(r.content[0].text) && !/pong|Acme|Olivia|@/.test(JSON.stringify(r));
  const answered = (r) => r?.isError === false && /^pong\./.test(r.content[0].text);
  check('Growth: the owner\'s and the manager\'s tools answer', answered(await tool(owner.tok.access_token)) && answered(await tool(mgr.tok.access_token)));
  for (const plan of ['free', 'starter']) {
    admin(OWNER).plan = plan;
    check(`owner now on ${plan} -> the owner's very next tool call gets the plan notice, no data`, refused(await tool(owner.tok.access_token)));
    check(`owner now on ${plan} -> same for the manager under them`, refused(await tool(mgr.tok.access_token)));
    check(`owner now on ${plan} -> same for the co-admin under them`, refused(await tool(co.tok.access_token)));
  }
  admin(OWNER).plan = 'business';
  check('subscribed again (Business) -> tools answer again, no reconnecting', answered(await tool(owner.tok.access_token)) && answered(await tool(mgr.tok.access_token)));
  admin(OWNER).plan = 'growth';
  planDown = true;
  check('plan cannot be read -> the answer is no', refused(await tool(owner.tok.access_token)));
  planDown = false;
  admin(MGR).plan = 'unlimited';   // a plan written on the manager's own row means nothing: the owner's plan decides
  admin(OWNER).plan = 'free';
  check('a plan on the manager\'s own row does not count', refused(await tool(mgr.tok.access_token)));
  admin(MGR).plan = 'free'; admin(OWNER).plan = 'growth';
  // grandfathered company on Free, and an ordinary Free account with a live connection
  admin(GF).ai_apps_enabled = true; admin(OTHER).ai_apps_enabled = true;
  const gfConn = await connect('claude', 'tokGf'), freeConn = await connect('claude', 'tokOther');
  check('grandfathered company on Free -> tools answer', gfConn.status === 200 && answered(await tool(gfConn.tok.access_token)));
  check('Free account -> may connect, every tool call gets the plan notice', freeConn.status === 200 && refused(await tool(freeConn.tok.access_token)));
  T.companies.find((c) => c.admin_id === GF).name = 'Some Other Co';
  check('...and the grandfathered company renamed -> no longer included', refused(await tool(gfConn.tok.access_token)));
  T.companies.find((c) => c.admin_id === GF).name = 'Oaziz Extracts';
  planDown = true;
  check('grandfathered company still answers while the plan lookup is down', answered(await tool(gfConn.tok.access_token)));
  planDown = false;
  for (const c of [gfConn, freeConn]) { const gid = grantOf(c.tok.access_token); T.mcp_tokens = T.mcp_tokens.filter((t) => t.grant_id !== gid); T.mcp_grants = T.mcp_grants.filter((x) => x.id !== gid); }
  admin(GF).ai_apps_enabled = false; admin(OTHER).ai_apps_enabled = false;

  // a connection marked cancelled whose tokens were, for whatever reason, not removed
  const cgr = grantRow(grantOf(co.tok.access_token));
  cgr.revoked_at = new Date().toISOString(); cgr.revoked_reason = 'support';
  check('cancelled connection with tokens still on file -> calls refused', await pingStatus(co.tok.access_token) === 401);
  const lateRefresh = await refreshWith('claude', co.tok.refresh_token);
  check('...and its refresh token is refused', lateRefresh.status === 400);
  cgr.revoked_at = null; cgr.revoked_reason = null;
  T.mcp_tokens.find((t) => t.token_hash === sha256hex(co.tok.refresh_token)).used_at = null;   // undo: that attempt marked it used

  const row = T.mcp_tokens.find((t) => t.token_hash === sha256hex(co.tok.access_token));
  const keep = row.expires_at; row.expires_at = PAST;
  check('expired access token -> 401', await pingStatus(co.tok.access_token) === 401);
  row.expires_at = keep;
  await new Promise((res) => setTimeout(res, 20));
  check('"last used" is recorded on the connection', !!grantRow(grantOf(owner.tok.access_token)).last_used_at);
}

out('\nRefresh: replaced on every use, reuse cancels the connection');
{
  const first = owner.tok;
  const r1 = await refreshWith('claude', first.refresh_token);
  check('refresh -> a new access token and a new refresh token', r1.status === 200 && r1.body.access_token !== first.access_token && r1.body.refresh_token !== first.refresh_token);
  check('new access token works', await pingStatus(r1.body.access_token) === 200);
  const r1b = await refreshWith('claude', first.refresh_token);
  check('the same refresh token again within seconds (the app racing itself) -> still served, nothing cancelled', r1b.status === 200 && !grantRow(grantOf(r1.body.access_token)).revoked_at);
  check('a ChatGPT client presenting Claude\'s refresh token -> refused', (await refreshWith('chatgpt', r1.body.refresh_token)).status === 400);
  check('an access token presented as a refresh token -> refused', (await refreshWith('claude', r1.body.access_token)).status === 400);
  check('...neither cancelled the connection', !grantRow(grantOf(r1.body.access_token)).revoked_at);

  // one minute later the old one comes back: theft
  const gid = grantOf(first.refresh_token);
  T.mcp_tokens.find((t) => t.token_hash === sha256hex(first.refresh_token)).used_at = new Date(Date.now() - 60_000).toISOString();
  const replay = await refreshWith('claude', first.refresh_token);
  check('an old refresh token coming back later -> refused', replay.status === 400 && replay.body.error === 'invalid_grant');
  check('...the whole connection is cancelled, reason "token_reuse"', grantRow(gid).revoked_reason === 'token_reuse' && !!grantRow(gid).revoked_at);
  check('...every token of it is gone', !T.mcp_tokens.some((t) => t.grant_id === gid));
  check('...the newest access token stops working', await pingStatus(r1.body.access_token) === 401);
  check('...the newest refresh token stops working', (await refreshWith('claude', r1b.body.refresh_token)).status === 400);
  await new Promise((res) => setTimeout(res, 10));
  check('...logged', T.audit_log.some((a) => a.event === 'mcp_token_reuse' && a.admin_id === OWNER));
  check('the co-admin\'s and the manager\'s connections are untouched', await pingStatus(co.tok.access_token) === 200 && await pingStatus(mgr.tok.access_token) === 200);

  // refresh re-checks the person
  const m1 = await refreshWith('chatgpt', mgr.tok.refresh_token);
  check('manager refresh (control)', m1.status === 200);
  const mg = grantOf(m1.body.access_token);
  admin(MGR).status = 'suspended';
  const m2 = await refreshWith('chatgpt', m1.body.refresh_token);
  admin(MGR).status = 'active';
  check('refresh by a suspended person -> refused and the connection cancelled ("deactivated")', m2.status === 400 && grantRow(mg).revoked_reason === 'deactivated' && !T.mcp_tokens.some((t) => t.grant_id === mg));
  check('...reactivating the person does not bring it back', await pingStatus(m1.body.access_token) === 401);

  const c1 = await refreshWith('claude', co.tok.refresh_token);
  const cg = grantOf(c1.body.access_token);
  T.mcp_tokens.find((t) => t.token_hash === sha256hex(c1.body.refresh_token)).expires_at = PAST;
  check('expired refresh token -> refused', (await refreshWith('claude', c1.body.refresh_token)).status === 400);
  check('...without cancelling the connection', !grantRow(cg).revoked_at);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nThe "AI apps" card: list and disconnect');
{
  owner = await connect('claude', 'tokOwner');
  mgr = await connect('chatgpt', 'tokMgr');
  admin(OTHER).ai_apps_enabled = true;
  const rival = await connect('claude', 'tokOther');
  const list = (sessionToken) => sdb({ action: 'mcp_list_grants', sessionToken });
  const revoke = (sessionToken, grant_id) => sdb({ action: 'mcp_revoke_grant', sessionToken, body: { grant_id } });
  const ownerG = grantOf(owner.tok.access_token), mgrG = grantOf(mgr.tok.access_token), rivalG = grantOf(rival.tok.access_token);

  check('not signed in -> 401', (await sdb({ action: 'mcp_list_grants' })).status === 401);
  let r = await list('tokOwner');
  const ids = r.body.grants.map((x) => x.id);
  check('owner sees every live connection on the account, with who and which app', r.status === 200 && r.body.is_owner && r.body.enabled && ids.includes(ownerG) && ids.includes(mgrG)
    && r.body.grants.find((x) => x.id === mgrG).person === 'Mia <b>Manager</b>' && r.body.grants.find((x) => x.id === mgrG).app === 'chatgpt' && r.body.grants.find((x) => x.id === ownerG).mine === true, JSON.stringify(r.body).slice(0, 300));
  check('...never another account\'s, never a cancelled one', !ids.includes(rivalG) && r.body.grants.every((x) => !grantRow(x.id).revoked_at));
  check('...and the address to paste', r.body.url === RESOURCE);
  check('...no token, hash or e-mail in the answer', !/pcc_|[0-9a-f]{64}|@example\.test|admin_id/.test(JSON.stringify(r.body)));
  r = await list('tokMgr');
  check('manager sees only their own', r.body.grants.length === 1 && r.body.grants[0].id === mgrG && r.body.is_owner === false && r.body.enabled === true);
  r = await list('tokCo');
  check('co-admin sees only their own', r.body.grants.every((x) => x.mine) && !r.body.grants.some((x) => x.id === ownerG || x.id === mgrG));
  r = await list('tokSuper');
  check('super admin: nothing', r.body.refused === 'super_admin' && r.body.grants.length === 0);

  check('malformed connection id -> 400', (await revoke('tokOwner', "x' or '1'='1")).status === 400);
  check('manager cannot disconnect the owner -> 404', (await revoke('tokMgr', ownerG)).status === 404 && !grantRow(ownerG).revoked_at);
  check('co-admin cannot disconnect the manager -> 404', (await revoke('tokCo', mgrG)).status === 404 && !grantRow(mgrG).revoked_at);
  check('another account\'s owner cannot disconnect ours -> 404', (await revoke('tokOther', ownerG)).status === 404 && !grantRow(ownerG).revoked_at);
  check('our owner cannot disconnect another account\'s -> 404', (await revoke('tokOwner', rivalG)).status === 404 && !grantRow(rivalG).revoked_at);
  check('super admin cannot either -> 404', (await revoke('tokSuper', ownerG)).status === 404 && !grantRow(ownerG).revoked_at);
  check('unknown id -> the same 404', (await revoke('tokOwner', randomUUID())).status === 404);

  r = await revoke('tokOwner', mgrG);
  check('owner disconnects the manager -> cancelled ("owner"), tokens gone, next call refused', r.status === 200 && grantRow(mgrG).revoked_reason === 'owner'
    && !T.mcp_tokens.some((t) => t.grant_id === mgrG) && await pingStatus(mgr.tok.access_token) === 401 && (await refreshWith('chatgpt', mgr.tok.refresh_token)).status === 400);
  check('disconnecting it again -> 404', (await revoke('tokOwner', mgrG)).status === 404);
  r = await revoke('tokOwner', ownerG);
  check('owner disconnects themselves -> "user"', r.status === 200 && grantRow(ownerG).revoked_reason === 'user' && await pingStatus(owner.tok.access_token) === 401);
  check('the other account is untouched by all of it', await pingStatus(rival.tok.access_token) === 200);

  // Disconnect pressed inside the app
  const again = await connect('claude', 'tokOwner');
  const ag = grantOf(again.tok.access_token);
  check('revoke endpoint with the access token -> connection cancelled', (await mcpCall('/revoke', form({ token: again.tok.access_token }))).status === 200 && grantRow(ag).revoked_reason === 'user'
    && await pingStatus(again.tok.access_token) === 401 && (await refreshWith('claude', again.tok.refresh_token)).status === 400);
}

out('\nSwitching "Allow AI apps" off cancels the whole account');
{
  const o = await connect('claude', 'tokOwner'), m = await connect('chatgpt', 'tokMgr'), c = await connect('claude', 'tokCo');
  const rival = await connect('chatgpt', 'tokOther');
  // a sign-in that is half way through
  const { verifier, challenge } = pkce();
  const { request } = await startSignIn('claude', challenge);
  const half = await sdb({ action: 'mcp_consent', sessionToken: 'tokCo', body: { request, decision: 'allow' } });
  const halfCode = new URL(half.body.redirect).searchParams.get('code');
  secrets.add(halfCode);
  check('(before) all three have a live connection', [OWNER, MGR, COADMIN].every((a) => liveGrants(a).length >= 1));

  const r = await sdb({ action: 'set_ai_apps', sessionToken: 'tokOwner', body: { enabled: false } });
  const acct = [OWNER, COADMIN, MGR];
  check('owner switches it off', r.status === 200 && r.body.enabled === false && r.body.cancelled >= 3 && admin(OWNER).ai_apps_enabled === false, JSON.stringify(r.body));
  check('every connection of owner, co-admin and manager is cancelled', acct.every((a) => liveGrants(a).length === 0));
  check('...with the reason "ai_apps_off"', acct.every((a) => T.mcp_grants.some((x) => x.admin_id === a && x.revoked_reason === 'ai_apps_off')));
  check('none of their tokens is left', !T.mcp_tokens.some((t) => acct.includes(grantRow(t.grant_id)?.admin_id)));
  check('calls and refreshes are refused', await pingStatus(o.tok.access_token) === 401 && await pingStatus(m.tok.access_token) === 401 && (await refreshWith('claude', c.tok.refresh_token)).status === 400);
  const late = await mcpCall('/token', form({ grant_type: 'authorization_code', code: halfCode, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id: CLAUDE_ID }));
  check('the half-finished sign-in cannot complete', late.status === 400 && !T.mcp_auth_codes.some((x) => x.code_hash === sha256hex(halfCode)));
  check('the other account keeps working', await pingStatus(rival.tok.access_token) === 200 && liveGrants(OTHER).length >= 1);
  check('logged', T.audit_log.some((a) => a.event === 'ai_apps_off' && a.admin_id === OWNER));
  await sdb({ action: 'set_ai_apps', sessionToken: 'tokOwner', body: { enabled: true } });
  check('switching it back on does not revive anything', await pingStatus(o.tok.access_token) === 401 && (await refreshWith('claude', o.tok.refresh_token)).status === 400 && liveGrants(OWNER).length === 0);
}

out('\nHousekeeping');
{
  const made = [];
  for (let i = 0; i < 4; i++) {
    made.push(await connect('claude', 'tokOwner'));
    // spread the creation times so "oldest" is unambiguous
    grantRow(grantOf(made[i].tok.access_token)).created_at = new Date(Date.now() - (10 - i) * 60_000).toISOString();
  }
  const fifth = await connect('claude', 'tokOwner');
  const live = liveGrants(OWNER).filter((x) => x.client === 'claude');
  check('beyond three live connections per person and app, the oldest are cancelled', live.length === 3 && await pingStatus(fifth.tok.access_token) === 200
    && await pingStatus(made[0].tok.access_token) === 401 && await pingStatus(made[3].tok.access_token) === 200, live.length);
  const other = await connect('chatgpt', 'tokOwner');
  check('the limit is per app: ChatGPT is not counted with Claude', other.status === 200 && liveGrants(OWNER).filter((x) => x.client === 'claude').length === 3);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
out('\nNothing secret is stored or logged');
{
  await new Promise((res) => setTimeout(res, 20));
  secrets.delete(null); secrets.delete(undefined);
  const stored = JSON.stringify(T);
  const logged = logLines.join('\n');
  const calls = dbLog.join('\n');
  const leaks = (hay) => [...secrets].filter((s) => hay.includes(s)).length;
  check(`${secrets.size} codes and tokens were handed out during this run`, secrets.size > 40, secrets.size);
  check('none of them is in the database (hashes only)', leaks(stored) === 0);
  check('none of them is in the function logs', leaks(logged) === 0 && logLines.length > 50);
  check('none of them is in a database address (they travel as hashes)', leaks(calls) === 0);
  check('every stored token and code is a 64-character hash', T.mcp_tokens.length > 0 && T.mcp_tokens.every((t) => HEX64.test(t.token_hash)) && T.mcp_auth_codes.every((c) => HEX64.test(c.code_hash)));
  const mcpSide = JSON.stringify([T.mcp_grants, T.mcp_tokens, T.mcp_auth_codes, T.audit_log]);
  check('no website session token ever reached the mcp tables or the logs', !/tok(Owner|Mgr|Co|Other|Super|Gf)/.test(mcpSide) && !/tok(Owner|Mgr|Co|Other|Super|Gf)/.test(logged));
  check('the logs carry no state value, verifier or challenge', !/st-123/.test(logged) && !/code_challenge=|code_verifier=/.test(logged));
  check('the audit log carries events and reasons only (no names, no addresses)', T.audit_log.length > 20 && T.audit_log.every((a) => !/@|Acme|Olivia|Mia|https?:/.test(JSON.stringify([a.event, a.table_name, a.filter]))));
}

out(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
