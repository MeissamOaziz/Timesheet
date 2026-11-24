// Approving a missed-punch request when the shift already has a punch of the same type.
//
// Reported by the owner (2026-11-24): an employee forgot to clock out, a manager added the OUT by hand, then the
// employee's own request arrived with the correct time. Approval refused it ("two OUTs in a row") and there was no
// way to say "the employee's time is the right one". Now the admin is shown both and picks: use the request (the
// other punch is removed) or keep the existing one (the request is declined). Mirrors findTwin in the admin app.
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

// The real shape (times in Montréal, UTC-5 in November): IN 04:27 from the tablet, OUT 14:00 added by a manager,
// next morning's IN. The employee asks for OUT 14:08.
const SHIFT = [
  {id:'in1', emp_id:'e1',type:'IN', punch_date:'2026-11-22',punch_time:'04:27:13',punched_at:'2026-11-22T09:27:13.000Z',source:'kiosk',is_manual:false},
  {id:'man', emp_id:'e1',type:'OUT',punch_date:'2026-11-22',punch_time:'14:00:00',punched_at:'2026-11-22T19:00:00.000Z',source:'admin',is_manual:true},
  {id:'in2', emp_id:'e1',type:'IN', punch_date:'2026-11-23',punch_time:'04:42:44',punched_at:'2026-11-23T09:42:44.000Z',source:'kiosk',is_manual:false},
];
const REQ = {id:'r1',emp_id:'e1',emp_name:'Max Test',company_id:'co1',site_id:'s1',type:'OUT',requested_date:'2026-11-22',requested_time:'14:08:00',status:'pending'};

async function setup(page, history, answer, opts={}){
  await page.evaluate(({h,answer,opts})=>{
    window._demoMode=false;
    Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',token:'t'}, false);
    C.companies=[{id:'co1',name:'Acme Test Co',admin_id:'a1'}];
    C.sites=[{id:'s1',name:'Site 1',company_id:'co1'}];
    C.punches=[];
    window.__hist=h.slice();
    window.__log=[];
    DB.all=async(table,f)=> table==='punches' ? window.__hist.slice() : [];
    DB.insert=async(table,rows)=>{ const arr=Array.isArray(rows)?rows:[rows]; arr.forEach(r=>window.__log.push(['insert',table,r])); return arr.map((r,i)=>({...r,id:'new'+i})); };
    DB.del=async(table,f)=>{ window.__log.push(['del',table,f]); if(opts.failDeleteOf && f.includes(opts.failDeleteOf)) throw new Error('network down'); return []; };
    DB.update=async(table,f,b)=>{ window.__log.push(['update',table,f,b]); return []; };
    window.notifyDecision=()=>{ window.__log.push(['notify']); };
    window.renderMissedPunchRequests=async()=>{};
    window.__asked=[];
    window.uiChoose=async(msg,o)=>{ window.__asked.push({msg,title:o.title,labels:o.options.map(x=>x.label)}); return answer; };
    window.__confirms=[];
    window.uiConfirm=async(msg)=>{ window.__confirms.push(msg); return true; };
    window.__toasts=[];
    window.showToast=(m,k)=>{ window.__toasts.push([k,m]); };
  }, {h:history, answer, opts});
}
const run = (page, req, date, time) => page.evaluate(({req,date,time})=>_doApproveMissedPunch(req,date,time).then(()=>({
  log: window.__log, asked: window.__asked, toasts: window.__toasts, confirms: window.__confirms,
})), {req,date,time});

const browser=await chromium.launch();
const ctx=await browser.newContext({timezoneId:'America/Toronto', locale:'en-CA'});
const page=await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(()=>typeof _doApproveMissedPunch==='function' && typeof uiChoose==='function');

// 1. The owner's case: choose the employee's time.
await setup(page, SHIFT, 'request');
let r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('the admin is asked to choose', r.asked.length===1, JSON.stringify(r.asked[0]?.labels));
ok('the question names both times and who entered the old one', /14:08/.test(r.asked[0]?.msg) && /14:00/.test(r.asked[0]?.msg) && /manager/.test(r.asked[0]?.msg), r.asked[0]?.msg);
ok('the title says OUT without the badge symbol', /^Two OUT punches/.test(r.asked[0]?.title||''), r.asked[0]?.title);
const ins = r.log.filter(x=>x[0]==='insert');
ok('the request becomes a punch at 14:08', ins.length===1 && ins[0][2].type==='OUT' && ins[0][2].punch_time==='14:08:00' && ins[0][2].punched_at==='2026-11-22T19:08:00.000Z', JSON.stringify(ins[0]?.[2]));
ok('the manager\'s 14:00 is removed, after the insert', r.log.findIndex(x=>x[0]==='del' && x[2]==='id=eq.man') > r.log.findIndex(x=>x[0]==='insert'));
const upd = r.log.find(x=>x[0]==='update');
ok('the request is approved and linked to the new punch', upd && upd[3].status==='approved' && upd[3].punch_id==='new0', JSON.stringify(upd?.[3]));
ok('the employee is notified', r.log.some(x=>x[0]==='notify'));
ok('no error toast', !r.toasts.some(t=>t[0]==='error'), JSON.stringify(r.toasts));

// 2. Keep the manager's time: the request is declined, nothing else changes.
await setup(page, SHIFT, 'keep');
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('keep: no punch written or removed', !r.log.some(x=>x[0]==='insert'||x[0]==='del'));
ok('keep: the request is declined and the employee told', r.log.some(x=>x[0]==='update' && x[3].status==='denied') && r.log.some(x=>x[0]==='notify'));

// 3. Cancel: nothing at all.
await setup(page, SHIFT, null);
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('cancel: nothing written', r.log.length===0, JSON.stringify(r.log));

// 4. A clean request (no OUT yet that shift): no question, approved as before.
await setup(page, SHIFT.filter(p=>p.id!=='man'), 'request');
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('clean: not asked', r.asked.length===0);
ok('clean: one punch, request approved', r.log.filter(x=>x[0]==='insert').length===1 && r.log.some(x=>x[0]==='update' && x[3].status==='approved'));
ok('clean: nothing removed', !r.log.some(x=>x[0]==='del'));

// 5. An OUT with no IN anywhere near: still refused, no choice offered (removing the other OUT would not fix it).
const lonely=[{id:'o1',emp_id:'e1',type:'OUT',punch_date:'2026-11-22',punch_time:'14:00:00',punched_at:'2026-11-22T19:00:00.000Z',source:'admin',is_manual:true}];
await setup(page, lonely, 'request');
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('no IN: not asked, nothing written, an error is shown', r.asked.length===0 && r.log.length===0 && r.toasts.some(t=>t[0]==='error'), JSON.stringify(r.toasts));

// 6. The old punch cannot be removed: the new one is taken back out and the request stays pending.
await setup(page, SHIFT, 'request', {failDeleteOf:'id=eq.man'});
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('failed removal: the new punch is deleted again', r.log.some(x=>x[0]==='del' && x[2]==='id=eq.new0'), JSON.stringify(r.log.filter(x=>x[0]==='del')));
ok('failed removal: the request is not approved', !r.log.some(x=>x[0]==='update'));
ok('failed removal: an error is shown', r.toasts.some(t=>t[0]==='error'));

// 7. A same-type punch from another day (over 16 hours away) is not offered as the twin.
const yesterdayOut=[
  {id:'a',emp_id:'e1',type:'IN', punch_date:'2026-11-21',punch_time:'04:28:00',punched_at:'2026-11-21T09:28:00.000Z',source:'kiosk',is_manual:false},
  {id:'b',emp_id:'e1',type:'OUT',punch_date:'2026-11-21',punch_time:'14:15:00',punched_at:'2026-11-21T19:15:00.000Z',source:'kiosk',is_manual:false},
];
await setup(page, yesterdayOut, 'request');
r = await run(page, REQ, '2026-11-22', '14:08:00');
ok('other day: not asked, still refused', r.asked.length===0 && !r.log.some(x=>x[0]==='insert'));

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
