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
async function stripePost(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: flattenParams(params).join("&")
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
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
async function sendOwnerEmail(subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY) { console.error("RESEND_API_KEY not set — payment notification not sent"); return; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "PunchClock Pro <noreply@punchclock.ca>", to: [OWNER_INBOX], subject, html }),
    });
    if (!res.ok) console.error(`Resend error: ${await res.text()}`);
  } catch (e) {
    console.error("sendOwnerEmail failed:", (e as Error).message);
  }
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
// ── Checkout ──────────────────────────────────────────────────────────────────
async function handleCheckout(body) {
  const { plan, adminId, adminEmail, successUrl, cancelUrl, priceId: overridePriceId } = body;
  if (!plan || !adminId || !adminEmail) {
    return json({
      error: "Missing required fields: plan, adminId, adminEmail"
    }, 400);
  }
  const priceId = overridePriceId || PRICE_IDS[plan];
  if (!priceId) return json({
    error: `No price configured for plan: ${plan}`
  }, 400);
  const admin = await getAdminById(adminId);
  if (!admin) return json({
    error: "Admin not found"
  }, 404);
  let customerId = admin.stripe_customer_id;
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
    success_url: successUrl || `https://www.punchclock.ca?checkout=success&plan=${plan}`,
    cancel_url: cancelUrl || "https://www.punchclock.ca?checkout=cancelled",
    "metadata[adminId]": adminId,
    "metadata[plan]": plan,
    "subscription_data[metadata][adminId]": adminId,
    "subscription_data[metadata][plan]": plan,
    "billing_address_collection": "required"
  };
  if (!isAddon) params["allow_promotion_codes"] = "true";
  const session = await stripePost("checkout/sessions", params);
  return json({
    url: session.url
  });
}
// ── Portal ────────────────────────────────────────────────────────────────────
async function handlePortal(body) {
  const { adminId, returnUrl } = body;
  if (!adminId) return json({
    error: "Missing adminId"
  }, 400);
  const admin = await getAdminById(adminId);
  if (!admin?.stripe_customer_id) {
    return json({
      error: "No Stripe customer found for this account"
    }, 404);
  }
  const session = await stripePost("billing_portal/sessions", {
    customer: admin.stripe_customer_id,
    return_url: returnUrl || "https://www.punchclock.ca"
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
    "test_payment_email"
  ];
  const action = knownActions.includes(lastSegment) ? lastSegment : url.searchParams.get("action") ?? null;
  if (action === "webhook") return handleWebhook(req);
  try {
    const body = await req.json().catch(() => ({}));
    if (action === "checkout") return handleCheckout(body);
    if (action === "portal") return handlePortal(body);
    if (action === "test_payment_email") {
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
