// notify-time-off — Supabase Edge Function
// Given a time_off row id, resolves recipients server-side and sends TWO emails:
// (A) approvers (account owner + active co-admins + managers of that site) get a "needs review"
// notice; (B) the requesting employee gets a confirmation. Mirrors notify-missed-punch, including
// the rule that recipient resolution is authoritative here and never trusted from the caller.
// JWT verification: OFF.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  'https://www.punchclock.ca',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function rest(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

async function sendContact(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-contact`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { console.error('send-contact failed', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('send-contact threw', (e as Error)?.message || e); return false; }
}

const KIND_LABEL: Record<string, string> = {
  vacation: 'Vacation / Vacances',
  sick:     'Sick / Maladie',
  personal: 'Personal / Personnel',
  unpaid:   'Unpaid / Sans solde',
  other:    'Other / Autre',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let requestId: string;
  try { requestId = (await req.json()).requestId; }
  catch { return json({ error: 'Invalid body' }, 400); }
  if (!requestId) return json({ error: 'Missing requestId' }, 400);

  try {
    const row = (await rest(`time_off?id=eq.${requestId}&select=*&limit=1`))[0];
    if (!row) return json({ error: 'Request not found' }, 404);
    // Only unreviewed employee requests generate a "needs review" notice. An absence an admin
    // entered directly is already decided and must not mail anybody.
    if (row.status !== 'pending' || row.requested_by !== 'employee') {
      return json({ ok: true, skipped: 'not a pending employee request' });
    }

    const coName = row.company_id ? ((await rest(`companies?id=eq.${row.company_id}&select=name`))[0]?.name || '—') : '—';
    const siteName = row.site_id ? ((await rest(`sites?id=eq.${row.site_id}&select=name`))[0]?.name || '—') : '—';
    const days = Math.round(
      (new Date(row.end_date + 'T00:00:00').getTime() - new Date(row.start_date + 'T00:00:00').getTime()) / 86400000
    ) + 1;
    const dates = row.end_date !== row.start_date ? `${row.start_date} → ${row.end_date}` : row.start_date;
    const details =
      `Employee: ${row.emp_name}\n` +
      `Company: ${coName}\n` +
      `Site: ${siteName}\n` +
      `Type: ${KIND_LABEL[row.kind] || row.kind}\n` +
      `Dates: ${dates}\n` +
      `Days: ${days}\n` +
      (row.reason ? `Reason: ${row.reason}\n` : '');

    // ---- Approvers: account owner + active co-admins + managers of that site ----
    const approvers = new Set<string>();
    if (row.company_id) {
      const adminId = (await rest(`companies?id=eq.${row.company_id}&select=admin_id`))[0]?.admin_id;
      if (adminId) {
        (await rest(`admins?id=eq.${adminId}&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
        (await rest(`admins?parent_admin_id=eq.${adminId}&status=eq.active&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
      }
    }
    if (row.site_id) {
      const mgrIds = (await rest(`manager_sites?site_id=eq.${row.site_id}&select=manager_id`)).map(m => m.manager_id).filter(Boolean);
      if (mgrIds.length) {
        (await rest(`admins?id=in.(${mgrIds.join(',')})&status=eq.active&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
      }
    }

    let employeeEmail: string | null = null;
    if (row.emp_id) {
      const e = (await rest(`employees?id=eq.${row.emp_id}&select=email`))[0];
      if (e?.email) employeeEmail = e.email.toLowerCase();
    }
    // An employee who is also an admin must not receive the approver copy as well.
    if (employeeEmail) approvers.delete(employeeEmail);

    const approverList = [...approvers];
    let approverSent = false, employeeSent = false;

    if (approverList.length) {
      approverSent = await sendContact({
        type: 'time_off',
        name: row.emp_name,
        email: 'noreply@punchclock.ca',
        subject: `[Time Off Request] ${row.emp_name} — ${dates}`,
        message:
          `A time off request has been submitted and needs your review.\n\n` +
          details +
          `\nNothing has been approved yet. Open PunchClock Pro → Time Off to approve or decline.`,
        companyId: row.company_id, companyName: coName,
        recipients: approverList,
      });
    } else {
      console.warn('notify-time-off: no approver recipients for', requestId);
    }

    if (employeeEmail) {
      employeeSent = await sendContact({
        type: 'time_off',
        name: row.emp_name,
        email: 'noreply@punchclock.ca',
        subject: `Your time off request was received — ${dates}`,
        message:
          `Hi ${row.emp_name},\n\n` +
          `This confirms your time off request was submitted and is now pending approval by your manager or administrator.\n\n` +
          details +
          `\nYou'll be notified once it has been reviewed. No further action is needed from you right now.`,
        companyId: row.company_id, companyName: coName,
        recipients: [employeeEmail],
      });
    }

    console.log('notify-time-off', requestId, 'approvers:', approverList.length, approverSent, 'employee:', !!employeeEmail, employeeSent);
    return json({ ok: true, approverCount: approverList.length, approverSent, employeeSent });
  } catch (e) {
    console.error('notify-time-off error', (e as Error)?.message || e);
    return json({ error: 'Internal error' }, 500);
  }
});
