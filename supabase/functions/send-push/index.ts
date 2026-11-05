// send-push — Supabase Edge Function
// Sends Expo push notifications to one or more employees' registered devices (employee_ids) and/or
// to admins' devices (admin_ids: owners, co-admins, managers, registered by the admin app).
// Zero-infra choice matching "I have Expo Go": Expo's own hosted push API, no Firebase/APNs
// integration needed. Same shape as the email functions (punch-alerts, send-weekly-digest) —
// this is push's equivalent of Resend.
// JWT verification: OFF — called server-to-server from other edge functions (service role),
// never directly by a client. The gate is in code: the bearer must be the service-role key or
// the cron secret (see isAuthorised below); anything else gets 401 before any work.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---- Caller authorisation (server-to-server only) --------------------------------------------
// verify_jwt is OFF on this function, so the gate is here: the Authorization bearer must equal the
// service-role key or the `cron_secret` row of internal_secrets (what pg_cron sends). Compared in
// constant time; the secret is loaded once per isolate. Anything else gets 401 before any work.
const _enc = new TextEncoder();
function safeEq(a: string, b: string): boolean {
  const x = _enc.encode(a), y = _enc.encode(b);
  let r = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) r |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return r === 0;
}
let _cronSecret = '';
async function loadCronSecret(): Promise<string> {
  if (_cronSecret) return _cronSecret;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/internal_secrets?key=eq.cron_secret&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (r.ok) {
      const rows = await r.json();
      const v = rows?.[0]?.value;
      if (typeof v === 'string' && v.length >= 32) _cronSecret = v;
    }
  } catch (_e) { /* fail closed */ }
  return _cronSecret;
}
async function isAuthorised(req: Request): Promise<boolean> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') || '');
  if (!m) return false;
  const tok = m[1];
  if (SERVICE_KEY && safeEq(tok, SERVICE_KEY)) return true;
  const cs = await loadCronSecret();
  return cs !== '' && safeEq(tok, cs);
}
function unauthorizedResponse(cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
}
// ----------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 200;

interface PushRequest {
  employee_ids?: string[];
  admin_ids?: string[];   // owners / co-admins / managers: tokens live in admin_push_tokens
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
  if (!(await isAuthorised(req))) return unauthorizedResponse(CORS);

  let body: Partial<PushRequest> & { action?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request body' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Harmless probe so a deployment can be verified without contacting Expo or any device.
  if (body.action === 'auth_probe') {
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  if (body.action === 'test') {
    // Smoke test: exercises the Expo call shape without needing a real registered device —
    // Expo's own API rejects the token format harmlessly, which is enough to confirm the
    // function is reachable and talks to Expo correctly.
    const result = await sendToTokens(['ExponentPushToken[test-000000000000000000]'], 'Test', 'send-push smoke test');
    return new Response(JSON.stringify({ ok: true, test: true, sent: result.sent, failed: result.errors.length }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Every id is interpolated into a PostgREST in.(...) list, so only well-formed UUIDs get through.
  const employeeIds = Array.isArray(body.employee_ids)
    ? body.employee_ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)).slice(0, MAX_IDS)
    : [];
  // Admin recipients (admin app): same UUID filtering and cap, tokens from admin_push_tokens.
  const adminIds = Array.isArray(body.admin_ids)
    ? body.admin_ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)).slice(0, MAX_IDS)
    : [];
  const title = typeof body.title === 'string' ? body.title : '';
  const msg = typeof body.body === 'string' ? body.body : '';
  if ((!employeeIds.length && !adminIds.length) || !title || !msg) {
    return new Response(JSON.stringify({ ok: false, error: 'valid employee_ids or admin_ids, title and body are required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  try {
    let tokens: string[] = [];
    if (employeeIds.length) {
      const res = await rest(`employee_push_tokens?employee_id=in.(${employeeIds.join(',')})&select=token`);
      const rows: Array<{ token: string }> = res.ok ? await res.json() : [];
      tokens = rows.map((r) => r.token);
    }
    if (adminIds.length) {
      // Up to MAX_IDS admins x 10 devices can exceed PostgREST's 1000-row cap, so order and page.
      for (let offset = 0; offset < 5000; offset += 1000) {
        const res = await rest(`admin_push_tokens?admin_id=in.(${adminIds.join(',')})&select=token&order=token.asc&limit=1000&offset=${offset}`);
        if (!res.ok) break;
        const rows: Array<{ token: string }> = await res.json();
        tokens.push(...rows.map((r) => r.token));
        if (rows.length < 1000) break;
      }
      tokens = [...new Set(tokens)]; // one message per device even if a token were ever in both tables
    }
    if (!tokens.length) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: adminIds.length ? 'no registered devices for these recipients' : 'no registered devices for these employees' }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const result = await sendToTokens(tokens, title, msg, body.data);
    return new Response(JSON.stringify({ ok: true, sent: result.sent, failed: result.errors.length }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('send-push error:', (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: 'Internal error' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
