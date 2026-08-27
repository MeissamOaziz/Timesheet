// Simulates a real tablet opening the kiosk link, so we can prove the wizard's
// "waiting for the tablet" step actually resolves against the live database.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon' };
const server = await new Promise(r => {
  const s = createServer(async (req,res)=>{
    try{
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if(!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()){ res.writeHead(404).end(); return; }
      res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
      createReadStream(f).pipe(res);
    }catch{ res.writeHead(404).end(); }
  });
  s.listen(0,'127.0.0.1',()=>r(s));
});

const SITE = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{ width:1024, height:768 } });
const rpcs = [];
page.on('request', r => { if(r.url().includes('/rpc/')) rpcs.push(r.url().split('/rpc/')[1]); });
page.on('pageerror', e => console.log('  page error:', e.message));

await page.goto(`http://127.0.0.1:${server.address().port}/index.html?kiosk=${SITE}`, { waitUntil:'networkidle' });
await page.waitForTimeout(2500);

const deviceId = await page.evaluate(() => localStorage.getItem('pc_device_id'));
const saved    = await page.evaluate(() => localStorage.getItem('pc_kiosk_device'));
const onPunch  = await page.evaluate(() => {
  const p = document.getElementById('page-punch');
  return !!p && getComputedStyle(p).display !== 'none';
});
console.log('RPCs called   :', rpcs.join(', ') || '(none)');
console.log('device id     :', deviceId);
console.log('kiosk saved   :', saved);
console.log('punch screen  :', onPunch ? 'shown' : 'NOT shown');
await browser.close(); server.close();
