// One navigation system. The risks in collapsing three into one are losing something the
// deleted surfaces carried (pending badges, the manager permission rule) and breaking the
// mobile fallback.
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
const shown = (page,sel)=>page.evaluate(s=>{
  const el=document.querySelector(s); return !!el && getComputedStyle(el).display!=='none';
}, sel);

const browser=await chromium.launch();
console.log('\n── desktop, signed in ─────────────────────────');
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
await page.evaluate(()=>startDemo());
await page.waitForTimeout(700);

ok('sidebar is showing', await shown(page,'#sideNav'));
ok('the old top tab strip is gone from the DOM entirely',
   await page.evaluate(()=>document.querySelectorAll('.nav-links .nav-btn').length===0));
ok('no layout-switch control remains', await page.evaluate(()=>
   !document.getElementById('navModeBtn') && !document.getElementById('ddNavModeLabel')));

// Every page the sidebar offers must actually route.
const routes = await page.evaluate(()=>{
  const out=[];
  document.querySelectorAll('#sideNav .sn-item[data-nav]').forEach(b=>{
    const nav=b.getAttribute('data-nav');
    const target=nav==='admins'?'admin':nav;
    out.push({nav, exists: !!document.getElementById('page-'+target)});
  });
  return out;
});
ok('every sidebar entry points at a page that exists',
   routes.every(r=>r.exists), routes.filter(r=>!r.exists).map(r=>r.nav).join(',')||routes.map(r=>r.nav).join(' '));

// Active state must follow navigation.
for(const p of ['dashboard','activity','reports','schedule','timeoff']){
  await page.evaluate(x=>navigate(x), p);
  await page.waitForTimeout(120);
}
ok('active state tracks the current page', await page.evaluate(()=>{
  const a=document.querySelector('#sideNav .sn-item.active');
  return !!a && a.getAttribute('data-nav')==='timeoff'; }));

// The badges the deleted top bar used to carry.
const badges = await page.evaluate(()=>{
  updateMissedPunchBadge(3); updateJoinRequestBadge(2);
  const g=document.getElementById('snTeamGroup');
  const sub=g.querySelector('.sn-sub');
  const openSubVis=getComputedStyle(sub).display!=='none';
  const openVis=getComputedStyle(document.getElementById('snTeamBadge')).display!=='none';
  toggleSideGroup('snTeamGroup');                       // collapse it for real
  const closedSubVis=getComputedStyle(sub).display!=='none';
  const closed=document.getElementById('snTeamBadge').textContent;
  const closedVis=getComputedStyle(document.getElementById('snTeamBadge')).display!=='none';
  toggleSideGroup('snTeamGroup');
  return {missed:document.getElementById('snMissedBadge').textContent,
          join:document.getElementById('snJoinBadge').textContent,
          closed, closedVis, openVis, openSubVis, closedSubVis};
});
ok('the group starts expanded', badges.openSubVis);
ok('the chevron actually collapses it', !badges.closedSubVis);
ok('missed-punch count reaches the sidebar', badges.missed==='3', badges.missed);
ok('join-request count reaches the sidebar', badges.join==='2', badges.join);
ok('collapsed group shows the combined total', badges.closed==='5' && badges.closedVis, badges.closed);
ok('and hides it once the group is open', !badges.openVis);

// The Admins row must stay a flex row despite the generic [data-admin-only] rule.
ok('admin-only sidebar row keeps its flex layout', await page.evaluate(()=>{
  document.body.classList.add('role-resolved','role-admin');
  const el=document.querySelector('.sn-item[data-admin-only]');
  return getComputedStyle(el).display==='flex';
}), await page.evaluate(()=>{
  const el=document.querySelector('.sn-item[data-admin-only]');
  return getComputedStyle(el).display; }));

ok('no page errors', errs.length===0, errs.join(' / '));
await page.close();

console.log('\n── phone ──────────────────────────────────────');
const m=await browser.newPage({viewport:{width:390,height:820}});
await m.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
await m.evaluate(()=>startDemo());
await m.waitForTimeout(700);
ok('sidebar steps aside on a phone', !(await shown(m,'#sideNav')));
ok('hamburger takes over', await shown(m,'.hamburger'));
ok('the mobile menu still lists every page', await m.evaluate(()=>
   document.querySelectorAll('#mobileMenu .mobile-nav-btn, .mobile-nav-btn').length>=6));
await m.close();
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
