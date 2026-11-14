// Two things a customer found while testing with a road crew:
//  1. Copying a shift to other days / other employees skipped every day where the person already
//     had ANY shift, so the afternoon half of a split day (8:00-12:00 + 12:30-15:30) was never
//     copied. Only an overlapping shift may block a copy.
//  2. "Strict" location could not be saved on a site without an address, so there was no way to say
//     "location required, punch from anywhere". Strict now stands on its own.
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

// A paying owner with the scheduling add-on; every write is captured instead of sent.
await page.evaluate(()=>{
  window._demoMode=false;
  Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t',plan:'starter',scheduling_addon:true}, false);
  C.primaryAdmin={id:'a1',plan:'starter',scheduling_addon:true};
  C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
  C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
  C.employees=[
    {id:'e1',name:'Marie Lavoie',site_id:'s1',company_id:'co1',active:true},
    {id:'e2',name:'David Pham', site_id:'s1',company_id:'co1',active:true},
    {id:'e3',name:'Sofia Ricci',site_id:'s1',company_id:'co1',active:true}];
  Ctx.set({co:{id:'co1',name:'Acme'}});
  document.body.classList.add('role-resolved','role-admin');
  window.__ins=[]; window.__upd=[];
  DB.insert=async(t,b)=>{window.__ins.push({t,b});return[{id:'new'+window.__ins.length,...b}];};
  DB.update=async(t,f,b)=>{window.__upd.push({t,f,b});return[];};
  window.renderScheduleGrid=async()=>{};
  window.renderSitesAdmin=()=>{}; window.populateEmpSiteFilter=()=>{};
});

// ── 1. Shift copy ────────────────────────────────────────────────────────────
console.log('\n── Shift copy: split days ──');
const copy = await page.evaluate(async ()=>{
  const ws = schedGetWeekStart(_schedWeek);
  const day = i => { const d=new Date(ws); d.setDate(d.getDate()+i); return schedDateStr(d); };
  const D=[0,1,2,3,4].map(day);
  // Mornings already scheduled Mon-Fri for e1 and e2; e3 has an afternoon on Tuesday that overlaps.
  _schedShifts = [
    ...D.map((d,i)=>({id:'m1'+i,employee_id:'e1',shift_date:d,start_time:'08:00:00',end_time:'12:00:00'})),
    ...D.map((d,i)=>({id:'m2'+i,employee_id:'e2',shift_date:d,start_time:'08:00:00',end_time:'12:00:00'})),
    {id:'x3',employee_id:'e3',shift_date:D[1],start_time:'13:00:00',end_time:'17:00:00'},
  ];
  const sel=document.getElementById('schedCoFilter');
  if(sel && ![...sel.options].some(o=>o.value==='co1')){ const o=document.createElement('option'); o.value='co1'; sel.appendChild(o); }
  if(sel) sel.value='co1';
  openAddShiftModal('e1', D[0]);
  document.getElementById('shiftStart').value='12:30';
  document.getElementById('shiftEnd').value='15:30';
  _shiftCopyDays = new Set(D.slice(1));
  _shiftCopyEmps = new Set(['e2','e3']);
  window.__ins=[];
  await saveShift();
  const by = id => window.__ins.filter(x=>x.t==='shifts' && x.b.employee_id===id).map(x=>x.b.shift_date).sort();
  const out = {D, e1:by('e1'), e2:by('e2'), e3:by('e3'),
    times:[...new Set(window.__ins.map(x=>x.b.start_time+'-'+x.b.end_time))]};

  // Same shift again, now that those afternoons exist: nothing may be doubled.
  _schedShifts = _schedShifts.concat(window.__ins.map((x,i)=>({id:'n'+i,...x.b,start_time:x.b.start_time+':00',end_time:x.b.end_time+':00'})));
  openAddShiftModal('e1', D[0]);
  document.getElementById('shiftStart').value='13:00';
  document.getElementById('shiftEnd').value='14:00';
  _shiftCopyDays = new Set(D.slice(1));
  _shiftCopyEmps = new Set(['e2']);
  window.__ins=[];
  await saveShift();
  out.second = window.__ins.map(x=>x.b.employee_id+'@'+x.b.shift_date);

  // Back-to-back is not an overlap: 12:00-13:00 next to 08:00-12:00 must copy.
  out.touching = _shiftClash('e1', D[2], '12:00', '12:30');
  out.inside   = _shiftClash('e1', D[2], '09:00', '10:00');
  out.otherDay = _shiftClash('e3', D[2], '16:00', '17:00');   // e3's 13:00-17:00 is on Tuesday, not Wednesday
  return out;
});
ok('afternoon shift lands on all 5 days for the employee', copy.e1.length===5, JSON.stringify(copy.e1));
ok('"also assign to" gives the second employee all 5 days', copy.e2.length===5, JSON.stringify(copy.e2));
ok('an employee with an overlapping shift is skipped only on that day', copy.e3.length===4 && !copy.e3.includes(copy.D[1]), JSON.stringify(copy.e3));
ok('copies keep the same hours', copy.times.length===1 && copy.times[0]==='12:30-15:30', copy.times.join(','));
ok('an overlapping shift is never doubled by a copy', copy.second.length===1 && copy.second[0]==='e1@'+copy.D[0], JSON.stringify(copy.second));
ok('back-to-back shifts do not count as overlapping', copy.touching===false);
ok('a shift inside another counts as overlapping', copy.inside===true);
ok('a shift on another day never blocks', copy.otherDay===false);

// Copy last week: last week had split days, this week already has the mornings.
console.log('\n── Copy last week: split days ──');
const lw = await page.evaluate(async ()=>{
  const ws = schedGetWeekStart(_schedWeek);
  const day = i => { const d=new Date(ws); d.setDate(d.getDate()+i); return schedDateStr(d); };
  const prev = [];
  for(let i=0;i<5;i++){
    prev.push({employee_id:'e1',company_id:'co1',site_id:'s1',shift_date:day(i-7),start_time:'08:00:00',end_time:'12:00:00',note:''});
    prev.push({employee_id:'e1',company_id:'co1',site_id:'s1',shift_date:day(i-7),start_time:'12:30:00',end_time:'15:30:00',note:''});
  }
  DB.all = async () => prev;
  _schedShifts = [0,1,2,3,4].map(i=>({id:'m'+i,employee_id:'e1',shift_date:day(i),start_time:'08:00:00',end_time:'12:00:00'}));
  window.__ins=[];
  await copyLastWeekForEmployee('e1');
  const one = window.__ins.map(x=>x.b.start_time);
  _schedShifts = [];
  window.__ins=[];
  await copyLastWeekForEmployee('e1');
  return {one, empty: window.__ins.length};
});
ok('only the missing afternoons are copied when mornings exist', lw.one.length===5 && lw.one.every(s=>s==='12:30:00'), JSON.stringify(lw.one));
ok('an empty week still gets both halves of every split day', lw.empty===10, String(lw.empty));

// ── 2. Strict location without an address ───────────────────────────────────
console.log('\n── Site: strict location with no address ──');
const geo = await page.evaluate(async ()=>{
  const out={};
  const save = async () => { window.__upd=[]; await saveSite(); return window.__upd.find(x=>x.t==='sites')?.b; };
  const open = site => { C.sites=[site]; editSite(site.id); };

  open({id:'s1',name:'Road crew',company_id:'co1',geo_lat:null,geo_lng:null,geo_radius_m:null,geo_strict:false});
  out.locked = window._geoLocked;
  out.plain = await save();

  open({id:'s1',name:'Road crew',company_id:'co1',geo_lat:null,geo_lng:null,geo_radius_m:null,geo_strict:false});
  selectGeoMode('strict');
  out.strictNoAddr = await save();

  // Re-open a strict site that has no address: the choice must be visible and survive a plain save.
  open({id:'s1',name:'Road crew',company_id:'co1',geo_lat:null,geo_lng:null,geo_radius_m:null,geo_strict:true});
  out.sectionOpen = document.getElementById('geoExpandedSection').style.display !== 'none';
  out.strictShown = document.getElementById('geoModeStrict').classList.contains('active');
  out.resave = await save();

  // "Remove Geofence" turns the rule off entirely.
  open({id:'s1',name:'Shop',company_id:'co1',geo_lat:45.5,geo_lng:-73.6,geo_radius_m:150,geo_strict:true});
  out.withAddr = await save();
  open({id:'s1',name:'Shop',company_id:'co1',geo_lat:45.5,geo_lng:-73.6,geo_radius_m:150,geo_strict:true});
  clearGeoFence();
  out.removed = await save();
  destroyGeoMap();
  return out;
});
ok('geofence section is unlocked on a paid plan', geo.locked===false);
ok('a site with nothing chosen saves strict off', geo.plain && geo.plain.geo_strict===false && geo.plain.geo_lat===null, JSON.stringify(geo.plain));
ok('Strict saves on a site with no address', geo.strictNoAddr && geo.strictNoAddr.geo_strict===true && geo.strictNoAddr.geo_lat===null && geo.strictNoAddr.geo_radius_m===null, JSON.stringify(geo.strictNoAddr));
ok('a strict site without an address opens with the section shown', geo.sectionOpen===true);
ok('...and Strict highlighted', geo.strictShown===true);
ok('...and stays strict when saved again', geo.resave && geo.resave.geo_strict===true, JSON.stringify(geo.resave));
ok('a strict geofence with an address is unchanged', geo.withAddr && geo.withAddr.geo_strict===true && geo.withAddr.geo_lat===45.5 && geo.withAddr.geo_radius_m===150, JSON.stringify(geo.withAddr));
ok('Remove Geofence clears the address and strict', geo.removed && geo.removed.geo_strict===false && geo.removed.geo_lat===null, JSON.stringify(geo.removed));

// The kiosk only checks location when the site has a point: a strict site without one must not block it.
const kiosk = await page.evaluate(()=>checkGeofence({id:'s1',geo_lat:null,geo_lng:null,geo_strict:true}));
ok('kiosk punch is not blocked at a strict site without an address', kiosk.ok===true && kiosk.status==='skipped', JSON.stringify(kiosk));

ok('no page errors', errs.length===0, errs.join(' | '));
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
