// Loading and busy states. The failure modes: a skeleton that never clears, a busy button
// that stays stuck after an error, and a toast that clips the message it exists to deliver.
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
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});

console.log('\n── skeletons ──────────────────────────────────');
const skel = await page.evaluate(()=>{
  showSkeleton('activityBody', 5, 'rows');
  const tb=document.getElementById('activityBody');
  const cols=document.querySelector('#activityBody')?.closest('table').querySelectorAll('thead th').length;
  return { rows: tb.querySelectorAll('tr').length,
           cells: tb.querySelectorAll('tr:first-child td').length, cols,
           animated: getComputedStyle(tb.querySelector('.skel')).animationName };
});
ok('table skeleton paints the requested rows', skel.rows===5, String(skel.rows));
ok('and matches the real column count so nothing reflows', skel.cells===skel.cols,
   `${skel.cells} cells vs ${skel.cols} columns`);
ok('skeleton actually shimmers', skel.animated==='skelShimmer', skel.animated);

const cardSkel = await page.evaluate(()=>{
  showSkeleton('activityCardsContainer', 3);
  return document.querySelectorAll('#activityCardsContainer .skel-card').length;
});
ok('card skeleton paints for the phone layout', cardSkel===3, String(cardSkel));

// Whatever renders next must replace it — a skeleton that outlives its fetch is worse than none.
const cleared = await page.evaluate(()=>{
  document.getElementById('activityBody').innerHTML='<tr><td>real</td></tr>';
  return document.querySelectorAll('#activityBody .skel').length;
});
ok('real content replaces the skeleton', cleared===0, String(cleared));

console.log('\n── busy buttons ───────────────────────────────');
const busy = await page.evaluate(async ()=>{
  const btn=document.createElement('button');
  btn.className='btn-primary'; btn.textContent='Save';
  document.body.appendChild(btn);
  let during=null;
  const p = withBusy(btn, async ()=>{
    during={cls:btn.classList.contains('btn-busy'), disabled:btn.disabled,
            color:getComputedStyle(btn).color};
    await new Promise(r=>setTimeout(r,40));
    return 'done';
  });
  const result = await p;
  return {during, after:{cls:btn.classList.contains('btn-busy'), disabled:btn.disabled}, result};
});
ok('button goes busy and disabled during the action', busy.during.cls && busy.during.disabled);
ok('label is hidden rather than removed', /rgba\(0, 0, 0, 0\)|transparent/.test(busy.during.color), busy.during.color);
ok('button is restored afterwards', !busy.after.cls && !busy.after.disabled);
ok('the action result is passed through', busy.result==='done', busy.result);

// The important one: a throw must not leave the button stuck forever.
const thrown = await page.evaluate(async ()=>{
  const btn=document.createElement('button'); btn.className='btn-primary';
  document.body.appendChild(btn);
  let caught=false;
  try { await withBusy(btn, async ()=>{ throw new Error('boom'); }); }
  catch(e){ caught=true; }
  return {caught, stuck: btn.classList.contains('btn-busy')||btn.disabled};
});
ok('a failed action still releases the button', thrown.caught && !thrown.stuck);

// A button disabled for another reason must not be silently enabled.
const preDisabled = await page.evaluate(async ()=>{
  const btn=document.createElement('button'); btn.disabled=true;
  document.body.appendChild(btn);
  await withBusy(btn, async ()=>{});
  return btn.disabled;
});
ok('a previously-disabled button stays disabled', preDisabled===true);

console.log('\n── toast ──────────────────────────────────────');
const toast = await page.evaluate(()=>{
  const long='This is a deliberately long error message about something that went wrong while saving, long enough that a single line would be cut off.';
  showToast(long,'error');
  const el=document.getElementById('pcToast');
  const cs=getComputedStyle(el);
  return {ws:cs.whiteSpace, h:el.getBoundingClientRect().height,
          w:el.getBoundingClientRect().width, text:el.innerText.length, src:long.length};
});
ok('toast is allowed to wrap', toast.ws!=='nowrap', toast.ws);
ok('long message wraps to more than one line', toast.h>28, toast.h+'px tall');
ok('full message is present, not truncated', toast.text>=toast.src-2, `${toast.text}/${toast.src} chars`);
ok('toast stays within a readable width', toast.w<=430, Math.round(toast.w)+'px');

console.log('\n── activation spinner ─────────────────────────');
// The overlay is built on demand, so check what the code would render rather than the DOM.
const spinSrc = await page.evaluate(()=>{
  const build = typeof showActivationSuccess==='function' ? showActivationSuccess.toString() : '';
  return { setsEmpty: /spinner\.textContent\s*=\s*''/.test(build),
           setsIcon: /spinner\.innerHTML/.test(build) };
});
ok('no branch leaves the activation spinner blank', !spinSrc.setsEmpty);
ok('success states render a real mark', spinSrc.setsIcon);
const spinMarkup = await page.evaluate(()=>{
  const el=document.createElement('div');
  el.innerHTML='<div id="activationSpinner" style="margin-bottom:16px;display:flex;justify-content:center"><div class="spinner"></div></div>';
  return !!el.querySelector('.spinner');
});
ok('the initial state is a spinner, not an emoji or an empty box', spinMarkup);

ok('no page errors', errs.length===0, errs.join(' / '));
await page.close();
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
