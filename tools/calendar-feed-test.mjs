// Test for the calendar feed (supabase/functions/calendar-feed): the calendar text it builds and what it refuses.
//
//   node tools/calendar-feed-test.mjs
//       Runs the function's code in this process. Nothing is deployed, nothing real is touched.
//   FEED_URL=https://<project>.supabase.co/functions/v1/calendar-feed node tools/calendar-feed-test.mjs
//       Harmless probes of a deployed copy: addresses that must answer "Not found", methods that must be refused.
// No link secrets are printed.
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LIVE = process.env.FEED_URL ? process.env.FEED_URL.replace(/\/+$/, '') : null;
const out = console.log.bind(console);
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; out('  ok   ' + name); }
  else { fail++; out('  FAIL ' + name + (detail !== '' ? '  -> ' + String(detail).slice(0, 300) : '')); }
}
const bytes = (s) => new TextEncoder().encode(s).length;
// Undo line folding, then split into logical lines.
const unfold = (ics) => ics.replace(/\r\n /g, '').split('\r\n').filter((l) => l !== '');
function events(ics) {
  const evs = []; let cur = null;
  for (const l of unfold(ics)) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { evs.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i)] = l.slice(i + 1); }
  }
  return evs;
}

if (!LIVE) {
  const src = process.env.FEED_SRC ? pathToFileURL(process.env.FEED_SRC).href : new URL('../supabase/functions/calendar-feed/index.ts', import.meta.url).href;

  // A stand-in for the database function calendar_feed_read (the real one is proven by a rolled-back run on the
  // database itself). It knows links only by the sha-256 of their secret, like the real table.
  const BASE = 'https://test-project.supabase.co';
  const SERVICE_KEY = 'test-service-key-' + randomBytes(12).toString('hex');
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
  const newSecret = () => 'pcf_' + randomBytes(32).toString('base64url');
  const feeds = new Map();          // hash -> what the database would answer
  const dbCalls = [];               // every call the function made to the database
  let dbMode = 'ok';                // ok | throw | 500 | notjson | nostatus
  const logLines = [];
  for (const k of ['log', 'error', 'warn', 'info']) { const orig = console[k]; console[k] = (...a) => { logLines.push(a.map(String).join(' ')); if (k === 'log') orig(...a); }; }
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body ? String(init.body) : '' };
    dbCalls.push(call);
    if (dbMode === 'throw') throw new Error('network down');
    if (dbMode === '500') return new Response('{"message":"boom"}', { status: 500 });
    if (dbMode === 'notjson') return new Response('<html>oops</html>', { status: 200 });
    if (dbMode === 'nostatus') return new Response('{"events":[]}', { status: 200 });
    if (call.url !== `${BASE}/rest/v1/rpc/calendar_feed_read` || call.method !== 'POST') return new Response('{"message":"no such function"}', { status: 404 });
    if (call.headers.apikey !== SERVICE_KEY || call.headers.Authorization !== `Bearer ${SERVICE_KEY}`) return new Response('{"message":"permission denied"}', { status: 401 });
    const { p_hash } = JSON.parse(call.body);
    const hit = /^[0-9a-f]{64}$/.test(p_hash || '') ? feeds.get(p_hash) : null;
    return new Response(JSON.stringify(hit || { status: 'not_found', reason: 'unknown' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const mod = await import(src);
  const { icsText, foldLine, localToUtcMs, icsUtc, buildCalendar, validTz, handler } = mod;

  out('\n== text escaping ==');
  check('comma, semicolon and backslash are escaped', icsText('a,b;c\\d') === 'a\\,b\\;c\\\\d');
  check('every kind of line break becomes \\n', icsText('1\r\n2\n3\r4' + String.fromCharCode(0x2028) + '5' + String.fromCharCode(0x2029) + '6\u00857') === '1\\n2\\n3\\n4\\n5\\n6\\n7');
  check('other control characters are dropped', icsText('a\u0000b\u0007c\u001bd\u007fe\tf') === 'abcdef');
  check('long text is cut', icsText('x'.repeat(900)).length === 500);
  check('null and undefined become empty', icsText(null) === '' && icsText(undefined) === '');
  const hostile = 'Hi\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Forged\nATTENDEE:mailto:x@example.com';
  check('no escaped text contains a real line break', !/[\r\n]/.test(icsText(hostile)));

  out('\n== line folding ==');
  const long = 'DESCRIPTION:' + 'é'.repeat(200);
  const folded = foldLine(long);
  check('every folded piece is at most 75 bytes', folded.split('\r\n').every((p) => bytes(p) <= 75), folded.split('\r\n').map(bytes).join(','));
  check('unfolding gives the line back', folded.replace(/\r\n /g, '') === long);
  check('a short line is untouched', foldLine('SUMMARY:ok') === 'SUMMARY:ok');
  const emoji = 'SUMMARY:' + '👷'.repeat(40);
  check('a character is never split in two', foldLine(emoji).replace(/\r\n /g, '') === emoji && !foldLine(emoji).includes('�'));

  out('\n== local time to UTC ==');
  const z = (d, t, tz, add) => { const ms = localToUtcMs(d, t, tz, add); return ms == null ? null : icsUtc(ms); };
  check('Toronto winter 08:00 is 13:00 UTC', z('2026-11-16', '08:00', 'America/Toronto') === '20261116T130000Z', z('2026-11-16', '08:00', 'America/Toronto'));
  check('Toronto summer 08:00 is 12:00 UTC', z('2026-07-01', '08:00:00', 'America/Toronto') === '20260701T120000Z');
  // Halifax rather than Vancouver: the western provinces stopped changing their clocks in 2026, so what
  // "Vancouver winter" means depends on how recent the runtime's time zone data is.
  check('Halifax winter 08:00 is 12:00 UTC', z('2026-12-01', '08:00', 'America/Halifax') === '20261201T120000Z');
  check('St. John\'s half-hour offset', z('2026-12-01', '08:00', 'America/St_Johns') === '20261201T113000Z');
  check('the evening before clocks go back', z('2026-10-31', '23:00', 'America/Toronto') === '20261101T030000Z');
  check('the morning after clocks go back', z('2026-11-01', '08:00', 'America/Toronto') === '20261101T130000Z');
  check('the morning after clocks go forward', z('2026-03-08', '08:00', 'America/Toronto') === '20260308T120000Z');
  check('next-day end', z('2026-11-16', '06:00', 'America/Toronto', 1) === '20261117T110000Z');
  check('broken date or time gives nothing', z('2026-13-01', '08:00', 'America/Toronto') === null && z('2026-11-16', '25:00', 'America/Toronto') === null && z('', '', 'America/Toronto') === null && z('x', 'y', 'America/Toronto') === null);
  check('an unknown or hostile time zone falls back to Toronto', validTz('Mars/Olympus') === 'America/Toronto' && validTz('America/Toronto\r\nX:1') === 'America/Toronto' && validTz(null) === 'America/Toronto' && validTz('America/Vancouver') === 'America/Vancouver');

  out('\n== a whole calendar ==');
  const ics = buildCalendar('Shifts, "Acme"; test', 'America/Toronto', [
    { uid: 'aaaaaaaa-1111-2222-3333-444444444444', date: '2026-11-16', start: '08:00:00', end: '12:00:00', summary: 'Installation', location: 'Head office', description: 'Bring the ladder' },
    { uid: 'bbbbbbbb-1111-2222-3333-444444444444', date: '2026-11-16', start: '22:00:00', end: '06:00:00', summary: 'Night' },
    { uid: 'cccccccc-1111-2222-3333-444444444444', date: '2026-11-17', start: '09:00:00', end: '10:00:00', summary: hostile, location: hostile, description: hostile },
    { uid: 'dddddddd-1111-2222-3333-444444444444', date: 'not-a-date', start: '09:00:00', end: '10:00:00', summary: 'broken row' },
    { uid: '\r\nUID:forged', date: '2026-11-18', start: '09:00:00', end: '10:00:00', summary: 'odd id' }
  ], Date.UTC(2026, 10, 13, 15, 0, 0));
  const lines = ics.split('\r\n');
  check('lines end with CRLF and the file ends with one', ics.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics) && !/\r[^\n]/.test(ics));
  check('no physical line is longer than 75 bytes', lines.every((l) => bytes(l) <= 75));
  let evs = events(ics);
  check('the broken row is left out, the others are there', evs.length === 4, evs.length);
  const count = (marker) => lines.filter((l) => l === marker).length;   // whole physical lines only: escaped text can mention a marker, it can never BE one
  check('exactly one calendar and matching event markers', count('BEGIN:VCALENDAR') === 1 && count('END:VCALENDAR') === 1 && count('BEGIN:VEVENT') === 4 && count('END:VEVENT') === 4);
  check('first shift at the right moment', evs[0].DTSTART === '20261116T130000Z' && evs[0].DTEND === '20261116T170000Z');
  check('overnight shift ends the next day', evs[1].DTSTART === '20261117T030000Z' && evs[1].DTEND === '20261117T110000Z');
  check('hostile text stays inside its own field', evs[2].SUMMARY.startsWith('Hi\\nEND:VEVENT\\nBEGIN:VEVENT') && !('ATTENDEE' in evs[2]) && Object.keys(evs[2]).sort().join() === 'DESCRIPTION,DTEND,DTSTAMP,DTSTART,LOCATION,SUMMARY,TRANSP,UID');
  check('a hostile id cannot add a line', evs[3].UID === 'UIDforged@punchclock.ca');
  check('the calendar name is escaped', unfold(ics).includes('X-WR-CALNAME:Shifts\\, "Acme"\\; test'));
  check('no attendee, organizer or alarm lines anywhere', !/^(ATTENDEE|ORGANIZER|BEGIN:VALARM|URL|ATTACH)/m.test(ics));

  out('\n== the function: addresses that are not a link never reach the database ==');
  const URL0 = BASE + '/functions/v1/calendar-feed';
  const call = (path, init) => handler(new Request(URL0 + path, init));
  const A43 = 'A'.repeat(43);
  let r, body;
  for (const p of ['', '/', '/demo.ics', '/other.ics', '/pcf_.ics', `/pcf_${A43}`, `/pcf_${A43}.ICS`, `/pcf_${A43}A.ics`, `/pcf_${A43.slice(1)}.ics`,
    `/PCF_${A43}.ics`, `/pcf_${A43.slice(1)}!.ics`, `/pcf_${A43.slice(1)}%2e.ics`, `/pcf_${A43}.ics/extra`, `/x.ics?token=pcf_${A43}`, `/pcf_${A43}.ics.txt`, '/%00.ics', '/..%2f..%2fsecure-db']) {
    dbCalls.length = 0;
    r = await call(p);
    check(`not found, no database call: "${p.replace(/A{40,}/g, '<A…>')}"`, r.status === 404 && (await r.text()) === 'Not found' && dbCalls.length === 0, r.status);
  }
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    dbCalls.length = 0;
    r = await call(`/pcf_${A43}.ics`, { method: m, body: m === 'OPTIONS' ? undefined : 'x'.repeat(5000) });
    check(`${m} is refused without a database call`, r.status === 405 && r.headers.get('allow') === 'GET, HEAD' && dbCalls.length === 0);
  }

  out('\n== the function: a working link ==');
  const s1 = newSecret(), s2 = newSecret();
  const hostileNote = 'Bring keys\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Forged shift\r\nATTENDEE:mailto:x@example.com';
  feeds.set(sha256hex(s1), { status: 'ok', company: 'Acme, Inc.; "QA"', tz: 'America/Halifax', lang: 'fr', events: [
    { id: '11111111-1111-4111-8111-111111111111', date: '2026-11-16', start: '08:00:00', end: '12:00:00', label: 'Installation', site: 'Siège social', note: 'Apporter l\'échelle' },
    { id: '22222222-2222-4222-8222-222222222222', date: '2026-11-16', start: '12:30:00', end: '15:30:00', label: null, site: null, note: null },
    { id: '33333333-3333-4333-8333-333333333333', date: '2026-11-17', start: '09:00:00', end: '10:00:00', label: hostileNote, site: hostileNote, note: hostileNote },
    { id: '44444444-4444-4444-8444-444444444444', date: 'garbage', start: '09:00:00', end: '10:00:00', label: 'broken row', site: null, note: null },
    null, 'text', 42, { id: 55, date: 20261116, start: null, end: {}, label: ['x'], site: 5, note: { a: 1 } }
  ] });
  feeds.set(sha256hex(s2), { status: 'ok', company: 'Other Co', tz: 'Mars/Olympus', lang: 'en', events: [
    { id: '99999999-9999-4999-8999-999999999999', date: '2026-11-18', start: '22:00:00', end: '06:00:00', label: '', site: 'Depot', note: 'only for employee two' }
  ] });

  dbCalls.length = 0; logLines.length = 0;
  r = await call(`/${s1}.ics`, { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
  body = await r.text();
  evs = events(body);
  check('200 with the calendar type', r.status === 200 && r.headers.get('content-type') === 'text/calendar; charset=utf-8');
  check('not cacheable, not indexable, no sniffing', /no-store/.test(r.headers.get('cache-control') || '') && /noindex/.test(r.headers.get('x-robots-tag') || '') && r.headers.get('x-content-type-options') === 'nosniff');
  check('exactly one database call, to the read function, as POST', dbCalls.length === 1 && dbCalls[0].url === `${BASE}/rest/v1/rpc/calendar_feed_read` && dbCalls[0].method === 'POST');
  const sent = dbCalls[0] ? JSON.parse(dbCalls[0].body) : {};
  check('the database gets the hash of the secret and the first forwarded address, nothing else', sent.p_hash === sha256hex(s1) && sent.p_ip === '203.0.113.7' && Object.keys(sent).sort().join() === 'p_hash,p_ip');
  check('the raw secret is not sent to the database', !JSON.stringify(dbCalls).includes(s1) && !JSON.stringify(dbCalls).includes(s1.slice(4)));
  check('the raw secret is not in the answer', !body.includes(s1.slice(4)) && ![...r.headers.values()].join(' ').includes(s1.slice(4)));
  check('the service key is not in the answer', !body.includes(SERVICE_KEY) && ![...r.headers.values()].join(' ').includes(SERVICE_KEY));
  check('nothing is logged for a normal read', logLines.length === 0, logLines.join(' | '));
  check('three good shifts; the broken and malformed rows are left out', evs.length === 3, evs.length);
  check('times are converted from the company time zone (Halifax)', evs[0] && evs[0].DTSTART === '20261116T120000Z' && evs[0].DTEND === '20261116T160000Z', evs[0] && evs[0].DTSTART);
  check('label, site and note are shown', evs[0] && evs[0].SUMMARY === 'Installation' && evs[0].LOCATION === 'Siège social' && evs[0].DESCRIPTION === 'Apporter l\'échelle');
  check('a shift with no label gets a French title for a French link, and no empty fields', evs[1] && evs[1].SUMMARY === 'Quart de travail' && !('LOCATION' in evs[1]) && !('DESCRIPTION' in evs[1]));
  check('hostile text stays inside its fields', evs[2] && Object.keys(evs[2]).sort().join() === 'DESCRIPTION,DTEND,DTSTAMP,DTSTART,LOCATION,SUMMARY,TRANSP,UID' && evs[2].DESCRIPTION.startsWith('Bring keys\\nEND:VEVENT'));
  const physical = body.split('\r\n');
  check('hostile text adds no event and no attendee', physical.filter((l) => l === 'BEGIN:VEVENT').length === 3 && !physical.some((l) => /^(ATTENDEE|ORGANIZER|SUMMARY:Forged)/.test(l)));
  check('the calendar is named after the company, escaped', unfold(body).includes('X-WR-CALNAME:Quarts de travail – Acme\\, Inc.\\; "QA"'));
  check('no email, PIN or person name fields exist in the calendar', !/^(ATTENDEE|ORGANIZER|CONTACT|X-.*EMAIL)/m.test(body));

  r = await call(`/${s2}.ics`);
  body = await r.text(); evs = events(body);
  check('a second link gets its own shifts only', r.status === 200 && evs.length === 1 && evs[0].DESCRIPTION === 'only for employee two' && !body.includes('Installation'));
  check('overnight shift ends the next day; an unknown time zone falls back to Toronto', evs[0].DTSTART === '20261119T030000Z' && evs[0].DTEND === '20261119T110000Z', evs[0].DTSTART + ' ' + evs[0].DTEND);
  check('English title and calendar name for an English link', evs[0].SUMMARY === 'Work shift' && unfold(body).includes('X-WR-CALNAME:Work shifts – Other Co'));
  check('no address header: counted as "unknown"', JSON.parse(dbCalls.at(-1).body).p_ip === 'unknown');
  await call(`/${s2}.ics`, { headers: { 'x-forwarded-for': '"><script>alert(1)</script>' } });
  check('a hostile address header is not passed on', JSON.parse(dbCalls.at(-1).body).p_ip === 'unknown');
  await call(`/${s2}.ics`, { headers: { 'x-forwarded-for': '2001:db8::1' } });
  check('an IPv6 address is passed on', JSON.parse(dbCalls.at(-1).body).p_ip === '2001:db8::1');
  r = await call(`/${s2}.ics`, { method: 'HEAD' });
  check('HEAD: 200 with no body', r.status === 200 && (await r.text()) === '');
  r = await call(`/${s2}.ics?employee_id=11111111-1111-4111-8111-111111111111&company=Acme`);
  body = await r.text();
  check('query parameters cannot choose another person', r.status === 200 && events(body).length === 1 && !body.includes('Installation'));

  out('\n== the function: links that do not work all get the same answer ==');
  const snap = async (resp) => JSON.stringify([resp.status, await resp.text(), [...resp.headers.entries()].sort()]);
  const unknown = await snap(await call(`/${newSecret()}.ics`));
  check('unknown link: 404 "Not found"', JSON.parse(unknown)[0] === 404 && JSON.parse(unknown)[1] === 'Not found');
  for (const reason of ['unknown', 'inactive', 'no_portal', 'plan', 'scheduling', 'shape']) {
    const s = newSecret();
    feeds.set(sha256hex(s), { status: 'not_found', reason, events: [{ id: 'x', date: '2026-11-16', start: '08:00', end: '09:00', label: 'must not leak' }] });
    check(`"${reason}": identical to an unknown link, no calendar`, (await snap(await call(`/${s}.ics`))) === unknown);
  }
  for (const odd of ['OK', 'Ok', '', 'yes', 'true']) {
    const s = newSecret();
    feeds.set(sha256hex(s), { status: odd, events: [{ id: 'x', date: '2026-11-16', start: '08:00', end: '09:00', label: 'must not leak' }] });
    check(`an unexpected database status "${odd}" is not accepted`, (await snap(await call(`/${s}.ics`))) === unknown);
  }
  const sT = newSecret();
  feeds.set(sha256hex(sT), { status: 'throttled', reason: 'rate', events: [{ id: 'x', date: '2026-11-16', start: '08:00', end: '09:00', label: 'must not leak' }] });
  r = await call(`/${sT}.ics`); body = await r.text();
  check('over the hourly limit: 429, come back in an hour, no calendar', r.status === 429 && r.headers.get('retry-after') === '3600' && !body.includes('VCALENDAR') && !body.includes('must not leak'));
  const sE = newSecret();
  feeds.set(sha256hex(sE), { status: 'ok', company: null, tz: null, lang: null, events: 'not a list' });
  r = await call(`/${sE}.ics`); body = await r.text();
  check('a link with no shifts gives a valid empty calendar', r.status === 200 && events(body).length === 0 && body.startsWith('BEGIN:VCALENDAR\r\n') && body.endsWith('END:VCALENDAR\r\n') && unfold(body).includes('X-WR-CALNAME:Work shifts – PunchClock Crew'));

  out('\n== the function: when the database does not answer ==');
  for (const mode of ['throw', '500', 'notjson', 'nostatus']) {
    dbMode = mode; logLines.length = 0;
    r = await call(`/${s1}.ics`); body = await r.text();
    check(`database ${mode}: 503 with a retry time, never "Not found", never a calendar`, r.status === 503 && r.headers.get('retry-after') === '900' && !body.includes('VCALENDAR'));
    check(`database ${mode}: the log holds no secret and no key`, !logLines.join(' ').includes(s1.slice(4)) && !logLines.join(' ').includes(SERVICE_KEY));
  }
  dbMode = 'ok';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const noKey = await import(src + '?nokey=1');
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  dbCalls.length = 0;
  r = await noKey.handler(new Request(`${URL0}/${s1}.ics`));
  check('no service key configured: 503 and no database call', r.status === 503 && dbCalls.length === 0);
} else {
  out(`\n== live probes of ${LIVE.replace(/^https:\/\/[^.]+/, 'https://<project>')} (refusals only) ==`);
  // Only addresses that are NOT shaped like a link, so nothing is counted or written anywhere.
  for (const p of ['', '/', '/demo.ics', '/other.ics', '/pcf_.ics', '/pcf_' + 'A'.repeat(42) + '.ics', '/pcf_' + 'A'.repeat(43), '/..%2fsecure-db']) {
    const r = await fetch(LIVE + p);
    const t = await r.text();
    check(`not found: "${p.replace(/A{40,}/, '<A…>')}"`, r.status === 404 && t === 'Not found', r.status + ' ' + t.slice(0, 80));
  }
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(LIVE + '/other.ics', { method: m, body: 'x'.repeat(2000) });
    await r.text();
    check(`${m} is refused`, r.status === 405, r.status);
  }
  if (process.env.FEED_PROBE_UNKNOWN === '1') {
    // One well-formed secret that matches nothing (the all-A one, never a real link): must be "Not found".
    // Leaves one short-lived counter row for this computer's address.
    const r = await fetch(LIVE + '/pcf_' + 'A'.repeat(43) + '.ics');
    const t = await r.text();
    check('a well-formed unknown link: not found', r.status === 404 && t === 'Not found', r.status + ' ' + t.slice(0, 80));
  }
}

out(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
