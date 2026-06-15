// secure-db — Supabase Edge Function
// Proxies DB reads through server-side session verification.
// JWT verification: OFF (custom auth logic below)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  'https://www.punchclock.ca',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

const PROTECTED_TABLES = new Set([
  'admins', 'punches', 'employees', 'companies', 'sites',
  'invitations', 'manager_sites', 'missed_punch_requests', 'join_requests',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function errResp(msg: string, status = 500): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Verify admin session exists and is active/pending_invite
async function verifySession(sessionId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?id=eq.${sessionId}&status=in.(active,pending_invite)&select=id&limit=1`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Verify kiosk site ID exists in the sites table
async function verifySite(siteId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sites?id=eq.${siteId}&select=id&limit=1`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Resolve the caller's admin id from an opaque session token (admin_sessions) that is
// unexpired and whose admin is active/pending_invite. Token-only — the legacy "sessionId =
// admin.id" credential is no longer accepted (sessionId is ignored).
async function resolveAdminId(sessionToken: string | null): Promise<string | null> {
  if (!sessionToken) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${sessionToken}&select=admin_id,expires_at&limit=1`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (res.ok) {
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && new Date(row.expires_at) > new Date() && await verifySession(row.admin_id)) {
      return row.admin_id as string;
    }
  }
  return null;
}

// Pre-auth: single equality lookup with no compound conditions.
// Covers login (email=eq.), invite acceptance (token=eq.), and
// specific-id lookups (id=eq.) needed before a session exists.
function isPreAuthAllowed(table: string, filter: string): boolean {
  if (!filter || !filter.includes('=eq.')) return false;
  // Strip select= projections and verified=eq.true before checking for compound conditions
  const parts = filter.split('&').filter(p =>
    !p.startsWith('select=') && p !== 'verified=eq.true'
  );
  if (parts.length !== 1) return false;
  const condition = parts[0];
  if (table === 'admins')      return condition.startsWith('email=eq.') || condition.startsWith('id=eq.');
  if (table === 'invitations') return condition.startsWith('token=eq.');
  return false;
}

// Strip sensitive admin fields. Password is always removed.
// Stripe fields are kept only when the admin is fetching their own record.
function stripAdminRows(rows: unknown[], sessionId: string | null, filter: string): unknown[] {
  const isSelf = !!sessionId && filter.includes(`id=eq.${sessionId}`);
  return rows.map(row => {
    if (typeof row !== 'object' || row === null) return row;
    const r = { ...(row as Record<string, unknown>) };
    delete r['password'];
    if (!isSelf) {
      delete r['stripe_customer_id'];
      delete r['stripe_subscription_id'];
    }
    return r;
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') return errResp('Method not allowed', 405);

  // Parse request body
  let filter: string;
  let table: string, method: string, body: unknown,
      sessionToken: string | null,
      kioskSiteId: string | null, action: string | null;
  try {
    const p = await req.json();
    table        = p.table;
    method       = p.method;
    filter       = p.filter || '';
    body         = p.body   || null;
    sessionToken = p.sessionToken || null;
    kioskSiteId  = p.kioskSiteId  || null;
    action       = p.action || null;
  } catch {
    return errResp('Invalid request body', 400);
  }
  // action requests don't need table/method
  if (!action && (!table || !method)) return errResp('Missing table or method', 400);

  // ── Server-side actions (non-CRUD) ──────────────────────────────────────
  if (action === 'request_reset_code') {
    const email = (typeof (body as any)?.email === 'string') ? (body as any).email.trim() : '';
    if (!email) return errResp('Missing email', 400);
    try {
      // 1. Issue code server-side (service role). Plaintext code stays on the server.
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_email_code`, {
        method: 'POST',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_email: email, p_purpose: 'password_reset' }),
      });
      const issued = await rpcRes.json().catch(() => null);
      // Always respond ok:true to avoid revealing whether the account exists.
      if (issued && issued.ok && issued.exists && issued.code) {
        // 2. Email the code in the background (EdgeRuntime.waitUntil) so the response
        // returns at the same time whether or not the account exists — this closes the
        // reset timing side-channel. Failures are swallowed and never surfaced.
        const emailJob = fetch(`${SUPABASE_URL}/functions/v1/send-verification`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: issued.email,
            name: issued.name || '',
            code: issued.code,
            subject: 'Reset your PunchClock Pro password',
            purpose: 'password_reset',
          }),
        }).then(() => {}).catch(() => {});
        // @ts-ignore EdgeRuntime is a Supabase Edge Functions global
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(emailJob);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch {
      // Even on internal error, return ok:true (don't reveal anything to caller).
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  if (action === 'request_registration_code') {
    const email = (typeof (body as any)?.email === 'string') ? (body as any).email.trim().toLowerCase() : '';
    const name  = (typeof (body as any)?.name === 'string') ? (body as any).name : '';
    if (!email) return errResp('Missing email', 400);
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_email_code`, {
        method: 'POST',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_email: email, p_purpose: 'registration' }),
      });
      const issued = await rpcRes.json().catch(() => null);

      // Registration legitimately reveals email-taken so the user can go log in.
      if (issued && issued.ok === false && issued.error === 'email_taken') {
        return new Response(JSON.stringify({ ok: false, error: 'email_taken' }), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }

      if (issued && issued.ok && issued.exists && issued.code) {
        // Email in the background (see request_reset_code) — keeps the response snappy
        // and timing uniform. Failures are swallowed.
        const emailJob = fetch(`${SUPABASE_URL}/functions/v1/send-verification`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: issued.email,
            name: name || '',
            code: issued.code,
          }),
        }).then(() => {}).catch(() => {});
        // @ts-ignore EdgeRuntime is a Supabase Edge Functions global
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(emailJob);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch {
      return errResp('Internal server error');
    }
  }

  // Resolve the authenticated admin once, from the opaque session token.
  const authedAdminId = await resolveAdminId(sessionToken);

  // ── Auth gate: writes (POST/PATCH/DELETE) — deny by default ──
  // Without this, any holder of the public anon key could insert/update/delete arbitrary
  // rows via the service-role forward below. Allow only an authenticated admin, or a
  // narrowly-scoped kiosk insert. (Action requests are handled earlier and never reach here.)
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    if (authedAdminId) {
      // Authenticated admin — allowed. (Per-tenant/role write scoping is a deeper layer.)
    } else if (
      kioskSiteId &&
      method === 'POST' &&
      (table === 'punches' || table === 'missed_punch_requests') &&
      !!body && typeof body === 'object' &&
      (body as Record<string, unknown>).site_id === kioskSiteId
    ) {
      // Kiosk clock-punch / missed-punch insert, scoped to the kiosk's own site.
      if (!(await verifySite(kioskSiteId))) return errResp('Unauthorized', 401);

    } else {
      return errResp('Unauthorized', 401);
    }
  }

  // ── Auth gate: GET on protected tables requires one of three valid paths ──
  if (method === 'GET' && PROTECTED_TABLES.has(table)) {

    if (authedAdminId) {
      // Path 1 — authenticated admin (token or, during transition, legacy admin id)

    } else if (kioskSiteId && (table === 'employees' || table === 'punches')) {
      // Path 2 — kiosk: verify site exists, then force site_id filter so the kiosk can only
      // read its own site's employees and punches (the latter drives the clocked-in board).
      const validSite = await verifySite(kioskSiteId);
      if (!validSite) return errResp('Unauthorized', 401);
      filter = `site_id=eq.${kioskSiteId}`;

    } else if (isPreAuthAllowed(table, filter)) {
      // Path 3 — pre-auth single-row lookup (login, invite, password reset)
      // Falls through; password always stripped from admins results below

    } else {
      return errResp('Unauthorized', 401);
    }
  }

  // ── Build and forward upstream request ───────────────────────────────────
  const qp: string[] = [];
  if (filter) qp.push(filter);
  if (method === 'GET') qp.push('select=*');
  const url = `${SUPABASE_URL}/rest/v1/${table}${qp.length ? '?' + qp.join('&') : ''}`;

  const upstreamHeaders: Record<string, string> = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST' || method === 'PATCH') {
    upstreamHeaders['Prefer'] = 'return=representation';
  }

  try {
    const upstream = await fetch(url, {
      method,
      headers: upstreamHeaders,
      body: body != null ? JSON.stringify(body) : undefined,
    });

    const text = await upstream.text();

    // 204 No Content — must not have a body (HTTP spec)
    if (upstream.status === 204 || !text) {
      return new Response(null, {
        status: upstream.status,
        headers: CORS,
      });
    }

    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    // Strip sensitive fields from admins GET responses
    if (method === 'GET' && table === 'admins' && Array.isArray(data)) {
      data = stripAdminRows(data, authedAdminId, filter);
    }

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch {
    return errResp('Internal server error');
  }
});
