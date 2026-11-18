// Kiosk punch when the reply is lost (weak Wi-Fi): the server stored the punch but the tablet never heard back, so it
// used to say "Error saving: Failed to fetch" and the person punched again (then got "already clocked in"). Now the
// terminal asks the server before reporting a failure. The network is stubbed; the server is simulated.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = await new Promise(r => {
  const s = createServer(async (q, res) => {
    try {
      const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(f).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  s.listen(0, '127.0.0.1', () => r(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

const SITE = '11111111-1111-4111-8111-111111111111';
const E_ANN = '00000000-0000-4000-8000-0000000000a1';
const PIN_OK = '1234', PROOF = 'proof-abc.sig';
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) });
const browser = await chromium.launch();

// behaviours for the punch POST, in order (the last repeats): 'ok' | 'lose' (stored, reply never arrives) | 'drop' (not stored, no connection) | 'http500'
async function terminal(behaviours, { stored = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const srv = { punches: stored.slice(), posts: 0, gets: 0 };
  let n = 0;
  await page.route('**/rest/v1/rpc/**', async route => {
    const fn = route.request().url().split('/rpc/')[1];
    if (fn === 'get_kiosk_bootstrap_v2') {
      return json(route, { ok: true, site: { id: SITE, name: 'Front desk', company_id: 'co1', lang: 'en', geo_strict: false },
        company: { id: 'co1', name: 'Acme', punch_label_mode: 'off', track_lunch_breaks: false, visitor_checkin_enabled: false },
        employees: [{ id: E_ANN, name: 'Ann Lee', emp_code: 'A1', site_id: SITE, company_id: 'co1', active: true, has_pin: true, has_email: false }] });
    }
    return json(route, {});
  });
  await page.route('**/functions/v1/secure-db', async route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'kiosk_verify_pin') return json(route, b.body && b.body.pin === PIN_OK ? { ok: true, proof: PROOF, ttl: 120000 } : { ok: false, error: 'incorrect' });
    if (b.table === 'punches' && b.method === 'POST') {
      srv.posts++;
      const beh = behaviours[Math.min(n++, behaviours.length - 1)];
      const row = { id: 'p' + srv.posts, emp_id: b.body.emp_id, type: b.body.type, is_break: !!b.body.is_break, punch_date: b.body.punch_date, punch_time: b.body.punch_time, punched_at: new Date().toISOString(), company_id: 'co1', site_id: SITE };
      if (beh === 'drop') return route.abort('failed');
      if (beh === 'http500') return json(route, { error: 'boom' }, 500);
      srv.punches.push(row);
      if (beh === 'lose') return route.abort('failed');
      return json(route, [row], 201);
    }
    if (b.table === 'punches' && b.method === 'GET') { srv.gets++; return json(route, srv.punches.slice().sort((a, c) => (a.punched_at < c.punched_at ? 1 : -1))); }
    if (b.table === 'employees' && b.method === 'GET') return json(route, [{ id: E_ANN, name: 'Ann Lee', emp_code: 'A1', site_id: SITE, company_id: 'co1', active: true, has_pin: true, has_email: false }]);
    return json(route, []);
  });
  await page.route('**/*.supabase.co/storage/**', r => r.fulfill({ status: 404, body: '' }));
  await page.goto(`${BASE}/index.html?kiosk=${SITE}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof C !== 'undefined' && C.employees && C.employees.length > 0, null, { timeout: 15000 });
  return { ctx, page, srv, errs };
}
async function punch(page, type) {
  await page.evaluate(i => { const s = document.getElementById('empSelect'); s.value = i; s.dispatchEvent(new Event('change')); }, E_ANN);
  await page.evaluate(t => requestPunch(t), type);
  for (const ch of PIN_OK) await page.evaluate(c => pinKey(c), ch);
  await page.waitForFunction(() => { const f = document.getElementById('punchFeedback'); return f && f.classList.contains('show') && f.innerText.trim().length > 0; }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  return page.evaluate(() => { const f = document.getElementById('punchFeedback'); return { text: f.innerText.trim(), cls: f.className, warn: document.getElementById('dblPunchWarnModal') && document.getElementById('dblPunchWarnModal').classList.contains('open') }; });
}
const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();
const inRow = { id: 'old1', emp_id: E_ANN, type: 'IN', is_break: false, punch_date: '2026-11-18', punch_time: '08:00:00', punched_at: minsAgo(240), company_id: 'co1', site_id: SITE };

console.log('\n── normal punch ─────────────────────────────────');
{
  const { ctx, page, srv, errs } = await terminal(['ok']);
  const m = await punch(page, 'IN');
  ok('a normal punch says it was recorded, one POST', /clocked IN/.test(m.text) && /success/.test(m.cls) && srv.posts === 1, JSON.stringify(m));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── the reply is lost after the server stored the punch ──');
{
  const { ctx, page, srv } = await terminal(['lose']);
  const m = await punch(page, 'IN');
  ok('the terminal checks the server and says the punch was recorded (no "Error saving")', /clocked IN/.test(m.text) && /success/.test(m.cls) && !/error saving/i.test(m.text), JSON.stringify(m));
  ok('the punch was sent exactly once (never re-sent, so no duplicate)', srv.posts === 1 && srv.punches.length === 1, 'posts=' + srv.posts);
  ok('and the tile shows the person as clocked in', await page.evaluate(id => getEmpStatus(id).status === 'IN', E_ANN));
  await ctx.close();
}
{
  const { ctx, page, srv } = await terminal(['lose'], { stored: [inRow] });
  const m = await punch(page, 'OUT');
  ok('a clock-out whose reply is lost is also confirmed', /clocked OUT/.test(m.text) && /success/.test(m.cls) && srv.posts === 1, JSON.stringify(m));
  await ctx.close();
}

console.log('\n── nothing reached the server ───────────────────');
{
  const { ctx, page, srv } = await terminal(['drop']);
  const m = await punch(page, 'IN');
  ok('it still reports the failure, as before', /error/.test(m.cls) && /error saving/i.test(m.text), JSON.stringify(m));
  ok('one attempt only, nothing stored, the person is not shown as clocked in', srv.posts === 1 && srv.punches.length === 0 && await page.evaluate(id => getEmpStatus(id).status !== 'IN', E_ANN));
  await ctx.close();
}
{
  const { ctx, page, srv } = await terminal(['http500']);
  const getsBefore = srv.gets;
  const m = await punch(page, 'IN');
  ok('a server error (it answered) is reported without any extra checking', /error/.test(m.cls) && srv.posts === 1 && srv.punches.length === 0, JSON.stringify(m));
  await ctx.close();
}

console.log('\n── a stale earlier punch is not mistaken for the new one ──');
{
  // The last punch is an OUT from earlier; the attempted IN is not stored. Nothing recent matches, so the failure stands.
  const oldOut = { ...inRow, id: 'old2', type: 'OUT', punched_at: minsAgo(30) };
  const { ctx, page } = await terminal(['drop'], { stored: [{ ...inRow, punched_at: minsAgo(300) }, oldOut] });
  const m = await punch(page, 'IN');
  ok('failure stands when the server has no recent IN', /error/.test(m.cls) && /error saving/i.test(m.text), JSON.stringify(m));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
