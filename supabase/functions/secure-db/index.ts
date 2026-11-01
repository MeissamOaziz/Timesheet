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
  // Portal login state per employee — email, status, and (while an invite is outstanding)
  // invite_token. Was reachable by any caller holding just the public anon key: no admin
  // session, no company match, nothing. invite_token is the credential that sets that
  // employee's password, so this wasn't just an email leak — it was an invite-hijack vector
  // across every tenant. The portal app itself never reads this table; it authenticates
  // through _resolve_portal_session and its own RPCs, entirely separate from this path.
  'employee_portal',
  // Visitor check-in log (name/company/phone/email + timestamps). Same tenant-data sensitivity
  // as employees/punches — PII tied to a specific company and site.
  'visitors',
  // Company-defined work labels (task / job / project names). Tenant data; managed only by owners
  // and admins on an account with the Scheduling add-on (enforced below).
  'work_labels',
]);

// Every table the app may touch through this function: the protected set (each with its own access
// rules below) and the announcements feed (public to read, super admin only to write).
const APP_TABLES = new Set<string>([...PROTECTED_TABLES, 'announcements']);

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
interface WriteViolation { field: string; reason: 'tenant' | 'entitlement' | 'plan' }

// Plan checks run in the database (one definition, public.has_paid_features and friends, shared with
// the daily job that switches off whatever an account is no longer entitled to). They fail open: a
// lookup that cannot be answered never blocks a customer from saving their settings.
async function planRpc(fn: string, args: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
const GRANDFATHERED_COMPANIES = ['Oaziz Extracts', 'Connoisseur Culture'];
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
  let labels: Set<string> | null = null;

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
  const labelIds = async () => {
    if (!labels) {
      const cs = [...(await companyIds())];
      labels = cs.length ? await idList(`work_labels?company_id=in.(${cs.join(',')})&select=id`) : new Set();
    }
    return labels;
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

    // A shift/punch may only be tagged with one of the caller's own labels.
    const lab = str(row.label_id);
    if (lab && !(await labelIds()).has(lab)) return { field: 'label_id', reason: 'tenant' };

    // A punch reference (missed-punch approval) must be a punch of the caller's own companies.
    const pid = str(row.punch_id);
    if (pid) {
      if (!TOKEN_RE.test(pid)) return { field: 'punch_id', reason: 'tenant' };
      const cs = [...(await companyIds())];
      const own = cs.length ? await restJson(`punches?id=eq.${pid}&company_id=in.(${cs.join(',')})&select=id&limit=1`) : [];
      if (!own || !own.length) return { field: 'punch_id', reason: 'tenant' };
    }

    // An invitation lists the sites a manager is to be given (accept_invitation inserts manager_sites for
    // each); every one must be a site of the caller's own account.
    if (table === 'invitations' && row.site_ids !== undefined && row.site_ids !== null) {
      if (!Array.isArray(row.site_ids)) return { field: 'site_ids', reason: 'tenant' };
      for (const sid of row.site_ids as unknown[]) {
        if (typeof sid !== 'string' || !(await siteIds()).has(sid)) return { field: 'site_ids', reason: 'tenant' };
      }
    }

    // admin-ish references must stay inside the caller's own account
    for (const key of ['admin_id', 'inviter_admin_id', 'manager_id', 'parent_admin_id', 'reviewed_by', 'created_by', 'requester_id', 'target_admin_id']) {
      const a = str(row[key]);
      if (a && !(await teamIds()).has(a)) return { field: key, reason: 'tenant' };
    }

    // Plan limits. Overtime tracking, evening hours and automatic payroll recipients are Starter-and-up
    // (a Free account previews them for a while); lunch breaks and visitor check-in are Growth-and-up.
    // The browser already locks these controls; this is what stops a hand-made request.
    if (table === 'companies') {
      const wantsPaid = row.track_overtime === true || (row.evening_start != null && row.evening_start !== '');
      const wantsGrowth = row.track_lunch_breaks === true || row.visitor_checkin_enabled === true;
      if ((wantsPaid || wantsGrowth) && !GRANDFATHERED_COMPANIES.includes(String(row.name ?? ''))) {
        if (wantsPaid && (await planRpc('has_paid_features', { p_admin: caller.primaryAdminId })) === false) {
          return { field: row.track_overtime === true ? 'track_overtime' : 'evening_start', reason: 'plan' };
        }
        if (wantsGrowth) {
          const rank = await planRpc('admin_plan_rank', { p_admin: caller.primaryAdminId });
          if (typeof rank === 'number' && rank < 2) {
            return { field: row.track_lunch_breaks === true ? 'track_lunch_breaks' : 'visitor_checkin_enabled', reason: 'plan' };
          }
        }
      }
    }
    if ((table === 'report_recipients' || table === 'time_off') && co &&
        (await planRpc('company_has_paid_features', { p_company: co })) === false) {
      return { field: 'company_id', reason: 'plan' };
    }
    // The employee portal (invitations, access) is a paid feature too. Revoking access sends no employee_id, so
    // it is never blocked.
    if (table === 'employee_portal') {
      const portalEmp = str(row.employee_id);
      if (portalEmp) {
        const owner = (await restJson(`employees?id=eq.${portalEmp}&select=company_id&limit=1`))?.[0];
        if (owner?.company_id && (await planRpc('company_has_paid_features', { p_company: owner.company_id as string })) === false) {
          return { field: 'employee_id', reason: 'plan' };
        }
      }
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
const COMPANY_SCOPED = new Set(['sites', 'employees', 'punches', 'missed_punch_requests', 'invitations', 'holidays', 'shifts', 'time_off', 'report_recipients', 'kiosk_devices', 'visitors', 'work_labels']);

// Fields a kiosk (no admin session) may set when checking a visitor out. Nothing else — a kiosk
// checking someone out must never be able to rewrite who they are, only that they've left.
const VISITOR_CHECKOUT_FIELDS = new Set(['checked_out_at']);

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

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const TABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// Session tokens, site ids and other opaque ids: letters, digits, '-' and '_' only. Nothing that
// could add a query parameter, a filter operator or a path segment when interpolated into a URL.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
function safeDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }
// PostgREST resource embedding (select=*,employee_portal(*)) lets a caller pull columns from other
// tables through foreign keys, including ones this proxy never intended to expose. Client `select`
// parameters are only honoured when they are a plain column list. The parameter NAME is decoded
// first because PostgREST decodes it too (%73elect is "select").
function sanitizeSelect(filter: string): string {
  if (!filter) return filter;
  return filter.split('&').filter(p => {
    const i = p.indexOf('=');
    const key = safeDecode(i < 0 ? p : p.slice(0, i));
    if (key !== 'select' && key !== 'order') return true;
    const val = safeDecode(i < 0 ? '' : p.slice(i + 1));
    // `order` may also reach into related tables (order=employee_portal(password_hash)), which would
    // leak how hidden values compare; only plain "column.direction" lists are honoured.
    return key === 'order' ? /^[A-Za-z0-9_.,]+$/.test(val) : /^[A-Za-z0-9_,*]+$/.test(val);
  }).join('&');
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

// Strip sensitive admin fields. Password is always removed, and so are invitation credentials and
// onboarding bookkeeping: nothing in the apps reads them back, and invite_token is a bearer credential.
// Stripe fields and the unsubscribe token are kept only on the caller's OWN row (decided per returned
// row, not by looking for the caller's id inside the request's filter text).
function stripAdminRows(rows: unknown[], sessionId: string | null): unknown[] {
  return rows.map(row => {
    if (typeof row !== 'object' || row === null) return row;
    const r = { ...(row as Record<string, unknown>) };
    const isSelf = !!sessionId && r['id'] === sessionId;
    delete r['password'];
    delete r['invite_token'];
    delete r['invite_expires_at'];
    delete r['invite_used_at'];
    delete r['invite_site_ids'];
    delete r['onboarding_emails_sent'];
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

// A request with no session may look an admin up before login (the sign-in, set-password and invitation
// screens, and the registration e-mail check). It used to get the whole row. Now: a lookup by e-mail
// learns only that the address exists, a lookup by id gets the handful of columns the sign-in screens
// build a session from. Nothing else (no billing ids, last login, tokens, counters).
const PREAUTH_ADMIN_COLS = ['id', 'name', 'email', 'role', 'plan', 'status', 'parent_admin_id', 'extra_seats', 'scheduling_addon', 'scheduling_trial_ends_at'];
function preAuthAdminRows(rows: unknown[], filter: string): unknown[] {
  const byEmail = filter.split('&').some(p => p.startsWith('email=eq.'));
  return rows.map(row => {
    if (typeof row !== 'object' || row === null) return row;
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of (byEmail ? ['email'] : PREAUTH_ADMIN_COLS)) if (k in r) out[k] = r[k];
    return out;
  });
}

// Strip employee_portal fields no admin client ever legitimately reads: password_hash is a
// bcrypt hash with no use outside portal_login/activate_employee_portal (both direct RPCs, not
// this path), and invite_token is a bearer credential — the admin re-invites by writing a new
// one (sendEmpPortalInvite in index.html), never by reading the current one back.
function stripPortalRows(rows: unknown[]): unknown[] {
  return rows.map(row => {
    if (typeof row !== 'object' || row === null) return row;
    const r = { ...(row as Record<string, unknown>) };
    delete r['password_hash'];
    delete r['invite_token'];
    return r;
  });
}

// ── Kiosk helpers ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A kiosk read is forced onto its own site, which REPLACES whatever the terminal asked for. That
// meant "this employee's shifts this week" came back as every shift at the site, any week, and the
// terminal's My Shifts panel showed other people's schedules. Keep the terminal's own narrowing
// clauses when they are a short list of well-formed ones: they can only shrink the result, never
// widen it beyond the site, so honouring them is strictly safer than ignoring them.
function kioskNarrowing(table: string, clientFilter: string): string {
  const keep: string[] = [];
  for (const part of clientFilter.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq), val = part.slice(eq + 1);
    if (table === 'shifts') {
      if (key === 'employee_id' && val.startsWith('eq.') && UUID_RE.test(val.slice(3))) keep.push(part);
      else if (key === 'shift_date') {
        const m = /^(eq|gte|lte)\.(.+)$/.exec(val);
        if (m && DATE_RE.test(m[2])) keep.push(part);
      } else if (key === 'order' && val === 'shift_date.asc,start_time.asc') keep.push(part);
    } else if (table === 'visitors') {
      if (key === 'checked_out_at' && val === 'is.null') keep.push(part);
    }
  }
  return keep.join('&');
}

async function restJson(path: string): Promise<any[] | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) ? j : null;
}

// A terminal polls its punches every minute or two, all day. It only needs to know who is clocked in
// and a little recent context, so instead of the latest 1000 rows (up to ~580 KB per refresh, per tablet)
// it gets the last 36 hours plus each person's latest punch, whatever its age (kiosk_recent_punches).
// Same columns, same newest-first order. Returns null if the function is unavailable, and the caller
// then falls back to the old read, so a missing migration can never leave a tablet without data.
async function kioskRecentPunches(siteId: string): Promise<unknown[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/kiosk_recent_punches`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_site_id: siteId, p_hours: 36 }),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// The Scheduling add-on is on when it is paid for, or during the free 14-day trial (an end date in the future,
// set once by start_scheduling_trial). Paid is checked first, so the common case costs one lookup as before.
async function schedulingActive(adminId: string): Promise<boolean> {
  const paid = (await restJson(`admins?id=eq.${adminId}&select=scheduling_addon&limit=1`))?.[0];
  if (paid?.scheduling_addon) return true;
  const t = (await restJson(`admins?id=eq.${adminId}&select=scheduling_trial_ends_at&limit=1`))?.[0]?.scheduling_trial_ends_at;
  return !!t && new Date(t as string).getTime() > Date.now();
}

// What a kiosk may know about work labels: its own company's, and only when that account has the
// Scheduling add-on. `mode` is the company's "labels at clock-in" setting (off / optional / required).
async function kioskLabelContext(siteId: string): Promise<{ companyId: string; addon: boolean; mode: string } | null> {
  const site = (await restJson(`sites?id=eq.${siteId}&select=company_id&limit=1`))?.[0];
  if (!site) return null;
  const co = (await restJson(`companies?id=eq.${site.company_id}&select=admin_id,punch_label_mode&limit=1`))?.[0];
  if (!co) return null;
  const addon = co.admin_id ? await schedulingActive(co.admin_id as string) : false;
  return { companyId: site.company_id as string, addon, mode: (co.punch_label_mode as string) || 'off' };
}

async function kioskLabelBelongs(siteId: string, labelId: string): Promise<boolean> {
  if (!UUID_RE.test(labelId)) return false;
  const lc = await kioskLabelContext(siteId);
  if (!lc) return false;
  const rows = await restJson(`work_labels?id=eq.${labelId}&company_id=eq.${lc.companyId}&select=id&limit=1`);
  return !!(rows && rows.length);
}

// ── Paged reads ───────────────────────────────────────────────────────────────

// PostgREST returns at most 1000 rows per request however large a limit the caller asks for, and
// does so silently. Every screen that reads a growing table (punches above all) was therefore one
// busy site away from quietly showing a truncated list. GETs are paged here instead, so no caller
// can be cut short: they get everything they asked for, or an explicit error -- never a quiet subset.
const PAGE_SIZE = 1000;
// Upper bound on what one request may pull back (~25 MB of JSON). Past it we refuse rather than
// truncate; the caller should narrow the date range.
const MAX_ROWS = 50000;

interface PagedResult { status: number; text: string }

async function getAllRows(table: string, filter: string, hdrs: Record<string, string>): Promise<PagedResult> {
  const rest: string[] = [];
  let wanted = Infinity, base = 0;
  for (const p of (filter ? filter.split('&') : []).filter(Boolean)) {
    if (p.startsWith('limit='))       { const n = parseInt(p.slice(6), 10);  if (n > 0) wanted = Math.min(wanted, n); }
    else if (p.startsWith('offset=')) { const n = parseInt(p.slice(7), 10);  if (n > 0) base = n; }
    else rest.push(p);
  }
  const build = (extra: string[]) =>
    `${SUPABASE_URL}/rest/v1/${table}?${[...rest, ...extra, 'select=*'].join('&')}`;
  const offsetQ = (o: number) => (o > 0 ? [`offset=${o}`] : []);

  // Small, bounded reads (single-row lookups, kiosk windows) need no paging and no count.
  if (wanted <= PAGE_SIZE) {
    const r = await fetch(build(Number.isFinite(wanted) ? [`limit=${wanted}`, ...offsetQ(base)] : offsetQ(base)), { headers: hdrs });
    return { status: r.status, text: await r.text() };
  }

  // Multi-page read. Paging only works on a stable order, so fall back to the primary key when the
  // caller specified none.
  // A caller's own order (e.g. punched_at.desc) can tie -- two people punching in the same second --
  // and ties straddling a page boundary would duplicate or drop rows, so the primary key is
  // always the final tiebreaker.
  const ordAt = rest.findIndex(p => p.startsWith('order='));
  let order: string[];
  if (ordAt === -1) order = ['order=id.asc'];
  else {
    const o = rest.splice(ordAt, 1)[0];
    order = [/(^order=|,)id\./.test(o) ? o : `${o},id.asc`];
  }
  const first = await fetch(
    build([...order, `limit=${PAGE_SIZE}`, ...offsetQ(base)]),
    { headers: { ...hdrs, 'Prefer': 'count=exact' } },
  );
  const firstText = await first.text();
  if (!first.ok) return { status: first.status, text: firstText };
  const rows = JSON.parse(firstText);
  if (!Array.isArray(rows)) return { status: first.status, text: firstText };

  const total = parseInt((first.headers.get('content-range') || '').split('/')[1], 10);
  if (!Number.isFinite(total)) return { status: 200, text: firstText };
  const target = Math.min(wanted, total - base);
  if (target > MAX_ROWS) {
    return { status: 413, text: JSON.stringify({ error: `Too many records (${target}) for one request. Narrow the date range.` }) };
  }
  if (rows.length >= target || rows.length === 0) return { status: 200, text: firstText };

  // Use the page size the server actually honoured, in case its cap is below ours.
  const size = rows.length;
  const jobs: { offset: number; limit: number }[] = [];
  for (let got = size; got < target; got += size) {
    jobs.push({ offset: base + got, limit: Math.min(size, target - got) });
  }
  const all: unknown[] = rows;
  for (let i = 0; i < jobs.length; i += 6) {
    const batch = await Promise.all(jobs.slice(i, i + 6).map(async j => {
      const r = await fetch(build([...order, `limit=${j.limit}`, `offset=${j.offset}`]), { headers: hdrs });
      return { ok: r.ok, status: r.status, text: await r.text() };
    }));
    for (const b of batch) {
      if (!b.ok) return { status: b.status, text: b.text };
      all.push(...JSON.parse(b.text));
    }
  }
  return { status: 200, text: JSON.stringify(all) };
}

// ── Emails sent on behalf of a signed-in admin ───────────────────────────────────────────────
// The browser used to call send-verification directly with the public key, which meant anyone could
// make us send mail from noreply@punchclock.ca to any address with any wording. Now the browser asks
// *here*, with its session, and names a row (an invitation token, an employee, a join request). The
// server reads that row, checks it belongs to the caller's account, takes the recipient and every
// link from the row itself, and only then calls send-verification with the service key. Nothing the
// browser sends decides who gets the email or where its buttons point.
const NOTIFY_EMAIL = 'meissam.h.p@gmail.com';

function jsonResp(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const strOf = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ── Private images (employee photos and company logos) ───────────────────────────────────────────
// The avatars and logos buckets are PRIVATE. photo_url / logo_url keep the stored, public-style value
// (.../storage/v1/object/public/<bucket>/<object>), which no longer opens by itself; every response that
// carries one hands the page a short-lived SIGNED url instead (minted here with the service key, many paths
// in one Storage call, cached per isolate so a kiosk that refreshes every 90 s does not cost a call each
// time). Whatever the page writes back (it may hold a signed url from an earlier read) is turned back into
// the stored form before it reaches the database, and must point at an object this account may use.
const IMG_SIGN_SECS = 4 * 3600;            // lifetime of a url handed to a page
const IMG_CACHE_MS = 20 * 60 * 1000;       // a cached url is reused for this long (so it always has >3 h left)
const IMG_EMAIL_SECS = 30 * 24 * 3600;     // lifetime of a logo url put into an email (opened days later)
const IMG_BUCKET_OF: Record<string, string> = { employees: 'avatars', companies: 'logos' };
const IMG_COL_OF: Record<string, string> = { employees: 'photo_url', companies: 'logo_url' };
const imgCache = new Map<string, { url: string; at: number }>();
const IMG_OBJECT_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// Reads a stored or signed url of OUR storage into {bucket, path}; anything else gives null.
function parseImageRef(v: unknown): { bucket: string; path: string } | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  const prefix = `${SUPABASE_URL}/storage/v1/object/`;
  if (!v.startsWith(prefix)) return null;
  const m = v.slice(prefix.length).split(/[?#]/)[0].match(/^(public|sign|authenticated)\/(avatars|logos)\/(.+)$/);
  if (!m || !IMG_OBJECT_RE.test(m[3]) || m[3].split('/').some((s) => s === '.' || s === '..')) return null;
  return { bucket: m[2], path: m[3] };
}
const canonicalImageUrl = (r: { bucket: string; path: string }) =>
  `${SUPABASE_URL}/storage/v1/object/public/${r.bucket}/${r.path}`;

// Signs the given objects, batching one Storage call per bucket. Returns "bucket/path" -> full signed url;
// objects that could not be signed are simply absent (the caller keeps the stored value, which then shows
// the page's initials fallback rather than failing the whole read).
async function signImages(refs: { bucket: string; path: string }[], secs = IMG_SIGN_SECS, useCache = true): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const need: Record<string, Set<string>> = {};
  for (const r of refs) {
    const key = `${r.bucket}/${r.path}`;
    const hit = useCache ? imgCache.get(key) : undefined;
    if (hit && now - hit.at < IMG_CACHE_MS) { if (hit.url) out.set(key, hit.url); continue; }
    (need[r.bucket] ||= new Set()).add(r.path);
  }
  for (const [bucket, set] of Object.entries(need)) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: secs, paths: [...set] }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const rel = row && typeof row.signedURL === 'string' && !row.error ? row.signedURL : '';
        if (!rel || typeof row.path !== 'string') continue;
        const full = rel.startsWith('http') ? rel : `${SUPABASE_URL}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
        const key = `${bucket}/${row.path}`;
        out.set(key, full);
        if (useCache) {
          if (imgCache.size > 2000) imgCache.clear();
          imgCache.set(key, { url: full, at: now });
        }
      }
    } catch (_e) { /* signing is best effort: the stored value is kept */ }
    // An object that could not be signed (deleted, or a failed call) is remembered for a while too, so a dangling
    // reference does not cost a Storage call on every 90 s terminal refresh.
    if (useCache) for (const pth of set) if (!out.has(`${bucket}/${pth}`)) imgCache.set(`${bucket}/${pth}`, { url: '', at: now });
  }
  return out;
}

// Replaces the stored url with a signed one on every row/object that has `col`.
async function signImageFields(items: Record<string, unknown>[], col: string): Promise<void> {
  const refs: { bucket: string; path: string }[] = [];
  for (const it of items) {
    const r = it && typeof it === 'object' ? parseImageRef(it[col]) : null;
    if (r) refs.push(r);
  }
  if (!refs.length) return;
  const signed = await signImages(refs);
  for (const it of items) {
    const r = it && typeof it === 'object' ? parseImageRef(it[col]) : null;
    const s = r ? signed.get(`${r.bucket}/${r.path}`) : undefined;
    if (s) it[col] = s;
  }
}

// A logo url good for 30 days, for an email. Empty string when it cannot be signed (the email then has no logo).
async function emailLogoUrl(stored: unknown): Promise<string> {
  const r = parseImageRef(stored);
  if (!r) return '';
  return (await signImages([r], IMG_EMAIL_SECS, false)).get(`${r.bucket}/${r.path}`) || '';
}

// Turns whatever photo_url / logo_url a write carries into the stored form and refuses anything that is not
// an object of this account's own: a url of ours, in the right bucket, either inside the folder of a company
// the caller owns (every upload since the buckets went private) or an older flat object this account already
// uses. Super admins are not tenant-scoped. Returns an error message, or null.
async function normaliseImageWrite(table: string, body: unknown, caller: Caller | null): Promise<string | null> {
  const col = IMG_COL_OF[table], bucket = IMG_BUCKET_OF[table];
  if (!col) return null;
  let owned: string[] | null = null;
  for (const row of bodyRows(body)) {
    if (!(col in row)) continue;
    const v = row[col];
    if (v === null || v === '') { row[col] = null; continue; }
    const ref = parseImageRef(v);
    if (!ref || ref.bucket !== bucket) return `Invalid ${col}`;
    row[col] = canonicalImageUrl(ref);
    if (caller && caller.role !== 'super_admin') {
      owned ||= await ownedCompanyIds(caller.primaryAdminId);
      const folder = ref.path.split('/')[0];
      if (ref.path.includes('/') && UUID_RE.test(folder)) {
        if (!owned.includes(folder)) return `Forbidden: ${col} does not belong to your account`;
      } else {
        const scope = table === 'companies' ? `admin_id=eq.${caller.primaryAdminId}`
          : `company_id=in.(${owned.length ? owned.join(',') : '00000000-0000-0000-0000-000000000000'})`;
        const used = await restJson(`${table}?${col}=eq.${encodeURIComponent(row[col] as string)}&${scope}&select=id&limit=1`);
        if (!used || !used.length) return `Forbidden: ${col} does not belong to your account`;
      }
    }
  }
  return null;
}

// Bounded, well-formed shifts only: whatever the browser sent, the email gets at most 60 rows of
// short text, real clock times and a real colour.
function cleanShifts(raw: unknown) {
  const rows = Array.isArray(raw) ? (raw as unknown[]).slice(0, 60) : [];
  return rows.map((r) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const st = strOf(x.startTime, 5), en = strOf(x.endTime, 5);
    const col = strOf(x.labelColor, 7);
    return { day: strOf(x.day, 60), startTime: HHMM_RE.test(st) ? st : '', endTime: HHMM_RE.test(en) ? en : '',
      note: strOf(x.note, 200), label: strOf(x.label, 60), labelColor: HEX_RE.test(col) ? col : '' };
  });
}

// The one email a person at a kiosk can ask for without an admin session: "email me my schedule".
// It is tied to that kiosk's own site, needs the employee's PIN (checked here, not in the browser),
// sends to the address on file (or, when none is on file, the address they typed, once), and is
// rate-limited so it cannot be used as a mail cannon.
const KIOSK_EMAIL_PER_EMPLOYEE_HOUR = 5;
const KIOSK_EMAIL_PER_SITE_HOUR = 60;
const EMAIL_SCHEDULE_PER_ADMIN_HOUR = 300;
const EMAIL_OTHER_PER_ADMIN_HOUR = 30;
const EMAIL_SHAPE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
async function sendKioskScheduleEmail(siteId: string, rawBody: unknown): Promise<Response> {
  const b = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  if (strOf(b.type, 40) !== 'schedule') return jsonResp({ ok: false, error: 'Unauthorized' }, 401);
  if (!(await verifySite(siteId))) return jsonResp({ ok: false, error: 'Unauthorized' }, 401);
  const empId = strOf(b.employee_id, 60);
  if (!UUID_RE.test(empId)) return jsonResp({ ok: false, error: 'Invalid employee' }, 400);
  const pin = strOf(b.pin, 8);
  if (!/^\d{4}$/.test(pin)) return jsonResp({ ok: false, error: 'PIN required' }, 400);
  // Wrong guesses are throttled exactly like the punch PIN: this check was an open PIN oracle.
  const attempt = await pinAttemptStart(siteId, empId);
  if (attempt.locked) return jsonResp({ ok: false, error: 'Too many wrong PINs. Please wait a few minutes.' }, 429);
  const emp = (await restJson(`employees?id=eq.${empId}&select=id,name,email,pin,site_id&limit=1`))?.[0];
  // Same answer for "no such employee", "employee at another site" and "wrong PIN": nothing to probe.
  if (!emp || emp.site_id !== siteId || !emp.pin || String(emp.pin) !== pin) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
  await pinAttemptClear(attempt.id);

  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const perEmp = await restJson(`audit_log?event=eq.email_sent:schedule_kiosk&filter=eq.emp:${empId}&at=gte.${since}&select=id`);
  const perSite = await restJson(`audit_log?event=eq.email_sent:schedule_kiosk&table_name=eq.site:${siteId}&at=gte.${since}&select=id`);
  if ((perEmp?.length ?? 0) >= KIOSK_EMAIL_PER_EMPLOYEE_HOUR || (perSite?.length ?? 0) >= KIOSK_EMAIL_PER_SITE_HOUR) {
    return jsonResp({ ok: false, error: 'Too many emails requested. Please try again later.' }, 429);
  }
  const onFile = strOf(emp.email, 200).toLowerCase();
  const to = onFile || strOf(b.email, 200).toLowerCase();
  if (!EMAIL_SHAPE.test(to)) return jsonResp({ ok: false, error: 'Please enter a valid email address.' }, 400);
  const payload = { email: to, name: emp.name || to, type: 'schedule', weekLabel: strOf(b.weekLabel, 60),
    shifts: cleanShifts(b.shifts), lang: b.lang === 'fr' ? 'fr' : 'en' };
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-verification`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.success !== true) return jsonResp({ ok: false, error: (data && data.error) || 'Could not send the email' }, 502);
    logAudit(null, 'email_sent:schedule_kiosk', `site:${siteId}`, 'POST', `emp:${empId}`);
    return jsonResp({ ok: true });
  } catch {
    return jsonResp({ ok: false, error: 'Could not send the email' }, 502);
  }
}

async function sendEmailAction(caller: Caller, rawBody: unknown): Promise<Response> {
  const b = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const type = strOf(b.type, 40);
  const dry = b.dry_run === true;
  const isSuper = caller.role === 'super_admin';
  const one = async (path: string) => (await restJson(path))?.[0] ?? null;
  const ownsCompany = async (companyId: unknown) =>
    isSuper || (typeof companyId === 'string' && (await ownedCompanyIds(caller.primaryAdminId)).includes(companyId));
  const me = async () => (await one(`admins?id=eq.${caller.adminId}&select=name,email,plan,created_at&limit=1`)) as
    { name?: string; email?: string; plan?: string; created_at?: string } | null;
  const lang = b.lang === 'fr' ? 'fr' : 'en';

  let payload: Record<string, unknown>;

  if (type === 'invitation') {
    const token = strOf(b.token, 60);
    if (!UUID_RE.test(token)) return jsonResp({ ok: false, error: 'Invalid invitation' }, 400);
    const inv = await one(`invitations?token=eq.${token}&select=email,role,company_id,status,expires_at&limit=1`);
    if (!inv || inv.status !== 'pending') return jsonResp({ ok: false, error: 'Invitation not found' }, 404);
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return jsonResp({ ok: false, error: 'Invitation has expired' }, 400);
    if (!(await ownsCompany(inv.company_id))) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    const co = await one(`companies?id=eq.${inv.company_id}&select=name&limit=1`);
    const m = await me();
    payload = { email: inv.email, name: inv.email, type: 'invitation', inviterName: m?.name || m?.email || 'Your administrator',
      companyName: co?.name || '', role: inv.role, token };

  } else if (type === 'employee_invite') {
    const empId = strOf(b.employee_id, 60);
    if (!UUID_RE.test(empId)) return jsonResp({ ok: false, error: 'Invalid employee' }, 400);
    const emp = await one(`employees?id=eq.${empId}&select=id,name,company_id&limit=1`);
    if (!emp) return jsonResp({ ok: false, error: 'Employee not found' }, 404);
    if (!(await ownsCompany(emp.company_id))) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    if ((await planRpc('company_has_paid_features', { p_company: emp.company_id as string })) === false) {
      return jsonResp({ ok: false, error: 'The employee portal is part of the paid plans' }, 403);
    }
    const portal = await one(`employee_portal?employee_id=eq.${empId}&select=email,invite_token,token_expires_at,status&limit=1`);
    if (!portal || portal.status !== 'invited' || !portal.invite_token || !portal.email) {
      return jsonResp({ ok: false, error: 'No pending portal invitation for this employee' }, 409);
    }
    const co = await one(`companies?id=eq.${emp.company_id}&select=name,logo_url&limit=1`);
    payload = { type: 'employee_invite', email: portal.email, name: emp.name || portal.email,
      portalUrl: `https://www.punchclock.ca/employee.html?token=${encodeURIComponent(portal.invite_token)}`,
      lang, companyName: co?.name || '', logoUrl: await emailLogoUrl(co?.logo_url) };

  } else if (type === 'join_approved' || type === 'join_denied') {
    const reqId = strOf(b.request_id, 60);
    if (!UUID_RE.test(reqId)) return jsonResp({ ok: false, error: 'Invalid request' }, 400);
    const jr = await one(`join_requests?id=eq.${reqId}&select=requester_email,requester_name,target_admin_id,status&limit=1`);
    if (!jr) return jsonResp({ ok: false, error: 'Request not found' }, 404);
    if (!(isSuper || jr.target_admin_id === caller.primaryAdminId || jr.target_admin_id === caller.adminId)) {
      return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    }
    const wanted = type === 'join_approved' ? 'approved' : 'denied';
    if (jr.status !== wanted || !jr.requester_email) return jsonResp({ ok: false, error: `This request is not ${wanted}` }, 409);
    if (type === 'join_approved') {
      const m = await me();
      payload = { email: jr.requester_email, name: jr.requester_name || jr.requester_email, type: 'join_approved', adminName: m?.name || m?.email || 'your administrator' };
    } else {
      const target = await one(`admins?id=eq.${jr.target_admin_id}&select=name&limit=1`);
      const co = await one(`companies?admin_id=eq.${jr.target_admin_id}&select=name&order=created_at.asc&limit=1`);
      payload = { email: jr.requester_email, name: jr.requester_name || jr.requester_email, type: 'join_request_denied',
        companyName: co?.name || '', adminName: target?.name || '' };
    }

  } else if (type === 'schedule') {
    const empId = strOf(b.employee_id, 60);
    if (!UUID_RE.test(empId)) return jsonResp({ ok: false, error: 'Invalid employee' }, 400);
    const emp = await one(`employees?id=eq.${empId}&select=id,name,email,company_id&limit=1`);
    if (!emp) return jsonResp({ ok: false, error: 'Employee not found' }, 404);
    if (!(await ownsCompany(emp.company_id))) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    const to = strOf(emp.email, 200).toLowerCase();
    if (!to) return jsonResp({ ok: false, error: 'This employee has no email address' }, 400);
    payload = { email: to, name: emp.name || to, type: 'schedule', weekLabel: strOf(b.weekLabel, 60), shifts: cleanShifts(b.shifts), lang };

  } else if (type === 'new_account_notification') {
    // A notice to us, built entirely from the caller's own account row, and only in the first
    // minutes after the account exists: it cannot be replayed later or aimed at anyone else.
    const m = await me();
    if (!m || !m.created_at || Date.now() - new Date(m.created_at).getTime() > 30 * 60 * 1000) {
      return jsonResp({ ok: false, error: 'Not available' }, 403);
    }
    const plan = (m.plan || 'free').toString();
    payload = { email: NOTIFY_EMAIL, name: m.name || m.email || 'New account', type: 'new_account_notification',
      userEmail: m.email || '', plan: plan.charAt(0).toUpperCase() + plan.slice(1), regType: 'New Company',
      timestamp: new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' }) };

  } else {
    return jsonResp({ ok: false, error: 'Unknown email type' }, 400);
  }

  // Rate limit per signed-in admin. Real use is a few invitations, or one schedule per employee (a
  // 60-person schedule is 60 emails), so those get a high ceiling; a stolen session or a script
  // gets neither. If the count cannot be read the email is sent: bookkeeping never blocks a customer.
  if (!dry && !isSuper) {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const recent = await restJson(`audit_log?admin_id=eq.${caller.adminId}&event=like.email_sent:*&at=gte.${since}&select=event&limit=500`);
    if (Array.isArray(recent)) {
      const schedules = recent.filter((r: { event?: string }) => r.event === 'email_sent:schedule').length;
      const others = recent.length - schedules;
      const tooMany = type === 'schedule' ? schedules >= EMAIL_SCHEDULE_PER_ADMIN_HOUR : others >= EMAIL_OTHER_PER_ADMIN_HOUR;
      if (tooMany) return jsonResp({ ok: false, error: 'Too many emails sent in the last hour. Please try again later.' }, 429);
    }
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-verification`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(dry ? { 'x-dry-run': '1' } : {}) },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.success !== true) {
      return jsonResp({ ok: false, error: (data && data.error) || 'Could not send the email' }, 502);
    }
    logAudit(caller.adminId, dry ? `email_dry_run:${type}` : `email_sent:${type}`);
    return dry ? jsonResp({ ok: true, dry: true, to: data.to, subject: data.subject, html: data.html }) : jsonResp({ ok: true });
  } catch {
    return jsonResp({ ok: false, error: 'Could not send the email' }, 502);
  }
}

// ── Kiosk PIN proof ───────────────────────────────────────────────────────────────────────────
// The PIN used to be shipped to every tablet (and to anyone holding the site id) and compared in the
// browser. Now the browser sends the PIN HERE, this function compares it against the database,
// throttles wrong guesses, and answers with a short-lived proof bound to that employee and that site.
// A kiosk punch is only accepted with a valid proof, so knowing a site id and an employee id is no
// longer enough to write punches. The proof is an HMAC under a key derived from the service key (it
// never leaves this function), so no new secret has to be stored.
// Strict kiosk mode (no PINs or emails sent to terminals, a PIN proof required for every kiosk punch)
// applies to every request from a moment in time. Before it, only clients that announce `kioskV: 2`
// get it, so tablets still running the previous page keep working while they update themselves
// (they check for a new version every 30 seconds). Pages from before this change stop punching
// after that moment until they reload. The moment is read from internal_secrets key
// 'kiosk_strict_from' (an ISO timestamp, cached for a minute) so it can be set without a redeploy;
// if the row is missing, the built-in fallback below applies, so strict mode can never stay off.
const KIOSK_STRICT_FALLBACK = Date.parse('2026-11-01T12:46:00Z');
let _strictCache = { at: 0, from: KIOSK_STRICT_FALLBACK };
async function kioskStrictFrom(): Promise<number> {
  if (Date.now() - _strictCache.at < 60_000) return _strictCache.from;
  let from = KIOSK_STRICT_FALLBACK;
  try {
    const v = (await restJson(`internal_secrets?key=eq.kiosk_strict_from&select=value&limit=1`))?.[0]?.value;
    const t = v ? Date.parse(String(v)) : NaN;
    if (Number.isFinite(t)) from = t;
  } catch { /* keep the fallback */ }
  _strictCache = { at: Date.now(), from };
  return from;
}
const PIN_PROOF_TTL_MS = 120_000;
const PIN_ATTEMPTS_PER_EMPLOYEE = 5;
const PIN_ATTEMPTS_PER_SITE = 40;
const PIN_WINDOW_MS = 10 * 60 * 1000;
let _pinKeyP: Promise<CryptoKey> | null = null;
function pinKey(): Promise<CryptoKey> {
  if (!_pinKeyP) {
    _pinKeyP = crypto.subtle.importKey('raw', new TextEncoder().encode('kiosk-pin-proof-v1:' + SERVICE_KEY),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return _pinKeyP;
}
function b64url(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function pinProofSig(empId: string, siteId: string, exp: number): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await pinKey(), new TextEncoder().encode(`${empId}.${siteId}.${exp}`)));
}
async function mintPinProof(empId: string, siteId: string): Promise<string> {
  const exp = Date.now() + PIN_PROOF_TTL_MS;
  return `${exp}.${await pinProofSig(empId, siteId, exp)}`;
}
async function verifyPinProof(proof: unknown, empId: string, siteId: string): Promise<boolean> {
  if (typeof proof !== 'string' || proof.length > 200) return false;
  const dot = proof.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(proof.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + PIN_PROOF_TTL_MS + 5000) return false;
  const want = await pinProofSig(empId, siteId, exp);
  const got = proof.slice(dot + 1);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
// Every PIN attempt is written down BEFORE it is judged (so a burst of parallel guesses cannot all
// slip under the limit) and removed again when the PIN turns out to be right, which leaves only wrong
// guesses to count. The audit_log write is awaited here, unlike the usual fire-and-forget logging.
async function pinAttemptStart(siteId: string, empId: string): Promise<{ locked: boolean; id: string | null }> {
  let id: string | null = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ admin_id: null, event: 'kiosk_pin_attempt', table_name: `site:${siteId}`, method: 'POST', filter: `emp:${empId}` }),
    });
    const rows = r.ok ? await r.json().catch(() => null) : null;
    // audit_log.id is a bigint, which arrives as a JSON number
    const rid = Array.isArray(rows) && rows[0] ? rows[0].id : null;
    id = (typeof rid === 'number' || (typeof rid === 'string' && /^\d+$/.test(rid))) ? String(rid) : null;
  } catch { /* if the log is unavailable the PIN check itself still runs */ }
  const since = new Date(Date.now() - PIN_WINDOW_MS).toISOString();
  const perEmp = await restJson(`audit_log?event=eq.kiosk_pin_attempt&filter=eq.emp:${empId}&at=gte.${since}&select=id&limit=${PIN_ATTEMPTS_PER_EMPLOYEE + 1}`);
  const perSite = await restJson(`audit_log?event=eq.kiosk_pin_attempt&table_name=eq.site:${siteId}&at=gte.${since}&select=id&limit=${PIN_ATTEMPTS_PER_SITE + 1}`);
  const locked = (perEmp?.length ?? 0) > PIN_ATTEMPTS_PER_EMPLOYEE || (perSite?.length ?? 0) > PIN_ATTEMPTS_PER_SITE;
  return { locked, id };
}
async function pinAttemptClear(id: string | null): Promise<void> {
  if (!id || !/^\d{1,18}$/.test(id)) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log?id=eq.${id}`, {
      method: 'DELETE', headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    });
  } catch { /* a leftover row only makes the throttle slightly stricter */ }
}

// ── Notifications and summaries triggered from the apps ──────────────────────────────────────
// notify-missed-punch, notify-time-off, send-period-summary and churn-survey used to be called by the
// browsers directly with the public key, so anybody could re-send mail, or make us send it, with only
// an id. Now the browser asks HERE, this function proves who is asking (admin session for their own
// company, kiosk PIN proof for the missed-punch report it has just filed, portal session for the time
// off request the employee has just filed, the single-use survey link for the survey just answered),
// reads the row itself, and only then calls the mail function with the service key. Recipients and
// content always come from the database. Every send is recorded once in audit_log, so repeating the
// same request cannot send the same mail twice.
const NOTIFY_KINDS: Record<string, { fn: string; table: string }> = {
  missed_punch: { fn: 'notify-missed-punch', table: 'missed_punch_requests' },
  time_off: { fn: 'notify-time-off', table: 'time_off' },
};
const NOTIFY_FRESH_MS = 15 * 60 * 1000;

async function markAudit(event: string, tableName: string, filter: string): Promise<string | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ admin_id: null, event, table_name: tableName, method: 'POST', filter }),
    });
    const rows = r.ok ? await r.json().catch(() => null) : null;
    const rid = Array.isArray(rows) && rows[0] ? rows[0].id : null;
    return (typeof rid === 'number' || (typeof rid === 'string' && /^\d+$/.test(rid))) ? String(rid) : null;
  } catch { return null; }
}

async function callMailFunction(fn: string, payload: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, data };
  } catch { return { ok: false, data: null }; }
}

// The sites a manager has been assigned.
async function managerSiteSet(managerId: string): Promise<Set<string>> {
  const rows = await restJson(`manager_sites?manager_id=eq.${managerId}&select=site_id`);
  return new Set((rows || []).map((r: { site_id: string }) => r.site_id));
}

async function notifyRequestAction(
  caller: Caller | null, kioskSiteId: string | null, pinProof: string | null, rawBody: unknown,
): Promise<Response> {
  const b = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const kind = strOf(b.kind, 30);
  const mode = b.mode === 'decision' ? 'decision' : 'submitted';
  const spec = NOTIFY_KINDS[kind];
  const reqId = strOf(b.request_id, 60);
  if (!spec || !UUID_RE.test(reqId)) return jsonResp({ ok: false, error: 'Invalid request' }, 400);
  const row = (await restJson(`${spec.table}?id=eq.${reqId}&select=*&limit=1`))?.[0];
  if (!row) return jsonResp({ ok: false, error: 'Request not found' }, 404);

  const fresh = row.created_at && Date.now() - new Date(row.created_at as string).getTime() < NOTIFY_FRESH_MS;
  let allowed = false;
  if (caller) {
    // A signed-in admin: the request must belong to a company of their own account (managers: a site they run).
    if (caller.role === 'super_admin') allowed = true;
    else if (typeof row.company_id === 'string' && (await ownedCompanyIds(caller.primaryAdminId)).includes(row.company_id)) {
      allowed = true;
      if (caller.role === 'manager' && row.site_id && !(await managerSiteSet(caller.adminId)).has(row.site_id as string)) allowed = false;
    }
  } else if (mode === 'submitted' && fresh && row.status === 'pending') {
    if (kind === 'missed_punch' && kioskSiteId) {
      // The report just filed at this terminal: same site, and the PIN proof of the employee who filed it.
      allowed = row.site_id === kioskSiteId && typeof row.emp_id === 'string' && TOKEN_RE.test(row.emp_id) &&
        await verifyPinProof(pinProof, row.emp_id as string, kioskSiteId);
    } else if (kind === 'time_off') {
      // The request just filed from the employee portal: the portal session must be that employee's.
      const tok = strOf(b.portal_token, 200);
      if (TOKEN_RE.test(tok) && row.requested_by === 'employee' && typeof row.emp_id === 'string') {
        const emp = await planRpc('_resolve_portal_session', { p_token: tok });
        allowed = typeof emp === 'string' && emp === row.emp_id;
      }
    }
  }
  if (!allowed) return jsonResp({ ok: false, error: 'Forbidden' }, 403);

  // One notice per request, per mode and per status (an approval and a later denial are different notices).
  const event = `notify:${kind}:${mode}`, tbl = `req:${reqId}`, flt = String(row.status ?? '');
  const prior = await restJson(`audit_log?event=eq.${event}&table_name=eq.${tbl}&filter=eq.${encodeURIComponent(flt)}&select=id&limit=1`);
  if (prior && prior.length) return jsonResp({ ok: true, skipped: 'already_sent' });
  const markId = await markAudit(event, tbl, flt);
  const out = await callMailFunction(spec.fn, { requestId: reqId, mode });
  if (!out.ok) {
    // Let the person try again: nothing was delivered.
    await pinAttemptClear(markId);
    return jsonResp({ ok: false, error: 'Could not send the notification' }, 502);
  }
  return jsonResp({ ok: true });
}

// The survey page is opened from an emailed link with a single-use token. After the answers are saved
// (submit_survey_response consumes the token), the page asks for the team copy. The text comes from the
// saved response, never from the request, and only for a survey answered in the last half hour.
async function surveyNotifyAction(rawBody: unknown): Promise<Response> {
  const b = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const tok = strOf(b.token, 200);
  if (!TOKEN_RE.test(tok)) return jsonResp({ ok: false, error: 'Invalid survey' }, 400);
  const inv = (await restJson(`survey_invites?token=eq.${tok}&select=id,status,responded_at&limit=1`))?.[0];
  if (!inv || inv.status !== 'responded' || !inv.responded_at ||
      Date.now() - new Date(inv.responded_at as string).getTime() > 30 * 60 * 1000) {
    return jsonResp({ ok: false, error: 'Forbidden' }, 403);
  }
  const prior = await restJson(`audit_log?event=eq.notify:survey&table_name=eq.invite:${inv.id}&select=id&limit=1`);
  if (prior && prior.length) return jsonResp({ ok: true, skipped: 'already_sent' });
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await restJson(`audit_log?event=eq.notify:survey&at=gte.${since}&select=id&limit=61`);
  if ((recent?.length ?? 0) > 60) return jsonResp({ ok: false, error: 'Busy, try later' }, 429);
  const resp = (await restJson(`survey_responses?invite_id=eq.${inv.id}&select=email,company_name,reason,liked,disliked,wanted_feature,rating&limit=1`))?.[0];
  if (!resp) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
  const markId = await markAudit('notify:survey', `invite:${inv.id}`, '');
  const out = await callMailFunction('churn-survey', {
    action: 'notify', email: resp.email, company: resp.company_name, reason: resp.reason,
    liked: resp.liked, disliked: resp.disliked, wanted: resp.wanted_feature, rating: resp.rating,
  });
  if (!out.ok) { await pinAttemptClear(markId); return jsonResp({ ok: false, error: 'Could not send the notification' }, 502); }
  return jsonResp({ ok: true });
}

// "Send a test summary" (payroll recipients) and "email this employee their hours". The admin must own
// the company; the function itself works out recipients and content from the database. Only the
// outcome comes back (never names or addresses), and sends are capped per admin per hour.
const PERIOD_TEST_PER_ADMIN_HOUR = 20;
const PERIOD_MANUAL_PER_ADMIN_HOUR = 300;
async function periodSummaryAction(caller: Caller, rawBody: unknown): Promise<Response> {
  const b = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  const mode = strOf(b.mode, 30);
  const isSuper = caller.role === 'super_admin';
  const startD = strOf(b.start_date, 10), endD = strOf(b.end_date, 10);
  const hasDates = startD !== '' || endD !== '';
  if (hasDates) {
    if (!DATE_RE.test(startD) || !DATE_RE.test(endD) || startD > endD ||
        (Date.parse(endD) - Date.parse(startD)) / 86400000 > 400) {
      return jsonResp({ ok: false, error: 'Invalid dates' }, 400);
    }
  }
  const owns = async (companyId: unknown) =>
    isSuper || (typeof companyId === 'string' && (await ownedCompanyIds(caller.primaryAdminId)).includes(companyId));
  let payload: Record<string, unknown>;
  if (mode === 'test_recipients') {
    // Payroll recipients are an owner/admin matter; the panel is hidden from managers.
    if (caller.role === 'manager') return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    const coId = strOf(b.company_id, 60);
    if (!TOKEN_RE.test(coId) || !(await owns(coId))) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    payload = { test_recipients: true, company_id: coId, ...(hasDates ? { start_date: startD, end_date: endD } : {}) };
  } else if (mode === 'manual') {
    const empId = strOf(b.emp_id, 60);
    if (!TOKEN_RE.test(empId) || !hasDates) return jsonResp({ ok: false, error: 'Invalid request' }, 400);
    const emp = (await restJson(`employees?id=eq.${empId}&select=id,company_id,site_id&limit=1`))?.[0];
    if (!emp || !(await owns(emp.company_id))) return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    if (caller.role === 'manager' && !(emp.site_id && (await managerSiteSet(caller.adminId)).has(emp.site_id as string))) {
      return jsonResp({ ok: false, error: 'Forbidden' }, 403);
    }
    payload = { manual: true, emp_id: empId, start_date: startD, end_date: endD };
  } else {
    return jsonResp({ ok: false, error: 'Unknown request' }, 400);
  }
  if (!isSuper) {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const cap = mode === 'manual' ? PERIOD_MANUAL_PER_ADMIN_HOUR : PERIOD_TEST_PER_ADMIN_HOUR;
    const recent = await restJson(`audit_log?admin_id=eq.${caller.adminId}&event=eq.period_summary:${mode}&at=gte.${since}&select=id&limit=${cap + 1}`);
    if ((recent?.length ?? 0) >= cap) return jsonResp({ ok: false, success: false, error: 'Too many sends in the last hour. Please try again later.' }, 429);
  }
  logAudit(caller.adminId, `period_summary:${mode}`);
  const out = await callMailFunction('send-period-summary', payload);
  const d = out.data && typeof out.data === 'object' ? out.data : null;
  if (!d) return jsonResp({ ok: false, success: false, error: 'Could not send the summary' }, 502);
  if (d.success === false) {
    const msg = typeof d.error === 'string' ? d.error.slice(0, 160) : '';
    const known = /^(Automated email reports are part of the paid plans|Employee has no email address)$/.test(msg);
    return jsonResp({ ok: false, success: false, error: known ? msg : 'Send failed' });
  }
  if (mode === 'manual') return jsonResp({ ok: true, success: true, manual_sent: true });
  const errs = Array.isArray(d.errors) ? d.errors.slice(0, 3).map(() => 'Some recipients could not be reached') : [];
  return jsonResp({ ok: true, success: errs.length === 0, test: true, period: d.period || null, recipientsSent: d.recipientsSent || 0, errors: errs });
}

// ── Role rules for writes ────────────────────────────────────────────────────────────────────
// The tenant scope says WHICH ROWS a signed-in admin may touch (their own account's). It said nothing
// about WHO inside the account may do what, so the lowest role could do anything the owner could: a
// manager could rewrite the owner's email (then reset the password to the new address), promote
// themselves, delete admins or companies. The browser hides those controls from managers; this is the
// server enforcing the same rules, so a hand-made request gets no further than the buttons do.
//
//   owner       the primary admin (no parent): everything in their account
//   co-admin    role 'admin' with a parent: edits and removes the account's other admins and managers
//               (as the Admins tab lets them), but never the owner, and never themselves beyond profile
//   manager     employees at their assigned sites, schedules, punches, time off; reads the rest. No
//               admins, invitations, sites, companies, recipients, manager assignments.
// Super admins are exempt (they never reach this function).
const SELF_ADMIN_FIELDS = new Set(['name', 'mute_manager_alerts', 'mute_approval_emails', 'last_login', 'last_seen_announcement_at', 'lang', 'weekly_digest']);
const CHILD_ADMIN_FIELDS = new Set(['name', 'role', 'status']);
const KIOSK_DEVICE_FIELDS = new Set(['revoked', 'label']);
const PORTAL_WRITE_FIELDS = new Set(['employee_id', 'email', 'invite_token', 'token_expires_at', 'status']);
const JOIN_REQUEST_FIELDS = new Set(['status']);

function bodyRows(body: unknown): Record<string, unknown>[] {
  return Array.isArray(body) ? (body as Record<string, unknown>[]).filter(r => r && typeof r === 'object')
    : (body && typeof body === 'object' ? [body as Record<string, unknown>] : []);
}
// The filter with its projection and paging removed, for reading which rows a write would hit.
function targetFilter(filter: string): string {
  return filter.split('&').filter(p => p && !/^(select|order|limit|offset)=/.test(safeDecode(p))).join('&');
}
const JR_NAME_MAX = 100, JR_EMAIL_MAX = 200;
// join_requests rows are shown to the super admin and mailed from; whoever writes one gets the same
// shape checks (super admins included): short text, no markup characters, real addresses, real ids.
function joinRequestShapeError(row: Record<string, unknown>): string | null {
  for (const k of ['requester_name']) {
    const v = row[k];
    if (v != null && (typeof v !== 'string' || v.length > JR_NAME_MAX || /[<>\u0000-\u001f]/.test(v))) return k;
  }
  for (const k of ['requester_email', 'target_admin_email']) {
    const v = row[k];
    if (v != null && (typeof v !== 'string' || v.length > JR_EMAIL_MAX || !EMAIL_SHAPE.test(v))) return k;
  }
  for (const k of ['requester_id', 'target_admin_id']) {
    const v = row[k];
    if (v != null && (typeof v !== 'string' || !UUID_RE.test(v))) return k;
  }
  if (row.status != null && !['pending', 'approved', 'denied'].includes(String(row.status))) return 'status';
  return null;
}

// Returns a refusal message, or null when the caller's role may make this write.
async function roleViolation(
  table: string, method: string, body: unknown, filter: string, caller: Caller,
): Promise<string | null> {
  const isMgr = caller.role === 'manager';
  const rows = bodyRows(body);
  const keysIn = (allowed: Set<string>) => rows.every(r => Object.keys(r).every(k => allowed.has(k)));

  switch (table) {
    case 'admins': {
      // Accounts are made by registration, invitation and the super admin: never by a row insert.
      if (method === 'POST') return 'Forbidden: accounts are created by invitation';
      const targets = await restJson(`admins?${targetFilter(filter)}&select=id,role,parent_admin_id&limit=100`);
      if (targets === null) return 'Forbidden';
      for (const t of targets) {
        if (t.id === caller.adminId) {
          if (method === 'DELETE') return 'Forbidden: you cannot delete your own account here';
          if (!keysIn(SELF_ADMIN_FIELDS)) return 'Forbidden: that field of your account cannot be changed from the app';
        } else if (t.id === caller.primaryAdminId) {
          return 'Forbidden: the account owner cannot be changed from here';
        } else if (t.parent_admin_id === caller.primaryAdminId && !isMgr) {
          if (method === 'PATCH') {
            if (rows.length !== 1 || !keysIn(CHILD_ADMIN_FIELDS)) return 'Forbidden: that field cannot be changed';
            const r = rows[0];
            if (r.role !== undefined && !['admin', 'manager'].includes(String(r.role))) return 'Forbidden: invalid role';
            if (r.status !== undefined && !['active', 'suspended'].includes(String(r.status))) return 'Forbidden: invalid status';
          }
        } else {
          return 'Forbidden: only the account owner or an admin can manage admins';
        }
      }
      return null;
    }
    case 'manager_sites':
    case 'sites':
    case 'companies':
    case 'report_recipients':
      if (isMgr) return 'Forbidden: managers cannot change this';
      if (table === 'companies') {
        if (method === 'POST') {
          // A company belongs to the account, not to whichever co-admin typed it in.
          for (const r of rows) if (r.admin_id !== undefined && r.admin_id !== caller.primaryAdminId) r.admin_id = caller.primaryAdminId;
        } else if (method === 'PATCH') {
          for (const r of rows) if (r.admin_id !== undefined && r.admin_id !== caller.primaryAdminId) return 'Forbidden: a company cannot be moved to another admin';
        }
      }
      return null;
    case 'invitations': {
      if (isMgr) return 'Forbidden: managers cannot invite';
      if (method === 'PATCH') return 'Forbidden: an invitation is cancelled by deleting it';
      if (method === 'POST') {
        for (const r of rows) {
          if (!['admin', 'manager'].includes(String(r.role))) return 'Forbidden: invalid role';
          if (r.status !== undefined && r.status !== 'pending') return 'Forbidden: invalid status';
          if (r.inviter_admin_id !== undefined && r.inviter_admin_id !== caller.adminId && r.inviter_admin_id !== caller.primaryAdminId) return 'Forbidden: invitations are sent as yourself';
        }
      }
      return null;
    }
    case 'kiosk_devices':
      // Tablets register themselves through kiosk_device_checkin; the app only revokes or renames.
      if (method !== 'PATCH') return 'Forbidden';
      return keysIn(KIOSK_DEVICE_FIELDS) ? null : 'Forbidden: that field cannot be changed';
    case 'employee_portal':
      if (method === 'POST' || method === 'PATCH') {
        if (!keysIn(PORTAL_WRITE_FIELDS)) return 'Forbidden: that field cannot be changed';
        if (rows.some(r => r.status !== undefined && !['invited', 'revoked'].includes(String(r.status)))) return 'Forbidden: invalid status';
      }
      return null;
    case 'join_requests':
      if (method === 'POST') return 'Forbidden';
      if (method === 'PATCH') {
        if (!keysIn(JOIN_REQUEST_FIELDS)) return 'Forbidden: that field cannot be changed';
        if (rows.some(r => !['approved', 'denied'].includes(String(r.status)))) return 'Forbidden: invalid status';
      }
      return null;
    case 'employees': {
      if (!isMgr) return null;
      if (method === 'DELETE') return 'Forbidden: managers cannot delete employees';
      const mine = await managerSiteSet(caller.adminId);
      for (const r of rows) {
        if (method === 'POST' && r.site_id === undefined) return 'Forbidden: choose one of your sites';
        if (r.site_id !== undefined && !(typeof r.site_id === 'string' && mine.has(r.site_id))) return 'Forbidden: that site is not assigned to you';
      }
      if (method === 'PATCH') {
        const targets = await restJson(`employees?${targetFilter(filter)}&select=id,site_id&limit=1000`);
        if (targets === null) return 'Forbidden';
        for (const t of targets) if (!(typeof t.site_id === 'string' && mine.has(t.site_id))) return 'Forbidden: that employee is not at one of your sites';
      }
      return null;
    }
    default:
      return null;
  }
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
      kioskSiteId: string | null, action: string | null,
      pinProof: string | null, kioskStrict: boolean;
  try {
    const p = await req.json();
    table        = p.table;
    method       = p.method;
    filter       = p.filter || '';
    body         = p.body   || null;
    sessionToken = p.sessionToken || null;
    kioskSiteId  = p.kioskSiteId  || null;
    action       = p.action || null;
    pinProof     = typeof p.pinToken === 'string' ? p.pinToken : null;
    kioskStrict  = p.kioskV === 2 || Date.now() >= await kioskStrictFrom();
  } catch {
    return errResp('Invalid request body', 400);
  }
  // ── Request-shape validation (security) ──────────────────────────────────────────────────────
  // `method` used to be compared with exact upper-case strings below, so any other spelling
  // ('post', 'get', 'delete') skipped the auth gate, the protected-table gate and the tenant scoping
  // but was still forwarded upstream with the service key (fetch normalises the case). Normalise it
  // once and refuse anything outside the four verbs the apps use.
  if (typeof method === 'string') method = method.toUpperCase();
  // action requests don't need table/method
  if (!action && (!table || !method)) return errResp('Missing table or method', 400);
  if (!action && !ALLOWED_METHODS.has(method)) return errResp('Method not allowed', 405);
  if (!action && (typeof table !== 'string' || !TABLE_NAME_RE.test(table))) return errResp('Invalid table', 400);
  // A literal '#' ends the URL's query, so everything appended after it (the tenant scope!) would
  // be dropped from the upstream request. Control characters have no place in a filter either.
  if (typeof filter !== 'string' || filter.length > 8000 || /[#\u0000-\u001f\u007f]/.test(filter)) {
    return errResp('Invalid filter', 400);
  }
  filter = sanitizeSelect(filter);
  // Identifiers that are interpolated into upstream URLs must be plain tokens, never query syntax.
  if (sessionToken !== null && (typeof sessionToken !== 'string' || !TOKEN_RE.test(sessionToken))) sessionToken = null;
  if (kioskSiteId !== null && (typeof kioskSiteId !== 'string' || !TOKEN_RE.test(kioskSiteId))) return errResp('Unauthorized', 401);

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

  // A person at a kiosk proves their PIN to the server (see "Kiosk PIN proof" above). The answer for a
  // wrong PIN, an unknown employee, an employee of another site and an employee without a PIN is the
  // same, so there is nothing to probe; repeated wrong guesses lock that employee for a few minutes.
  if (action === 'kiosk_verify_pin') {
    if (caller || !kioskSiteId) return errResp('Unauthorized', 401);
    if (!(await verifySite(kioskSiteId))) return errResp('Unauthorized', 401);
    const vb = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const vEmp = strOf(vb.employee_id, 60), vPin = strOf(vb.pin, 8);
    if (!UUID_RE.test(vEmp) || !/^\d{4}$/.test(vPin)) return jsonResp({ ok: false, error: 'invalid' }, 400);
    const attempt = await pinAttemptStart(kioskSiteId, vEmp);
    if (attempt.locked) return jsonResp({ ok: false, locked: true, error: 'Too many wrong PINs. Please wait a few minutes.' }, 429);
    const emp = (await restJson(`employees?id=eq.${vEmp}&select=id,site_id,pin&limit=1`))?.[0];
    if (!emp || emp.site_id !== kioskSiteId || !emp.pin || String(emp.pin) !== vPin) return jsonResp({ ok: false, error: 'incorrect' }, 200);
    await pinAttemptClear(attempt.id);
    return jsonResp({ ok: true, proof: await mintPinProof(vEmp, kioskSiteId), ttl: PIN_PROOF_TTL_MS });
  }

  // A terminal's one read of its site, company and employees. The database function returns whole rows; the
  // photo and logo urls in them are swapped for short-lived signed ones here, because the buckets are private.
  if (action === 'kiosk_bootstrap') {
    if (caller || !kioskSiteId || !UUID_RE.test(kioskSiteId)) return errResp('Unauthorized', 401);
    const br = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_kiosk_bootstrap_v2`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_site_id: kioskSiteId }),
    });
    const boot = await br.json().catch(() => null);
    if (!br.ok || !boot || typeof boot !== 'object') return errResp('Could not load this terminal', 502);
    if (boot.ok) {
      if (boot.company && typeof boot.company === 'object') await signImageFields([boot.company], 'logo_url');
      if (Array.isArray(boot.employees)) await signImageFields(boot.employees, 'photo_url');
    }
    return jsonResp(boot);
  }

  if (action === 'send_email') {
    if (caller) return await sendEmailAction(caller, body);
    if (kioskSiteId) return await sendKioskScheduleEmail(kioskSiteId, body);
    return errResp('Unauthorized', 401);
  }

  // Notices about a request that was just filed or decided (missed punch, time off), the team copy of a
  // survey answer, and the payroll / employee hours e-mails. See the section above for who may ask.
  if (action === 'notify_request') return await notifyRequestAction(caller, kioskSiteId, pinProof, body);
  if (action === 'survey_notify') return await surveyNotifyAction(body);
  if (action === 'send_period_summary') {
    if (!caller) return errResp('Unauthorized', 401);
    return await periodSummaryAction(caller, body);
  }

  // Demoting a manager used to be a public RPC that trusted a caller id sent by the browser. Now the
  // caller is the signed-in admin of this session; the database function still decides whether the
  // manager belongs to that admin's account.
  if (action === 'demote_manager') {
    if (!caller) return errResp('Unauthorized', 401);
    if (caller.role === 'manager') return errResp('Forbidden', 403);
    const mgrId = (body as Record<string, unknown> | null)?.manager_id;
    if (typeof mgrId !== 'string' || !UUID_RE.test(mgrId)) return errResp('Invalid manager', 400);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/demote_manager_to_employee`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_caller_id: caller.adminId, p_manager_id: mgrId }),
    });
    const out = await r.json().catch(() => null);
    if (!r.ok || !out) return errResp('Could not update this manager', 502);
    if (out.ok) logAudit(caller.adminId, 'demote_manager', `admins:${mgrId}`);
    return jsonResp(out);
  }

  // An `action` that none of the handlers above recognised must stop here. It used to fall through
  // into the table path below with whatever method/table came along in the same body.
  if (action) return errResp('Unknown action', 400);

  // ── Table allowlist: deny by default ─────────────────────────────────────────────────────────
  // The gates below only knew about PROTECTED_TABLES; any other table was forwarded untouched. That
  // left `admin_sessions` (live admin session tokens, super admin included), `email_codes` (reset
  // and registration code hashes) and `audit_log` readable by anyone holding the public anon key,
  // and writable by any signed-in admin. The app reads and writes exactly the tables listed in
  // PROTECTED_TABLES, plus the public announcements feed; nothing else is reachable from here.
  // Server-side actions (sessions, codes) use the service key directly and never come through this
  // path. Anything new must be added to the list on purpose.
  if (!APP_TABLES.has(table)) {
    return errResp('Forbidden', 403);
  }

  // ── Auth gate: writes (POST/PATCH/DELETE) — deny by default ──
  // Without this, any holder of the public anon key could insert/update/delete arbitrary
  // rows via the service-role forward below. Allow only an authenticated admin, or a
  // narrowly-scoped kiosk insert. (Action requests are handled earlier and never reach here.)
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    // Announcements are a global broadcast feed (not tenant data) -- read by every admin, but
    // authored only by Meissam. Checked first since the tenant-payload validation below has
    // nothing to say about a table with no company/site/employee columns.
    if (table === 'announcements' && (!caller || caller.role !== 'super_admin')) {
      return errResp('Unauthorized', 401);
    }
    if (table === 'work_labels' && caller && caller.role !== 'super_admin') {
      // Managing labels is an owner/admin task, and the feature belongs to the Scheduling add-on.
      if (caller.role === 'manager') return errResp('Forbidden: managers cannot manage work labels', 403);
      if (!(await schedulingActive(caller.primaryAdminId))) {
        return errResp('Forbidden: work labels are part of the Scheduling add-on', 403);
      }
    }
    if (authedAdminId) {
      // Authenticated admin — allowed, but the payload must not point at another tenant.
      // Super admins are deliberately unscoped, matching the read path.
      if (caller && caller.role !== 'super_admin' && (method === 'POST' || method === 'PATCH')) {
        const bad = await validateWritePayload(table, body, caller);
        if (bad) {
          logAudit(authedAdminId,
            bad.reason === 'entitlement' ? 'entitlement_write_blocked'
              : bad.reason === 'plan' ? 'plan_write_blocked' : 'cross_tenant_write_blocked',
            table, method, bad.field);
          return errResp(bad.reason === 'entitlement'
            ? `Forbidden: ${bad.field} cannot be changed from the app`
            : bad.reason === 'plan'
              ? `Forbidden: ${bad.field} is not included in your plan`
              : `Forbidden: ${bad.field} does not belong to your account`, 403);
        }
      }
    } else if (
      kioskSiteId &&
      method === 'POST' &&
      (table === 'punches' || table === 'missed_punch_requests' || table === 'visitors') &&
      !!body && typeof body === 'object' &&
      (body as Record<string, unknown>).site_id === kioskSiteId
    ) {
      // Kiosk clock-punch / missed-punch / visitor check-in insert, scoped to the kiosk's own site.
      if (!(await verifySite(kioskSiteId))) return errResp('Unauthorized', 401);
      // A punch may only carry a label from the site's own company.
      const punchLabel = (body as Record<string, unknown>).label_id;
      if (table === 'punches' && punchLabel != null && !(await kioskLabelBelongs(kioskSiteId, String(punchLabel)))) {
        return errResp("Forbidden: that label does not belong to this site's company", 403);
      }
      // The employee on a kiosk punch / missed-punch must really work at THIS site, and the company
      // is taken from the site, never from the request. Without this, anyone holding one valid site
      // id could write punches for any employee id they had seen, in any company.
      if (table === 'punches' || table === 'missed_punch_requests') {
        const kb = body as Record<string, unknown>;
        const empId = kb.emp_id;
        if (typeof empId !== 'string' || !TOKEN_RE.test(empId)) return errResp('Forbidden: employee does not belong to this site', 403);
        const emp = (await restJson(`employees?id=eq.${empId}&select=id,site_id,company_id&limit=1`))?.[0];
        if (!emp || emp.site_id !== kioskSiteId) return errResp('Forbidden: employee does not belong to this site', 403);
        if (kb.company_id !== undefined && kb.company_id !== null && kb.company_id !== emp.company_id) {
          return errResp('Forbidden: employee does not belong to this site', 403);
        }
        if (kb.company_id === undefined && table === 'punches') kb.company_id = emp.company_id;
        // ...and the person at the terminal must have just proved that employee's PIN to the server.
        if ((kioskStrict || pinProof) && !(await verifyPinProof(pinProof, empId, kioskSiteId))) return errResp('PIN required', 401);
      }

    } else if (
      kioskSiteId &&
      method === 'PATCH' &&
      table === 'visitors' &&
      filter.split('&').includes(`site_id=eq.${kioskSiteId}`) &&
      !!body && typeof body === 'object' &&
      Object.keys(body as Record<string, unknown>).every(k => VISITOR_CHECKOUT_FIELDS.has(k))
    ) {
      // Kiosk visitor check-OUT. The filter must itself carry site_id=eq.<this kiosk's site> as
      // one of its clauses — PostgREST ANDs it with whatever else is filtered on (id=eq.<visit>),
      // so even a spoofed kioskSiteId can only ever match rows that are actually at that site;
      // it can't move a checkout onto a different site's visit. The field allowlist above is the
      // other half: this path may flip checked_out_at and nothing else about who the visitor is.
      if (!(await verifySite(kioskSiteId))) return errResp('Unauthorized', 401);

    } else {
      return errResp('Unauthorized', 401);
    }
    // Audit the authorized admin write (kiosk inserts are intentionally not logged here).
    if (authedAdminId) logAudit(authedAdminId, 'write', table, method, filter);
  }

  // ── Auth gate: GET on protected tables requires one of three valid paths ──
  let kioskLabelMode = 'off';
  if (method === 'GET' && PROTECTED_TABLES.has(table)) {

    if (authedAdminId) {
      // Path 1 — authenticated admin (token or, during transition, legacy admin id)

    } else if (kioskSiteId && (table === 'employees' || table === 'punches' || table === 'shifts' || table === 'visitors')) {
      // Path 2 — kiosk: verify site exists, then force site_id filter so the kiosk can only
      // read its own site's employees and punches (the latter drives the clocked-in board).
      // 'shifts' is included because an employee at the terminal can PIN in to have their own
      // schedule emailed; the forced filter keeps that to the terminal's own site. 'visitors' is
      // included so the terminal can show who from this site is currently checked in.
      const validSite = await verifySite(kioskSiteId);
      if (!validSite) return errResp('Unauthorized', 401);
      const clientFilter = filter;
      if (table === 'punches') {
        const recent = await kioskRecentPunches(kioskSiteId);
        if (recent) return new Response(JSON.stringify(recent), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      filter = `site_id=eq.${kioskSiteId}`;
      // The forced filter above replaces whatever the kiosk asked for, including its ordering.
      // PostgREST caps a response at 1000 rows, so once a site passed ~1000 punches an unordered
      // read returned an arbitrary 1000 in table order — admin-added OUTs (inserted later) fell
      // past the cut and the board showed people clocked in who had long since left. Newest
      // first guarantees every employee's latest punch is inside the window.
      if (table === 'punches') filter += '&order=punched_at.desc&limit=1000';
      else if (table === 'visitors') filter += '&order=checked_in_at.desc&limit=500';
      const narrowing = kioskNarrowing(table, clientFilter);
      if (narrowing) filter += '&' + narrowing;

    } else if (kioskSiteId && table === 'work_labels') {
      // A terminal may see its own company's active labels, and only when the account has the
      // Scheduling add-on AND the company has switched labels on at clock-in. Otherwise an empty
      // list, so a terminal that isn't using labels behaves exactly as it always has.
      const lc = await kioskLabelContext(kioskSiteId);
      if (!lc) return errResp('Unauthorized', 401);
      if (!lc.addon || lc.mode === 'off') {
        return new Response('[]', { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      kioskLabelMode = lc.mode;
      filter = `company_id=eq.${lc.companyId}&active=eq.true&order=sort_order.asc,name.asc`;

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
  // Inserts and updates are validated separately (validateWritePayload: every tenant-bearing column in
  // the body must point at the caller's own account) and by role (roleViolation) before forwarding.
  // Pre-auth lookups and kiosk paths have no caller and are unaffected.
  if (caller && caller.role !== 'super_admin' &&
      (method === 'GET' || method === 'PATCH' || method === 'DELETE') &&
      (COMPANY_SCOPED.has(table) || table === 'companies' || table === 'admins' ||
       table === 'availability' || table === 'employee_portal' ||
       table === 'manager_sites' || table === 'join_requests')) {
    if (table === 'availability' || table === 'employee_portal') {
      // Neither table has a company_id column — both hang off employee_id — so scope through
      // the caller's employees. An empty list yields a sentinel that matches nothing, so the
      // failure mode is "no rows" rather than "everyone's rows".
      const empIds = await ownedEmployeeIds(await ownedCompanyIds(caller.primaryAdminId));
      const scope = `employee_id=in.(${empIds.length ? empIds.join(',') : '00000000-0000-0000-0000-000000000000'})`;
      filter = filter ? `${filter}&${scope}` : scope;
    } else if (table === 'manager_sites') {
      // Manager assignments hang off sites: only those at the caller's own account's sites.
      const cs = await ownedCompanyIds(caller.primaryAdminId);
      const siteList = cs.length ? [...await idList(`sites?company_id=in.(${cs.join(',')})&select=id`)] : [];
      const scope = `site_id=in.(${siteList.length ? siteList.join(',') : '00000000-0000-0000-0000-000000000000'})`;
      filter = filter ? `${filter}&${scope}` : scope;
    } else if (table === 'join_requests') {
      // Access requests: only those aimed at this account (or filed by the caller).
      const scope = `or=(target_admin_id.eq.${caller.primaryAdminId},target_admin_id.eq.${caller.adminId},requester_id.eq.${caller.adminId})`;
      filter = filter ? `${filter}&${scope}` : scope;
    } else {
      const owned = (COMPANY_SCOPED.has(table) || table === 'companies')
        ? await ownedCompanyIds(caller.primaryAdminId) : [];
      const scope = tenantScopeFilter(table, caller, owned);
      if (scope) filter = filter ? `${filter}&${scope}` : scope;
    }
  }

  // ── Role rules and shape checks for writes (see roleViolation) ───────────────
  if (authedAdminId && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    if (caller && caller.role !== 'super_admin') {
      const denied = await roleViolation(table, method, body, filter, caller);
      if (denied) {
        logAudit(authedAdminId, 'role_write_blocked', table, method, denied.slice(0, 100));
        return errResp(denied, 403);
      }
    }
    if (table === 'join_requests' && method !== 'DELETE') {
      for (const r of bodyRows(body)) {
        const badField = joinRequestShapeError(r);
        if (badField) return errResp(`Invalid ${badField}`, 400);
      }
    }
  }

  // photo_url / logo_url: back to the stored form, and only an object this account may use (see above).
  if (authedAdminId && (method === 'POST' || method === 'PATCH') && IMG_COL_OF[table]) {
    const imgBad = await normaliseImageWrite(table, body, caller);
    if (imgBad) return errResp(imgBad, imgBad.startsWith('Forbidden') ? 403 : 400);
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
    let upstreamStatus: number;
    let text: string;
    if (method === 'GET') {
      const paged = await getAllRows(table, filter, upstreamHeaders);
      upstreamStatus = paged.status;
      text = paged.text;
    } else {
      const upstream = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: body != null ? JSON.stringify(body) : undefined,
      });
      upstreamStatus = upstream.status;
      text = await upstream.text();
    }

    // 204 No Content — must not have a body (HTTP spec)
    if (upstreamStatus === 204 || !text) {
      return new Response(null, {
        status: upstreamStatus,
        headers: CORS,
      });
    }

    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    // Strip sensitive fields from every admins response, not just GET. PATCH is sent back with
    // Prefer: return=representation, so renaming a co-admin was handing the caller that person's
    // bcrypt hash -- the same secret the GET path has always been careful to remove.
    if (table === 'admins' && Array.isArray(data)) {
      data = stripAdminRows(data, authedAdminId);
      if (!authedAdminId) data = preAuthAdminRows(data, filter);
    }
    if (table === 'employee_portal' && Array.isArray(data)) {
      data = stripPortalRows(data);
    }
    // Employee photos and company logos live in private buckets: reads (and the rows a write sends back)
    // carry short-lived signed urls, never the bare storage address.
    if (IMG_COL_OF[table] && Array.isArray(data) && upstreamStatus < 300) {
      await signImageFields(data as Record<string, unknown>[], IMG_COL_OF[table]);
    }
    // A terminal learns who works at its site, never their PIN or email: it only needs to know whether
    // each of them has one (the PIN itself is checked by kiosk_verify_pin).
    if (table === 'employees' && kioskSiteId && !authedAdminId && kioskStrict && Array.isArray(data)) {
      data = data.map((e: any) => {
        const { pin, email, ...rest } = e;
        return { ...rest, has_pin: !!pin, has_email: !!email };
      });
    }
    // A terminal has no other way to learn the company's "labels at clock-in" setting, so it rides
    // along on each label it is allowed to see.
    if (table === 'work_labels' && kioskSiteId && !authedAdminId && Array.isArray(data)) {
      data = data.map((l: any) => ({ ...l, punch_label_mode: kioskLabelMode }));
    }

    return new Response(JSON.stringify(data), {
      status: upstreamStatus,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch {
    return errResp('Internal server error');
  }
});
