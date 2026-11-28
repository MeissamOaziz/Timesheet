// Arrival and departure reminders (phone app, Growth and up): the company switch in Settings, Clocking, the
// per-employee switch in the employee profile, and "turn on for everyone with phone clock-in". Nothing leaves the
// browser: writes are captured. The server checks the plan again (secure-db plan-limits, portal_arrival_status).
//   cd tools && node arrival-test.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = await new Promise(r => { const s = createServer(async (q, res) => { try {
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = normalize(join(ROOT, rel));
  if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(f).pipe(res); } catch { res.writeHead(404).end(); } }); s.listen(0, '127.0.0.1', () => r(s)); });

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const q = (page, expr) => page.evaluate(expr);
const wait = ms => new Promise(r => setTimeout(r, ms));

// An owner on `plan`; company co1 with phone clock-in on; Ann and Bob can clock in from the phone, Cy cannot.
async function setup(page, { plan, coArrival = false, empArrival = false }) {
  await page.evaluate(a => {
    window._demoMode = false;
    Sess.set({ id: 'a1', email: 'o@t.ca', status: 'active', role: 'admin', plan: a.plan, token: 't' }, false);
    C.acctCreatedAt = '2026-01-01T12:00:00Z';
    C.companies = [{ id: 'co1', name: 'Acme Fence', admin_id: 'a1', payroll_frequency: 'biweekly', remote_punch_enabled: true, arrival_prompts_enabled: a.coArrival }];
    C.sites = [{ id: 's1', name: 'Main', company_id: 'co1', geo_lat: 45.5, geo_lng: -73.5, geo_radius_m: 100, geo_strict: false }];
    C.employees = [
      { id: 'e1', name: 'Ann Lee', company_id: 'co1', site_id: 's1', active: true, remote_punch_enabled: true, arrival_prompts_enabled: a.empArrival, email: 'ann@x.ca', pin: '1234' },
      { id: 'e2', name: 'Bob Roy', company_id: 'co1', site_id: 's1', active: true, remote_punch_enabled: true, arrival_prompts_enabled: false, email: 'bob@x.ca', pin: '2345' },
      { id: 'e3', name: 'Cy Day', company_id: 'co1', site_id: 's1', active: true, remote_punch_enabled: false, arrival_prompts_enabled: false, email: 'cy@x.ca', pin: '3456' },
    ];
    C.punches = [];
    Ctx.set({ co: C.companies[0], site: C.sites[0] });
    document.body.classList.add('role-resolved', 'role-admin');
    document.querySelectorAll('.upgrade-wall:not(#toLockWall)').forEach(e => e.remove());
    window.__upd = []; DB.update = async (t, f, b) => { window.__upd.push({ t, f, b }); return []; };
    window.__ins = []; DB.insert = async (t, b) => { window.__ins.push({ t, b }); return [{ ...b, id: 'new' }]; };
    DB.all = async () => []; window.refreshCache = async () => {}; window.uploadImage = async () => null;
    window.__toasts = []; window.showToast = m => { window.__toasts.push(String(m)); };
    window.uiConfirm = async () => true;
  }, { plan, coArrival, empArrival });
}
// The row's own display (its Settings tab or the employee's portal section may be folded away in this test).
const vis = (page, id) => page.evaluate(i => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none'; }, id);
const lastUpd = (page, t) => page.evaluate(tb => { const u = window.__upd.filter(x => x.t === tb); return u.length ? u[u.length - 1].b : null; }, t);

const browser = await chromium.launch();
for (const lang of ['en', 'fr']) {
  console.log(`\n── ${lang.toUpperCase()} ────────────────────────────────`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(l => setLang(l), lang);

  // ── company switch
  await setup(page, { plan: 'starter' });
  await page.evaluate(() => editCompany('co1')); await wait(150);
  ok('starter: the reminders switch shows under phone clock-in, locked', await vis(page, 'arrivalPromptsToggleRow') && await q(page, "document.getElementById('arrivalPromptsToggleRow').style.pointerEvents==='none'"));
  await page.evaluate(() => { document.getElementById('arrivalPromptsThumb').style.left = '20px'; saveCompany(); }); await wait(200);
  ok('starter: saving never sends reminders on, whatever the screen says', (await lastUpd(page, 'companies'))?.arrival_prompts_enabled === false);
  await page.evaluate(() => closeModal('addCompanyModal'));

  await setup(page, { plan: 'growth' });
  await page.evaluate(() => editCompany('co1')); await wait(150);
  ok('growth: the switch is unlocked and off by default', await q(page, "document.getElementById('arrivalPromptsToggleRow').style.pointerEvents!=='none' && document.getElementById('arrivalPromptsThumb').style.left!=='20px'"));
  ok('growth: "everyone" button hidden until the switch is saved on', !(await vis(page, 'arrivalPromptsAllRow')));
  await page.evaluate(() => toggleArrivalPromptsOpt());
  await page.evaluate(() => saveCompany()); await wait(200);
  ok('growth: turning it on saves true', (await lastUpd(page, 'companies'))?.arrival_prompts_enabled === true);
  await page.evaluate(() => closeModal('addCompanyModal'));

  await setup(page, { plan: 'growth', coArrival: true });
  await page.evaluate(() => editCompany('co1')); await wait(150);
  ok('growth: a saved-on switch loads on', await q(page, "document.getElementById('arrivalPromptsThumb').style.left==='20px'"));
  await page.evaluate(() => toggleRemotePunchOpt()); await wait(50);
  ok('turning phone clock-in off hides the reminders switch', !(await vis(page, 'arrivalPromptsBlock')));
  await page.evaluate(() => saveCompany()); await wait(200);
  ok('...and saves reminders off with it', (await lastUpd(page, 'companies'))?.arrival_prompts_enabled === false && (await lastUpd(page, 'companies'))?.remote_punch_enabled === false);
  await page.evaluate(() => closeModal('addCompanyModal'));

  // ── "everyone with phone clock-in"
  await setup(page, { plan: 'growth', coArrival: true });
  await page.evaluate(() => editCompany('co1')); await wait(150);
  ok('growth, saved on: the "everyone" button shows', await vis(page, 'arrivalPromptsAllRow'));
  await page.evaluate(() => arrivalPromptsForAll()); await wait(200);
  const all = await q(page, "window.__upd.filter(u=>u.t==='employees').map(u=>u.f+':'+u.b.arrival_prompts_enabled).sort().join(',')");
  ok('it switches on exactly the two employees with phone clock-in', all === 'id=eq.e1:true,id=eq.e2:true', all);
  await page.evaluate(() => closeModal('addCompanyModal'));

  // ── employee profile
  await setup(page, { plan: 'growth', coArrival: true });
  await page.evaluate(() => editEmployee('e1')); await wait(150);
  ok('employee with phone clock-in: the reminders row shows, off', await vis(page, 'empArrivalRow') && await q(page, "document.getElementById('empArrivalThumb').style.left!=='20px'"));
  await page.evaluate(() => toggleEmpArrivalOpt());
  await page.evaluate(() => saveEmployee()); await wait(250);
  ok('switching it on saves true for that employee', (await lastUpd(page, 'employees'))?.arrival_prompts_enabled === true);

  await setup(page, { plan: 'growth', coArrival: true, empArrival: true });
  await page.evaluate(() => editEmployee('e1')); await wait(150);
  ok('a saved-on employee loads on', await q(page, "document.getElementById('empArrivalThumb').style.left==='20px'"));
  await page.evaluate(() => { setEmpRemotePunchToggle(false); });
  ok('turning the employee\'s phone clock-in off hides the row', !(await vis(page, 'empArrivalRow')));
  await page.evaluate(() => saveEmployee()); await wait(250);
  ok('...and saves reminders off', (await lastUpd(page, 'employees'))?.arrival_prompts_enabled === false);

  await setup(page, { plan: 'growth', coArrival: true });
  await page.evaluate(() => editEmployee('e3')); await wait(150);
  ok('employee without phone clock-in: no reminders row', !(await vis(page, 'empArrivalRow')));
  await page.evaluate(() => closeModal('addEmpModal'));

  await setup(page, { plan: 'growth', coArrival: false });
  await page.evaluate(() => editEmployee('e1')); await wait(150);
  ok('company switch off: no reminders row on any employee', !(await vis(page, 'empArrivalRow')));
  await page.evaluate(() => closeModal('addEmpModal'));

  await setup(page, { plan: 'starter', coArrival: true, empArrival: true });
  await page.evaluate(() => editEmployee('e1')); await wait(150);
  ok('starter (even with old stored flags): no row, and a save sends off', !(await vis(page, 'empArrivalRow')));
  await page.evaluate(() => saveEmployee()); await wait(250);
  ok('...saved off', (await lastUpd(page, 'employees'))?.arrival_prompts_enabled === false);

  await setup(page, { plan: 'growth', coArrival: true });
  await page.evaluate(() => { openAddEmpModal(); }); await wait(150);
  ok('new employee: reminders start off', await q(page, "document.getElementById('empArrivalThumb').style.left!=='20px'"));
  await page.evaluate(() => closeModal('addEmpModal'));

  // ── words
  const words = await q(page, "[t('modal.arrivalPrompts'),t('modal.arrivalPromptsDesc'),t('modal.arrivalPromptsAll'),t('emp.arrivalTitle'),t('emp.arrivalDesc'),t('modal.growthAddonLock')]");
  ok('every string exists in this language', words.every(w => w && w.length > 5), JSON.stringify(words.map(w => (w || '').slice(0, 25))));
  if (lang === 'fr') ok('French strings are French', /Rappels/.test(words[0]) && /rappels/.test(words[5]));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
