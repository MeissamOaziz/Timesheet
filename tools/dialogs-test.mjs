// Native confirm()/alert() are gone. The risks in replacing them: a promise that never
// resolves (the caller hangs forever), a destructive prompt that defaults to the destructive
// button, and multi-line copy written for confirm() losing its line breaks.
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
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  // If any native dialog is still reachable it would block the run; fail loudly instead.
  let native=0;
  page.on('dialog', async d=>{ native++; await d.dismiss(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  // Confirm resolves true on the confirm button.
  const yes = await page.evaluate(async ()=>{
    const p = uiConfirm('Delete this?');
    await new Promise(r=>setTimeout(r,60));
    document.getElementById('uiDlgOk').click();
    return await p;
  });
  ok('confirm resolves true when confirmed', yes===true, String(yes));

  const no = await page.evaluate(async ()=>{
    const p = uiConfirm('Delete this?');
    await new Promise(r=>setTimeout(r,60));
    document.getElementById('uiDlgCancel').click();
    return await p;
  });
  ok('confirm resolves false when cancelled', no===false, String(no));

  const esc = await page.evaluate(async ()=>{
    const p = uiConfirm('Delete this?');
    await new Promise(r=>setTimeout(r,60));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    return await p;
  });
  ok('Escape cancels rather than confirming', esc===false, String(esc));

  // A destructive prompt must not put the keyboard on the destructive button.
  const focus = await page.evaluate(async ()=>{
    const p = uiConfirm('Delete this?');
    await new Promise(r=>setTimeout(r,120));
    const id = document.activeElement && document.activeElement.id;
    document.getElementById('uiDlgCancel').click(); await p;
    return id;
  });
  ok('danger prompts focus Cancel, not the destructive action', focus==='uiDlgCancel', focus||'(none)');

  // Copy written for confirm() used real newlines.
  const br = await page.evaluate(async ()=>{
    const p = uiConfirm('Line one\n\nLine two');
    await new Promise(r=>setTimeout(r,60));
    const html = document.querySelector('#uiDialog p').innerHTML;
    document.getElementById('uiDlgCancel').click(); await p;
    return html;
  });
  ok('newlines become line breaks', br.includes('<br>') && !br.includes('\n\n'), br.slice(0,50));

  // Message text is escaped, not injected.
  const xss = await page.evaluate(async ()=>{
    const p = uiConfirm('<img src=x onerror="window.__pwned=1">');
    await new Promise(r=>setTimeout(r,60));
    const has = !!document.querySelector('#uiDialog img');
    document.getElementById('uiDlgCancel').click(); await p;
    return {has, pwned: !!window.__pwned};
  });
  ok('message content is escaped, not rendered as markup', !xss.has && !xss.pwned);

  // Alert has one button and resolves.
  const al = await page.evaluate(async ()=>{
    const p = uiAlert('Something happened');
    await new Promise(r=>setTimeout(r,60));
    const btns = document.querySelectorAll('#uiDialog button').length;
    document.getElementById('uiDlgOk').click();
    await p;
    return btns;
  });
  ok('alert offers a single button', al===1, String(al));

  // Labels translated, dialog closes.
  const labels = await page.evaluate(async ()=>{
    const p = uiConfirm('x');
    await new Promise(r=>setTimeout(r,60));
    const txt = document.getElementById('uiDialog').innerText;
    document.getElementById('uiDlgCancel').click(); await p;
    return {txt, closed: !document.getElementById('uiDialog').classList.contains('open')};
  });
  ok('no raw i18n keys in the dialog', !/\b(dlg|common)\.[a-zA-Z]+/.test(labels.txt),
     labels.txt.replace(/\n/g,' | ').slice(0,60));
  ok('dialog closes after answering', labels.closed);
  // A real converted call site, end to end: the helper working in isolation proves nothing
  // about whether `if(!(await uiConfirm(...))) return;` actually gates the delete.
  const real = await page.evaluate(async ()=>{
    window._demoMode=false;
    C.companies=[{id:'co1',name:'Acme'}];
    _timeOff=[{id:'to1',emp_id:'e1',emp_name:'Ana',kind:'vacation',start_date:'2026-09-01',
               end_date:'2026-09-02',hours_per_day:8,status:'approved',company_id:'co1'}];
    let deleted=false;
    DB.del = async ()=>{ deleted=true; return []; };
    window.refreshTimeOff = async ()=>{}; window.renderTimeOff = ()=>{};
    window.showToast = ()=>{};

    const p1 = deleteTimeOff('to1');
    await new Promise(r=>setTimeout(r,80));
    const promptShown = document.getElementById('uiDialog').classList.contains('open');
    document.getElementById('uiDlgCancel').click();
    await p1;
    const afterCancel = deleted;

    const p2 = deleteTimeOff('to1');
    await new Promise(r=>setTimeout(r,80));
    document.getElementById('uiDlgOk').click();
    await p2;
    return {promptShown, afterCancel, afterConfirm: deleted};
  });
  ok('a real delete asks before acting', real.promptShown);
  ok('cancelling the styled prompt does NOT delete', real.afterCancel===false);
  ok('confirming it does delete', real.afterConfirm===true);

  ok('no native browser dialog was triggered', native===0, String(native));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
