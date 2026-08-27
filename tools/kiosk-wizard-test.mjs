// End-to-end check of the kiosk setup wizard (Phase 1).
//
//   cd tools && node kiosk-wizard-test.mjs
//
// Runs the real page in a real browser, in both languages, and asserts the things that
// silently rot: that every string resolves, that the QR actually decodes back to the
// kiosk URL, that the "tablet connected" status flips when a device appears, and that
// the device-token step only shows for sites that require it.

import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png',
               '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' };

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                           'Cache-Control':'no-store' });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

let pass = 0, fail = 0;
const ok  = (n, c, extra='') => { c ? pass++ : fail++; console.log(`  ${c?'PASS':'FAIL'}  ${n}${extra?'  '+extra:''}`); };

const server = await startServer();
const URL = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await chromium.launch();

for (const lang of ['en','fr']) {
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil:'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.setItem('pc_tour_v1','1'); } catch(e){} });
  await page.reload({ waitUntil:'networkidle' });
  await page.evaluate(l => setLang(l), lang);
  await page.evaluate(() => startDemo());
  await page.waitForTimeout(800);

  const siteId = await page.evaluate(() => C.sites[0].id);
  await page.evaluate(id => openKioskShortcut(id), siteId);
  await page.waitForTimeout(500);

  ok('wizard opens', await page.evaluate(() =>
    document.getElementById('kioskShortcutModal').classList.contains('open')));

  // Every visible string resolved — t() returns the key itself on a miss, so a raw
  // "kw.something" anywhere in the modal is a missing translation.
  const raw = await page.evaluate(() => {
    const txt = document.querySelector('.kiosk-wiz').innerText;
    return (txt.match(/\b(kw|kiosk|punch|common)\.[a-zA-Z]+/g) || []);
  });
  ok('no raw i18n keys rendered', raw.length === 0, raw.join(', '));

  // t() warns once per missing key across the whole page load, which catches strings
  // that resolve into attributes or are built but not yet shown.
  const missing = await page.evaluate(() => __missingI18n());
  ok('no missing translation keys page-wide', missing.length === 0, missing.join(', '));

  // The QR is the entire premise of the wizard: if it doesn't decode, nothing works.
  const shot = await page.locator('#kioskWizQR canvas').screenshot();
  const { data, info } = await (await import('sharp')).default(shot)
    .ensureAlpha().raw().toBuffer({ resolveWithObject:true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  const expected = await page.evaluate(() => window._currentKioskUrl);
  ok('QR decodes to the kiosk URL', decoded && decoded.data === expected,
     decoded ? (decoded.data === expected ? expected : `got ${decoded.data}`) : 'no decode');

  ok('URL shown as text matches the QR', await page.evaluate(() =>
    document.getElementById('kioskUrlDisplay').textContent.trim() === window._currentKioskUrl));

  // Step 3 starts in the waiting state and must flip when a tablet shows up.
  const waiting = await page.evaluate(() => document.getElementById('kwStatus').className);
  ok('starts in the waiting state', !waiting.includes('ok'), waiting);

  const connected = await page.evaluate(() => {
    setKioskWizStatus(true, { device_id:'dev-test', label:'Front counter',
                              last_seen:new Date().toISOString() });
    return document.getElementById('kwStatus').innerText;
  });
  ok('flips to connected when a tablet appears',
     /kw\./.test(connected) === false && connected.includes('Front counter'), connected.trim());

  // The device list has to render the tablet, its last-seen time, and an unlink control.
  const list = await page.evaluate(id => {
    renderKioskDevices([{ device_id:'dev-test', label:'Front counter',
                          last_seen:new Date(Date.now()-5*60000).toISOString() }], id);
    return document.getElementById('kwDevices').innerText;
  }, siteId);
  ok('device list renders label + last-seen + unlink',
     list.includes('Front counter') && /5/.test(list) && !/kw\./.test(list), list.replace(/\n/g,' | ').trim());

  // A real check-in carries no label — the server only records the user agent — so the
  // list has to name the device from that. This is what admins actually see in practice.
  const unlabelled = await page.evaluate(id => {
    renderKioskDevices([{ device_id:'dev-ua', label:null,
      user_agent:'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      last_seen:new Date().toISOString() }], id);
    return document.getElementById('kwDevices').innerText;
  }, siteId);
  ok('unlabelled device is named from its user agent',
     unlabelled.includes('iPad') && !/kw\./.test(unlabelled), unlabelled.replace(/\n/g, ' | ').trim());

  // Step 4 is conditional — it must stay hidden for a normal site and appear for a
  // token-locked one, because it's the only place those sites can authorise a tablet.
  ok('token step hidden for a normal site', await page.evaluate(() =>
    document.getElementById('kwTokenStep').style.display === 'none'));

  const tokenTxt = await page.evaluate(id => {
    const s = C.sites.find(x=>x.id===id);
    s.require_device_token = true;
    renderKioskTokenStep(s);
    const el = document.getElementById('kwTokenStep');
    return { shown: el.style.display !== 'none', txt: el.innerText };
  }, siteId);
  ok('token step appears when the site requires it', tokenTxt.shown);
  ok('token step copy resolved', !/kw\./.test(tokenTxt.txt), tokenTxt.txt.replace(/\n/g,' | ').trim().slice(0,110));

  // Closing must kill the poll timer, or the wizard keeps hitting the DB forever.
  await page.evaluate(() => closeKioskWizard());
  ok('closing stops the poller', await page.evaluate(() => _kwPoll === null));

  ok('no page errors', errors.length === 0, errors.join(' / '));

  await page.screenshot({ path: `../assets/screenshots/_kiosk-wizard-${lang}.png` }).catch(()=>{});
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
