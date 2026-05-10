import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
function wrapper(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#1a1d27;border:1px solid #2e3347;border-radius:16px;padding:36px 32px;">
    ${body}
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="color:#555e7a;font-size:12px;">PunchClock Pro &mdash; Time &amp; Attendance Software<br>This is an automated message, please do not reply.</p>
  </div>
</div></body></html>`;
}
function buildVerificationHtml(name, code) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">Verify your email address</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 28px;">
      Hi ${name}, use the code below to complete your PunchClock Pro registration.
      This code expires in <strong style="color:#e8eaf0;">10 minutes</strong>.
    </p>
    <div style="background:#0f1117;border:2px solid #4f8ef7;border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;">
      <div style="font-size:11px;font-weight:600;color:#8b92a8;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Your verification code</div>
      <div style="font-family:monospace;font-size:42px;font-weight:700;color:#4f8ef7;letter-spacing:12px;">${code}</div>
    </div>
    <p style="color:#555e7a;font-size:13px;line-height:1.6;margin:0;">If you did not request this code, you can safely ignore this email.</p>`);
}
function buildJoinRequestHtml(adminName, requesterName, requesterEmail) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">New co-admin access request</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Hi ${adminName}, someone has requested access to join your PunchClock Pro account as a co-admin.
    </p>
    <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="font-size:12px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Request from</div>
      <div style="font-size:17px;font-weight:600;color:#e8eaf0;">${requesterName}</div>
      <div style="font-size:14px;color:#8b92a8;margin-top:4px;">${requesterEmail}</div>
    </div>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Log in to your PunchClock Pro admin panel and go to <strong style="color:#e8eaf0;">Settings → Co-Admins</strong> to approve or deny this request.
    </p>
    <a href="https://www.punchclock.ca" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;">
      Go to Admin Panel →
    </a>`);
}
function buildCoAdminInviteHtml(inviteeName, adminName, loginUrl) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">You've been invited to co-manage an account</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Hi ${inviteeName}, <strong style="color:#e8eaf0;">${adminName}</strong> has invited you to be a co-admin on their PunchClock Pro account.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Click below to log in and set up your password. You'll have access to all companies and sites associated with this account.
    </p>
    <a href="${loginUrl}" style="display:inline-block;background:#4f8ef7;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;">
      Accept Invitation &amp; Log In →
    </a>
    <p style="color:#555e7a;font-size:12px;margin-top:20px;">If you weren't expecting this invitation, you can safely ignore this email.</p>`);
}
function buildJoinApprovedHtml(coAdminName, primaryAdminName) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">✅ Your access has been approved!</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Hi ${coAdminName}, <strong style="color:#e8eaf0;">${primaryAdminName}</strong> has approved your request to join their PunchClock Pro account.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      You can now log in to access all companies and sites associated with this account.
    </p>
    <a href="https://www.punchclock.ca" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px;">
      Log In to PunchClock Pro →
    </a>`);
}
function buildScheduleHtml(empName, weekLabel, shifts, lang) {
  const isFr = lang === 'fr';
  const title = isFr ? `Votre horaire — ${weekLabel}` : `Your Schedule — ${weekLabel}`;
  const greeting = isFr ? `Bonjour ${empName},` : `Hi ${empName},`;
  const intro = isFr ? `Voici votre horaire de travail pour la semaine du <strong style="color:#e8eaf0">${weekLabel}</strong>.` : `Here is your work schedule for the week of <strong style="color:#e8eaf0">${weekLabel}</strong>.`;
  const noShifts = isFr ? 'Aucun quart prévu cette semaine.' : 'No shifts scheduled this week.';
  const footer = isFr ? 'Pour toute question, contactez votre administrateur.' : 'For any questions, contact your administrator.';
  const shiftRows = shifts.length === 0 ? `<tr><td colspan="3" style="padding:16px;text-align:center;color:#555e7a;font-style:italic">${noShifts}</td></tr>` : shifts.map((s)=>`
      <tr>
        <td style="padding:12px 14px;border-bottom:1px solid #2e3347;font-weight:600;color:#e8eaf0;white-space:nowrap">${s.day}</td>
        <td style="padding:12px 14px;border-bottom:1px solid #2e3347;color:#4f8ef7;font-weight:600;white-space:nowrap">${s.startTime} – ${s.endTime}</td>
        <td style="padding:12px 14px;border-bottom:1px solid #2e3347;color:#8b92a8;font-size:13px">${s.note || '—'}</td>
      </tr>`).join('');
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 6px;">🗓️ ${title}</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 24px;">${greeting}<br>${intro}</p>
    <table style="width:100%;border-collapse:collapse;background:#0f1117;border-radius:10px;overflow:hidden;border:1px solid #2e3347">
      <thead>
        <tr style="background:#222535">
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#555e7a;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Jour' : 'Day'}</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#555e7a;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Heures' : 'Hours'}</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#555e7a;text-transform:uppercase;letter-spacing:.6px">${isFr ? 'Note' : 'Note'}</th>
        </tr>
      </thead>
      <tbody>${shiftRows}</tbody>
    </table>
    <p style="color:#555e7a;font-size:13px;line-height:1.6;margin:20px 0 0">${footer}</p>`);
}
function buildEmployeeInviteHtml(empName, portalUrl, lang) {
  const isFr = lang === 'fr';
  const title = isFr ? `Vous avez accès au portail employé` : `You've been invited to the Employee Portal`;
  const greeting = isFr ? `Bonjour ${empName},` : `Hi ${empName},`;
  const intro = isFr ? `Votre employeur vous a donné accès au <strong style="color:#e8eaf0">portail employé PunchClock Pro</strong>. Depuis ce portail, vous pouvez :` : `Your employer has given you access to the <strong style="color:#e8eaf0">PunchClock Pro Employee Portal</strong>. From the portal, you can:`;
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
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">🔗 ${title}</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">${greeting}<br><br>${intro}</p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;display:flex;flex-direction:column;gap:8px;">
      ${features.map((f)=>`<li style="color:#8b92a8;font-size:14px;padding:8px 14px;background:#0f1117;border-radius:8px;border:1px solid #2e3347">${f}</li>`).join('')}
    </ul>
    <a href="${portalUrl}" style="display:inline-block;background:#7c5cbf;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;">
      ${cta}
    </a>
    <p style="color:#555e7a;font-size:12px;margin-top:20px;text-align:center">${expiry}</p>
    <p style="color:#555e7a;font-size:12px;margin-top:8px;">${ignore}</p>`);
}
function buildJoinDeniedHtml(name, companyName) {
  const co = companyName || 'the company';
  return wrapper(`
    <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 16px;">Your access request</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${name},</p>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Your request to join <strong style="color:#e8eaf0;">${co}</strong> on PunchClock Pro was not approved.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      If you believe this is a mistake, please contact the company administrator directly.
      You can also create your own free account at <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a>.
    </p>
    <hr style="border:none;border-top:1px solid #2e3347;margin:0 0 28px;">
    <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 16px;">Votre demande d'acc&egrave;s</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 16px;">Bonjour ${name},</p>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Votre demande pour rejoindre <strong style="color:#e8eaf0;">${co}</strong> sur PunchClock Pro n&rsquo;a pas &eacute;t&eacute; approuv&eacute;e.
    </p>
    <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0;">
      Si vous pensez qu&rsquo;il s&rsquo;agit d&rsquo;une erreur, veuillez contacter directement l&rsquo;administrateur de l&rsquo;entreprise.
      Vous pouvez &eacute;galement cr&eacute;er votre propre compte gratuit sur <a href="https://punchclock.ca" style="color:#4f8ef7;">punchclock.ca</a>.
    </p>
  `);
}
function buildNewAccountNotificationHtml(userName, userEmail, plan, regType, timestamp) {
  return wrapper(`<h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px;">🆕 New Account Registration</h1>
    <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      A new admin account has been created on PunchClock Pro.
    </p>
    <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Name</div>
        <div style="font-size:16px;font-weight:600;color:#e8eaf0">${userName}</div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Email</div>
        <div style="font-size:14px;color:#4f8ef7">${userEmail}</div>
      </div>
      <div style="display:flex;gap:24px">
        <div>
          <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Plan</div>
          <div style="font-size:14px;font-weight:600;color:#e8eaf0">${plan}</div>
        </div>
        <div>
          <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Type</div>
          <div style="font-size:14px;color:#e8eaf0">${regType}</div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Registered At</div>
        <div style="font-size:13px;color:#8b92a8">${timestamp}</div>
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
    const body = await req.json();
    const { email, name, code, type, requesterName, requesterEmail, adminName, companyName } = body;
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
    let subject;
    let html;
    if (type === "join_request") {
      subject = `New co-admin request from ${requesterName || requesterEmail} — PunchClock Pro`;
      html = buildJoinRequestHtml(name, requesterName || "Someone", requesterEmail || "");
    } else if (type === "co_admin_invite") {
      subject = `You've been invited to co-manage a PunchClock Pro account`;
      html = buildCoAdminInviteHtml(name, body.adminName || "An administrator", body.loginUrl || "https://www.punchclock.ca");
    } else if (type === "join_approved") {
      subject = "Your PunchClock Pro access has been approved!";
      html = buildJoinApprovedHtml(name, adminName || "your administrator");
    } else if (type === "schedule") {
      const { weekLabel, shifts, lang } = body;
      subject = lang === 'fr' ? `🗓️ Votre horaire — ${weekLabel}` : `🗓️ Your schedule — ${weekLabel}`;
      html = buildScheduleHtml(name, weekLabel || '', shifts || [], lang || 'en');
    } else if (type === "employee_invite") {
      const { portalUrl, lang } = body;
      subject = lang === 'fr' ? `🔗 Accès à votre portail employé PunchClock Pro` : `🔗 You've been invited to the PunchClock Pro Employee Portal`;
      html = buildEmployeeInviteHtml(name, portalUrl || 'https://www.punchclock.ca/employee.html', lang || 'en');
    } else if (type === "join_request_denied") {
      subject = "Your access request — PunchClock Pro | Votre demande d'accès";
      html = buildJoinDeniedHtml(name, companyName || '');
    } else if (type === "new_account_notification") {
      const { userEmail, plan, regType, timestamp } = body;
      subject = `🆕 New PunchClock Pro registration: ${name}`;
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
      subject = `${code} — Your PunchClock Pro verification code`;
      html = buildVerificationHtml(name, code);
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
