// The admin's view of an employee's calendar link (index.html, employee dialog, portal section): one line saying a
// link exists and when a calendar last read it, and a Cancel button. The network is stubbed; what the server does
// with these requests is covered by the `calfeed` group of tools/secure-db-regression/diff-test.mjs.
//   node tools/calendar-admin-test.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = await new Promise((r) => { const s = createServer(async (q, res) => { try {
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = normalize(join(ROOT, rel));
  if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(f).pipe(res); } catch { res.writeHead(404).end(); } }); s.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x !== '' ? '  -> ' + String(x).slice(0, 300) : ''}`); };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const E1 = '00000000-0000-4000-8000-0000000000e1', E2 = '00000000-0000-4000-8000-0000000000e2';
const OWNER = { id: 'a1', name: 'Olivia Owner', email: 'o@x.ca', role: 'admin', plan: 'growth', token: 'tok-admin' };
const browser = await chromium.launch();

// st.portal: the employee's portal row status (active | invited | none). st.feed: what calendar_feed_status answers.
async function openApp(st, { lang = 'en', demo = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  st.calls = []; st.errs = [];
  page.on('pageerror', (e) => st.errs.push(e.message));
  await page.route('**/functions/v1/**', async (route) => {
    if (!route.request().url().endsWith('/secure-db')) return json(route, {});
    const b = JSON.parse(route.request().postData() || '{}'); st.calls.push(b);
    if (b.action === 'calendar_feed_status') {
      if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
      return st.statusCode ? json(route, { error: 'x' }, st.statusCode) : json(route, st.feed || { ok: true, active: false, created_at: null, last_read_at: null });
    }
    if (b.action === 'calendar_feed_cancel') {
      if (st.cancelCode) return json(route, { error: 'Could not cancel the calendar link' }, st.cancelCode);
      st.feed = { ok: true, active: false, created_at: null, last_read_at: null };
      return json(route, { ok: true, cancelled: true });
    }
    if (b.action) return json(route, { ok: true });
    if (b.table === 'employee_portal' && b.method === 'GET') return json(route, st.portal === 'none' ? [] : [{ id: 'p1', employee_id: E1, email: 'ann@x.ca', status: st.portal || 'active', last_login: '2026-11-12T12:00:00Z' }]);
    if (b.table === 'employee_portal' && b.method === 'DELETE') { st.portal = 'none'; return route.fulfill({ status: 204, body: '' }); }
    return json(route, []);
  });
  await page.route('**/rest/v1/rpc/**', (route) => json(route, {}));
  await page.route('**/*.supabase.co/storage/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => setLang(l), lang);
  if (demo) await page.evaluate(() => startDemo());
  else await page.evaluate((s) => { Sess.set(s, false); hideLanding(); updateNav(); }, OWNER);
  await page.evaluate((id) => {
    window.__confirm = true; window.__asked = [];
    window.uiConfirm = async (m) => { window.__asked.push(m); return window.__confirm; };
    document.getElementById('editEmpUid').value = id;
    C.employees = [{ id, name: 'Ann Lee', email: 'ann@x.ca' }];
    document.getElementById('addEmpModal').classList.remove('paid-locked');
    document.getElementById('emailReportSection').style.display = '';   // shown by the app when an existing employee is opened
    openModal('addEmpModal');          // the line lives inside the employee dialog
  }, E1);
  return { page, ctx };
}
const load = async (page, id = E1) => { await page.evaluate((i) => loadEmpPortalStatus({ id: i, name: 'Ann Lee', email: 'ann@x.ca' }), id); await page.waitForTimeout(150); };
const row = (page) => page.evaluate(() => {
  const r = document.getElementById('empCalFeedRow');
  return { shown: getComputedStyle(r).display !== 'none', text: document.getElementById('empCalFeedStatus').textContent, btn: document.getElementById('empCalFeedCancelBtn').textContent, html: r.innerHTML };
});
const feedCalls = (st, a) => st.calls.filter((c) => c.action === a);
const toast = (page) => page.evaluate(() => (document.getElementById('toast') || document.querySelector('.toast') || {}).textContent || '');

console.log('\n── the employee has a link ──');
{
  const st = { portal: 'active', feed: { ok: true, active: true, created_at: '2026-11-10T12:00:00Z', last_read_at: '2026-11-13T08:00:00Z' } };
  const { page, ctx } = await openApp(st);
  await load(page);
  let r = await row(page);
  ok('the line is shown under the portal status', r.shown && /^Calendar link: on · last read /.test(r.text) && r.btn === 'Cancel link', JSON.stringify(r));
  const sent = feedCalls(st, 'calendar_feed_status');
  ok('one status call: the employee id and the session token, nothing else of interest', sent.length === 1 && JSON.stringify(sent[0].body) === JSON.stringify({ employee_id: E1 }) && sent[0].sessionToken === 'tok-admin');
  ok('the page holds no link and no secret', !/pcf_|\.ics|calendar-feed/.test(r.html));
  await page.evaluate(() => { window.__confirm = false; });
  await page.click('#empCalFeedCancelBtn'); await page.waitForTimeout(150);
  ok('Cancel asks first; answering no sends nothing', (await page.evaluate(() => window.__asked.length)) === 1 && feedCalls(st, 'calendar_feed_cancel').length === 0 && (await row(page)).shown);
  await page.evaluate(() => { window.__confirm = true; });
  await page.click('#empCalFeedCancelBtn'); await page.waitForTimeout(200);
  r = await row(page);
  ok('answering yes cancels that employee\'s link and hides the line', feedCalls(st, 'calendar_feed_cancel').length === 1 && JSON.stringify(feedCalls(st, 'calendar_feed_cancel')[0].body) === JSON.stringify({ employee_id: E1 }) && !r.shown);
  ok('no page errors', st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}

console.log('\n── variations ──');
{
  const st = { portal: 'active', feed: { ok: true, active: true, created_at: '2026-11-10T12:00:00Z', last_read_at: null } };
  const { page, ctx } = await openApp(st, { lang: 'fr' });
  await load(page);
  const r = await row(page);
  ok('French, never read', r.shown && r.text === 'Lien de calendrier : actif · pas encore lu' && r.btn === 'Annuler le lien', r.text);
  ok('no page errors', st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}
{
  const st = { portal: 'active' };
  const { page, ctx } = await openApp(st);
  await load(page);
  ok('no link: nothing is shown', !(await row(page)).shown && feedCalls(st, 'calendar_feed_status').length === 1);
  await ctx.close();
}
for (const portal of ['invited', 'none']) {
  const st = { portal, feed: { ok: true, active: true, created_at: null, last_read_at: null } };
  const { page, ctx } = await openApp(st);
  await load(page);
  ok(`portal account ${portal}: the link is not even asked about`, !(await row(page)).shown && feedCalls(st, 'calendar_feed_status').length === 0);
  await ctx.close();
}
for (const code of [400, 403, 404, 500, 502]) {
  const st = { portal: 'active', statusCode: code };
  const { page, ctx } = await openApp(st);
  await load(page);
  ok(`the server answers ${code}: nothing is shown, the admin stays signed in`, !(await row(page)).shown && await page.evaluate(() => !!Sess.get()) && st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}
for (const [name, feed] of [
  ['"active" is not exactly true', { ok: true, active: 'yes', last_read_at: null }],
  ['an empty answer', {}],
  ['a list instead of an object', [{ active: true }]]
]) {
  const st = { portal: 'active', feed };
  const { page, ctx } = await openApp(st);
  await load(page);
  ok(`${name}: nothing is shown`, !(await row(page)).shown && st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}
{
  const st = { portal: 'active', feed: { ok: true, active: true, created_at: '<img src=x onerror=window.__pwned=1>', last_read_at: '<img src=x onerror=window.__pwned=1>' } };
  const { page, ctx } = await openApp(st);
  await load(page);
  const r = await row(page);
  ok('a hostile date is shown as "not read yet", never as markup', r.shown && r.text === 'Calendar link: on · not read yet' && !r.html.includes('<img') && await page.evaluate(() => !window.__pwned), r.text);
  await ctx.close();
}
{
  // The dialog moves on to another employee while the answer for the first is still on its way.
  const st = { portal: 'active', delayMs: 400, feed: { ok: true, active: true, created_at: null, last_read_at: null } };
  const { page, ctx } = await openApp(st);
  await page.evaluate((i) => { loadEmpPortalStatus({ id: i, name: 'Ann Lee', email: 'ann@x.ca' }); }, E1);
  await page.waitForTimeout(150);
  await page.evaluate((i) => { document.getElementById('editEmpUid').value = i; }, E2);
  await page.waitForTimeout(600);
  ok('a late answer for the previous employee is not shown on the next one', !(await row(page)).shown);
  await ctx.close();
}
{
  const st = { portal: 'active', cancelCode: 502, feed: { ok: true, active: true, created_at: null, last_read_at: null } };
  const { page, ctx } = await openApp(st);
  await load(page);
  await page.click('#empCalFeedCancelBtn'); await page.waitForTimeout(200);
  ok('cancel fails: the line stays and the button works again', (await row(page)).shown && await page.evaluate(() => !document.getElementById('empCalFeedCancelBtn').disabled) && st.errs.length === 0);
  await ctx.close();
}
{
  const st = { portal: 'active', feed: { ok: true, active: true, created_at: null, last_read_at: null } };
  const { page, ctx } = await openApp(st);
  await load(page);
  await page.evaluate((i) => revokeEmpPortalAccess(i), E1); await page.waitForTimeout(300);
  const order = st.calls.map((c) => c.action || `${c.method} ${c.table}`);
  ok('revoking portal access also cancels the calendar link, after the portal row is removed',
    order.indexOf('calendar_feed_cancel') > order.indexOf('DELETE employee_portal') && order.indexOf('DELETE employee_portal') >= 0 && !(await row(page)).shown, order.join(', '));
  ok('no page errors', st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}
{
  const st = { portal: 'active', feed: { ok: true, active: true, created_at: null, last_read_at: null } };
  const { page, ctx } = await openApp(st, { demo: true });
  await page.evaluate((i) => loadEmpCalFeed({ id: i }), E1); await page.waitForTimeout(150);
  ok('demo mode: nothing is asked of the server', !(await row(page)).shown && feedCalls(st, 'calendar_feed_status').length === 0 && st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
