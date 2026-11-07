// "Where new accounts came from" for the internal weekly digest (signup-source tracking, 2026-11-07).
// Pure helpers: no Deno, network or database imports, so tools/weekly-digest-sources-test.mjs can run
// them under Node. Every value that reaches HTML goes through esc(), even though the database already
// limits these columns to plain tokens (CHECK constraints in migration 20261106_signup_source).

export type SourceRow = {
  created_at: string;
  plan?: string | null;
  stripe_subscription_id?: string | null;
  signup_utm_source?: string | null;
  signup_utm_medium?: string | null;
  signup_utm_campaign?: string | null;
  signup_utm_content?: string | null;
  signup_referrer_host?: string | null;
  signup_heard?: string | null;
};

// Accounts created before the page started recording sources have nothing to show.
export const TRACKING_START = "2026-11-07T00:00:00Z";

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ENT[c]);

const HEARD: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", google: "Google search",
  friend: "A friend or colleague", accountant: "Their accountant", other: "Other",
};

export function sourceLabel(a: SourceRow): string {
  const s = (a.signup_utm_source || "").toLowerCase();
  if (s) return s;
  const h = (a.signup_referrer_host || "").toLowerCase();
  if (!h) return "direct / unknown";
  if (/(^|\.)google\.[a-z.]+$/.test(h)) return "google (search)";
  if (/(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com|ecosia\.org)$/.test(h)) return "other search";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(h)) return "facebook (no tag)";
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram (no tag)";
  if (/(^|\.)(linkedin\.com|lnkd\.in)$/.test(h)) return "linkedin (no tag)";
  return "site: " + h;
}

// One line per new account in the digest's lists, e.g. "facebook · launch · p03-demo · said: Their accountant".
export function sourceDetail(a: SourceRow): string {
  if (!a.created_at || a.created_at < TRACKING_START) return "";
  const parts = [sourceLabel(a)];
  if (a.signup_utm_campaign) parts.push(a.signup_utm_campaign);
  if (a.signup_utm_content) parts.push(a.signup_utm_content);
  if (a.signup_heard) parts.push("said: " + (HEARD[a.signup_heard] || a.signup_heard));
  return parts.join(" · ");
}

export type SourceCount = { label: string; week: number; total: number; paying: number };
export function summariseSources(rows: SourceRow[], weekStartIso: string): SourceCount[] {
  const m = new Map<string, SourceCount>();
  for (const r of rows) {
    const label = sourceLabel(r);
    const c = m.get(label) || { label, week: 0, total: 0, paying: 0 };
    c.total++;
    if (r.created_at >= weekStartIso) c.week++;
    if (r.stripe_subscription_id) c.paying++;
    m.set(label, c);
  }
  return [...m.values()].sort((x, y) => y.total - x.total || x.label.localeCompare(y.label));
}

export type HeardCount = { answer: string; total: number; paying: number };
export function summariseHeard(rows: SourceRow[]): HeardCount[] {
  const m = new Map<string, HeardCount>();
  for (const r of rows) {
    const answer = r.signup_heard ? (HEARD[r.signup_heard] || r.signup_heard) : "(left blank)";
    const c = m.get(answer) || { answer, total: 0, paying: 0 };
    c.total++;
    if (r.stripe_subscription_id) c.paying++;
    m.set(answer, c);
  }
  return [...m.values()].sort((x, y) => y.total - x.total || x.answer.localeCompare(y.answer));
}

// The section body. `rows` = primary accounts created since `sinceIso` (tracking start or 60 days back).
export function sourcesSectionHtml(rows: SourceRow[], weekStartIso: string, sinceIso: string): string {
  const since = sinceIso.slice(0, 10);
  if (!rows.length) {
    return `<div style="color:#94a3b8;font-size:13px;font-style:italic">No new accounts since ${esc(since)} yet.</div>`;
  }
  const td = "padding:6px 0;border-bottom:1px solid #e2e8f0";
  const num = `${td};text-align:right;font-weight:700`;
  const sources = summariseSources(rows, weekStartIso).map((c) =>
    `<tr><td style="${td}">${esc(c.label)}</td><td style="${num}">${c.week}</td><td style="${num}">${c.total}</td><td style="${num}">${c.paying}</td></tr>`).join("");
  const heard = summariseHeard(rows).map((c) =>
    `<tr><td style="${td}">${esc(c.answer)}</td><td style="${num}">${c.total}</td><td style="${num}">${c.paying}</td></tr>`).join("");
  const th = "text-align:right;padding:4px 0;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.4px";
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;color:#1e293b">
      <tr><th style="${th};text-align:left">Source</th><th style="${th}">This week</th><th style="${th}">Since ${esc(since)}</th><th style="${th}">Paying now</th></tr>
      ${sources}
    </table>
    <div style="color:#475569;font-size:12px;font-weight:700;margin:14px 0 4px">"How did you hear about us?"</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#1e293b">
      <tr><th style="${th};text-align:left">Answer</th><th style="${th}">Since ${esc(since)}</th><th style="${th}">Paying now</th></tr>
      ${heard}
    </table>
    <div style="color:#475569;font-size:11px;margin-top:10px;line-height:1.5">
      From the link a visitor arrived with (utm tags), else the site that sent them; "direct / unknown" means
      neither. Paying = a live Stripe subscription. Tracking started ${esc(TRACKING_START.slice(0, 10))}.
    </div>`;
}
