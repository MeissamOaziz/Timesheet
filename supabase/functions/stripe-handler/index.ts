// stripe-handler — Supabase Edge Function
// Uses raw fetch for Stripe API calls (avoids Deno SDK compatibility issues)
// JWT verification: OFF
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
// ── Environment ───────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Referral program: the id of the Stripe coupon (10% off, once) given to a referred account's first checkout.
// Not set = no referral discount is ever added; everything else behaves as before.
const REFERRAL_COUPON_ID = Deno.env.get("REFERRAL_COUPON_ID");
// Same inbox as the weekly digest, churn survey and punch alerts — the one place these land.
const OWNER_INBOX = "meissam.h.p@gmail.com";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.punchclock.ca",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Max-Age": "86400"
};
// ── Stripe Price IDs (Sandbox) ────────────────────────────────────────────────
const PRICE_IDS: Record<string, string> = {
  starter: "price_1TM5NRIhFqyQNAEWBIazJeAo",
  growth: "price_1TM5NPIhFqyQNAEW2itq6QuX",
  business: "price_1TM5NPIhFqyQNAEWLuYZjimL",
  extra_seat: "price_1TM5NMIhFqyQNAEWRPqJ23ZY",
  scheduling_addon: "price_1TM5NMIhFqyQNAEWo4s8iSpb"
};
const KNOWN_PRICE_TO_PLAN: Record<string, string> = {
  "price_1TM5NRIhFqyQNAEWBIazJeAo": "starter",
  "price_1TM5NPIhFqyQNAEW2itq6QuX": "growth",
  "price_1TM5NPIhFqyQNAEWLuYZjimL": "business",
  "price_1TM5NMIhFqyQNAEWRPqJ23ZY": "extra_seat",
  "price_1TM5NMIhFqyQNAEWo4s8iSpb": "scheduling_addon"
};
const MAIN_PLAN_PRICES = new Set([
  PRICE_IDS.starter,
  PRICE_IDS.growth,
  PRICE_IDS.business,
]);
// Growth and Business (and comped Unlimited) include Scheduling since 2026-11-26; on Starter it stays a paid add-on.
// Same rule as secure-db's schedulingActive, the database's admin_scheduling_active and the website.
const SCHEDULING_INCLUDED_PLANS = new Set(["growth", "business", "unlimited"]);
const PLAN_LABELS: Record<string, string> = {
  starter: "Starter ($19.49/mo)",
  growth: "Growth ($39.49/mo)",
  business: "Business ($79.49/mo)",
  extra_seat: "Extra Seat add-on ($19.49/mo)",
  scheduling_addon: "Scheduling add-on ($14.95/mo)",
};
const BILLING_REASON_LABELS: Record<string, string> = {
  subscription_create: "New subscription",
  subscription_cycle: "Renewal payment",
  subscription_update: "Plan change",
  subscription_threshold: "Usage threshold reached",
  manual: "Manual invoice",
};
// ── Raw Stripe API helpers ────────────────────────────────────────────────────
function flattenParams(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)){
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v)) {
      parts.push(...flattenParams(v, key));
    } else if (v !== null && v !== undefined) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts;
}
async function stripePost(path, params, idempotencyKey?: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
    },
    body: flattenParams(params).join("&")
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}
async function stripeGet(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}
// An owner who moves to a plan that includes Scheduling must not keep paying for the separate add-on. Each running
// add-on subscription of that customer is set to end with the period already paid: no refund (Terms), no further
// charge. Its own customer.subscription.deleted event then clears scheduling_addon, and the plan keeps Scheduling on.
// Only a subscription made of nothing but the add-on price is touched, never the main plan's subscription.
async function endSchedulingAddon(customerId: unknown): Promise<number> {
  if (typeof customerId !== "string" || !/^cus_[A-Za-z0-9]+$/.test(customerId)) return 0;
  const list = await stripeGet(`subscriptions?customer=${customerId}&status=all&limit=100`);
  let ended = 0;
  for (const sub of list?.data || []) {
    if (!["active", "trialing", "past_due"].includes(sub.status) || sub.cancel_at_period_end) continue;
    const items = sub.items?.data || [];
    if (!items.length || !items.every((it) => it.price?.id === PRICE_IDS.scheduling_addon)) continue;
    await stripePost(`subscriptions/${sub.id}`, { cancel_at_period_end: "true" }, `end-scheduling-addon-${sub.id}`);
    ended++;
  }
  return ended;
}
async function endSchedulingAddonSafely(customerId: unknown, why: string): Promise<void> {
  // Never allowed to fail the webhook: Stripe would retry and replay the plan change.
  try {
    const n = await endSchedulingAddon(customerId);
    if (n) console.log(`scheduling add-on set to end at period end (${why}): ${n}`);
  } catch (e) { console.error("endSchedulingAddon failed:", (e as Error).message); }
}
// ── Response helpers ──────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function ok() {
  return new Response("OK", {
    status: 200,
    headers: corsHeaders
  });
}
// ── DB helpers ────────────────────────────────────────────────────────────────
async function getAdminByCustomerId(customerId) {
  const { data } = await supabase.from("admins").select("id, plan, extra_seats, scheduling_addon, stripe_subscription_id").eq("stripe_customer_id", customerId).is("parent_admin_id", null).maybeSingle();
  return data;
}
async function getAdminById(adminId) {
  const { data } = await supabase.from("admins").select("id, plan, extra_seats, scheduling_addon, stripe_customer_id, stripe_subscription_id").eq("id", adminId).maybeSingle();
  return data;
}
// ── Who is calling? (checkout and portal) ─────────────────────────────────────────────────────
// These two actions used to trust an `adminId` (and a `priceId`) sent by the browser, so anyone who
// knew an account's id could open that customer's billing portal, and any price could be attached to
// any plan label. The caller is now identified by their admin session token, only the account OWNER
// may manage the subscription, and prices come from this file's own list.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
async function resolveBillingOwner(sessionToken: unknown): Promise<{ id: string; email: string } | { error: string; status: number }> {
  if (typeof sessionToken !== "string" || !TOKEN_RE.test(sessionToken)) return { error: "Please sign in again", status: 401 };
  // Tokens are stored hashed (2026-11-20): the database function does the comparison.
  const { data: rows } = await supabase.rpc("_admin_session_lookup", { p_token: sessionToken });
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s || new Date(s.expires_at as string).getTime() <= Date.now()) return { error: "Please sign in again", status: 401 };
  const { data: a } = await supabase.from("admins").select("id, email, parent_admin_id, status").eq("id", s.admin_id).maybeSingle();
  if (!a || !(a.status === "active" || a.status === "pending_invite")) return { error: "Please sign in again", status: 401 };
  if (a.parent_admin_id) return { error: "Only the account owner can manage the subscription", status: 403 };
  return { id: a.id as string, email: a.email as string };
}
// Redirect targets must stay on our own site.
function safeReturnUrl(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && /^https:\/\/www\.punchclock\.ca(\/|\?|#|$)/.test(candidate) ? candidate : fallback;
}
// A constant-time comparison for the one action reserved for server-to-server use.
function bearerIsServiceKey(req: Request): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") || "");
  if (!m || !SUPABASE_SERVICE_KEY) return false;
  const a = new TextEncoder().encode(m[1]), b = new TextEncoder().encode(SUPABASE_SERVICE_KEY);
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return r === 0;
}
// The nightly pg_cron job (migration 20261201_referral_reconcile_cron.sql) sends the shared cron_secret of
// internal_secrets, like the other scheduled jobs; the service key is accepted too. Loaded once per isolate,
// compared in constant time, fails closed. Used by referral_reconcile only.
let _cronSecret = "";
async function bearerIsServerCaller(req: Request): Promise<boolean> {
  if (bearerIsServiceKey(req)) return true;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") || "");
  if (!m) return false;
  if (!_cronSecret) {
    try {
      const { data } = await supabase.from("internal_secrets").select("value").eq("key", "cron_secret").maybeSingle();
      if (typeof data?.value === "string" && data.value.length >= 32) _cronSecret = data.value;
    } catch (_e) { /* fail closed */ }
  }
  if (!_cronSecret) return false;
  const a = new TextEncoder().encode(m[1]), b = new TextEncoder().encode(_cronSecret);
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return r === 0;
}
async function getAdminContact(adminId: string): Promise<{ name: string; email: string } | null> {
  const { data } = await supabase.from("admins").select("name, email").eq("id", adminId).maybeSingle();
  return data;
}
async function getCompanyNames(adminId: string): Promise<string[]> {
  const { data } = await supabase.from("companies").select("name").eq("admin_id", adminId);
  return ((data ?? []) as Array<{ name: string }>).map((c) => c.name);
}
// ── Payment notifications ─────────────────────────────────────────────────────
// A real-time email every time money actually moves — separate from the weekly digest, which
// only surfaces MRR once a week. Fires from invoice.payment_succeeded rather than
// checkout.session.completed: that is the one event Stripe sends for every successful charge,
// first payment and renewal alike, so one hook covers "just subscribed and paid" and every
// month after without double-sending for the same charge.
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
function resolveInvoicePlan(invoice: any): string | undefined {
  for (const line of invoice.lines?.data ?? []) {
    const priceId = line.price?.id ?? line.plan?.id;
    if (priceId && KNOWN_PRICE_TO_PLAN[priceId]) return KNOWN_PRICE_TO_PLAN[priceId];
  }
  return undefined;
}
function paymentEmailHtml(opts: {
  amount: string; currency: string; reason: string; customerLabel: string;
  email: string; planLabel: string; stripeCustomerId: string;
}): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 16px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:#ffffff;border-bottom:1px solid #e2e8f0;padding:20px 28px"><div style="font-size:18px;font-weight:700;color:#22c55e">&#128176; Payment received</div></td></tr>
  <tr><td style="padding:22px 28px">
    <div style="font-size:28px;font-weight:700;color:#1e293b;margin-bottom:4px">${escHtml(opts.currency)} ${escHtml(opts.amount)}</div>
    <div style="font-size:13px;color:#64748b;margin-bottom:18px">${escHtml(opts.reason)}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#1e293b">
      <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">Customer</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:600">${escHtml(opts.customerLabel)}</td></tr>
      <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">Email</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right">${escHtml(opts.email || "—")}</td></tr>
      <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">Item</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right">${escHtml(opts.planLabel)}</td></tr>
      <tr><td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">Stripe customer</td><td style="padding:6px 0;border-top:1px solid #e2e8f0;text-align:right;font-family:monospace;font-size:11px">${escHtml(opts.stripeCustomerId)}</td></tr>
    </table>
  </td></tr>
</table></td></tr></table></body></html>`;
}
async function sendMail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY) { console.error("RESEND_API_KEY not set — email not sent"); return; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "PunchClock Crew <noreply@punchclock.ca>", to: [to], subject, html }),
    });
    if (!res.ok) console.error(`Resend error: ${await res.text()}`);
  } catch (e) {
    console.error("sendMail failed:", (e as Error).message);
  }
}
async function sendOwnerEmail(subject: string, html: string): Promise<void> {
  await sendMail(OWNER_INBOX, subject, html);
}
async function notifyPayment(invoice: any, adminId: string): Promise<void> {
  // A $0 invoice (100%-off coupon, a credit-balance top-up) is not a payment — nothing moved.
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;
  const [contact, companies] = await Promise.all([getAdminContact(adminId), getCompanyNames(adminId)]);
  const plan = resolveInvoicePlan(invoice);
  const planLabel = plan ? (PLAN_LABELS[plan] ?? plan) : "Unknown item";
  const reason = BILLING_REASON_LABELS[invoice.billing_reason as string] ?? (invoice.billing_reason || "Payment");
  const amount = (invoice.amount_paid / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = String(invoice.currency ?? "cad").toUpperCase();
  const customerLabel = companies.length ? companies.join(", ") : (contact?.name || contact?.email || "Unknown customer");
  const html = paymentEmailHtml({
    amount, currency, reason, customerLabel,
    email: contact?.email ?? "", planLabel, stripeCustomerId: String(invoice.customer ?? ""),
  });
  await sendOwnerEmail(`💰 Payment received — ${currency} ${amount} (${customerLabel})`, html);
}
// ── Idempotency helper ───────────────────────────────────────────────────────
async function isAlreadyProcessed(eventId: string): Promise<boolean> {
  const { data } = await supabase
    .from("processed_webhook_events")
    .select("id")
    .eq("id", eventId)
    .maybeSingle();
  return !!data;
}
async function markProcessed(eventId: string): Promise<void> {
  await supabase
    .from("processed_webhook_events")
    .upsert({ id: eventId, processed_at: new Date().toISOString() });
}
// ── Referral program ──────────────────────────────────────────────────────────
// Design and rules: docs/referral-program.md. Tables: migration 20261201_referral_program.sql.
//
// A referred account (a row in `referrals`, written by secure-db when the code is entered) gets a 10% coupon on
// its first plan checkout. The referrer earns the reward in two halves, each a credit on their Stripe customer
// balance: half 1 when the referred account pays its first month, half 2 when it pays its second month.
//
// Why a payment can never pay twice:
//   * a referral only moves pending -> first_paid -> completed, with an update that names the status it expects;
//   * each half is one row of referral_rewards, unique on (referral_id, half);
//   * the Stripe credit carries that row's id in its metadata and as its idempotency key, and is looked up
//     before it is created.
const DAY_MS = 86_400_000;
// A credit that waits for its referrer to move to a paid plan expires 12 months after it was earned (owner,
// 2026-11-20). A credit already on the Stripe balance does not expire.
const WAITING_CREDIT_MONTHS = 12;
function waitingCreditExpiry(earnedAt: string): Date {
  const d = new Date(earnedAt);
  d.setUTCMonth(d.getUTCMonth() + WAITING_CREDIT_MONTHS);
  return d;
}
const REFERRAL_VOID_BLOCKS_REWARD = new Set(["same_card", "manual", "prior_payment"]);

function invoicePaidAtMs(invoice: any, fallbackSeconds?: number): number {
  const s = Number(invoice?.status_transitions?.paid_at) || Number(fallbackSeconds) || Number(invoice?.created) || 0;
  return s > 0 ? s * 1000 : Date.now();
}
// A plan invoice (Starter, Growth or Business), not an add-on charged alone.
function invoiceHasMainPlan(invoice: any): boolean {
  for (const line of invoice?.lines?.data ?? []) {
    const priceId = line.price?.id ?? line.pricing?.price_details?.price ?? line.plan?.id;
    if (priceId && MAIN_PLAN_PRICES.has(priceId)) return true;
  }
  return false;
}
// The whole rule in one place, with no I/O: what does this paid invoice mean for this referral?
function referralDecision(
  ref: { status: string; created_at: string; first_invoice_id?: string | null; first_paid_at?: string | null },
  promo: { first_payment_days: number; second_payment_min_days: number; second_payment_max_days: number },
  inv: { id: string; paidAtMs: number; total: number; hasMainPlan: boolean; billingReason?: string },
): { action: "none" | "first" | "second" | "void"; reason?: string } {
  // "Pays" = a plan invoice with something to pay after discounts. A $0 invoice is not a payment.
  if (!inv.id || !inv.hasMainPlan || !(inv.total > 0)) return { action: "none" };
  if (ref.status === "pending") {
    if (inv.paidAtMs > Date.parse(ref.created_at) + promo.first_payment_days * DAY_MS) return { action: "void", reason: "first_payment_late" };
    return { action: "first" };
  }
  if (ref.status === "first_paid") {
    if (inv.id === ref.first_invoice_id) return { action: "none" };
    // A plan change in the middle of a month bills a difference: that is not a second month.
    if (inv.billingReason === "subscription_update") return { action: "none" };
    const first = Date.parse(ref.first_paid_at || "");
    if (!Number.isFinite(first)) return { action: "none" };
    if (inv.paidAtMs < first + promo.second_payment_min_days * DAY_MS) return { action: "none" };
    if (inv.paidAtMs > first + promo.second_payment_max_days * DAY_MS) return { action: "void", reason: "second_payment_late" };
    return { action: "second" };
  }
  return { action: "none" };
}
// 1949 cents -> 975 then 974: the two halves always add up to the reward.
function referralHalfCents(rewardCents: number, half: number): number {
  const first = Math.ceil(rewardCents / 2);
  return half === 1 ? first : rewardCents - first;
}
// Stripe's fingerprint is the same for the same card number on any customer of this Stripe account.
async function cardFingerprints(customerId: string): Promise<string[]> {
  const list = await stripeGet(`customers/${encodeURIComponent(customerId)}/payment_methods?type=card&limit=20`);
  const out = new Set<string>();
  for (const pm of list?.data ?? []) if (typeof pm?.card?.fingerprint === "string") out.add(pm.card.fingerprint);
  return [...out];
}
const sharesCard = (a: string[], b: string[]) => a.some((x) => b.includes(x));

async function getPromotion(id: string) {
  const { data } = await supabase.from("referral_promotions").select("*").eq("id", id).maybeSingle();
  return data;
}
async function voidReferral(ref: any, reason: string): Promise<void> {
  await supabase.from("referrals").update({ status: "void", void_reason: reason }).eq("id", ref.id).eq("status", ref.status);
  console.log(`referral ${ref.id} void: ${reason}`);
}

// Checkout: should this account's plan checkout carry the referral coupon? Returns the referral id, or null.
async function referralForCheckout(adminId: string, customerId: string, hadCustomer: boolean): Promise<string | null> {
  if (!REFERRAL_COUPON_ID) return null;
  const { data: ref } = await supabase.from("referrals").select("*").eq("referred_admin_id", adminId).eq("status", "pending").maybeSingle();
  if (!ref || ref.discount_used_at) return null;
  const promo = await getPromotion(ref.promotion_id);
  if (!promo || !promo.enabled) return null;
  // "A code cannot be added after the first payment": an account that already paid us anything is not new.
  if (hadCustomer) {
    const paid = await stripeGet(`invoices?customer=${encodeURIComponent(customerId)}&status=paid&limit=10`);
    if ((paid?.data ?? []).some((i: any) => Number(i.amount_paid) > 0)) {
      await voidReferral(ref, "prior_payment");
      return null;
    }
  }
  return ref.id as string;
}
async function markReferralDiscountUsed(referralId: string, adminId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(referralId)) return;
  await supabase.from("referrals").update({ discount_used_at: new Date().toISOString() })
    .eq("id", referralId).eq("referred_admin_id", adminId).is("discount_used_at", null);
}

// A paid invoice of `adminId`: if that account was referred, move its referral forward and grant what is earned.
async function processReferralPayment(invoice: any, adminId: string, paidAtMs: number): Promise<void> {
  if (!invoice || invoice.status && invoice.status !== "paid") return;
  const { data: ref } = await supabase.from("referrals").select("*").eq("referred_admin_id", adminId).in("status", ["pending", "first_paid"]).maybeSingle();
  if (!ref) return;
  const promo = await getPromotion(ref.promotion_id);
  if (!promo) return;
  const d = referralDecision(ref, promo, {
    id: String(invoice.id || ""), paidAtMs, total: Number(invoice.total ?? invoice.amount_paid ?? 0),
    hasMainPlan: invoiceHasMainPlan(invoice), billingReason: invoice.billing_reason,
  });
  if (d.action === "none") return;
  if (d.action === "void") { await voidReferral(ref, d.reason as string); return; }
  const paidAt = new Date(paidAtMs).toISOString();
  if (d.action === "first") {
    // Same card as the referrer = the same person behind both accounts: it does not count.
    const referredCards = invoice.customer ? await cardFingerprints(String(invoice.customer)) : [];
    const referrer = await getAdminById(ref.referrer_admin_id);
    if (!referrer) { await voidReferral(ref, "referrer_gone"); return; }
    const referrerCards = referrer.stripe_customer_id ? await cardFingerprints(referrer.stripe_customer_id) : [];
    if (sharesCard(referredCards, referrerCards)) { await voidReferral(ref, "same_card"); return; }
    // The cap counts referred accounts that earned their referrer something (a first half that was not voided).
    // Over the cap the new account keeps its 10% (it was given at checkout); only the referrer earns nothing more.
    if (promo.max_rewards_per_referrer) {
      const { data: got } = await supabase.from("referral_rewards").select("id").eq("referrer_admin_id", ref.referrer_admin_id).eq("half", 1).in("status", ["waiting", "delivered"]);
      if ((got ?? []).length >= promo.max_rewards_per_referrer) { await voidReferral(ref, "referrer_cap"); return; }
    }
    const { data: moved } = await supabase.from("referrals")
      .update({ status: "first_paid", first_invoice_id: invoice.id, first_paid_at: paidAt, referred_cards: referredCards })
      .eq("id", ref.id).eq("status", "pending").select("id");
    if (!moved || !moved.length) return;   // another delivery of the same payment got there first
    await grantReferralHalf({ ...ref, referred_cards: referredCards }, promo, 1);
  } else {
    const { data: moved } = await supabase.from("referrals")
      .update({ status: "completed", second_invoice_id: invoice.id, second_paid_at: paidAt })
      .eq("id", ref.id).eq("status", "first_paid").select("id");
    if (!moved || !moved.length) return;
    await grantReferralHalf(ref, promo, 2);
  }
}

// Record one half as earned (once), then try to deliver it.
async function grantReferralHalf(ref: any, promo: any, half: 1 | 2): Promise<void> {
  const ins = await supabase.from("referral_rewards").insert({
    referral_id: ref.id, referrer_admin_id: ref.referrer_admin_id, half,
    amount_cents: referralHalfCents(Number(promo.reward_cents), half), currency: promo.currency || "cad",
  }).select("*").maybeSingle();
  let row = ins.data;
  const fresh = !ins.error && !!row;
  if (ins.error) {
    if (ins.error.code !== "23505") throw new Error(`referral_rewards insert: ${ins.error.message}`);
    // Already recorded by an earlier attempt: carry on from that row.
    ({ data: row } = await supabase.from("referral_rewards").select("*").eq("referral_id", ref.id).eq("half", half).maybeSingle());
  }
  if (!row) return;
  const status = await deliverReferralReward(row, ref);
  // A referrer on Free is told once, when the half is earned, that it waits for them (and until when).
  if (fresh && status === "waiting") await notifyReferrer(row, "waiting");
}

// Put one earned half on the referrer's Stripe balance. A referrer who is not on a paid plan has no invoice to
// reduce, so the row stays "waiting" until they are (see deliverWaitingRewards).
async function deliverReferralReward(row: any, refIn?: any): Promise<string> {
  if (row.status !== "waiting") return row.status;
  if (Date.now() >= waitingCreditExpiry(row.earned_at).getTime()) {
    await supabase.from("referral_rewards").update({ status: "void", void_reason: "expired" }).eq("id", row.id).eq("status", "waiting");
    return "void";
  }
  const referrer = await getAdminById(row.referrer_admin_id);
  if (!referrer || !referrer.stripe_customer_id || !referrer.plan || referrer.plan === "free") return "waiting";
  let ref = refIn;
  if (!ref) ({ data: ref } = await supabase.from("referrals").select("*").eq("id", row.referral_id).maybeSingle());
  const voidRow = async (reason: string) => {
    await supabase.from("referral_rewards").update({ status: "void", void_reason: reason }).eq("id", row.id).eq("status", "waiting");
    return "void";
  };
  if (!ref) return "waiting";
  if (ref.status === "void" && REFERRAL_VOID_BLOCKS_REWARD.has(ref.void_reason)) return await voidRow(ref.void_reason);
  // The referrer may have had no card when half 1 was earned (Free plan). Compare again now that they have one.
  const referredCards: string[] = Array.isArray(ref.referred_cards) ? ref.referred_cards : [];
  if (referredCards.length && sharesCard(referredCards, await cardFingerprints(referrer.stripe_customer_id))) {
    if (ref.status !== "void") await voidReferral(ref, "same_card");
    return await voidRow("same_card");
  }
  const cus = encodeURIComponent(referrer.stripe_customer_id);
  // Was this exact credit already created (an earlier attempt that could not write back)?
  const existing = await stripeGet(`customers/${cus}/balance_transactions?limit=100`);
  let txn = (existing?.data ?? []).find((x: any) => x?.metadata?.referral_reward_id === row.id);
  if (!txn) {
    txn = await stripePost(`customers/${cus}/balance_transactions`, {
      amount: -Math.abs(Number(row.amount_cents)),          // negative = a credit in the customer's favour
      currency: row.currency || "cad",
      // Booked as a marketing expense, not a discount: the invoice it pays keeps its full price and its full tax.
      // metadata[type] lets the books pull every referral credit out of the customer balance history.
      description: `PunchClock Crew referral credit (marketing), part ${row.half} of 2`,
      "metadata[type]": "referral_credit",
      "metadata[referral_reward_id]": row.id,
      "metadata[referral_id]": row.referral_id,
    }, `referral-reward-${row.id}`);
  }
  const { data: moved } = await supabase.from("referral_rewards").update({ status: "delivered", stripe_txn_id: txn.id, delivered_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "waiting").select("id");
  if (!moved || !moved.length) return "delivered";   // a parallel attempt recorded it (and sent the emails)
  await notifyReferrer(row, "delivered");
  const amount = (Number(row.amount_cents) / 100).toFixed(2);
  const contact = await getAdminContact(row.referrer_admin_id);
  await sendOwnerEmail(`Referral credit ${String(row.currency || "cad").toUpperCase()} ${amount} (part ${row.half} of 2)`,
    `<p>A referral credit of <strong>${escHtml(amount)}</strong> was added to the Stripe balance of ${escHtml(contact?.name || "")} (${escHtml(contact?.email || "")}).</p><p>Part ${escHtml(row.half)} of 2. Referral ${escHtml(row.referral_id)}.</p>`);
  return "delivered";
}
// The referrer's own email, English then French (no language is stored for an account). It never names the
// referred business. A failure is logged and never undoes the credit.
async function notifyReferrer(row: any, kind: "delivered" | "waiting"): Promise<void> {
  try {
    const contact = await getAdminContact(row.referrer_admin_id);
    if (!contact?.email) return;
    const cents = Number(row.amount_cents) || 0;
    const en = `$${(cents / 100).toFixed(2)}`, fr = `${(cents / 100).toFixed(2).replace(".", ",")} $`;
    const exp = waitingCreditExpiry(row.earned_at);
    const expEn = exp.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });
    const expFr = exp.toLocaleDateString("fr-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });
    const first = Number(row.half) === 1;
    const whatEn = first ? "A business you referred has paid for its first month of PunchClock Crew."
      : "A business you referred has paid for its second month of PunchClock Crew. This completes your reward for that referral.";
    const whatFr = first ? "Une entreprise que vous avez recommandée a payé son premier mois de PunchClock Crew."
      : "Une entreprise que vous avez recommandée a payé son deuxième mois de PunchClock Crew. Votre récompense pour cette recommandation est complète.";
    const nextEn = kind === "delivered"
      ? `A credit of <strong>${en}</strong> has been added to your account. It will come off your next PunchClock Crew invoice automatically.`
      : `You earned a credit of <strong>${en}</strong>. Your account is on the Free plan, so the credit is kept for you and applied when you move to a paid plan, until ${escHtml(expEn)}.`;
    const nextFr = kind === "delivered"
      ? `Un crédit de <strong>${fr}</strong> a été ajouté à votre compte. Il se déduira automatiquement de votre prochaine facture PunchClock Crew.`
      : `Vous avez gagné un crédit de <strong>${fr}</strong>. Votre compte est au forfait Gratuit : le crédit est conservé et appliqué lorsque vous passerez à un forfait payant, jusqu'au ${escHtml(expFr)}.`;
    const p = (s: string) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#1e293b">${s}</p>`;
    const html = `<!DOCTYPE html><html><body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 16px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:14px;padding:24px 28px"><tr><td>
${p(`Hello ${escHtml(contact.name || "")},`)}${p(whatEn)}${p(nextEn)}${p("Thank you for recommending us. Your code and your credits are in the app: profile menu, Refer a business.")}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0">
${p(`Bonjour ${escHtml(contact.name || "")},`)}${p(whatFr)}${p(nextFr)}${p("Merci de nous avoir recommandés. Votre code et vos crédits sont dans l'application : menu du profil, Recommander une entreprise.")}
</td></tr></table></td></tr></table></body></html>`;
    await sendMail(contact.email, `Referral credit: ${en} | Crédit de parrainage : ${fr}`, html);
  } catch (e) { console.error("notifyReferrer failed:", (e as Error).message); }
}
async function deliverWaitingRewards(adminId: string): Promise<void> {
  const { data: rows } = await supabase.from("referral_rewards").select("*").eq("referrer_admin_id", adminId).eq("status", "waiting");
  for (const row of rows ?? []) {
    try { await deliverReferralReward(row); }
    catch (e) { console.error(`referral reward ${row.id} not delivered:`, (e as Error).message); }
  }
}

// The safety net (service key only): replay Stripe's paid invoices through the same steps, make sure every
// earned half has its row, and deliver what is waiting. Changes nothing when everything is already in order.
async function referralReconcile(): Promise<{ referrals: number; waiting: number; errors: number }> {
  let errors = 0;
  const { data: open } = await supabase.from("referrals").select("*").in("status", ["pending", "first_paid", "completed"]);
  for (const ref0 of open ?? []) {
    try {
      if (ref0.status !== "completed") {
        const referred = await getAdminById(ref0.referred_admin_id);
        if (referred?.stripe_customer_id) {
          const list = await stripeGet(`invoices?customer=${encodeURIComponent(referred.stripe_customer_id)}&status=paid&limit=24`);
          const invoices = [...(list?.data ?? [])].sort((a: any, b: any) => invoicePaidAtMs(a) - invoicePaidAtMs(b));
          for (const inv of invoices) await processReferralPayment(inv, ref0.referred_admin_id, invoicePaidAtMs(inv));
        }
      }
      const { data: ref } = await supabase.from("referrals").select("*").eq("id", ref0.id).maybeSingle();
      const promo = ref ? await getPromotion(ref.promotion_id) : null;
      if (ref && promo && (ref.status === "first_paid" || ref.status === "completed")) {
        await grantReferralHalf(ref, promo, 1);
        if (ref.status === "completed") await grantReferralHalf(ref, promo, 2);
      }
    } catch (e) { errors++; console.error(`referral ${ref0.id} reconcile:`, (e as Error).message); }
  }
  const { data: waiting } = await supabase.from("referral_rewards").select("*").eq("status", "waiting");
  let still = 0;
  for (const row of waiting ?? []) {
    try { if ((await deliverReferralReward(row)) === "waiting") still++; }
    catch (e) { errors++; console.error(`referral reward ${row.id} reconcile:`, (e as Error).message); }
  }
  return { referrals: (open ?? []).length, waiting: still, errors };
}
// ── Checkout ──────────────────────────────────────────────────────────────────
async function handleCheckout(body) {
  const { plan, successUrl, cancelUrl } = body;
  const who = await resolveBillingOwner(body.sessionToken);
  if ("error" in who) return json({ error: who.error }, who.status);
  const adminId = who.id, adminEmail = who.email;
  if (!plan || typeof plan !== "string") {
    return json({
      error: "Missing required field: plan"
    }, 400);
  }
  // Only this file's own price list: a client can no longer attach another price to a plan label.
  const priceId = Object.prototype.hasOwnProperty.call(PRICE_IDS, plan) ? PRICE_IDS[plan] : undefined;
  if (!priceId) return json({
    error: `No price configured for plan: ${plan}`
  }, 400);
  const admin = await getAdminById(adminId);
  if (!admin) return json({
    error: "Admin not found"
  }, 404);
  if (plan === "scheduling_addon" && SCHEDULING_INCLUDED_PLANS.has(String(admin.plan ?? ""))) {
    return json({ error: "Scheduling is already included in your plan" }, 400);
  }
  let customerId = admin.stripe_customer_id;
  const hadCustomer = !!customerId;
  if (!customerId) {
    const customer = await stripePost("customers", {
      email: adminEmail,
      "metadata[adminId]": adminId
    });
    customerId = customer.id;
    await supabase.from("admins").update({
      stripe_customer_id: customerId
    }).eq("id", adminId);
  }
  const isAddon = plan === "extra_seat" || plan === "scheduling_addon";
  const params = {
    customer: customerId,
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: safeReturnUrl(successUrl, `https://www.punchclock.ca?checkout=success&plan=${plan}`),
    cancel_url: safeReturnUrl(cancelUrl, "https://www.punchclock.ca?checkout=cancelled"),
    "metadata[adminId]": adminId,
    "metadata[plan]": plan,
    "subscription_data[metadata][adminId]": adminId,
    "subscription_data[metadata][plan]": plan,
    "billing_address_collection": "required"
  };
  // Referral program: a referred account's first plan checkout carries the 10% coupon. Stripe does not allow a
  // preset discount and the promotion-code box on the same session, so it is one or the other. Any failure in
  // the lookup means "no referral": the checkout itself is never blocked.
  let referralId: string | null = null;
  if (!isAddon) {
    try { referralId = await referralForCheckout(adminId, customerId, hadCustomer); }
    catch (e) { console.error("referralForCheckout failed:", (e as Error).message); }
  }
  if (referralId) {
    params["discounts[0][coupon]"] = REFERRAL_COUPON_ID;
    params["metadata[referralId]"] = referralId;
    params["subscription_data[metadata][referralId]"] = referralId;
  } else if (!isAddon) params["allow_promotion_codes"] = "true";
  const session = await stripePost("checkout/sessions", params);
  return json({
    url: session.url
  });
}
// ── Portal ────────────────────────────────────────────────────────────────────
async function handlePortal(body) {
  const { returnUrl } = body;
  const who = await resolveBillingOwner(body.sessionToken);
  if ("error" in who) return json({ error: who.error }, who.status);
  const admin = await getAdminById(who.id);
  if (!admin?.stripe_customer_id) {
    return json({
      error: "No Stripe customer found for this account"
    }, 404);
  }
  const session = await stripePost("billing_portal/sessions", {
    customer: admin.stripe_customer_id,
    return_url: safeReturnUrl(returnUrl, "https://www.punchclock.ca")
  });
  return json({
    url: session.url
  });
}
// ── Webhook signature verification (pure Web Crypto, no SDK) ─────────────────
async function verifyWebhookSignature(payload: Uint8Array, sigHeader: string, secret: string): Promise<{valid: boolean; reason: string}> {
  try {
    const parts = sigHeader.split(",");
    const t = parts.find((p)=>p.startsWith("t="))?.slice(2);
    const v1 = parts.find((p)=>p.startsWith("v1="))?.slice(3);
    if (!t || !v1) return { valid: false, reason: "malformed_header" };
    const enc = new TextEncoder();
    const signed = enc.encode(`${t}.${new TextDecoder().decode(payload)}`);
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), {
      name: "HMAC",
      hash: "SHA-256"
    }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, signed);
    const computed = Array.from(new Uint8Array(sigBytes)).map((b)=>b.toString(16).padStart(2, "0")).join("");
    if (computed.length !== v1.length) return { valid: false, reason: "hmac_mismatch" };
    let diff = 0;
    for(let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
    if (diff !== 0) return { valid: false, reason: "hmac_mismatch" };
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(t);
    if (ageSeconds > 300) return { valid: false, reason: `too_old_${ageSeconds}s` };
    return { valid: true, reason: "ok" };
  } catch(e) {
    return { valid: false, reason: `exception: ${e.message}` };
  }
}
// ── Webhook ───────────────────────────────────────────────────────────────────
async function handleWebhook(req: Request) {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("FATAL: STRIPE_WEBHOOK_SECRET env var is not set");
    return new Response("Webhook secret not configured", { status: 500, headers: corsHeaders });
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    console.error("Webhook rejected: missing stripe-signature header");
    return new Response("Missing signature", { status: 400, headers: corsHeaders });
  }
  const rawBody = new Uint8Array(await req.arrayBuffer());
  const { valid, reason } = await verifyWebhookSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.error(`Webhook signature invalid: ${reason}`);
    return new Response("Invalid signature", { status: 400, headers: corsHeaders });
  }
  const event = JSON.parse(new TextDecoder().decode(rawBody));
  console.log("Webhook:", event.type);

  // Idempotency: skip if this event was already processed
  if (await isAlreadyProcessed(event.id)) {
    console.log(`Skipping already-processed event: ${event.id}`);
    return ok();
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const adminId = s.metadata?.adminId;
    const plan = s.metadata?.plan;
    if (!adminId || !plan) return ok();
    if (plan === "extra_seat") {
      const admin = await getAdminById(adminId);
      if (admin) {
        await supabase.from("admins").update({
          extra_seats: (Number(admin.extra_seats) || 0) + 1,
          stripe_customer_id: s.customer
        }).eq("id", adminId);
      }
    } else if (plan === "scheduling_addon") {
      await supabase.from("admins").update({
        scheduling_addon: true,
        stripe_customer_id: s.customer
      }).eq("id", adminId);
    } else {
      const updateFields: Record<string, unknown> = {
        plan,
        status: "active",
        stripe_customer_id: s.customer,
        stripe_subscription_id: s.subscription || null,
      };
      // Only reset extra_seats when upgrading to business (unlimited employees)
      if (plan === "business") {
        updateFields.extra_seats = 0;
      }
      await supabase.from("admins").update(updateFields).eq("id", adminId);
      if (SCHEDULING_INCLUDED_PLANS.has(plan)) await endSchedulingAddonSafely(s.customer, `checkout ${plan}`);
      // Referral program. Two things happen when an account starts paying for a plan: the 10% coupon it used
      // (if any) is marked as spent, and referral credits it earned while on Free are put on its Stripe balance.
      // Never allowed to fail the webhook (see the note on notifyPayment below).
      try {
        if (typeof s.metadata?.referralId === "string") await markReferralDiscountUsed(s.metadata.referralId, adminId);
        await deliverWaitingRewards(adminId);
      } catch (e) { console.error("referral (checkout) failed:", (e as Error).message); }
    }
    console.log(`checkout.session.completed: plan=${plan} admin=${adminId}`);
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    // Find the main plan price by scanning all subscription items
    let resolvedPlan: string | undefined;
    for (const item of sub.items?.data || []) {
      const pid = item.price?.id;
      if (pid && MAIN_PLAN_PRICES.has(pid)) {
        resolvedPlan = KNOWN_PRICE_TO_PLAN[pid];
        break;
      }
    }
    // Fall back to metadata if no main plan price found in items
    if (!resolvedPlan) resolvedPlan = sub.metadata?.plan;
    const admin = sub.metadata?.adminId ? await getAdminById(sub.metadata.adminId) : await getAdminByCustomerId(sub.customer);
    if (admin && resolvedPlan && resolvedPlan !== "extra_seat" && resolvedPlan !== "scheduling_addon") {
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : "suspended";
      const updateFields: Record<string, unknown> = {
        plan: resolvedPlan,
        status,
        stripe_subscription_id: sub.id
      };
      // Reset extra_seats only when changing to business (unlimited)
      if (resolvedPlan === "business") {
        updateFields.extra_seats = 0;
      }
      await supabase.from("admins").update(updateFields).eq("id", admin.id);
      if (status === "active" && SCHEDULING_INCLUDED_PLANS.has(resolvedPlan)) {
        await endSchedulingAddonSafely(sub.customer, `plan change ${resolvedPlan}`);
      }
    }
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const priceId = sub.items?.data?.[0]?.price?.id;
    const resolvedPlan = (priceId ? KNOWN_PRICE_TO_PLAN[priceId] : undefined) ?? sub.metadata?.plan;
    const admin = sub.metadata?.adminId ? await getAdminById(sub.metadata.adminId) : await getAdminByCustomerId(sub.customer);
    if (!admin) return ok();
    if (resolvedPlan === "scheduling_addon") {
      await supabase.from("admins").update({
        scheduling_addon: false
      }).eq("id", admin.id);
    } else if (resolvedPlan === "extra_seat") {
      await supabase.from("admins").update({
        extra_seats: Math.max(0, (Number(admin.extra_seats) || 0) - 1)
      }).eq("id", admin.id);
    } else {
      await supabase.from("admins").update({
        plan: "free",
        status: "active",
        stripe_subscription_id: null
      }).eq("id", admin.id);
    }
  } else if (event.type === "invoice.payment_failed") {
    const admin = await getAdminByCustomerId(event.data.object.customer);
    if (admin) await supabase.from("admins").update({
      status: "suspended"
    }).eq("id", admin.id);
  } else if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const admin = await getAdminByCustomerId(invoice.customer);
    if (admin && admin.plan !== "free") {
      await supabase.from("admins").update({
        status: "active"
      }).eq("id", admin.id);
    }
    // Every successful charge on any subscription for this customer — main plan or add-on,
    // first payment or renewal — gets a real-time email. Failures here must never fail the
    // webhook: Stripe retries a non-2xx response, and re-processing state changes on a retry
    // would be a correctness bug, not just a missed email.
    if (admin) {
      try { await notifyPayment(invoice, admin.id); }
      catch (e) { console.error("notifyPayment failed:", (e as Error).message); }
      // Referral program: this payment may be month one or month two of a referred account (a half of the
      // referrer's reward is earned), and the payer may hold referral credits that were waiting for them to be
      // on a paid plan. Same rule as above: a failure is logged, never returned to Stripe. What a failure leaves
      // undone is picked up by the referral_reconcile action.
      try {
        await processReferralPayment(invoice, admin.id, invoicePaidAtMs(invoice, event.created));
        if (admin.plan && admin.plan !== "free") await deliverWaitingRewards(admin.id);
      } catch (e) { console.error("referral (payment) failed:", (e as Error).message); }
    }
  }

  // Mark event as processed for idempotency
  await markProcessed(event.id);
  return ok();
}
// ── Router ────────────────────────────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const lastSegment = pathParts[pathParts.length - 1];
  const knownActions = [
    "checkout",
    "portal",
    "webhook",
    "test_payment_email",
    "referral_reconcile"
  ];
  const action = knownActions.includes(lastSegment) ? lastSegment : url.searchParams.get("action") ?? null;
  if (action === "webhook") return handleWebhook(req);
  try {
    const body = await req.json().catch(() => ({}));
    if (action === "checkout") return handleCheckout(body);
    if (action === "portal") return handlePortal(body);
    if (action === "test_payment_email") {
      // Server-to-server only: anyone else could otherwise make us mail the owner on demand.
      if (!bearerIsServiceKey(req)) return json({ error: "Unauthorized" }, 401);
      // Sends a sample straight to OWNER_INBOX so the notification can be checked without
      // waiting for — or faking — a real Stripe charge.
      await sendOwnerEmail(
        "💰 Payment received — CAD 19.49 (Test Co) [TEST]",
        paymentEmailHtml({
          amount: "19.49", currency: "CAD", reason: "New subscription (test)",
          customerLabel: "Test Co", email: "test@example.com",
          planLabel: PLAN_LABELS.starter, stripeCustomerId: "cus_test000000000000",
        })
      );
      return json({ ok: true });
    }
    if (action === "referral_reconcile") {
      // Server-to-server only (the nightly cron job, or the service key by hand). Re-reads Stripe for open
      // referrals, delivers anything a failed webhook left undone and closes expired waiting credits. Every step is
      // idempotent, so it can be run as often as wanted.
      if (!(await bearerIsServerCaller(req))) return json({ error: "Unauthorized" }, 401);
      const result = await referralReconcile();
      console.log(`referral_reconcile: ${JSON.stringify(result)}`);
      return json({ ok: true, ...result });
    }
    return json({
      error: `Unknown action: ${action}`
    }, 400);
  } catch (err) {
    console.error("Handler error:", err);
    return json({
      error: err.message
    }, 500);
  }
});
