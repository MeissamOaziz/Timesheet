// Activity log: flags the server puts on phone punches (review_flags) and the employee's location note.
// Pins: each flag shows a badge in the right language, nothing shows for a clean punch or a kiosk punch,
// and the employee's free-text note can never inject markup.
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
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ────────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  const html=(p)=>page.evaluate(p=>reviewBadges(p),p);
  const text=async(p)=>{const h=await html(p);return page.evaluate(h=>{const e=document.createElement('div');e.innerHTML=h;return e.textContent;},h);};

  ok('a punch with no flags shows nothing', (await html({}))==='' && (await html({review_flags:null}))==='' && (await html({review_flags:[]}))==='');
  ok('a non-array value is ignored, not a crash', (await html({review_flags:'no_location'}))==='');

  const nl=await text({review_flags:['no_location:no_fix']});
  ok('no_location shows its badge', lang==='fr'?/SANS LOCALISATION/.test(nl):/NO LOCATION/.test(nl), nl);
  const tipNl=await page.evaluate(()=>{const e=document.createElement('div');e.innerHTML=reviewBadges({review_flags:['no_location:no_fix']});return e.firstElementChild.title;});
  ok('the reason code is in the tooltip, as text', /no_fix/.test(tipNl), tipNl.slice(0,80));
  ok('outside_geofence shows a red badge', /bad/.test(await html({review_flags:['outside_geofence']})));
  ok('low_accuracy shows its badge', lang==='fr'?/GPS FAIBLE/.test(await text({review_flags:['low_accuracy']})):/WEAK GPS/.test(await text({review_flags:['low_accuracy']})));
  ok('clock_unverified shows the time badge', lang==='fr'?/HEURE NON VÉRIFIÉE/.test(await text({review_flags:['clock_unverified']})):/TIME UNVERIFIED/.test(await text({review_flags:['clock_unverified']})));
  ok('stale_offline shows the loud CHECK TIME badge, not two time badges',
     (await page.evaluate(()=>{const e=document.createElement('div');e.innerHTML=reviewBadges({review_flags:['stale_offline','clock_unverified','time_mismatch']});return e.querySelectorAll('.late-badge').length;}))===1);
  ok('several unrelated flags show several badges',
     (await page.evaluate(()=>{const e=document.createElement('div');e.innerHTML=reviewBadges({review_flags:['no_location','outside_geofence','low_accuracy','clock_skew']});return e.querySelectorAll('.late-badge').length;}))===4);
  ok('no raw i18n keys leak into a badge or its tooltip',
     !/activity\.(flag|tip)/.test(await html({review_flags:['no_location','outside_geofence','low_accuracy','stale_offline','clock_skew']})));

  // The note is written by an employee: it must never become markup.
  const evil='<img src=x onerror=window.__pwned=1> & "quoted"';
  const noteHtml=await page.evaluate(n=>geoNoteLine({geo_note:n}),evil);
  ok('the note is escaped', !/<img/i.test(noteHtml) && /&lt;img/.test(noteHtml), noteHtml.slice(0,80));
  const injected=await page.evaluate(h=>{const e=document.createElement('div');e.innerHTML=h;document.body.appendChild(e);return !!window.__pwned || !!e.querySelector('img');},noteHtml);
  ok('inserting it into the page runs nothing and adds no element', injected===false);
  ok('no note, no line', (await page.evaluate(()=>geoNoteLine({geo_note:null})+geoNoteLine({})))==='');

  // And the tooltip text can not break out of its attribute.
  const tipHtml=await page.evaluate(()=>reviewBadges({review_flags:['no_location:"><img src=x onerror=window.__pwned2=1>']}));
  const broke=await page.evaluate(h=>{const e=document.createElement('div');e.innerHTML=h;document.body.appendChild(e);return !!window.__pwned2 || !!e.querySelector('img');},tipHtml);
  ok('a hostile reason code cannot break out of the tooltip', broke===false);

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
