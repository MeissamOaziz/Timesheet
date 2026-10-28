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
    document.querySelectorAll('.upgrade-wall:not(#toLockWall)').forEach(e=>e.remove());
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

  // ── Scheduling add-on: the free 14-day trial button
  const sched = async (o) => {
    await setup(page, { plan: 'free', created: '2026-01-01T12:00:00Z', now: '2026-11-20T12:00:00Z' });
    await page.evaluate(a => {
      document.getElementById('schedTrialBanner')?.remove();
      const s = Sess.get(); Object.assign(s, a.sess || {}); Sess.set(s);
      C.primaryAdmin = a.primary || null;
      if (!document.getElementById('schedGridContent')) document.body.insertAdjacentHTML('beforeend', '<div id="schedGridContent"></div>');
      window.schedChrome = () => {}; window.ensureManagerSiteIds = async () => {}; window.refreshCache = async () => {};
      window.onSchedCoChange = () => {}; window.checkHolidayReminder = () => {}; window.renderScheduleGrid = async () => { document.getElementById('schedGridContent').innerHTML = '<div id="realGrid"></div>'; };
      window.__toasts = []; window.showToast = (m) => window.__toasts.push(String(m));
      window.__trialCalls = 0;
      window.supaFetch = async (m, t, o) => {
        window.__trialCalls++;
        if (a.fail) throw new Error('The scheduling trial has already been used');
        return { ok: true, endsAt: new Date(Date.now() + 14 * 864e5).toISOString() };
      };
    }, o);
    await page.evaluate(() => loadSchedulePage());
  };
  const FUT = new Date(Date.parse('2026-11-20T12:00:00Z') + 9 * 864e5).toISOString(), PST = new Date(Date.parse('2026-11-20T12:00:00Z') - 3 * 864e5).toISOString();

  await sched({});
  ok('trial: an owner who never tried sees the free-trial button', await q(page, "!!document.getElementById('schedTrialBtn') && /14/.test(document.getElementById('schedTrialBtn').textContent)"), await q(page, "(document.getElementById('schedTrialBtn')||{}).textContent"));
  ok('trial: the paid option is still offered next to it', await q(page, "!!document.querySelector('.sched-preview-cta button.btn-secondary')"));
  ok('trial: before starting, scheduling is off', !(await q(page, 'hasSchedulingAddon()')));
  await page.evaluate(() => startSchedulingTrial()); await page.waitForTimeout(150);
  ok('trial: clicking asks the server once', (await q(page, 'window.__trialCalls')) === 1);
  ok('trial: scheduling is on, with a trial that ends in 14 days', await q(page, "schedulingTrialState().state==='active' && hasSchedulingAddon() && Math.round((schedulingTrialState().endsAt-Date.now())/864e5)===14"));
  ok('trial: the session remembers it (survives a reload)', await q(page, "!!Sess.get().scheduling_trial_ends_at"));
  ok('trial: the schedule opens with a "days left" reminder and a way to keep it', await q(page, "!!document.getElementById('schedTrialBanner') && /14|13/.test(document.getElementById('schedTrialBanner').textContent) && !!document.querySelector('#schedTrialBanner button')"), await q(page, "(document.getElementById('schedTrialBanner')||{}).textContent"));
  ok('trial: the real schedule replaces the sample week', await q(page, "!!document.getElementById('realGrid') && !document.querySelector('.sched-preview-note')"));

  await sched({ sess: { scheduling_trial_ends_at: FUT } });
  ok('trial running: scheduling is open, banner shows', await q(page, "hasSchedulingAddon() && !!document.getElementById('schedTrialBanner')"));
  await sched({ sess: { scheduling_trial_ends_at: PST } });
  ok('trial over: scheduling is closed again', !(await q(page, 'hasSchedulingAddon()')));
  ok('trial over: it says so, with the end date, and offers no second trial', await q(page, "!document.getElementById('schedTrialBtn') && /ended|a pris fin/.test(document.querySelector('.sched-preview-cta').textContent)"), await q(page, "document.querySelector('.sched-preview-cta').textContent.replace(/\s+/g,' ').slice(0,140)"));
  await sched({ sess: { scheduling_addon: true } });
  ok('paid: no trial banner, scheduling open', await q(page, "hasSchedulingAddon() && !document.getElementById('schedTrialBanner')"));
  await sched({ sess: { parent_admin_id: 'owner-1' }, primary: { id: 'owner-1', scheduling_trial_ends_at: null } });
  ok('co-admin, owner never tried: no button, told who can start it', await q(page, "!document.getElementById('schedTrialBtn') && /owner|propri/.test(document.querySelector('.sched-preview-cta').textContent)"));
  await sched({ sess: { parent_admin_id: 'owner-1' }, primary: { id: 'owner-1', scheduling_trial_ends_at: FUT } });
  ok("co-admin: the owner's running trial opens scheduling for the team", await q(page, 'hasSchedulingAddon()'));
  await sched({ fail: true });
  await page.evaluate(() => startSchedulingTrial()); await page.waitForTimeout(150);
  ok('trial refused by the server: button comes back, the reason is shown, nothing turns on', await q(page, "!document.getElementById('schedTrialBtn').disabled && window.__toasts.some(m=>/already been used/.test(m)) && !hasSchedulingAddon()"));

  // ── Geofencing, remote clock-in, the employee portal and time off are Starter-and-up too
  const lockSetup = async (plan, now, created = '2026-01-01T12:00:00Z') => {
    await setup(page, { plan, created, now });
    await page.evaluate(() => {
      C.companies[0].remote_punch_enabled = true; C.companies[0].name = 'Acme Fence';
      C.sites = [{ id: 's1', name: 'Main', company_id: 'co1', geo_lat: 45.5, geo_lng: -73.5, geo_radius_m: 100, geo_strict: false }];
      C.employees = [{ id: 'e1', name: 'Ann Lee', company_id: 'co1', site_id: 's1', active: true, remote_punch_enabled: true, email: 'ann@x.ca' }];
      window.__upd = []; DB.update = async (t, f, b) => { window.__upd.push({ t, b }); return []; }; DB.all = async () => []; window.refreshCache = async () => {}; window.uploadImage = async () => null;
      window.showToast = (m) => { (window.__toasts = window.__toasts || []).push(String(m)); };
      window.showUpgradePlans = () => { window.__plansShown = true; };
    });
  };
  const POST = '2026-11-20T12:00:00Z', PREV = '2026-10-24T12:00:00Z';

  // site modal
  await lockSetup('free', POST);
  await page.evaluate(() => editSite('s1'));
  ok('free after the preview: the geofence section is closed with the reason', await q(page, "document.getElementById('addSiteModal').classList.contains('paid-locked') && getComputedStyle(document.getElementById('geoExpandedSection')).display==='none' && getComputedStyle(document.getElementById('geoLockNote')).display==='block'"));
  await page.evaluate(() => saveSite()); await page.waitForTimeout(150);
  ok('...and saving the site leaves its geofence alone', await q(page, "window.__upd.length===1 && !('geo_lat' in window.__upd[0].b) && !('geo_strict' in window.__upd[0].b) && window.__upd[0].b.name==='Main'"), await q(page, 'JSON.stringify(window.__upd[0]&&window.__upd[0].b)'));
  await lockSetup('free', PREV);
  await page.evaluate(() => editSite('s1'));
  ok('free during the preview: the geofence section works', await q(page, "!document.getElementById('addSiteModal').classList.contains('paid-locked') && getComputedStyle(document.getElementById('geoLockNote')).display==='none'"));
  await page.evaluate(() => saveSite()); await page.waitForTimeout(150);
  ok('...and the geofence is saved', await q(page, "window.__upd.length===1 && window.__upd[0].b.geo_lat===45.5"), await q(page, 'JSON.stringify(window.__upd[0]&&window.__upd[0].b)'));
  await lockSetup('starter', POST);
  await page.evaluate(() => editSite('s1'));
  ok('starter: geofencing unlocked', await q(page, "!document.getElementById('addSiteModal').classList.contains('paid-locked')"));
  await page.evaluate(() => closeModal('addSiteModal'));

  // company modal: remote clock-in switch
  await lockSetup('free', POST);
  await page.evaluate(() => editCompany('co1'));
  ok('free after the preview: the remote clock-in switch is locked', await q(page, "document.getElementById('remotePunchToggleRow').style.pointerEvents==='none'"));
  await page.evaluate(() => { document.getElementById('remotePunchThumb').style.left = '2px'; saveCompany(); }); await page.waitForTimeout(200);
  ok('...and saving keeps the stored value, whatever the screen says', await q(page, "window.__upd.length>=1 && window.__upd[0].b.remote_punch_enabled===true"), await q(page, 'JSON.stringify(window.__upd[0]&&window.__upd[0].b.remote_punch_enabled)'));
  await lockSetup('starter', POST);
  await page.evaluate(() => { editCompany('co1'); document.getElementById('remotePunchThumb').style.left = '2px'; saveCompany(); }); await page.waitForTimeout(200);
  ok('starter: the switch is free to change', await q(page, "window.__upd.length>=1 && window.__upd[0].b.remote_punch_enabled===false && document.getElementById('remotePunchToggleRow').style.pointerEvents===''"));

  // employee modal: portal invitation and remote grant
  await lockSetup('free', POST);
  await page.evaluate(() => { editEmployee('e1'); });
  await page.waitForTimeout(150);
  ok('free after the preview: portal invitation and remote grant are hidden, the reason is shown', await q(page, "document.getElementById('addEmpModal').classList.contains('paid-locked') && getComputedStyle(document.getElementById('empPortalInviteRow')).display==='none' && getComputedStyle(document.getElementById('empRemotePunchRow')).display==='none' && getComputedStyle(document.getElementById('empPaidLockHint')).display==='block'"));
  await page.evaluate(() => { _selectedEmps.clear(); _selectedEmps.add('e1'); window.__upd = []; window.__plansShown = false; bulkToggleRemotePunch(true); }); await page.waitForTimeout(100);
  ok('...and bulk remote grants are refused with the upgrade offer', await q(page, "window.__plansShown===true && window.__upd.length===0"));
  await page.evaluate(() => closeModal('addEmpModal'));
  await lockSetup('free', PREV);
  await page.evaluate(() => { editEmployee('e1'); }); await page.waitForTimeout(150);
  ok('free during the preview: the employee modal is unlocked', await q(page, "!document.getElementById('addEmpModal').classList.contains('paid-locked') && getComputedStyle(document.getElementById('empPaidLockHint')).display==='none'"));
  await page.evaluate(() => closeModal('addEmpModal'));

  // time off page
  await lockSetup('free', POST);
  await page.evaluate(() => { if (!document.getElementById('toSiteFilter')) {} window.refreshTimeOff = async () => {}; window.renderTimeOff = () => {}; loadTimeOffPage(); }); await page.waitForTimeout(100);
  ok('free after the preview: the Time Off page explains it is a paid feature and hides the tool', await q(page, "document.getElementById('page-timeoff').classList.contains('to-locked') && getComputedStyle(document.getElementById('toLockWall')).display==='block' && getComputedStyle(document.querySelector('#page-timeoff .page-header .btn-primary')).display==='none'"));
  await lockSetup('free', PREV);
  await page.evaluate(() => { window.refreshTimeOff = async () => {}; window.renderTimeOff = () => {}; loadTimeOffPage(); }); await page.waitForTimeout(100);
  ok('free during the preview: Time Off works', await q(page, "!document.getElementById('page-timeoff').classList.contains('to-locked') && getComputedStyle(document.getElementById('toLockWall')).display==='none'"));

  ok('no page errors', errs.length===0, errs.join(' | '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
