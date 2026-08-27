// Checks the consolidated onboarding: one system on screen, the right steps, and the
// tablet step behaving as the funnel's actual failure point deserves.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon' };
const server = await new Promise(r => {
  const s = createServer(async (req,res)=>{
    try{
      const rel=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
      const f=normalize(join(ROOT,rel));
      if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
      res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
      createReadStream(f).pipe(res);
    }catch{res.writeHead(404).end();}
  });
  s.listen(0,'127.0.0.1',()=>r(s));
});

let pass=0, fail=0;
const ok=(n,c,x='')=>{ c?pass++:fail++; console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`); };

// Stand the checklist up against a chosen account state without touching the network.
async function setup(page, { company=true, site=true, emps=true, punch=false, kiosk=false, sites=1 }={}) {
  await page.evaluate(st => {
    window._demoMode=false;
    Sess.set ? Sess.set({id:'a1',email:'owner@test.ca',status:'active'})
             : localStorage.setItem('pc_sess', JSON.stringify({id:'a1',email:'owner@test.ca',status:'active'}));
    C.companies = st.company ? [{id:'co1',name:'Test Co',admin_id:'a1'}] : [];
    C.sites = st.site ? Array.from({length:st.sites},(_,i)=>({id:'s'+(i+1),name:'Site '+(i+1),company_id:'co1'})) : [];
    C.employees = st.emps ? [{id:'e1',name:'Ana',pin:'1234',site_id:'s1',company_id:'co1',active:true}] : [];
    C.punches = st.punch ? [{id:'p1',emp_id:'e1',type:'IN',company_id:'co1'}] : [];
    Ctx.set({co:{id:'co1',name:'Test Co'}});
    // Make the probe deterministic instead of hitting the live database — an in-flight
    // real lookup resolving late is exactly what made this test flake.
    DB.all = async (table)=> table==='kiosk_devices' ? (st.kiosk?[{id:'k1'}]:[]) : [];
    _kioskSeen = st.kiosk;
    localStorage.removeItem('pc_setup_done');
    renderSetupChecklist();
  }, { company, site, emps, punch, kiosk, sites });
  await page.waitForTimeout(120);
}

const browser = await chromium.launch();
for (const lang of ['en','fr']) {
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page = await browser.newPage({ viewport:{ width:1280, height:1000 } });
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil:'networkidle' });
  await page.evaluate(l=>setLang(l), lang);

  // The collision: a tour modal must not auto-open over the checklist any more.
  await page.evaluate(()=>{ try{localStorage.removeItem('pc_tour_v1');}catch(e){} });
  await setup(page);
  await page.evaluate(()=>renderDashboard());
  await page.waitForTimeout(900);   // the old code opened the tour at 400ms
  ok('tour does not auto-open over the checklist', await page.evaluate(()=>
    !document.getElementById('tourModal').classList.contains('open')));
  ok('tour is still reachable on demand', await page.evaluate(()=>{
    startTour(); const open=document.getElementById('tourModal').classList.contains('open');
    endTour(true); return open; }));

  // Step list for the normal account: no dead pre-ticked company row.
  await setup(page, { company:true, site:false, emps:false });
  const txt = await page.evaluate(()=>document.getElementById('setupChecklist').innerText);
  ok('company step hidden when a company exists', !/Create your company|Cr[ée]ez votre (entreprise|compagnie)/i.test(txt));
  ok('tablet step is present', /punch tablet|tablette de pointage/i.test(txt));
  ok('four steps for a normal account', await page.evaluate(()=>
    document.querySelectorAll('#setupChecklist [style*="border-bottom"]').length+1===4),
    String(await page.evaluate(()=>document.querySelectorAll('#setupChecklist [style*="border-bottom"]').length+1)));
  ok('no raw i18n keys', !/\bsetup\.[a-zA-Z0-9]+/.test(txt), (txt.match(/\bsetup\.[a-zA-Z0-9]+/g)||[]).join(','));

  // And it does appear for the minority who somehow have no company.
  await setup(page, { company:false, site:false, emps:false });
  ok('company step appears when there is no company', await page.evaluate(()=>
    /Create your company|Cr[ée]ez votre|Ajouter une/i.test(document.getElementById('setupChecklist').innerText)));

  // The tablet step needs a site; offering it before one exists is a dead end.
  await setup(page, { site:false, emps:false });
  ok('tablet button disabled with no site', await page.evaluate(()=>{
    const b=[...document.querySelectorAll('#setupChecklist button')].find(x=>/tablet|tablette/i.test(x.textContent));
    return !!b && b.disabled; }));

  await setup(page, { sites:1 });
  ok('one site opens the wizard directly', await page.evaluate(()=>{
    setupTabletFromChecklist();
    return document.getElementById('kioskShortcutModal').classList.contains('open'); }));
  await page.evaluate(()=>closeKioskWizard());

  await setup(page, { sites:3 });
  ok('several sites sends the owner to pick one', await page.evaluate(()=>{
    window.__nav=null; const o=window.navigate; window.navigate=p=>{window.__nav=p;};
    setupTabletFromChecklist(); window.navigate=o;
    return window.__nav==='sites' && !document.getElementById('kioskShortcutModal').classList.contains('open'); }));

  // Ticking the tablet step is the whole reason the probe exists.
  await setup(page, { kiosk:true, punch:false });
  const done = await page.evaluate(()=>document.getElementById('setupChecklist').innerText);
  ok('tablet step shows as done once a tablet connected',
     !/Set up tablet|Configurer la tablette/i.test(done) && /3 of 4 done|3 sur 4 termin/.test(done),
     done.replace(/\s+/g,' ').match(/\d of \d done|\d sur \d terminées/)?.[0] || '?');

  // A failed lookup must not un-tick a step the owner finished — it would send the
  // checklist back to nagging about work already done.
  ok('a failed probe does not un-tick the tablet step', await page.evaluate(async ()=>{
    DB.all = async ()=>{ throw new Error('network down'); };
    await _checkKioskSeen();
    return _kioskSeen === true;
  }));

  // Everything finished → the checklist retires itself.
  await setup(page, { kiosk:true, punch:true });
  ok('checklist hides when setup is complete', await page.evaluate(()=>
    document.getElementById('setupChecklist').style.display==='none'));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
