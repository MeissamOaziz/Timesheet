// calendar-feed — Supabase Edge Function. JWT verification: OFF (calendar apps cannot send a key; the checks below are the gate).
//
// A read-only calendar (iCalendar / .ics) that Google Calendar, Apple Calendar and Outlook re-read on their own timetable.
//
// Each employee can create one private link in the employee portal ("Add my shifts to my calendar"). The link ends in
// a secret (pcf_ + 43 characters, 256 random bits). This function hashes the secret and asks the database function
// calendar_feed_read for that employee's shifts. It has no other way to choose a person: nothing in the address, the
// headers or the query can name an employee, a company or a site.
//
// Rules
//   - GET (and HEAD) only. Anything else is refused after its upload has been read (an unread upload can make the
//     gateway time out instead of delivering the refusal).
//   - One answer for everything that is not a working link: 404 "Not found" (unknown, replaced, turned off, person
//     or portal account gone, plan or Scheduling lapsed). An address that is not shaped like a link never reaches
//     the database.
//   - Checked by the database on every read: employee active, portal account active, paid portal, Scheduling add-on
//     or trial. 60 reads an hour per link, counted before the shifts are fetched (then 429).
//   - The secret is never stored (only its sha-256), never logged and never sent back.
//   - Only the employee's own shifts are returned: time, work label, site name, note. No names, emails or ids of people.
//   - Text that people typed (labels, site names, notes) is escaped so it can never add or forge calendar lines.
//   - If the database does not answer: 503, never "Not found" (a calendar app must not conclude the link is dead).

const g = globalThis as any;
const env = (k: string): string => (g.Deno ? g.Deno.env.get(k) : g.process?.env?.[k]) || '';

const BASE = env('SUPABASE_URL').replace(/\/+$/, '');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');

const DRAIN_MAX = 1024 * 1024;
const DEFAULT_TZ = 'America/Toronto';
const MAX_TEXT = 500;

// ── iCalendar building blocks ────────────────────────────────────────────────────────────────
export interface FeedEvent {
  uid: string;          // stable id of the shift
  date: string;         // YYYY-MM-DD, local to `tz`
  start: string;        // HH:MM or HH:MM:SS, local
  end: string;          // same; an end at or before the start means "ends the next day"
  summary: string;
  location?: string;
  description?: string;
}

// Escapes free text for a calendar line: backslash, semicolon, comma; every kind of line break becomes the two
// characters \n; other control characters are dropped. The result can never contain a real line break.
// Line and paragraph separators (U+2028, U+2029) are built from their numbers so no editor can turn them into real breaks.
const LINE_BREAKS = new RegExp('\\r\\n|[\\n\\r\\u000b\\u000c\\u0085' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
export function icsText(value: unknown, max = MAX_TEXT): string {
  let s = String(value ?? '');
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s
    .replace(/\\/g, '\\\\')
    .replace(LINE_BREAKS, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// Calendar lines may be at most 75 bytes; longer ones continue on the next line after a single space.
// Splits between characters, never inside one.
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '', curBytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) { parts.push(cur); cur = ''; curBytes = 0; limit = 74; }
    cur += ch; curBytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export function validTz(tz: unknown): string {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}

// Minutes that `tz` is ahead of UTC at the instant `utcMs`.
function tzOffsetMin(utcMs: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 60000);
}

// A wall-clock date and time in `tz` -> the UTC instant in milliseconds (null when the input is not a real date/time).
// Events are written in UTC so no time-zone table has to be shipped and every calendar app shows the same moment.
export function localToUtcMs(date: string, time: string, tz: string, addDays = 0): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time || '');
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, da + addDays, h, mi, 0);
  let utc = wall - tzOffsetMin(wall, tz) * 60000;
  utc = wall - tzOffsetMin(utc, tz) * 60000;          // second pass settles the hours around a clock change
  return utc;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function icsUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function buildCalendar(name: string, tz: string, events: FeedEvent[], nowMs = Date.now()): string {
  const zone = validTz(tz);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PunchClock Crew//Shifts//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name, 80)}`,
    `X-WR-TIMEZONE:${zone}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];
  const stamp = icsUtc(nowMs);
  for (const ev of events) {
    const startMs = localToUtcMs(ev.date, ev.start, zone);
    let endMs = localToUtcMs(ev.date, ev.end, zone);
    if (startMs == null || endMs == null) continue;                 // a row with a broken date or time is left out
    if (endMs <= startMs) endMs = localToUtcMs(ev.date, ev.end, zone, 1);
    if (endMs == null || endMs <= startMs) continue;
    const uid = String(ev.uid || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (!uid) continue;
    lines.push('BEGIN:VEVENT', `UID:${uid}@punchclock.ca`, `DTSTAMP:${stamp}`, `DTSTART:${icsUtc(startMs)}`, `DTEND:${icsUtc(endMs)}`,
      `SUMMARY:${icsText(ev.summary, 120)}`);
    if (ev.location) lines.push(`LOCATION:${icsText(ev.location, 120)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsText(ev.description)}`);
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────
const COMMON: Record<string, string> = {
  'Cache-Control': 'no-store, private',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
const notFound = () => plain(404, 'Not found');
const calendar = (body: string, head: boolean) =>
  new Response(head ? null : body, { status: 200, headers: { ...COMMON, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="shifts.ics"' } });

async function drain(req: Request): Promise<void> {
  try {
    if (!req.body || req.bodyUsed) return;
    const reader = req.body.getReader();
    for (let size = 0;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > DRAIN_MAX) { await reader.cancel().catch(() => {}); return; }
    }
  } catch { /* the answer goes out anyway */ }
}

// ── the link's secret -> that employee's shifts ──────────────────────────────────────────────
const SECRET_FILE_RE = /^(pcf_[A-Za-z0-9_-]{43})\.ics$/;     // 256 random bits; anything else never reaches the database

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The caller's address, only to count wrong links per address. Never trusted for anything else.
function callerIp(req: Request): string {
  const first = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : 'unknown';
}

// One database call: it counts the read, checks the employee, the portal account and the plan, and returns only that
// employee's own shifts. null = the database did not answer (never treated as "this link is dead").
async function readFeed(hash: string, ip: string): Promise<any | null> {
  if (!BASE || !SERVICE_KEY) return null;
  try {
    const r = await fetch(`${BASE}/rest/v1/rpc/calendar_feed_read`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_hash: hash, p_ip: ip })
    });
    if (!r.ok) { await r.text().catch(() => ''); console.error(`calendar-feed: database answered ${r.status}`); return null; }
    const j = await r.json().catch(() => null);
    return j && typeof j === 'object' && typeof j.status === 'string' ? j : null;
  } catch {
    console.error('calendar-feed: database not reachable');
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function toEvents(rows: unknown, fr: boolean): FeedEvent[] {
  if (!Array.isArray(rows)) return [];
  const out: FeedEvent[] = [];
  for (const r of rows.slice(0, 500)) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    out.push({
      uid: str(row.id),
      date: str(row.date),
      start: str(row.start),
      end: str(row.end),
      summary: str(row.label).trim() || (fr ? 'Quart de travail' : 'Work shift'),
      location: str(row.site).trim() || undefined,
      description: str(row.note).trim() || undefined
    });
  }
  return out;
}

export async function handler(req: Request): Promise<Response> {
  await drain(req);
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let last = '';
  try { last = new URL(req.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return notFound(); }
  const m = SECRET_FILE_RE.exec(last);
  if (!m) return notFound();

  const feed = await readFeed(await sha256hex(m[1]), callerIp(req));
  if (!feed) return plain(503, 'Temporarily unavailable', { 'Retry-After': '900' });
  if (feed.status === 'throttled') return plain(429, 'Too many requests', { 'Retry-After': '3600' });
  if (feed.status !== 'ok') return notFound();        // unknown, replaced, turned off, person gone, plan lapsed: one answer

  const fr = feed.lang === 'fr';
  const company = str(feed.company).trim() || 'PunchClock Crew';
  const name = fr ? `Quarts de travail – ${company}` : `Work shifts – ${company}`;
  return calendar(buildCalendar(name, str(feed.tz), toEvents(feed.events, fr)), method === 'HEAD');
}

if (g.Deno) g.Deno.serve(handler);
