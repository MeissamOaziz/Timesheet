// "Add my shifts to my calendar" card on the employee portal (employee.html). The network is stubbed, so this checks
// the page's behaviour only: what it shows in each state, that the link is built only from a well-formed secret, that
// the secret is never written to storage or into markup, and that it is forgotten on sign-out. The server side is
// covered by tools/calendar-feed-test.mjs and the rolled-back database run described in the migration.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = await new Promise((r) => { const s = createServer(async (q, res) => { try {
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = normalize(join(ROOT, rel));
  if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(f).pipe(res); } catch { res.writeHead(404).end(); } }); s.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x ? '  -> ' + String(x).slice(0, 300) : ''}`); };

const SECRET = 'pcf_' + 'aB3-_'.repeat(8) + 'xYz';            // 43 characters after the prefix, test value only
const SECRET2 = 'pcf_' + 'Zz9-_'.repeat(8) + 'qRs';
const FEED = 'uziwymrwaeojhqaagqcm.supabase.co/functions/v1/calendar-feed/';
const browser = await chromium.launch();

// Opens the portal as a signed-in employee. `state` is what the stubbed server holds and may be changed by the test.
async function open(state, { lang = 'en', width = 390 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const calls = []; const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); state.acceptDialogs === false ? await d.dismiss() : await d.accept(); });
  await page.route('**/rest/v1/rpc/*', async (route) => {
    const fn = route.request().url().split('/rpc/')[1];
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push({ fn, body });
    let out = [], status = 200;
    if (fn === 'portal_calendar_feed_status') {
      if (state.statusFails) status = 404;
      else if (state.noSession) out = [];
      else out = [{ allowed: state.allowed !== false, active: !!state.active, created_at: state.active ? '2026-11-14T15:00:00Z' : null, last_read_at: state.lastRead || null }];
    } else if (fn === 'portal_calendar_feed_create') {
      if (state.createFails) status = 500;
      else if (state.createReply) out = [state.createReply];
      else { state.active = true; out = [{ status: 'ok', token: state.nextToken || SECRET }]; }
    } else if (fn === 'portal_calendar_feed_revoke') { state.active = false; out = true; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.goto(BASE + '/employee.html', { waitUntil: 'networkidle' });
  await page.evaluate((l) => {
    _empLang = l;
    _session = { token: 'tok', siteId: '33333333-3333-3333-3333-333333333333', employeeId: 'e1' };
    _employee = {};
    document.getElementById('screenApp').style.display = 'block';
  }, lang);
  await page.evaluate(() => renderSchedule());
  await page.waitForTimeout(250);
  return { ctx, page, calls, errs, dialogs };
}
const cardText = (page) => page.evaluate(() => document.getElementById('calFeedCard').innerText);
const cardHtml = (page) => page.evaluate(() => document.getElementById('calFeedCard').innerHTML);
const feedCalls = (c, fn) => c.filter((x) => x.fn === fn);
const settle = (page) => page.waitForTimeout(250);

console.log('\n── no link yet ──');
{
  const state = {};
  const { ctx, page, calls, errs, dialogs } = await open(state);
  ok('the card offers to get a link', /Add my shifts to my calendar/.test(await cardText(page)) && await page.locator('#calFeedGet').isVisible());
  ok('the status is asked with the session token only', feedCalls(calls, 'portal_calendar_feed_status').every((c) => Object.keys(c.body).join() === 'p_session' && c.body.p_session === 'tok'));
  await page.click('#calFeedGet'); await settle(page);
  const create = feedCalls(calls, 'portal_calendar_feed_create');
  ok('one create call, with the session token and the language, and no employee id', create.length === 1 && Object.keys(create[0].body).sort().join() === 'p_lang,p_session' && create[0].body.p_lang === 'en');
  ok('no confirmation is asked for a first link', dialogs.length === 0);
  ok('the link is shown, built from the secret', (await page.inputValue('#calFeedLink')) === `https://${FEED}${SECRET}.ics`);
  ok('the Apple button opens the same link as a calendar subscription', (await page.getAttribute('#calFeedApple', 'href')) === `webcal://${FEED}${SECRET}.ics`);
  ok('the Google button hands that link to Google Calendar', (await page.getAttribute('#calFeedGoogle', 'href')) === 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(`webcal://${FEED}${SECRET}.ics`));
  ok('the Google button opens a new tab without passing the page along', (await page.getAttribute('#calFeedGoogle', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('#calFeedGoogle', 'rel')) && /noreferrer/.test(await page.getAttribute('#calFeedGoogle', 'rel')));
  ok('it says the link is private and that Google refreshes slowly', /Keep this link to yourself/.test(await cardText(page)) && /once or twice a day/.test(await cardText(page)));
  const stored = await page.evaluate((sec) => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie, location.href]).includes(sec.slice(4)), SECRET);
  ok('the secret is not in localStorage, sessionStorage, cookies or the address bar', !stored);
  await page.click('#calFeedCopy'); await settle(page);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  ok('Copy puts the link on the clipboard', clip === null ? true : clip === `https://${FEED}${SECRET}.ics`, clip);
  // switching language redraws the card and keeps the link for this visit
  await page.evaluate(() => setEmpLang('fr')); await settle(page);
  ok('French: same link, French words', (await page.inputValue('#calFeedLink')) === `https://${FEED}${SECRET}.ics` && /Ajouter à Google Agenda/.test(await cardText(page)) && /Gardez ce lien pour vous/.test(await cardText(page)));
  ok('no key name shows instead of a translation', !/\bcal[A-Z][A-Za-z]+\b/.test(await cardText(page)), (await cardText(page)).match(/\bcal[A-Z][A-Za-z]+\b/));
  await page.evaluate(() => setEmpLang('en')); await settle(page);
  // turn off
  state.acceptDialogs = false;
  await page.click('#calFeedOff'); await settle(page);
  ok('Turn off asks first; answering no changes nothing', dialogs.length === 1 && feedCalls(calls, 'portal_calendar_feed_revoke').length === 0 && await page.locator('#calFeedLink').isVisible());
  state.acceptDialogs = true;
  await page.click('#calFeedOff'); await settle(page);
  ok('Turn off: the server is told, the link is gone from the page', feedCalls(calls, 'portal_calendar_feed_revoke').length === 1 && !(await cardHtml(page)).includes(SECRET.slice(4)) && await page.locator('#calFeedGet').isVisible());
  ok('the page forgot the secret', await page.evaluate(() => _calFeedToken === null));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── coming back later: the link exists but is not shown again ──');
{
  const state = { active: true, lastRead: '2026-11-14T18:30:00Z', nextToken: SECRET2 };
  const { ctx, page, calls, errs, dialogs } = await open(state);
  const text = await cardText(page);
  ok('it says the link is on, when it was made and last read', /Your calendar link is on/.test(text) && /Created/.test(text) && /Last read by your calendar/.test(text) && !/not yet/.test(text));
  ok('no link, no Google or Apple button', (await page.locator('#calFeedLink').count()) === 0 && (await page.locator('#calFeedGoogle').count()) === 0 && !(await cardHtml(page)).includes('pcf_'));
  state.acceptDialogs = false;
  await page.click('#calFeedNew'); await settle(page);
  ok('a new link asks first; answering no sends nothing', dialogs.length === 1 && /stops working right away/.test(dialogs[0]) && feedCalls(calls, 'portal_calendar_feed_create').length === 0);
  state.acceptDialogs = true;
  await page.click('#calFeedNew'); await settle(page);
  ok('answering yes makes the new link and shows it', feedCalls(calls, 'portal_calendar_feed_create').length === 1 && (await page.inputValue('#calFeedLink')) === `https://${FEED}${SECRET2}.ics`);
  await page.evaluate(() => doEmpLogout()); await settle(page);
  ok('signing out forgets the secret', await page.evaluate(() => _calFeedToken === null));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── never read yet, French ──');
{
  const { ctx, page, errs } = await open({ active: true }, { lang: 'fr' });
  const text = await cardText(page);
  ok('French words and "pas encore"', /Votre lien de calendrier est actif/.test(text) && /pas encore/.test(text) && /Obtenir un nouveau lien/.test(text));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── company without Scheduling ──');
{
  const { ctx, page, errs } = await open({ allowed: false });
  ok('a locked note, no button', /part of Scheduling/.test(await cardText(page)) && (await page.locator('#calFeedCard button').count()) === 0 && (await page.locator('#calFeedCard a').count()) === 0);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── the server refuses ──');
for (const [name, reply, expect] of [
  ['too many new links', { status: 'too_many', token: null }, /Too many new links/],
  ['locked', { status: 'locked', token: null }, /part of Scheduling/],
  ['an unknown status', { status: 'weird', token: SECRET }, /./]
]) {
  const state = { createReply: reply };
  const { ctx, page, errs } = await open(state);
  await page.click('#calFeedGet'); await settle(page);
  const toast = await page.evaluate(() => document.getElementById('empToast').textContent);
  ok(`${name}: a message, no link`, expect.test(toast) && (await page.locator('#calFeedLink').count()) === 0 && await page.evaluate(() => _calFeedToken === null), toast);
  ok(`${name}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── a hostile or malformed "secret" from the server is never used ──');
for (const bad of ['"><img src=x onerror=window.__pwned=1>', 'pcf_short', 'javascript:alert(1)', 'pcf_' + 'a'.repeat(42) + '/', '../../secure-db', '', null, 12345]) {
  const state = { createReply: { status: 'ok', token: bad } };
  const { ctx, page, errs } = await open(state);
  await page.click('#calFeedGet'); await settle(page);
  const html = await cardHtml(page);
  ok(`refused: ${JSON.stringify(bad).slice(0, 40)}`, (await page.locator('#calFeedLink').count()) === 0 && (await page.locator('#calFeedGoogle').count()) === 0
    && !html.includes('onerror') && !html.includes('javascript:') && await page.evaluate(() => _calFeedToken === null && !window.__pwned));
  ok('  no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── the server cannot be reached, or does not offer the feature ──');
for (const [name, state] of [['status call fails', { statusFails: true }], ['session no longer valid', { noSession: true }]]) {
  const { ctx, page, errs } = await open(state);
  ok(`${name}: the card stays empty and the schedule still shows`, (await cardHtml(page)) === '' && (await page.locator('#schedContent').innerText()).length > 0);
  ok(`${name}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const state = { createFails: true };
  const { ctx, page, errs } = await open(state);
  await page.click('#calFeedGet'); await settle(page);
  ok('create fails: an error message, the button is usable again', (await page.locator('#calFeedGet').isEnabled()) && (await page.evaluate(() => document.getElementById('empToast').textContent)).length > 0);
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── layout: narrow phone and desktop ──');
for (const width of [320, 390, 1280]) {
  const { ctx, page } = await open({}, { width });
  await page.click('#calFeedGet'); await settle(page);
  const m = await page.evaluate(() => {
    const card = document.querySelector('#calFeedCard .card').getBoundingClientRect();
    const kids = [...document.querySelectorAll('#calFeedCard .card *')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
    return { cardFits: card.left >= 0 && card.right <= document.documentElement.clientWidth + 1, outside: kids.filter((b) => b.right > card.right + 1 || b.left < card.left - 1).length };
  });
  // The card only: the portal's top bar is measured elsewhere (it is wider than a narrow phone in this bare harness, with or without the card).
  ok(`${width}px: the card fits the screen and nothing sticks out of it`, m.cardFits && m.outside === 0, JSON.stringify(m));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
