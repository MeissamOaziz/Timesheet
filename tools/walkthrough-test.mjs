// Walk-through: opens every page the sidebar offers, in demo mode (sample data, nothing real), in English and
// French, on a desktop and on a phone, and looks for the things a person would notice at a glance and no other
// suite checks everywhere: a script error, a translation key or "undefined" showing as text, French pages still
// showing an English label, and a page that scrolls sideways. It does not replace the suites that check what each
// page does; it catches the page nobody thought to test.
//   node tools/walkthrough-test.mjs [folder-for-screenshots]
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
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x !== '' ? '  -> ' + String(x).slice(0, 500) : ''}`); };
const browser = await chromium.launch();

// What one page looks like right now, read inside the browser.
const look = () => {
  const page = document.querySelector('.page.active') || document.body;
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = page.innerText || '';
  const keys = new Set(Object.keys(TRANSLATIONS.en));
  // A translation key printed as text: a visible leaf element whose whole text is a known key.
  const rawKeys = [...page.querySelectorAll('*')].filter((e) => !e.children.length && seen(e) && keys.has((e.textContent || '').trim())).map((e) => e.textContent.trim());
  // French page, English label: an element marked for translation that still shows the English string
  // although the French one is different.
  const english = document.documentElement.lang !== 'fr' ? [] : [...page.querySelectorAll('[data-i18n]')].filter((e) => {
    const k = e.getAttribute('data-i18n'), en = TRANSLATIONS.en[k], fr = TRANSLATIONS.fr[k];
    return seen(e) && en && fr && en !== fr && (e.textContent || '').trim() === en.replace(/<[^>]+>/g, '').trim();
  }).map((e) => e.getAttribute('data-i18n'));
  const junk = (text.match(/\bundefined\b|\bNaN\b|\[object Object\]/g) || []);
  return { id: page.id || 'body', chars: text.trim().length, rawKeys: [...new Set(rawKeys)], english: [...new Set(english)], junk: [...new Set(junk)],
    sideways: document.documentElement.scrollWidth - window.innerWidth };
};

for (const [device, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 800 }]]) {
  for (const lang of ['en', 'fr']) {
    console.log(`\n── ${device}, ${lang} ──`);
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate((l) => { setLang(l); startDemo(); }, lang);
    await page.waitForTimeout(700);
    const navs = await page.evaluate(() => [...new Set([...document.querySelectorAll('#sideNav .sn-item[data-nav]')].map((b) => b.getAttribute('data-nav')))]);
    ok(`the sidebar offers pages to walk (${navs.length})`, navs.length >= 8, navs.join(' '));
    // The clock-in screen covers the whole window once opened, so it is walked last.
    for (const nav of [...navs.filter((n) => n !== 'punch'), ...navs.filter((n) => n === 'punch')]) {
      const before = errs.length;
      await page.evaluate((n) => navigate(n === 'admins' ? 'admin' : n), nav);
      await page.waitForTimeout(350);
      const v = await page.evaluate(look);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `walk-${device}-${lang}-${nav}.png`) });
      const problems = [];
      if (errs.length > before) problems.push('script error: ' + errs.slice(before).join(' / '));
      if (v.chars < 20) problems.push('page is empty');
      if (v.rawKeys.length) problems.push('translation key shown as text: ' + v.rawKeys.join(', '));
      if (v.junk.length) problems.push('shows ' + v.junk.join(', '));
      if (v.english.length) problems.push('English label on the French page: ' + v.english.join(', '));
      if (v.sideways > 1) problems.push(`scrolls sideways by ${v.sideways}px`);
      ok(`${nav}`, problems.length === 0, problems.join('; '));
    }
    await ctx.close();
  }
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
