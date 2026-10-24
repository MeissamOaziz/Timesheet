// PunchClock Pro — Contact & Support Email Edge Function
// Deploy to: supabase/functions/send-contact/index.ts
//
// Required env vars (set in Supabase Dashboard → Settings → Edge Functions):
//   RESEND_API_KEY  — your Resend API key (already used by send-verification)
const DEST_EMAIL = Deno.env.get('SUPPORT_EMAIL') || 'support@punchclock.ca';
const FROM_EMAIL = 'PunchClock Pro <noreply@punchclock.ca>';
const ACK_FROM = 'PunchClock Pro Support <support@punchclock.ca>';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const SUBJECT_LABELS: Record<string, string> = {
  // Landing / sales subjects
  sales: 'Sales / Pricing question',
  trial: 'Help getting started',
  feature: 'Feature request',
  other: 'Other',
  // Support subjects
  billing: 'Billing / Subscription',
  technical: 'Technical issue',
  account: 'Account help'
};

// Types that are internal notifications — never send a customer ack for these.
// time_off was missing: notify-time-off sends through here with the placeholder address
// noreply@punchclock.ca, so every request produced a "We received your message" ack addressed to
// the employee's name but delivered to the support inbox (two per request).
const INTERNAL_TYPES = new Set(['new_account_notification', 'missed_punch', 'time_off']);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// This function is public on purpose (the landing contact form and the in-app support form post to it),
// so it must not be usable to send mail anywhere else. Only our own server functions (notify-time-off,
// notify-missed-punch) hold the service key; with it a caller may choose the recipients and use the
// internal types. Everyone else always writes to the support inbox, in the two public types, within a
// rate limit, and every field they control is escaped and length-capped.
const PUBLIC_TYPES = new Set(['sales', 'support']);
const MAX_PER_SENDER_HOUR = 5;
const MAX_PER_HOUR_ALL = 120;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Escape text for HTML and cap its length. Anything that is not a string becomes ''.
function esc(v: unknown, max = 200): string {
  const t = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const oneLine = (v: unknown, max = 100): string =>
  typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rate limit, kept in audit_log (service key only). Fails open: if the count cannot be read, a real
// customer is never turned away because of our own bookkeeping.
async function recentCount(filterClause: string): Promise<number> {
  try {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/audit_log?event=eq.contact_form&${filterClause}&at=gte.${since}&select=id&limit=200`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) return 0;
    const rows = await r.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}
async function recordContact(senderEmail: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ event: 'contact_form', table_name: 'send-contact', filter: senderEmail.toLowerCase().slice(0, 200) }),
    });
  } catch { /* bookkeeping must never block a message */ }
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Same dark-theme wrapper used by send-verification and other PunchClock emails
function wrapper(body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,sans-serif;">
<div style="max-width:540px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#1a1d27;border:1px solid #2e3347;border-radius:16px;padding:36px 32px;">
    ${body}
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="color:#555e7a;font-size:12px;">PunchClock Pro &mdash; Time &amp; Attendance Software</p>
  </div>
</div></body></html>`;
}

function buildAckHtml(name: string, subLabel: string, receivedEn: string, receivedFr: string): string {
  const nameEn = esc(name, 100) || 'there';
  const nameFr = esc(name, 100) || 'vous';
  return wrapper(`
    <!-- ENGLISH -->
    <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 16px;">We received your message</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${nameEn},</p>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">
      Thank you for contacting PunchClock Pro support. We've received your message and our team will get back to you within <strong style="color:#e8eaf0;">48 hours</strong>.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 10px;">In the meantime, here are a few things that might help:</p>
    <ul style="color:#8b92a8;font-size:14px;line-height:1.9;margin:0 0 24px;padding-left:20px;">
      <li>Visit <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a> for guides on setting up your company, sites, and employees</li>
      <li>PunchClock Pro is a time &amp; attendance tracking platform — it records clock-ins/outs and generates payroll-ready reports</li>
      <li>For billing questions, you can manage your subscription directly from your account under <strong style="color:#e8eaf0;">My Profile → Manage Billing</strong></li>
    </ul>
    <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:18px 20px;margin-bottom:36px;">
      <div style="font-size:11px;font-weight:600;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Your message details</div>
      <div style="font-size:14px;color:#e8eaf0;margin-bottom:6px;"><span style="color:#8b92a8;">Subject:</span> ${subLabel}</div>
      <div style="font-size:14px;color:#e8eaf0;"><span style="color:#8b92a8;">Received:</span> ${receivedEn}</div>
    </div>

    <!-- SEPARATOR -->
    <hr style="border:none;border-top:1px solid #2e3347;margin:0 0 36px;">

    <!-- FRENCH -->
    <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 16px;">Nous avons reçu votre message</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">Bonjour ${nameFr},</p>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">
      Merci d'avoir contacté le support PunchClock Pro. Nous avons bien reçu votre message et notre équipe vous répondra dans les <strong style="color:#e8eaf0;">48 heures</strong>.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 10px;">En attendant, voici quelques ressources utiles :</p>
    <ul style="color:#8b92a8;font-size:14px;line-height:1.9;margin:0 0 24px;padding-left:20px;">
      <li>Visitez <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a> pour des guides sur la configuration de votre entreprise, vos sites et vos employés</li>
      <li>PunchClock Pro est une plateforme de suivi du temps de présence — elle enregistre les pointages et génère des rapports prêts pour la paie</li>
      <li>Pour toute question de facturation, vous pouvez gérer votre abonnement directement depuis votre compte sous <strong style="color:#e8eaf0;">Mon profil → Gérer la facturation</strong></li>
    </ul>
    <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:18px 20px;margin-bottom:36px;">
      <div style="font-size:11px;font-weight:600;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Détails de votre message</div>
      <div style="font-size:14px;color:#e8eaf0;margin-bottom:6px;"><span style="color:#8b92a8;">Sujet :</span> ${subLabel}</div>
      <div style="font-size:14px;color:#e8eaf0;"><span style="color:#8b92a8;">Reçu le :</span> ${receivedFr}</div>
    </div>

    <!-- BILINGUAL FOOTER NOTE -->
    <p style="color:#555e7a;font-size:12px;line-height:1.7;margin:0;text-align:center;">
      This is an automated acknowledgment — please do not reply to this email.<br>
      Our team will respond to your original message shortly.<br><br>
      Ceci est un accusé de réception automatique — veuillez ne pas répondre à ce courriel.<br>
      Notre équipe répondra à votre message original sous peu.
    </p>
  `);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const isService = !!SERVICE_KEY && timingSafeEqual(bearer, SERVICE_KEY);
    const body = await req.json();
    const { type, name, email, subject, message, adminId, recipients } = body;
    const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' }
    });

    if (!name || !email || !subject || !message) return fail(400, 'Missing required fields');
    if (!isService && !PUBLIC_TYPES.has(String(type))) return fail(403, 'Unauthorized');

    // Recipients: only the server may choose them. Everyone else writes to the support inbox.
    let toList: string[] = [DEST_EMAIL];
    if (isService && Array.isArray(recipients) && recipients.length > 0) {
      toList = recipients.filter((r: unknown) => typeof r === 'string' && isValidEmail(r)).slice(0, 20);
      if (!toList.length) toList = [DEST_EMAIL];
    }

    const senderEmail = oneLine(email, 200);
    if (!isService) {
      if (!isValidEmail(senderEmail)) return fail(400, 'Invalid email address');
      if (String(message).length > 5000) return fail(400, 'Message is too long');
      // Rate limit per sender address and overall. The acknowledgement goes to that address, so this is
      // also what stops the form being used to mail someone repeatedly.
      const [mine, all] = await Promise.all([
        recentCount(`filter=eq.${encodeURIComponent(senderEmail.toLowerCase())}`),
        recentCount('table_name=eq.send-contact'),
      ]);
      if (mine >= MAX_PER_SENDER_HOUR || all >= MAX_PER_HOUR_ALL) return fail(429, 'Too many messages. Please try again later.');
      await recordContact(senderEmail);
    }

    const isSales = type === 'sales';
    const subLabelRaw = SUBJECT_LABELS[subject] ?? oneLine(subject, 80);
    const subLabel = esc(subLabelRaw, 120);
    const typeLabel = isSales ? '📣 Sales Inquiry' : '🎧 Support Request';
    const emailSubject = `[PunchClock Pro] ${typeLabel} — ${oneLine(subLabelRaw, 120)}`;
    // Many mail clients (Gmail webmail among them) strip <style> blocks entirely, so the
    // .message-box white-space:pre-wrap rule below can't be relied on to keep line breaks —
    // convert them to real <br> tags, which every client honours regardless of CSS support.
    const messageHtml = String(message).slice(0, 5000)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const safeAdminId = typeof adminId === 'string' && UUID_RE.test(adminId) ? adminId : '';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;margin:0;padding:24px}
  .card{background:#1a1d27;border:1px solid #2a2d3a;border-radius:12px;padding:28px;max-width:560px;margin:0 auto}
  h2{color:#fff;margin:0 0 20px;font-size:18px}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;
    background:${isSales ? '#5b21b6' : '#0e4d91'};color:#fff;margin-bottom:18px}
  .row{margin-bottom:14px}
  .label{font-size:11px;font-weight:600;color:#8b93a7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .value{font-size:14px;color:#e2e8f0;background:#11131c;border-radius:8px;padding:10px 14px;word-break:break-word}
  .message-box{white-space:pre-wrap;line-height:1.6}
  .footer{font-size:11px;color:#4a5068;margin-top:20px;text-align:center}
</style></head>
<body>
  <div class="card">
    <h2>⏱ PunchClock Pro</h2>
    <div class="badge">${typeLabel}</div>
    <div class="row"><div class="label">From</div><div class="value">${esc(name, 100)} &lt;${esc(senderEmail, 200)}&gt;</div></div>
    ${safeAdminId ? `<div class="row"><div class="label">Admin ID</div><div class="value">${safeAdminId}</div></div>` : ''}
    <div class="row"><div class="label">Subject</div><div class="value">${subLabel}</div></div>
    <div class="row"><div class="label">Message</div><div class="value message-box" style="white-space:normal;line-height:1.6">${messageHtml}</div></div>
    <div class="footer">Sent via PunchClock Pro contact form</div>
  </div>
</body>
</html>`;

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) throw new Error('RESEND_API_KEY not set');

    // Send main support email to the team
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: toList,
        reply_to: senderEmail,
        subject: emailSubject,
        html
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      throw new Error(`Resend ${resendRes.status}: ${err}`);
    }

    // Fire-and-forget customer acknowledgment — never blocks the main response
    if (!INTERNAL_TYPES.has(type) && senderEmail && isValidEmail(senderEmail)) {
      const now = new Date();
      const receivedEn = now.toLocaleString('en-CA', {
        timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'short'
      });
      const receivedFr = now.toLocaleString('fr-CA', {
        timeZone: 'America/Toronto', dateStyle: 'long', timeStyle: 'short'
      });
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: ACK_FROM,
          to: [senderEmail],
          subject: '✅ We received your message | Nous avons reçu votre message — PunchClock Pro',
          html: buildAckHtml(String(name), subLabel, receivedEn, receivedFr)
        })
      }).catch(() => { /* fire-and-forget: ack failures are non-fatal */ });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
});
