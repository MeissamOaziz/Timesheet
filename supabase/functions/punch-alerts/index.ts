// punch-alerts — scheduled manager alerts: (1) forgot to clock out (open IN punch older than
// FORGOT_OUT_HOURS), (2) daily overtime (a day's completed hours over OT_DAILY_HOURS, for
// companies that track overtime). Dedupes via sent_alerts. action=test mails a sample.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const TEAM_INBOX = 'meissam.h.p@gmail.com';
const FORGOT_OUT_HOURS = 14;
const OT_DAILY_HOURS = 8;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
function rest(path: string, init?: RequestInit) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}
async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'PunchClock Pro <noreply@punchclock.ca>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
function roundMs(iso: string, mins: number): number {
  const ms = new Date(iso).getTime();
  if (!mins) return ms;
  const step = mins * 60000;
  return Math.round(ms / step) * step;
}

interface Alert { type: 'forgot_out' | 'ot_daily'; empName: string; detail: string; detailFr: string }

function alertEmailHtml(adminName: string, companyName: string, alerts: Alert[]): string {
  const ico = (t: string) => t === 'forgot_out' ? '⏱️' : '⚠️';
  const rowsFr = alerts.map((a) => `<tr><td style="padding:9px 0;font-size:14px;color:#1e293b;border-top:1px solid #e2e8f0">${ico(a.type)} <strong>${esc(a.empName)}</strong> — ${esc(a.detailFr)}</td></tr>`).join('');
  const rowsEn = alerts.map((a) => `<tr><td style="padding:9px 0;font-size:14px;color:#1e293b;border-top:1px solid #e2e8f0">${ico(a.type)} <strong>${esc(a.empName)}</strong> — ${esc(a.detail)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 16px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:#ffffff;border-bottom:1px solid #e2e8f0;padding:20px 28px"><div style="font-size:18px;font-weight:700;color:#4f8ef7">⏱ PunchClock Pro</div></td></tr>
  <tr><td style="padding:22px 28px">
    <h1 style="margin:0 0 4px;font-size:18px;color:#1e293b">Alertes pour ${esc(companyName)} / Alerts for ${esc(companyName)}</h1>
    <p style="margin:0 0 14px;font-size:13px;color:#64748b">Bonjour ${esc(adminName || '')}, voici ce qui demande votre attention. / Hi ${esc(adminName || '')}, here's what needs a look.</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rowsFr}</table>
    <div style="border-top:1px solid #e2e8f0;margin:18px 0 14px"></div>
    <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px">English</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rowsEn}</table>
    <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;line-height:1.6">Ouvrez PunchClock Pro pour corriger les pointages. / Open PunchClock Pro to review and fix the punches.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  if (body.action === 'test') {
    try {
      await sendEmail(TEAM_INBOX, 'Alertes PunchClock / PunchClock alerts (test)',
        alertEmailHtml('Meissam', 'Test Co', [
          { type: 'forgot_out', empName: 'Marie L.', detail: 'still clocked in since yesterday 9:02 AM (16h) — forgot to clock out?', detailFr: 'toujours pointée depuis hier 9 h 02 (16 h) — oubli de pointer la sortie?' },
          { type: 'ot_daily', empName: 'David P.', detail: 'worked 9h 30m today — over the 8h daily overtime threshold.', detailFr: 'a travaillé 9 h 30 aujourd\'hui — au-dessus du seuil de 8 h.' },
        ]));
    } catch (_e) { /* ignore */ }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  try {
    const now = Date.now();
    const sinceIso = new Date(now - 3 * 864e5).toISOString();
    const [coRes, empRes, punchRes] = await Promise.all([
      rest('companies?select=id,name,admin_id,track_overtime,punch_rounding,alerts_enabled,alert_forgot_out,alert_overtime,forgot_out_hours'),
      rest('employees?active=eq.true&select=id,name,company_id,site_id'),
      rest(`punches?punched_at=gte.${sinceIso}&select=id,emp_id,company_id,type,punch_date,punched_at&order=punched_at.asc`),
    ]);
    const companies = coRes.ok ? await coRes.json() : [];
    const employees = empRes.ok ? await empRes.json() : [];
    const punches = punchRes.ok ? await punchRes.json() : [];

    const adminIds = [...new Set((companies as Array<{ admin_id: string }>).map((c) => c.admin_id).filter(Boolean))];
    // Owners plus everyone they delegated to. Alerts used to go to the account owner only, so
    // co-admins and managers never learned about a missed punch on a site they run.
    const teamRes = adminIds.length
      ? await Promise.all([
        rest(`admins?id=in.(${adminIds.join(',')})&select=id,email,name,role,status,expires_at,parent_admin_id`),
        rest(`admins?parent_admin_id=in.(${adminIds.join(',')})&status=eq.active&select=id,email,name,role,status,expires_at,parent_admin_id`),
      ])
      : [];
    type AdminRow = { id: string; email: string; name: string; role: string; status: string; expires_at: string | null; parent_admin_id: string | null };
    const owners: AdminRow[] = teamRes.length && teamRes[0].ok ? await teamRes[0].json() : [];
    const delegates: AdminRow[] = teamRes.length && teamRes[1].ok ? await teamRes[1].json() : [];
    const adminById: Record<string, { email: string; name: string }> = {};
    for (const a of owners) adminById[a.id] = a;

    // Managers only hear about sites they are actually assigned to.
    const managerIds = delegates.filter((a) => a.role === 'manager').map((a) => a.id);
    const mgrSiteIds: Record<string, Set<string>> = {};
    if (managerIds.length) {
      const msRes = await rest(`manager_sites?manager_id=in.(${managerIds.join(',')})&select=manager_id,site_id`);
      if (msRes.ok) {
        for (const r of (await msRes.json()) as Array<{ manager_id: string; site_id: string }>) {
          (mgrSiteIds[r.manager_id] || (mgrSiteIds[r.manager_id] = new Set())).add(r.site_id);
        }
      }
    }

    const empById: Record<string, { name: string; company_id: string; site_id: string | null }> = {};
    for (const e of employees as Array<{ id: string; name: string; company_id: string; site_id: string | null }>) empById[e.id] = e;
    const coById: Record<string, { name: string; admin_id: string; track_overtime: boolean; punch_rounding: number; alerts_enabled: boolean; alert_forgot_out: boolean; alert_overtime: boolean; forgot_out_hours: number }> = {};
    for (const c of companies as Array<{ id: string; name: string; admin_id: string; track_overtime: boolean; punch_rounding: number; alerts_enabled: boolean; alert_forgot_out: boolean; alert_overtime: boolean; forgot_out_hours: number }>) coById[c.id] = c;

    // Group punches by employee (ascending)
    const byEmp: Record<string, Array<{ id: string; type: string; punch_date: string; punched_at: string }>> = {};
    for (const p of punches as Array<{ id: string; emp_id: string; type: string; punch_date: string; punched_at: string }>) {
      (byEmp[p.emp_id] || (byEmp[p.emp_id] = [])).push(p);
    }

    const candidates: Array<{ alert_type: string; ref_key: string; company_id: string; emp_id: string; site_id: string | null; alert: Alert }> = [];
    for (const empId of Object.keys(byEmp)) {
      const emp = empById[empId];
      if (!emp) continue;
      const co = coById[emp.company_id];
      if (!co || !co.alerts_enabled) continue;
      const eps = byEmp[empId];
      // (1) forgot to clock out — latest punch is IN and older than the threshold
      const last = eps[eps.length - 1];
      if (co.alert_forgot_out && last && last.type === 'IN') {
        const hoursOpen = (now - new Date(last.punched_at).getTime()) / 3600000;
        if (hoursOpen > (co.forgot_out_hours || FORGOT_OUT_HOURS)) {
          const since = new Date(last.punched_at).toISOString().slice(0, 16).replace('T', ' ');
          candidates.push({ alert_type: 'forgot_out', ref_key: last.id, company_id: emp.company_id, emp_id: empId, site_id: emp.site_id,
            alert: { type: 'forgot_out', empName: emp.name, detail: `still clocked in for ${Math.round(hoursOpen)}h (since ${since} UTC) — forgot to clock out?`, detailFr: `toujours pointé depuis ${Math.round(hoursOpen)} h (depuis ${since} UTC) — oubli de pointer la sortie?` } });
        }
      }
      // (2) daily overtime — completed hours per day over the threshold (track_overtime only)
      if (co.track_overtime && co.alert_overtime) {
        const dayHours: Record<string, number> = {};
        let i = 0;
        while (i < eps.length) {
          const p = eps[i];
          if (p.type === 'IN') {
            const out = eps[i + 1] && eps[i + 1].type === 'OUT' ? eps[i + 1] : null;
            if (out) { const hrs = (roundMs(out.punched_at, co.punch_rounding) - roundMs(p.punched_at, co.punch_rounding)) / 3600000; if (hrs > 0) dayHours[p.punch_date] = (dayHours[p.punch_date] || 0) + hrs; i += 2; } else i++;
          } else i++;
        }
        for (const d of Object.keys(dayHours)) {
          if (dayHours[d] > OT_DAILY_HOURS) {
            const h = dayHours[d]; const hh = Math.floor(h); const mm = Math.round((h - hh) * 60);
            candidates.push({ alert_type: 'ot_daily', ref_key: `${empId}|${d}`, company_id: emp.company_id, emp_id: empId, site_id: emp.site_id,
              alert: { type: 'ot_daily', empName: emp.name, detail: `worked ${hh}h ${mm}m on ${d} — over the ${OT_DAILY_HOURS}h daily overtime threshold.`, detailFr: `a travaillé ${hh} h ${mm} le ${d} — au-dessus du seuil de ${OT_DAILY_HOURS} h.` } });
          }
        }
      }
    }

    // Dedupe via sent_alerts (insert ignore-duplicates; only newly-inserted are emailed)
    const fresh: typeof candidates = [];
    for (const c of candidates) {
      const ins = await rest('sent_alerts', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ alert_type: c.alert_type, ref_key: c.ref_key, company_id: c.company_id, emp_id: c.emp_id }),
      });
      if (ins.ok) { const rows = await ins.json(); if (Array.isArray(rows) && rows.length) fresh.push(c); }
    }

    // Fan out per company: the owner and every co-admin see all of it; a manager sees only the
    // alerts for the sites assigned to them, so nobody gets another site's data.
    const nowMs = Date.now();
    const active = (a: AdminRow) =>
      a.status === 'active' && !!a.email && (!a.expires_at || new Date(a.expires_at).getTime() > nowMs);

    const freshByCo: Record<string, typeof fresh> = {};
    for (const c of fresh) (freshByCo[c.company_id] || (freshByCo[c.company_id] = [])).push(c);

    let emailed = 0;
    const errors: string[] = [];
    const recipients: string[] = [];
    for (const coId of Object.keys(freshByCo)) {
      const co = coById[coId];
      if (!co) continue;
      const items = freshByCo[coId];

      const team: AdminRow[] = [];
      const owner = owners.find((o) => o.id === co.admin_id);
      if (owner && active(owner)) team.push(owner);
      for (const d of delegates) {
        if (d.parent_admin_id === co.admin_id && active(d) && (d.role === 'co_admin' || d.role === 'manager')) team.push(d);
      }

      const seen = new Set<string>();
      for (const person of team) {
        const key = person.email.toLowerCase();
        if (seen.has(key)) continue; // never mail the same address twice for one company
        seen.add(key);
        const mine = person.role === 'manager'
          ? items.filter((c) => c.site_id && (mgrSiteIds[person.id] || new Set()).has(c.site_id))
          : items;
        if (!mine.length) continue;
        try {
          await sendEmail(person.email, `Alertes PunchClock / PunchClock alerts — ${co.name}`,
            alertEmailHtml(person.name, co.name, mine.map((c) => c.alert)));
          emailed++;
          recipients.push(person.email);
        } catch (e) { errors.push(`${person.email}: ${(e as Error).message}`); }
      }
    }
    return new Response(JSON.stringify({ ok: true, candidates: candidates.length, fresh: fresh.length, emailed, recipients, errors }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
