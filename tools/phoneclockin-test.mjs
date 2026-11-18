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
  const m = await p.evaluate(() => ({ open: document.getElementById('phoneSetupModal').classList.contains('open'), boxes: document.querySelectorAll('#phoneSetupBody .ph-cb').length, selects: document.querySelectorAll('#phoneSetupBody select').length, dis: document.getElementById('phSendBtn').disabled }));
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
