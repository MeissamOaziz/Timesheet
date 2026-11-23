// A saved sign-in must not keep the plan it had on the day of the login. A customer who paid from another
// device (or was upgraded or downgraded by us) used to keep the old plan in this browser until they signed
// out and in again: "Free" in the header and the plan list instead of the Scheduling checkout.
//   cd tools && node stale-plan-test.mjs
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
// saved = the plan stored in the browser, server = the owner's row as the server answers it (null = the read fails)
async function run({saved,server:row,role='admin',parent=null}){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const seen={ownRow:0,checkout:[]};
  await page.route('**/checkout',route=>{seen.checkout.push(JSON.parse(route.request().postData()||'{}').plan);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({error:'stopped by the test'})});});
  await page.route('**/rest/v1/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.route('**/functions/v1/secure-db',route=>{
    const b=JSON.parse(route.request().postData()||'{}');
    const j=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
    if(b.table==='admins'&&b.method==='GET'&&/select=created_at/.test(b.filter||'')){
      seen.ownRow++;
      if(!row) return route.fulfill({status:500,contentType:'application/json',body:'{"error":"down"}'});
      return j([{created_at:'2026-10-27T18:44:33Z',...row}]);
    }
    if(b.table==='companies'&&b.method==='GET') return j([{id:'co1',name:'Acme Fence',admin_id:'a1'}]);
    if(b.table==='sites'&&b.method==='GET') return j([{id:'s1',name:'S',company_id:'co1'}]);
    if(b.method==='GET') return j([]);
    return j({});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(a=>{
    window._demoMode=false;
    Sess.set({id:'a1',name:'Pat',email:'o@t.ca',status:'active',role:a.role,plan:a.saved.plan,extra_seats:a.saved.extra_seats||0,parent_admin_id:a.parent,token:'t'},true);
    Ctx.set({co:{id:'co1',name:'Acme Fence'},site:{id:'s1',name:'S'}});
    C.acctCreatedAt=null; C.acctCreatedFor=null;
  },{saved,role,parent});
  await page.evaluate(async()=>{ try{ await refreshCache(); }catch(e){ window._rcErr=String(e); } });
  const out=await page.evaluate(()=>({plan:Sess.get()?.plan,seats:Sess.get()?.extra_seats,name:getAdminPlan().name,err:window._rcErr||null,token:Sess.get()?.token}));
  await page.evaluate(()=>startSchedulingAddonCheckout());
  await page.waitForTimeout(300);
  await page.close();
  return {...out,...seen};
}

console.log('\n── the plan saved in the browser follows the server ─────────');
let r=await run({saved:{plan:'free'},server:{plan:'starter',extra_seats:0,scheduling_addon:false,scheduling_trial_ends_at:null}});
ok('saved Free, server Starter: the browser now says Starter', r.plan==='starter'&&r.name==='Starter', JSON.stringify(r));
ok('...and "Add Scheduling" goes to the checkout, not back to the plan list', r.checkout.length===1&&r.checkout[0]==='scheduling_addon', JSON.stringify(r.checkout));
ok('...the sign-in itself is untouched', r.token==='t');

r=await run({saved:{plan:'free'},server:{plan:'free',extra_seats:0,scheduling_addon:false,scheduling_trial_ends_at:null}});
ok('saved Free, server Free: stays Free', r.plan==='free'&&r.name==='Free');
ok('...and "Add Scheduling" still shows the plans first (no checkout)', r.checkout.length===0, JSON.stringify(r.checkout));

r=await run({saved:{plan:'starter'},server:{plan:'free',extra_seats:0,scheduling_addon:false,scheduling_trial_ends_at:null}});
ok('saved Starter, server Free (cancelled elsewhere): the browser now says Free', r.plan==='free'&&r.name==='Free', JSON.stringify(r));

r=await run({saved:{plan:'business'},server:{plan:'starter',extra_seats:2,scheduling_addon:false,scheduling_trial_ends_at:null}});
ok('saved Business is refreshed too (used to be skipped)', r.plan==='starter'&&r.ownRow===1, JSON.stringify(r));
ok('...extra seats follow the server', r.seats===2);

r=await run({saved:{plan:'starter',extra_seats:1},server:null});
ok('the read fails: the saved plan is kept, nothing is downgraded on an error', r.plan==='starter'&&r.seats===1&&!r.err, JSON.stringify(r));

r=await run({saved:{plan:'starter'},server:{extra_seats:null}});
ok('an answer without a plan changes nothing', r.plan==='starter', JSON.stringify(r));

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
