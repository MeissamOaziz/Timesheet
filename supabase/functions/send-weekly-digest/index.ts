// PunchClock Pro — Weekly Digest Email
// Supabase Edge Function: send-weekly-digest
// Runs weekly via pg_cron (Mondays 9am UTC). Manually triggerable.
// Sends a snapshot of new accounts, the free base, paying customers, comped accounts, MRR
// (from live Stripe subscriptions only), and login alerts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const DIGEST_TO = "meissam.h.p@gmail.com";

// Pricing (CAD/month, matches Stripe live mode)
const PRICE = { starter: 19.49, growth: 39.49, business: 79.49, schedulingAddon: 14.95 };

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
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 18px;">
  <div style="text-align:center;margin-bottom:28px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
    <div style="color:#475569;font-size:13px;margin-top:6px">${headerLine}</div>
  </div>
  ${body}
  <div style="text-align:center;margin-top:24px;">
    <p style="color:#94a3b8;font-size:11px;line-height:1.6">
      <em>Note: Last login tracking started April 14, 2026.<br>Null values for earlier accounts are expected.</em><br><br>
      PunchClock Pro &mdash; Weekly Digest<br>
      Automated message; do not reply.
    </p>
  </div>
</div></body></html>`;
}

function statBox(label: string, value: string, color: string): string {
  return `<div style="flex:1;min-width:130px;background:#ffffff;border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:10px;padding:12px 14px">
    <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.5px;font-weight:600">${label}</div>
    <div style="font-size:22px;font-weight:700;color:#1e293b;margin-top:4px;line-height:1.1">${value}</div>
  </div>`;
}

function sectionCard(title: string, color: string, inner: string): string {
  return `<div style="background:#ffffff;border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:12px;padding:18px 20px;margin-bottom:16px">
    <h2 style="margin:0 0 12px;color:#1e293b;font-size:15px;font-weight:700;letter-spacing:.3px">${title}</h2>
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
    : `<span style="color:#475569">no recorded login</span>`;
  return `<div style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:13px;line-height:1.5">
    <div style="color:#1e293b;font-weight:600">${escapeHtml(a.name || "(no name)")}
      <span style="color:#475569;font-weight:400"> &middot; ${escapeHtml(a.email)}</span>
    </div>
    <div style="color:#475569;font-size:11px;margin-top:2px">
      registered ${days}d ago &middot; ${lastLogin}
    </div>
  </div>`;
}

function emptyHint(text: string): string {
  return `<div style="color:#94a3b8;font-size:13px;font-style:italic">${text}</div>`;
}

// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });

  // dry_run computes every figure and returns it without sending. Added because verifying a
  // change to the revenue numbers should not require mailing the owner a digest he did not ask
  // for, and because the counts are worth being able to check against Stripe at any time.
  let dryRun = false;
  try {
    const p = await req.json();
    dryRun = p?.dry_run === true;
  } catch { /* no body: a normal cron invocation */ }

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

    // 2) NEW FREE ACCOUNTS — free, verified, primary admin, registered < 7d ago.
    // Previously labelled "Active Trials". There is no trial in the product: no plan has ever
    // had a trial period, so every one of these is simply someone on the free plan who signed
    // up this week. The old label made the free tier look like a funnel stage that expires.
    const { data: newFree = [], error: e2 } = await supabase
      .from("admins")
      .select(SEL)
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .gte("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false });
    if (e2) throw e2;

    // 3) ESTABLISHED FREE ACCOUNTS — free, verified, primary admin, registered >= 7d ago.
    // Previously "Expired Trials", which described nothing: nothing expired, and these people
    // are not lapsed customers. They are the free user base.
    const { data: olderFree = [], error: e3 } = await supabase
      .from("admins")
      .select(SEL)
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .lt("created_at", sevenDaysAgo.toISOString())
      .order("created_at", { ascending: false });
    if (e3) throw e3;

    // 4) PAID SUBSCRIBERS — everyone on a non-free plan, split by whether they are actually
    // being billed.
    //
    // This used to count the `plan` column alone, which is set for three different reasons:
    // a real Stripe checkout, a grandfathered company (GRANDFATHERED_NAMES in the app), and the
    // owner's own account. The result was a digest reporting three paid subscribers and
    // CA$178.47 MRR when Stripe had one subscription totalling $19.49 — a nine-fold overstatement
    // of revenue, in the one number most likely to be read as fact.
    //
    // stripe_subscription_id is the ground truth: it is written only by
    // checkout.session.completed and cleared on customer.subscription.deleted. Accounts on a paid
    // plan without one are comped, and are now reported as such instead of as income.
    const { data: nonFree = [], error: e4 } = await supabase
      .from("admins")
      .select(SEL + ",stripe_subscription_id")
      .neq("plan", "free")
      .neq("role", "super_admin")
      .is("parent_admin_id", null)
      .order("created_at", { ascending: true });
    if (e4) throw e4;

    // Built with a concatenated select string, so supabase-js cannot infer the row shape.
    type BillRow = AdminRow & { stripe_subscription_id: string | null };
    const nonFreeRows = (nonFree ?? []) as unknown as BillRow[];
    const billed = nonFreeRows.filter(a => !!a.stripe_subscription_id);
    const comped = nonFreeRows.filter(a => !a.stripe_subscription_id);

    const tier = (plan: string) => billed.filter(a => a.plan === plan).length;
    const starterCount = tier("starter");
    const growthCount  = tier("growth");
    const businessCount = tier("business");

    // The add-on is only revenue when the account behind it is actually being billed.
    const schedAddonCount = billed.filter(a => a.scheduling_addon).length;

    // 5) MRR — summed per billed account from its own plan, so a plan with no listed price
    // contributes nothing rather than silently inheriting another tier's number.
    const mrr = billed.reduce(
      (sum, a) => sum + (PRICE[a.plan as keyof typeof PRICE] ?? 0), 0
    ) + schedAddonCount * PRICE.schedulingAddon;

    // 6) LAST LOGIN ALERTS — billed customers who haven't logged in for 30+ days (or never).
    // Scoped to billed accounts: the owner's own two accounts were on this list every week,
    // which is exactly the noise that trains someone to stop reading the section.
    const thirty = thirtyDaysAgo.getTime();
    const loginAlerts = billed
      .filter(a => !a.last_login || new Date(a.last_login).getTime() < thirty)
      .sort((x, y) => new Date(x.last_login ?? 0).getTime() - new Date(y.last_login ?? 0).getTime());

    // 7) TOTAL ACTIVE ACCOUNTS — all primary, non-super admins
    const { count: totalActive = 0 } = await supabase
      .from("admins")
      .select("id", { count: "exact", head: true })
      .neq("role", "super_admin")
      .is("parent_admin_id", null);

    // ── Build email body ────────────────────────────────────────────────────
    const totalPaid = billed.length;

    const statsRow = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">
      ${statBox("Total Accounts", String(totalActive), "#4f8ef7")}
      ${statBox("New This Week", String((newUsers ?? []).length), "#4f8ef7")}
      ${statBox("Free Accounts", String((newFree ?? []).length + (olderFree ?? []).length), "#f59e0b")}
      ${statBox("Paying Customers", String(totalPaid), "#22c55e")}
      ${statBox("MRR", fmtMoney(mrr), "#22c55e")}
    </div>`;

    const newSection = sectionCard(
      `🎉 New This Week (${(newUsers ?? []).length})`,
      "#4f8ef7",
      (newUsers ?? []).length
        ? (newUsers as AdminRow[]).map(userRow).join("")
        : emptyHint("No new primary admins registered in the last 7 days.")
    );

    const newFreeSection = sectionCard(
      `🆕 New Free Accounts &mdash; this week (${(newFree ?? []).length})`,
      "#f59e0b",
      (newFree ?? []).length
        ? (newFree as AdminRow[]).map(userRow).join("")
        : emptyHint("No new free accounts in the last 7 days.")
    );

    const olderFreeSection = sectionCard(
      `👥 Free Accounts &mdash; 7+ days old (${(olderFree ?? []).length})`,
      "#64748b",
      (olderFree ?? []).length
        ? (olderFree as AdminRow[]).map(userRow).join("")
        : emptyHint("No established free accounts.")
    );

    const tierRow = (label: string, n: number, last = false) =>
      `<tr><td style="padding:6px 0${last ? "" : ";border-bottom:1px solid #e2e8f0"}">${label}</td>` +
      `<td style="text-align:right;padding:6px 0${last ? "" : ";border-bottom:1px solid #e2e8f0"};font-weight:700">${n}</td></tr>`;

    const paidSection = sectionCard(
      `💳 Paying Customers (${totalPaid}) &middot; MRR ${fmtMoney(mrr)}`,
      "#22c55e",
      `<table style="width:100%;border-collapse:collapse;font-size:13px;color:#1e293b">
        ${tierRow("Starter ($19.49/mo)", starterCount)}
        ${tierRow("Growth ($39.49/mo)", growthCount)}
        ${tierRow("Business ($79.49/mo)", businessCount)}
        ${tierRow(`Scheduling add-on ($${PRICE.schedulingAddon}/mo)`, schedAddonCount, true)}
      </table>
      <div style="color:#475569;font-size:11px;margin-top:10px;line-height:1.5">
        Counts only accounts with a live Stripe subscription, so this figure should match the
        Stripe dashboard. Comped accounts are listed separately below.
      </div>
      ${billed.length ? `<div style="margin-top:10px">${billed.map(userRow).join("")}</div>` : ""}`
    );

    // Named, not hidden. These accounts really do have paid-tier access; they just are not
    // revenue, and the previous digest counted them as though they were.
    const compedSection = sectionCard(
      `🎁 Comped &mdash; paid plan, no subscription (${comped.length})`,
      "#7c5cbf",
      comped.length
        ? comped.map(userRow).join("") +
          `<div style="color:#475569;font-size:11px;margin-top:10px;line-height:1.5">
            Grandfathered or internal accounts. They have paid-tier access but generate no MRR.
          </div>`
        : emptyHint("No comped accounts.")
    );

    const alertsSection = sectionCard(
      `⚠️ Login Alerts (${loginAlerts.length}) &mdash; paying, no login in 30+ days`,
      "#ef4444",
      loginAlerts.length
        ? loginAlerts.map(userRow).join("")
        : emptyHint("Every paying customer has logged in within the last 30 days. 🎉")
    );

    const body = statsRow + newSection + newFreeSection + olderFreeSection
               + paidSection + compedSection + alertsSection;
    const html = wrapper(body, `Weekly Digest &middot; ${dateRange}`);
    const subject = `📊 PunchClock Pro — Weekly Digest ${dateRange}`;

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true, dry_run: true, dateRange,
        mrr: Number(mrr.toFixed(2)),
        paying: billed.map(a => ({ email: a.email, plan: a.plan, subscription: a.stripe_subscription_id })),
        comped: comped.map(a => ({ email: a.email, plan: a.plan })),
        freeAccounts: (newFree ?? []).length + (olderFree ?? []).length,
        totalAccounts: totalActive ?? 0,
        loginAlerts: loginAlerts.map(a => a.email),
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

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
        newFree: (newFree ?? []).length,
        olderFree: (olderFree ?? []).length,
        paying: { starter: starterCount, growth: growthCount, business: businessCount, schedulingAddon: schedAddonCount },
        comped: comped.length,
        loginAlerts: loginAlerts.length,
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
