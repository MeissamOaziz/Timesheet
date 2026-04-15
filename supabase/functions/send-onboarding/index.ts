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

// ── Email wrapper (matches send-verification dark theme) ─────────────────────
function wrapper(body: string): string {
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

function ctaButton(text: string, url: string, color = "#4f8ef7"): string {
  return `<a href="${url}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;margin-top:8px">${text}</a>`;
}

function stepList(): string {
  return `<div style="margin:20px 0 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
      <span style="color:#e8eaf0;font-size:14px"><strong>Create your company</strong> &mdash; name, industry, payroll settings</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
      <span style="color:#e8eaf0;font-size:14px"><strong>Add a site</strong> &mdash; your work location with an access code</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
      <span style="color:#e8eaf0;font-size:14px"><strong>Add employees</strong> &mdash; they can start clocking in immediately</span>
    </div>
  </div>`;
}

// ── Email templates ──────────────────────────────────────────────────────────
function buildDay1(name: string): { subject: string; html: string } {
  return {
    subject: "Welcome to PunchClock Pro \u2014 here's how to get started \uD83C\uDF89",
    html: wrapper(`
      <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px">Welcome aboard, ${name}!</h1>
      <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px">
        Your PunchClock Pro account is ready. Getting set up takes less than 5 minutes &mdash; just follow these 3 simple steps:
      </p>
      ${stepList()}
      ${ctaButton("Set Up My Account \u2192", APP_URL)}
      <p style="color:#555e7a;font-size:13px;margin-top:20px;text-align:center">You still have <strong style="color:#e8eaf0">6 days</strong> to explore &mdash; no credit card needed.</p>
    `)
  };
}

function buildDay3(name: string): { subject: string; html: string } {
  return {
    subject: "Still getting set up? We're here to help \uD83D\uDC4B",
    html: wrapper(`
      <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px">Hi ${name}, need a hand?</h1>
      <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px">
        We noticed you haven't created your company yet. No worries &mdash; it only takes a couple of minutes.
      </p>
      <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 8px">Quick reminder of the steps:</p>
      ${stepList()}
      ${ctaButton("Create My Company Now \u2192", APP_URL)}
      <p style="color:#f59e0b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">Only 4 days left in your trial.</p>
    `)
  };
}

function buildDay6(name: string): { subject: string; html: string } {
  return {
    subject: "\u23F0 Your PunchClock Pro trial expires tomorrow",
    html: wrapper(`
      <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px">Your trial expires tomorrow</h1>
      <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day free trial ends tomorrow. After that, your account will be limited to the free plan.
      </p>
      <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">What you'll lose on the free plan</div>
        <div style="color:#ef4444;font-size:14px;line-height:1.8">
          &bull; Limited to 1 company, 1 site, 5 employees<br>
          &bull; No scheduling or reporting add-ons<br>
          &bull; No geofencing or GPS tracking
        </div>
      </div>
      <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Upgrade starting at</div>
        <div style="font-size:28px;font-weight:700;color:#22c55e">$19.49<span style="font-size:14px;color:#8b92a8;font-weight:400">/mo CAD</span></div>
      </div>
      ${ctaButton("Upgrade Now \u2192", APP_URL, "#22c55e")}
      <p style="color:#555e7a;font-size:13px;margin-top:16px;text-align:center">Or continue free with limited features.</p>
    `)
  };
}

function buildDay7(name: string): { subject: string; html: string } {
  return {
    subject: "Your trial has ended \u2014 here's what happens next",
    html: wrapper(`
      <h1 style="font-size:22px;font-weight:700;color:#e8eaf0;margin:0 0 8px">Your trial period has ended</h1>
      <p style="color:#8b92a8;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day PunchClock Pro trial has ended. But don't worry &mdash; you can still use the free plan:
      </p>
      <div style="background:#0f1117;border:1px solid #2e3347;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Free plan includes</div>
        <div style="color:#e8eaf0;font-size:14px;line-height:1.8">
          &bull; 1 company<br>
          &bull; 1 site<br>
          &bull; Up to 5 employees<br>
          &bull; Basic punch clock features
        </div>
      </div>
      <p style="color:#8b92a8;font-size:14px;line-height:1.6;margin:0 0 20px">
        Need more companies, sites, or employees? Upgrade from <strong style="color:#22c55e">$19.49/mo CAD</strong>.
      </p>
      ${ctaButton("See Upgrade Options \u2192", APP_URL)}
    `)
  };
}

// ── Send email via Resend ────────────────────────────────────────────────────
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

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200 });
  }

  try {
    // Fetch all eligible free-plan admins
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

      // Check if admin has any companies
      let hasCompany = false;
      if (daysSinceReg >= 1 && daysSinceReg <= 5) {
        const { count } = await supabase
          .from("companies")
          .select("id", { count: "exact", head: true })
          .eq("admin_id", admin.id);
        hasCompany = (count ?? 0) > 0;
      }

      // Day 1: welcome (only if no company)
      if (daysSinceReg >= 1 && daysSinceReg <= 2 && !emailsSent.day1 && !hasCompany) {
        const { subject, html } = buildDay1(admin.name);
        if (await sendEmail(admin.email, subject, html)) {
          emailsSent.day1 = true;
          sent.push("day1");
        }
      }

      // Day 3: nudge (only if no company)
      if (daysSinceReg >= 3 && daysSinceReg <= 4 && !emailsSent.day3 && !hasCompany) {
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

      // Update the admin record if any emails were sent
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
