// Adding a punch for a day someone forgot entirely.
//
// Reported by a customer (Connoisseur Culture, 2026-08-30): an employee missed BOTH punches on
// 2026-08-26, and the Add Punch dialog refused every way of fixing it. The IN was rejected
// because the next punch (the following day's IN) is also an IN; the OUT was rejected because
// no IN existed yet. The day was unrepairable in both directions.
//
// These checks pin the repair open: the paired entry writes both punches, the forward-looking
// sequence complaint is a confirmable warning rather than a wall, and the checks that actually
// prevent double-counted hours still refuse.
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

// Chantal's real shape: clocked out 08-25, nothing at all on 08-26, clocked in again 08-27 08:44.
const HISTORY = [
  {id:'p1',emp_id:'e1',type:'IN', punch_date:'2026-08-25',punch_time:'08:40:00',punched_at:'2026-08-25T12:40:00.000Z'},
  {id:'p2',emp_id:'e1',type:'OUT',punch_date:'2026-08-25',punch_time:'16:30:00',punched_at:'2026-08-25T20:30:00.000Z'},
  {id:'p3',emp_id:'e1',type:'IN', punch_date:'2026-08-27',punch_time:'08:44:00',punched_at:'2026-08-27T12:44:00.000Z'},
];

async function setup(page, history=HISTORY){
  await page.evaluate(h=>{
    window._demoMode=false;
    Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t'}, false);
    C.companies=[{id:'co1',name:'Connoisseur',admin_id:'a1'}];
    C.sites=[{id:'s1',name:'WIN1',company_id:'co1'}];
    C.employees=[{id:'e1',name:'Chantal Arruda',site_id:'s1',company_id:'co1',active:true}];
    C.punches=[];
    Ctx.set({co:{id:'co1',name:'Connoisseur'},site:{id:'s1',name:'WIN1'}});
    document.body.classList.add('role-resolved','role-admin');
    window.__hist=h.slice();
    window.__inserted=[];
    DB.all=async(table)=> table==='punches' ? window.__hist.slice() : [];
    DB.insert=async(table,rows)=>{
      const arr=Array.isArray(rows)?rows:[rows];
      arr.forEach((r,i)=>window.__inserted.push(r));
      return arr.map((r,i)=>({...r,id:'new'+i}));
    };
    window.loadActivityPage=async()=>{};
    window.__confirms=[];
    window.uiConfirm=async(msg)=>{window.__confirms.push(msg);return window.__confirmAnswer!==false;};
  }, history);
}

const fill = (page, {type,date,tin,tout}) => page.evaluate(v=>{
  openAddPunchModal();
  document.getElementById('addPunchEmp').value='e1';
  document.getElementById('addPunchType').value=v.type;
  _onAddPunchTypeChange();
  document.getElementById('addPunchDate').value=v.date;
  document.getElementById('addPunchTime').value=v.tin;
  if(v.tout!=null) document.getElementById('addPunchTimeOut').value=v.tout;
  _checkAddPunchOvernight();
}, {type,date,tin,tout});

const result = page => page.evaluate(()=>({
  inserted: window.__inserted.map(p=>`${p.type} ${p.punch_date} ${p.punch_time}`),
  msg: (document.getElementById('addPunchMsg')||{}).innerText||'',
  confirms: window.__confirms.slice(),
  overnightShown: getComputedStyle(document.getElementById('addPunchOvernight')).display!=='none',
}));

const browser=await chromium.launch();

for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ────────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await setup(page);

  // ── The exact report: a whole forgotten day, 08:45 to 16:30 on 2026-08-26.
  await fill(page,{type:'SHIFT',date:'2026-08-26',tin:'08:45:00',tout:'16:30:00'});
  await page.evaluate(()=>saveAddPunch());
  await page.waitForTimeout(150);
  let r=await result(page);
  ok('a fully forgotten day can be repaired', r.inserted.length===2, r.inserted.join(' | ')||r.msg);
  ok('it writes the IN and the OUT, in order',
     r.inserted[0]==='IN 2026-08-26 08:45:00' && r.inserted[1]==='OUT 2026-08-26 16:30:00',
     r.inserted.join(' | '));
  ok('and does not stop to ask', r.confirms.length===0, r.confirms.join(' / '));

  // ── The paired entry is the default, so the common repair needs no discovery.
  await page.evaluate(()=>{openAddPunchModal();});
  ok('paired entry is the default type',
     await page.evaluate(()=>document.getElementById('addPunchType').value==='SHIFT'));

  // ── A single IN before a later IN is now a warning the admin can accept.
  await setup(page);
  await fill(page,{type:'IN',date:'2026-08-26',tin:'08:45:00'});
  await page.evaluate(()=>{window.__confirmAnswer=true;return saveAddPunch();});
  await page.waitForTimeout(150);
  r=await result(page);
  ok('a lone IN warns instead of blocking', r.confirms.length===1, r.confirms[0]?.slice(0,60)||'(none)');
  ok('and is written once accepted', r.inserted.length===1, r.inserted.join(' | ')||r.msg);

  // ── Declining the warning writes nothing.
  await setup(page);
  await fill(page,{type:'IN',date:'2026-08-26',tin:'08:45:00'});
  await page.evaluate(()=>{window.__confirmAnswer=false;return saveAddPunch();});
  await page.waitForTimeout(150);
  r=await result(page);
  ok('declining the warning writes nothing', r.inserted.length===0, r.inserted.join(' | '));

  // ── The check that actually protects hours still refuses: already clocked in.
  await setup(page,[{id:'p1',emp_id:'e1',type:'IN',punch_date:'2026-08-26',punch_time:'08:00:00',punched_at:'2026-08-26T12:00:00.000Z'}]);
  await page.evaluate(()=>{window.__confirmAnswer=true;});
  await fill(page,{type:'IN',date:'2026-08-26',tin:'09:00:00'});
  await page.evaluate(()=>saveAddPunch());
  await page.waitForTimeout(150);
  r=await result(page);
  ok('a second IN while clocked in is still refused', r.inserted.length===0 && !!r.msg, r.msg.slice(0,60));
  ok('and it is refused, not merely confirmed away', r.confirms.length===0, r.confirms.join(' / '));

  // ── A pair that would swallow an existing punch is refused outright.
  await setup(page,[{id:'p9',emp_id:'e1',type:'IN',punch_date:'2026-08-26',punch_time:'12:00:00',punched_at:'2026-08-26T16:00:00.000Z'}]);
  await fill(page,{type:'SHIFT',date:'2026-08-26',tin:'08:45:00',tout:'16:30:00'});
  await page.evaluate(()=>saveAddPunch());
  await page.waitForTimeout(150);
  r=await result(page);
  ok('a shift wrapping an existing punch is refused', r.inserted.length===0 && !!r.msg, r.msg.slice(0,70));

  // ── Overnight shift: the OUT lands on the next day, and the dialog says so first.
  await setup(page,[]);
  await fill(page,{type:'SHIFT',date:'2026-08-26',tin:'22:00:00',tout:'06:00:00'});
  r=await result(page);
  ok('an overnight shift is flagged before saving', r.overnightShown);
  await page.evaluate(()=>saveAddPunch());
  await page.waitForTimeout(150);
  r=await result(page);
  ok('and its OUT is written on the following day',
     r.inserted[1]==='OUT 2026-08-27 06:00:00', r.inserted.join(' | ')||r.msg);

  // ── Copy is translated in both languages.
  await setup(page,[]);
  await fill(page,{type:'SHIFT',date:'2026-08-26',tin:'08:45:00',tout:'16:30:00'});
  const labels=await page.evaluate(()=>document.getElementById('addPunchModal').innerText);
  ok('no raw i18n keys in the dialog', !/addPunch\.[a-zA-Z]/.test(labels),
     (labels.match(/addPunch\.[a-zA-Z]+/g)||[]).join(','));
  // Matched on words that cannot appear in the English copy. An earlier version of this check
  // tested for "entr" and was satisfied by the English word "entry", so it passed while the
  // dialog's title and hint were not translated at all.
  if(lang==='fr') ok('the dialog is actually in French',
     /Ajouter un pointage/.test(labels) && /Quart complet/.test(labels) && !/Add Punch Record/.test(labels),
     labels.split('\n')[0]);
  if(lang==='en') ok('the dialog reads in English',
     /Add Punch Record/.test(labels) && /Full shift/.test(labels), labels.split('\n')[0]);

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
