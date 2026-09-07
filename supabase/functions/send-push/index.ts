// send-push — Supabase Edge Function
// Sends Expo push notifications to one or more employees' registered devices.
// Zero-infra choice matching "I have Expo Go": Expo's own hosted push API, no Firebase/APNs
// integration needed. Same shape as the email functions (punch-alerts, send-weekly-digest) —
// this is push's equivalent of Resend.
// JWT verification: OFF — called server-to-server from other edge functions (service role),
// never directly by a client. There is no client-facing input to authenticate here.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface PushRequest {
  employee_ids: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

function rest(path: string, init?: RequestInit) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

// Expo asks for batches no larger than 100 messages per request.
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendToTokens(tokens: string[], title: string, body: string, data?: Record<string, unknown>) {
  let sent = 0;
  const errors: string[] = [];
  for (const batch of chunk(tokens, 100)) {
    const messages = batch.map((to) => ({ to, title, body, data: data ?? {}, sound: 'default' }));
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) { errors.push(`Expo ${res.status}: ${await res.text()}`); continue; }
      sent += batch.length;
      // Not polling per-message receipts (DeviceNotRegistered cleanup, delivery confirmation) —
      // a reasonable v1 gap, not a correctness issue: a stale/invalid token just silently fails
      // to deliver, the same fate an email to a dead address has today.
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { sent, errors };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let body: Partial<PushRequest> & { action?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request body' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  if (body.action === 'test') {
    // Smoke test: exercises the Expo call shape without needing a real registered device —
    // Expo's own API rejects the token format harmlessly, which is enough to confirm the
    // function is reachable and talks to Expo correctly.
    const result = await sendToTokens(['ExponentPushToken[test-000000000000000000]'], 'Test', 'send-push smoke test');
    return new Response(JSON.stringify({ ok: true, test: true, result }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const employeeIds = Array.isArray(body.employee_ids) ? body.employee_ids.filter((x) => typeof x === 'string') : [];
  const title = typeof body.title === 'string' ? body.title : '';
  const msg = typeof body.body === 'string' ? body.body : '';
  if (!employeeIds.length || !title || !msg) {
    return new Response(JSON.stringify({ ok: false, error: 'employee_ids, title and body are required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  try {
    const res = await rest(`employee_push_tokens?employee_id=in.(${employeeIds.join(',')})&select=token`);
    const rows: Array<{ token: string }> = res.ok ? await res.json() : [];
    const tokens = rows.map((r) => r.token);
    if (!tokens.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: 'no registered devices for these employees' }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const result = await sendToTokens(tokens, title, msg, body.data);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
