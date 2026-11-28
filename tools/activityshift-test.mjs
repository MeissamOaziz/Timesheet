// Activity "By shift": one row per clock-in and clock-out, with the hours worked out.
//
// The view is a reading aid over the same punches. These checks pin what it must never get wrong:
//   - a shift adds up to the same hours as its rows in a report (pairing, rounding, paid break)
//   - a label or site filter never strips a shift of its clock-out
//   - "Working now" is only said of a recent open shift; an old one is "No clock-out" with a fix button
//   - "Every punch" is exactly the table that was there before
//   - Free accounts and managers at another site get no edit or add controls
//   - names typed by a customer are shown as text
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
const near=(a,b)=>Math.abs(a-b)<0.01;

// Local-time punches, so the test reads the same in any time zone.
const P=(id,emp,type,date,time,extra={})=>({id,emp_id:emp,emp_name:extra.name||('Emp '+emp),type,punch_date:date,punch_time:time,
  punched_at:new Date(`${date}T${time}`).toISOString(),company_id:extra.co||'co1',site_id:extra.site||'s1',...extra});

async function boot(page, lang='en'){
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>{ try{localStorage.removeItem('pc_act_view');}catch(_){} setLang(l); },lang);
}
// A signed-in owner with stubbed data; nothing reaches the network.
async function setup(page, punches, o={}){
  await page.evaluate(({punches,o})=>{
    window._demoMode=false;
    Sess.set({id:'a1',email:'o@t.ca',status:'active',role:o.manager?'manager':'admin',token:'t'}, false);
    C.companies=[{id:'co1',name:'Acme Test Co',admin_id:'a1',punch_rounding:o.rounding||0,
      track_lunch_breaks:!!o.paidBreak,lunch_break_paid_minutes:o.paidBreak||0,forgot_out_hours:14}];
    C.sites=[{id:'s1',name:'Plateau',company_id:'co1'},{id:'s2',name:'Vieux-Port',company_id:'co1'}];
    C.employees=[{id:'e1',name:'Emp e1',site_id:'s1',company_id:'co1',active:true,emp_code:'A1'},
                 {id:'e2',name:'Emp e2',site_id:'s2',company_id:'co1',active:true},
                 {id:'e3',name:'Emp e3',site_id:'s1',company_id:'co1',active:true}];
    C.punches=punches;
    Ctx.set({co:{id:'co1',name:'Acme Test Co'},site:{id:'s1',name:'Plateau'}});
    document.body.classList.add('role-resolved','role-admin');
    document.getElementById('landingPage')?.classList.remove('show');
    window.refreshCache=async()=>{};
    window.ensureManagerSiteIds=async()=>{};
    window.loadAllWorkLabels=async()=>{};
    window.loadActivityVisitors=()=>{};
    window.isPaidCompany=()=>o.free?false:true;
    window.isCurrentCompanyPaid=()=>o.free?false:true;
    window.isManager=()=>!!o.manager;
    managerSiteIds=o.manager?o.manager:null;
    _allLabels=o.labels||[];
    DB.all=async()=>[];
    document.getElementById('actStart').value=''; document.getElementById('actEnd').value='';
  },{punches,o});
}
const open=async page=>{ await page.evaluate(async()=>{ navigate('activity'); await loadActivityPage(); }); await page.waitForTimeout(80); };
const shifts=(page,now)=>page.evaluate(n=>buildActShifts(C.punches,n).map(s=>({emp:s.empId,date:s.date,state:s.state,hours:s.hours,brk:s.breakMin,labels:s.labels,n:s.punches.length,inT:s.inP?.punch_time,outT:s.outP?.punch_time})),now);

const D='2026-11-17', D2='2026-11-18';
const browser=await chromium.launch();

// ── 1. Pairing and hours ────────────────────────────────────────────────────────────────────
{
  console.log('\n── pairing and hours');
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await boot(page);

  await setup(page,[P('1','e1','IN',D,'07:00:00'),P('2','e1','OUT',D,'14:30:00')]);
  let s=await shifts(page);
  ok('one IN and one OUT make one shift', s.length===1&&s[0].state==='done', JSON.stringify(s));
  ok('its hours are the gap', near(s[0].hours,7.5), String(s[0]?.hours));

  // lunch: 08:00 in, 12:00 out to break, 12:30 back, 16:30 out
  const lunch=[P('1','e1','IN',D,'08:00:00'),P('2','e1','OUT',D,'12:00:00',{is_break:true}),P('3','e1','IN',D,'12:30:00',{is_break:true}),P('4','e1','OUT',D,'16:30:00')];
  await setup(page,lunch);
  s=await shifts(page);
  ok('a lunch break stays inside one shift', s.length===1&&s[0].n===4, JSON.stringify(s));
  ok('an unpaid break is not counted as work', near(s[0].hours,8)&&near(s[0].brk,30), `${s[0]?.hours} h, break ${s[0]?.brk}`);
  ok('the shift runs from the first IN to the last OUT', s[0].inT==='08:00:00'&&s[0].outT==='16:30:00');
  await setup(page,lunch,{paidBreak:15});
  s=await shifts(page);
  ok('the paid part of a break counts, capped', near(s[0].hours,8.25), String(s[0]?.hours));

  // label switch: one shift, two labels
  await setup(page,[P('1','e1','IN',D,'08:00:00',{label_id:'L1'}),P('2','e1','OUT',D,'10:00:00',{is_switch:true}),P('3','e1','IN',D,'10:00:00',{is_switch:true,label_id:'L2'}),P('4','e1','OUT',D,'12:00:00')]);
  s=await shifts(page);
  ok('a label switch stays inside one shift', s.length===1&&near(s[0].hours,4), JSON.stringify(s));
  ok('and the shift carries both labels', s[0].labels.join()==='L1,L2', s[0]?.labels.join());

  // a real second shift the same day is its own row
  await setup(page,[P('1','e1','IN',D,'06:00:00'),P('2','e1','OUT',D,'10:00:00'),P('3','e1','IN',D,'17:00:00'),P('4','e1','OUT',D,'21:00:00')]);
  s=await shifts(page);
  ok('a split day (no break flag) is two shifts', s.length===2&&s.every(x=>near(x.hours,4)), JSON.stringify(s));

  // overnight
  await setup(page,[P('1','e1','IN',D,'22:00:00'),P('2','e1','OUT',D2,'06:00:00')]);
  s=await shifts(page);
  ok('an overnight shift is one row on the day it started', s.length===1&&s[0].date===D&&near(s[0].hours,8), JSON.stringify(s));

  // rounding follows the company setting, the same helper Reports uses
  await setup(page,[P('1','e1','IN',D,'08:07:00'),P('2','e1','OUT',D,'16:08:00')],{rounding:15});
  const want=await page.evaluate(()=>(_roundPunchMs(C.punches[1].punched_at,15)-_roundPunchMs(C.punches[0].punched_at,15))/3600000);
  s=await shifts(page);
  ok('hours use the company rounding', near(s[0].hours,want)&&!near(want,8.0167), `${s[0]?.hours} vs ${want}`);

  // open shifts
  const now=new Date(`${D2}T10:00:00`).getTime();
  await setup(page,[P('1','e1','IN',D2,'08:00:00'),                       // 2 h ago, latest punch
                    P('2','e2','IN',D,'06:00:00',{site:'s2'}),            // 28 h ago, never closed
                    P('3','e3','IN',D,'07:00:00'),P('4','e3','IN',D2,'07:00:00'),P('5','e3','OUT',D2,'09:00:00')]);
  s=await shifts(page,now);
  const by=e=>s.filter(x=>x.emp===e);
  ok('a recent open shift is "working"', by('e1')[0].state==='working'&&near(by('e1')[0].hours,2), JSON.stringify(by('e1')));
  ok('an open shift older than the forgot-out limit is "no clock-out"', by('e2')[0].state==='noout'&&by('e2')[0].hours===0, JSON.stringify(by('e2')));
  ok('an IN followed by another IN is "no clock-out", and the next shift is intact',
     by('e3').length===2&&by('e3')[0].state==='noout'&&by('e3')[1].state==='done'&&near(by('e3')[1].hours,2), JSON.stringify(by('e3')));

  await setup(page,[P('1','e1','OUT',D,'15:00:00'),P('2','e1','IN',D2,'08:00:00'),P('3','e1','OUT',D2,'12:00:00')]);
  s=await shifts(page);
  ok('an OUT with no IN before it is "no clock-in"', s.length===2&&s[0].state==='noin'&&s[1].state==='done', JSON.stringify(s));

  // parity with the Reports pairing on a busy week
  const week=[];let n=0;
  for(const d of ['2026-11-09','2026-11-10','2026-11-11']){
    week.push(P(String(++n),'e1','IN',d,'08:03:00'),P(String(++n),'e1','OUT',d,'12:01:00',{is_break:true}),P(String(++n),'e1','IN',d,'12:47:00',{is_break:true}),P(String(++n),'e1','OUT',d,'16:34:00'));
  }
  await setup(page,week,{rounding:5,paidBreak:30});
  const parity=await page.evaluate(()=>{
    const co=C.companies[0], eps=C.punches.slice().sort((a,b)=>new Date(a.punched_at)-new Date(b.punched_at));
    let rep=0,i=0;
    while(i<eps.length){ const p=eps[i]; if(p.type==='IN'){ const o=eps[i+1]?.type==='OUT'?eps[i+1]:null;
      if(o){ rep+=(_roundPunchMs(o.punched_at,co.punch_rounding)-_roundPunchMs(p.punched_at,co.punch_rounding))/3600000; i+=2; } else i++; } else i++; }
    for(let b=0;b<eps.length-1;b++){ const a=eps[b],c=eps[b+1];
      if(a.type==='OUT'&&a.is_break&&c.type==='IN'&&c.is_break) rep+=Math.min(new Date(c.punched_at)-new Date(a.punched_at),co.lunch_break_paid_minutes*60000)/3600000; }
    return {rep, mine:buildActShifts(C.punches).reduce((a,s)=>a+s.hours,0)};
  });
  ok('three days with breaks add up to the Reports total', near(parity.rep,parity.mine)&&parity.rep>20, `${parity.mine} vs ${parity.rep}`);
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

// ── 2. The page, EN and FR ──────────────────────────────────────────────────────────────────
const DAY=[P('1','e1','IN',D,'07:02:00',{name:'Aïsha Benali',label_id:'L1'}),P('2','e1','OUT',D,'14:52:00',{name:'Aïsha Benali'}),
           P('3','e2','IN',D,'06:05:00',{name:'Liam O\'Connor',site:'s2'}),
           P('4','e3','IN',D,'09:00:00',{name:'<img src=x onerror=window.__xss=1>'}),P('5','e3','OUT',D,'11:00:00',{name:'<img src=x onerror=window.__xss=1>'})];
const LABELS=[{id:'L1',name:'Kitchen',color:'#4f8ef7',company_id:'co1',active:true}];
for(const lang of ['en','fr']){
  console.log(`\n── page, ${lang.toUpperCase()}`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await boot(page,lang);
  await setup(page,DAY,{labels:LABELS});
  await page.evaluate(()=>{ window.hasSchedulingAddon=()=>true; window.loadAllWorkLabels=async()=>{}; });
  await open(page);
  let v=await page.evaluate(()=>({
    shift:getComputedStyle(document.getElementById('actShiftWrap')).display!=='none',
    punch:getComputedStyle(document.getElementById('actPunchWrap')).display!=='none',
    rows:document.querySelectorAll('#actShiftBody tr[data-shift-state]').length,
    days:document.querySelectorAll('#actShiftBody tr.act-day-row').length,
    text:document.getElementById('actShiftBody').innerText,
    seg:[...document.querySelectorAll('#actViewSeg button')].map(b=>b.textContent.trim()+':'+b.getAttribute('aria-pressed')).join(' | '),
    img:document.querySelectorAll('#actShiftBody img, #actShiftCards img').length, xss:!!window.__xss,
    punchRows:document.querySelectorAll('#activityBody tr').length,
    missing:__missingI18n().filter(k=>k.indexOf('activity.')===0),
  }));
  ok('Activity opens on By shift', v.shift&&!v.punch, v.seg);
  ok('the switch is labelled in this language', v.seg===(lang==='fr'?'Par quart:true | Chaque pointage:false':'By shift:true | Every punch:false'), v.seg);
  ok('three people, three rows, one day heading', v.rows===3&&v.days===1, `${v.rows} rows, ${v.days} days`);
  ok('a finished shift shows in, out and hours', /07:02/.test(v.text)&&/14:52/.test(v.text)&&/7 h 50/.test(v.text), v.text.slice(0,200).replace(/\n/g,' '));
  ok('the old open shift says no clock-out', v.text.includes(lang==='fr'?'Sortie manquante':'No clock-out'));
  ok('and offers the fix', v.text.includes(lang==='fr'?'Ajouter la sortie':'Add clock-out'));
  ok('the day heading counts shifts and hours', v.text.includes(lang==='fr'?'3 quarts':'3 shifts')&&/9 h 50/.test(v.text), v.text.split('\n')[0]);
  ok('the day is written out in this language', v.text.toLowerCase().includes(lang==='fr'?'mardi':'tuesday'), v.text.split('\n')[0]);
  ok('a customer-typed name is shown as text', v.img===0&&!v.xss&&v.text.includes('<img src=x'));
  ok('no missing translation', v.missing.length===0, v.missing.join());
  ok('every punch is still rendered underneath', v.punchRows===5, String(v.punchRows));

  // label filter keeps the clock-out; site filter narrows by the shift's site
  await page.evaluate(()=>{ initActLabelFilter(); document.getElementById('actLabelFilter').value='L1'; });
  await page.evaluate(()=>loadActivityPage()); await page.waitForTimeout(60);
  v=await page.evaluate(()=>({rows:document.querySelectorAll('#actShiftBody tr[data-shift-state]').length,
    state:document.querySelector('#actShiftBody tr[data-shift-state]')?.dataset.shiftState, text:document.getElementById('actShiftBody').innerText,
    punchRows:document.querySelectorAll('#activityBody tr .act-row-check').length}));
  ok('label filter: only the labelled shift, complete with its clock-out', v.rows===1&&v.state==='done'&&/14:52/.test(v.text), `${v.rows} ${v.state}`);
  ok('label filter: Every punch behaves as before (the IN only)', v.punchRows===1, String(v.punchRows));
  await page.evaluate(()=>{ document.getElementById('actLabelFilter').value='all'; updateActSiteFilter('all'); const s=document.getElementById('actSiteFilter');
    if(![...s.options].some(o=>o.value==='s2')){const o=document.createElement('option');o.value='s2';s.appendChild(o);} s.value='s2'; });
  await page.evaluate(()=>{ window.updateActSiteFilter=()=>{}; return loadActivityPage(); }); await page.waitForTimeout(60);
  v=await page.evaluate(()=>({rows:document.querySelectorAll('#actShiftBody tr[data-shift-state]').length,text:document.getElementById('actShiftBody').innerText}));
  ok('site filter: only that site\'s shift', v.rows===1&&v.text.includes('Liam'), `${v.rows}`);
  await page.evaluate(()=>{ document.getElementById('actSiteFilter').value='all'; return loadActivityPage(); }); await page.waitForTimeout(60);

  // switch to Every punch and back; the choice is remembered
  await page.click('#actViewPunch');
  v=await page.evaluate(()=>({shift:getComputedStyle(document.getElementById('actShiftWrap')).display!=='none',punch:getComputedStyle(document.getElementById('actPunchWrap')).display!=='none',
    rows:document.querySelectorAll('#activityBody tr .act-row-check').length, saved:localStorage.getItem('pc_act_view'),
    cols:document.querySelectorAll('#actPunchWrap thead th').length}));
  ok('Every punch shows the original table', v.punch&&!v.shift&&v.rows===5&&v.cols===7, JSON.stringify(v));
  ok('the choice is remembered', v.saved==='punch');
  await page.evaluate(()=>loadActivityPage()); await page.waitForTimeout(60);
  ok('and survives a refresh of the page data', await page.evaluate(()=>getComputedStyle(document.getElementById('actPunchWrap')).display!=='none'));
  await page.click('#actViewShift');

  // Add clock-out opens the normal window, filled in
  await page.click('#actShiftBody tr[data-shift-state="noout"] button.btn-primary');
  v=await page.evaluate(()=>({open:document.getElementById('addPunchModal').classList.contains('open')||getComputedStyle(document.getElementById('addPunchModal')).display!=='none',
    emp:document.getElementById('addPunchEmp').value,date:document.getElementById('addPunchDate').value,type:document.getElementById('addPunchType').value,
    outWrap:getComputedStyle(document.getElementById('addPunchOutWrap')).display}));
  ok('Add clock-out opens Add Punch for that person, day and side', v.open&&v.emp==='e2'&&v.date===D&&v.type==='OUT'&&v.outWrap==='none', JSON.stringify(v));
  await page.evaluate(()=>closeModal('addPunchModal'));

  // a time is a button that opens Edit for that punch
  const edited=await page.evaluate(()=>{ let got=null; window.openEditPunch=id=>{got=id;}; document.querySelector('#actShiftBody .act-time-btn').click(); return got; });
  ok('a time opens Edit for that punch', edited==='1'||edited==='4'||edited==='3', String(edited));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

// ── 3. Who may change things ────────────────────────────────────────────────────────────────
{
  console.log('\n── Free plan and managers');
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await boot(page);
  await setup(page,DAY,{free:true});
  await open(page);
  let v=await page.evaluate(()=>({btns:document.querySelectorAll('#actShiftBody .act-time-btn').length,rows:document.querySelectorAll('#actShiftBody tr[data-shift-state]').length}));
  ok('Free: shifts are shown', v.rows===3);
  ok('Free: times are not edit buttons', v.btns===0, String(v.btns));
  await page.click('#actShiftBody tr[data-shift-state="noout"] button.btn-primary');
  v=await page.evaluate(()=>({open:document.getElementById('addPunchModal').classList.contains('open'),gate:!!document.getElementById('activity-upgrade-hint')}));
  ok('Free: Add clock-out shows the plan message, not the window', !v.open&&v.gate, JSON.stringify(v));

  await setup(page,DAY,{manager:['s1']});
  await open(page);
  v=await page.evaluate(()=>({
    s2fix:[...document.querySelectorAll('#actShiftBody tr[data-shift-state="noout"]')].filter(r=>r.querySelector('button.btn-primary')).length,
    s1btn:document.querySelectorAll('#actShiftBody .act-time-btn').length}));
  ok('manager: no fix button on a shift at a site that is not theirs', v.s2fix===0, String(v.s2fix));
  ok('manager: their own site\'s times can be edited', v.s1btn>=2, String(v.s1btn));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

// ── 4. Phone width ──────────────────────────────────────────────────────────────────────────
for(const w of [360,390]){
  console.log(`\n── phone ${w}px`);
  const page=await browser.newPage({viewport:{width:w,height:800}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await boot(page,'fr');
  await setup(page,DAY);
  await open(page);
  const v=await page.evaluate(()=>({
    table:getComputedStyle(document.querySelector('#actShiftWrap table')).display,
    cards:document.querySelectorAll('#actShiftCards .mobile-card-row').length,
    cardsShown:getComputedStyle(document.getElementById('actShiftCards')).display!=='none',
    over:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    segW:document.getElementById('actViewSeg').getBoundingClientRect().right, vw:window.innerWidth}));
  ok('cards replace the table', v.table==='none'&&v.cardsShown&&v.cards===3, JSON.stringify(v));
  ok('nothing scrolls sideways', v.over<=0, String(v.over));
  ok('the switch fits', v.segW<=v.vw, `${v.segW} of ${v.vw}`);
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
