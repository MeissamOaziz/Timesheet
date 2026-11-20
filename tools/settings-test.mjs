// The Settings page (replaces the long Company Info window): four tabs over the same company form, a Save bar that says
// when something is unsaved, a company picker for accounts with several companies, owners and co-admins only. The form
// is the same elements as before, so saving must send what the old window sent. Runs in demo mode (sample data, nothing
// real); everything that leaves the browser is blocked and saves are captured.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon' };
const server = await new Promise(r => {
  const s = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(f).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  s.listen(0, '127.0.0.1', () => r(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

const browser = await chromium.launch();
async function demoPage(width, height, lang) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route(u => !u.href.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(u.href) && !u.href.startsWith('data:'), r => r.abort());
  const p = await ctx.newPage(); p._errs = []; p.on('pageerror', e => { if (!/ServiceWorker/.test(e.message)) p._errs.push(e.message); });
  await p.goto(BASE + 'index.html', { waitUntil: 'load' }); await sleep(500);
  await p.evaluate(l => { try { localStorage.setItem('pc_tour_v1', '1'); sessionStorage.setItem('pc_demo_coach', 'off'); setLang(l); } catch (e) {} }, lang);
  await p.evaluate(() => startDemo()); await sleep(600);
  await p.evaluate(() => { const b = document.getElementById('demoBanner'); if (b) b.remove(); _syncDemoBannerH(); const d = document.getElementById('demoCoach'); if (d) d.remove(); });
  // capture writes, never send them
  await p.evaluate(() => { window.__upd = []; DB.update = async (t, f, b) => { window.__upd.push({ t, f, b }); return []; }; window.uploadImage = async () => null; window.refreshCache = async () => {}; });
  return p;
}
const q = (p, expr) => p.evaluate(expr);
const visibleSecs = p => p.evaluate(() => [...document.querySelectorAll('#companyFormBody .set-sec')].filter(e => getComputedStyle(e).display !== 'none').map(e => e.dataset.sec));
const SEC_FIELDS = {
  company: ['companyName', 'companyAddress', 'companyPhone', 'companyIndustry', 'companyDesc', 'logoFileInput'],
  pay: ['companyWeekStart', 'companyPayrollFreq', 'companyPunchRounding', 'overtimeToggle', 'companyOtDailyHours', 'companyOtWeeklyHours', 'companyEveningOn', 'companyEveningStart'],
  clock: ['remotePunchToggle', 'companyPunchLabelMode', 'lunchToggle', 'companyLunchPaidMinutes', 'visitorCheckinToggle'],
  mgr: ['mgrAllSitesToggle', 'companyAlertsEnabled', 'companyAlertForgotOut', 'companyForgotOutHours', 'companyAlertOvertime'],
};

console.log('\n── the page, desktop, English ───────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  ok('the sidebar has a Settings entry', await q(p, "(() => { const b = document.getElementById('snSettings'); return !!b && getComputedStyle(b).display !== 'none' && /Settings/.test(b.innerText); })()"));
  ok('the phone menu has one too', await q(p, "(() => { const b = document.getElementById('mobileNavSettings'); return !!b && /Settings/.test(b.textContent); })()"));
  await p.evaluate(() => document.getElementById('snSettings').click()); await sleep(500);
  ok('it opens the Settings page and marks the sidebar entry', await q(p, "document.getElementById('page-settings').classList.contains('active') && document.getElementById('snSettings').classList.contains('active')"));
  ok('the form lives on the page, not in the window', await q(p, "document.getElementById('companyFormBody').parentElement.id==='settingsHost' && !document.getElementById('addCompanyModal').classList.contains('open')"));
  ok('four tabs, the first one open', await q(p, "[...document.querySelectorAll('#setTabs .set-tab')].map(b=>b.innerText).join('|')") === 'Company|Pay and hours|Clocking|Managers and alerts' && (await visibleSecs(p)).join() === 'company');
  for (const [sec, ids] of Object.entries(SEC_FIELDS)) {
    await p.evaluate(s => settingsGoSec(s), sec);
    const vis = await visibleSecs(p);
    const inView = await p.evaluate(ids => ids.map(id => { const e = document.getElementById(id); return e && e.closest('.set-sec') && e.closest('.set-sec').dataset.sec; }), ids);
    ok(`tab "${sec}": only that section shows, and it holds its fields`, vis.join() === sec && inView.every(x => x === sec), JSON.stringify({ vis, inView }));
  }
  await p.evaluate(() => settingsGoSec('pay'));
  const h = await p.evaluate(() => Math.round(document.getElementById('settingsHost').getBoundingClientRect().height));
  ok('one tab is far shorter than the old 2,300 px window', h < 900, 'host height ' + h);
  ok('the Save bar is in view without scrolling', await q(p, "(() => { const r = document.getElementById('settingsSaveBtn').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"));
  ok('nothing is marked unsaved yet', await q(p, "document.getElementById('settingsNote').textContent==='' && document.getElementById('settingsRevertBtn').style.display==='none'"));
  ok('no page errors', p._errs.length === 0, p._errs.join(' | '));
  await p.context().close();
}

console.log('\n── unsaved changes ──────────────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => openSettings()); await sleep(400);
  await p.evaluate(() => settingsGoSec('pay'));
  await p.evaluate(() => { const s = document.getElementById('companyOtDailyHours'); s.value = '10'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  ok('changing a field says so and offers Discard', await q(p, "/unsaved/i.test(document.getElementById('settingsNote').textContent) && document.getElementById('settingsRevertBtn').style.display!=='none'"));
  await p.evaluate(() => document.getElementById('settingsRevertBtn').click());
  ok('Discard puts the stored value back and clears the note', await q(p, "document.getElementById('companyOtDailyHours').value===String(C.companies[0].ot_daily_hours||8) && document.getElementById('settingsNote').textContent===''"));
  await p.evaluate(() => settingsGoSec('clock'));
  await p.evaluate(() => document.getElementById('visitorCheckinToggleRow').click());
  await p.evaluate(() => document.getElementById('lunchToggleRow').click());
  ok('flipping a switch counts too', await q(p, "/unsaved/i.test(document.getElementById('settingsNote').textContent)"));
  await p.evaluate(() => document.getElementById('settingsRevertBtn').click());

  await p.evaluate(() => { const s = document.getElementById('companyName'); s.value = s.value + ' X'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  let dlg = null; p.once('dialog', d => { dlg = d.message(); d.dismiss(); });
  await p.evaluate(() => navigate('dashboard')); await sleep(300);
  ok('leaving with an unsaved edit asks first (and Cancel keeps you here)', !!dlg && /unsaved/i.test(dlg) && await q(p, "currentPage==='settings' && document.getElementById('page-settings').classList.contains('active')"), String(dlg));
  p.once('dialog', d => d.accept());
  await p.evaluate(() => navigate('dashboard')); await sleep(400);
  ok('...and OK leaves, handing the form back to the New company window', await q(p, "currentPage==='dashboard' && document.getElementById('companyFormBody').parentElement.classList.contains('modal') && !document.getElementById('companyFormBody').classList.contains('settings-mode')"));
  ok('...and the edit was not saved', (await q(p, 'window.__upd.length')) === 0);
  await p.evaluate(() => openSettings()); await sleep(400);
  ok('coming back shows the stored name again, nothing marked unsaved', await q(p, "document.getElementById('companyName').value===C.companies[0].name && document.getElementById('settingsNote').textContent===''"));
  await p.context().close();
}

console.log('\n── saving sends what the old window sent ─────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => openSettings()); await sleep(400);
  const before = await p.evaluate(() => JSON.parse(JSON.stringify(C.companies[0])));
  await p.evaluate(() => { settingsGoSec('pay'); const s = document.getElementById('companyOtDailyHours'); s.value = '10'; s.dispatchEvent(new Event('change', { bubbles: true })); const w = document.getElementById('companyWeekStart'); w.value = 'sunday'; w.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.evaluate(() => document.getElementById('settingsSaveBtn').click()); await sleep(400);
  const upd = await q(p, 'window.__upd');
  ok('one company update was sent, for this company', upd.length === 1 && upd[0].t === 'companies' && upd[0].f === `id=eq.${before.id}`, JSON.stringify(upd.map(u => u.f)));
  const b = upd[0] && upd[0].b || {};
  ok('it carries the two edits', b.ot_daily_hours === 10 && b.week_start === 'sunday', JSON.stringify({ d: b.ot_daily_hours, w: b.week_start }));
  // what the form shows (and so sends) for a setting the company has no stored value for yet
  const DEF = { alerts_enabled: true, alert_forgot_out: true, alert_overtime: true, forgot_out_hours: 14, ot_weekly_hours: 40, punch_rounding: 0, track_overtime: false, track_lunch_breaks: false, lunch_break_paid_minutes: 0, visitor_checkin_enabled: false, remote_punch_enabled: false, managers_see_all_sites: false, punch_label_mode: 'off', evening_start: null, evening_end: null, evening_days: null, payroll_frequency: 'biweekly' };
  const diff = Object.keys(DEF).filter(k => JSON.stringify(b[k]) !== JSON.stringify(before[k] !== undefined && before[k] !== null ? before[k] : DEF[k]));
  ok('every other setting is sent unchanged', diff.length === 0, 'differs: ' + diff.join(','));
  ok('it stays on the page, marks nothing unsaved and shows the saved notice', await q(p, "currentPage==='settings' && document.getElementById('settingsNote').textContent==='' && /saved/i.test(document.getElementById('toast')?.textContent||document.body.innerText)"));
  ok('the stored company now has the new values', await q(p, "C.companies[0].ot_daily_hours===10 && C.companies[0].week_start==='sunday'"));
  // a bad evening window is refused on the right tab
  await p.evaluate(() => { window.__upd = []; settingsGoSec('pay'); document.getElementById('companyEveningOn').checked = true; toggleEveningSettings(); document.getElementById('companyEveningStart').value = '18:00'; document.getElementById('companyEveningEnd').value = '17:00'; settingsGoSec('mgr'); });
  await p.evaluate(() => document.getElementById('settingsSaveBtn').click()); await sleep(300);
  ok('a bad evening window: nothing is sent, the error is shown, and the Pay and hours tab opens', (await q(p, 'window.__upd.length')) === 0 && await q(p, "/must end after/i.test(document.getElementById('settingsMsg').innerText) && document.querySelector('#setTabs .set-tab.active').dataset.sec==='pay'"));
  await p.evaluate(() => { document.getElementById('companyName').value = ''; settingsGoSec('mgr'); });
  await p.evaluate(() => document.getElementById('settingsSaveBtn').click()); await sleep(300);
  ok('an empty name: refused, and the Company tab opens', await q(p, "document.querySelector('#setTabs .set-tab.active').dataset.sec==='company' && document.getElementById('settingsMsg').innerText.length>3"));
  ok('no page errors', p._errs.length === 0, p._errs.join(' | '));
  await p.context().close();
}

console.log('\n── the New company window is unchanged ──────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => openSettings()); await sleep(400);
  await p.evaluate(() => navigate('sites')); await sleep(300);
  await p.evaluate(() => { window.canAddCompany = () => ({ ok: true, current: 0, max: 9, plan: { name: 'Test' } }); openAddCompanyModal(); });
  ok('it opens with every section stacked, in the window', await q(p, "document.getElementById('addCompanyModal').classList.contains('open') && document.getElementById('companyFormBody').parentElement.classList.contains('modal') && [...document.querySelectorAll('#companyFormBody .set-sec')].every(e=>getComputedStyle(e).display!=='none')"));
  ok('and starts empty', await q(p, "document.getElementById('companyName').value==='' && document.getElementById('editCompanyUid').value===''"));
  await p.evaluate(() => closeModal('addCompanyModal'));
  await p.evaluate(() => openSettings()); await sleep(400);
  ok('Settings takes the form back and shows the stored company', await q(p, "document.getElementById('companyFormBody').parentElement.id==='settingsHost' && document.getElementById('companyName').value===C.companies[0].name && document.getElementById('editCompanyUid').value===C.companies[0].id"));
  ok('no page errors', p._errs.length === 0, p._errs.join(' | '));
  await p.context().close();
}

console.log('\n── several companies, and who may open it ───────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { const c = JSON.parse(JSON.stringify(C.companies[0])); c.id = 'demo-co2'; c.name = 'Second Co'; c.ot_daily_hours = 6; C.companies.push(c); });
  await p.evaluate(() => openSettings('demo-co2', 'pay')); await sleep(400);
  ok('the picker shows, with both companies, on the one asked for', await q(p, "getComputedStyle(document.getElementById('settingsCoPick')).display!=='none' && document.getElementById('settingsCompany').options.length===2 && document.getElementById('settingsCompany').value==='demo-co2'"));
  ok('...and the tab asked for, with that company\'s values', await q(p, "document.querySelector('#setTabs .set-tab.active').dataset.sec==='pay' && document.getElementById('companyName').value==='Second Co' && document.getElementById('companyOtDailyHours').value==='6'"));
  await p.evaluate(() => { const s = document.getElementById('settingsCompany'); s.value = C.companies[0].id; s.dispatchEvent(new Event('change')); });
  ok('switching company loads the other one', await q(p, "document.getElementById('companyName').value===C.companies[0].name && document.getElementById('editCompanyUid').value===C.companies[0].id"));
  await p.evaluate(() => { document.getElementById('companyName').value = 'Edited'; document.getElementById('companyName').dispatchEvent(new Event('input', { bubbles: true })); });
  let dlg = null; p.once('dialog', d => { dlg = d.message(); d.dismiss(); });
  await p.evaluate(() => { const s = document.getElementById('settingsCompany'); s.value = 'demo-co2'; s.dispatchEvent(new Event('change')); }); await sleep(200);
  ok('switching with an unsaved edit asks first, and Cancel keeps both the company and the edit', !!dlg && await q(p, "document.getElementById('settingsCompany').value===C.companies[0].id && document.getElementById('companyName').value==='Edited'"));
  await p.evaluate(() => { window.isManager = () => true; });
  await p.evaluate(() => navigate('dashboard'));
  p.once('dialog', d => d.accept());
  await p.evaluate(() => navigate('settings')); await sleep(300);
  ok('a manager is sent to the dashboard instead', await q(p, "currentPage==='dashboard'"));
  await p.context().close();
}

console.log('\n── "Set up phone clock-in" from the page ────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => openSettings(null, 'clock')); await sleep(400);
  ok('Clocking has the Remote Access switch and the setup link', await q(p, "(() => { const r = document.getElementById('remotePunchSetupRow'); return getComputedStyle(r).display!=='none' && /Set up phone clock-in/.test(r.innerText) && r.closest('.set-sec').dataset.sec==='clock'; })()"));
  await p.evaluate(() => document.querySelector('#remotePunchSetupRow button').click()); await sleep(500);
  ok('the link opens the phone window for this company, over the page', await q(p, "document.getElementById('phoneSetupModal').classList.contains('open') && currentPage==='settings'"));
  ok('no page errors', p._errs.length === 0, p._errs.join(' | '));
  await p.context().close();
}

console.log('\n── French, and a phone ──────────────────────────');
{
  const p = await demoPage(390, 844, 'fr');
  await p.evaluate(() => openSettings()); await sleep(500);
  ok('French labels', await q(p, "[...document.querySelectorAll('#setTabs .set-tab')].map(b=>b.innerText).join('|')") === 'Compagnie|Paie et heures|Pointage|Gestionnaires et alertes' && /Paramètres/.test(await q(p, "document.querySelector('#page-settings h1').innerText")));
  ok('no sideways scrolling of the page', await q(p, 'document.documentElement.scrollWidth <= innerWidth + 1'), await q(p, 'document.documentElement.scrollWidth + ">" + innerWidth'));
  ok('the tab strip scrolls inside itself', await q(p, "(() => { const b = document.getElementById('setTabs'); return b.scrollWidth > b.clientWidth && getComputedStyle(b).overflowX !== 'visible'; })()"));
  await p.evaluate(() => settingsGoSec('mgr')); await sleep(200);
  ok('opening the last tab brings it into view', await q(p, "(() => { const bar = document.getElementById('setTabs').getBoundingClientRect(), b = document.getElementById('setTab-mgr').getBoundingClientRect(); return b.left >= bar.left - 1 && b.right <= bar.right + 1; })()"));
  ok('the Save bar is reachable and not cut off', await q(p, "(() => { const r = document.getElementById('settingsSaveBtn').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()"));
  await p.evaluate(() => { const e = document.getElementById('companyName'); e.value = 'Z'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  ok('French unsaved note', await q(p, "/non enregistrées/.test(document.getElementById('settingsNote').textContent)"));
  for (const sec of ['company', 'pay', 'clock', 'mgr']) {
    await p.evaluate(s => settingsGoSec(s), sec);
    ok(`${sec}: no sideways scrolling on a phone`, await q(p, 'document.documentElement.scrollWidth <= innerWidth + 1 && document.getElementById("settingsHost").scrollWidth <= document.getElementById("settingsHost").clientWidth + 1'));
  }
  ok('no page errors', p._errs.length === 0, p._errs.join(' | '));
  await p.context().close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
