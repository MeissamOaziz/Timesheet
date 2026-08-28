// Five of the eleven tables had no card build, so on a phone those screens rendered as blank
// space. These checks assert content is actually present at 375px AND that the cards stay
// hidden on desktop, which is the obvious way a fix like this goes wrong.
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

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

// Is anything actually painted? Cards can exist in the DOM and still be display:none.
const visibleText = (page, sel) => page.evaluate(s=>{
  const el=document.querySelector(s);
  if(!el) return null;
  if(getComputedStyle(el).display==='none') return '';
  return el.innerText.replace(/\s+/g,' ').trim();
}, sel);

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:375,height:820}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await page.evaluate(()=>startDemo());
  await page.waitForTimeout(700);

  // Activity — demo seeds punches, so this must not be empty.
  await page.evaluate(()=>navigate('activity'));
  await page.waitForTimeout(600);
  const act = await visibleText(page,'#activityCardsContainer');
  ok('activity log has visible cards on a phone', !!act && act.length>40, (act||'(blank)').slice(0,70));
  ok('activity table itself is hidden', await page.evaluate(()=>
    getComputedStyle(document.querySelector('#activityBody').closest('table')).display==='none'));

  // Reports — generate one, then check the results render.
  await page.evaluate(()=>navigate('reports'));
  await page.waitForTimeout(500);
  await page.evaluate(()=>{ try{ generateReport(); }catch(e){ window.__genErr=e.message; } });
  await page.waitForTimeout(900);
  const rep = await visibleText(page,'#reportCardsContainer');
  ok('report results have visible cards on a phone', !!rep && rep.length>40, (rep||'(blank)').slice(0,70));

  // Time off — seed one row and render.
  await page.evaluate(()=>{
    _timeOff=[{id:'to1',emp_id:C.employees[0].id,emp_name:C.employees[0].name,kind:'vacation',
               start_date:'2026-09-01',end_date:'2026-09-05',hours_per_day:8,status:'approved',
               company_id:C.companies[0].id}];
    renderTimeOff();
  });
  await page.waitForTimeout(300);
  // Target the time-off host specifically — joining every .mcards together would let the
  // report cards satisfy this assertion without the time-off build working at all.
  const to = await page.evaluate(()=>{
    const wrap=document.getElementById('toListWrap');
    const cards=wrap && wrap.querySelector('.mcards');
    if(!cards) return null;
    if(getComputedStyle(cards).display==='none') return '';
    return cards.innerText.replace(/\s+/g,' ').trim();
  });
  ok('time off list has visible cards on a phone',
     !!to && /vacation|vacances/i.test(to), (to===null?'(no container)':to||'(blank)').slice(0,70));

  ok('no raw i18n keys in any card', !/\b(admin|common|activity|reports|to)\.[a-zA-Z]+/.test(act+' '+rep+' '+to),
     ((act+' '+rep+' '+to).match(/\b(admin|common|activity|reports|to)\.[a-zA-Z]+/g)||[]).join(','));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();

  // Desktop: the cards must NOT appear alongside the tables.
  const wide=await browser.newPage({viewport:{width:1280,height:900}});
  await wide.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await wide.evaluate(l=>setLang(l),lang);
  await wide.evaluate(()=>startDemo());
  await wide.waitForTimeout(600);
  await wide.evaluate(()=>navigate('activity'));
  await wide.waitForTimeout(500);
  ok('cards stay hidden on desktop', await wide.evaluate(()=>
    [...document.querySelectorAll('.mcards')].every(e=>getComputedStyle(e).display==='none')));
  ok('desktop still shows the real table', await wide.evaluate(()=>
    getComputedStyle(document.querySelector('#activityBody').closest('table')).display!=='none'));
  await wide.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
