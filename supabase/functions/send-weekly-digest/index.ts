// PunchClock Pro — Weekly Digest Email
// Supabase Edge Function: send-weekly-digest
// Runs weekly via pg_cron (Mondays 9am UTC). Manually triggerable.
// Sends a snapshot of new accounts, trial state, paid tier breakdown, MRR, and login alerts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const DIGEST_TO = "meissam.h.p@gmail.com";

// Pricing (CAD/month, matches Stripe live mode)
const PRICE = { starter: 19.49, growth: 39.49, business: 79.49 };

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { month: "short", day: "2-digit", year: "numeric" });
}
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function fmtMoney(n: number): string {
  return "CA$" + n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Email wrapper (matches existing dark theme) ─────────────────────────────
function wrapper(body: string, headerLine: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 18px;">
  <div style="text-align:center;margin-bottom:28px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
    <div style="color:#8b92a8;font-size:13px;margin-top:6px">${headerLine}</div>
  </div>
  ${body}
  <div style="text-align:center;margin-top:24px;">
    <p style="color:#555e7a;font-size:11px;line-height:1.6">
      <em>Note: Last login tracking started April 14, 2026.<br>Null values for earlier accounts are expected.</em><br><br>
      PunchClock Pro &mdash; Weekly Digest<br>
      Automated message; do not reply.
    </p>
  </div>
</div></body></html>`;
}

function statBox(label: string, value: string, color: string): string {
  return `<div style="flex:1;min-width:130px;background:#1a1d27;border:1px solid #2e3347;border-left:3px solid ${color};border-radius:10px;padding:12px 14px">
    <div style="font-size:11px;color:#8b92a8;text-transform:uppercase;letter-spacing:.5px;font-weight:600">${label}</div>
    <div style="font-size:22px;font-weight:700;color:#e8eaf0;margin-top:4px;line-height:1.1">${value}</div>
  </div>`;
}

function sectionCard(title: string, color: string, inner: string): string {
  return `<div style="background:#1a1d27;border:1px solid #2e3347;border-left:4px solid ${color};border-radius:12px;padding:18px 20px;margin-bottom:16px">
    <h2 style="margin:0 0 12px;color:#e8eaf0;font-size:15px;font-weight:700;letter-spacing:.3px">${title}</h2>
    ${inner}
  </div>`;
}

type AdminRow = {
  id: string; name: string; email: string; plan: string;
  last_login: string | null; created_at: string;
  scheduling_addon?: boolean | null;
};

function userRow(a: AdminRow): string {
  const days = daysSince(a.created_at);
  const lastLogin = a.last_login
    ? `last login ${daysSince(a.last_login)}d ago`
    : `<span style="color:#8b92a8">no recorded login</span>`;
  return `<div style="padding:8px 0;border-bottom:1px solid #2e3347;font-size:13px;line-height:1.5">
    <div style="color:#e8eaf0;font-weight:600">${escapeHtml(a.name || "(no name)")}
      <span style="color:#8b92a8;font-weight:400"> &middot; ${escapeHtml(a.email)}</span>
    </div>
    <div style="color:#8b92a8;font-size:11px;margin-top:2px">
      registered ${days}d ago &middot; ${lastLogin}
    </div>
  </div>`;
}

function emptyHint(text: string): string {
  return `<div style="color:#555e7a;font-size:13px;font-style:italic">${text}</div>`;
}

// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const dateRange = `${fmtDate(sevenDaysAgo)} – ${fmtDate(now)}`;

    // Common select fields
    const SEL = "id,name,email,plan,last_login,created_at,scheduling_addon";

    // 1) NEW THIS WEEK — primary admins registered in the last 7 days
    const { data: newUsers = [], error: e1 } = await supabase
      .from("admins")
      .select(SEL)
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .gte("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false });
    if (e1) throw e1;

    // 2) ACTIVE TRIALS — free, verified, primary admin, registered < 7d ago
    const { data: activeTrials = [], error: e2 } = await supabase
      .from("admins")
      .select(SEL)
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .gte("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false });
    if (e2) throw e2;

    // 3) EXPIRED TRIALS — free, verified, primary admin, registered >= 7d ago
    const { data: expiredTrials = [], error: e3 } = await supabase
      .from("admins")
      .select(SEL)
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .lt("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false });
    if (e3) throw e3;

    // 4) PAID SUBSCRIBERS by tier (primary admins only)
    const tierFilter = (q: any, plan: string) => q.eq("plan", plan).neq("role", "super_admin").is("parent_admin_id", null);

    const { count: starterCount = 0 } = await tierFilter(
      supabase.from("admins").select("id", { count: "exact", head: true }), "starter"
    );
    const { count: growthCount = 0 } = await tierFilter(
      supabase.from("admins").select("id", { count: "exact", head: true }), "growth"
    );
    const { count: businessCount = 0 } = await tierFilter(
      supabase.from("admins").select("id", { count: "exact", head: true }), "business"
    );
    const { count: schedAddonCount = 0 } = await supabase
      .from("admins")
      .select("id", { count: "exact", head: true })
      .eq("scheduling_addon", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null);

    // 5) MRR ESTIMATE
    const mrr = (starterCount ?? 0) * PRICE.starter
              + (growthCount ?? 0) * PRICE.growth
              + (businessCount ?? 0) * PRICE.business;

    // 6) LAST LOGIN ALERTS — paid users who haven't logged in for 30+ days (or never)
    const { data: loginAlerts = [], error: e6 } = await supabase
      .from("admins")
      .select(SEL)
      .neq("plan", "free")
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .or(`last_login.is.null,last_login.lt.${thirtyDaysAgo.toISOString()}`)
      .order("last_login", { ascending: true, nullsFirst: true });
    if (e6) throw e6;

    // 7) TOTAL ACTIVE ACCOUNTS — all primary, non-super admins
    const { count: totalActive = 0 } = await supabase
      .from("admins")
      .select("id", { count: "exact", head: true })
      .neq("role", "super_admin")
      .is("parent_admin_id", null);

    // ── Build email body ────────────────────────────────────────────────────
    const totalPaid = (starterCount ?? 0) + (growthCount ?? 0) + (businessCount ?? 0);

    const statsRow = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">
      ${statBox("Total Accounts", String(totalActive), "#4f8ef7")}
      ${statBox("New This Week", String((newUsers ?? []).length), "#4f8ef7")}
      ${statBox("Active Trials", String((activeTrials ?? []).length), "#f59e0b")}
      ${statBox("Paid Subscribers", String(totalPaid), "#22c55e")}
      ${statBox("MRR", fmtMoney(mrr), "#22c55e")}
    </div>`;

    const newSection = sectionCard(
      `🎉 New This Week (${(newUsers ?? []).length})`,
      "#4f8ef7",
      (newUsers ?? []).length
        ? (newUsers as AdminRow[]).map(userRow).join("")
        : emptyHint("No new primary admins registered in the last 7 days.")
    );

    const activeSection = sectionCard(
      `⏳ Active Trials (${(activeTrials ?? []).length})`,
      "#f59e0b",
      (activeTrials ?? []).length
        ? (activeTrials as AdminRow[]).map(userRow).join("")
        : emptyHint("No active trials currently.")
    );

    const expiredSection = sectionCard(
      `⏰ Expired Trials &mdash; still on free (${(expiredTrials ?? []).length})`,
      "#ef4444",
      (expiredTrials ?? []).length
        ? (expiredTrials as AdminRow[]).map(userRow).join("")
        : emptyHint("No expired trials.")
    );

    const paidSection = sectionCard(
      `💳 Paid Subscribers (${totalPaid}) &middot; MRR ${fmtMoney(mrr)}`,
      "#22c55e",
      `<table style="width:100%;border-collapse:collapse;font-size:13px;color:#e8eaf0">
        <tr><td style="padding:6px 0;border-bottom:1px solid #2e3347">Starter ($19.49/mo)</td><td style="text-align:right;padding:6px 0;border-bottom:1px solid #2e3347;font-weight:700">${starterCount ?? 0}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid #2e3347">Growth ($39.49/mo)</td><td style="text-align:right;padding:6px 0;border-bottom:1px solid #2e3347;font-weight:700">${growthCount ?? 0}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid #2e3347">Business ($79.49/mo)</td><td style="text-align:right;padding:6px 0;border-bottom:1px solid #2e3347;font-weight:700">${businessCount ?? 0}</td></tr>
        <tr><td style="padding:6px 0">Scheduling add-on</td><td style="text-align:right;padding:6px 0;font-weight:700;color:#7c5cbf">${schedAddonCount ?? 0}</td></tr>
      </table>`
    );

    const alertsSection = sectionCard(
      `⚠️ Login Alerts (${(loginAlerts ?? []).length}) &mdash; paid, no login in 30+ days`,
      "#ef4444",
      (loginAlerts ?? []).length
        ? (loginAlerts as AdminRow[]).map(userRow).join("")
        : emptyHint("All paid users have logged in within the last 30 days. 🎉")
    );

    const body = statsRow + newSection + activeSection + expiredSection + paidSection + alertsSection;
    const html = wrapper(body, `Weekly Digest &middot; ${dateRange}`);
    const subject = `📊 PunchClock Pro — Weekly Digest ${dateRange}`;

    // ── Send via Resend ─────────────────────────────────────────────────────
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [DIGEST_TO], subject, html }),
    });
    const sendText = await sendRes.text();
    if (!sendRes.ok) {
      console.error(`Resend error: ${sendText}`);
      return new Response(JSON.stringify({ ok: false, error: sendText }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }

    const summary = {
      ok: true,
      to: DIGEST_TO,
      dateRange,
      counts: {
        newThisWeek: (newUsers ?? []).length,
        activeTrials: (activeTrials ?? []).length,
        expiredTrials: (expiredTrials ?? []).length,
        paid: { starter: starterCount ?? 0, growth: growthCount ?? 0, business: businessCount ?? 0, schedulingAddon: schedAddonCount ?? 0 },
        loginAlerts: (loginAlerts ?? []).length,
        totalActive: totalActive ?? 0,
      },
      mrr: Number(mrr.toFixed(2)),
    };
    console.log("Weekly digest sent:", JSON.stringify(summary));
    return new Response(JSON.stringify(summary, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Weekly digest error:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
