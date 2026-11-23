// Referral program: the pages (sign-up field, "Refer a business" panel, holiday banners) in index.html.
// The network is stubbed: nothing real is contacted, nothing is written. What the server does with these
// requests, and the money, is covered by tools/referral-test.mjs.
//   node tools/referral-ui-test.mjs [folder-for-screenshots]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = await new Promise((r) => {
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
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x !== '' ? '  -> ' + String(x).slice(0, 400) : ''}`); };
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) });
const browser = await chromium.launch();

// One page with every server call stubbed. `st.reply(action, body)` decides what secure-db answers.
async function open(query = '', { viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { });
  const page = await ctx.newPage();
  const st = { calls: [], errs: [], reply: () => null };
  page.on('pageerror', (e) => st.errs.push(e.message));
  await page.route('**/functions/v1/**', async (route) => {
    if (!route.request().url().endsWith('/secure-db')) return json(route, {});
    const b = JSON.parse(route.request().postData() || '{}'); st.calls.push(b);
    const r = b.action ? st.reply(b.action, b.body || {}) : null;
    if (r && r.__status) return json(route, r.body, r.__status);
    return json(route, r ?? (b.action ? { ok: true } : []));
  });
  await page.route('**/rest/v1/**', (route) => json(route, {}));
  await page.route('**/*.supabase.co/storage/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(`${BASE}/index.html${query}`, { waitUntil: 'networkidle' });
  return { page, st, ctx };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') }); };
const refCalls = (st) => st.calls.filter((c) => /^referral_/.test(c.action || ''));
// Fill the sign-up form and run both steps with the account creation itself stubbed.
async function register(page, code) {
  return page.evaluate(async (code) => {
    navigate('register');
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('regFirstName', 'Jane'); set('regLastName', 'Smith'); set('regEmail', 'jane@example.test'); set('regPass', 'secret123'); set('regCompany', 'Acme Corp');
    if (code !== undefined) set('regReferral', code);
    let codeRequests = 0;
    DB.requestRegistrationCode = async () => { codeRequests++; return { ok: true }; };
    await doRegister();
    const step2 = document.getElementById('regStep2').style.display !== 'none';
    const msg1 = document.getElementById('registerMsg').innerText;
    if (!step2) return { step2, msg1, codeRequests };
    DB.rpc = async () => ({ ok: true, id: 'a1', name: 'Jane Smith', email: 'jane@example.test', company: null });
    window._mintSessionToken = async () => 'tok-new';
    DB.update = async () => []; window.sendAppEmail = async () => { }; window.refreshCache = async () => { };
    document.getElementById('codeInput').value = '123456';
    let threw = null;
    try { await doVerify(); } catch (e) { threw = String(e); }
    return { step2, msg1, codeRequests, threw, signedIn: !!Sess.get(), msg2: document.getElementById('registerMsg').innerText, note: window._referralNote || null };
  }, code);
}
const OWNER = { id: 'a1', name: 'Olivia Owner', email: 'o@x.ca', role: 'admin', plan: 'starter', token: 'tok-admin' };
const MGR = { id: 'a2', name: 'Mia', email: 'm@x.ca', role: 'manager', plan: 'free', parent_admin_id: 'a1', token: 'tok-mgr' };
// A company is put in the page's cache so the first-run "create your company" window stays out of the way.
const signIn = (page, sess) => page.evaluate((s) => { Sess.set(s, false); C.companies = [{ id: 'c1', name: 'Acme', admin_id: 'a1' }]; hideLanding(); updateNav(); }, sess);
const INFO = {
  ok: true, code: 'ABCD2345', is_owner: true, on_free_plan: false,
  promo: { open: true, starts_at: '2026-12-01T05:00:00Z', ends_at: '2027-01-01T05:00:00Z', discount_percent: 10, reward_cents: 1949, currency: 'cad' },
  referred: { pending: 2, first_paid: 1, completed: 1 }, credit: { delivered_cents: 2924, waiting_cents: 0 }, mine: null, can_enter: false,
};
const visible = (page, id) => page.evaluate((id) => { const e = document.getElementById(id); return !!e && e.style.display !== 'none' && e.offsetParent !== null; }, id);
const panelText = (page) => page.evaluate(() => document.getElementById('referBody').innerText);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('── as shipped (switch on, before 1 December 2026): nothing of the program shows ──');
{
  const { page, st, ctx } = await open();
  ok('the page ships switched on, and it is still before 1 December', await page.evaluate(() => REFERRAL_PROMO.on === true && Date.now() < REFERRAL_PROMO.start));
  ok('no banner on the home page', !(await visible(page, 'referralLandBanner')));
  await page.evaluate(() => navigate('register'));
  ok('no referral field on the sign-up form', !(await visible(page, 'regReferralGroup')));
  const r = await register(page, 'ABCD2345');
  ok('sign-up works and sends nothing about referrals, even with a value forced into the hidden field', r.step2 && r.signedIn && !r.threw && refCalls(st).length === 0, JSON.stringify(r));
  await signIn(page, OWNER);
  ok('no menu entry', await page.evaluate(() => document.getElementById('ddReferBtn').style.display === 'none'));
  await page.evaluate(() => renderDashboard());
  ok('no banner on the dashboard', !(await visible(page, 'referralDashBanner')));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}

console.log('\n── the dates (with the page switch on) ──');
{
  const { page, ctx } = await open();
  const at = (iso, fn) => page.evaluate(([iso, fn]) => { REFERRAL_PROMO.on = true; return window[fn](Date.parse(iso)); }, [iso, fn]);
  ok('30 Nov 2026 23:59 Toronto: closed', (await at('2026-11-30T23:59:59-05:00', 'referralOpen')) === false);
  ok('1 Dec 2026 00:00 Toronto: open', (await at('2026-12-01T00:00:00-05:00', 'referralOpen')) === true);
  ok('31 Dec 2026 23:59 Toronto: open', (await at('2026-12-31T23:59:59-05:00', 'referralOpen')) === true);
  ok('1 Jan 2027 00:00 Toronto: closed', (await at('2027-01-01T00:00:00-05:00', 'referralOpen')) === false);
  ok('the panel stays in the menu in February 2027', (await at('2027-02-15T12:00:00-05:00', 'referralPanelOn')) === true);
  ok('and leaves it on 1 May 2027', (await at('2027-05-01T00:00:00-04:00', 'referralPanelOn')) === false);
  ok('today (before 1 December) the switch alone shows nothing', Date.now() >= Date.parse('2026-12-01T05:00:00Z') || (await page.evaluate(() => { REFERRAL_PROMO.on = true; return referralOpen() === false && referralPanelOn() === false; })));
  await ctx.close();
}

for (const lang of ['en', 'fr']) {
  console.log(`\n── sign-up field (${lang.toUpperCase()}) ──`);
  const { page, st, ctx } = await open('?referral=1');
  await page.evaluate((l) => setLang(l), lang);
  await page.evaluate(() => { hideLanding(); navigate('register'); });
  ok('the field is on the form', await visible(page, 'regReferralGroup'));
  const label = await page.evaluate(() => document.querySelector('label[for="regReferral"]').innerText + ' | ' + document.querySelector('#regReferralGroup p').innerText);
  ok('label and help are translated', lang === 'fr' ? /Code de parrainage \(facultatif\)/.test(label) && /10 % de rabais/.test(label) : /Referral code \(optional\)/.test(label) && /10% off/.test(label), label);
  if (lang === 'en') await shot(page, 'signup-en'); else await shot(page, 'signup-fr');

  let r = await register(page, '');
  ok('left empty: sign-up as usual, no referral call', r.step2 && r.signedIn && refCalls(st).length === 0, JSON.stringify(r));
  await ctx.close();

  { const o = await open('?referral=1'); await o.page.evaluate((l) => { setLang(l); hideLanding(); }, lang);
    r = await register(o.page, 'ABC');
    ok('a code of the wrong shape stops before the verification email', !r.step2 && r.codeRequests === 0 && (lang === 'fr' ? /n'est pas valide/ : /not valid/).test(r.msg1) && refCalls(o.st).length === 0, JSON.stringify(r));
    await o.ctx.close(); }
  { const o = await open('?referral=1'); await o.page.evaluate((l) => { setLang(l); hideLanding(); }, lang);
    o.st.reply = (a) => a === 'referral_check' ? { ok: true, open: true, valid: false } : null;
    r = await register(o.page, 'ZZZZ2222');
    ok('a code the server does not know stops too', !r.step2 && r.codeRequests === 0 && refCalls(o.st).length === 1, JSON.stringify(r));
    await o.ctx.close(); }
  { const o = await open('?referral=1'); await o.page.evaluate((l) => { setLang(l); hideLanding(); }, lang);
    o.st.reply = (a) => a === 'referral_check' ? { ok: true, open: true, valid: true } : a === 'referral_apply' ? { ok: true, discount_percent: 10 } : null;
    r = await register(o.page, ' abcd-2345 ');
    const calls = refCalls(o.st);
    ok('a valid code is checked, then attached with the new account\'s session', r.step2 && r.signedIn && calls.length === 2 && calls[0].action === 'referral_check' && calls[0].body.code === 'ABCD2345' && !calls[0].sessionToken
      && calls[1].action === 'referral_apply' && calls[1].body.code === 'ABCD2345' && calls[1].sessionToken === 'tok-new', JSON.stringify(calls));
    ok('the new owner is told the discount is on', (lang === 'fr' ? /10 % de rabais/ : /10% off/).test(r.note || ''), r.note);
    ok('no page errors', o.st.errs.length === 0, o.st.errs.join(' / '));
    await o.ctx.close(); }
  { const o = await open('?referral=1'); await o.page.evaluate((l) => { setLang(l); hideLanding(); }, lang);
    o.st.reply = (a) => a === 'referral_check' ? { __status: 500, body: { error: 'x' } } : a === 'referral_apply' ? { __status: 503, body: { error: 'x' } } : null;
    r = await register(o.page, 'ABCD2345');
    ok('referral calls failing never cost a sign-up', r.step2 && r.signedIn && !r.threw && (lang === 'fr' ? /n'a pas pu être appliqué/ : /could not be applied/).test(r.note || ''), JSON.stringify(r));
    await o.ctx.close(); }
  { const o = await open('?referral=1'); await o.page.evaluate((l) => { setLang(l); hideLanding(); }, lang);
    o.st.reply = (a) => a === 'referral_check' ? { ok: true, open: true, valid: true } : a === 'referral_apply' ? { ok: false, code: 'same_domain' } : null;
    r = await register(o.page, 'ABCD2345');
    ok('a code the server refuses at the last step: account created, owner told', r.signedIn && !r.threw && !!r.note && !(lang === 'fr' ? /appliqué :/ : /applied:/).test(r.note), JSON.stringify(r));
    await o.ctx.close(); }
}

console.log('\n── sign-up link ──');
{
  const { page, ctx } = await open('?referral=1&ref=abcd2345');
  await page.evaluate(() => { hideLanding(); navigate('register'); });
  ok('?ref=CODE pre-fills the field', await page.evaluate(() => document.getElementById('regReferral').value === 'ABCD2345'));
  await ctx.close();
  const o = await open('?referral=1&ref=%3Cscript%3Ealert(1)%3C/script%3E');
  await o.page.evaluate(() => { hideLanding(); navigate('register'); });
  ok('a hostile ?ref= value is ignored', await o.page.evaluate(() => document.getElementById('regReferral').value === '' && localStorage.getItem('pc_ref_code') === null) && o.st.errs.length === 0);
  await o.ctx.close();
}

console.log('\n── the "Refer a business" panel ──');
{
  const { page, st, ctx } = await open('?referral=1');
  st.reply = (a) => a === 'referral_info' ? INFO : null;
  await signIn(page, OWNER);
  ok('owner: the menu entry is there', await page.evaluate(() => document.getElementById('ddReferBtn').style.display !== 'none'));
  await page.evaluate(() => openRefer()); await page.waitForSelector('#referCode');
  let txt = await panelText(page);
  ok('the code is shown', await page.evaluate(() => document.getElementById('referCode').value === 'ABCD2345'));
  ok('it says what each side gets', /10% off their first paid month/.test(txt) && /\$19\.49 credit/.test(txt), txt);
  ok('it says exactly how and when the referrer is paid', /\$9\.75 when the business you referred pays for its first month/.test(txt) && /\$9\.74 when it pays for its second month/.test(txt) && /comes off your next PunchClock Crew invoice automatically/.test(txt), txt);
  ok('the totals', /Signed up, not paying yet\s*2/.test(txt) && /First month paid\s*1/.test(txt) && /Two months paid\s*1/.test(txt) && /Credit added to your account\s*\$29\.24/.test(txt), txt);
  ok('the conditions are one click away', await page.evaluate(() => /no cash value/.test(document.querySelector('#referBody details').textContent) && /section 4/.test(document.querySelector('#referBody details').textContent)));
  ok('the cap of 10 is stated under the code and in the conditions', /up to 10 referred businesses/.test(txt) && await page.evaluate(() => /at most 10 referred accounts/.test(document.querySelector('#referBody details').textContent)));
  await shot(page, 'panel-en');
  await page.click('#referBody button.btn-primary');
  ok('Copy code puts the code on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === 'ABCD2345');
  await page.click('#referBody button.btn-secondary');
  ok('Copy sign-up link puts the link on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === 'https://www.punchclock.ca/?ref=ABCD2345');
  ok('a paying referrer is not shown the Free plan note or the code box', !/Free plan/.test(txt) && !(await page.$('#referEnter')));

  st.reply = (a) => a === 'referral_info' ? { ...INFO, on_free_plan: true, referred: { pending: 0, first_paid: 0, completed: 0 }, credit: { delivered_cents: 0, waiting_cents: 975, waiting_first_expires_at: '2027-12-03T15:00:00Z' } } : null;
  await page.evaluate(() => loadRefer()); await page.waitForFunction(() => /Free plan/.test(document.getElementById('referBody').innerText));
  txt = await panelText(page);
  ok('a referrer on Free is told the credit waits for their upgrade', /kept and applied when you move to a paid plan, within 12 months/.test(txt) && /Credit waiting for your upgrade\s*\$9\.75/.test(txt), txt);
  ok('and when the oldest waiting credit expires', /expires on December 3, 2027/.test(txt), txt);

  await page.evaluate(() => { setLang('fr'); renderRefer(); });
  txt = await panelText(page);
  ok('French: amounts and wording', /crédit de 19,49 \$/.test(txt) && /9,75 \$ lorsque l'entreprise recommandée paie son premier mois/.test(txt) && /9,74 \$ lorsqu'elle paie son deuxième mois/.test(txt) && /forfait Gratuit/.test(txt) && /au plus 10 entreprises recommandées/.test(txt) && /expire le 3 décembre 2027/.test(txt), txt);
  await shot(page, 'panel-fr');
  await page.evaluate(() => setLang('en'));

  st.reply = (a) => a === 'referral_info' ? { ...INFO, code: '<img src=x onerror=window.__xss=1>' } : null;
  await page.evaluate(() => loadRefer()); await page.waitForTimeout(250);
  ok('a code of the wrong shape from the server is not drawn', /Could not load/.test(await panelText(page)) && await page.evaluate(() => !window.__xss));
  st.reply = () => ({ __status: 500, body: { error: 'x' } });
  await page.evaluate(() => loadRefer()); await page.waitForTimeout(250);
  ok('a server error shows a plain message', /Could not load/.test(await panelText(page)));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}
{
  // a new account that has not entered a code yet
  const { page, st, ctx } = await open('?referral=1');
  let applied = false;
  st.reply = (a, b) => a === 'referral_info' ? { ...INFO, on_free_plan: true, referred: { pending: 0, first_paid: 0, completed: 0 }, credit: { delivered_cents: 0, waiting_cents: 0 }, can_enter: !applied, mine: applied ? { status: 'pending', discount_used: false } : null }
    : a === 'referral_apply' ? (b.code === 'SAMEDMN2' ? { ok: false, code: 'same_domain' } : (applied = true, { ok: true })) : null;
  await signIn(page, { ...OWNER, plan: 'free' });
  await page.evaluate(() => openRefer()); await page.waitForSelector('#referEnter');
  ok('nobody referred yet: says so', /Nobody has used your code yet/.test(await panelText(page)));
  await page.fill('#referEnter', 'nope'); await page.click('#referEnter + button'); await page.waitForTimeout(150);
  ok('a wrong shape is refused on the page, nothing sent', /not valid/.test(await panelText(page)) && !st.calls.some((c) => c.action === 'referral_apply'));
  await page.fill('#referEnter', 'SAMEDMN2'); await page.click('#referEnter + button'); await page.waitForFunction(() => /own organisation/.test(document.getElementById('referBody').innerText));
  ok('the server\'s reason is explained (same organisation)', true);
  await page.fill('#referEnter', 'wxyz-6789'); await page.click('#referEnter + button'); await page.waitForFunction(() => !document.getElementById('referEnter'));
  const sent = st.calls.filter((c) => c.action === 'referral_apply').pop();
  ok('a good code is sent with the session, then the panel shows the discount', sent.body.code === 'WXYZ6789' && sent.sessionToken === 'tok-admin' && /10% off your first paid month, applied automatically at checkout/.test(await panelText(page)));
  await ctx.close();
}
{
  const { page, st, ctx } = await open('?referral=1');
  st.reply = (a) => a === 'referral_info' ? INFO : null;
  await signIn(page, MGR);
  ok('a manager has no menu entry', await page.evaluate(() => document.getElementById('ddReferBtn').style.display === 'none'));
  await page.evaluate(() => openRefer()); await page.waitForTimeout(150);
  ok('and cannot open the panel', await page.evaluate(() => !document.getElementById('referModal').classList.contains('open')) && !st.calls.some((c) => c.action === 'referral_info'));
  await page.evaluate(() => renderDashboard());
  ok('nor see the dashboard banner', !(await visible(page, 'referralDashBanner')));
  await ctx.close();
}

console.log('\n── holiday banners ──');
for (const lang of ['en', 'fr']) {
  const { page, st, ctx } = await open('?referral=1' + (lang === 'fr' ? '&lang=fr' : ''));
  await page.evaluate((l) => { setLang(l); showLanding(); }, lang);
  ok(`${lang}: the home page shows the banner`, await visible(page, 'referralLandBanner'));
  const txt = await page.evaluate(() => document.getElementById('referralLandBanner').innerText);
  ok(`${lang}: with the dates and the 10%`, lang === 'fr' ? /du 1er au 31 décembre/.test(txt) && /10 % de rabais/.test(txt) : /1 to 31 December/.test(txt) && /10% off/.test(txt), txt);
  await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'banner-home-' + lang);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  ok(`${lang}: the page does not scroll sideways`, wide);
  await page.click('#referralLandBanner .link-btn');
  ok(`${lang}: Hide removes it`, !(await visible(page, 'referralLandBanner')));
  await page.reload({ waitUntil: 'networkidle' });
  ok(`${lang}: and it stays hidden after a reload`, !(await visible(page, 'referralLandBanner')));
  st.reply = (a) => a === 'referral_info' ? INFO : null;
  await page.evaluate((l) => setLang(l), lang);
  await signIn(page, OWNER);
  await page.evaluate(() => { navigate('dashboard'); renderReferralBanners(); });
  ok(`${lang}: the dashboard shows its banner to the owner`, await visible(page, 'referralDashBanner'));
  const d = await page.evaluate(() => document.getElementById('referralDashBanner').innerText);
  ok(`${lang}: with the reward`, lang === 'fr' ? /crédit de 19,49 \$/.test(d) : /\$19\.49 credit/.test(d), d);
  await shot(page, 'banner-dash-' + lang);
  await page.click('#referralDashBanner .btn-primary'); await page.waitForSelector('#referCode');
  ok(`${lang}: its button opens the panel`, true);
  ok(`${lang}: no page errors`, st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}
{
  const { page, ctx } = await open('?referral=1', { viewport: { width: 375, height: 800 } });
  await page.evaluate(() => showLanding());
  ok('phone width: banner visible, no sideways scroll', (await visible(page, 'referralLandBanner')) && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot(page, 'banner-home-phone');
  await ctx.close();
}

console.log('\n── Terms 4.1 and the FAQ entry (owner-approved wording, 2026-11-20) ──');
{
  const { page, ctx } = await open();
  const faqHas30 = () => page.evaluate(() => { showLanding(); renderFAQ(); return !!document.getElementById('faqItem30'); });
  ok('the FAQ question is not shown while the offer is closed', !(await faqHas30()));
  const tos = await page.evaluate(() => { setLang('en'); return document.querySelector('[data-i18n="tos.hRef"]').textContent + ' | ' + [...document.querySelectorAll('[data-i18n^="tos.pRef"]')].map((e) => e.textContent).join(' '); });
  ok('Terms 4.1 is in the page (EN)', /^4\.1 Referral program \(December 2026\)/.test(tos) && /\$9\.75 when the referred account makes its first monthly plan payment/.test(tos) && /at most 10 referred accounts/.test(tos) && /expires 12 months after it was earned/.test(tos), tos.slice(0, 200));
  const tosFr = await page.evaluate(() => { setLang('fr'); return document.querySelector('[data-i18n="tos.hRef"]').textContent + ' | ' + [...document.querySelectorAll('[data-i18n^="tos.pRef"]')].map((e) => e.textContent).join(' '); });
  ok('Terms 4.1 is in the page (FR)', /^4\.1 Programme de parrainage \(décembre 2026\)/.test(tosFr) && /9,74 \$ lorsque le compte recommandé effectue son deuxième paiement/.test(tosFr) && /au plus 10 comptes/.test(tosFr), tosFr.slice(0, 200));
  ok('the Terms date is updated in both languages', await page.evaluate(() => TRANSLATIONS.en['tos.updated'] === 'Last updated: November 20, 2026' && TRANSLATIONS.fr['tos.updated'] === 'Dernière mise à jour : 20 novembre 2026'));
  await ctx.close();
  const o = await open('?referral=1');
  const shown = await o.page.evaluate(() => { setLang('fr'); showLanding(); renderFAQ(); const el = document.getElementById('faqItem30'); return el ? el.innerText : ''; });
  ok('while the offer is open the FAQ shows the question (FR)', /Y a-t-il une offre de parrainage\?/.test(shown), shown.slice(0, 120));
  const ans = await o.page.evaluate(() => TRANSLATIONS.fr['faq.a30'] + ' | ' + TRANSLATIONS.en['faq.a30']);
  ok('the FAQ answer carries the cap in both languages', /pour au plus 10 entreprises recommandées/.test(ans) && /for up to 10 referred businesses/.test(ans));
  ok('no page errors', o.st.errs.length === 0, o.st.errs.join(' / '));
  await o.ctx.close();
}

console.log('\n── holiday greeting banner (owner-approved 2026-11-22) ──');
{
  const { page, st, ctx } = await open();
  const at = (iso) => page.evaluate((iso) => holidayOpen(Date.parse(iso)), iso);
  ok('13 Dec 2026 23:59 Toronto: hidden', (await at('2026-12-13T23:59:59-05:00')) === false);
  ok('14 Dec 2026 00:00 Toronto: shown', (await at('2026-12-14T00:00:00-05:00')) === true);
  ok('3 Jan 2027 23:59 Toronto: shown', (await at('2027-01-03T23:59:59-05:00')) === true);
  ok('4 Jan 2027 00:00 Toronto: hidden', (await at('2027-01-04T00:00:00-05:00')) === false);
  ok('today (before 14 December) nothing shows', Date.now() >= Date.parse('2026-12-14T05:00:00Z') || !(await visible(page, 'holidayLandBanner')));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}
for (const lang of ['en', 'fr']) {
  const { page, st, ctx } = await open('?holiday=1&referral=1', { viewport: { width: 375, height: 800 } });
  await page.evaluate((l) => { setLang(l); showLanding(); }, lang);
  const txt = await page.evaluate(() => document.getElementById('holidayLandBanner').innerText);
  ok(`${lang}: home page greeting, approved text`, lang === 'fr' ? /Toute l'équipe de PunchClock Crew vous souhaite de joyeuses Fêtes\. Merci de votre confiance cette année!/.test(txt) : /From all of us at PunchClock Crew, happy holidays to you and your team\. Thank you for being with us this year\./.test(txt), txt);
  ok(`${lang}: no offer and no support-hours line in it`, !/10|%|\$|___|support|soutien/.test(txt), txt);
  ok(`${lang}: shown together with the referral banner, no sideways scroll on a phone`, (await visible(page, 'referralLandBanner')) && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'holiday-home-phone-' + lang);
  await page.click('#holidayLandBanner .link-btn');
  ok(`${lang}: Hide removes it and leaves the referral banner`, !(await visible(page, 'holidayLandBanner')) && (await visible(page, 'referralLandBanner')));
  await signIn(page, MGR);
  await page.evaluate(() => { navigate('dashboard'); renderReferralBanners(); });
  ok(`${lang}: a manager sees the greeting on the dashboard (not the referral offer)`, (await visible(page, 'holidayDashBanner')) && !(await visible(page, 'referralDashBanner')));
  ok(`${lang}: no page errors`, st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}

console.log('\n── translations ──');
{
  const { page, ctx } = await open();
  const r = await page.evaluate(() => {
    const en = Object.keys(TRANSLATIONS.en).filter((k) => k.startsWith('ref.')), fr = Object.keys(TRANSLATIONS.fr).filter((k) => k.startsWith('ref.'));
    return { en: en.length, missing: en.filter((k) => !TRANSLATIONS.fr[k]), extra: fr.filter((k) => !TRANSLATIONS.en[k]), same: en.filter((k) => TRANSLATIONS.fr[k] === TRANSLATIONS.en[k] && k !== 'ref.termsTitle'),
      dash: en.filter((k) => /—/.test(TRANSLATIONS.en[k] + TRANSLATIONS.fr[k])) };
  });
  ok(`every English string has a French one (${r.en} strings)`, r.en > 40 && r.missing.length === 0 && r.extra.length === 0, JSON.stringify(r));
  ok('no French string is a copy of the English', r.same.length === 0, r.same.join(','));
  ok('amounts agree in both languages ($19.49, $9.75, $9.74)', await page.evaluate(() => /\$19\.49/.test(TRANSLATIONS.en['ref.terms']) && /\$9\.75/.test(TRANSLATIONS.en['ref.terms']) && /\$9\.74/.test(TRANSLATIONS.en['ref.terms'])
    && /19,49 \$/.test(TRANSLATIONS.fr['ref.terms']) && /9,75 \$/.test(TRANSLATIONS.fr['ref.terms']) && /9,74 \$/.test(TRANSLATIONS.fr['ref.terms'])));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
