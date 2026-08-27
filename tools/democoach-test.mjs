// The demo coach advances on the visitor DOING each thing. These checks pin that down —
// a coach that advances on its own button is a slideshow, which is what it replaced.
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
const card = page => page.evaluate(()=>{
  const el=document.querySelector('#demoCoach .dcoach');
  return el ? el.innerText.replace(/\n+/g,' | ') : null; });

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  ok('no coach before the demo starts', (await card(page))===null);

  await page.evaluate(()=>startDemo());
  await page.waitForTimeout(500);
  let c = await card(page);
  ok('step 1 appears with the demo', !!c && /1|clock|point/i.test(c), c);
  ok('no raw i18n keys', !!c && !/\bdc\.[a-zA-Z]+/.test(c), (c||'').match(/\bdc\.[a-zA-Z]+/g)?.join(',')||'');

  // Step 1 → 2 on arriving at the punch page.
  await page.evaluate(()=>navigate('punch'));
  await page.waitForTimeout(300);
  ok('advances to step 2 on reaching the clock-in page',
     await page.evaluate(()=>_dcStep===1), 'step index '+await page.evaluate(()=>_dcStep));

  // Step 2 must NOT advance on navigation — only on an actual punch.
  await page.evaluate(()=>navigate('dashboard'));
  await page.waitForTimeout(250);
  ok('step 2 does not advance just by navigating away',
     await page.evaluate(()=>_dcStep===1), 'step index '+await page.evaluate(()=>_dcStep));

  // A real punch advances it.
  await page.evaluate(()=>navigate('punch'));
  await page.waitForTimeout(250);
  const punched = await page.evaluate(async ()=>{
    const emp=C.employees.find(e=>getEmpStatus(e.id).status!=='IN') || C.employees[0];
    await executePunch(emp.id, getEmpStatus(emp.id).status==='IN'?'OUT':'IN');
    return _dcStep;
  });
  ok('a real punch advances to step 3', punched===2, 'step index '+punched);
  c = await card(page);
  ok('step 3 talks about the dashboard', !!c && /dashboard|tableau/i.test(c), c);

  await page.evaluate(()=>navigate('dashboard'));
  await page.waitForTimeout(250);
  ok('advances to step 4 on the dashboard', await page.evaluate(()=>_dcStep===3));
  c = await card(page);
  ok('step 4 talks about reports/payroll', !!c && /report|rapport|payroll|paie/i.test(c), c);

  await page.evaluate(()=>navigate('reports'));
  await page.waitForTimeout(300);
  ok('coach retires after the last step', (await card(page))===null);

  // Exit intent: only after they have seen it work, only once, and never after dismissal.
  await page.evaluate(()=>{ _dcStep=0; _dcExitAsked=false; renderDemoCoach(); });
  await page.evaluate(()=>document.dispatchEvent(new MouseEvent('mouseout',{clientY:-5,bubbles:true})));
  await page.waitForTimeout(120);
  ok('no exit prompt before the visitor has tried anything',
     !/before you go|avant de partir/i.test((await card(page))||''));

  await page.evaluate(()=>{ _dcStep=2; _dcExitAsked=false; renderDemoCoach(); });
  await page.evaluate(()=>document.dispatchEvent(new MouseEvent('mouseout',{clientY:-5,bubbles:true})));
  await page.waitForTimeout(120);
  c = await card(page);
  ok('exit prompt appears once they have seen it work',
     /before you go|avant de partir/i.test(c||''), c);
  ok('exit prompt copy resolved', !!c && !/\b(dc|demo)\.[a-zA-Z]+/.test(c));

  await page.evaluate(()=>{ dismissDemoCoach(); _dcExitAsked=false;
    document.dispatchEvent(new MouseEvent('mouseout',{clientY:-5,bubbles:true})); });
  await page.waitForTimeout(120);
  ok('dismissal is respected, including by exit intent', (await card(page))===null);

  // Leaving the demo must take the coach with it.
  await page.evaluate(()=>{ try{sessionStorage.removeItem('pc_demo_coach');}catch(e){}
    startDemo(); });
  await page.waitForTimeout(300);
  await page.evaluate(()=>exitDemo());
  await page.waitForTimeout(200);
  ok('coach disappears when the demo ends', (await card(page))===null);

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
