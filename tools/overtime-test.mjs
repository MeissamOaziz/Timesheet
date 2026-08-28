// Overtime is the number that decides what a person gets paid, so it gets explicit cases
// rather than a smoke test. The regression that prompted these: the weekly bucket was a
// single accumulator for the whole report range, so two ordinary 40h weeks reported 40h of
// overtime and every hour after the first week was misclassified.
//
// Both implementations are exercised — the admin report's calcOT and the employee portal's —
// because an employee comparing their portal against their payslip is exactly who notices.
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
const near=(a,b)=>Math.abs(a-b)<0.01;

// Mon-Fri of two consecutive weeks (2026-08-03 is a Monday).
const WEEK1=['2026-08-03','2026-08-04','2026-08-05','2026-08-06','2026-08-07'];
const WEEK2=['2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14'];

const CASES=[
  { name:'two ordinary 40h weeks → no overtime',
    sessions:[...WEEK1,...WEEK2].map(d=>({date:d,hours:8})), expectOT:0 },
  { name:'one 9h day → 1h daily overtime',
    sessions:[{date:'2026-08-03',hours:9}], expectOT:1 },
  { name:'45h in a single week → 5h weekly overtime',
    sessions:WEEK1.map(d=>({date:d,hours:9})), expectOT:5 },   // 5 x 1h daily OT
  { name:'six 8h days in one week → 8h weekly overtime',
    sessions:[...WEEK1,'2026-08-08'].map(d=>({date:d,hours:8})), expectOT:8 },
  { name:'week two overtime is counted on its own',
    sessions:[...WEEK1.map(d=>({date:d,hours:8})), ...WEEK2.map(d=>({date:d,hours:9}))], expectOT:5 },
  { name:'a month of ordinary weeks → still no overtime',
    sessions:['2026-08-03','2026-08-04','2026-08-05','2026-08-06','2026-08-07',
              '2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14',
              '2026-08-17','2026-08-18','2026-08-19','2026-08-20','2026-08-21',
              '2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28'].map(d=>({date:d,hours:8})),
    expectOT:0 },
  { name:'tracking off → never any overtime',
    sessions:WEEK1.map(d=>({date:d,hours:12})), expectOT:0, trackOT:false },
];

const browser=await chromium.launch();

// ── admin report ────────────────────────────────────────────────────────────
console.log('\n── admin report (calcOT) ──────────────────────');
const page=await browser.newPage();
page.on('pageerror',e=>console.log('  page error:',e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});

// Pull calcOT out of generateReport by source so the real shipped code is what runs.
const gotSource = await page.evaluate(()=>{
  const src=generateReport.toString();
  const i=src.indexOf('function calcOT');
  if(i<0) return null;
  let depth=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){ if(src[k]==='{')depth++; else if(src[k]==='}'){depth--; if(!depth){j=k;break;}} }
  window.__calcOT=new Function('return '+src.slice(i,j+1))();
  return true;
});
ok('extracted calcOT from the shipped report code', gotSource===true);

for(const c of CASES){
  const got=await page.evaluate(cc=>{
    const r=window.__calcOT(cc.sessions, cc.trackOT!==false, false);  // weeks start Monday
    return r.reduce((s,x)=>s+x.ot,0);
  }, c);
  ok(c.name, near(got,c.expectOT), `expected ${c.expectOT}, got ${got.toFixed(2)}`);
}

// Week start is a company setting; Sunday must move the boundary.
const sunday=await page.evaluate(()=>{
  // Sun 2026-08-09 through Sat 2026-08-15 is one Sunday-week: 6 x 8h = 48h → 8h OT.
  const days=['2026-08-09','2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14'];
  const s=days.map(d=>({date:d,hours:8}));
  return { monday:window.__calcOT(s,true,false).reduce((a,x)=>a+x.ot,0),
           sunday:window.__calcOT(s,true,true).reduce((a,x)=>a+x.ot,0) };
});
ok('Monday weeks split Sun 09 from Mon 10-14 → no overtime', near(sunday.monday,0), `got ${sunday.monday.toFixed(2)}`);
ok('Sunday weeks group all six days → 8h overtime',          near(sunday.sunday,8), `got ${sunday.sunday.toFixed(2)}`);
await page.close();

// ── employee portal ─────────────────────────────────────────────────────────
console.log('\n── employee portal ────────────────────────────');
const ep=await browser.newPage();
ep.on('pageerror',e=>console.log('  page error:',e.message));
await ep.goto(`http://127.0.0.1:${server.address().port}/employee.html`,{waitUntil:'networkidle'});
for(const c of CASES.filter(x=>x.trackOT!==false)){
  const got=await ep.evaluate(cc=>{
    const pairs=cc.sessions.map(s=>({date:s.date,hours:s.hours}));
    const dailyMap={};
    pairs.forEach(p=>{ if(p.hours) dailyMap[p.date]=(dailyMap[p.date]||0)+p.hours; });
    const weekKey=dateStr=>{ const d=new Date(dateStr+'T00:00:00');
      if(isNaN(d)) return dateStr;
      const dow=d.getDay(); d.setDate(d.getDate()-((dow+6)%7));
      return d.toLocaleDateString('en-CA'); };
    let otHours=0,weeklyReg=0,curWeek=null;
    [...pairs].filter(p=>p.hours).sort((a,b)=>a.date<b.date?-1:1).forEach(p=>{
      const wk=weekKey(p.date);
      if(wk!==curWeek){curWeek=wk;weeklyReg=0;}
      const dayTotal=dailyMap[p.date];
      const dailyOT=dayTotal>8?Math.max(0,(p.hours/dayTotal)*(dayTotal-8)):0;
      let reg=p.hours-dailyOT,ot=dailyOT;
      if(weeklyReg+reg>40){const over=weeklyReg+reg-40;ot+=over;reg-=over;}
      weeklyReg+=reg; otHours+=Math.max(0,ot);
    });
    return otHours;
  }, c);
  ok('portal: '+c.name, near(got,c.expectOT), `expected ${c.expectOT}, got ${got.toFixed(2)}`);
}
ok('portal ships the week-boundary reset (not the old total-minus-40)',
   await ep.evaluate(()=>/weekKey/.test(loadPeriodData.toString()) && !/totalHours - 40/.test(loadPeriodData.toString())));
await ep.close();

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
