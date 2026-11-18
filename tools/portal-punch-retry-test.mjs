// Clock-in / clock-out on the employee portal when the connection is weak. 2026-11-18: a clock-out was stored by the
// server but its reply never reached the phone, so the screen said "Could not record punch", kept showing "Clocked in",
// and the next tap said "You are not clocked in yet". fetch is stubbed; the server is simulated (it remembers the
// client_op_id of each punch, like portal_punch does).
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

const browser = await chromium.launch();
const SITE = '33333333-3333-3333-3333-333333333333';
// behaviours: per-attempt behaviour of portal_punch, the last one repeats:
//   'ok' | 'lose' (stored, reply never arrives) | 'drop' (not stored, no connection) | 'hang' (stored, never answers)
//   'notin' (server refuses) | 'http500'
async function run(behaviours, { lastType = 'IN', lang = 'en', timeout = 300 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const srv = { punches: lastType === 'IN' ? [{ type: 'IN', punched_at: new Date(Date.now() - 3600e3).toISOString() }] : [], ops: new Map(), calls: [], opIds: [] };
  let n = 0;
  await page.route('**/rest/v1/rpc/*', async route => {
    const fn = route.request().url().split('/rpc/')[1];
    const body = JSON.parse(route.request().postData() || '{}'); srv.calls.push(fn);
    if (fn === 'portal_punch') {
      srv.opIds.push(body.p_client_op_id);
      const b = behaviours[Math.min(n++, behaviours.length - 1)];
      const store = () => {
        if (body.p_client_op_id && srv.ops.has(body.p_client_op_id)) return { dup: true };
        srv.punches.push({ type: body.p_type, punched_at: new Date().toISOString() });
        if (body.p_client_op_id) srv.ops.set(body.p_client_op_id, 1);
        return { dup: false };
      };
      if (b === 'drop') return route.abort('failed');
      if (b === 'lose') { store(); return route.abort('failed'); }
      if (b === 'hang') { store(); return; }
      if (b === 'notin') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ok: false, error_code: 'not_in' }]) });
      if (b === 'http500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
      const r = store();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ok: true, error_code: null, punch_id: 'a8e16a56-c098-4f5f-9c70-92aa2b7293cd', duplicate: r.dup }]) });
    }
    let out = [];
    if (fn === 'portal_get_company_payroll') out = [{ remote_punch_enabled: true }];
    else if (fn === 'portal_get_punches') out = srv.punches;
    else if (fn === 'portal_get_punch_labels') out = [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.goto(BASE + '/employee.html', { waitUntil: 'networkidle' });
  await page.evaluate(([site, lg, to]) => { _session = { token: 'tok', siteId: site, employeeId: 'e1' }; _employee = { remote_punch_enabled: true }; _empLang = lg; _punchTimeoutMs = to; document.getElementById('screenApp').style.display = 'block'; }, [SITE, lang, timeout]);
  await page.evaluate(() => initPunchBar()); await page.waitForTimeout(400);
  return { ctx, page, srv, errs };
}
const state = page => page.evaluate(() => ({ text: document.getElementById('punchStatusText').innerText, err: document.getElementById('punchError').innerText.trim(), btn: document.getElementById('punchBtnLabel').innerText, punching: _punching, disabled: document.getElementById('punchBtn').disabled }));
const tap = async (page, ms = 8000) => { await page.evaluate(() => { doPunch(); }); await page.waitForFunction(() => !_punching, null, { timeout: ms }).catch(() => {}); await page.waitForTimeout(200); };
const outs = srv => srv.punches.filter(p => p.type === 'OUT').length;

console.log('\n── normal clock-out ─────────────────────────────');
{
  const { ctx, page, srv, errs } = await run(['ok']); await tap(page);
  const s = await state(page);
  ok('one punch is sent, with a client_op_id (a uuid)', srv.calls.filter(c => c === 'portal_punch').length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(srv.opIds[0] || ''), String(srv.opIds[0]));
  ok('the screen shows Clocked out, no error', s.text === 'Clocked out' && s.err === '' && s.btn === 'Clock In' && !s.punching, JSON.stringify(s));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── the reply is lost after the server stored the punch (the real case) ──');
{
  const { ctx, page, srv, errs } = await run(['lose', 'ok']); await tap(page);
  const s = await state(page);
  ok('it asks again with the SAME id', srv.calls.filter(c => c === 'portal_punch').length === 2 && srv.opIds[0] === srv.opIds[1], JSON.stringify(srv.opIds));
  ok('the server holds exactly one clock-out (no duplicate)', outs(srv) === 1, 'outs=' + outs(srv));
  ok('the screen shows Clocked out, no error', s.text === 'Clocked out' && s.err === '' && s.btn === 'Clock In', JSON.stringify(s));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, srv } = await run(['lose']); await tap(page, 15000);
  const s = await state(page);
  ok('even if every reply is lost, the screen checks with the server and shows Clocked out (it WAS recorded)', s.text === 'Clocked out' && s.err === '' && s.btn === 'Clock In' && !s.punching && outs(srv) === 1, JSON.stringify({ s, outs: outs(srv) }));
  await ctx.close();
}
{
  const { ctx, page, srv } = await run(['hang']); await tap(page, 20000);
  const s = await state(page);
  ok('a request that never answers is given up after the timeout, then checked: Clocked out, button usable again', s.text === 'Clocked out' && !s.punching && !s.disabled && outs(srv) === 1, JSON.stringify({ s, outs: outs(srv) }));
  await ctx.close();
}

console.log('\n── nothing reached the server ───────────────────');
{
  const { ctx, page, srv } = await run(['drop']); await tap(page, 15000);
  const s = await state(page);
  ok('it says plainly that the punch was NOT recorded', /No connection\. Your punch was NOT recorded/.test(s.err), JSON.stringify(s));
  ok('the screen still shows Clocked in and the button works again', s.text === 'Clocked in' && s.btn === 'Clock Out' && !s.punching && !s.disabled && outs(srv) === 0, JSON.stringify(s));
  await ctx.close();
}
{
  const { ctx, page, srv } = await run(['http500', 'ok']); await tap(page, 15000);
  const s = await state(page);
  ok('a server error is retried and then succeeds', s.text === 'Clocked out' && s.err === '' && outs(srv) === 1, JSON.stringify(s));
  await ctx.close();
}
{
  const { ctx, page } = await run(['drop'], { lang: 'fr' }); await tap(page, 15000);
  const s = await state(page);
  ok('the message is French in a French portal', /Pas de connexion\. Votre pointage n.a PAS/.test(s.err), JSON.stringify(s));
  await ctx.close();
}

console.log('\n── the server says no ────────────────────────────');
{
  const { ctx, page } = await run(['notin']); await tap(page);
  const s = await state(page);
  ok('the refusal is shown in words', /You are not clocked in yet/.test(s.err), JSON.stringify(s));
  await ctx.close();
}
{
  const { ctx, page, srv } = await run(['notin']);
  srv.punches.push({ type: 'OUT', punched_at: new Date().toISOString() });   // the server already has the clock-out
  await tap(page);
  const s = await state(page);
  ok('when the server already has the clock-out, the refusal is followed by Clocked out (no more stale screen)', s.text === 'Clocked out' && s.btn === 'Clock In', JSON.stringify(s));
  await ctx.close();
}

console.log('\n── clocking in still works ──────────────────────');
{
  const { ctx, page, srv } = await run(['ok'], { lastType: 'OUT' }); await tap(page);
  const s = await state(page);
  ok('IN: sent once and the screen shows Clocked in', srv.calls.filter(c => c === 'portal_punch').length === 1 && s.text === 'Clocked in' && s.err === '', JSON.stringify(s));
  await ctx.close();
}
{
  const { ctx, page, srv } = await run(['lose', 'ok'], { lastType: 'OUT' }); await tap(page);
  const s = await state(page);
  ok('IN with a lost reply: retried with the same id, one IN stored, Clocked in', s.text === 'Clocked in' && srv.punches.filter(p => p.type === 'IN').length === 1 && srv.opIds[0] === srv.opIds[1], JSON.stringify(s));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
