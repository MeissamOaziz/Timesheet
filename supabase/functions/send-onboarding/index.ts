// PunchClock Pro — Onboarding Drip Email Sequence
// Supabase Edge Function: send-onboarding
// Runs daily at 9am UTC via pg_cron
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const APP_URL = "https://www.punchclock.ca";

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

// ── Shared helpers ────────────────────────────────────────────────────────────
function wrapper(body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:36px 32px;">
    ${body}
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="color:#94a3b8;font-size:12px;">PunchClock Pro &mdash; Time &amp; Attendance Software<br>This is an automated message, please do not reply.</p>
  </div>
</div></body></html>`;
}

function ctaButton(text: string, url: string, color = "#4f8ef7"): string {
  return `<a href="${url}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;margin-top:8px">${text}</a>`;
}

function divider(): string {
  return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 28px">`;
}

function stepListEn(): string {
  return `<div style="margin:20px 0 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
      <span style="color:#1e293b;font-size:14px"><strong>Add your first site</strong> &mdash; name, location, optional geofence</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
      <span style="color:#1e293b;font-size:14px"><strong>Add employees</strong> &mdash; name, site, and 4-digit PIN</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
      <span style="color:#1e293b;font-size:14px"><strong>Start tracking</strong> &mdash; point any device at the clock page</span>
    </div>
  </div>`;
}

function stepListFr(): string {
  return `<div style="margin:20px 0 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
      <span style="color:#1e293b;font-size:14px"><strong>Ajoutez votre premier site</strong> &mdash; nom, emplacement, g&eacute;ofence optionnel</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
      <span style="color:#1e293b;font-size:14px"><strong>Ajoutez des employ&eacute;s</strong> &mdash; nom, site et NIP &agrave; 4 chiffres</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
      <span style="color:#1e293b;font-size:14px"><strong>Commencez le suivi</strong> &mdash; pointez n&rsquo;importe quel appareil vers la page de pointage</span>
    </div>
  </div>`;
}

// ── Email templates ───────────────────────────────────────────────────────────
function buildDay1(name: string): { subject: string; html: string } {
  return {
    subject: "Welcome to PunchClock Pro — here’s how to get started 🎉 | Bienvenue sur PunchClock Pro",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Welcome aboard, ${name}!</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Your PunchClock Pro account is ready. Getting set up takes less than 5 minutes &mdash; just follow these 3 simple steps:
      </p>
      ${stepListEn()}
      ${ctaButton("Set Up My Account →", APP_URL)}
      <p style="color:#94a3b8;font-size:13px;margin-top:20px;text-align:center">You still have <strong style="color:#1e293b">6 days</strong> to explore &mdash; no credit card needed.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bienvenue, ${name}!</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Votre compte PunchClock Pro est pr&ecirc;t. La configuration prend moins de 5 minutes &mdash; suivez ces 3 &eacute;tapes simples&nbsp;:
      </p>
      ${stepListFr()}
      ${ctaButton("Configurer mon compte →", APP_URL)}
      <p style="color:#94a3b8;font-size:13px;margin-top:20px;text-align:center">Il vous reste encore <strong style="color:#1e293b">6 jours</strong> pour explorer &mdash; aucune carte de cr&eacute;dit requise.</p>
    `)
  };
}

function buildDay3(name: string): { subject: string; html: string } {
  return {
    subject: "Still getting set up? We’re here to help 👋 | Besoin d’aide?",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Hi ${name}, need a hand?</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        We noticed you haven&rsquo;t added your first site yet. No worries &mdash; it only takes a couple of minutes.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">Quick reminder of the steps:</p>
      ${stepListEn()}
      ${ctaButton("Add My First Site →", APP_URL)}
      <p style="color:#f59e0b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">Only 4 days left in your trial.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bonjour ${name}, besoin d&rsquo;un coup de main&nbsp;?</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Nous avons remarqu&eacute; que vous n&rsquo;avez pas encore ajout&eacute; votre premier site. Pas d&rsquo;inqui&eacute;tude &mdash; &ccedil;a ne prend que quelques minutes.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">Rappel des &eacute;tapes&nbsp;:</p>
      ${stepListFr()}
      ${ctaButton("Ajouter mon premier site →", APP_URL)}
      <p style="color:#f59e0b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">Il ne vous reste que 4 jours dans votre essai.</p>
    `)
  };
}

function buildDay6(name: string): { subject: string; html: string } {
  return {
    subject: "⏰ Your PunchClock Pro trial expires tomorrow | Votre essai expire demain",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Your trial expires tomorrow</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day free trial ends tomorrow. After that, your account will be limited to the free plan.
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">What you&rsquo;ll lose on the free plan</div>
        <div style="color:#ef4444;font-size:14px;line-height:1.8">
          &bull; Limited to 1 site and 5 employees<br>
          &bull; No scheduling or reporting add-ons<br>
          &bull; No geofencing or GPS tracking
        </div>
      </div>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Upgrade starting at</div>
        <div style="font-size:28px;font-weight:700;color:#22c55e">$19.49<span style="font-size:14px;color:#475569;font-weight:400">/mo CAD</span></div>
      </div>
      ${ctaButton("Upgrade Now →", APP_URL, "#22c55e")}
      <p style="color:#94a3b8;font-size:13px;margin-top:16px;text-align:center">Or continue free with limited features.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Votre essai expire demain</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Bonjour ${name}, votre essai gratuit de 7 jours se termine demain. Apr&egrave;s cela, votre compte sera limit&eacute; au plan gratuit.
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Ce que vous perdrez avec le plan gratuit</div>
        <div style="color:#ef4444;font-size:14px;line-height:1.8">
          &bull; Limit&eacute; &agrave; 1 site et 5 employ&eacute;s<br>
          &bull; Pas de modules de planification ou de rapports<br>
          &bull; Pas de g&eacute;olocalisation ni de suivi GPS
        </div>
      </div>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">À partir de</div>
        <div style="font-size:28px;font-weight:700;color:#22c55e">$19.49<span style="font-size:14px;color:#475569;font-weight:400">/mois CAD</span></div>
      </div>
      ${ctaButton("Mettre à niveau maintenant →", APP_URL, "#22c55e")}
      <p style="color:#94a3b8;font-size:13px;margin-top:16px;text-align:center">Ou continuez avec les fonctions limit&eacute;es du plan gratuit.</p>
    `)
  };
}

function buildDay7(name: string): { subject: string; html: string } {
  return {
    subject: "Your trial has ended — here’s what happens next | Votre essai est terminé",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Your trial period has ended</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day PunchClock Pro trial has ended. But don&rsquo;t worry &mdash; you can still use the free plan:
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Free plan includes</div>
        <div style="color:#1e293b;font-size:14px;line-height:1.8">
          &bull; 1 site<br>
          &bull; Up to 5 employees<br>
          &bull; Basic punch clock features
        </div>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px">
        Need more sites or employees? Upgrade from <strong style="color:#22c55e">$19.49/mo CAD</strong>.
      </p>
      ${ctaButton("See Upgrade Options →", APP_URL)}

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Votre p&eacute;riode d&rsquo;essai est termin&eacute;e</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Bonjour ${name}, votre essai PunchClock Pro de 7 jours est termin&eacute;. Mais pas d&rsquo;inqui&eacute;tude &mdash; vous pouvez continuer avec le plan gratuit&nbsp;:
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Le plan gratuit comprend</div>
        <div style="color:#1e293b;font-size:14px;line-height:1.8">
          &bull; 1 site<br>
          &bull; Jusqu&rsquo;&agrave; 5 employ&eacute;s<br>
          &bull; Fonctions de pointage de base
        </div>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px">
        Besoin de plus de sites ou d&rsquo;employ&eacute;s&nbsp;? Passez &agrave; la version payante &agrave; partir de <strong style="color:#22c55e">$19.49/mois CAD</strong>.
      </p>
      ${ctaButton("Voir les options →", APP_URL)}
    `)
  };
}

// ── Send email via Resend ─────────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Resend error for ${to}: ${err}`);
    return false;
  }
  return true;
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200 });
  }

  try {
    // Fetch all eligible free-plan primary admins
    const { data: admins, error: adminsErr } = await supabase
      .from("admins")
      .select("id, name, email, plan, created_at, onboarding_emails_sent")
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null);

    if (adminsErr) throw adminsErr;
    if (!admins?.length) {
      return new Response(JSON.stringify({ ok: true, processed: 0, message: "No eligible admins" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const results: Array<{ admin: string; sent: string[]; skipped: string[] }> = [];

    for (const admin of admins) {
      const sent: string[] = [];
      const skipped: string[] = [];
      const emailsSent: Record<string, boolean> = admin.onboarding_emails_sent || {};
      const daysSinceReg = Math.floor((Date.now() - new Date(admin.created_at).getTime()) / 86400000);

      // Check if admin has any sites — company always exists after registration,
      // so Day 1/3 nudges fire only when setup is still incomplete (no sites yet).
      let hasSite = false;
      if (daysSinceReg >= 1 && daysSinceReg <= 5) {
        const { data: coData } = await supabase
          .from("companies")
          .select("id")
          .eq("admin_id", admin.id)
          .maybeSingle();
        if (coData) {
          const { count } = await supabase
            .from("sites")
            .select("id", { count: "exact", head: true })
            .eq("company_id", coData.id);
          hasSite = (count ?? 0) > 0;
        }
      }

      // Day 1: welcome (only if no site added yet)
      if (daysSinceReg >= 1 && daysSinceReg <= 2 && !emailsSent.day1 && !hasSite) {
        const { subject, html } = buildDay1(admin.name);
        if (await sendEmail(admin.email, subject, html)) {
          emailsSent.day1 = true;
          sent.push("day1");
        }
      }

      // Day 3: nudge (only if no site added yet)
      if (daysSinceReg >= 3 && daysSinceReg <= 4 && !emailsSent.day3 && !hasSite) {
        const { subject, html } = buildDay3(admin.name);
        if (await sendEmail(admin.email, subject, html)) {
          emailsSent.day3 = true;
          sent.push("day3");
        }
      }

      // Day 6: trial expiring tomorrow
      if (daysSinceReg >= 6 && daysSinceReg <= 6 && !emailsSent.day6) {
        const { subject, html } = buildDay6(admin.name);
        if (await sendEmail(admin.email, subject, html)) {
          emailsSent.day6 = true;
          sent.push("day6");
        }
      }

      // Day 7+: trial ended
      if (daysSinceReg >= 7 && !emailsSent.day7) {
        const { subject, html } = buildDay7(admin.name);
        if (await sendEmail(admin.email, subject, html)) {
          emailsSent.day7 = true;
          sent.push("day7");
        }
      }

      // Persist any sent flags back to the admin record
      if (sent.length > 0) {
        await supabase
          .from("admins")
          .update({ onboarding_emails_sent: emailsSent })
          .eq("id", admin.id);
      }

      results.push({ admin: admin.email, sent, skipped });
    }

    const totalSent = results.reduce((n, r) => n + r.sent.length, 0);
    console.log(`Onboarding drip: processed ${admins.length} admins, sent ${totalSent} emails`);

    return new Response(JSON.stringify({ ok: true, processed: admins.length, totalSent, results }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Onboarding error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
