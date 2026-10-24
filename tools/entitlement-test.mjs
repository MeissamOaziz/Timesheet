// Plan entitlements: what Free, Starter and Growth accounts can use, and the 14-day / 2026-11-06 preview.
// The pricing page promises these; the app must do exactly that. Same rule as public.has_paid_features.
//   cd tools && node entitlement-test.mjs
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

// Put the page in the state of an admin on `plan`, whose account was created `created`, "now" being `now`.
async function setup(page,{plan='free',created='2026-10-01T12:00:00Z',now='2026-10-24T12:00:00Z',coName='Acme Fence',coAdmin=false}){
  await page.evaluate(a=>{
    const realNow=Date.now; const delta=Date.parse(a.now)-realNow();
    Date.now=()=>realNow()+delta;
    window._demoMode=false;
    Sess.set({id:'a1',email:'o@t.ca',status:'active',role:'admin',plan:a.plan,token:'t'},false);
    C.acctCreatedAt=a.created;
    C.companies=[{id:'co1',name:a.coName,admin_id:'a1',track_overtime:true,evening_start:'17:00',evening_days:null,payroll_frequency:'biweekly'}];
    C.sites=[{id:'s1',name:'S',company_id:'co1'}];
    C.employees=[];C.punches=[];
    Ctx.set({co:{id:'co1',name:a.coName},site:{id:'s1',name:'S'}});
    document.body.classList.add('role-resolved','role-admin');
    document.querySelectorAll('.upgrade-wall').forEach(e=>e.remove());
  },{plan,created,now,coName});
}
const q=(page,expr)=>page.evaluate(expr);

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ────────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>{errs.push(e.message);console.log('   [pageerror]',e.message,(e.stack||'').split('\n').slice(1,4).join(' | '));});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  // ── the window itself
  await setup(page,{plan:'free',created:'2026-10-01T12:00:00Z',now:'2026-10-24T12:00:00Z'});
  ok('Free, existing account, before 6 Nov: paid features available', await q(page,"featureEntitled('paid')"));
  ok('...and it counts as a preview', await q(page,'inPaidPreview()'));
  ok('...ending on 6 Nov', (await q(page,'paidPreviewEndText()')).includes('6'), await q(page,'paidPreviewEndText()'));
  ok('Growth features have no preview', !(await q(page,"featureEntitled('growth')")));

  await setup(page,{plan:'free',created:'2026-10-01T12:00:00Z',now:'2026-11-07T12:00:00Z'});
  ok('Free, existing account, after 6 Nov: paid features locked', !(await q(page,"featureEntitled('paid')")));
  ok('...and no longer a preview', !(await q(page,'inPaidPreview()')));
  ok('...isPaidCompany agrees (punch edit buttons, email reports)', !(await q(page,"isPaidCompany('co1')")));

  await setup(page,{plan:'free',created:'2026-11-01T12:00:00Z',now:'2026-11-10T12:00:00Z'});
  ok('Free, account created 1 Nov, on 10 Nov: still inside its 14 days', await q(page,"featureEntitled('paid')"));
  await setup(page,{plan:'free',created:'2026-11-01T12:00:00Z',now:'2026-11-16T12:00:00Z'});
  ok('...and locked on 16 Nov', !(await q(page,"featureEntitled('paid')")));

  await setup(page,{plan:'free',created:'2026-11-01T12:00:00Z',now:'2026-11-16T12:00:00Z'});
  await page.evaluate(()=>{C.acctCreatedAt=null;});
  ok('creation date not known yet: nothing is locked on a guess', await q(page,"featureEntitled('paid')"));

  for(const [plan,paid,growth] of [['starter',true,false],['growth',true,true],['business',true,true],['unlimited',true,true]]){
    await setup(page,{plan,created:'2026-01-01T12:00:00Z',now:'2026-11-20T12:00:00Z'});
    ok(`${plan}: paid features ${paid}, growth features ${growth}`, (await q(page,"featureEntitled('paid')"))===paid && (await q(page,"featureEntitled('growth')"))===growth);
  }
  await setup(page,{plan:'free',created:'2026-01-01T12:00:00Z',now:'2026-11-20T12:00:00Z',coName:'Connoisseur Culture'});
  ok('a grandfathered company keeps everything', await q(page,"featureEntitled('paid',C.companies[0])") && await q(page,"featureEntitled('growth',C.companies[0])"));

  // ── the screens: Free, after the preview
  await setup(page,{plan:'free',created:'2026-01-01T12:00:00Z',now:'2026-11-20T12:00:00Z'});
  await page.evaluate(()=>{ window.exportReport=()=>{window.__exported=true;}; window.__exported=false; guardedExport('excel'); });
  ok('Excel export is refused with the upgrade notice', !(await q(page,'window.__exported')) && await q(page,"!!document.getElementById('reports-upgrade-hint')"));
  await page.evaluate(()=>{ document.getElementById('reports-upgrade-hint')?.remove(); guardedExport('pdf'); });
  ok('PDF export stays free', await q(page,'window.__exported'));
  await page.evaluate(()=>{ window.openAddPunchModal=()=>{window.__addOpened=true;}; window.__addOpened=false; guardedAddPunch(); });
  ok('adding a punch is refused with the upgrade notice', !(await q(page,'window.__addOpened')) && await q(page,"!!document.getElementById('activity-upgrade-hint')"));

  await page.evaluate(()=>editCompany('co1'));
  ok('company settings: overtime is forced off and locked', await q(page,"document.getElementById('overtimeThumb').style.left!=='20px' && document.getElementById('otToggleRow').style.pointerEvents==='none'"));
  ok('company settings: evening hours are forced off and locked', await q(page,"!document.getElementById('companyEveningOn').checked && document.getElementById('eveningToggleRow').style.pointerEvents==='none'"));
  ok('company settings: the reason is shown', await q(page,"document.getElementById('paidFeatureNote').style.display!=='none' && document.getElementById('paidFeatureNoteText').textContent.length>20"));
  let saved=null;
  await page.evaluate(()=>{ window.__upd=null; DB.all=async()=>[]; window.refreshCache=async()=>{}; DB.update=async(t,f,b)=>{window.__upd={t,b};return [];}; window.uploadImage=async()=>null;
    document.getElementById('overtimeThumb').style.left='20px'; document.getElementById('companyEveningOn').checked=true; document.getElementById('companyEveningStart').value='17:00'; });
  await page.evaluate(()=>saveCompany()); await page.waitForTimeout(150);
  saved=await q(page,'window.__upd');
  ok('saving cannot switch overtime on, even if the toggle was forced', saved&&saved.t==='companies'&&saved.b.track_overtime===false, JSON.stringify(saved&&saved.b&&saved.b.track_overtime));
  ok('saving cannot switch evening hours on either', saved&&saved.b.evening_start===null&&saved.b.evening_end===null&&saved.b.evening_days===null);
  await page.evaluate(()=>closeModal('addCompanyModal'));

  await page.evaluate(()=>{ Ctx.set({co:{id:'co1',name:'Acme Fence'},site:{id:'s1',name:'S'}}); DB.all=async()=>[]; });
  await page.evaluate(()=>renderRecipients());
  ok('payroll summary card: add button hidden, upgrade offered', await q(page,"document.getElementById('recipAddBtn').style.display==='none' && !!document.querySelector('#recipList button')"));

  // ── Free, inside the preview: everything works, and says when it ends
  await setup(page,{plan:'free',created:'2026-10-20T12:00:00Z',now:'2026-10-24T12:00:00Z'});
  await page.evaluate(()=>{ window.exportReport=()=>{window.__exported=true;}; window.__exported=false; guardedExport('excel'); });
  ok('preview: Excel export works', await q(page,'window.__exported'));
  await page.evaluate(()=>{ window.openAddPunchModal=()=>{window.__addOpened=true;}; window.__addOpened=false; guardedAddPunch(); });
  ok('preview: adding a punch works', await q(page,'window.__addOpened'));
  await page.evaluate(()=>editCompany('co1'));
  ok('preview: overtime and evening hours stay on and editable', await q(page,"document.getElementById('overtimeThumb').style.left==='20px' && document.getElementById('companyEveningOn').checked && document.getElementById('otToggleRow').style.pointerEvents===''"));
  ok('preview: the note says when it ends', await q(page,"document.getElementById('paidFeatureNote').style.display!=='none' && /6/.test(document.getElementById('paidFeatureNoteText').textContent)"), await q(page,"document.getElementById('paidFeatureNoteText').textContent"));
  await page.evaluate(()=>closeModal('addCompanyModal'));
  await page.evaluate(()=>{ document.getElementById('dashboardContent')||document.body.insertAdjacentHTML('beforeend','<div id="dashboardContent"></div>'); renderPlanPreviewBanner(); });
  ok('preview: the dashboard banner is shown with the end date', await q(page,"!!document.getElementById('planPreviewBanner') && /6/.test(document.getElementById('planPreviewBanner').textContent)"));

  // ── paying accounts see no notices, no locks
  await setup(page,{plan:'starter',created:'2026-10-20T12:00:00Z',now:'2026-11-20T12:00:00Z'});
  await page.evaluate(()=>{ renderPlanPreviewBanner(); editCompany('co1'); });
  ok('Starter: no banner', await q(page,"!document.getElementById('planPreviewBanner')"));
  ok('Starter: overtime and evening hours unlocked, no note', await q(page,"document.getElementById('overtimeThumb').style.left==='20px' && document.getElementById('otToggleRow').style.pointerEvents==='' && document.getElementById('paidFeatureNote').style.display==='none'"));
  ok('Starter: lunch breaks still locked (Growth)', await q(page,"document.getElementById('lunchToggleRow').style.pointerEvents==='none'"));
  await page.evaluate(()=>closeModal('addCompanyModal'));

  ok('no page errors', errs.length===0, errs.join(' | '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
