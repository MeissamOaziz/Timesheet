// notify-missed-punch — Supabase Edge Function
// Given a missed_punch_requests row id, resolves recipients server-side and sends
// TWO emails: (A) approvers (admin + active co-admins + site managers) get a
// "needs review" notice; (B) the reporting employee gets a separate confirmation.
// Recipient resolution is authoritative server-side. JWT verification: OFF.

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
  } catch (e) { console.error('send-contact threw', e?.message || e); return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let requestId: string;
  try { requestId = (await req.json()).requestId; }
  catch { return json({ error: 'Invalid body' }, 400); }
  if (!requestId) return json({ error: 'Missing requestId' }, 400);

  try {
    const mpr = (await rest(`missed_punch_requests?id=eq.${requestId}&select=*&limit=1`))[0];
    if (!mpr) return json({ error: 'Request not found' }, 404);

    // Common details
    const coName = mpr.company_id ? ((await rest(`companies?id=eq.${mpr.company_id}&select=name`))[0]?.name || '—') : '—';
    const siteName = mpr.site_id ? ((await rest(`sites?id=eq.${mpr.site_id}&select=name`))[0]?.name || '—') : '—';
    const typeLabel = mpr.type === 'IN' ? 'Missed Clock In' : 'Missed Clock Out';
    const details =
      `Employee: ${mpr.emp_name}\n` +
      `Company: ${coName}\n` +
      `Site: ${siteName}\n` +
      `Type: ${typeLabel}\n` +
      `Date: ${mpr.requested_date}\n` +
      `Time: ${mpr.requested_time}\n` +
      (mpr.reason ? `Reason: ${mpr.reason}\n` : '');

    // ---- Resolve approver emails (admin + active co-admins + site managers) ----
    const approvers = new Set<string>();
    if (mpr.company_id) {
      const adminId = (await rest(`companies?id=eq.${mpr.company_id}&select=admin_id`))[0]?.admin_id;
      if (adminId) {
        (await rest(`admins?id=eq.${adminId}&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
        (await rest(`admins?parent_admin_id=eq.${adminId}&status=eq.active&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
      }
    }
    if (mpr.site_id) {
      const mgrIds = (await rest(`manager_sites?site_id=eq.${mpr.site_id}&select=manager_id`)).map(m => m.manager_id).filter(Boolean);
      if (mgrIds.length) {
        (await rest(`admins?id=in.(${mgrIds.join(',')})&status=eq.active&select=email`)).forEach(a => a.email && approvers.add(a.email.toLowerCase()));
      }
    }

    // ---- Resolve the reporting employee's email ----
    let employeeEmail: string | null = null;
    if (mpr.emp_id) {
      const e = (await rest(`employees?id=eq.${mpr.emp_id}&select=email`))[0];
      if (e?.email) employeeEmail = e.email.toLowerCase();
    }
    // Ensure the employee is never in the approver set
    if (employeeEmail) approvers.delete(employeeEmail);

    const approverList = [...approvers];
    let approverSent = false, employeeSent = false;

    // ---- (A) Approver "needs review" email ----
    if (approverList.length) {
      approverSent = await sendContact({
        type: 'missed_punch',
        name: mpr.emp_name,
        email: 'noreply@punchclock.ca',
        subject: `[Missed Punch Request] ${mpr.emp_name} — ${typeLabel}`,
        message:
          `A missed punch request has been submitted and needs your review.\n\n` +
          details +
          `\nThis punch has NOT been recorded yet — your review is required in the Admin panel.`,
        companyId: mpr.company_id, companyName: coName,
        recipients: approverList,
      });
    } else {
      console.warn('notify-missed-punch: no approver recipients for', requestId);
    }

    // ---- (B) Employee confirmation email (separate) ----
    if (employeeEmail) {
      employeeSent = await sendContact({
        type: 'missed_punch',
        name: mpr.emp_name,
        email: 'noreply@punchclock.ca',
        subject: `Your missed punch request was received — ${typeLabel}`,
        message:
          `Hi ${mpr.emp_name},\n\n` +
          `This confirms your missed punch request was submitted successfully and is now pending approval by your manager or administrator.\n\n` +
          details +
          `\nYou'll be notified once it has been reviewed. No further action is needed from you right now.`,
        companyId: mpr.company_id, companyName: coName,
        recipients: [employeeEmail],
      });
    }

    console.log('notify-missed-punch', requestId, 'approvers:', approverList.length, approverSent, 'employee:', !!employeeEmail, employeeSent);
    return json({ ok: true, approverCount: approverList.length, approverSent, employeeSent });
  } catch (e) {
    console.error('notify-missed-punch error', e?.message || e);
    return json({ error: 'Internal error' }, 500);
  }
});
