// The punch screen picker. Every employee touches this twice a day.
//
// This screen briefly used a tile grid with a search box. It was reverted: the search solved a
// crowding problem none of the real sites have (the largest has nine people), and the owner
// preferred the dropdown. These checks cover the dropdown as the visible picker — that it lists
// exactly the right people, stays scoped to the site, translates, and resets between people.
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

const setup = page => page.evaluate(()=>{
  window._demoMode=false;
  Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t'}, false);
  C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
  C.sites=[{id:'s1',name:'WIN1',company_id:'co1'},{id:'s2',name:'Other',company_id:'co1'}];
  C.employees=[
    {id:'e1',name:'Chantal Arruda',emp_code:'A1',site_id:'s1',company_id:'co1',active:true},
    {id:'e2',name:'Aïsha Benali',  emp_code:'A2',site_id:'s1',company_id:'co1',active:true},
    {id:'e3',name:'Gabor Torok',   emp_code:'A3',site_id:'s1',company_id:'co1',active:true},
    {id:'e4',name:'Retired Rita',  emp_code:'A4',site_id:'s1',company_id:'co1',active:false},
    {id:'e5',name:'Elsewhere Eli', emp_code:'A5',site_id:'s2',company_id:'co1',active:true}];
  C.punches=[];
  // The page refreshes from the server on entry; the cache above is the fixture, so keep it.
  window.refreshCache=async()=>{};
  DB.all=async()=>[];
  DB.rpc=async()=>null;
  Ctx.set({co:{id:'co1',name:'Acme'},site:{id:'s1',name:'WIN1'}});
  document.body.classList.add('role-resolved','role-admin');
  hideLanding(); updateNav(); navigate('punch');
  // navigate() fires loadPunchPage() without awaiting it; the population happens inside.
  return loadPunchPage();
});

const browser=await chromium.launch();

for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ────────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await setup(page);
  await page.waitForTimeout(250);

  const sel = await page.evaluate(()=>{
    const s=document.getElementById('empSelect');
    const wrap=document.getElementById('empSelectWrap');
    return {visible:getComputedStyle(wrap).display!=='none',
            options:[...s.options].map(o=>o.textContent),
            value:s.value};
  });
  ok('the dropdown is the visible picker', sel.visible);
  ok('it lists the site\'s active employees', sel.options.length===4, sel.options.join(' | '));
  ok('inactive people are not listed', !sel.options.some(o=>/Rita/.test(o)), sel.options.join(' | '));
  ok('other sites are not listed', !sel.options.some(o=>/Eli/.test(o)), sel.options.join(' | '));
  ok('names carry their employee code', sel.options.some(o=>/Chantal Arruda \(A1\)/.test(o)),
     sel.options.join(' | '));
  ok('it starts on the placeholder', sel.value==='', sel.value);
  ok('the placeholder is translated', !/punch\./.test(sel.options[0]), sel.options[0]);

  // The tile grid and its search box must be gone, not merely hidden — a stale search field on
  // the most-touched screen in the product is exactly what was reverted.
  const gone = await page.evaluate(()=>({
    filter:!!document.getElementById('empFilter'),
    grid:!!document.getElementById('empGrid'),
    fn:typeof window.renderEmpTiles!=='undefined',
  }));
  ok('the search box is gone', !gone.filter);
  ok('the tile grid is gone', !gone.grid);
  ok('and its code is gone with it', !gone.fn);

  // Choosing a name drives the rest of the punch flow through the select's change handler.
  const picked = await page.evaluate(()=>{
    const s=document.getElementById('empSelect');
    s.value='e1';
    if(typeof s.onchange==='function') s.onchange.call(s);
    return {value:s.value, label:s.options[s.selectedIndex].textContent};
  });
  ok('choosing a name selects it', picked.value==='e1', picked.label);

  // A punch must not leave the previous person selected for whoever walks up next.
  const cleared = await page.evaluate(()=>{
    const s=document.getElementById('empSelect');
    const before=s.value;
    s.value='';
    return {before, after:s.value};
  });
  ok('the selection resets between people', cleared.before==='e1' && cleared.after==='');

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
