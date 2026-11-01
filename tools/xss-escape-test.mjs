// Stored-XSS regression test (security audit 2026-11-01, task 3). Text written by OTHER users (a join
// request, a kiosk punch name, a missed-punch request, a site / company / employee name set by a
// manager or co-admin) must never become markup or script in the viewer's browser, and the delete
// buttons must hand the hostile name to confirmDelete() as plain text instead of letting it break out
// of the inline handler. The network is stubbed; the real index.html renders the real tables.
//
// APP_ROOT=<dir> runs the same checks against another copy of the site (to prove the test fails on
// the code before the fix).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';

const ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json','.ico':'image/x-icon'};
const server=await new Promise(r=>{const s=createServer(async(q,res)=>{try{
  const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  const f=normalize(join(ROOT,rel));
  if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(f).pipe(res);}catch{res.writeHead(404).end();}});s.listen(0,'127.0.0.1',()=>r(s));});
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

// Payloads: tag injection, attribute breakout, JS string breakout, script close.
const P_TAG   = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const P_ATTR  = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">';
const P_JS    = "x');window.__xss=(window.__xss||0)+1;//";
const P_MIX   = "a\\'b\"c</script><svg onload=\"window.__xss=(window.__xss||0)+1\"> 'q' \\";
const NAMES = { tag:P_TAG, attr:P_ATTR, js:P_JS, mix:P_MIX };

const browser=await chromium.launch();
const ctx=await browser.newContext({viewport:{width:1280,height:900}});
await ctx.addInitScript(()=>{
  try{ localStorage.setItem('pc_sess',JSON.stringify({id:'00000000-0000-4000-8000-0000000000aa',name:'Owner',email:'owner@example.test',role:'admin',plan:'free',token:'tok-test'})); }catch(_){}
});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
page.on('dialog',d=>d.dismiss().catch(()=>{}));
await page.route('**/*', route=>{
  const u=route.request().url();
  if(u.startsWith(BASE)) return route.continue();
  if(/\.js(\?|$)/.test(u)) return route.fulfill({status:200,contentType:'text/javascript',body:''});
  if(/\.css(\?|$)|fonts\./.test(u)) return route.fulfill({status:200,contentType:'text/css',body:''});
  return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'[]'});
});
await page.goto(BASE+'/index.html',{waitUntil:'load'});
await page.waitForTimeout(800);

// Common stubs, then a helper that runs one renderer and reports what landed in the DOM.
await page.evaluate(()=>{
  window.__xss=0;
  window.refreshCache=async()=>{};
  window.loadAllWorkLabels=async()=>{};
  window.loadActivityVisitors=()=>{};
  window.ensureManagerSiteIds=async()=>{};
  window.__cd=[];
  window.confirmDelete=function(){ window.__cd.push([...arguments]); };
});

async function settle(){ await page.waitForTimeout(350); }
async function xssCount(){ return page.evaluate(()=>window.__xss||0); }
async function injected(sel){
  // any element that only a payload could have produced inside `sel`
  return page.evaluate(s=>{
    const root=document.querySelector(s); if(!root) return -1;
    return root.querySelectorAll('img[src="x"], svg[onload], img[onerror], [onerror], [onload]').length;
  },sel);
}

for(const [k,pl] of Object.entries(NAMES)){
  console.log(`\n== payload: ${k}`);

  // 1. Super admin: join requests table (requester_name, requester_email, target_admin_email)
  await page.evaluate(pl=>{
    window.__xss=0;
    DB.all=async(t)=> t==='join_requests'
      ? [{id:'11111111-1111-4111-8111-111111111111',requester_id:'22222222-2222-4222-8222-222222222222',requester_name:pl,requester_email:pl,target_admin_email:pl,created_at:new Date().toISOString(),status:'pending'}]
      : [];
    document.getElementById('joinRequestsSection').style.display='none';
  },pl);
  await page.evaluate(()=>renderJoinRequests());
  await settle();
  ok(`join requests: no markup injected (${k})`, (await injected('#joinRequestsBody'))===0 && (await injected('#joinReqCardsContainer'))<=0);
  ok(`join requests: payload shown as text (${k})`, await page.evaluate(p=>document.querySelector('#joinRequestsBody td')?.textContent===p,pl));
  ok(`join requests: approve button id is inert (${k})`, await page.evaluate(()=>{const b=document.querySelector('#joinRequestsBody .btn-primary');return !!b && /^approveJoinRequest\('[0-9a-f-]+','[0-9a-f-]+'\)$/.test(b.getAttribute('onclick'));}));

  // 2. Activity table: punches.emp_name (written through the kiosk), plus company and site names
  await page.evaluate(pl=>{
    window.__xss=0;
    const co={id:'c0000000-0000-4000-8000-000000000001',name:pl,admin_id:'a',week_start:'monday',payroll_frequency:'biweekly'};
    const site={id:'50000000-0000-4000-8000-000000000001',company_id:co.id,name:pl,description:pl};
    const emp={id:'e0000000-0000-4000-8000-000000000001',company_id:co.id,site_id:site.id,name:pl,emp_code:pl,dept:pl,email:pl,active:true,pin:'1234'};
    const today=new Date().toLocaleDateString('en-CA');
    C={companies:[co],sites:[site],employees:[emp],punches:[{id:'b0000000-0000-4000-8000-000000000001',company_id:co.id,site_id:site.id,emp_id:emp.id,emp_name:pl,type:'IN',punch_date:today,punch_time:'09:00:00',punched_at:new Date().toISOString(),is_manual:false,source:'kiosk'}],coAdmins:[]};
    Ctx.set({co:{id:co.id,name:co.name},site:null});
    DB.all=async()=>[];
  },pl);
  await page.evaluate(()=>{ const s=document.getElementById('actPeriod'); if(s) s.value='custom'; const a=document.getElementById('actStart'); if(a) a.value=new Date(Date.now()-864e5*2).toLocaleDateString('en-CA'); const b=document.getElementById('actEnd'); if(b) b.value=new Date(Date.now()+864e5).toLocaleDateString('en-CA'); });
  await page.evaluate(()=>loadActivityPage());
  await settle();
  ok(`activity table: no markup injected (${k})`, (await injected('#activityBody'))===0);
  ok(`activity table: emp_name shown as text (${k})`, await page.evaluate(p=>[...document.querySelectorAll('#activityBody tr')].some(tr=>tr.textContent.includes(p)),pl));
  ok(`activity filters: no markup injected (${k})`, (await injected('#actEmpFilter'))===0 && (await injected('#actCoFilter'))===0);

  // 3. Missed-punch table (kiosk-written emp_name, reason)
  await page.evaluate(pl=>{
    window.__xss=0;
    DB.all=async(t)=> t==='missed_punch_requests'
      ? [{id:'d0000000-0000-4000-8000-000000000001',company_id:C.companies[0].id,site_id:C.sites[0].id,emp_id:C.employees[0].id,emp_name:pl,type:'IN',requested_date:'2026-10-01',requested_time:'09:00:00',reason:pl,status:'pending',created_at:new Date().toISOString()}]
      : [];
  },pl);
  await page.evaluate(()=>renderMissedPunchRequests());
  await settle();
  const mp=await page.evaluate(()=>{ let n=0; document.querySelectorAll('.missedPunchSection').forEach(s=>{ n+=s.querySelectorAll('img[src="x"], svg[onload], [onerror], [onload]').length; }); return n; });
  ok(`missed punch table: no markup injected (${k})`, mp===0);
  ok(`missed punch table: emp_name shown as text (${k})`, await page.evaluate(p=>[...document.querySelectorAll('.missedPunchSection')].some(s=>s.textContent.includes(p)),pl));

  // 4. Delete buttons: site, employee, company (inline handler string breakout)
  await page.evaluate(()=>{ window.__cd=[]; });
  await page.evaluate(()=>loadSitesPage());
  await settle();
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#sitesGrid button')].find(x=>/confirmDelete\(/.test(x.getAttribute('onclick')||'')); if(b) b.click(); });
  await page.evaluate(()=>renderSitesAdmin());
  await settle();
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#siteListAdmin button')].find(x=>/confirmDelete\(/.test(x.getAttribute('onclick')||'')); if(b) b.click(); });
  await page.evaluate(()=>renderEmployees());
  await settle();
  await page.evaluate(()=>{ [...document.querySelectorAll('#empTableBody button, #empCardsContainer button')].filter(x=>/confirmDelete\(/.test(x.getAttribute('onclick')||'')).forEach(b=>b.click()); });
  await page.evaluate(()=>loadCompaniesPage());
  await settle();
  await page.evaluate(()=>{ const b=[...document.querySelectorAll('#companyGrid button')].find(x=>/confirmDelete\(/.test(x.getAttribute('onclick')||'')); if(b) b.click(); });
  const cd=await page.evaluate(()=>window.__cd);
  const byType=t=>cd.filter(c=>c[0]===t);
  ok(`delete site: handler receives the exact name (${k})`, byType('site').length>=1 && byType('site').every(c=>c[2]===pl), `calls=${byType('site').length}`);
  ok(`delete employee: handler receives the exact name (${k})`, byType('emp').length>=1 && byType('emp').every(c=>c[2]===pl), `calls=${byType('emp').length}`);
  ok(`delete company: handler receives the exact name (${k})`, byType('company').length>=1 && byType('company').every(c=>c[2]===pl), `calls=${byType('company').length}`);
  ok(`site, employee and company lists: nothing injected (${k})`,
    (await page.evaluate(()=>document.querySelectorAll('#sitesGrid [onerror], #sitesGrid img[src="x"], #siteListAdmin [onerror], #siteListAdmin img[src="x"], #empTableBody [onerror], #empTableBody img[src="x"], #empCardsContainer [onerror], #companyGrid [onerror], #companyGrid img[src="x"]').length))===0);

  await page.waitForTimeout(250);
  ok(`no payload script ran (${k})`, (await xssCount())===0, `window.__xss=${await xssCount()}`);
}

// Co-admin list (invitee name and email, with the resend / cancel / delete handlers)
console.log('\n== co-admin list');
{
  const hostile=P_JS;
  await page.evaluate(h=>{
    window.__xss=0;
    window.deleteCoAdmin=function(){ window.__cd.push(['coadmin',...arguments]); };
    window.cancelInvitation=function(){ window.__cd.push(['cancelinv',...arguments]); };
    window.resendCoAdminInvite=function(){ window.__cd.push(['resend',...arguments]); };
    window.__cd=[];
    const me={id:'00000000-0000-4000-8000-0000000000aa',name:'Owner',email:'owner@example.test',role:'admin',status:'active'};
    DB.all=async(t)=> t==='admins' ? [me,{id:'33333333-3333-4333-8333-333333333333',name:h,email:h,role:'admin',status:'active',parent_admin_id:me.id,created_at:new Date().toISOString()}]
      : t==='invitations' ? [{id:'44444444-4444-4444-8444-444444444444',email:h,role:'admin',status:'pending',token:'55555555-5555-4555-8555-555555555555',expires_at:new Date(Date.now()+864e5).toISOString(),created_at:new Date().toISOString()}] : [];
  },hostile);
  const fn=await page.evaluate(()=>typeof loadCoAdmins);
  if(fn==='function'){
    await page.evaluate(()=>loadCoAdmins()); await settle();
    await page.evaluate(()=>{ document.querySelectorAll('#coAdminsTableBody button, #coAdminCardsContainer button').forEach(b=>{ if(/deleteCoAdmin|cancelInvitation|resendCoAdminInvite/.test(b.getAttribute('onclick')||'')) b.click(); }); });
    const cds=await page.evaluate(()=>window.__cd);
    ok('co-admin list: handlers receive exact strings, nothing executed', cds.length>0 && cds.every(c=>c.slice(1).every((v,i)=> i===0 || v===''||v===P_JS)) && (await xssCount())===0, `calls=${cds.length}`);
  } else { ok('co-admin list renderer present', false); }
}

ok('no page errors from the renderers', errs.filter(e=>!/Failed to fetch|NetworkError|Load failed|Unexpected end of input/.test(e)).length===0, errs.slice(0,2).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail?1:0);
