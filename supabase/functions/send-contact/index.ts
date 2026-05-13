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

// Types that are internal notifications — never send a customer ack for these
const INTERNAL_TYPES = new Set(['new_account_notification', 'missed_punch']);

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
  const nameEn = name?.trim() || 'there';
  const nameFr = name?.trim() || 'vous';
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
    const body = await req.json();
    const { type, name, email, subject, message, adminId, recipients } = body;
    const toList: string[] = Array.isArray(recipients) && recipients.length > 0
      ? recipients
      : [DEST_EMAIL];

    if (!name || !email || !subject || !message) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    const isSales = type === 'sales';
    const subLabel = SUBJECT_LABELS[subject] ?? subject;
    const typeLabel = isSales ? '📣 Sales Inquiry' : '🎧 Support Request';
    const emailSubject = `[PunchClock Pro] ${typeLabel} — ${subLabel}`;

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
    <div class="row"><div class="label">From</div><div class="value">${name} &lt;${email}&gt;</div></div>
    ${adminId ? `<div class="row"><div class="label">Admin ID</div><div class="value">${adminId}</div></div>` : ''}
    <div class="row"><div class="label">Subject</div><div class="value">${subLabel}</div></div>
    <div class="row"><div class="label">Message</div><div class="value message-box">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div></div>
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
        reply_to: email,
        subject: emailSubject,
        html
      })
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      throw new Error(`Resend ${resendRes.status}: ${err}`);
    }

    // Fire-and-forget customer acknowledgment — never blocks the main response
    if (!INTERNAL_TYPES.has(type) && email && isValidEmail(email)) {
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
          to: [email],
          subject: '✅ We received your message | Nous avons reçu votre message — PunchClock Pro',
          html: buildAckHtml(name, subLabel, receivedEn, receivedFr)
        })
      }).catch(() => { /* fire-and-forget: ack failures are non-fatal */ });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }
});
