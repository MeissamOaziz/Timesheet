// send-support-reply — Supabase Edge Function
// Sends a customer-support reply from "PunchClock Pro Support <support@punchclock.ca>" via
// Resend, on behalf of the overnight support-triage cloud routine. This bypasses Gmail
// entirely — the Gmail MCP tools this project uses (reply/create_draft/send_message) have no
// way to pick a "send as" alias, so anything sent through them goes out as Meissam's primary
// address instead of support@punchclock.ca, and skips that alias's signature. punchclock.ca is
// already a verified Resend sending domain (send-contact's ACK_FROM proves support@ works), so
// this just reuses that rather than fighting Gmail.
//
// JWT verification: OFF — gated instead by a shared secret looked up from internal_secrets
// (never the anon key alone). Unlike send-push/punch-alerts, which only ever push to
// already-registered device tokens or compute their own recipient list server-side, this
// endpoint accepts an arbitrary recipient and free-text body — without a real gate, anyone who
// found this URL could send spam or phishing from our verified domain to any address.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM = '"PunchClock Pro Support" <support@punchclock.ca>';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// Same dark-theme wrapper send-contact/send-verification use, so a support reply looks like
// every other PunchClock email instead of a bare unbranded message.
function wrapper(bodyHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,sans-serif;">
<div style="max-width:540px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#1a1d27;border:1px solid #2e3347;border-radius:16px;padding:36px 32px;">
    ${bodyHtml}
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="color:#555e7a;font-size:12px;">PunchClock Pro Support &mdash; support@punchclock.ca</p>
  </div>
</div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  try {
    const body = await req.json();
    const { secret, to, subject, message } = body as { secret?: string; to?: string; subject?: string; message?: string };

    if (!secret) {
      return new Response(JSON.stringify({ error: 'Missing secret' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const secretRes = await fetch(`${SUPABASE_URL}/rest/v1/internal_secrets?key=eq.support_reply_secret&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const secretRows = secretRes.ok ? await secretRes.json() : [];
    const expected = secretRows?.[0]?.value;
    if (!expected || secret !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (!to || !subject || !message) {
      return new Response(JSON.stringify({ error: 'Missing to/subject/message' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return new Response(JSON.stringify({ error: 'Invalid recipient' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const messageHtml = esc(message).replace(/\n/g, '<br>');
    const html = wrapper(`<div style="color:#e2e8f0;font-size:15px;line-height:1.7">${messageHtml}</div>`);

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!resendRes.ok) {
      const err = await resendRes.text();
      throw new Error(`Resend ${resendRes.status}: ${err}`);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
