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

// PGRST303 "JWT issued at future" is a platform-side clock-skew fault, not a bad key: the same
// credential succeeds seconds later. It took this project offline for days in August, and it
// silently killed the 9am run on 2026-08-28 — the whole drip threw before mailing anyone. The
// client already retries it once (see _isTransientAuthFault in index.html); the server side had
// no such guard, so a momentary skew read as "no such row" and a notification vanished.
function isClockSkew(text: string): boolean {
  return /PGRST303|JWT issued at future/i.test(text);
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rest(path: string, retried = false): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (!retried && isClockSkew(body)) { await pause(1500); return rest(path, true); }
    // Swallowing the status made every failure look identical to "no such row", which is how
    // a transient auth fault turned into a silently dropped email.
    console.error('rest failed', r.status, path, body.slice(0, 200));
    return [];
  }
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

  let requestId: string, mode = 'submitted';
  try {
    const body = await req.json();
    requestId = body.requestId;
    mode = body.mode === 'decision' ? 'decision' : 'submitted';
  }
  catch { return json({ error: 'Invalid body' }, 400); }
  if (!requestId) return json({ error: 'Missing requestId' }, 400);

  try {
    const mpr = (await rest(`missed_punch_requests?id=eq.${requestId}&select=*&limit=1`))[0];
    if (!mpr) return json({ error: 'Request not found' }, 404);

    // ── Decision notice ──────────────────────────────────────────────────────
    // An employee reporting a missed punch is asking to be paid for time they worked. Until
    // now the answer never reached them: the row changed, an admin saw a toast, and the person
    // who filed it learned nothing. Approving or declining now says so, and an approval states
    // the exact time that was recorded, since an admin may have edited it before approving.
    if (mode === 'decision') {
      if (mpr.status !== 'approved' && mpr.status !== 'denied') {
        return json({ ok: true, skipped: `status is ${mpr.status}` });
      }
      if (!mpr.emp_id) return json({ ok: true, skipped: 'no employee on request' });
      const emp = (await rest(`employees?id=eq.${mpr.emp_id}&select=email`))[0];
      const to = emp?.email?.toLowerCase();
      if (!to) return json({ ok: true, skipped: 'employee has no email' });

      const co = mpr.company_id ? ((await rest(`companies?id=eq.${mpr.company_id}&select=name`))[0]?.name || '—') : '—';
      const label = mpr.type === 'IN' ? 'clock in' : 'clock out';
      const labelFr = mpr.type === 'IN' ? 'entrée' : 'sortie';
      const approved = mpr.status === 'approved';

      // Read the punch that was actually created rather than echoing what was requested —
      // "Edit + Approve" exists precisely so an admin can correct the time first.
      let recorded = `${mpr.requested_date} ${mpr.requested_time}`;
      if (approved && mpr.punch_id) {
        const p = (await rest(`punches?id=eq.${mpr.punch_id}&select=punch_date,punch_time`))[0];
        if (p) recorded = `${p.punch_date} ${String(p.punch_time).slice(0, 5)}`;
      }

      const sentOk = await sendContact({
        type: 'missed_punch',
        name: mpr.emp_name,
        email: 'noreply@punchclock.ca',
        subject: approved
          ? `Missed ${label} approved — ${recorded} | Pointage ajouté`
          : `Missed ${label} not approved — ${mpr.requested_date} | Pointage refusé`,
        message: approved
          ? `Hi ${mpr.emp_name},

` +
            `Your missed ${label} has been approved and added to your timesheet.

` +
            `Recorded: ${recorded}
` +
            `Company: ${co}

` +
            (recorded !== `${mpr.requested_date} ${mpr.requested_time}`
              ? `Note: this differs from the time you submitted (${mpr.requested_date} ${mpr.requested_time}) — your manager adjusted it before approving.

`
              : `Nothing further is needed from you.

`) +
            `— — —

` +
            `Bonjour ${mpr.emp_name},

` +
            `Votre ${labelFr} manquante a été approuvée et ajoutée à votre feuille de temps.

` +
            `Enregistré : ${recorded}
` +
            `Entreprise : ${co}

` +
            (recorded !== `${mpr.requested_date} ${mpr.requested_time}`
              ? `Note : cela diffère de l'heure que vous aviez soumise (${mpr.requested_date} ${mpr.requested_time}) — votre gestionnaire l'a ajustée avant d'approuver.`
              : `Rien d'autre n'est requis de votre part.`)
          : `Hi ${mpr.emp_name},

` +
            `Your missed ${label} request for ${mpr.requested_date} at ${mpr.requested_time} was not approved, ` +
            `so no punch was added to your timesheet.

` +
            `Company: ${co}

` +
            `If you think this was a mistake, speak with your manager — they can review it again.

` +
            `— — —

` +
            `Bonjour ${mpr.emp_name},

` +
            `Votre demande de ${labelFr} manquante du ${mpr.requested_date} à ${mpr.requested_time} n'a pas été approuvée, ` +
            `donc aucun pointage n'a été ajouté à votre feuille de temps.

` +
            `Entreprise : ${co}

` +
            `Si vous pensez qu'il s'agit d'une erreur, parlez-en à votre gestionnaire — la demande peut être réexaminée.`,
        companyId: mpr.company_id, companyName: co,
        recipients: [to],
      });
      console.log('notify-missed-punch decision', requestId, mpr.status, sentOk);
      return json({ ok: true, mode: 'decision', status: mpr.status, sent: sentOk });
    }

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
