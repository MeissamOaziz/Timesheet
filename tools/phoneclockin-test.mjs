// Phone clock-in: the Phone column on the Employees list, the "Phone clock-in" window, and the
// "How will your team clock in?" question on the dashboard. Runs in demo mode (sample data, nothing
// leaves the browser), and also checks the French text and the phone layout.
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
  // Nothing may leave the browser.
  await ctx.route(u => !u.href.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(u.href) && !u.href.startsWith('data:'), r => r.abort());
  const p = await ctx.newPage(); p._errs = []; p.on('pageerror', e => p._errs.push(e.message));
  await p.goto(BASE + 'index.html', { waitUntil: 'load' }); await sleep(500);
  await p.evaluate(l => { try { localStorage.setItem('pc_tour_v1', '1'); sessionStorage.setItem('pc_demo_coach', 'off'); setLang(l); } catch (e) {} }, lang);
  await p.evaluate(() => startDemo()); await sleep(500);
  await p.evaluate(() => { const b = document.getElementById('demoBanner'); if (b) b.remove(); _syncDemoBannerH(); const d = document.getElementById('demoCoach'); if (d) d.remove(); });
  return p;
}
const rowText = (p, name) => p.evaluate(nm => [...document.querySelectorAll('#empTableBody tr')].find(r => r.innerText.includes(nm)).innerText.replace(/\n+/g, ' / '), name);

console.log('\n── Employees list ──────────────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => navigate('admin')); await sleep(1100);
  ok('Marie can clock in', /Can clock in/.test(await rowText(p, 'Marie')));
  ok('David is invited, with Resend', /Invited \/ Resend/.test(await rowText(p, 'David')));
  ok('Jean has an email but no invitation, with Invite', /Not invited \/ Invite/.test(await rowText(p, 'Jean')));
  ok('Sofia needs an email, with Add email', /Needs an email \/ Add email/.test(await rowText(p, 'Sofia')));
  await p.evaluate(() => invitePhoneFromList('demo-e3')); await sleep(600);
  ok('inviting Jean from the list turns it into Invited', /Invited/.test(await rowText(p, 'Jean')));
  await p.evaluate(() => { C.employees.find(e => e.id === 'demo-e0').remote_punch_enabled = false; renderEmployees(); });
  ok('portal access without the grant reads Portal only', /Portal only/.test(await rowText(p, 'Marie')));
  await p.evaluate(() => { toggleEmpSelect('demo-e1', true); }); await sleep(200);
  ok('the bulk bar offers Invite to phone clock-in', await p.evaluate(() => [...document.querySelectorAll('button')].some(b => b.offsetParent && /Invite to phone clock-in/.test(b.innerText))));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── Phone clock-in window ───────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => navigate('admin')); await sleep(700);
  ok('the sidebar has a Phone clock-in entry', await p.evaluate(() => [...document.querySelectorAll('#sideNav .sn-item')].some(b => /Phone clock-in/.test(b.innerText))));
  await p.evaluate(() => openPhoneSetup()); await sleep(800);
  const m = await p.evaluate(() => ({ open: document.getElementById('phoneSetupModal').classList.contains('open'), boxes: document.querySelectorAll('#phoneSetupBody .ph-cb').length, selects: document.querySelectorAll('#phoneSetupBody select:not(.invite-lang)').length, dis: document.getElementById('phSendBtn').disabled }));
  ok('opens with a checkbox per person who is not set up yet, one rule per site, and nothing to send', m.open && m.boxes === 5 && m.selects === 2 && m.dis, JSON.stringify(m));
  await p.evaluate(() => document.getElementById('ph-cb-demo-e2').click());
  await p.fill('#ph-em-demo-e2', 'sofia.ricci@example.com');
  ok('one person ticked with an email: Send 1', (await p.evaluate(() => document.getElementById('phSendBtn').innerText)) === 'Send 1 invitation(s)');
  await p.fill('#ph-em-demo-e2', 'not an email');
  ok('a bad email does not count', (await p.evaluate(() => document.getElementById('phSendBtn').innerText)) === 'Send 0 invitation(s)');
  await p.fill('#ph-em-demo-e2', 'sofia.ricci@example.com');
  await p.evaluate(() => { document.getElementById('ph-cb-demo-e1').click(); document.getElementById('ph-cb-demo-e3').click(); });
  ok('three ready', (await p.evaluate(() => document.getElementById('phSendBtn').innerText)) === 'Send 3 invitation(s)');
  await p.selectOption('#ph-site-demo-s2', 'req'); await sleep(200);
  ok('"Anywhere, location required" is saved on the site', await p.evaluate(() => C.sites.find(s => s.id === 'demo-s2').geo_strict === true));
  await p.click('#phSendBtn'); await sleep(500);
  ok('sending asks for confirmation first', await p.evaluate(() => /anywhere, on any device/.test(document.body.innerText)));
  await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
  const after = await p.evaluate(() => ({ msg: (document.querySelector('#phoneSetupBody [role=status]') || {}).innerText || '', e2: C.employees.find(e => e.id === 'demo-e2'), portal: (window._demoPortal || []).map(x => x.employee_id + ':' + x.status).join(','), co: C.companies[0].remote_punch_enabled }));
  ok('three invitations sent', /3 invitation/.test(after.msg), after.msg);
  ok('the typed email and the remote grant were saved', after.e2.email === 'sofia.ricci@example.com' && after.e2.remote_punch_enabled === true);
  ok('each invitee has an invited portal row, and Marie stays active', /demo-e1:invited/.test(after.portal) && /demo-e2:invited/.test(after.portal) && /demo-e3:invited/.test(after.portal) && /demo-e0:active/.test(after.portal), after.portal);
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── When the hourly email limit is reached ───────');
{
  const LIMIT = 'Too many emails sent in the last hour. Please try again later.';
  // First window: Send stops at the first refusal, keeps the message, and leaves the rest ticked.
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => navigate('admin')); await sleep(700);
  await p.evaluate(() => { window._mailCalls = 0; sendAppEmail = async () => { window._mailCalls++; if (window._mailCalls === 2) { const e = new Error('Too many emails sent in the last hour. Please try again later.'); e._raw = '{"ok":false}'; throw e; } return { ok: true }; }; });
  await p.evaluate(() => { for (const id of ['demo-e1', 'demo-e3', 'demo-e4']) { const e = C.employees.find(x => x.id === id); if (!e.email) e.email = id + '@example.com'; } });
  await p.evaluate(() => openPhoneSetup()); await sleep(900);
  await p.evaluate(() => { for (const id of ['demo-e1', 'demo-e3', 'demo-e4']) document.getElementById('ph-cb-' + id).click(); });
  await p.click('#phSendBtn'); await sleep(500);
  await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
  const r = await p.evaluate(() => ({ msg: (document.querySelector('#phoneSetupBody [role=status]') || {}).innerText || '', calls: window._mailCalls, ticked: [..._phSel].sort().join(','), row4: (window._demoPortal || []).some(x => x.employee_id === 'demo-e4') }));
  ok('the first invitation goes out', /1 invitation\(s\) sent/.test(r.msg), r.msg);
  ok('the failure keeps its reason on screen', r.msg.includes(LIMIT) && /1 could not be sent/.test(r.msg), r.msg);
  ok('it says the run stopped, and why', /Stopped: the hourly limit/.test(r.msg));
  ok('nothing further is attempted after the limit', r.calls === 2 && !r.row4, JSON.stringify({ calls: r.calls, row4: r.row4 }));
  ok('the person who failed and the person not reached stay ticked', r.ticked === 'demo-e3,demo-e4', r.ticked);
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}
{
  // The bulk bar: how many went out before it stopped, and why.
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => navigate('admin')); await sleep(700);
  await p.evaluate(() => {
    window._mailCalls = 0;
    sendAppEmail = async () => { window._mailCalls++; if (window._mailCalls === 2) throw new Error('Too many emails sent in the last hour. Please try again later.'); return { ok: true }; };
    for (const id of ['demo-e1', 'demo-e3', 'demo-e4']) { const e = C.employees.find(x => x.id === id); if (!e.email) e.email = id + '@example.com'; toggleEmpSelect(id, true); }
  });
  await p.evaluate(() => { bulkInvitePhone(); }); await sleep(600);
  await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
  const r = await p.evaluate(() => ({ toast: document.body.innerText, calls: window._mailCalls }));
  ok('the bulk invite says how many went out and why it stopped', /1 invitation\(s\) sent before it stopped: Too many emails sent in the last hour/.test(r.toast));
  ok('and stops there', r.calls === 2, String(r.calls));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── Mid-width screens: tables are reachable ──────');
{
  // 800 to 1,250 px with the sidebar open is where a 966 px table is wider than its box. The right-hand columns
  // (Phone, Status, Actions) must be reachable by scrolling, never cut off.
  for (const W of [800, 900, 1100, 1250]) {
    const p = await demoPage(W, 800, 'en');
    for (const pg of ['admin', 'activity', 'reports', 'timeoff']) {
      await p.evaluate(x => navigate(x), pg); await sleep(900);
      if (pg === 'reports') { await p.evaluate(() => { try { generateReport(); } catch (e) {} }); await sleep(900); }
      const r = await p.evaluate(() => {
        const wraps = [...document.querySelectorAll('.page.active .table-wrap')].filter(w => w.offsetParent !== null && w.querySelector('table') && w.querySelector('table').offsetParent !== null);
        return wraps.map(w => {
          const t = w.querySelector('table'); const over = t.getBoundingClientRect().width > w.clientWidth + 1;
          const ox = getComputedStyle(w).overflowX;
          w.scrollLeft = w.scrollWidth;
          const ths = [...t.querySelectorAll('thead th')]; const last = ths[ths.length - 1].getBoundingClientRect(); const box = w.getBoundingClientRect();
          return { over, ox, lastReachable: last.right <= box.right + 1 };
        });
      });
      ok(`${W} px, ${pg}: every column can be reached`, r.length === 0 || r.every(x => x.lastReachable && (!x.over || /auto|scroll/.test(x.ox))), JSON.stringify(r));
    }
    await p.evaluate(() => navigate('admin')); await sleep(600);
    const emp = await p.evaluate(() => { const w = document.querySelector('#tab-employees .table-wrap'); w.scrollLeft = w.scrollWidth; const b = [...document.querySelectorAll('#empTableBody tr:first-child .icon-btn')].map(x => x.getBoundingClientRect().right); return { editVisible: b.length > 0 && Math.max(...b) <= w.getBoundingClientRect().right + 1, phone: !!document.querySelector('#empTableBody .ph-cell') }; });
    ok(`${W} px: the Employees Actions buttons can be scrolled into view`, emp.editVisible, JSON.stringify(emp));
    if (W === 900) ok('900 px: the Employees table really is wider than its box here (so the checks above are not vacuous)', await p.evaluate(() => { const w = document.querySelector('#tab-employees .table-wrap'); return w.querySelector('table').getBoundingClientRect().width > w.clientWidth + 1; }));
    ok(`${W} px: no page errors`, p._errs.length === 0, p._errs.join(' / '));
    await p.context().close();
  }
}

console.log('\n── Phone menu entry ─────────────────────────────');
{
  const p = await demoPage(390, 844, 'en');
  const r = await p.evaluate(() => { const d = id => getComputedStyle(document.getElementById(id)).display; return { phone: d('mobileNavPhone'), sites: d('mobileNavCompanies'), sched: d('mobileNavSchedule') }; });
  ok('Phone clock-in is a flex row like the other entries', r.phone === 'flex' && r.sites === 'flex', JSON.stringify(r));
  await p.evaluate(() => { document.body.classList.remove('role-admin'); document.body.classList.add('role-manager'); });   // a manager: no entry at all
  ok('and a manager does not get it', await p.evaluate(() => getComputedStyle(document.getElementById('mobileNavPhone')).display === 'none'));
  await p.context().close();
}

console.log('\n── Hidden until phone clock-in is in use ────────');
// An owner who never asked for it must not see it: no Team menu entry, no phone-menu entry, no Phone column, no bulk
// button, no card line. It appears when the company switch is on, someone was granted it, or the owner said their
// team clocks in on phones; the way in is Company Info > Remote Access > Set up phone clock-in.
{
  const shown = p => p.evaluate(() => {
    const d = el => !!el && getComputedStyle(el).display !== 'none';
    const th = document.querySelector('#tab-employees thead th.ph-col'), td = document.querySelector('#empTableBody td.ph-col');
    return { on: document.body.classList.contains('phone-on'), side: d([...document.querySelectorAll('#sideNav .sn-item')].find(b => /openPhoneSetup/.test(b.getAttribute('onclick') || ''))),
             menu: d(document.getElementById('mobileNavPhone')), th: d(th), td: d(td), bulk: d(document.querySelector('.ph-bulk')), card: d(document.querySelector('#empCardsContainer .ph-card')) };
  });
  const off = p => p.evaluate(() => { C.companies.forEach(c => { c.remote_punch_enabled = false; }); const x = Ctx.get(); if (x && x.co) { x.co.remote_punch_enabled = false; Ctx.set(x); } C.employees.forEach(e => { e.remote_punch_enabled = false; }); try { localStorage.removeItem('pc_setup_mode'); } catch (e) {} navigate('admin'); });
  const p = await demoPage(1440, 900, 'en');
  await off(p); await sleep(900);
  let v = await shown(p);
  ok('not in use: nothing about phone clock-in is shown (menu, column, bulk button, card line)', !v.on && !v.side && !v.menu && !v.th && !v.td && !v.bulk && !v.card, JSON.stringify(v));
  ok('not in use: the Employees list has no "Phone" word in its header', !(await p.evaluate(() => [...document.querySelectorAll('#tab-employees thead th')].filter(t => getComputedStyle(t).display !== 'none').some(t => /Phone/i.test(t.innerText)))));
  // the way in
  await p.evaluate(() => editCompany(C.companies[0].id)); await sleep(600);
  ok('Company Info offers "Set up phone clock-in" next to Remote Access', await p.evaluate(() => { const r = document.getElementById('remotePunchSetupRow'); return !!r && getComputedStyle(r).display !== 'none' && /Set up phone clock-in/.test(r.innerText); }));
  await p.evaluate(() => document.querySelector('#remotePunchSetupRow button').click()); await sleep(700);
  ok('and it opens the window (and closes Company Info)', await p.evaluate(() => document.getElementById('phoneSetupModal').classList.contains('open') && !document.getElementById('addCompanyModal').classList.contains('open')));
  // sending turns it on, and the entries appear
  await p.evaluate(() => { const e = C.employees.find(x => x.id === 'demo-e1'); if (!e.email) e.email = 'david.pham@example.com'; renderPhoneSetup(); document.getElementById('ph-cb-demo-e1').click(); });
  await p.click('#phSendBtn'); await sleep(500);
  await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
  v = await shown(p);
  ok('after the first invitations are sent it is in use: the entries and the Phone column appear', v.on && v.side && v.th && v.td, JSON.stringify(v));
  await p.context().close();
}
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { C.companies.forEach(c => { c.remote_punch_enabled = false; }); const x = Ctx.get(); if (x && x.co) { x.co.remote_punch_enabled = false; Ctx.set(x); } C.employees.forEach(e => { e.remote_punch_enabled = false; }); try { localStorage.removeItem('pc_setup_mode'); } catch (e) {} navigate('admin'); });
  await sleep(700);
  ok('"their own phones" in the first-run question turns it on', await p.evaluate(() => { setSetupMode('phones'); return document.body.classList.contains('phone-on'); }));
  ok('"a tablet at the door" does not', await p.evaluate(() => { setSetupMode('tablet'); return !document.body.classList.contains('phone-on'); }));
  ok('"both" turns it on', await p.evaluate(() => { setSetupMode('both'); return document.body.classList.contains('phone-on'); }));
  ok('one granted employee is enough', await p.evaluate(() => { setSetupMode(''); const hidden = !document.body.classList.contains('phone-on'); C.employees[0].remote_punch_enabled = true; syncPhoneFeature(); return hidden && document.body.classList.contains('phone-on'); }));
  ok('a manager never gets the menu entry, even when it is in use', await p.evaluate(() => { document.body.classList.add('role-manager'); const side = getComputedStyle([...document.querySelectorAll('#sideNav .sn-item')].find(b => /openPhoneSetup/.test(b.getAttribute('onclick') || ''))).display; const menu = getComputedStyle(document.getElementById('mobileNavPhone')).display; document.body.classList.remove('role-manager'); return side === 'none' && menu === 'none'; }));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}
{
  const p = await demoPage(390, 844, 'en');
  await p.evaluate(() => { C.companies.forEach(c => { c.remote_punch_enabled = false; }); const x = Ctx.get(); if (x && x.co) { x.co.remote_punch_enabled = false; Ctx.set(x); } C.employees.forEach(e => { e.remote_punch_enabled = false; }); try { localStorage.removeItem('pc_setup_mode'); } catch (e) {} navigate('admin'); });
  await sleep(900);
  const r = await p.evaluate(() => ({ menu: getComputedStyle(document.getElementById('mobileNavPhone')).display, cards: document.querySelectorAll('#empCardsContainer .ph-card').length, cardShown: [...document.querySelectorAll('#empCardsContainer .ph-card')].some(c => getComputedStyle(c).display !== 'none') }));
  ok('on a phone, not in use: no menu entry and no Phone line on the employee cards', r.menu === 'none' && r.cards > 0 && !r.cardShown, JSON.stringify(r));
  await p.context().close();
}

console.log('\n── A manager, and the company switch ────────────');
// Turning a company's Remote Access switch on is the owner's. A manager who presses Invite or Allow with it off gets a
// plain sentence, and no write to companies is even attempted; with it on they can still invite and grant.
{
  const ASK = 'Ask the account owner to turn it on.';
  const setup = (p, switchOn) => p.evaluate(on => {
    C.companies.forEach(c => { c.remote_punch_enabled = on; }); const x = Ctx.get(); if (x && x.co) { x.co.remote_punch_enabled = on; Ctx.set(x); }
    C.employees.forEach(e => { e.remote_punch_enabled = false; });
    for (const id of ['demo-e1', 'demo-e3']) { const e = C.employees.find(q => q.id === id); if (!e.email) e.email = id + '@example.com'; }
    window._calls = []; const orig = DB.update; DB.update = async (t, f, b) => { window._calls.push(t); return orig(t, f, b); };
    Sess.get = () => ({ id: 'm1', name: 'Mgr', email: 'm@example.com', role: 'manager', plan: 'business' }); document.body.classList.add('role-manager'); navigate('admin');   // a signed-in manager (the real isManager() reads the session)
  }, switchOn);
  {
    const p = await demoPage(1440, 900, 'en');
    await setup(p, false); await sleep(800);
    await p.evaluate(() => { toggleEmpSelect('demo-e1', true); }); await p.evaluate(() => { bulkInvitePhone(); }); await sleep(600);
    const r = await p.evaluate(() => ({ text: document.body.innerText, dialog: document.getElementById('uiDialog') && document.getElementById('uiDialog').classList.contains('open'), calls: window._calls.join(',') }));
    ok('manager, switch off, bulk invite: a plain message, no confirmation, no write to companies', r.text.includes(ASK) && !r.dialog && !/companies/.test(r.calls), JSON.stringify({ dialog: r.dialog, calls: r.calls }));
    await p.evaluate(() => { _portalMap = _portalMap || {}; _portalMap['demo-e0'] = { employee_id: 'demo-e0', status: 'active' }; allowPhoneClockIn('demo-e0'); }); await sleep(500);
    const a = await p.evaluate(() => ({ modal: document.getElementById('phoneSetupModal').classList.contains('open'), text: document.body.innerText, calls: window._calls.join(',') }));
    ok('manager, switch off, Allow clock-in: the same plain message, not "no permission"', a.text.includes(ASK) && !a.modal && !/companies/.test(a.calls) && !/permission/i.test(a.text.replace(ASK, '')), JSON.stringify({ modal: a.modal, calls: a.calls }));
    ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
    await p.context().close();
  }
  {
    const p = await demoPage(1440, 900, 'en');
    await setup(p, true); await sleep(800);
    await p.evaluate(() => { toggleEmpSelect('demo-e1', true); toggleEmpSelect('demo-e3', true); bulkInvitePhone(); }); await sleep(600);
    await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
    const r = await p.evaluate(() => ({ text: document.body.innerText, calls: window._calls.join(','), granted: C.employees.filter(e => e.remote_punch_enabled).map(e => e.id).sort().join(',') }));
    ok('manager, switch on: the invitations go through and the grants are written', /2 invitation\(s\) sent/.test(r.text) && r.granted === 'demo-e1,demo-e3', JSON.stringify({ granted: r.granted }));
    ok('and no write to companies is attempted', !/companies/.test(r.calls), r.calls);
    await p.context().close();
  }
}

console.log('\n── Several companies ───────────────────────────');
// Everyone is listed together, and the company selected (or first) must not decide for the others: each person is
// judged by their own company's switch.
{
  const addSecond = p => p.evaluate(() => {
    Ctx.clear();
    const base = C.companies[0]; base.remote_punch_enabled = true;
    C.companies.push(Object.assign({}, base, { id: 'demo-co2', name: 'Second Co', remote_punch_enabled: false }));
    C.employees.push({ id: 'demo-x1', name: 'Zed Other', site_id: 'demo-s1', company_id: 'demo-co2', active: true, email: 'zed@example.com', remote_punch_enabled: true, pin: '9999', dept: '', emp_code: 'X1' });
    C.employees.push({ id: 'demo-x2', name: 'Yan Other', site_id: 'demo-s1', company_id: 'demo-co2', active: true, email: 'yan@example.com', remote_punch_enabled: false, pin: '9998', dept: '', emp_code: 'X2' });
    window._demoPortal.push({ id: 'pt-x1', employee_id: 'demo-x1', email: 'zed@example.com', status: 'active' });
    _portalMap = { 'demo-e0': { employee_id: 'demo-e0', status: 'active' }, 'demo-x1': { employee_id: 'demo-x1', status: 'active' } };
  });
  const p = await demoPage(1440, 900, 'en');
  await addSecond(p);
  const states = () => p.evaluate(() => ({ first: C.companies[0].name, e0: phoneState(C.employees.find(e => e.id === 'demo-e0')).k, x1: phoneState(C.employees.find(e => e.id === 'demo-x1')).k, feature: phoneFeatureOn() }));
  let st = await states();
  ok('the "on" company first: its employee can clock in, the other company\'s reads Portal only', st.e0 === 'can' && st.x1 === 'portal', JSON.stringify(st));
  await p.evaluate(() => { C.companies.reverse(); });
  st = await states();
  ok('and the same with the companies the other way round', st.e0 === 'can' && st.x1 === 'portal' && st.first === 'Second Co', JSON.stringify(st));
  ok('phone clock-in counts as in use when any company has the switch on, whichever is first', await p.evaluate(() => { C.employees.forEach(e => { e.remote_punch_enabled = false; }); try { localStorage.removeItem('pc_setup_mode'); } catch (e) {} return phoneFeatureOn(); }));
  // Allow clock-in for the "off" company's person opens the window for THAT company
  await p.evaluate(() => { _portalMap['demo-x2'] = { employee_id: 'demo-x2', status: 'active' }; allowPhoneClockIn('demo-x2'); }); await sleep(900);
  const w = await p.evaluate(() => ({ open: document.getElementById('phoneSetupModal').classList.contains('open'), text: document.getElementById('phoneSetupBody').innerText }));
  ok('Allow clock-in for the other company opens the window on that company, and names it', w.open && /Company: Second Co/.test(w.text) && /Yan Other/.test(w.text) && !/Aïsha/.test(w.text), w.text.slice(0, 120));
  await p.evaluate(() => closeModal('phoneSetupModal'));
  // Bulk invite across both companies turns on each switch that is off
  await p.evaluate(() => {
    C.companies.forEach(c => { c.remote_punch_enabled = false; });
    for (const id of ['demo-e1', 'demo-x2']) { const e = C.employees.find(q => q.id === id); if (!e.email) e.email = id + '@example.com'; toggleEmpSelect(id, true); }
    window._calls = []; const orig = DB.update; DB.update = async (t, f, b) => { window._calls.push(t + ':' + f); return orig(t, f, b); };
    bulkInvitePhone();
  }); await sleep(600);
  await p.locator('button', { hasText: /^Confirm$/ }).last().click(); await sleep(1500);
  const b = await p.evaluate(() => ({ calls: window._calls.filter(c => c.startsWith('companies')).join(' '), on: C.companies.map(c => c.remote_punch_enabled).join(',') }));
  ok('a bulk invite across two companies turns the switch on for each one that was off', /demo-co\b/.test(b.calls) && /demo-co2/.test(b.calls) && b.on === 'true,true', JSON.stringify(b));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── An invitation whose email fails ───────────────');
// The invitation row is written before the email (the server reads it). If the email does not go out, the row must be put
// back: no "Invited" for someone who got nothing, and an active account must not be knocked back to "invited".
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { const e = C.employees.find(x => x.id === 'demo-e3'); e.email = 'new.person@example.com'; sendAppEmail = async () => { throw new Error('Too many emails'); }; });
  const r1 = await p.evaluate(async () => {
    let msg = ''; try { await portalInviteCore('demo-e3', 'new.person@example.com'); } catch (e) { msg = e.message; }
    return { msg, rows: window._demoPortal.filter(x => x.employee_id === 'demo-e3').length, mapped: !!(_portalMap && _portalMap['demo-e3']) };
  });
  ok('new invitation, email fails: the error is raised and no portal row is left behind', r1.msg === 'Too many emails' && r1.rows === 0 && !r1.mapped, JSON.stringify(r1));
  const r2 = await p.evaluate(async () => {
    const row = window._demoPortal.find(x => x.employee_id === 'demo-e0'); const before = JSON.stringify(row);
    let msg = ''; try { await portalInviteCore('demo-e0', row.email); } catch (e) { msg = e.message; }
    const after = window._demoPortal.find(x => x.employee_id === 'demo-e0');
    return { msg, same: JSON.stringify(after) === before, status: after && after.status };
  });
  ok('re-invite of an active account, email fails: the account stays exactly as it was (still active)', r2.msg && r2.same && r2.status === 'active', JSON.stringify(r2));
  const r3 = await p.evaluate(async () => { sendAppEmail = async () => ({ ok: true }); await portalInviteCore('demo-e3', 'new.person@example.com'); return { rows: window._demoPortal.filter(x => x.employee_id === 'demo-e3').length, st: window._demoPortal.find(x => x.employee_id === 'demo-e3').status }; });
  ok('and when the email does go out, the row is written as invited', r3.rows === 1 && r3.st === 'invited', JSON.stringify(r3));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── Language of the invitation ───────────────────');
// An English-speaking admin often invites a French-speaking employee: the language is chosen when sending, and the
// set-password page (reached from the email) has its own EN/FR switch.
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { try { localStorage.removeItem('pc_invite_lang'); } catch (e) {} const e = C.employees.find(x => x.id === 'demo-e3'); e.email = 'lang.test@example.com'; e.send_report = true; window._sent = []; sendAppEmail = async (t, d) => { window._sent.push(Object.assign({ t }, d)); return { ok: true }; }; editEmployee('demo-e3'); });
  await sleep(1200);
  let r = await p.evaluate(() => { const sel = document.getElementById('empInviteLang'); return { has: !!sel, shown: !!sel && sel.offsetParent !== null, val: sel && sel.value, opts: sel && [...sel.options].map(o => o.text).join('/') }; });
  ok('Edit employee: an "Email language" choice sits beside the invitation button, English by default in an English screen', r.has && r.shown && r.val === 'en' && r.opts === 'English/Français', JSON.stringify(r));
  await p.evaluate(() => { const s = document.getElementById('empInviteLang'); s.value = 'fr'; s.dispatchEvent(new Event('change')); document.getElementById('empPortalInviteBtn').click(); });
  await sleep(800);
  r = await p.evaluate(() => ({ sent: window._sent.map(x => x.t + ':' + x.lang).join(','), stored: localStorage.getItem('pc_invite_lang') }));
  ok('choosing Français sends the invitation email in French (and remembers the choice)', r.sent === 'employee_invite:fr' && r.stored === 'fr', JSON.stringify(r));
  await p.evaluate(() => closeModal('empModal') || 0).catch(() => {});
  await p.context().close();
}
{
  const p = await demoPage(1440, 900, 'fr');
  await p.evaluate(() => { try { localStorage.removeItem('pc_invite_lang'); } catch (e) {} window._sent = []; sendAppEmail = async (t, d) => { window._sent.push(Object.assign({ t }, d)); return { ok: true }; }; });
  const r = await p.evaluate(() => inviteLang());
  ok('in a French screen the default is French', r === 'fr');
  await p.evaluate(() => { for (const id of ['demo-e3']) { const e = C.employees.find(q => q.id === id); e.email = 'lang.test@example.com'; } C.companies.forEach(c => { c.remote_punch_enabled = true; }); openPhoneSetup(); }); await sleep(900);
  const w = await p.evaluate(() => { renderPhoneSetup(); const s = document.getElementById('phInviteLang'); return { has: !!s, val: s && s.value }; });
  ok('the phone clock-in window has the same choice, French here', w.has && w.val === 'fr', JSON.stringify(w));
  await p.evaluate(() => { const s = document.getElementById('phInviteLang'); s.value = 'en'; s.dispatchEvent(new Event('change')); document.getElementById('ph-cb-demo-e3').click(); });
  await p.click('#phSendBtn'); await sleep(500);
  const txt = await p.evaluate(() => document.body.innerText);
  ok('the confirmation names the language the emails will be in', /Langue du courriel : English/.test(txt), txt.slice(txt.indexOf('Langue du courriel') - 20, txt.indexOf('Langue du courriel') + 60));
  await p.locator('button', { hasText: /^Confirmer$/ }).last().click(); await sleep(1500);
  const sent = await p.evaluate(() => window._sent.map(x => x.lang).join(','));
  ok('and that is the language that goes out (English, although the screen is French)', sent === 'en', sent);
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-CA' });
  await ctx.route(u => !u.href.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(u.href) && !u.href.startsWith('data:'), r => r.abort());
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'employee.html', { waitUntil: 'load' }); await sleep(800);
  await p.evaluate(() => { showScreen('screenSetPassword'); });
  const r = await p.evaluate(() => { const sw = document.querySelector('#screenSetPassword .lang-sw'); return { has: !!sw && sw.offsetParent !== null, title: document.getElementById('setPassTitle').innerText }; });
  ok('set-password page: an EN/FR switch is shown', r.has, JSON.stringify(r));
  await p.click('#screenSetPassword .lang-sw button[data-lang="fr"]'); await sleep(300);
  const f = await p.evaluate(() => ({ title: document.getElementById('setPassTitle').innerText, btn: document.getElementById('setPassBtn').innerText, active: document.querySelector('#screenSetPassword .lang-sw button.active').dataset.lang }));
  ok('pressing FR puts the whole page in French', /Bienvenue/.test(f.title) && f.active === 'fr', JSON.stringify(f));
  ok('no page errors', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

console.log('\n── Not on a paid plan ──────────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { window._demoMode = true; paidPreviewEndsAt = () => 0; getAdminPlan = () => PLANS.free; getCompanyPlan = () => PLANS.free; navigate('admin'); }); await sleep(900);
  ok('the list says Starter and up, with no invite buttons', /Starter and up/.test(await rowText(p, 'Marie')) && !/Invite|Resend/.test(await rowText(p, 'David')));
  await p.evaluate(() => openPhoneSetup()); await sleep(500);
  const txt = await p.evaluate(() => document.getElementById('phoneSetupBody').innerText);
  ok('the window explains it and offers the upgrade, with no send button', /Starter plan and above/.test(txt) && /Upgrade now/.test(txt) && !(await p.$('#phSendBtn')));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── How will your team clock in? ────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  await p.evaluate(() => { Sess.set({ id: 'x', name: 'Owner', email: 'o@example.com', plan: 'free', role: 'admin' }, false); C.punches = []; localStorage.removeItem('pc_setup_mode'); localStorage.removeItem('pc_setup_done'); navigate('dashboard'); }); await sleep(800);
  const text = () => p.evaluate(() => document.getElementById('setupChecklist').innerText);
  let q = await text();
  ok('a new account is asked, with three answers', /How will your team clock in\?/.test(q) && /A tablet at the door/.test(q) && /Their own phones/.test(q) && /Both/.test(q));
  await p.evaluate(() => setSetupMode('phones')); await sleep(300);
  q = await text();
  ok('phones: phone setup and a phone first punch, no tablet step', /Set up phone clock-in/.test(q) && /First clock-in from a phone/.test(q) && !/punch tablet/i.test(q));
  await p.evaluate(() => setSetupMode('both')); await sleep(300);
  q = await text();
  ok('both: tablet and phone steps', /punch tablet/i.test(q) && /Set up phone clock-in/.test(q) && /Try your first clock-in/.test(q));
  await p.evaluate(() => setSetupMode('tablet')); await sleep(300);
  q = await text();
  ok('tablet: unchanged from before', /punch tablet/i.test(q) && /Try your first clock-in/.test(q) && !/phone clock-in/i.test(q));
  await p.evaluate(() => setSetupMode('')); await sleep(300);
  ok('"Change how your team clocks in" brings the question back', /How will your team clock in\?/.test(await text()));
  await p.evaluate(() => { C.punches = [{ id: 'z', source: 'kiosk' }]; renderSetupChecklist(); });
  ok('an account that already has punches is not asked', !/How will your team clock in/.test(await text()));
  await p.evaluate(() => Sess.clear());
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── French, on a phone ──────────────────────────');
{
  const p = await demoPage(390, 844, 'fr');
  await p.evaluate(() => navigate('admin')); await sleep(800);
  ok('the Employees page does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.evaluate(() => openPhoneSetup()); await sleep(700);
  const fr = await p.evaluate(() => document.getElementById('phoneSetupModal').innerText);
  ok('the window is in French', /Pointage par téléphone/.test(fr) && /Qui peut pointer avec son téléphone/.test(fr) && /Courriel requis/.test(fr));
  ok('the plan is called Débutant in French, as everywhere else', await p.evaluate(() => TRANSLATIONS.fr['ph.lock'].includes('Débutant') && TRANSLATIONS.fr['ph.lockNote'].includes('Débutant') && !/Starter/.test(TRANSLATIONS.fr['ph.lock'] + TRANSLATIONS.fr['ph.lockNote'])));
  ok('and the help text names the real button', await p.evaluate(() => /Envoyer N invitation\(s\)/.test(TRANSLATIONS.fr['help.remoteDesc']) && /Send N invitation\(s\)/.test(TRANSLATIONS.en['help.remoteDesc']) && !/Envoyer les invitations|Send invitations/.test(TRANSLATIONS.fr['help.remoteDesc'] + TRANSLATIONS.en['help.remoteDesc'])));
  ok('and does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
