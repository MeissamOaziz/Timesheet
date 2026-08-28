// The punch screen is also the kiosk screen. A portal link helps the employee standing at a
// normal punch page and is a hole in a kiosk terminal, because a plain href is a full page
// load that navigate()'s kiosk lock never sees.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.ico':'image/x-icon'};
const server=await new Promise(r=>{const s=createServer(async(q,res)=>{try{
  const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  const f=normalize(join(ROOT,rel));
  if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(f).pipe(res);}catch{res.writeHead(404).end();}});s.listen(0,'127.0.0.1',()=>r(s));});
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);

  // Normal punch page: the link should be there and readable.
  const page=await browser.newPage({viewport:{width:900,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await page.evaluate(()=>startDemo());
  await page.evaluate(()=>navigate('punch'));
  await page.waitForTimeout(500);
  const link = await page.evaluate(()=>{
    const el=document.getElementById('portalLinkFooter');
    if(!el) return null;
    return { visible:getComputedStyle(el).display!=='none',
             text:el.innerText.trim(),
             href:el.querySelector('a')?.getAttribute('href') };
  });
  ok('portal link present on a normal punch page', !!link && link.visible, link?link.text:'(missing)');
  ok('points at the portal', link?.href==='employee.html', link?.href||'');
  ok('copy is translated, not a raw key', !!link && !/punch\./.test(link.text));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();

  // Kiosk terminal: the link must be gone, not merely inert.
  const kiosk=await browser.newPage({viewport:{width:900,height:900}});
  await kiosk.goto(`${BASE}/index.html?kiosk=demo-s1`,{waitUntil:'networkidle'});
  await kiosk.waitForTimeout(900);
  ok('kiosk mode was entered', await kiosk.evaluate(()=>window._kioskUrlMode===true));
  ok('portal link is hidden on a kiosk terminal', await kiosk.evaluate(()=>{
    const el=document.getElementById('portalLinkFooter');
    return !el || getComputedStyle(el).display==='none';
  }));
  await kiosk.close();
}

// The portal has to actually answer at that URL, or the link is a dead end.
const ep=await browser.newPage();
const resp=await ep.goto(`${BASE}/employee.html`,{waitUntil:'domcontentloaded'});
ok('portal URL serves a login screen', resp.status()===200 &&
   /sign in|connexion|portal|portail/i.test(await ep.evaluate(()=>document.body.innerText)),
   'HTTP '+resp.status());
await ep.close();

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
