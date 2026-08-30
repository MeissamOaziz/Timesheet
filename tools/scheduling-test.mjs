// Scheduling: zero customers have ever created a shift, and the first thing every one of them
// saw was a locked page showing a price and nothing else. These checks cover the preview that
// replaced it — including that it is unmistakably labelled a sample and cannot write anything —
// plus the weekly-hours column and the delete control that was unreachable on a tablet.
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

// An owner on a paid plan WITHOUT the scheduling add-on — the state nobody has got past.
const asNonPayer = page => page.evaluate(()=>{
  window._demoMode=false;
  Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t',scheduling_addon:false}, false);
  C.primaryAdmin={id:'a1',scheduling_addon:false};
  C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
  C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
  C.employees=[
    {id:'e1',name:'Marie Lavoie',site_id:'s1',company_id:'co1',active:true},
    {id:'e2',name:'David Pham', site_id:'s1',company_id:'co1',active:true},
    {id:'e3',name:'Sofia Ricci',site_id:'s1',company_id:'co1',active:true}];
  Ctx.set({co:{id:'co1',name:'Acme'}});
  document.body.classList.add('role-resolved','role-admin');
  // Any write attempt during preview is a bug; make one visible if it happens.
  window.__writes=[];
  DB.insert=async(t,b)=>{window.__writes.push(t);return[];};
  DB.update=async(t)=>{window.__writes.push(t);return[];};
  renderSchedulePreview();
});

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await asNonPayer(page);
  await page.waitForTimeout(250);

  const prev = await page.evaluate(()=>{
    const host=document.getElementById('schedGridContent');
    return {rows:host.querySelectorAll('tbody tr').length,
            shifts:host.querySelectorAll('.sched-shift').length,
            names:[...host.querySelectorAll('.sched-emp-name')].map(n=>n.textContent),
            note:(host.querySelector('.sched-preview-note')||{}).innerText||'',
            cta:!!host.querySelector('.sched-preview-cta button'),
            text:host.innerText};
  });
  ok('a real week renders instead of an empty wall', prev.rows>0 && prev.shifts>10,
     `${prev.rows} rows, ${prev.shifts} shifts`);
  ok('it uses the account\'s own employees', prev.names.includes('Marie Lavoie'), prev.names.join(', '));
  ok('it is labelled a sample, unmistakably',
     /sample|exemple/i.test(prev.note) && /not your real|pas votre horaire/i.test(prev.note),
     prev.note.slice(0,72));
  ok('and says nothing is saved', /nothing here is saved|rien n.est enregistr/i.test(prev.note));
  ok('the buy action is present', prev.cta);
  ok('no raw i18n keys', !/\bsched\.[a-zA-Z]+/.test(prev.text),
     (prev.text.match(/\bsched\.[a-zA-Z]+/g)||[]).join(','));

  // The preview must be inert: no clicks through, no writes.
  const inert = await page.evaluate(()=>{
    const wrap=document.querySelector('.sched-preview-wrap');
    const pe=getComputedStyle(wrap).pointerEvents;
    document.querySelectorAll('.sched-preview-wrap .sched-shift').forEach(el=>el.click());
    return {pointerEvents:pe, writes:window.__writes.length,
            modalOpen:!!document.querySelector('.modal-overlay.open')};
  });
  ok('the sample grid is inert', inert.pointerEvents==='none', inert.pointerEvents);
  ok('clicking it writes nothing', inert.writes===0, String(inert.writes));
  ok('and opens no editor', !inert.modalOpen);
  ok('the Add Shift button stays hidden', await page.evaluate(()=>
     getComputedStyle(document.getElementById('addShiftBtn')).display==='none'));

  // Every control above the grid drives a schedule this account does not have: the filters render
  // empty, the week arrows move a sample that ignores them, and Holidays/Notify touch real data.
  const chrome = await page.evaluate(()=>['holidaysBtn','notifyTeamBtn','schedToolbar']
    .filter(id=>getComputedStyle(document.getElementById(id)).display!=='none'));
  ok('the locked page shows no dead controls', chrome.length===0, chrome.join(', '));

  // ...and the unlocked page gets all of them back — a session can flip without a reload.
  const restored = await page.evaluate(()=>{ schedChrome(true);
    return ['holidaysBtn','notifyTeamBtn','addShiftBtn','schedToolbar']
      .filter(id=>getComputedStyle(document.getElementById(id)).display==='none'); });
  ok('unlocking restores every control', restored.length===0, restored.join(', '));

  // Hours column arithmetic.
  const hours = await page.evaluate(()=>
    [...document.querySelectorAll('#schedGridContent td.sched-hours')].map(td=>parseFloat(td.textContent)));
  ok('every row shows its weekly hours', hours.length===prev.rows && hours.every(h=>h>0),
     hours.join(', '));
  ok('the totals are plausible for a work week', hours.every(h=>h>0 && h<=60), hours.join(', '));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

// ── the delete control on a touch device ──
console.log('\n── touch device ───────────────────────────────');
const touch=await browser.newContext({viewport:{width:820,height:1180}, hasTouch:true, isMobile:true});
const tp=await touch.newPage();
await tp.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
const del = await tp.evaluate(()=>{
  const d=document.createElement('div'); d.className='sched-shift';
  d.innerHTML='<span class="shift-delete">x</span>';
  document.body.appendChild(d);
  const cs=getComputedStyle(d.querySelector('.shift-delete'));
  return {opacity:parseFloat(cs.opacity), padding:cs.padding};
});
ok('the delete control is visible without hover', del.opacity>0.5, 'opacity '+del.opacity);
ok('and has a real touch target', parseFloat(del.padding)>=4, 'padding '+del.padding);
await touch.close();

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
