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
  'time_off',
  // These three were readable by any anonymous caller: shift schedules, holiday calendars and
  // staff availability for every tenant. Read-only, but still cross-tenant customer data.
  'availability', 'holidays', 'shifts',
  // Holds the addresses payroll summaries get mailed to — must never be readable or writable
  // across tenants, or one company could redirect another's hours to itself.
  'report_recipients',
  // Which tablets are acting as punch terminals. Admin-visible only; the tablets themselves
  // check in through the kiosk_device_checkin RPC rather than this path.
  'kiosk_devices',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function errResp(msg: string, status = 500): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Append a row to the audit_log without blocking the response (EdgeRuntime.waitUntil).
// Never logs the request body — bodies can contain secrets (e.g. password hashes).
function logAudit(adminId: string | null, event: string, tableName?: string, method?: string, filter?: string): void {
  try {
    const job = fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        admin_id: adminId, event,
        table_name: tableName ?? null, method: method ?? null, filter: filter ?? null,
      }),
    }).then(() => {}).catch(() => {});
    // @ts-ignore EdgeRuntime is a Supabase Edge Functions global
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(job);
  } catch (_e) { /* auditing must never break the request */ }
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

// Resolve the caller from an opaque session token (admin_sessions): returns their admin id,
// primary admin id (the parent for co-admins/managers — the tenant owner), and role, or null
// if the token is missing/expired or the admin isn't active/pending_invite. Token-only.
interface Caller { adminId: string; primaryAdminId: string; role: string; }
async function resolveCaller(sessionToken: string | null): Promise<Caller | null> {
  if (!sessionToken) return null;
  const sres = await fetch(
    `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${sessionToken}&select=admin_id,expires_at&limit=1`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!sres.ok) return null;
  const srows = await sres.json();
  const srow = Array.isArray(srows) ? srows[0] : null;
  if (!srow || new Date(srow.expires_at) <= new Date()) return null;
  const ares = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?id=eq.${srow.admin_id}&select=id,parent_admin_id,role,status&limit=1`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!ares.ok) return null;
  const arows = await ares.json();
  const a = Array.isArray(arows) ? arows[0] : null;
  if (!a || !(a.status === 'active' || a.status === 'pending_invite')) return null;
  return {
    adminId: a.id as string,
    primaryAdminId: (a.parent_admin_id as string) || (a.id as string),
    role: a.role as string,
  };
}

// Company ids owned by a tenant (the primary admin's companies).
async function ownedCompanyIds(primaryAdminId: string): Promise<string[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/companies?admin_id=eq.${primaryAdminId}&select=id`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : [];
}

// availability has no company_id — it hangs off an employee — so it is scoped by resolving the
// caller's employees first.
async function ownedEmployeeIds(companyIds: string[]): Promise<string[]> {
  if (!companyIds.length) return [];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employees?company_id=in.(${companyIds.join(',')})&select=id`,
    { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : [];
}

async function idList(path: string): Promise<Set<string>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : []);
}

// Reject a write whose payload points at another tenant.
//
// Reads/updates/deletes are already narrowed by filter, so a caller can only *touch* their own
// rows — but nothing stopped the body of an INSERT (or a PATCH) from naming another tenant's
// company, site or employee, which would plant a row in, or move one into, someone else's account.
// Every tenant-bearing key present in the payload must resolve to something the caller owns.
// Keys that are absent are left alone: the database's own NOT NULL and FK constraints still apply.
//
// Returns null when the payload is acceptable, or the offending field and why it was refused.
// The two reasons need different wording: one is "that row is not yours", the other is "that
// column is not yours to set" -- reporting an entitlement block as a tenant error would send
// anyone debugging it looking in the wrong place.
interface WriteViolation { field: string; reason: 'tenant' | 'entitlement' }
async function validateWritePayload(
  table: string, body: unknown, caller: Caller,
): Promise<WriteViolation | null> {
  const rows: Record<string, unknown>[] = Array.isArray(body)
    ? body as Record<string, unknown>[]
    : (body && typeof body === 'object' ? [body as Record<string, unknown>] : []);
  if (!rows.length) return null;

  // Resolved lazily — most writes only need the company list.
  let companies: Set<string> | null = null;
  let sites: Set<string> | null = null;
  let employees: Set<string> | null = null;
  let adminIds: Set<string> | null = null;

  const companyIds = async () => {
    if (!companies) companies = new Set(await ownedCompanyIds(caller.primaryAdminId));
    return companies;
  };
  const siteIds = async () => {
    if (!sites) {
      const cs = [...(await companyIds())];
      sites = cs.length ? await idList(`sites?company_id=in.(${cs.join(',')})&select=id`) : new Set();
    }
    return sites;
  };
  const employeeIds = async () => {
    if (!employees) {
      const cs = [...(await companyIds())];
      employees = cs.length ? await idList(`employees?company_id=in.(${cs.join(',')})&select=id`) : new Set();
    }
    return employees;
  };
  // The caller, the account owner, and everyone delegated under that owner.
  const teamIds = async () => {
    if (!adminIds) {
      adminIds = await idList(`admins?parent_admin_id=eq.${caller.primaryAdminId}&select=id`);
      adminIds.add(caller.adminId);
      adminIds.add(caller.primaryAdminId);
    }
    return adminIds;
  };

  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

  for (const row of rows) {
    const co = str(row.company_id);
    if (co && !(await companyIds()).has(co)) return { field: 'company_id', reason: 'tenant' };

    const site = str(row.site_id);
    if (site && !(await siteIds()).has(site)) return { field: 'site_id', reason: 'tenant' };

    for (const key of ['employee_id', 'emp_id']) {
      const emp = str(row[key]);
      if (emp && !(await employeeIds()).has(emp)) return { field: key, reason: 'tenant' };
    }

    // admin-ish references must stay inside the caller's own account
    for (const key of ['admin_id', 'inviter_admin_id', 'manager_id', 'parent_admin_id', 'reviewed_by']) {
      const a = str(row[key]);
      if (a && !(await teamIds()).has(a)) return { field: key, reason: 'tenant' };
    }

    // Entitlements are billing state, not user data. The tenant scope above lets an admin write
    // to their OWN admins row, which is correct for a name or a co-admin's status -- but it also
    // meant a session holder could PATCH scheduling_addon or plan and grant themselves paid
    // features outright. These columns are writable only by Stripe webhooks and server-side
    // actions running under the service role, both of which bypass this check, and by super
    // admins, who are exempt from validateWritePayload entirely.
    if (table === 'admins') {
      for (const key of ENTITLEMENT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(row, key)) return { field: key, reason: 'entitlement' };
      }
      // ...and nobody promotes themselves to super_admin through the co-admin editor.
      if (str(row.role) === 'super_admin') return { field: 'role', reason: 'entitlement' };
    }
  }
  return null;
}

// Columns on `admins` that a client session may never write. Changing any of these is either a
// billing event (Stripe webhook), a server-side action, or a super-admin operation.
const ENTITLEMENT_FIELDS = [
  'plan', 'scheduling_addon', 'scheduling_trial_ends_at', 'extra_seats',
  'stripe_customer_id', 'stripe_subscription_id', 'verified', 'password', 'unsub_token',
];

// Tables scoped to a tenant by their company_id column.
const COMPANY_SCOPED = new Set(['sites', 'employees', 'punches', 'missed_punch_requests', 'invitations', 'holidays', 'shifts', 'time_off', 'report_recipients', 'kiosk_devices']);

// Ownership constraint to AND onto a read/update/delete filter for `table`. '' = not scoped here.
function tenantScopeFilter(table: string, caller: Caller, owned: string[]): string {
  if (COMPANY_SCOPED.has(table)) {
    // Empty owned → a sentinel uuid that matches no row (deny), keeping in.() syntactically valid.
    return `company_id=in.(${owned.length ? owned.join(',') : '00000000-0000-0000-0000-000000000000'})`;
  }
  if (table === 'companies') return `admin_id=eq.${caller.primaryAdminId}`;
  // admins tenant view: the caller's own row, the primary (parent) admin's row, and everyone
  // under the same primary. Including the primary's own row is essential — co-admins/managers
  // read their parent admin for plan/permissions (C.primaryAdmin).
  if (table === 'admins')    return `or=(id.eq.${caller.adminId},id.eq.${caller.primaryAdminId},parent_admin_id.eq.${caller.primaryAdminId})`;
  return '';
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
      // The unsubscribe token silences that admin's digest from an unauthenticated link, so a
      // co-admin reading the team list must not be able to lift their owner's out of the API.
      delete r['unsub_token'];
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
  // Same shape as request_reset_code below, for the employee portal. Kept separate rather
  // than parameterised so the two cannot be confused: an employee's code must never be able
  // to reset an admin account, and vice versa — the purpose string is the whole boundary.
  if (action === 'portal_request_reset') {
    const email = (typeof (body as any)?.email === 'string') ? (body as any).email.trim() : '';
    if (!email) return errResp('Missing email', 400);
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_email_code`, {
        method: 'POST',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_email: email, p_purpose: 'portal_reset' }),
      });
      const issued = await rpcRes.json().catch(() => null);
      if (issued && issued.ok && issued.exists && issued.code) {
        // Sent in the background so the response time is identical whether or not the account
        // exists — otherwise the delay itself reveals which addresses are real.
        const emailJob = fetch(`${SUPABASE_URL}/functions/v1/send-verification`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: issued.email,
            name: issued.name || '',
            code: issued.code,
            subject: 'Reset your PunchClock password | Réinitialisez votre mot de passe',
            purpose: 'password_reset',
          }),
        }).then(() => {}).catch(() => {});
        // @ts-ignore EdgeRuntime is a Supabase Edge Functions global
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(emailJob);
      }
      // Always ok:true — never reveal whether that address has a portal account.
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

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

  // Resolve the authenticated caller once, from the opaque session token.
  const caller = await resolveCaller(sessionToken);
  const authedAdminId = caller?.adminId ?? null;

  // -- Start the 14-day scheduling add-on trial --
  // The end date is computed here, never accepted from the client, and the trial is offered
  // exactly once: a non-null scheduling_trial_ends_at (past or future) makes the account
  // ineligible. The trial belongs to the tenant owner, so a co-admin cannot start a second one
  // on their own row; only the account owner may start it at all, since it precedes a charge.
  if (action === 'start_scheduling_trial') {
    if (!caller) return errResp('Unauthorized', 401);
    if (caller.adminId !== caller.primaryAdminId) {
      return errResp('Only the account owner can start the scheduling trial', 403);
    }
    const ownerRows = await fetch(
      `${SUPABASE_URL}/rest/v1/admins?id=eq.${caller.primaryAdminId}&select=scheduling_addon,scheduling_trial_ends_at&limit=1`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    ).then(r => r.ok ? r.json() : null).catch(() => null);
    const owner = Array.isArray(ownerRows) ? ownerRows[0] : null;
    if (!owner) return errResp('Account not found', 404);
    if (owner.scheduling_addon) return errResp('Scheduling is already active on this account', 400);
    if (owner.scheduling_trial_ends_at) return errResp('The scheduling trial has already been used', 400);

    const endsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    // The is.null filter makes this idempotent under a double-click: the second request matches
    // no row, and an empty result set means the trial was already started.
    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/admins?id=eq.${caller.primaryAdminId}&scheduling_trial_ends_at=is.null`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=representation',
        },
        body: JSON.stringify({ scheduling_trial_ends_at: endsAt }),
      }
    );
    if (!upd.ok) return errResp('Could not start the trial. Please try again.');
    const updated = await upd.json().catch(() => null);
    if (!Array.isArray(updated) || !updated.length) {
      return errResp('The scheduling trial has already been used', 400);
    }
    logAudit(caller.adminId, 'scheduling_trial_started', 'admins', 'PATCH', endsAt);
    return new Response(JSON.stringify({ ok: true, endsAt }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── Auth gate: writes (POST/PATCH/DELETE) — deny by default ──
  // Without this, any holder of the public anon key could insert/update/delete arbitrary
  // rows via the service-role forward below. Allow only an authenticated admin, or a
  // narrowly-scoped kiosk insert. (Action requests are handled earlier and never reach here.)
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    if (authedAdminId) {
      // Authenticated admin — allowed, but the payload must not point at another tenant.
      // Super admins are deliberately unscoped, matching the read path.
      if (caller && caller.role !== 'super_admin' && (method === 'POST' || method === 'PATCH')) {
        const bad = await validateWritePayload(table, body, caller);
        if (bad) {
          logAudit(authedAdminId,
            bad.reason === 'entitlement' ? 'entitlement_write_blocked' : 'cross_tenant_write_blocked',
            table, method, bad.field);
          return errResp(bad.reason === 'entitlement'
            ? `Forbidden: ${bad.field} cannot be changed from the app`
            : `Forbidden: ${bad.field} does not belong to your account`, 403);
        }
      }
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
    // Audit the authorized admin write (kiosk inserts are intentionally not logged here).
    if (authedAdminId) logAudit(authedAdminId, 'write', table, method, filter);
  }

  // ── Auth gate: GET on protected tables requires one of three valid paths ──
  if (method === 'GET' && PROTECTED_TABLES.has(table)) {

    if (authedAdminId) {
      // Path 1 — authenticated admin (token or, during transition, legacy admin id)

    } else if (kioskSiteId && (table === 'employees' || table === 'punches' || table === 'shifts')) {
      // Path 2 — kiosk: verify site exists, then force site_id filter so the kiosk can only
      // read its own site's employees and punches (the latter drives the clocked-in board).
      // 'shifts' is included because an employee at the terminal can PIN in to have their own
      // schedule emailed; the forced filter keeps that to the terminal's own site.
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

  // ── Per-tenant scoping (reads + updates + deletes) ───────────────────────
  // Narrow GET/PATCH/DELETE to the caller's own tenant rows so a logged-in admin cannot read
  // or modify another tenant's data. Narrowing is safe-by-design: a legitimate op still matches
  // the caller's rows; only cross-tenant rows fall out (0 rows). Super admins are unscoped.
  // Inserts are not yet tenant-validated here (lowest-damage vector; tracked as follow-up).
  // Pre-auth lookups and kiosk paths have no caller and are unaffected.
  if (caller && caller.role !== 'super_admin' &&
      (method === 'GET' || method === 'PATCH' || method === 'DELETE') &&
      (COMPANY_SCOPED.has(table) || table === 'companies' || table === 'admins' || table === 'availability')) {
    if (table === 'availability') {
      // Scope through the caller's employees. An empty list yields a sentinel that matches
      // nothing, so the failure mode is "no rows" rather than "everyone's rows".
      const empIds = await ownedEmployeeIds(await ownedCompanyIds(caller.primaryAdminId));
      const scope = `employee_id=in.(${empIds.length ? empIds.join(',') : '00000000-0000-0000-0000-000000000000'})`;
      filter = filter ? `${filter}&${scope}` : scope;
    } else {
      const owned = (COMPANY_SCOPED.has(table) || table === 'companies')
        ? await ownedCompanyIds(caller.primaryAdminId) : [];
      const scope = tenantScopeFilter(table, caller, owned);
      if (scope) filter = filter ? `${filter}&${scope}` : scope;
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

    // Strip sensitive fields from every admins response, not just GET. PATCH is sent back with
    // Prefer: return=representation, so renaming a co-admin was handing the caller that person's
    // bcrypt hash -- the same secret the GET path has always been careful to remove.
    if (table === 'admins' && Array.isArray(data)) {
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
