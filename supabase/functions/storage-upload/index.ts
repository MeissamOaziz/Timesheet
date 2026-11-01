// storage-upload — Supabase Edge Function
// Receives a base64 image from the signed-in admin's browser, validates it, and uploads it to the PRIVATE
// avatars / logos bucket with the service-role key. Returns the stored address (public-style, not directly
// openable: pages receive short-lived signed urls from secure-db) and a short-lived signed url for an
// immediate preview.
// JWT verification: ON at the gateway (the public key passes it), real authentication is the admin session
// token checked below against admin_sessions, like secure-db.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  'https://www.punchclock.ca',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const ALLOWED_BUCKETS = new Set(['logos', 'avatars']);
const ALLOWED_TYPES = new Set(['image/png','image/jpeg','image/jpg','image/webp','image/gif']);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOADS_PER_ADMIN_HOUR = 60;
const PREVIEW_SECS = 4 * 3600;

function err(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
async function rest(path: string): Promise<any[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

// Same session lookup as secure-db: token -> admin_sessions -> active admin.
async function resolveCaller(token: string): Promise<{ adminId: string; primaryAdminId: string; role: string } | null> {
  const s = (await rest(`admin_sessions?token=eq.${token}&select=admin_id,expires_at&limit=1`))?.[0];
  if (!s || new Date(s.expires_at) <= new Date()) return null;
  const a = (await rest(`admins?id=eq.${s.admin_id}&select=id,parent_admin_id,role,status&limit=1`))?.[0];
  if (!a || !(a.status === 'active' || a.status === 'pending_invite')) return null;
  return { adminId: a.id, primaryAdminId: a.parent_admin_id || a.id, role: a.role };
}

// The image must really be what its content type says (the bucket only trusts the header).
function sniffOk(bytes: Uint8Array, type: string): boolean {
  const t = type.toLowerCase();
  const at = (o: number, s: string) => s.split('').every((c, i) => bytes[o + i] === c.charCodeAt(0));
  if (t === 'image/png') return bytes[0] === 0x89 && at(1, 'PNG');
  if (t === 'image/jpeg' || t === 'image/jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (t === 'image/gif') return at(0, 'GIF8');
  if (t === 'image/webp') return at(0, 'RIFF') && at(8, 'WEBP');
  return false;
}

async function audit(adminId: string, event: string, table: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_id: adminId, event, table_name: table }),
    });
  } catch { /* auditing never breaks an upload */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let bucket: string, fileName: string, contentType: string, dataB64: string,
      sessionToken: unknown, companyId: unknown, employeeId: unknown;
  try {
    const p = await req.json();
    bucket = p.bucket; fileName = p.fileName; contentType = p.contentType; dataB64 = p.data;
    sessionToken = p.sessionToken; companyId = p.companyId; employeeId = p.employeeId;
  } catch { return err('Invalid request body'); }

  // ── Who is uploading, and for what ────────────────────────────────────────────────────────────
  if (typeof sessionToken !== 'string' || !TOKEN_RE.test(sessionToken)) return err('Unauthorized', 401);
  const caller = await resolveCaller(sessionToken);
  if (!caller) return err('Unauthorized', 401);
  if (!ALLOWED_BUCKETS.has(bucket)) return err('Invalid bucket');
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) return err('Missing company', 400);
  // Company logos are an owner/admin setting (managers cannot edit the company); photos belong to employees,
  // which managers may maintain.
  if (bucket === 'logos' && caller.role === 'manager') return err('Forbidden', 403);
  const isSuper = caller.role === 'super_admin';
  const co = (await rest(`companies?id=eq.${companyId}&select=id,admin_id&limit=1`))?.[0];
  if (!co || (!isSuper && co.admin_id !== caller.primaryAdminId)) return err('Forbidden', 403);
  if (employeeId !== undefined && employeeId !== null) {
    if (bucket !== 'avatars' || typeof employeeId !== 'string' || !UUID_RE.test(employeeId)) return err('Invalid employee', 400);
    const emp = (await rest(`employees?id=eq.${employeeId}&company_id=eq.${companyId}&select=id&limit=1`))?.[0];
    if (!emp) return err('Forbidden', 403);
  }

  // ── The file ───────────────────────────────────────────────────────────────────────────────────
  if (!contentType || typeof contentType !== 'string' || !ALLOWED_TYPES.has(contentType.toLowerCase())) return err('Invalid file type');
  if (!fileName || typeof fileName !== 'string') return err('Missing file name');
  // sanitize filename: allow only safe chars, no path traversal
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.length > 120) return err('Invalid file name');
  if (!dataB64 || typeof dataB64 !== 'string') return err('Missing file data');

  // Decode base64 → bytes, enforce size
  let bytes: Uint8Array;
  try {
    const bin = atob(dataB64);
    if (bin.length > MAX_BYTES) return err('File too large (max 2MB)', 413);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return err('Invalid file encoding'); }
  if (!sniffOk(bytes, contentType)) return err('Invalid file type');

  // A signed-in account cannot be used to fill the buckets.
  try {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/audit_log?admin_id=eq.${caller.adminId}&event=eq.image_upload&at=gte.${encodeURIComponent(since)}&select=id`,
      { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
    const total = parseInt((r.headers.get('content-range') || '').split('/')[1] || '0', 10);
    if (total >= UPLOADS_PER_ADMIN_HOUR) return err('Too many uploads. Please try again later.', 429);
  } catch { /* count unavailable: do not block a legitimate upload */ }

  // Object name: <company id>/<client name>-<12 random hex>.<ext>, never an overwrite. The folder ties the
  // object to the company that owns it (secure-db only accepts a photo_url / logo_url inside a folder of the
  // caller's own companies); the random part keeps the names unguessable. Clients only ever use the url
  // returned below, never a name they built themselves. Cache-control: private bucket, signed urls change
  // every few hours, so a week-long cache is still fine for the object itself.
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const dot = fileName.lastIndexOf('.');
  const leaf = dot > 0 ? `${fileName.slice(0, dot)}-${rnd}${fileName.slice(dot)}` : `${fileName}-${rnd}`;
  const objName = `${companyId}/${leaf}`;
  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objName}`, {
    method: 'POST',
    headers: {
      ...H,
      'Content-Type': contentType,
      'x-upsert': 'false',
      'cache-control': 'max-age=604800',
    },
    body: bytes,
  });
  if (!upRes.ok) return err('Upload failed', 500);
  await audit(caller.adminId, 'image_upload', `${bucket}:${companyId}`);

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objName}`;
  let signedUrl: string | null = null;
  try {
    const sr = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${objName}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: PREVIEW_SECS }),
    });
    const sj = sr.ok ? await sr.json() : null;
    if (sj && typeof sj.signedURL === 'string') signedUrl = `${SUPABASE_URL}/storage/v1${sj.signedURL.startsWith('/') ? '' : '/'}${sj.signedURL}`;
  } catch { /* preview only */ }
  return new Response(JSON.stringify({ ok: true, url: publicUrl, signedUrl }), {
    status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
