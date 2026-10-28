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

    // admin-ish references must stay inside the caller's own account
    for (const key of ['admin_id', 'inviter_admin_id', 'manager_id', 'parent_admin_id', 'reviewed_by']) {
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
  const emp = (await restJson(`employees?id=eq.${empId}&select=id,name,email,pin,site_id&limit=1`))?.[0];
  // Same answer for "no such employee", "employee at another site" and "wrong PIN": nothing to probe.
  if (!emp || emp.site_id !== siteId || String(emp.pin) !== pin) return jsonResp({ ok: false, error: 'Forbidden' }, 403);

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
      lang, companyName: co?.name || '', logoUrl: co?.logo_url || '' };

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

  if (action === 'send_email') {
    if (caller) return await sendEmailAction(caller, body);
    if (kioskSiteId) return await sendKioskScheduleEmail(kioskSiteId, body);
    return errResp('Unauthorized', 401);
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
  // Inserts are not yet tenant-validated here (lowest-damage vector; tracked as follow-up).
  // Pre-auth lookups and kiosk paths have no caller and are unaffected.
  if (caller && caller.role !== 'super_admin' &&
      (method === 'GET' || method === 'PATCH' || method === 'DELETE') &&
      (COMPANY_SCOPED.has(table) || table === 'companies' || table === 'admins' ||
       table === 'availability' || table === 'employee_portal')) {
    if (table === 'availability' || table === 'employee_portal') {
      // Neither table has a company_id column — both hang off employee_id — so scope through
      // the caller's employees. An empty list yields a sentinel that matches nothing, so the
      // failure mode is "no rows" rather than "everyone's rows".
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
      data = stripAdminRows(data, authedAdminId, filter);
    }
    if (table === 'employee_portal' && Array.isArray(data)) {
      data = stripPortalRows(data);
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
