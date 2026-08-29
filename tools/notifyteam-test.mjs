// Publishing a week to the whole team. The two things that go wrong here are miscounting
// failures (the core returns {ok}, not a boolean) and mailing people who have no shifts.
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

// Three people with shifts (one with no email), one person with an email but no shifts.
const seed = (page, coreResult) => page.evaluate(cr=>{
  window._demoMode=false;
  C.companies=[{id:'co1',name:'Acme'}];
  C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
  C.employees=[
    {id:'e1',name:'Ana',   email:'ana@test.ca', site_id:'s1',company_id:'co1',active:true},
    {id:'e2',name:'Ben',   email:'ben@test.ca', site_id:'s1',company_id:'co1',active:true},
    {id:'e3',name:'Cleo',  email:null,          site_id:'s1',company_id:'co1',active:true},
    {id:'e4',name:'Dan',   email:'dan@test.ca', site_id:'s1',company_id:'co1',active:true},
  ];
  _schedShifts=[
    {employee_id:'e1',shift_date:'2026-08-31',start_time:'09:00:00',end_time:'17:00:00'},
    {employee_id:'e2',shift_date:'2026-09-01',start_time:'09:00:00',end_time:'17:00:00'},
    {employee_id:'e3',shift_date:'2026-09-02',start_time:'09:00:00',end_time:'17:00:00'},
  ];
  window.__sentTo=[]; window.__toasts=[]; window.__confirmText='';
  window.confirm = msg => { window.__confirmText=msg; return true; };
  const ot=window.showToast; window.showToast=(m,k)=>{window.__toasts.push(String(m));};
  window.sendScheduleEmailCore = async (email)=>{ window.__sentTo.push(email);
    return cr==='fail-ben' && email==='ben@test.ca' ? {ok:false,error:'boom'} : {ok:true}; };
}, coreResult);

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  ok('button exists on the schedule page', await page.evaluate(()=>
    !!document.getElementById('notifyTeamBtn')));

  // Demo mode must decline rather than pretending to mail sample people.
  await page.evaluate(()=>{ window._demoMode=true; window.__toasts=[];
    const o=window.showToast; window.showToast=m=>window.__toasts.push(String(m)); });
  await page.evaluate(()=>notifyTeamSchedule());
  ok('demo mode declines', await page.evaluate(()=>window.__toasts.length===1));

  await seed(page,'all-ok');
  await page.evaluate(()=>notifyTeamSchedule());
  await page.waitForTimeout(200);
  const r1 = await page.evaluate(()=>({sent:window.__sentTo, confirm:window.__confirmText, toasts:window.__toasts}));
  ok('mails only the people who have shifts AND an email',
     JSON.stringify(r1.sent)===JSON.stringify(['ana@test.ca','ben@test.ca']), r1.sent.join(', '));
  ok('does not mail someone with no shifts', !r1.sent.includes('dan@test.ca'));
  ok('warns about the scheduled person with no email',
     /Cleo/.test(r1.confirm), r1.confirm.replace(/\n/g,' | ').slice(0,90));
  ok('final toast reports 2 sent',
     /\b2\b/.test(r1.toasts[r1.toasts.length-1]), r1.toasts[r1.toasts.length-1]);
  ok('no raw i18n keys in any message',
     !/\bsched\.[a-zA-Z]+/.test(r1.confirm + r1.toasts.join(' ')));

  // The bug this nearly shipped with: {ok:false} counted as a success.
  await seed(page,'fail-ben');
  await page.evaluate(()=>notifyTeamSchedule());
  await page.waitForTimeout(200);
  const last = await page.evaluate(()=>window.__toasts[window.__toasts.length-1]);
  ok('a failed send is counted as failed, not silently as sent',
     /1/.test(last) && !/^.*\b2 employee|2 employé/.test(last), last);

  // Nothing scheduled at all.
  await page.evaluate(()=>{ _schedShifts=[]; window.__toasts=[]; window.__sentTo=[]; });
  await page.evaluate(()=>notifyTeamSchedule());
  ok('says so when the week is empty, and mails nobody', await page.evaluate(()=>
    window.__sentTo.length===0 && window.__toasts.length===1));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
