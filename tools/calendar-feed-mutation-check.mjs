// Do the calendar feed's tests really bite? This breaks one rule at a time in a COPY of the function (the real file is
// never touched) and runs tools/calendar-feed-test.mjs against the broken copy. Every broken rule must make the suite
// fail. Run it after changing supabase/functions/calendar-feed: "pattern not found" means a rule's code changed and
// its entry below needs updating; "MISSED" means a rule has no test that notices when it is gone.
//   node tools/calendar-feed-mutation-check.mjs
// The database side (who a link belongs to, plan and Scheduling checks, limits) is proven separately by a rolled-back
// run on the database: see the header of supabase/migrations/20261113_calendar_feeds.sql.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calfeed-mutation-'));
const file = path.join(repo, 'supabase/functions/calendar-feed/index.ts');
const M = [
  ['only link-shaped addresses reach the database', "const SECRET_FILE_RE = /^(pcf_[A-Za-z0-9_-]{43})\\.ics$/;", "const SECRET_FILE_RE = /^(.*)\\.ics$/;"],
  ['only GET and HEAD', "if (method !== 'GET' && method !== 'HEAD') return plain(405,", "if (false) return plain(405,"],
  ['the secret is hashed before it leaves the function', "await readFeed(await sha256hex(m[1]), callerIp(req))", "await readFeed(m[1], callerIp(req))"],
  ['anything but "ok" is not found', "if (feed.status !== 'ok') return notFound();", "if (false) return notFound();"],
  ['over the limit is refused with 429', "if (feed.status === 'throttled') return plain(429, 'Too many requests', { 'Retry-After': '3600' });", "if (feed.status === 'throttled') feed.status = 'ok';"],
  ['a database outage is not "not found"', "if (!feed) return plain(503, 'Temporarily unavailable', { 'Retry-After': '900' });", "if (!feed) return notFound();"],
  ['no service key: no database call', "if (!BASE || !SERVICE_KEY) return null;", ""],
  ['a database answer without a status is refused', "return j && typeof j === 'object' && typeof j.status === 'string' ? j : null;", "return j && typeof j === 'object' ? { status: 'ok', ...j } : null;"],
  ['the address header is validated', "return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : 'unknown';", "return first || 'unknown';"],
  ['line breaks in text are neutralised', ".replace(LINE_BREAKS, '\\\\n')", ""],
  ['control characters are dropped', ".replace(/[\\u0000-\\u001f\\u007f]/g, '')", ""],
  ['semicolons are escaped', ".replace(/;/g, '\\\\;')", ""],
  ['commas are escaped', ".replace(/,/g, '\\\\,')", ""],
  ['backslashes are escaped', ".replace(/\\\\/g, '\\\\\\\\')", ""],
  ['the title is escaped', "`SUMMARY:${icsText(ev.summary, 120)}`", "`SUMMARY:${ev.summary}`"],
  ['the location is escaped', "`LOCATION:${icsText(ev.location, 120)}`", "`LOCATION:${ev.location}`"],
  ['the note is escaped', "`DESCRIPTION:${icsText(ev.description)}`", "`DESCRIPTION:${ev.description}`"],
  ['the calendar name is escaped', "`X-WR-CALNAME:${icsText(name, 80)}`", "`X-WR-CALNAME:${name}`"],
  ['a hostile shift id cannot add a line', ".replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)", ""],
  ['long lines are folded', "if (curBytes + n > limit) {", "if (false) {"],
  // two guards each stop a row with a broken date or time; either alone is enough, so both are removed together
  ['rows with a broken date or time are left out', [
    ["if (startMs == null || endMs == null) continue;                 // a row with a broken date or time is left out", ""],
    ["if (endMs == null || endMs <= startMs) continue;", ""]]],
  ['malformed rows are skipped', "if (!r || typeof r !== 'object') continue;", ""],
  ['an overnight shift ends the next day', "if (endMs <= startMs) endMs = localToUtcMs(ev.date, ev.end, zone, 1);", ""],
  ['answers are not cacheable', "'Cache-Control': 'no-store, private',", "'Cache-Control': 'public, max-age=3600',"],
  ['answers are not indexable', "'X-Robots-Tag': 'noindex, nofollow',", ""]
];
let caught = 0; const missed = [];
for (const [name, from, to] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const pairs = Array.isArray(from) ? from : [[from, to]];
  if (!pairs.every(([f]) => src.includes(f))) { console.log('  ??      pattern not found: ' + name); missed.push(name + ' (pattern not found)'); continue; }
  for (const [f, t] of pairs) src = src.replace(f, () => t);
  const out = path.join(dir, 'feed.ts');
  fs.writeFileSync(out, src);
  const r = spawnSync(process.execPath, [path.join(repo, 'tools/calendar-feed-test.mjs')], { env: { ...process.env, FEED_SRC: out, FEED_URL: '' }, encoding: 'utf8', timeout: 60000 });
  const fails = (r.stdout.match(/^  FAIL .*$/gm) || []);
  if (r.status !== 0) { caught++; console.log(`  caught  ${name}  (${fails.length || 'crash'}: ${(fails[0] || (r.stderr || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, 100)})`); }
  else { missed.push(name); console.log('  MISSED  ' + name); }
}
console.log(`\n${caught} of ${M.length} broken rules were caught` + (missed.length ? `\nNOT caught: ${missed.join('; ')}` : ''));
process.exit(missed.length ? 1 : 0);
