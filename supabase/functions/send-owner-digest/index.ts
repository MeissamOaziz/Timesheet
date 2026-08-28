// send-owner-digest — the owner's own week, mailed to them.
//
// Distinct from send-weekly-digest, which is the internal business report that goes to one
// inbox. This one goes to each customer about their own company: hours worked, who is on the
// clock, who is waiting on them. The funnel says the day-two return visit is the one that
// never happens (6 of 18 signups ever came back), and an owner has no standing reason to open
// the app on a Monday morning. This is that reason.
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
      You get this once a week because you run a company here.
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
    subject: `Your week at ${o.company}: ${h}h | Votre semaine : ${h} h`,
    html: wrapper(`
      <h1 style="font-size:21px;font-weight:700;color:#1e293b;margin:0 0 8px">Last week at ${co}</h1>
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
      ${o.offNext ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px"><strong>${o.offNext}</strong> approved ${o.offNext > 1 ? "absences are" : "absence is"} coming up next week.</p>` : ""}
      ${cta("Open PunchClock Pro &rarr;")}

      <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 24px">

      <h1 style="font-size:21px;font-weight:700;color:#1e293b;margin:0 0 8px">La semaine derni&egrave;re chez ${co}</h1>
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
      ${o.offNext ? `<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px"><strong>${o.offNext}</strong> absence${o.offNext > 1 ? "s" : ""} approuv&eacute;e${o.offNext > 1 ? "s" : ""} la semaine prochaine.</p>` : ""}
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
  // sending: dry_run reports exactly who would get what, `only` targets one address.
  let dryRun = false, only = "";
  try {
    const b = await req.json();
    dryRun = !!b?.dry_run;
    only = b?.only || "";
  } catch { /* cron posts no body */ }

  try {
    const { data: owners, error } = await withSkewRetry(() => {
      let q = supabase.from("admins")
        .select("id, name, email, weekly_digest, unsub_token")
        .eq("verified", true)
        .neq("role", "super_admin")
        .is("parent_admin_id", null);
      if (only) q = q.eq("email", only.toLowerCase());
      return q as never;
    });
    if (error) throw error;

    const weekEnd = new Date(); weekEnd.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(weekEnd.getTime() - 7 * 86400000);
    const nextWeekEnd = new Date(weekEnd.getTime() + 7 * 86400000);
    const iso = (d: Date) => d.toISOString();
    const day = (d: Date) => d.toISOString().slice(0, 10);

    const results: Array<Record<string, unknown>> = [];

    for (const a of (owners ?? []) as Array<Record<string, string | boolean>>) {
      // Honoured before anything is computed — an unsubscribed owner is not a data question.
      if (a.weekly_digest === false) { results.push({ email: a.email, skipped: "unsubscribed" }); continue; }

      const { data: coRows } = await supabase.from("companies").select("id, name").eq("admin_id", a.id as string);
      const coIds = (coRows ?? []).map((c: { id: string }) => c.id);
      if (!coIds.length) { results.push({ email: a.email, skipped: "no company" }); continue; }

      const { data: punchRows } = await supabase.from("punches")
        .select("emp_id, type, punched_at").in("company_id", coIds)
        .gte("punched_at", iso(weekStart)).lt("punched_at", iso(weekEnd));
      const { hours, people } = pairHours(punchRows ?? []);

      // Silence beats a digest that reports nothing happened.
      if (!(punchRows ?? []).length || hours < 1) {
        results.push({ email: a.email, skipped: "no activity" });
        continue;
      }

      const { count: pendingPunch } = await supabase.from("missed_punch_requests")
        .select("id", { count: "exact", head: true }).in("company_id", coIds).eq("status", "pending");
      const { count: pendingTimeOff } = await supabase.from("time_off")
        .select("id", { count: "exact", head: true }).in("company_id", coIds).eq("status", "pending");
      const { count: offNext } = await supabase.from("time_off")
        .select("id", { count: "exact", head: true }).in("company_id", coIds)
        .eq("status", "approved").gte("start_date", day(weekEnd)).lt("start_date", day(nextWeekEnd));

      const { subject, html } = buildDigest({
        name: String(a.name || "there").split(" ")[0],
        company: (coRows?.[0] as { name?: string })?.name || "your company",
        hours, people, punches: (punchRows ?? []).length,
        pendingPunch: pendingPunch ?? 0, pendingTimeOff: pendingTimeOff ?? 0, offNext: offNext ?? 0,
        unsubUrl: `${APP_URL}/?unsub=${a.unsub_token}`,
      });

      const sent = dryRun ? true : await sendEmail(a.email as string, subject, html);
      results.push({
        email: a.email, sent, dryRun,
        hours: Math.round(hours), people, punches: (punchRows ?? []).length,
        pending: (pendingPunch ?? 0) + (pendingTimeOff ?? 0), subject,
      });
    }

    const totalSent = results.filter((r) => r.sent).length;
    console.log(`owner digest: ${results.length} owners, ${totalSent} ${dryRun ? "would send" : "sent"}`);
    return new Response(JSON.stringify({ ok: true, dryRun, totalSent, results }, null, 2),
      { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("owner digest error:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
