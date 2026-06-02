// storage-upload — Supabase Edge Function
// Receives a base64 image from the client, validates it, and uploads to Storage
// using the service-role key. Returns the public URL. Lets us lock the buckets
// to service-write-only (no anon writes).
// JWT verification: OFF (validated by allowed-bucket + type/size checks below)

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

function err(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  let bucket: string, fileName: string, contentType: string, dataB64: string;
  try {
    const p = await req.json();
    bucket = p.bucket; fileName = p.fileName; contentType = p.contentType; dataB64 = p.data;
  } catch { return err('Invalid request body'); }

  if (!ALLOWED_BUCKETS.has(bucket)) return err('Invalid bucket');
  if (!contentType || !ALLOWED_TYPES.has(contentType.toLowerCase())) return err('Invalid file type');
  if (!fileName || typeof fileName !== 'string') return err('Missing file name');
  // sanitize filename: allow only safe chars, no path traversal
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return err('Invalid file name');
  if (!dataB64 || typeof dataB64 !== 'string') return err('Missing file data');

  // Decode base64 → bytes, enforce size
  let bytes: Uint8Array;
  try {
    const bin = atob(dataB64);
    if (bin.length > MAX_BYTES) return err('File too large (max 2MB)', 413);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return err('Invalid file encoding'); }

  // Upload with service key
  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${fileName}`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    return err('Upload failed: ' + t, 500);
  }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${fileName}`;
  return new Response(JSON.stringify({ ok: true, url: publicUrl }), {
    status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
