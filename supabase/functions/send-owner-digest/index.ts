// send-owner-digest — the owner's own activity, mailed to them on the schedule they chose.
//
// Distinct from send-weekly-digest, which is the internal business report that goes to one
// inbox. This one goes to each customer about their own company: hours worked, who is on the
// clock, who is waiting on them. The funnel says the day-two return visit is the one that
// never happens (6 of 18 signups ever came back), and an owner has no standing reason to open
// the app on a Monday morning. This is that reason.
//
// Per-company delivery preferences (2026-09-12): frequency (daily/weekly/per_period/monthly),
// hour-of-day, day-of-week or day-of-month, and IANA timezone all live on `companies`, set from
// the Company Info modal. Previously this ran once a week for every company, on a fixed UTC
// schedule; the cron now runs hourly and each run decides, per company, whether THIS is its
// chosen local hour. `digest_last_sent_at` is the dedup guard against a cron that fires more
// than once inside the same due hour.
//
// One company at a time (not one email per admin aggregating every company they own, which is
// what this used to do) — a Growth+ admin with three companies can put each on its own cadence,
// and the numbers in the email are never mixed across companies that don't share a schedule.
//
// Two rules keep it from becoming noise:
//   • Nothing to report → nothing sent. A digest reading "0h worked" is worse than silence.
//   • Every send carries a working unsubscribe, honoured before anything else is computed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
const APP_URL = "https://www.punchclock.ca";

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ENT[c]);

// PGRST303 "JWT issued at future" is a platform clock-skew fault that has taken this project
// down twice; the same credential works seconds later. One retry costs nothing.
async function withSkewRetry<T>(fn: () => Promise<{ data: T; error: unknown }>) {
  let r = await fn();
  if (r.error && /PGRST303|JWT issued at future/i.test(JSON.stringify(r.error))) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await fn();
  }
  return r;
}

type Frequency = "daily" | "weekly" | "per_period" | "monthly";

type CompanyRow = {
  id: string; name: string; admin_id: string;
  digest_frequency: Frequency; digest_hour: number;
  digest_day_of_week: number; digest_day_of_month: number;
  digest_timezone: string; digest_last_sent_at: string | null;
  payroll_frequency: string | null; week_start: string | null; payroll_anchor_date: string | null;
};

// Company-local calendar parts for `date`, via ICU — Deno's timezone database is complete, so
// this needs no dependency, just Intl configured with the company's IANA zone.
function localParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

// Mirrors the anchor-aware period-start rule the app itself uses for biweekly (getPayrollPeriods
// in index.html) — a fresh weekly/monthly boundary is unambiguous, but biweekly genuinely needs
// the anchor date to know which of the two weeks is the start.
function isPayrollPeriodStart(co: CompanyRow, p: ReturnType<typeof localParts>): boolean {
  const freq = co.payroll_frequency || "biweekly";
  if (freq === "monthly") return p.day === 1;
  const startWeekday = co.week_start === "sunday" ? 0 : 1;
  if (freq === "weekly") return p.weekday === startWeekday;
  // biweekly
  if (co.payroll_anchor_date) {
    const anchor = new Date(co.payroll_anchor_date + "T00:00:00Z");
    const todayUtcMidnight = Date.UTC(p.year, p.month - 1, p.day);
    const anchorUtcMidnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
    const daysSince = Math.round((todayUtcMidnight - anchorUtcMidnight) / 86400000);
    return daysSince >= 0 && daysSince % 14 === 0;
  }
  return p.weekday === startWeekday; // no anchor set — fall back to a plain weekly cadence
}

function payrollPeriodDays(co: CompanyRow): number {
  const freq = co.payroll_frequency || "biweekly";
  if (freq === "weekly") return 7;
  if (freq === "monthly") return 30; // approximate; monthly period start is the real boundary anyway
  return 14;
}

// Is `now` this company's due moment, and — if so — what window of activity should the email
// cover? Returns null when not due. `lastSent` guards against the hourly cron catching the same
// due hour twice (a retry, or a run a few minutes either side of the top of the hour).
function dueWindow(co: CompanyRow, now: Date, lastSent: Date | null): { start: Date; end: Date } | null {
  const tz = co.digest_timezone || "America/Toronto";
  const p = localParts(now, tz);
  if (p.hour !== co.digest_hour) return null;

  const alreadySentToday = lastSent && (() => {
    const lp = localParts(lastSent, tz);
    return lp.year === p.year && lp.month === p.month && lp.day === p.day;
  })();

  switch (co.digest_frequency) {
    case "daily":
      if (alreadySentToday) return null;
      return { start: new Date(now.getTime() - 86400000), end: now };
    case "weekly": {
      if (p.weekday !== co.digest_day_of_week) return null;
      if (lastSent && now.getTime() - lastSent.getTime() < 6 * 86400000) return null;
      return { start: new Date(now.getTime() - 7 * 86400000), end: now };
    }
    case "monthly": {
      if (p.day !== co.digest_day_of_month) return null;
      if (lastSent) {
        const lp = localParts(lastSent, tz);
        if (lp.year === p.year && lp.month === p.month) return null;
      }
      const start = new Date(now); start.setUTCMonth(start.getUTCMonth() - 1);
      return { start, end: now };
    }
    case "per_period": {
      if (!isPayrollPeriodStart(co, p)) return null;
      if (alreadySentToday) return null;
      const days = payrollPeriodDays(co);
      return { start: new Date(now.getTime() - days * 86400000), end: now };
    }
    default:
      return null;
  }
}

const PERIOD_LABEL: Record<Frequency, { en: string; fr: string }> = {
  daily: { en: "day", fr: "journée" },
  weekly: { en: "week", fr: "semaine" },
  per_period: { en: "pay period", fr: "période de paie" },
  monthly: { en: "month", fr: "mois" },
};

function wrapper(body: string, unsubUrl: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<div style="max-width:540px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:30px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:34px 30px;">
    ${body}
  </div>
  <div style="text-align:center;margin-top:24px;">
    <p style="color:#5c6b7f;font-size:12px;line-height:1.6;margin:0;">
      PunchClock Pro &mdash; Time &amp; Attendance Software<br>
      You get this because you run a company here, on the schedule set in Company Info.
      <a href="${unsubUrl}" style="color:#5c6b7f;">Turn these off</a>.
    </p>
  </div>
</div></body></html>`;
}

const stat = (n: string, label: string) =>
  `<td style="border:1px solid #e2e8f0;padding:13px 10px;text-align:center;background:#f8fafc">
     <span style="font-size:21px;font-weight:700;color:#1e293b;display:block">${n}</span>
     <span style="font-size:10.5px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">${label}</span>
   </td>`;

// Hours from raw punches, pairing each IN with the OUT that follows it for that employee. An
// unclosed IN contributes nothing rather than running to now, so a tablet left on overnight
// cannot inflate a figure we put in front of a customer.
function pairHours(rows: Array<{ emp_id: string; type: string; punched_at: string }>) {
  const byEmp: Record<string, Array<{ type: string; at: number }>> = {};
  for (const r of rows) (byEmp[r.emp_id] ||= []).push({ type: r.type, at: new Date(r.punched_at).getTime() });
  let hours = 0;
  const people = new Set<string>();
  for (const [emp, list] of Object.entries(byEmp)) {
    list.sort((a, b) => a.at - b.at);
    let any = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].type === "IN" && list[i + 1]?.type === "OUT") {
        hours += (list[i + 1].at - list[i].at) / 3600000;
        any = true;
        i++;
      }
    }
    if (any) people.add(emp);
  }
  return { hours, people: people.size };
}

function buildDigest(o: {
  name: string; company: string; hours: number; people: number; punches: number;
  pendingPunch: number; pendingTimeOff: number; offNext: number; unsubUrl: string;
  period: { en: string; fr: string };
}) {
  const h = Math.round(o.hours);
  const pending = o.pendingPunch + o.pendingTimeOff;
  const co = esc(o.company);
  const who = esc(o.name);

  const pendingBox = (title: string, punchLine: string, offLine: string, none: string) =>
    pending > 0
      ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:15px 17px;margin:0 0 20px">
           <p style="color:#92400e;font-size:14px;line-height:1.7;margin:0">
             <strong>${title}</strong><br>
             ${o.pendingPunch ? punchLine + "<br>" : ""}${o.pendingTimeOff ? offLine : ""}
           </p>
         </div>`
      : `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px">${none}</p>`;

  const cta = (label: string) =>
    `<a href="${APP_URL}" style="display:block;background:#4f8ef7;color:#fff;text-decoration:none;padding:13px 30px;border-radius:10px;font-weight:600;font-size:14.5px;text-align:center;margin-top:6px">${label}</a>`;

  return {
    subject: `Your ${o.period.en} at ${o.company}: ${h}h | Votre ${o.period.fr} : ${h} h`,
    html: wrapper(`
      <h1 style="font-size:21px;font-weight:700;color:#1e293b;margin:0 0 8px">Last ${o.period.en} at ${co}</h1>
      <p style="color:#475569;font-size:14.5px;line-height:1.6;margin:0 0 16px">
        Hi ${who}, here is what your team recorded.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 18px"><tr>
        ${stat(h + "h", "Worked")}${stat(String(o.people), "On the clock")}${stat(String(o.punches), "Punches")}
      </tr></table>
      ${pendingBox(
        `${pending} waiting on you`,
        `${o.pendingPunch} missed punch${o.pendingPunch > 1 ? "es" : ""} to review`,
        `${o.pendingTimeOff} time off request${o.pendingTimeOff > 1 ? "s" : ""} to review`,
        "Nothing is waiting on your approval.")}
      ${o.offNext ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px"><strong>${o.offNext}</strong> approved ${o.offNext > 1 ? "absences are" : "absence is"} coming up next.</p>` : ""}
      ${cta("Open PunchClock Pro &rarr;")}

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 24px">

      <h1 style="font-size:21px;font-weight:700;color:#1e293b;margin:0 0 8px">Derni&egrave;re ${o.period.fr} chez ${co}</h1>
      <p style="color:#475569;font-size:14.5px;line-height:1.6;margin:0 0 16px">
        Bonjour ${who}, voici ce que votre &eacute;quipe a enregistr&eacute;.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 18px"><tr>
        ${stat(h + "&nbsp;h", "Travaill&eacute;es")}${stat(String(o.people), "Employ&eacute;s")}${stat(String(o.punches), "Pointages")}
      </tr></table>
      ${pendingBox(
        `${pending} en attente de vous`,
        `${o.pendingPunch} pointage${o.pendingPunch > 1 ? "s" : ""} manquant${o.pendingPunch > 1 ? "s" : ""} &agrave; r&eacute;viser`,
        `${o.pendingTimeOff} demande${o.pendingTimeOff > 1 ? "s" : ""} de cong&eacute; &agrave; r&eacute;viser`,
        "Rien n&rsquo;attend votre approbation.")}
      ${o.offNext ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px"><strong>${o.offNext}</strong> absence${o.offNext > 1 ? "s" : ""} approuv&eacute;e${o.offNext > 1 ? "s" : ""} &agrave; venir.</p>` : ""}
      ${cta("Ouvrir PunchClock Pro &rarr;")}
    `, o.unsubUrl),
  };
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    console.error(`Resend error for ${to}: ${await res.text()}`);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });

  // Copy changes reach every customer on the next run, so the function is inspectable without
  // sending: dry_run reports exactly who would get what, `only` targets one company by id,
  // `force` skips the due-hour check (both are for manual/test invocation from the app).
  let dryRun = false, only = "", force = false;
  try {
    const b = await req.json();
    dryRun = !!b?.dry_run;
    only = b?.only_company_id || "";
    force = !!b?.force;
  } catch { /* cron posts no body */ }

  try {
    const now = new Date();

    let coQuery = supabase.from("companies")
      .select("id, name, admin_id, digest_frequency, digest_hour, digest_day_of_week, digest_day_of_month, digest_timezone, digest_last_sent_at, payroll_frequency, week_start, payroll_anchor_date");
    if (only) coQuery = coQuery.eq("id", only);
    const { data: companies, error: coErr } = await withSkewRetry(() => coQuery as never);
    if (coErr) throw coErr;

    const adminIds = [...new Set((companies ?? []).map((c: CompanyRow) => c.admin_id).filter(Boolean))];
    const { data: adminRows } = adminIds.length
      ? await supabase.from("admins").select("id, name, email, verified, role, weekly_digest, unsub_token").in("id", adminIds)
      : { data: [] };
    const adminById = new Map((adminRows ?? []).map((a: Record<string, unknown>) => [a.id as string, a]));

    const results: Array<Record<string, unknown>> = [];

    for (const co of (companies ?? []) as CompanyRow[]) {
      const admin = adminById.get(co.admin_id) as Record<string, unknown> | undefined;
      if (!admin || admin.role === "super_admin" || !admin.verified) { results.push({ company: co.name, skipped: "no admin" }); continue; }
      // Honoured before anything is computed — an unsubscribed owner is not a data question.
      if (admin.weekly_digest === false) { results.push({ company: co.name, skipped: "unsubscribed" }); continue; }

      const lastSent = co.digest_last_sent_at ? new Date(co.digest_last_sent_at) : null;
      const window = force ? { start: new Date(now.getTime() - 7 * 86400000), end: now } : dueWindow(co, now, lastSent);
      if (!window) { results.push({ company: co.name, skipped: "not due" }); continue; }

      // Mark as processed for this due hour immediately (unless this is just a dry run) — a cron
      // that fires more than once inside the same hour must not double-send.
      if (!dryRun) await supabase.from("companies").update({ digest_last_sent_at: now.toISOString() }).eq("id", co.id);

      const iso = (d: Date) => d.toISOString();
      const { data: punchRows } = await supabase.from("punches")
        .select("emp_id, type, punched_at").eq("company_id", co.id)
        .gte("punched_at", iso(window.start)).lt("punched_at", iso(window.end));
      const { hours, people } = pairHours(punchRows ?? []);

      // Silence beats a digest that reports nothing happened.
      if (!(punchRows ?? []).length || hours < 1) {
        results.push({ company: co.name, skipped: "no activity" });
        continue;
      }

      const day = (d: Date) => d.toISOString().slice(0, 10);
      const { count: pendingPunch } = await supabase.from("missed_punch_requests")
        .select("id", { count: "exact", head: true }).eq("company_id", co.id).eq("status", "pending");
      const { count: pendingTimeOff } = await supabase.from("time_off")
        .select("id", { count: "exact", head: true }).eq("company_id", co.id).eq("status", "pending");
      const { count: offNext } = await supabase.from("time_off")
        .select("id", { count: "exact", head: true }).eq("company_id", co.id)
        .eq("status", "approved").gte("start_date", day(window.end)).lt("start_date", day(new Date(window.end.getTime() + 7 * 86400000)));

      const period = PERIOD_LABEL[co.digest_frequency] || PERIOD_LABEL.weekly;
      const { subject, html } = buildDigest({
        name: String(admin.name || "there").split(" ")[0],
        company: co.name || "your company",
        hours, people, punches: (punchRows ?? []).length,
        pendingPunch: pendingPunch ?? 0, pendingTimeOff: pendingTimeOff ?? 0, offNext: offNext ?? 0,
        unsubUrl: `${APP_URL}/?unsub=${admin.unsub_token}`,
        period,
      });

      const sent = dryRun ? true : await sendEmail(admin.email as string, subject, html);
      results.push({
        company: co.name, email: admin.email, sent, dryRun, frequency: co.digest_frequency,
        hours: Math.round(hours), people, punches: (punchRows ?? []).length,
        pending: (pendingPunch ?? 0) + (pendingTimeOff ?? 0), subject,
      });
    }

    const totalSent = results.filter((r) => r.sent).length;
    console.log(`owner digest: ${results.length} companies checked, ${totalSent} ${dryRun ? "would send" : "sent"}`);
    return new Response(JSON.stringify({ ok: true, dryRun, totalSent, results }, null, 2),
      { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("owner digest error:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
