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

ok('no page errors', errs.length===0, errs.join(' / '));
await page.close();
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
