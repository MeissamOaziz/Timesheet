// A customer bound her own phone as a kiosk, then could not get into admin: she could reach
// the login screen and authenticate, but every navigation after that was silently refused.
// The lock exists to stop staff wandering off the punch page — an admin who has signed in on
// that device is not staff.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json','.ico':'image/x-icon'};
const server=await new Promise(r=>{const s=createServer(async(q,res)=>{try{
  const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  const f=normalize(join(ROOT,rel));
  if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(f).pipe(res);}catch{res.writeHead(404).end();}});s.listen(0,'127.0.0.1',()=>r(s));});

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

const browser=await chromium.launch();
for(const [label,w] of [['phone',390],['tablet',1024]]){
  console.log(`\n── ${label} ───────────────────────────────────`);
  const page=await browser.newPage({viewport:{width:w,height:844}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});

  // Put the page in the state a kiosk-bound device boots into.
  await page.evaluate(()=>{
    window._kioskUrlMode = true;
    Sess.clear();
    navigate('punch');
    const f=document.getElementById('kioskResetFooter'); if(f) f.style.display='';
  });

  // Signed out: the lock holds.
  ok('signed out, admin pages stay blocked', await page.evaluate(()=>{
    navigate('dashboard'); return currentPage!=='dashboard'; }));
  ok('signed out, the login page is still reachable', await page.evaluate(()=>{
    navigate('login'); return currentPage==='login'; }));

  // Signed in on that same device: the lock must release.
  const released = await page.evaluate(()=>{
    Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t'}, false);
    // A set-up account: without a company, navigate() legitimately diverts to onboarding and
    // the test would be measuring that rather than the kiosk guard.
    C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
    C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
    C.employees=[{id:'e1',name:'Ana',site_id:'s1',company_id:'co1',active:true}];
    Ctx.set({co:{id:'co1',name:'Acme'}});
    navigate('dashboard');
    return {page: currentPage, loggedIn: isLoggedIn(), onboarding: needsOnboarding()};
  });
  ok('a signed-in admin can reach the dashboard', released.page==='dashboard',
     `logged in: ${released.loggedIn}, onboarding: ${released.onboarding}, landed on: ${released.page}`);
  for(const p of ['reports','admin','sites','activity']){
    const got = await page.evaluate(x=>{ navigate(x); return currentPage; }, p);
    ok(`  ...and ${p}`, got===p, got);
  }

  // The escape has to be findable on the device someone bound by mistake.
  await page.evaluate(()=>{ Sess.clear(); window._kioskUrlMode=true; navigate('punch');
    const f=document.getElementById('kioskResetFooter'); if(f) f.style.display=''; });
  const esc = await page.evaluate(()=>{
    const f=document.getElementById('kioskResetFooter');
    const btns=[...f.querySelectorAll('button')];
    return {visible:getComputedStyle(f).display!=='none',
            count:btns.length,
            labels:btns.map(b=>b.textContent.trim()),
            smallest:Math.min(...btns.map(b=>parseFloat(getComputedStyle(b).fontSize))),
            faintest:Math.min(...btns.map(b=>parseFloat(getComputedStyle(b).opacity)))};
  });
  ok('the punch screen offers a way back', esc.visible && esc.count>=2, esc.labels.join(' | '));
  ok('an explicit admin sign-in is one of them', esc.labels.some(l=>/admin/i.test(l)));
  ok('it is not hidden in tiny faint text', esc.smallest>=12 && esc.faintest>=1,
     `${esc.smallest}px @ opacity ${esc.faintest}`);
  ok('no raw i18n keys', !/kiosk\./.test(esc.labels.join(' ')));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
