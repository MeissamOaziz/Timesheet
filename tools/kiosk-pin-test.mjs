// Kiosk PIN flow (security audit 2026-11-01). A terminal no longer receives anyone's PIN or email:
// the server checks the PIN and hands back a short-lived proof that the punch must carry.
// The network is stubbed, so this checks the page's behaviour only; the server side is covered by
// tools/secure-db-regression/diff-test.mjs (group kiosk-pin).
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
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

const SITE='11111111-1111-4111-8111-111111111111';
const E_ANN='00000000-0000-4000-8000-0000000000a1', E_BOB='00000000-0000-4000-8000-0000000000a2', E_NOPIN='00000000-0000-4000-8000-0000000000a3';
const PIN_OK='1234', PIN_BAD='0000', PIN_LOCK='9999';
const PROOF='proof-abc.sig';

const browser=await chromium.launch();
const ctx=await browser.newContext({viewport:{width:1100,height:900}, permissions:['geolocation'], geolocation:{latitude:45.5,longitude:-73.5}});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));

const calls=[];   // every request the page makes to secure-db or an RPC
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)});
await page.route('**/rest/v1/rpc/**', async route=>{
  const fn=route.request().url().split('/rpc/')[1];
  const body=JSON.parse(route.request().postData()||'{}');
  calls.push({kind:'rpc',fn,body});
  if(fn==='get_kiosk_bootstrap_v2'){
    return json(route,{ok:true,
      site:{id:SITE,name:'Front desk',company_id:'co1',lang:'en',geo_strict:false},
      company:{id:'co1',name:'Acme',punch_label_mode:'off',track_lunch_breaks:false,visitor_checkin_enabled:false},
      employees:[
        {id:E_ANN,name:'Ann Lee',emp_code:'A1',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:true},
        {id:E_BOB,name:'Bob Roy',emp_code:'A2',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:false},
        {id:E_NOPIN,name:'Nina NoPin',emp_code:'A3',site_id:SITE,company_id:'co1',active:true,has_pin:false,has_email:false}]});
  }
  if(fn==='get_kiosk_bootstrap') return json(route,{ok:false,error:'old bootstrap must not be used'});
  return json(route,{});
});
await page.route('**/functions/v1/secure-db', async route=>{
  const b=JSON.parse(route.request().postData()||'{}');
  calls.push({kind:'db',...b});
  if(b.action==='kiosk_verify_pin'){
    const pin=b.body&&b.body.pin;
    if(pin===PIN_OK) return json(route,{ok:true,proof:PROOF,ttl:120000});
    if(pin===PIN_LOCK) return json(route,{ok:false,locked:true,error:'Too many wrong PINs.'},429);
    return json(route,{ok:false,error:'incorrect'});
  }
  if(b.table==='punches'&&b.method==='POST') return json(route,[{id:'p1',...b.body}],201);
  if(b.table==='employees'&&b.method==='GET') return json(route,[
    {id:E_ANN,name:'Ann Lee',emp_code:'A1',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:true},
    {id:E_BOB,name:'Bob Roy',emp_code:'A2',site_id:SITE,company_id:'co1',active:true,has_pin:true,has_email:false},
    {id:E_NOPIN,name:'Nina NoPin',emp_code:'A3',site_id:SITE,company_id:'co1',active:true,has_pin:false,has_email:false}]);
  return json(route,[]);
});
await page.route('**/*.supabase.co/storage/**', r=>r.fulfill({status:404,body:''}));

const consoleLines=[]; page.on('console',m=>{ if(m.type()==='error'||m.type()==='warning') consoleLines.push(m.text().slice(0,200)); });
await page.goto(`${BASE}/index.html?kiosk=${SITE}`,{waitUntil:'networkidle'});
try{
  await page.waitForFunction(()=>typeof C!=='undefined'&&C.employees&&C.employees.length>0,null,{timeout:15000});
}catch(e){
  console.log('terminal never loaded. Requests seen:',JSON.stringify(calls.map(c=>c.fn||c.action||`${c.method} ${c.table}`)),'\nconsole:',consoleLines.join(' | '),'\npage errors:',errs.join(' | '));
  process.exit(1);
}

console.log('\n── terminal start-up ──');
ok('the terminal loads through the PIN-free bootstrap', calls.some(c=>c.fn==='get_kiosk_bootstrap_v2'));
ok('and never falls back to the old bootstrap', !calls.some(c=>c.fn==='get_kiosk_bootstrap'));
const emps=await page.evaluate(()=>C.employees.map(e=>({id:e.id,hasPinField:'pin' in e,hasEmailField:'email' in e,has_pin:e.has_pin})));
ok('no employee on the terminal carries a PIN or an email', emps.every(e=>!e.hasPinField&&!e.hasEmailField));
ok('each employee only says whether they have a PIN', emps.length===3&&emps[0].has_pin===true&&emps[2].has_pin===false);

const enterPin=async d=>{ for(const ch of d) await page.evaluate(c=>pinKey(c),ch); await page.waitForTimeout(700); };
const pick=async id=>{ await page.evaluate(i=>{const s=document.getElementById('empSelect'); s.value=i; s.dispatchEvent(new Event('change'));},id); };
const punchPosts=()=>calls.filter(c=>c.kind==='db'&&c.table==='punches'&&c.method==='POST');
const verifies=()=>calls.filter(c=>c.kind==='db'&&c.action==='kiosk_verify_pin');
const reset=async()=>{ await page.evaluate(()=>{ try{closeModal('pinModal');}catch(_){} try{resetPin();}catch(_){} window._kioskPinProof=null; }); };

console.log('\n── wrong PIN ──');
calls.length=0;
await pick(E_ANN);
await page.evaluate(()=>requestPunch('IN'));
await enterPin(PIN_BAD);
ok('the PIN was sent to the server, not compared in the page', verifies().length===1&&verifies()[0].body.pin===PIN_BAD&&verifies()[0].body.employee_id===E_ANN);
ok('the request names the terminal\'s site and the strict protocol', verifies()[0].kioskSiteId===SITE&&verifies()[0].kioskV===2);
ok('no punch is sent', punchPosts().length===0);
const msg1=await page.evaluate(()=>document.getElementById('pinErrorMsg').textContent);
ok('the person is told the PIN is wrong', /incorrect/i.test(msg1), msg1);
await reset();

console.log('\n── locked out ──');
calls.length=0;
await pick(E_ANN);
await page.evaluate(()=>requestPunch('IN'));
await enterPin(PIN_LOCK);
ok('no punch is sent when the server says locked', punchPosts().length===0);
const msg2=await page.evaluate(()=>document.getElementById('pinErrorMsg').textContent);
ok('the person is told to wait', /wait|too many/i.test(msg2), msg2);
await reset();

console.log('\n── right PIN ──');
calls.length=0;
await pick(E_ANN);
await page.evaluate(()=>requestPunch('IN'));
await enterPin(PIN_OK);
await page.waitForFunction(()=>true);
await page.waitForTimeout(800);
ok('the server was asked once', verifies().length===1);
ok('one punch is sent', punchPosts().length===1, JSON.stringify(punchPosts().map(p=>Object.keys(p))));
const post=punchPosts()[0]||{};
ok('the punch carries the proof the server issued', post.pinToken===PROOF, String(post.pinToken));
ok('the punch is for the employee who proved their PIN', post.body&&post.body.emp_id===E_ANN&&post.body.type==='IN');
ok('the punch names the terminal\'s site', post.kioskSiteId===SITE&&post.body&&post.body.site_id===SITE);
await reset();

console.log('\n── a proof is not reused for someone else ──');
calls.length=0;
await pick(E_BOB);
await page.evaluate(()=>requestPunch('IN'));
await enterPin(PIN_BAD);
ok('Bob needs his own PIN check (no punch without it)', punchPosts().length===0&&verifies().length===1);
await reset();

console.log('\n── employee without a PIN ──');
calls.length=0;
await pick(E_NOPIN);
await page.evaluate(()=>requestPunch('IN'));
await page.waitForTimeout(300);
ok('nothing is asked of the server', verifies().length===0&&punchPosts().length===0);
const shown=await page.evaluate(()=>document.body.innerText);
ok('the person is told no PIN is set', /no pin|pin set|PIN/i.test(shown));
await reset();

console.log('\n── page errors ──');
ok('no page errors', errs.length===0, errs.join(' | '));

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
