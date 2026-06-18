// churn-survey — (1) daily: email a feedback survey to churned trial users; (2) action=notify:
// email a submitted survey response to the team inbox. Deployed with verify_jwt off.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const APP_URL = 'https://www.punchclock.ca';
const TEAM_INBOX = 'meissam.h.p@gmail.com';

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

async function sendEmail(opts: { to: string; subject: string; html: string; replyTo?: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'PunchClock Pro <noreply@punchclock.ca>',
      to: [opts.to], subject: opts.subject, html: opts.html,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function token(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function surveyEmailHtml(name: string, url: string): string {
  const hi = name ? `Hi ${esc(name)},` : 'Hi there,';
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#1e293b,#334155);padding:24px 32px">
    <div style="font-size:20px;font-weight:700;color:#4f8ef7">⏱ PunchClock Pro</div></td></tr>
  <tr><td style="padding:28px 32px">
    <h1 style="margin:0 0 12px;font-size:21px;color:#1e293b">${hi}</h1>
    <p style="margin:0 0 14px;font-size:15px;color:#475569;line-height:1.6">You recently gave PunchClock Pro a try — and then things went quiet. We'd genuinely love to know <strong>what worked and what didn't</strong>. It takes about a minute, and your answers go straight to our team and shape what we build next.</p>
    <p style="margin:0 0 22px;font-size:15px;color:#475569;line-height:1.6">Whether it was the design, a missing feature, or something that just didn't fit — tell us. <strong>If we build what you ask for, we'll email you to come try it, free.</strong></p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="border-radius:10px;background:#4f8ef7">
      <a href="${esc(url)}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">Share your feedback →</a>
    </td></tr></table>
    <p style="margin:22px 0 0;font-size:13px;color:#94a3b8;line-height:1.6;text-align:center">Prefer to just reply? Hit reply to this email and tell us anything — it comes straight to us.</p>
  </td></tr>
  <tr><td style="padding:18px 32px 28px;border-top:1px solid #e2e8f0">
    <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center">We're a small team that genuinely wants to serve our customers well. Thank you. — The PunchClock Pro team</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function feedbackEmailHtml(d: Record<string, unknown>): string {
  const row = (label: string, val: unknown) => val
    ? `<tr><td style="padding:8px 0;font-size:13px;color:#64748b;width:150px;vertical-align:top">${label}</td><td style="padding:8px 0;font-size:14px;color:#1e293b">${esc(val)}</td></tr>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 16px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:#1e293b;padding:18px 28px"><div style="font-size:16px;font-weight:700;color:#4f8ef7">📨 New survey feedback</div></td></tr>
  <tr><td style="padding:22px 28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('From', d.email)}
      ${row('Company', d.company)}
      ${row('Rating', d.rating ? `${d.rating} / 5` : '')}
      ${row('Main reason', d.reason)}
      ${row('Liked', d.liked)}
      ${row('Disliked / missing', d.disliked)}
      ${row('Feature they want', d.wanted)}
    </table>
    <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">Reply to this email to respond directly to the customer. Also visible in the Super Admin → Survey Feedback panel.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // ── action=notify: email a submitted response to the team inbox ──
  if (body.action === 'notify') {
    try {
      await sendEmail({
        to: TEAM_INBOX,
        subject: `New PunchClock feedback${body.email ? ` from ${body.email}` : ''}`,
        html: feedbackEmailHtml(body),
        replyTo: typeof body.email === 'string' ? body.email : undefined,
      });
    } catch (_e) { /* swallow — the response is already saved in the DB */ }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── default: daily send to churned trial users ──
  try {
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
    const q = `admins?select=id,email,name,companies(name)` +
      `&verified=eq.true&status=eq.active&plan=eq.free&parent_admin_id=is.null` +
      `&created_at=lte.${cutoff}&last_login=lte.${cutoff}&limit=200`;
    const candRes = await rest(q);
    const candidates = candRes.ok ? await candRes.json() : [];

    // Exclude anyone already surveyed.
    const invRes = await rest('survey_invites?select=admin_id');
    const already = new Set((invRes.ok ? await invRes.json() : []).map((r: { admin_id: string }) => r.admin_id));

    const targets = (candidates as Array<Record<string, unknown>>)
      .filter((a) => a.email && !already.has(a.id as string))
      .slice(0, 100);

    let sent = 0;
    const errors: string[] = [];
    for (const a of targets) {
      const tok = token();
      const company = Array.isArray(a.companies) && a.companies[0] ? (a.companies[0] as { name: string }).name : null;
      const ins = await rest('survey_invites', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ admin_id: a.id, email: a.email, company_name: company, token: tok }),
      });
      if (!ins.ok) { errors.push(`invite ${a.email}: ${ins.status}`); continue; }
      try {
        await sendEmail({
          to: a.email as string,
          subject: 'How was your PunchClock Pro trial? (1-minute survey)',
          html: surveyEmailHtml((a.name as string) || '', `${APP_URL}/?survey=${tok}`),
          replyTo: TEAM_INBOX,
        });
        sent++;
      } catch (e) { errors.push(`email ${a.email}: ${(e as Error).message}`); }
    }
    return new Response(JSON.stringify({ ok: true, candidates: targets.length, sent, errors }, null, 2),
      { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
