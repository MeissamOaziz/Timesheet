import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dry-run"
};
// Everything below that ends up in an email that a person typed (names, notes, company names) goes
// through esc(): it used to be placed into the HTML raw, so markup in a name or a shift note became
// markup in the email. Links are only ever ours (siteUrl) or an uploaded logo (logoUrl).
const esc = (v: unknown): string => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
// A one-line, bounded string for a subject header.
const oneLine = (v: unknown): string => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
// Links in these emails must point at our own site; anything else falls back to the default.
const siteUrl = (u: unknown, fallback: string): string => {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'https:' && (x.hostname === 'www.punchclock.ca' || x.hostname === 'punchclock.ca')) return String(u);
  } catch (_e) { /* fall through */ }
  return fallback;
};
// A company logo is an uploaded file, which lives in our own storage.
const logoUrlOk = (u: unknown): string => {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'https:' && (x.hostname.endsWith('.supabase.co') || x.hostname.endsWith('punchclock.ca'))) return String(u);
  } catch (_e) { /* fall through */ }
  return '';
};
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
// Table-based layout with bgcolor attributes, not just inline CSS -- plain divs with
// background/border-radius get their styling stripped by some webmail clients (Outlook.com
// among them), which flattens the card into unstyled text and turns styled <a> buttons into
// bare underlined links. Tables + bgcolor survive that stripping in every client that matters.
function wrapper(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9" style="background:#f1f5f9;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">
<tr><td align="center" style="padding-bottom:32px;font-family:Arial,sans-serif;">
<span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:36px 32px;">
${body}
</td></tr>
<tr><td align="center" style="padding-top:28px;font-family:Arial,sans-serif;">
<p style="color:#94a3b8;font-size:12px;margin:0;">PunchClock Pro &mdash; Time &amp; Attendance Software<br>This is an automated message, please do not reply.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
// Bulletproof CTA button: a table cell carrying the background via the bgcolor attribute (not
// just style="background:..."), so the button keeps its color and shape even in clients that
// strip inline styles off <a> tags. Reused by every builder below that has a primary action link.
function ctaButton(href, label, color) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">
<tr><td align="center" bgcolor="${color}" style="background:${color};border-radius:10px;">
<a href="${esc(href)}" target="_blank" style="display:block;color:#ffffff;text-decoration:none;padding:14px 32px;font-weight:600;font-size:15px;font-family:Arial,sans-serif;">${label}</a>
</td></tr>
</table>`;
}
function buildVerificationHtml(name, code) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px;">Verify your email address</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
      Hi ${esc(name)}, use the code below to complete your PunchClock Pro registration.
      This code expires in <strong style="color:#1e293b;">10 minutes</strong>.
    </p>
    <div style="background:#f1f5f9;border:2px solid #4f8ef7;border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;">
      <div style="font-size:11px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Your verification code</div>
      <div style="font-family:monospace;font-size:42px;font-weight:700;color:#4f8ef7;letter-spacing:12px;">${esc(code)}</div>
    </div>
    <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0;">If you did not request this code, you can safely ignore this email.</p>`);
}
// Password reset code (admin and employee portal). It used to reuse the registration template,
// which told people to "complete your registration" and quoted a 10-minute expiry when the code
// actually lasts 15. Bilingual, like the other emails that can reach French-speaking staff.
function buildPasswordResetHtml(name, code) {
  const box = `<div style="background:#f1f5f9;border:2px solid #4f8ef7;border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;">
      <div style="font-size:11px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Reset code / Code de r&eacute;initialisation</div>
      <div style="font-family:monospace;font-size:42px;font-weight:700;color:#4f8ef7;letter-spacing:12px;">${esc(code)}</div>
    </div>`;
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px;">Reset your password</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
      Hi ${esc(name)}, enter the code below on the PunchClock Pro sign-in page to choose a new password.
      This code expires in <strong style="color:#1e293b;">15 minutes</strong>.
    </p>
    ${box}
    <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 28px;">If you did not ask to reset your password, you can safely ignore this email. Your password has not changed.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;">
    <h2 style="font-size:18px;font-weight:700;color:#1e293b;margin:0 0 8px;">R&eacute;initialisez votre mot de passe</h2>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">
      Bonjour ${esc(name)}, entrez le code ci-dessus sur la page de connexion PunchClock Pro pour choisir un nouveau mot de passe.
      Ce code expire dans <strong style="color:#1e293b;">15 minutes</strong>.
    </p>
    <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0;">Si vous n'avez pas demand&eacute; cette r&eacute;initialisation, vous pouvez ignorer ce courriel. Votre mot de passe n'a pas chang&eacute;.</p>`);
}
function buildJoinApprovedHtml(coAdminName, primaryAdminName) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px;">✅ Your access has been approved!</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Hi ${esc(coAdminName)}, <strong style="color:#1e293b;">${esc(primaryAdminName)}</strong> has approved your request to join their PunchClock Pro account.
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px;">
      You can now log in to access all companies and sites associated with this account.
    </p>
    <a href="https://www.punchclock.ca" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;">
      Log In to PunchClock Pro →
    </a>`);
}
function buildScheduleHtml(empName, weekLabel, shifts, lang) {
  const isFr = lang === 'fr';
  const eh = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A shift's work label (what it is for), as a small tag ahead of the note. The colour comes from
  // the database but is checked here before it goes into a style attribute.
  const labelTag = (s) => {
    if (!s.label) return '';
    const c = /^#[0-9a-fA-F]{6}$/.test(s.labelColor || '') ? s.labelColor : '#4f8ef7';
    return `<span style="display:inline-block;margin:0 6px 2px 0;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700;color:#1e293b;background:#ffffff;border:1px solid ${c}"><span style="color:${c}">&#9679;</span> ${eh(s.label)}</span>`;
  };
  const title = isFr ? `Votre horaire — ${esc(weekLabel)}` : `Your Schedule — ${esc(weekLabel)}`;
  const greeting = isFr ? `Bonjour ${esc(empName)},` : `Hi ${esc(empName)},`;
  const intro = isFr ? `Voici votre horaire de travail pour la semaine du <strong style="color:#1e293b">${esc(weekLabel)}</strong>.` : `Here is your work schedule for the week of <strong style="color:#1e293b">${esc(weekLabel)}</strong>.`;
  const noShifts = isFr ? 'Aucun quart prévu cette semaine.' : 'No shifts scheduled this week.';
  const footer = isFr ? 'Pour toute question, contactez votre administrateur.' : 'For any questions, contact your administrator.';
  const shiftRows = shifts.length === 0 ? `<tr><td colspan="3" style="padding:16px;text-align:center;color:#94a3b8;font-style:italic">${noShifts}</td></tr>` : shifts.map((s)=>`
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1e293b;white-space:nowrap">${esc(s.day)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;color:#4f8ef7;font-weight:600;white-space:nowrap">${esc(s.startTime)} – ${esc(s.endTime)}</td>
        <td style="padding:12px 14px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:13px">${labelTag(s)}${esc(s.note) || (s.label ? '' : '—')}</td>
      </tr>`).join('');
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 6px;">🗓️ ${title}</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">${greeting}<br>${intro}</p>
    <table style="width:100%;border-collapse:collapse;background:#f1f5f9;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Jour' : 'Day'}</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Heures' : 'Hours'}</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Note' : 'Note'}</th>
        </tr>
      </thead>
      <tbody>${shiftRows}</tbody>
    </table>
    <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:20px 0 0">${footer}</p>`);
}
function buildEmployeeInviteHtml(empName, portalUrl, lang, companyName, logoUrl) {
  const isFr = lang === 'fr';
  const title = isFr ? `Vous avez accès au portail employé` : `You've been invited to the Employee Portal`;
  const greeting = isFr ? `Bonjour ${esc(empName)},` : `Hi ${esc(empName)},`;
  // Falls back to the generic "your employer" wording when a company has no name on file (should
  // not happen in practice, but the email must still read correctly rather than show "undefined").
  const employerLabel = companyName
    ? `<strong style="color:#1e293b">${esc(companyName)}</strong>`
    : (isFr ? `Votre employeur` : `Your employer`);
  const intro = isFr ? `${employerLabel} vous a donné accès au <strong style="color:#1e293b">portail employé PunchClock Pro</strong>. Depuis ce portail, vous pouvez :` : `${employerLabel} has given you access to the <strong style="color:#1e293b">PunchClock Pro Employee Portal</strong>. From the portal, you can:`;
  const features = isFr ? [
    `🗓️ Consulter votre horaire de quarts à venir`,
    `📊 Voir vos rapports d'heures et pointages`,
    `🚫 Indiquer vos jours et heures d'indisponibilité`
  ] : [
    `🗓️ View your upcoming shift schedule`,
    `📊 See your hours reports and punch records`,
    `🚫 Set your days/times when you're not available to work`
  ];
  const cta = isFr ? `Activer mon compte →` : `Activate my account →`;
  const expiry = isFr ? `Ce lien expire dans 48 heures.` : `This link expires in 48 hours.`;
  const ignore = isFr ? `Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message.` : `If you weren't expecting this invitation, you can safely ignore this email.`;
  // Table cell, not a bare <img>, so it survives the same webmail clients the rest of this file
  // is built to survive (see the note on `wrapper` above) -- centered, capped height so a huge
  // source logo can't blow out the card.
  const logo = logoUrlOk(logoUrl) ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
      <tr><td align="center"><img src="${esc(logoUrlOk(logoUrl))}" alt="${esc(companyName || '')}" height="40" style="height:40px;max-width:220px;width:auto;object-fit:contain;"></td></tr>
    </table>` : '';
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px;">🔗 ${title}</h1>
    ${logo}
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">${greeting}<br><br>${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
      ${features.map((f)=>`<tr><td bgcolor="#f1f5f9" style="background:#f1f5f9;border-radius:8px;border:1px solid #e2e8f0;padding:8px 14px;color:#475569;font-size:14px;font-family:Arial,sans-serif;">${f}</td></tr><tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>`).join('')}
    </table>
    ${ctaButton(portalUrl, cta, '#7c5cbf')}
    <p style="color:#94a3b8;font-size:12px;margin-top:20px;text-align:center">${expiry}</p>
    <p style="color:#94a3b8;font-size:12px;margin-top:8px;">${ignore}</p>`);
}
function buildJoinDeniedHtml(name, companyName) {
  const co = esc(companyName || 'the company');
  return wrapper(`
    <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px;">Your access request</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${esc(name)},</p>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Your request to join <strong style="color:#1e293b;">${co}</strong> on PunchClock Pro was not approved.
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px;">
      If you believe this is a mistake, please contact the company administrator directly.
      You can also create your own free account at <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a>.
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 28px;">
    <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px;">Votre demande d'acc&egrave;s</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">Bonjour ${esc(name)},</p>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Votre demande pour rejoindre <strong style="color:#1e293b;">${co}</strong> sur PunchClock Pro n&rsquo;a pas &eacute;t&eacute; approuv&eacute;e.
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0;">
      Si vous pensez qu&rsquo;il s&rsquo;agit d&rsquo;une erreur, veuillez contacter directement l&rsquo;administrateur de l&rsquo;entreprise.
      Vous pouvez &eacute;galement cr&eacute;er votre propre compte gratuit sur <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a>.
    </p>
  `);
}
function buildInvitationHtml(inviterName, companyName, role, token) {
  const acceptUrl = `https://www.punchclock.ca?invite=${encodeURIComponent(String(token || ''))}`;
  const isManager = role === 'manager';
  const roleEn = isManager ? 'Manager' : 'Co-Admin';
  const roleFr = isManager ? 'Gestionnaire' : 'Co-administrateur';
  // Role-aware H1 and intro — promotion gets different wording than a generic co-admin invite
  const h1En = isManager
    ? `You've been promoted to Manager 🎉`
    : `You've been invited to join PunchClock Pro`;
  const h1Fr = isManager
    ? `Vous avez été promu(e) gestionnaire 🎉`
    : `Vous avez été invité à rejoindre PunchClock Pro`;
  const introEn = isManager
    ? `<strong style="color:#1e293b;">${esc(inviterName)}</strong> has promoted you to <strong style="color:#4f8ef7;">Manager</strong> at <strong style="color:#1e293b;">${esc(companyName)}</strong> on PunchClock Pro.`
    : `<strong style="color:#1e293b;">${esc(inviterName)}</strong> has invited you to join <strong style="color:#1e293b;">${esc(companyName)}</strong> on PunchClock Pro as a <strong style="color:#4f8ef7;">${roleEn}</strong>.`;
  const introFr = isManager
    ? `<strong style="color:#1e293b;">${esc(inviterName)}</strong> vous a promu(e) <strong style="color:#4f8ef7;">Gestionnaire</strong> chez <strong style="color:#1e293b;">${esc(companyName)}</strong> sur PunchClock Pro.`
    : `<strong style="color:#1e293b;">${esc(inviterName)}</strong> vous a invité à rejoindre <strong style="color:#1e293b;">${esc(companyName)}</strong> sur PunchClock Pro en tant que <strong style="color:#4f8ef7;">${roleFr}</strong>.`;
  return wrapper(`
    <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px;">${h1En}</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">${introEn}</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Click the button below to create your account. You'll set your name and password on the next page.
    </p>
    <a href="${esc(acceptUrl)}" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;">
      ${isManager ? 'Accept & Set Up Account →' : 'Accept Invitation →'}
    </a>
    <p style="color:#94a3b8;font-size:12px;margin-top:16px;text-align:center;">This invitation expires in 7 days. If you weren't expecting this, you can safely ignore this email.</p>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0;">

    <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 16px;">${h1Fr}</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px;">${introFr}</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Cliquez sur le bouton ci-dessous pour créer votre compte. Vous définirez votre nom et mot de passe à l'étape suivante.
    </p>
    <a href="${esc(acceptUrl)}" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;">
      ${isManager ? 'Accepter et configurer le compte →' : 'Accepter l\'invitation →'}
    </a>
    <p style="color:#94a3b8;font-size:12px;margin-top:16px;text-align:center;">Cette invitation expire dans 7 jours. Si vous ne vous attendiez pas à cette invitation, vous pouvez ignorer ce message.</p>
  `);
}
function buildNewAccountNotificationHtml(userName, userEmail, plan, regType, timestamp) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px;">🆕 New Account Registration</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px;">
      A new admin account has been created on PunchClock Pro.
    </p>
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Name</div>
        <div style="font-size:16px;font-weight:600;color:#1e293b">${esc(userName)}</div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Email</div>
        <div style="font-size:14px;color:#4f8ef7">${esc(userEmail)}</div>
      </div>
      <div style="display:flex;gap:24px">
        <div>
          <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Plan</div>
          <div style="font-size:14px;font-weight:600;color:#1e293b">${esc(plan)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Type</div>
          <div style="font-size:14px;color:#1e293b">${esc(regType)}</div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Registered At</div>
        <div style="font-size:13px;color:#475569">${esc(timestamp)}</div>
      </div>
    </div>
    <a href="https://www.punchclock.ca" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;">
      View Admin Panel →
    </a>`);
}
// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  try {
    // Dry run: build the email and return it WITHOUT sending, so templates and routing can be
    // checked on live data. Only honoured for a caller holding the service key; asking for it
    // without that key is refused outright, never silently turned into a real send.
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const isService = !!serviceKey && timingSafeEqual(bearer, serviceKey);
    const dry = req.headers.get("x-dry-run") === "1";
    if (dry && !isService) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    // Only the server may send mail through this function. The browser used to call it with the public
    // key, which let anyone email any address from our domain in their own words; the app now asks
    // secure-db (send_email), which checks the database row first and calls here with the service key.
    // Anything else is refused and logged so a stale client or an abuser shows up in the function log.
    if (!isService) {
      console.warn("send-verification: refused a caller without the service key");
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const body = await req.json();
    const { email, name, code, type, requesterName, requesterEmail, adminName, companyName, purpose } = body;
    if (!email || !name) {
      return new Response(JSON.stringify({
        success: false,
        error: "Missing required fields: email, name"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (!EMAIL_RE.test(String(email))) {
      return new Response(JSON.stringify({ success: false, error: "Invalid email address" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    let subject;
    let html;
    if (type === "join_approved") {
      subject = "Your PunchClock Pro access has been approved!";
      html = buildJoinApprovedHtml(name, adminName || "your administrator");
    } else if (type === "schedule") {
      const { weekLabel, shifts, lang } = body;
      subject = lang === 'fr' ? `🗓️ Votre horaire — ${oneLine(weekLabel)}` : `🗓️ Your schedule — ${oneLine(weekLabel)}`;
      html = buildScheduleHtml(name, weekLabel || '', shifts || [], lang || 'en');
    } else if (type === "employee_invite") {
      const { portalUrl, lang, logoUrl } = body;
      subject = lang === 'fr' ? `🔗 Accès à votre portail employé PunchClock Pro` : `🔗 You've been invited to the PunchClock Pro Employee Portal`;
      html = buildEmployeeInviteHtml(name, siteUrl(portalUrl, 'https://www.punchclock.ca/employee.html'), lang || 'en', companyName || '', logoUrl || '');
    } else if (type === "join_request_denied") {
      subject = "Your access request — PunchClock Pro | Votre demande d'accès";
      html = buildJoinDeniedHtml(name, companyName || '');
    } else if (type === "invitation") {
      const { inviterName, companyName, role, token } = body;
      subject = role === 'manager'
        ? `🎉 You've been promoted to Manager at ${oneLine(companyName || 'your company')} — PunchClock Pro`
        : `You've been invited to join ${oneLine(companyName || 'a company')} on PunchClock Pro | Invitation PunchClock Pro`;
      html = buildInvitationHtml(inviterName || 'Your administrator', companyName || 'your company', role || 'co_admin', token || '');
    } else if (type === "new_account_notification") {
      const { userEmail, plan, regType, timestamp } = body;
      subject = `🆕 New PunchClock Pro registration: ${oneLine(name)}`;
      html = buildNewAccountNotificationHtml(name, userEmail || email, plan || 'Free', regType || 'New Company', timestamp || new Date().toISOString());
    } else {
      if (!code) {
        return new Response(JSON.stringify({
          success: false,
          error: "Missing required field: code"
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      if (purpose === 'password_reset') {
        subject = `${code} — Reset your PunchClock password | Réinitialisez votre mot de passe`;
        html = buildPasswordResetHtml(name, code);
      } else {
        subject = `${code} — Your PunchClock Pro verification code`;
        html = buildVerificationHtml(name, code);
      }
    }
    subject = oneLine(subject);
    if (dry) {
      return new Response(JSON.stringify({ success: true, dry: true, to: email, subject, html }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [
          email
        ],
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Resend error:", JSON.stringify(data));
      return new Response(JSON.stringify({
        success: false,
        error: data.message || "Failed to send email"
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      sent: true,
      id: data.id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
