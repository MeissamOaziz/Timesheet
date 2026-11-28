// The landing page's cost comparison. Every figure in it must match PLANS — a marketing page
// that quotes a price the product does not charge is the worst kind of bug.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
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
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const warns=[]; page.on('console',m=>{ if(/missing translation key/.test(m.text())) warns.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});

console.log('\n── the numbers must match PLANS ───────────────');
// Read the table, then check each row against what the app would actually charge.
const rows = await page.evaluate(()=>{
  const out=[];
  document.querySelectorAll('#landingCompare tbody tr').forEach(tr=>{
    const td=tr.querySelectorAll('td');
    out.push({size:parseInt(td[0].textContent,10), them:td[1].textContent.trim(), us:td[2].textContent.trim()});
  });
  return out;
});
ok('the comparison table renders', rows.length===4, rows.length+' rows');

const planFor = await page.evaluate((sizes)=>{
  // Cheapest plan that actually fits that headcount, straight from PLANS.
  const order=['free','starter','growth','business'];
  return sizes.map(n=>{
    const key=order.find(k=>PLANS[k].maxEmployees>=n);
    return {n, plan:key, price:PLANS[key].price};
  });
}, rows.map(r=>r.size));

for(let i=0;i<rows.length;i++){
  const r=rows[i], p=planFor[i];
  const claimed = /free|gratuit/i.test(r.us) ? 0 : parseFloat(r.us.replace(/[^0-9.]/g,''));
  ok(`${r.size} employees quoted as the real ${p.plan} price`, Math.abs(claimed-p.price)<0.005,
     `page says ${r.us}, PLANS says ${p.price===0?'Free':'$'+p.price}`);
}

// The per-employee column must be consistent with the rate the note discloses.
const rate = await page.evaluate(()=>{
  const note=document.querySelector('#landingCompare .cmp-note').textContent;
  const m=note.match(/([\d.,]+)\s*(?:\$|per)/);
  return m ? parseFloat(m[1].replace(',','.')) : null;
});
ok('the note discloses the assumed per-employee rate', rate===5.5, String(rate));
for(const r of rows){
  const them=parseFloat(r.them.replace(/[^0-9.]/g,''));
  ok(`${r.size} × $${rate} is stated as $${them}`, Math.abs(them-r.size*rate)<1,
     `${r.size}×${rate}=${(r.size*rate).toFixed(2)} vs ${them}`);
}

console.log('\n── no competitor is named ─────────────────────');
const named = await page.evaluate(()=>{
  const txt=document.getElementById('landingCompare').innerText.toLowerCase();
  return ['agendrix','connecteam','jibble','homebase','evolia','deputy','7shifts']
    .filter(n=>txt.includes(n));
});
ok('the comparison names no competitor', named.length===0, named.join(', ')||'none named');

console.log('\n── hero and CTAs ──────────────────────────────');
const heroBtns = await page.evaluate(()=>
  [...document.querySelectorAll('.land-hero .land-cta-group button')]
    .filter(b=>getComputedStyle(b).display!=='none').map(b=>b.textContent.trim()));
ok('the hero is down to two calls to action', heroBtns.length===2, heroBtns.join(' | '));

console.log('\n── home page layout (2026-11-28) ──────────────');
{
  // Order of the blocks inside #landingPage: hero, two ways, apps band, preview, trust band, then the sections.
  const order = await page.evaluate(()=>{
    const lp=document.getElementById('landingPage');
    const pick=['.land-hero','#landingWays','#landingApps','.land-preview','#landingHowItWorks','#landingCompare','#landingPricing',
                '#landingFeatures','#landingGeofencing','#landingFAQ','#landingContact'];
    const els=pick.map(s=>lp.querySelector(s));
    const ok=els.every(Boolean) && els.every((e,i)=>i===0||(els[i-1].compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING));
    return {ok, missing:pick.filter((s,i)=>!els[i])};
  });
  ok('sections are in the new order (hero, two ways, apps, preview, how, compare, pricing, features, geofencing, FAQ, contact)', order.ok, JSON.stringify(order));
  ok('the "fixed terminal beats GPS" section is gone', await page.evaluate(()=>!document.getElementById('landingTabletAdvantage')));
  ok('hero keeps its SEO title, loses the badge and the pills', await page.evaluate(()=>{
    const h=document.querySelector('.land-hero h1'); const hero=document.querySelector('.land-hero');
    return /actually works/.test(h.textContent) && !/automated payroll period reports/i.test(hero.textContent) && !hero.querySelector('[data-i18n^="land.pill"]');
  }));
  const noAttack = await page.evaluate(()=>{
    const txt=['.land-hero','#landingWays','#landingApps','#landingFeatures','#landingHowItWorks'].map(s=>document.querySelector(s).textContent).join(' ');
    return ['spoof','couch','from home','beats GPS','No GPS'].filter(w=>txt.toLowerCase().includes(w.toLowerCase()));
  });
  ok('no sentence argues against GPS or phones in the hero, features or how it works', noAttack.length===0, noAttack.join(', ')||'none');

  // Two ways to clock in: two real buttons, one panel at a time, works from the keyboard.
  const way = () => page.evaluate(()=>({
    tab:document.getElementById('landWayBtnTablet').getAttribute('aria-pressed'), ph:document.getElementById('landWayBtnPhone').getAttribute('aria-pressed'),
    tabShown:!document.getElementById('landWayTablet').hidden && document.getElementById('landWayTablet').offsetParent!==null,
    phShown:!document.getElementById('landWayPhone').hidden && document.getElementById('landWayPhone').offsetParent!==null }));
  let w = await way();
  ok('two ways: tablet is shown first', w.tab==='true' && w.ph==='false' && w.tabShown && !w.phShown, JSON.stringify(w));
  await page.click('#landWayBtnPhone'); w = await way();
  ok('two ways: clicking "Their own phones" swaps the panel', w.tab==='false' && w.ph==='true' && !w.tabShown && w.phShown, JSON.stringify(w));
  await page.focus('#landWayBtnPhone'); await page.keyboard.press('Shift+Tab');
  const focused = await page.evaluate(()=>document.activeElement&&document.activeElement.id);
  await page.keyboard.press('Enter'); w = await way();
  ok('two ways: Tab reaches the other button and Enter switches back', focused==='landWayBtnTablet' && w.tab==='true' && w.tabShown && !w.phShown, focused+' '+JSON.stringify(w));
  await page.keyboard.press('Tab'); await page.keyboard.press('Space'); w = await way();
  ok('two ways: Space works too', w.ph==='true' && w.phShown, JSON.stringify(w));
  ok('two ways: both screenshots are real files that load', await page.evaluate(async()=>{
    const imgs=[...document.querySelectorAll('#landingWays img')];
    for(const i of imgs){ i.loading='eager'; if(!i.complete) await new Promise(r=>{i.onload=i.onerror=r;}); }
    return imgs.length===2 && imgs.every(i=>i.naturalWidth>0);
  }));
  await page.click('#landWayBtnTablet');

  // Apps band: what it says, and what it must not (no date, no store badge, no link).
  const apps = await page.evaluate(()=>{ const e=document.getElementById('landingApps'); return {t:e.innerText, links:e.querySelectorAll('a,img').length}; });
  ok('apps band (EN) says the apps are coming soon', /Mobile apps coming soon/.test(apps.t) && /PunchClock Crew Admin/.test(apps.t) && /iPhone and Android/.test(apps.t), apps.t);
  ok('apps band has no date, store badge or download link', apps.links===0 && !/20\d\d|january|february|march|spring|summer|App Store|Google Play|watch|reminder/i.test(apps.t));

  // Features: six first, the rest behind one button, in the DOM all along.
  const feats = () => page.evaluate(()=>({vis:[...document.querySelectorAll('#landingFeatures .feature-card')].filter(e=>e.offsetParent!==null).length,
    all:document.querySelectorAll('#landingFeatures .feature-card').length, exp:document.getElementById('landFeatMore').getAttribute('aria-expanded'),
    label:document.getElementById('landFeatMore').textContent.trim()}));
  let f = await feats();
  ok('features: six cards shown first, the rest still in the page', f.vis===6 && f.all===16 && f.exp==='false' && f.label==='Show all features', JSON.stringify(f));
  await page.click('#landFeatMore'); f = await feats();
  ok('features: "Show all features" reveals all of them', f.vis===16 && f.exp==='true' && f.label==='Hide', JSON.stringify(f));
  await page.click('#landFeatMore'); f = await feats();
  ok('features: "Hide" goes back to six', f.vis===6 && f.exp==='false', JSON.stringify(f));

  // FAQ: the mobile-app question is there.
  ok('FAQ: "Is there a mobile app?" is listed', await page.evaluate(()=>{ renderFAQ(); const e=document.getElementById('faqItem32'); return !!e && /Is there a mobile app\?/.test(e.innerText); }));

  // French.
  await page.evaluate(()=>setLang('fr')); await page.waitForTimeout(200);
  const fr = await page.evaluate(()=>({apps:document.getElementById('landingApps').innerText, ways:document.getElementById('landingWays').innerText,
    btn:document.getElementById('landFeatMore').textContent.trim(), shot:document.querySelector('#landWayTablet img').getAttribute('src'),
    faq:(renderFAQ(), (document.getElementById('faqItem32')||{}).innerText||'')}));
  ok('apps band (FR) is in French', /Applications mobiles à venir/.test(fr.apps) && /iPhone et Android/.test(fr.apps), fr.apps);
  ok('two ways (FR) is in French, with the French screenshot', /Tablette à l’entrée/.test(fr.ways) && /Leur propre téléphone/.test(fr.ways) && /-fr\.webp$/.test(fr.shot), fr.shot);
  ok('features button (FR) is in French', fr.btn==='Voir toutes les fonctions', fr.btn);
  ok('FAQ (FR): « Y a-t-il une application mobile? »', /Y a-t-il une application mobile\?/.test(fr.faq));
  await page.evaluate(()=>setLang('en')); await page.waitForTimeout(150);

  // No sideways scroll inside #landingPage, with each panel open and all features shown.
  for (const W of [320, 390, 768, 1280]) {
    await page.setViewportSize({width:W,height:800}); await page.waitForTimeout(150);
    const res = {};
    for (const wayName of ['tablet','phone']) {
      await page.evaluate(n=>{ setLandWay(n); const g=document.getElementById('landFeatGrid'); if(!g.classList.contains('show-all')) toggleLandFeatures(); }, wayName);
      res[wayName] = await page.evaluate(()=>{ const lp=document.getElementById('landingPage'); return lp.scrollWidth<=innerWidth+1 && document.documentElement.scrollWidth<=innerWidth+1; });
    }
    await page.evaluate(()=>{ setLandWay('tablet'); toggleLandFeatures(); });
    ok(`${W} px: no horizontal overflow in #landingPage (both panels, all features)`, res.tablet && res.phone, JSON.stringify(res));
  }
  await page.setViewportSize({width:1280,height:900});
  const landWarns = warns.filter(m=>/key:\s*(land\.|faq\.q32|faq\.a32)/.test(m));
  ok('no missing-translation warnings for land.* (EN and FR)', landWarns.length===0, landWarns.join(' / ')||'none');
}

console.log('\n── phone ──────────────────────────────────────');
await page.setViewportSize({width:390,height:844});
await page.waitForTimeout(250);
const mob = await page.evaluate(()=>{
  const vis=s=>{const e=document.querySelector(s);return !!e&&getComputedStyle(e).display!=='none';};
  const nav=document.querySelector('.land-nav-actions .lnb-cta');
  return {sticky:vis('.land-sticky-cta'), sectionCta:vis('#landingCompare .cmp-cta'),
          navCta:!!nav&&getComputedStyle(nav).display!=='none',
          bodyPad:getComputedStyle(document.body).paddingBottom};
});
ok('sticky CTA appears on a phone', mob.sticky);
ok('the section stops repeating the same button', !mob.sectionCta);
ok('the clipped nav CTA is hidden', !mob.navCta);

// The table must not push the page sideways.
const overflow = await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1);
ok('no horizontal scroll on a phone', overflow);

console.log('\n── homepage header and menu, 320 px and up ─────');
// The section links hide below 1240 px and on a phone so do Employee Portal, Admin Login and Get Started Free: a menu
// button must hold them all, reachable in one or two taps, with nothing cut off and no sideways scroll (the landing
// scrolls inside #landingPage, so that is the element to measure).
{
  const BASE = `http://127.0.0.1:${server.address().port}/index.html`;
  const MENU = ['Features', 'Geofencing', 'Pricing', 'How It Works', 'FAQ', 'Contact', 'Employee Portal', 'Admin Login', 'Get Started Free'];
  for (const lang of ['en', 'fr']) {
    for (const W of [320, 375, 430, 768, 1024, 1240, 1280]) {
      const ctx = await browser.newContext({ viewport: { width: W, height: 800 } });
      await ctx.route(u => !u.href.startsWith(BASE.replace('/index.html', '')) && !/fonts\./.test(u.href), r => r.abort());
      const pg = await ctx.newPage(); const e2 = []; pg.on('pageerror', e => e2.push(e.message));
      await pg.goto(BASE, { waitUntil: 'load' }); await pg.waitForTimeout(400);
      await pg.evaluate(l => setLang(l), lang);
      const h = await pg.evaluate(() => {
        const nav = document.querySelector('.land-nav');
        const kids = [...nav.querySelectorAll('.land-logo, .land-nav-actions > *, .land-nav-sections')].filter(e => e.offsetParent !== null);
        const cut = kids.filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; }).map(e => e.className || e.tagName);
        const btn = document.getElementById('landMenuBtn');
        return { sideways: document.getElementById('landingPage').scrollWidth > innerWidth + 1, cut, btnShown: btn.offsetParent !== null, sections: document.querySelector('.land-nav-sections').offsetParent !== null };
      });
      const tag = `${lang}, ${W} px`;
      ok(`${tag}: nothing in the header is cut off, and the page does not scroll sideways`, !h.sideways && h.cut.length === 0, JSON.stringify(h));
      if (W <= 1240) {
        ok(`${tag}: a menu button is there (the section links are hidden)`, h.btnShown && !h.sections);
        await pg.click('#landMenuBtn'); await pg.waitForTimeout(200);
        const m = await pg.evaluate(() => {
          const items = [...document.querySelectorAll('#landMenu .lm-item')].filter(e => e.offsetParent !== null);
          return { open: document.getElementById('landMenu').classList.contains('open'), n: items.length, bad: items.filter(e => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; }).length,
                   adminTop: Math.round((items.find(e => /onclick|Admin|Connexion/.test(e.outerHTML) && /navigate\('login'\)/.test(e.getAttribute('onclick') || '')) || { getBoundingClientRect: () => ({ top: 9999 }) }).getBoundingClientRect().top),
                   expanded: document.getElementById('landMenuBtn').getAttribute('aria-expanded'), sticky: getComputedStyle(document.querySelector('.land-sticky-cta')).display };
        });
        ok(`${tag}: the menu opens with all ten entries fully on screen`, m.open && m.n === 10 && m.bad === 0 && m.expanded === 'true', JSON.stringify(m));
        ok(`${tag}: Admin Login is in the menu, within the first screen`, m.adminTop < 700, String(m.adminTop));
        ok(`${tag}: the bottom Start button steps aside while the menu is open`, m.sticky === 'none');
        await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
        ok(`${tag}: Escape closes it`, await pg.evaluate(() => !document.getElementById('landMenu').classList.contains('open')));
        if (W === 320 || W === 1024) {
          await pg.click('#landMenuBtn'); await pg.waitForTimeout(150);
          await pg.click('#landMenu [onclick="landMenuGo(\'landingPricing\')"]'); await pg.waitForTimeout(600);
          ok(`${tag}: choosing a section closes the menu and scrolls there`, await pg.evaluate(() => !document.getElementById('landMenu').classList.contains('open') && document.getElementById('landingPage').scrollTop > 300));
          await pg.evaluate(() => { document.getElementById('landingPage').scrollTop = 0; });
          await pg.click('#landMenuBtn'); await pg.waitForTimeout(150);
          await pg.click('#landMenu [onclick*="navigate(\'login\')"]'); await pg.waitForTimeout(500);
          ok(`${tag}: Admin Login from the menu opens the sign-in page`, await pg.evaluate(() => !document.getElementById('landingPage').classList.contains('show') && document.getElementById('page-login').classList.contains('active')));
        }
      } else {
        ok(`${tag}: wide screens keep the full links and no menu button`, !h.btnShown && h.sections);
      }
      if (lang === 'fr' && W === 320) {
        const labels = await pg.evaluate(() => [...document.querySelectorAll('#landMenu .lm-item')].map(e => e.innerText.trim()));
        ok('fr: the menu is in French', labels.includes('Tarifs') && labels.includes('Portail employé') && labels.includes('Connexion Admin'), labels.join(' | '));
      }
      ok(`${tag}: no page errors`, e2.length === 0, e2.join(' / '));
      await ctx.close();
    }
  }
}

ok('no page errors', errs.length===0, errs.join(' / '));
await page.close();
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
