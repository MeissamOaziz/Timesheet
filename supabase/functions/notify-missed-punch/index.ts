// notify-missed-punch — Supabase Edge Function
// Given a missed_punch_requests row id, resolves recipients server-side
// (primary admin + active co-admins + managers assigned to the report's site
//  + the reporting employee as confirmation), de-dupes, and emails them all.
// Recipient resolution is authoritative server-side (not trusting the client).
// JWT verification: OFF (no sensitive capability — only triggers a notification
// for an already-inserted report; resolves its own recipients).

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let requestId: string;
  try {
    const p = await req.json();
    requestId = p.requestId;
  } catch { return json({ error: 'Invalid body' }, 400); }
  if (!requestId) return json({ error: 'Missing requestId' }, 400);

  try {
    // 1. Load the request row
    const reqRows = await rest(`missed_punch_requests?id=eq.${requestId}&select=*&limit=1`);
    const mpr = reqRows[0];
    if (!mpr) return json({ error: 'Request not found' }, 404);

    const emails = new Set<string>();

    // 2. Company → primary admin + active co-admins
    if (mpr.company_id) {
      const coRows = await rest(`companies?id=eq.${mpr.company_id}&select=admin_id,name`);
      const adminId = coRows[0]?.admin_id;
      if (adminId) {
        const primary = await rest(`admins?id=eq.${adminId}&select=email`);
        primary.forEach(a => a.email && emails.add(a.email.toLowerCase()));
        const coAdmins = await rest(`admins?parent_admin_id=eq.${adminId}&status=eq.active&select=email`);
        coAdmins.forEach(a => a.email && emails.add(a.email.toLowerCase()));
      }
    }

    // 3. Managers assigned to the report's site
    if (mpr.site_id) {
      const ms = await rest(`manager_sites?site_id=eq.${mpr.site_id}&select=manager_id`);
      const mgrIds = ms.map(m => m.manager_id).filter(Boolean);
      if (mgrIds.length) {
        const mgrs = await rest(`admins?id=in.(${mgrIds.join(',')})&status=eq.active&select=email`);
        mgrs.forEach(a => a.email && emails.add(a.email.toLowerCase()));
      }
    }

    // 4. The reporting employee (confirmation copy)
    if (mpr.emp_id) {
      const emp = await rest(`employees?id=eq.${mpr.emp_id}&select=email`);
      emp.forEach(e => e.email && emails.add(e.email.toLowerCase()));
    }

    const recipients = [...emails];
    if (recipients.length === 0) {
      console.warn('notify-missed-punch: no recipients resolved for request', requestId);
      return json({ ok: true, sent: 0, note: 'no recipients' });
    }

    // 5. Build the email content (neutral wording — works for approvers and the reporting employee)
    const coName = (await rest(`companies?id=eq.${mpr.company_id}&select=name`))[0]?.name || '—';
    const siteName = mpr.site_id ? ((await rest(`sites?id=eq.${mpr.site_id}&select=name`))[0]?.name || '—') : '—';
    const typeLabel = mpr.type === 'IN' ? 'Missed Clock In' : 'Missed Clock Out';
    const subject = `[Missed Punch Request] ${mpr.emp_name} — ${typeLabel}`;
    const message =
      `A missed punch request has been submitted and is pending review.\n\n` +
      `Employee: ${mpr.emp_name}\n` +
      `Company: ${coName}\n` +
      `Site: ${siteName}\n` +
      `Type: ${typeLabel}\n` +
      `Date: ${mpr.requested_date}\n` +
      `Time: ${mpr.requested_time}\n` +
      (mpr.reason ? `Reason: ${mpr.reason}\n` : '') +
      `\nThis punch has NOT been recorded yet — an admin or site manager needs to review it in the Admin panel. ` +
      `If you are the employee who submitted it, this is your confirmation that the request was received.`;

    // 6. Send via the existing send-contact path (verified sender, missed_punch internal type)
    const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-contact`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'missed_punch',
        name: mpr.emp_name,
        email: 'noreply@punchclock.ca',
        subject, message,
        companyId: mpr.company_id, companyName: coName,
        recipients,
      }),
    });
    if (!sendRes.ok) {
      const errTxt = await sendRes.text();
      console.error('notify-missed-punch: send-contact failed', sendRes.status, errTxt);
      return json({ error: 'send failed', detail: errTxt }, 502);
    }

    console.log('notify-missed-punch: sent for', requestId, 'to', recipients.length, 'recipients');
    return json({ ok: true, sent: recipients.length });
  } catch (e) {
    console.error('notify-missed-punch error', e?.message || e);
    return json({ error: 'Internal error' }, 500);
  }
});
