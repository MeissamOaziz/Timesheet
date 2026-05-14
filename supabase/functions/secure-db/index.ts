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
      sessionId: string | null, kioskSiteId: string | null;
  try {
    const p = await req.json();
    table       = p.table;
    method      = p.method;
    filter      = p.filter || '';
    body        = p.body   || null;
    sessionId   = p.sessionId   || null;
    kioskSiteId = p.kioskSiteId || null;
  } catch {
    return errResp('Invalid request body', 400);
  }
  if (!table || !method) return errResp('Missing table or method', 400);

  // ── Auth gate: GET on protected tables requires one of three valid paths ──
  if (method === 'GET' && PROTECTED_TABLES.has(table)) {

    if (sessionId) {
      // Path 1 — authenticated admin session
      const valid = await verifySession(sessionId);
      if (!valid) return errResp('Unauthorized', 401);

    } else if (kioskSiteId && table === 'employees') {
      // Path 2 — kiosk: verify site exists, then force site_id filter
      const validSite = await verifySite(kioskSiteId);
      if (!validSite) return errResp('Unauthorized', 401);
      // Override filter — kiosk can only read its own site's employees
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
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    // Strip sensitive fields from all admins GET responses
    if (method === 'GET' && table === 'admins' && Array.isArray(data)) {
      data = stripAdminRows(data, sessionId, filter);
    }

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch {
    return errResp('Internal server error');
  }
});
