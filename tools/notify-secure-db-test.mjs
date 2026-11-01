// The four mail functions that browsers used to call directly (notify-missed-punch, notify-time-off,
// send-period-summary, churn-survey) are now only called by secure-db, which checks who is asking.
// This checks the PAGES: every trigger goes to secure-db with the right action and proof, and nothing in
// the apps still posts to those functions. The network is stubbed (nothing is sent); the server side is
// covered by tools/secure-db-regression/diff-test.mjs (groups notify, survey, period).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
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
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)});

console.log('── static: no page posts to the four functions any more ──');
for(const f of ['index.html','employee.html']){
  const src=await readFile(join(ROOT,f),'utf8');
  ok(`${f} has no direct call to churn-survey, notify-*, send-period-summary`, !/functions\/v1\/(churn-survey|notify-missed-punch|notify-time-off|send-period-summary)/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'')) );
}
{
  const src=await readFile(join(ROOT,'index.html'),'utf8');
  ok('index.html has no anonymous lookup of the admins table by e-mail', !/DB\.all\('admins',`email=eq\.\$\{encodeURIComponent\(email\)\}`\)/.test(src));
}

const browser=await chromium.launch();
const SITE='11111111-1111-4111-8111-111111111111';
const E_ANN='00000000-0000-4000-8000-0000000000a1';
const forbidden=[];   // any request to the four functions
const calls=[];       // secure-db bodies
const rpcs=[];
async function wire(page){
  await page.route('**/functions/v1/**', async route=>{
    const url=route.request().url();
    if(/functions\/v1\/(churn-survey|notify-missed-punch|notify-time-off|send-period-summary)/.test(url)){ forbidden.push(url); return json(route,{ok:true}); }
    if(url.endsWith('/secure-db')){
      const b=JSON.parse(route.request().postData()||'{}'); calls.push(b);
      if(b.action==='kiosk_verify_pin') return json(route,{ok:true,proof:'proof-abc.sig',ttl:120000});
      if(b.action) return json(route,{ok:true,success:true,manual_sent:true,period:{start:'2026-10-01',end:'2026-10-14'},errors:[]});
      if(b.table==='admins'&&b.method==='GET') return json(route,[{id:'a1',name:'Owner',email:'o@x.ca',role:'admin',plan:'starter',status:'active',parent_admin_id:null,extra_seats:0,stripe_customer_id:'cus_x',scheduling_addon:false}]);
      if(b.table==='missed_punch_requests'&&b.method==='POST') return json(route,[{id:'m1'}],201);
      if(b.method==='GET'&&b.table==='employees') return json(route,[{id:E_ANN,name:'Ann Lee',emp_code:'A1',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:true}]);
      return json(route,[]);
    }
    return json(route,{});
  });
  await page.route('**/rest/v1/rpc/**', async route=>{
    const fn=route.request().url().split('/rpc/')[1]; const body=JSON.parse(route.request().postData()||'{}'); rpcs.push({fn,body});
    if(fn==='get_kiosk_bootstrap_v2') return json(route,{ok:true,site:{id:SITE,name:'Front desk',company_id:'co1',lang:'en'},company:{id:'co1',name:'Acme'},employees:[{id:E_ANN,name:'Ann Lee',emp_code:'A1',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:true}]});
    if(fn==='verify_admin_login') return json(route,[{id:'a1',name:'Owner',email:'o@x.ca',role:'admin',status:'active'}]);
    if(fn==='mint_admin_session') return json(route,{ok:true,session_token:'tok-minted'});
    if(fn==='submit_survey_response') return json(route,{ok:true,id:'r1',email:'cust@x.ca',company_name:'Cust Co'});
    if(fn==='portal_request_time_off') return json(route,[{id:'44444444-4444-4444-8444-444444444441'}]);
    return json(route,{});
  });
  await page.route('**/*.supabase.co/storage/**', r=>r.fulfill({status:404,body:''}));
}

// ── terminal: missed-punch report ──
{
  console.log('\n── terminal: a missed-punch report asks secure-db to notify ──');
  const page=await (await browser.newContext({viewport:{width:1100,height:900},permissions:['geolocation'],geolocation:{latitude:45.5,longitude:-73.5}})).newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await wire(page);
  await page.goto(`${BASE}/index.html?kiosk=${SITE}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof C!=='undefined'&&C.employees&&C.employees.length>0,null,{timeout:15000});
  calls.length=0;
  await page.evaluate(()=>{
    window._kioskPinProof={proof:'proof-abc.sig',exp:Date.now()+60000};
    _pendingMissedPunchReport={emp:C.employees[0],site:{id:Ctx.get().site.id},type:'IN',punch_date:'2026-10-30',fullTime:'09:00:00',notes:'forgot'};
  });
  await page.evaluate(()=>_finalizeMissedPunchReport());
  await page.waitForTimeout(600);
  const n=calls.find(c=>c.action==='notify_request');
  ok('the terminal asked secure-db to notify', !!n);
  ok('the request names the kind, the request id and the mode only', n&&n.body.kind==='missed_punch'&&n.body.request_id==='m1'&&n.body.mode==='submitted'&&Object.keys(n.body).length===3, JSON.stringify(n&&n.body));
  ok('it carries the employee PIN proof and the terminal site', n&&n.pinToken==='proof-abc.sig'&&n.kioskSiteId===SITE);
  ok('nothing was posted to a mail function', forbidden.length===0, forbidden.join(','));
  ok('no page error', errs.length===0, errs.join(' | '));
  await page.context().close();
}

// ── admin app ──
{
  console.log('\n── admin app: decisions, payroll test, login, survey ──');
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await wire(page);
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(()=>{ Sess.set({id:'a1',name:'Owner',email:'o@x.ca',role:'admin',plan:'starter',token:'tok-admin'},false); });
  calls.length=0;
  await page.evaluate(()=>notifyDecision('notify-missed-punch','m-1'));
  await page.evaluate(()=>notifyDecision('notify-time-off','t-1'));
  await page.waitForTimeout(300);
  const d1=calls.find(c=>c.action==='notify_request'&&c.body.kind==='missed_punch'), d2=calls.find(c=>c.action==='notify_request'&&c.body.kind==='time_off');
  ok('missed-punch decision goes to secure-db with the session token', d1&&d1.body.mode==='decision'&&d1.body.request_id==='m-1'&&d1.sessionToken==='tok-admin');
  ok('time-off decision goes to secure-db with the session token', d2&&d2.body.mode==='decision'&&d2.body.request_id==='t-1'&&d2.sessionToken==='tok-admin');

  calls.length=0;
  await page.evaluate(()=>{ _recipients=[{id:'r1',email:'a@b.ca'}]; window._recipCompanyId=()=>'co1'; });
  await page.evaluate(()=>testRecipient('r1'));
  await page.waitForTimeout(300);
  const p1=calls.find(c=>c.action==='send_period_summary');
  ok('the payroll test goes to secure-db with the company only', p1&&p1.body.mode==='test_recipients'&&p1.body.company_id==='co1'&&Object.keys(p1.body).length===2&&p1.sessionToken==='tok-admin', JSON.stringify(p1&&p1.body));

  // login: the token is minted first, then the admin row is read WITH it (no anonymous lookup)
  await page.evaluate(()=>{ Sess.clear&&Sess.clear(); });
  calls.length=0; rpcs.length=0;
  await page.evaluate(()=>{ document.getElementById('loginEmail').value='o@x.ca'; document.getElementById('loginPass').value='pw-123456'; });
  await page.evaluate(()=>doLogin());
  await page.waitForTimeout(800);
  const rowRead=calls.find(c=>c.table==='admins'&&c.method==='GET');
  ok('login reads the admin row once', !!rowRead);
  ok('the row is read with the freshly minted session token', rowRead&&rowRead.sessionToken==='tok-minted', String(rowRead&&rowRead.sessionToken));
  ok('the session stores the token and the billing id of the signed-in admin', await page.evaluate(()=>{const s=Sess.get();return !!s&&s.token==='tok-minted'&&s.stripe_customer_id==='cus_x';}));
  ok('no page error', errs.length===0, errs.join(' | '));

  // survey: team copy uses the survey token
  calls.length=0;
  await page.evaluate(()=>{ _surveyToken='aa11bb22cc33dd44aa11bb22cc33dd44'; _surveyRating=4; document.getElementById('surveyReason').value='price'; });
  await page.evaluate(()=>submitSurvey());
  await page.waitForTimeout(400);
  const sv=calls.find(c=>c.action==='survey_notify');
  ok('the survey asks secure-db for the team copy with its token only', sv&&sv.body.token==='aa11bb22cc33dd44aa11bb22cc33dd44'&&Object.keys(sv.body).length===1, JSON.stringify(sv&&sv.body));
  ok('nothing was posted to a mail function', forbidden.length===0, forbidden.join(','));
  await ctx.close();
}

// ── employee portal ──
{
  console.log('\n── employee portal: time-off request ──');
  const page=await (await browser.newContext({viewport:{width:480,height:900}})).newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await wire(page);
  await page.goto(`${BASE}/employee.html`,{waitUntil:'networkidle'});
  calls.length=0;
  await page.evaluate(()=>{
    _session={token:'ptok-1',employeeId:'e1'};
    window.renderTimeOff=async()=>{};
    for(const [id,v] of [['toStartInput','2026-12-01'],['toEndInput','2026-12-02'],['toKindInput','vacation'],['toReasonInput','trip']]){ const el=document.getElementById(id); if(el){ el.value=v; } }
  });
  await page.evaluate(()=>submitTimeOff());
  await page.waitForTimeout(500);
  const t=calls.find(c=>c.action==='notify_request');
  ok('the portal asks secure-db to notify, with its session token', t&&t.body.kind==='time_off'&&t.body.request_id==='44444444-4444-4444-8444-444444444441'&&t.body.mode==='submitted'&&t.body.portal_token==='ptok-1', JSON.stringify(t&&t.body));
  ok('nothing was posted to a mail function', forbidden.length===0, forbidden.join(','));
  ok('no page error', errs.length===0, errs.join(' | '));
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
