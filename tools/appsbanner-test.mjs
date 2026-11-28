// "Phone apps are on the way" notice (owner's wording, 2026-11-28): home page for visitors, dashboard for owners
// and co-admins. The plan it names is a promise to customers, so the exact text is pinned here in both languages:
// planned for January 2027 (a month, never a day), included with Growth and Business, nothing about Starter or Free.
// The network is stubbed: nothing real is contacted.
//   node tools/appsbanner-test.mjs [folder-for-screenshots]
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
const OWNER = { id: 'a1', name: 'Olivia Owner', email: 'o@x.ca', role: 'admin', plan: 'free', token: 'tok-admin' };
const MGR = { id: 'a2', name: 'Mia', email: 'm@x.ca', role: 'manager', plan: 'free', parent_admin_id: 'a1', token: 'tok-mgr' };
const signIn = (page, sess) => page.evaluate((s) => { Sess.set(s, false); C.companies = [{ id: 'c1', name: 'Acme', admin_id: 'a1' }]; hideLanding(); updateNav(); navigate('dashboard'); renderReferralBanners(); }, sess);
const visible = (page, id) => page.evaluate((id) => { const e = document.getElementById(id); return !!e && e.style.display !== 'none' && e.offsetParent !== null; }, id);
const text = (page, id) => page.evaluate((id) => document.getElementById(id).innerText.replace(/\s+/g, ' ').trim(), id);
const WORDING = {
  en: /^Our iPhone and Android apps are on the way, planned for January 2027\. They will be included with the Growth and Business plans\. Hide$/,
  fr: /^Nos applications pour iPhone et Android arrivent : la sortie est prévue pour janvier 2027\. Elles seront incluses dans les forfaits Croissance et Entreprise\. Masquer$/,
};

for (const lang of ['en', 'fr']) {
  console.log(`\n── home page, ${lang} ──`);
  const { page, st, ctx } = await open('', { viewport: { width: 375, height: 800 } });
  await page.evaluate((l) => { setLang(l); showLanding(); }, lang);
  ok(`${lang}: a visitor sees the notice on the home page`, await visible(page, 'appsLandBanner'));
  const txt = await text(page, 'appsLandBanner');
  ok(`${lang}: the exact approved wording`, WORDING[lang].test(txt), txt);
  ok(`${lang}: no day, no price, no store name, no Starter or Free`, !/\$|App Store|Google Play|Starter|Débutant|Free|Gratuit|\b\d{1,2} (January|janvier)/i.test(txt), txt);
  ok(`${lang}: no sideways scroll on a phone`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.evaluate(() => window.scrollTo(0, 0)); await shot(page, 'apps-home-phone-' + lang);
  await page.click('#appsLandBanner .link-btn');
  ok(`${lang}: Hide removes it`, !(await visible(page, 'appsLandBanner')));
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => showLanding());
  ok(`${lang}: and it stays hidden after a reload`, !(await visible(page, 'appsLandBanner')));
  ok(`${lang}: no page errors`, st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}

console.log('\n── dashboard ──');
{
  const { page, st, ctx } = await open();
  await signIn(page, OWNER);
  ok('an owner on the Free plan sees it on the dashboard', await visible(page, 'appsDashBanner'));
  ok('with the same wording', WORDING.en.test(await text(page, 'appsDashBanner')), await text(page, 'appsDashBanner'));
  ok('and the home-page copy is not drawn for someone signed in', !(await visible(page, 'appsLandBanner')));
  await shot(page, 'apps-dashboard');
  await page.click('#appsDashBanner .link-btn');
  ok('Hide removes it from the dashboard', !(await visible(page, 'appsDashBanner')));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}
{
  const { page, st, ctx } = await open();
  await signIn(page, MGR);
  ok('a site manager does not see it (plans are not theirs to choose)', !(await visible(page, 'appsDashBanner')));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}
{
  const { page, st, ctx } = await open();
  await page.evaluate(() => startDemo());
  await page.waitForTimeout(400);
  await page.evaluate(() => { navigate('dashboard'); renderReferralBanners(); });
  ok('demo mode does not show it', !(await visible(page, 'appsDashBanner')));
  ok('no page errors', st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}

console.log('\n── pricing cards ──');
for (const lang of ['en', 'fr']) {
  const { page, st, ctx } = await open();
  await page.evaluate((l) => { setLang(l); showLanding(); }, lang);
  const cards = await page.evaluate(() => [...document.querySelectorAll('.price-card')].map((c) => ({
    name: c.querySelector('.price-name').getAttribute('data-i18n'), lines: [...c.querySelectorAll('.price-features li')].map((li) => li.innerText.trim()) })));
  const line = lang === 'fr' ? 'Applications iPhone et Android (sortie prévue en janvier 2027)' : 'iPhone and Android apps (planned for January 2027)';
  const has = (n) => { const c = cards.find((c) => c.name === n); return !!c && c.lines.includes(line); };
  const mentions = (n) => { const c = cards.find((c) => c.name === n); return !c || c.lines.some((l) => /iPhone|Android/i.test(l)); };
  ok(`${lang}: the four plan cards are there`, ['plan.free', 'plan.starter', 'plan.growth', 'plan.business'].every((n) => cards.some((c) => c.name === n)), cards.map((c) => c.name).join(' '));
  ok(`${lang}: Growth and Business list the apps, with the planned month`, has('plan.growth') && has('plan.business'), JSON.stringify(cards.filter((c) => /growth|business/.test(c.name))));
  ok(`${lang}: Free and Starter do not mention them`, !mentions('plan.free') && !mentions('plan.starter'));
  ok(`${lang}: no page errors`, st.errs.length === 0, st.errs.join(' / '));
  await ctx.close();
}

console.log('\n── translations ──');
{
  const { page, ctx } = await open();
  const r = await page.evaluate(() => ({ en: TRANSLATIONS.en['apps.banner'], fr: TRANSLATIONS.fr['apps.banner'], de: TRANSLATIONS.en['apps.dismiss'], df: TRANSLATIONS.fr['apps.dismiss'] }));
  ok('both languages have both strings, and French is not a copy of English', !!r.en && !!r.fr && !!r.de && !!r.df && r.en !== r.fr);
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
