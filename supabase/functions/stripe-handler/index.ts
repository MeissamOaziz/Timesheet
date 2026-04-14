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
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.punchclock.ca",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Max-Age": "86400"
};
// ── Stripe Price IDs (Sandbox) ────────────────────────────────────────────────
const PRICE_IDS = {
  starter: "price_1TM5NRIhFqyQNAEWBIazJeAo",
  growth: "price_1TM5NPIhFqyQNAEW2itq6QuX",
  business: "price_1TM5NPIhFqyQNAEWLuYZjimL",
  extra_seat: "price_1TM5NMIhFqyQNAEWRPqJ23ZY",
  scheduling_addon: "price_1TM5NMIhFqyQNAEWo4s8iSpb"
};
const KNOWN_PRICE_TO_PLAN = {
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
async function verifyWebhookSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",");
    const t = parts.find((p)=>p.startsWith("t="))?.slice(2);
    const v1 = parts.find((p)=>p.startsWith("v1="))?.slice(3);
    if (!t || !v1) return false;
    const enc = new TextEncoder();
    const signed = enc.encode(`${t}.${new TextDecoder().decode(payload)}`);
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), {
      name: "HMAC",
      hash: "SHA-256"
    }, false, [
      "sign"
    ]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, signed);
    const computed = Array.from(new Uint8Array(sigBytes)).map((b)=>b.toString(16).padStart(2, "0")).join("");
    if (computed.length !== v1.length) return false;
    let diff = 0;
    for(let i = 0; i < computed.length; i++)diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
    if (diff !== 0) return false;
    // Reject events older than 300 seconds to prevent replay attacks
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(t);
    if (ageSeconds > 300) return false;
    return true;
  } catch  {
    return false;
  }
}
// ── Webhook ───────────────────────────────────────────────────────────────────
async function handleWebhook(req) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", {
    status: 400,
    headers: corsHeaders
  });
  const rawBody = new Uint8Array(await req.arrayBuffer());
  const valid = await verifyWebhookSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", {
    status: 400,
    headers: corsHeaders
  });
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
    const admin = await getAdminByCustomerId(event.data.object.customer);
    if (admin && admin.plan !== "free") {
      await supabase.from("admins").update({
        status: "active"
      }).eq("id", admin.id);
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
    "webhook"
  ];
  const action = knownActions.includes(lastSegment) ? lastSegment : url.searchParams.get("action") ?? null;
  if (action === "webhook") return handleWebhook(req);
  try {
    const body = await req.json();
    if (action === "checkout") return handleCheckout(body);
    if (action === "portal") return handlePortal(body);
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
