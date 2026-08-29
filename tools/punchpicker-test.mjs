// The punch screen picker. Every employee touches this twice a day, so the risks are: the
// tiles and the hidden select disagreeing, a filter that misses accented names, and the
// selection surviving a punch when it should reset.
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
for(const [label,vw] of [['desktop',1280],['phone',390]]){
  console.log(`\n── ${label} (${vw}px) ─────────────────────────`);
  const page=await browser.newPage({viewport:{width:vw,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(()=>setLang('en'));
  await page.evaluate(()=>startDemo());
  await page.evaluate(()=>navigate('punch'));
  await page.waitForTimeout(700);

  const tiles = await page.evaluate(()=>document.querySelectorAll('.emp-tile').length);
  ok('tiles render for every employee', tiles>0, tiles+' tiles');
  ok('the native dropdown is no longer what people tap', await page.evaluate(()=>
     getComputedStyle(document.getElementById('empSelectWrap')).display==='none'));

  // Tap target size is the whole point of replacing a <select>.
  const box = await page.evaluate(()=>{
    const t=document.querySelector('.emp-tile'); const r=t.getBoundingClientRect();
    return {w:Math.round(r.width),h:Math.round(r.height)};
  });
  ok('tiles are a comfortable tap target', box.h>=48 && box.w>=110, `${box.w}x${box.h}`);

  // Tapping a tile must drive the hidden select, which the rest of the flow reads.
  const picked = await page.evaluate(()=>{
    const t=document.querySelector('.emp-tile');
    const id=t.dataset.emp; t.click();
    return {sel:document.getElementById('empSelect').value, id,
            marked:document.querySelector('.emp-tile.sel')?.dataset.emp};
  });
  ok('tapping a tile sets the hidden select', picked.sel===picked.id, picked.sel);
  ok('and the tile shows as selected', picked.marked===picked.id);

  // Accent-insensitive search: the demo roster has Aïsha Benali.
  const search = await page.evaluate(()=>{
    document.getElementById('empFilter').value='aisha';
    renderEmpTiles();
    const names=[...document.querySelectorAll('.emp-tile-name')].map(n=>n.textContent);
    return names;
  });
  ok('search ignores accents', search.length===1 && /Aïsha/.test(search[0]), search.join(',')||'(none)');

  const none = await page.evaluate(()=>{
    document.getElementById('empFilter').value='zzzzz';
    renderEmpTiles();
    const e=document.getElementById('empGridEmpty');
    return {tiles:document.querySelectorAll('.emp-tile').length,
            shown:getComputedStyle(e).display!=='none', txt:e.textContent};
  });
  ok('a search with no match says so', none.tiles===0 && none.shown, none.txt);
  ok('empty-state copy is translated', !/punch\./.test(none.txt));

  // Someone already clocked in is marked — it is how you notice you never clocked out.
  const inMark = await page.evaluate(()=>{
    document.getElementById('empFilter').value='';
    renderEmpTiles();
    return {dots:document.querySelectorAll('.emp-tile-in').length,
            actuallyIn:C.employees.filter(e=>getEmpStatus(e.id).status==='IN').length};
  });
  ok('clocked-in employees are marked', inMark.dots===inMark.actuallyIn,
     `${inMark.dots} dots vs ${inMark.actuallyIn} clocked in`);

  // Clearing the selection (what a completed punch does) must clear the tiles too.
  const cleared = await page.evaluate(()=>{
    document.querySelector('.emp-tile').click();
    const before=!!document.querySelector('.emp-tile.sel');
    document.getElementById('empSelect').value=''; renderEmpTiles();
    return {before, after:!!document.querySelector('.emp-tile.sel')};
  });
  ok('clearing the select clears the highlighted tile', cleared.before && !cleared.after);

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
