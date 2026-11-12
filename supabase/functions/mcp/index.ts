// mcp — Supabase Edge Function. JWT verification: OFF (the OAuth checks below are the gate).
//
// THE AI CONNECTOR: sign-in service + MCP server for Claude and ChatGPT.
// A person adds this address in Claude or ChatGPT, is sent to www.punchclock.ca/connect.html, signs in there and
// allows read-only access. From then on the app holds tokens that this function checks on every call.
//
// Who is who
//   - This function never sees a PunchClock password or a website session token. The consent page talks to
//     secure-db, which checks the signed-in person and writes a one-time code (hash only) for this function to redeem.
//   - Identity on every call comes from the access token (looked up by its hash) -> connection -> person. Nothing the
//     AI sends can choose an account.
//
// Rules that hold everywhere below
//   - A sign-in code is only ever sent to Claude's or ChatGPT's own callback address.
//   - PKCE S256 is required; an empty or missing verifier is refused before anything else is looked at.
//   - Codes are single use (60 s). Refresh tokens are replaced on every use; an old one coming back later cancels
//     the whole connection.
//   - Tokens and codes are random, stored only as sha-256 hashes, and never logged.
//   - Checked live on every call and every refresh: the connection is not cancelled, the person is still active,
//     is not the super admin, and the account owner's "Allow AI apps" switch is still on.
//
// Tools: only `ping` for now. The data tools (who is clocked in, hours, time off, schedule) arrive in later steps.

const g = globalThis as any;
const env = (k: string): string => (g.Deno ? g.Deno.env.get(k) : g.process?.env?.[k]) || '';

const BASE = env('SUPABASE_URL').replace(/\/+$/, '');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const RESOURCE = `${BASE}/functions/v1/mcp`;   // the address a person pastes into Claude or ChatGPT
const ISSUER = RESOURCE;                       // the sign-in service lives under the same address
const CONNECT_URL = 'https://www.punchclock.ca/connect.html';   // the consent page (our own site, fixed)

const SCOPE = 'punchclock.read';
const REQUEST_TTL_S = 600;            // how long a person has to sign in and press Allow
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const REFRESH_GRACE_MS = 30_000;      // ChatGPT refreshes twice within seconds of connecting: not theft
const LIVE_GRANTS_PER_APP = 3;        // per person and app; older connections are cancelled when a new one is made
const LAST_USED_EVERY_MS = 5 * 60_000;
const MAX_BODY = 65536;
const MAX_STATE = 2000;

// The two apps. A client is recognised by the host of the address it publishes about itself (its Client ID Metadata
// Document, never fetched here); the callback allowlist is the real guard.
type App = 'claude' | 'chatgpt';
const APP_HOSTS: Record<string, App> = { 'claude.ai': 'claude', 'claude.com': 'claude', 'chatgpt.com': 'chatgpt' };
const REDIRECTS: Record<App, (u: string) => boolean> = {
  claude: (u) => u === 'https://claude.ai/api/mcp/auth_callback' || u === 'https://claude.com/api/mcp/auth_callback',
  chatgpt: (u) => u === 'https://chatgpt.com/connector_platform_oauth_redirect'
    || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(u),
};
function appOfClient(id: unknown): App | null {
  if (typeof id !== 'string' || id.length > 300) return null;
  try {
    const u = new URL(id);
    if (u.protocol !== 'https:' || u.port || u.hash || u.username || u.password || u.pathname === '/') return null;
    return APP_HOSTS[u.hostname] ?? null;
  } catch { return null; }
}
const redirectAllowed = (app: App, u: unknown): u is string => typeof u === 'string' && u.length <= 400 && REDIRECTS[app](u);

// Both apps call from their servers, with no Origin header. A browser page on another site is refused.
const ORIGINS = new Set(['https://claude.ai', 'https://claude.com', 'https://chatgpt.com']);

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const SECRET_RE = { code: /^pcc_ac_[A-Za-z0-9_-]{43}$/, access: /^pcc_at_[A-Za-z0-9_-]{43}$/, refresh: /^pcc_rt_[A-Za-z0-9_-]{43}$/ };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ── small helpers ────────────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function sha256hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}
const newSecret = (prefix: string): string => prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));
const nowIso = (plusMs = 0): string => new Date(Date.now() + plusMs).toISOString();

// The sign-in request that travels through the person's browser to the consent page and on to secure-db: a signed
// value "<payload>.<signature>", so anonymous visitors never write to the database and nobody can alter where the
// code will be sent. secure-db verifies it with the same key (derived from the service key, which only the two
// functions hold).
let _keyP: Promise<CryptoKey> | null = null;
function requestKey(): Promise<CryptoKey> {
  if (!_keyP) {
    _keyP = crypto.subtle.importKey('raw', enc.encode('mcp-connector-v1:' + SERVICE_KEY),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return _keyP;
}
async function sealRequest(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + REQUEST_TTL_S })));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await requestKey(), enc.encode(`req.${body}`))));
  return `${body}.${sig}`;
}

const sameResource = (v: string): boolean => v.replace(/\/+$/, '') === RESOURCE;

const NO_STORE = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };
function json(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function text(msg: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}
const oauthErr = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status, NO_STORE);

// One line per event in the function log. Never a code, token, verifier or state value.
function log(ev: string, req: Request, extra: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ mcp: ev, ua: (req.headers.get('user-agent') || '').slice(0, 80), ...extra }));
  } catch { /* logging must never break a request */ }
}
function describeUrl(u: unknown): string {
  try { const x = new URL(String(u)); return (x.origin + x.pathname).slice(0, 160); } catch { return 'unparseable'; }
}
function background(job: Promise<unknown>): void {
  const quiet = job.then(() => {}).catch(() => {});
  if (typeof g.EdgeRuntime !== 'undefined') g.EdgeRuntime.waitUntil(quiet);
}

// At most MAX_BODY bytes are kept. A larger upload is refused (null), but it is still read to the end and thrown away
// (up to DRAIN_MAX, then cut) before the answer goes out: answering while the upload was still in flight made the gateway
// time out now and then (a 504 instead of the 413). Nothing of an oversized upload is kept in memory.
const DRAIN_MAX = 1048576;
async function readBody(req: Request): Promise<string | null> {
  let tooBig = Number(req.headers.get('content-length') || '0') > MAX_BODY;
  const reader = req.body ? req.body.getReader() : null;
  if (!reader) return tooBig ? null : '';
  let chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { tooBig = true; chunks = []; }
      if (size > DRAIN_MAX) { await reader.cancel().catch(() => {}); break; }
      if (!tooBig) chunks.push(value);
    }
  } catch { return null; }
  if (tooBig) return null;
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  return dec.decode(buf);
}
// The same for answers that never look at the upload (the 401 that starts sign-in, a 404, a 405): what was sent is read
// and thrown away first, cut off after DRAIN_MAX.
async function drain(req: Request): Promise<void> {
  try {
    if (!req.body || req.bodyUsed) return;
    const reader = req.body.getReader();
    for (let size = 0;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > DRAIN_MAX) { await reader.cancel().catch(() => {}); return; }
    }
  } catch { /* the answer goes out anyway */ }
}

// ── database (service key; these tables are closed to everyone else) ─────────────────────────
interface DbResult { ok: boolean; rows: any[] }
async function db(method: string, path: string, body?: unknown, wantRows = false): Promise<DbResult> {
  try {
    const r = await fetch(`${BASE}/rest/v1/${path}`, {
      method,
      headers: {
        'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'Prefer': wantRows ? 'return=representation' : 'return=minimal' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) return { ok: false, rows: [] };
    if (method !== 'GET' && !wantRows) return { ok: true, rows: [] };
    const j = await r.json().catch(() => null);
    return { ok: Array.isArray(j), rows: Array.isArray(j) ? j : [] };
  } catch { return { ok: false, rows: [] }; }
}
const q = (v: string): string => encodeURIComponent(v);

// Connection events (made, refused, cancelled, token reuse) go to audit_log: ids and reasons only.
function audit(adminId: string | null, event: string, detail: string): void {
  background(db('POST', 'audit_log', { admin_id: adminId, event, table_name: 'mcp_grants', method: null, filter: detail }));
}

// Is this person still allowed to use a connection, right now?
type Refusal = 'gone' | 'deactivated' | 'super_admin' | 'ai_apps_off' | 'error';
async function personState(adminId: string): Promise<{ ok: true; ownerId: string } | { ok: false; why: Refusal }> {
  if (!UUID_RE.test(adminId)) return { ok: false, why: 'gone' };
  // Temporary accounts carry an end date (expires_at). The website only checks it when signing in; here it counts on every call.
  const lapsed = (row: any): boolean => !!row.expires_at && !(new Date(row.expires_at).getTime() > Date.now());
  const me = await db('GET', `admins?id=eq.${adminId}&select=id,parent_admin_id,role,status,expires_at&limit=1`);
  if (!me.ok) return { ok: false, why: 'error' };
  const a = me.rows[0];
  if (!a) return { ok: false, why: 'gone' };
  if (a.status !== 'active' || lapsed(a)) return { ok: false, why: 'deactivated' };
  if (a.role === 'super_admin') return { ok: false, why: 'super_admin' };
  const ownerId: string = a.parent_admin_id || a.id;
  if (!UUID_RE.test(ownerId)) return { ok: false, why: 'gone' };
  const ow = await db('GET', `admins?id=eq.${ownerId}&select=id,role,status,expires_at,ai_apps_enabled&limit=1`);
  if (!ow.ok) return { ok: false, why: 'error' };
  const o = ow.rows[0];
  if (!o || o.status !== 'active' || lapsed(o)) return { ok: false, why: 'deactivated' };
  if (o.role === 'super_admin') return { ok: false, why: 'super_admin' };
  if (o.ai_apps_enabled !== true) return { ok: false, why: 'ai_apps_off' };
  return { ok: true, ownerId };
}
const REVOKE_REASON: Record<Refusal, string | null> = {
  gone: null, error: null, deactivated: 'deactivated', super_admin: 'support', ai_apps_off: 'ai_apps_off',
};

async function revokeGrant(grantId: string, reason: string): Promise<void> {
  await db('PATCH', `mcp_grants?id=eq.${grantId}&revoked_at=is.null`, { revoked_at: nowIso(), revoked_reason: reason });
  await db('DELETE', `mcp_tokens?grant_id=eq.${grantId}`);
}

async function issueTokens(grantId: string): Promise<Response> {
  const access = newSecret('pcc_at_'), refresh = newSecret('pcc_rt_');
  const ins = await db('POST', 'mcp_tokens', [
    { token_hash: await sha256hex(access), grant_id: grantId, kind: 'access', expires_at: nowIso(ACCESS_TTL_S * 1000) },
    { token_hash: await sha256hex(refresh), grant_id: grantId, kind: 'refresh', expires_at: nowIso(REFRESH_TTL_S * 1000) },
  ]);
  if (!ins.ok) return oauthErr('server_error', 'Please try again', 503);
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }, 200, NO_STORE);
}

// ── discovery documents ──────────────────────────────────────────────────────────────────────
const resourceMetadata = () => ({
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'PunchClock Crew',
});
const serverMetadata = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  revocation_endpoint: `${ISSUER}/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [SCOPE],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
});
const challenge = () => ({
  'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
});

// ── sign-in service ──────────────────────────────────────────────────────────────────────────
// Step 1 of signing in: check the request, then hand the person to the consent page with a signed copy of it.
// Nothing is written and nobody is approved here.
async function authorize(req: Request, url: URL): Promise<Response> {
  const p = url.searchParams;
  const clientId = p.get('client_id');
  const redirectUri = p.get('redirect_uri');
  const app = appOfClient(clientId);
  log('authorize', req, {
    app, redirect_uri: describeUrl(redirectUri), redirect_ok: !!app && redirectAllowed(app, redirectUri),
    has_resource: p.has('resource'), challenge_method: (p.get('code_challenge_method') || '').slice(0, 10), has_state: p.has('state'),
  });
  // Until the app and its callback are both known good, the person is never sent anywhere.
  if (!app) return text('Unknown app. Nothing was connected.', 400);
  if (!redirectAllowed(app, redirectUri)) return text('That return address is not allowed. Nothing was connected.', 400);

  const state = p.get('state');
  const fail = (error: string, d: string): Response => {
    const to = new URL(redirectUri);
    to.searchParams.set('error', error);
    to.searchParams.set('error_description', d);
    if (state !== null) to.searchParams.set('state', state);
    to.searchParams.set('iss', ISSUER);
    return new Response(null, { status: 302, headers: { Location: to.toString(), ...NO_STORE } });
  };
  if (state !== null && state.length > MAX_STATE) return text('That request is too large. Nothing was connected.', 400);
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code');
  const codeChallenge = p.get('code_challenge') || '';
  if (p.get('code_challenge_method') !== 'S256' || !CHALLENGE_RE.test(codeChallenge)) {
    return fail('invalid_request', 'PKCE with S256 is required');
  }
  const resource = p.get('resource');
  if (resource !== null && !sameResource(resource)) return fail('invalid_target', 'Unknown resource');

  const request = await sealRequest({ c: app, r: redirectUri, ch: codeChallenge, s: state });
  // In the fragment, so the request is not sent to (or logged by) the web host that serves the page.
  return new Response(null, { status: 302, headers: { Location: `${CONNECT_URL}#r=${request}`, ...NO_STORE } });
}

async function token(req: Request): Promise<Response> {
  const raw = await readBody(req);
  if (raw === null) return oauthErr('invalid_request', 'Request too large', 413);
  const p = new URLSearchParams(raw);
  const grant = p.get('grant_type');
  const app = appOfClient(p.get('client_id'));
  log('token', req, { grant: (grant || '').slice(0, 30), app, has_resource: p.has('resource') });
  if (!app) return oauthErr('invalid_client', 'Unknown client', 401);
  const resource = p.get('resource');
  if (resource !== null && !sameResource(resource)) return oauthErr('invalid_target', 'Unknown resource');

  if (grant === 'authorization_code') {
    const badCode = () => oauthErr('invalid_grant', 'The code is invalid or has expired');
    const verifier = p.get('code_verifier');
    // Refused before anything else is looked at: no verifier, or an empty one, is never "close enough".
    if (!verifier || !VERIFIER_RE.test(verifier)) return oauthErr('invalid_request', 'code_verifier is required');
    const code = p.get('code') || '';
    if (!SECRET_RE.code.test(code)) return badCode();
    // Single use: this update matches the row only once. Whoever presents a code uses it up, right or wrong.
    const used = await db('PATCH',
      `mcp_auth_codes?code_hash=eq.${await sha256hex(code)}&used_at=is.null&expires_at=gt.${q(nowIso())}`,
      { used_at: nowIso() }, true);
    const row = used.rows[0];
    if (!used.ok || !row) return badCode();
    if (row.client !== app || row.redirect_uri !== p.get('redirect_uri')
      || typeof row.code_challenge !== 'string' || !safeEq(await s256(verifier), row.code_challenge)) {
      log('code_refused', req, { app });
      return badCode();
    }
    const adminId = String(row.admin_id || '');
    const who = await personState(adminId);
    if (!who.ok) {
      audit(who.why === 'gone' ? null : adminId, 'mcp_connect_refused', `${app}:${who.why}`);
      return badCode();
    }
    const made = await db('POST', 'mcp_grants', { admin_id: adminId, client: app }, true);
    const grantId = made.rows[0]?.id;
    if (!made.ok || typeof grantId !== 'string' || !UUID_RE.test(grantId)) return oauthErr('server_error', 'Please try again', 503);
    // Keep the list short: beyond the newest few connections of this person with this app, older ones are cancelled.
    const old = await db('GET',
      `mcp_grants?admin_id=eq.${adminId}&client=eq.${app}&revoked_at=is.null&select=id&order=created_at.desc&offset=${LIVE_GRANTS_PER_APP}&limit=50`);
    for (const o of old.rows) if (typeof o.id === 'string' && UUID_RE.test(o.id) && o.id !== grantId) await revokeGrant(o.id, 'user');
    audit(adminId, 'mcp_connected', app);
    return await issueTokens(grantId);
  }

  if (grant === 'refresh_token') {
    const bad = () => oauthErr('invalid_grant', 'The refresh token is invalid or has expired');
    const rt = p.get('refresh_token') || '';
    if (!SECRET_RE.refresh.test(rt)) return bad();
    const hash = await sha256hex(rt);
    // Replaced on every use: this update matches a refresh token only the first time it is presented.
    const first = await db('PATCH',
      `mcp_tokens?token_hash=eq.${hash}&kind=eq.refresh&used_at=is.null&expires_at=gt.${q(nowIso())}`,
      { used_at: nowIso() }, true);
    if (!first.ok) return oauthErr('server_error', 'Please try again', 503);
    let grantId: string | null = first.rows[0]?.grant_id ?? null;
    if (!grantId) {
      const seen = await db('GET', `mcp_tokens?token_hash=eq.${hash}&kind=eq.refresh&select=grant_id,used_at,expires_at&limit=1`);
      const t = seen.rows[0];
      if (!t || !t.used_at || new Date(t.expires_at).getTime() <= Date.now()) return bad();
      if (Date.now() - new Date(t.used_at).getTime() > REFRESH_GRACE_MS) {
        // An already-replaced refresh token came back: either it was stolen or the app's copy was. Cancel everything.
        if (typeof t.grant_id === 'string' && UUID_RE.test(t.grant_id)) {
          const gr = await db('GET', `mcp_grants?id=eq.${t.grant_id}&select=admin_id,revoked_at&limit=1`);
          if (gr.rows[0] && !gr.rows[0].revoked_at) {
            await revokeGrant(t.grant_id, 'token_reuse');
            audit(gr.rows[0].admin_id ?? null, 'mcp_token_reuse', app);
          }
        }
        log('refresh_reuse', req, { app });
        return bad();
      }
      grantId = t.grant_id;   // the same token twice within a few seconds: the app racing itself
    }
    if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) return bad();
    const gr = await db('GET', `mcp_grants?id=eq.${grantId}&revoked_at=is.null&select=id,admin_id,client&limit=1`);
    const grantRow = gr.rows[0];
    if (!gr.ok || !grantRow || grantRow.client !== app) return bad();
    const who = await personState(String(grantRow.admin_id || ''));
    if (!who.ok) {
      if (who.why === 'error') return oauthErr('server_error', 'Please try again', 503);
      const reason = REVOKE_REASON[who.why];
      if (reason) { await revokeGrant(grantId, reason); audit(grantRow.admin_id ?? null, 'mcp_grant_revoked', `${app}:${reason}`); }
      return bad();
    }
    return await issueTokens(grantId);
  }
  return oauthErr('unsupported_grant_type', 'Only authorization_code and refresh_token');
}

// "Disconnect" pressed inside Claude or ChatGPT. Whoever holds one of a connection's tokens may cancel that
// connection; the answer is the same whether or not the token was known.
async function revoke(req: Request): Promise<Response> {
  const raw = await readBody(req);
  if (raw === null) return oauthErr('invalid_request', 'Request too large', 413);
  const p = new URLSearchParams(raw);
  const tok = p.get('token') || '';
  const kind = SECRET_RE.refresh.test(tok) ? 'refresh' : SECRET_RE.access.test(tok) ? 'access' : null;
  log('revoke', req, { kind });
  if (kind) {
    const t = await db('GET', `mcp_tokens?token_hash=eq.${await sha256hex(tok)}&kind=eq.${kind}&select=grant_id&limit=1`);
    const grantId = t.rows[0]?.grant_id;
    if (typeof grantId === 'string' && UUID_RE.test(grantId)) {
      const gr = await db('GET', `mcp_grants?id=eq.${grantId}&revoked_at=is.null&select=admin_id,client&limit=1`);
      if (gr.rows[0]) {
        await revokeGrant(grantId, 'user');
        audit(gr.rows[0].admin_id ?? null, 'mcp_grant_revoked', `${gr.rows[0].client}:user`);
      }
    }
  }
  return json({}, 200, NO_STORE);
}

// ── the MCP server ───────────────────────────────────────────────────────────────────────────
interface Session { grantId: string; adminId: string; ownerId: string; app: string }
// 'unavailable' (the database could not be asked) is kept apart from "no": a hiccup must not make the app think its
// token is dead and send the person through sign-in again.
async function authenticate(req: Request): Promise<Session | 'unavailable' | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '');
  if (!m || !SECRET_RE.access.test(m[1])) return null;
  const t = await db('GET',
    `mcp_tokens?token_hash=eq.${await sha256hex(m[1])}&kind=eq.access&expires_at=gt.${q(nowIso())}&select=grant_id&limit=1`);
  if (!t.ok) return 'unavailable';
  const grantId = t.rows[0]?.grant_id;
  if (typeof grantId !== 'string' || !UUID_RE.test(grantId)) return null;
  const gr = await db('GET', `mcp_grants?id=eq.${grantId}&revoked_at=is.null&select=id,admin_id,client,last_used_at&limit=1`);
  if (!gr.ok) return 'unavailable';
  const grantRow = gr.rows[0];
  if (!grantRow) return null;
  const who = await personState(String(grantRow.admin_id || ''));
  if (!who.ok) return who.why === 'error' ? 'unavailable' : null;
  const last = grantRow.last_used_at ? new Date(grantRow.last_used_at).getTime() : 0;
  if (Date.now() - last > LAST_USED_EVERY_MS) background(db('PATCH', `mcp_grants?id=eq.${grantId}`, { last_used_at: nowIso() }));
  return { grantId, adminId: grantRow.admin_id, ownerId: who.ownerId, app: grantRow.client };
}

// AI apps are part of the Growth plan and up (or a grandfathered company: same list as secure-db). The owner's plan is
// read on EVERY tool call and never remembered: the moment a subscription ends (the account goes back to Free) or
// drops below Growth, tools stop answering, with no need to cancel anything. If the plan cannot be read, the answer
// is "no". Every tool goes through this, so a tool added later cannot forget it.
const GRANDFATHERED_COMPANIES = ['Oaziz Extracts', 'Connoisseur Culture'];
const PLAN_NOTICE = 'AI apps are part of the PunchClock Crew Growth plan and up. This account is not on such a plan right now, '
  + 'so no data is available here. The account owner can change the plan at https://www.punchclock.ca/#pricing.';
async function planIncluded(ownerId: string): Promise<boolean> {
  if (!UUID_RE.test(ownerId)) return false;
  try {
    const r = await fetch(`${BASE}/rest/v1/rpc/admin_plan_rank`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_admin: ownerId }),
    });
    const rank = r.ok ? await r.json().catch(() => null) : null;
    if (typeof rank === 'number' && rank >= 2) return true;
  } catch { /* not answered: only a grandfathered company can still say yes */ }
  const cos = await db('GET', `companies?admin_id=eq.${ownerId}&select=name&limit=500`);
  return cos.ok && cos.rows.some((c) => GRANDFATHERED_COMPANIES.includes(String(c.name)));
}

const TOOLS = [{
  name: 'ping',
  title: 'Connection check',
  description: 'Checks that PunchClock Crew is connected. Returns a fixed sentence. It reads no account data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Connection check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

async function mcp(req: Request): Promise<Response> {
  // Every request needs a valid token, including the first one: the 401 is what starts sign-in in both apps.
  const session = await authenticate(req);
  if (session === 'unavailable') return text('Temporarily unavailable', 503, { 'Retry-After': '5' });
  if (!session) {
    log('mcp_401', req, { method: req.method, had_token: !!req.headers.get('authorization') });
    return json({ error: 'unauthorized' }, 401, challenge());
  }
  if (req.method !== 'POST') return text('Method not allowed', 405, { Allow: 'POST' });

  const raw = await readBody(req);
  if (raw === null) return text('Request too large', 413);
  let msg: any;
  try { msg = JSON.parse(raw); } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
  }
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
  log('mcp_call', req, { rpc: msg.method.slice(0, 40), app: session.app });
  if (!hasId) return new Response(null, { status: 202 });   // a notification: nothing to answer

  const reply = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code: number, message: string) => json({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'punchclock-crew', title: 'PunchClock Crew', version: '0.1.0' },
        instructions: 'PunchClock Crew, read-only. This version only confirms the connection; the tools for hours, time off and schedules are not available yet.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      if (msg.params?.name !== 'ping') return error(-32602, 'Unknown tool');
      if (!(await planIncluded(session.ownerId))) {
        log('mcp_plan_refused', req, { app: session.app });
        return reply({ content: [{ type: 'text', text: PLAN_NOTICE }], isError: true });
      }
      return reply({
        content: [{ type: 'text', text: 'pong. PunchClock Crew is connected. The tools for hours, time off and schedules are not available yet.' }],
        isError: false,
      });
    default:
      return error(-32601, 'Method not found');
  }
}

// ── router ───────────────────────────────────────────────────────────────────────────────────
export async function handler(req: Request): Promise<Response> {
  const res = await route(req);
  await drain(req);
  return res;
}
async function route(req: Request): Promise<Response> {
  try {
    if (!BASE || !SERVICE_KEY) return text('Not configured', 500);
    const url = new URL(req.url);
    // Inside the function the path starts with /mcp (the gateway strips /functions/v1).
    const sub = url.pathname.replace(/^.*?\/mcp(?=\/|$)/, '').replace(/\/+$/, '');
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204 });   // no CORS: browsers on other sites get nothing
    const origin = req.headers.get('origin');
    if (method !== 'GET' && origin && !ORIGINS.has(origin)) {
      log('origin_refused', req, { origin: describeUrl(origin) });
      return text('Forbidden', 403);
    }

    if (sub === '/.well-known/oauth-protected-resource' && method === 'GET') {
      return json(resourceMetadata(), 200, { 'Cache-Control': 'public, max-age=300' });
    }
    if ((sub === '/.well-known/oauth-authorization-server' || sub === '/.well-known/openid-configuration') && method === 'GET') {
      return json(serverMetadata(), 200, { 'Cache-Control': 'public, max-age=300' });
    }
    if (sub === '/authorize') return method === 'GET' ? await authorize(req, url) : text('Method not allowed', 405, { Allow: 'GET' });
    if (sub === '/token') return method === 'POST' ? await token(req) : text('Method not allowed', 405, { Allow: 'POST' });
    if (sub === '/revoke') return method === 'POST' ? await revoke(req) : text('Method not allowed', 405, { Allow: 'POST' });
    if (sub === '') return await mcp(req);
    return text('Not found', 404);
  } catch {
    return text('Internal error', 500);
  }
}

if (g.Deno) g.Deno.serve(handler);
