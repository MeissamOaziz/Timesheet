// Checks the printable PIN handout: that it prints exactly the rows the table is showing,
// that a PIN-less employee is called out rather than printed blank, and that the print
// stylesheet actually hides the app and shows the sheet.
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
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if(!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()){ res.writeHead(404).end(); return; }
      res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
      createReadStream(f).pipe(res);
    }catch{ res.writeHead(404).end(); }
  });
  s.listen(0,'127.0.0.1',()=>r(s));
});

let pass=0, fail=0;
const ok=(n,c,x='')=>{ c?pass++:fail++; console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`); };

const browser = await chromium.launch();
for (const lang of ['en','fr']) {
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page = await browser.newPage({ viewport:{ width:1280, height:900 } });
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil:'domcontentloaded' });
  await page.evaluate(()=>{ try{ localStorage.setItem('pc_tour_v1','1'); }catch(e){} });
  await page.reload({ waitUntil:'networkidle' });
  await page.evaluate(l=>setLang(l), lang);
  await page.evaluate(()=>startDemo());
  await page.waitForTimeout(800);

  // Demo mode must refuse rather than print fake PINs as if they were real.
  await page.evaluate(()=>{ window.__toasts=[]; const o=window.showToast; window.showToast=(m,t)=>{window.__toasts.push(m);return o&&o(m,t);}; });
  await page.evaluate(()=>printPinCards());
  ok('demo mode refuses to print', await page.evaluate(()=>
    document.getElementById('pinCardSheet').innerHTML==='' && window.__toasts.length===1),
    await page.evaluate(()=>window.__toasts[0]||''));

  // Leave demo and stand up a deterministic roster so counts are checkable.
  await page.evaluate(()=>{
    window._demoMode=false;
    C.companies=[{id:'co1',name:'Café Rivière'}];
    C.sites=[{id:'s1',name:'Plateau',company_id:'co1'},{id:'s2',name:'Vieux-Port',company_id:'co1'}];
    C.employees=[
      {id:'e1',name:'Maxime Cambon',   pin:'4821',emp_code:'A-01',site_id:'s1',company_id:'co1',active:true},
      {id:'e2',name:'Théophane Gendrot',pin:'9137',emp_code:'A-02',site_id:'s1',company_id:'co1',active:true},
      {id:'e3',name:'Sarah Okonkwo',   pin:'2044',emp_code:'B-01',site_id:'s2',company_id:'co1',active:true},
      {id:'e4',name:'Luc Tremblay',    pin:'',    emp_code:'B-02',site_id:'s2',company_id:'co1',active:true}
    ];
    Ctx.set({co:{id:'co1',name:'Café Rivière'}});
    renderEmployees();
  });
  await page.waitForTimeout(200);

  await page.evaluate(()=>printPinCards());
  const all = await page.evaluate(()=>document.getElementById('pinCardSheet').innerText);
  ok('prints every employee by default',
     ['Maxime Cambon','Théophane Gendrot','Sarah Okonkwo','Luc Tremblay'].every(n=>all.includes(n)));
  ok('PINs appear on the cards', ['4821','9137','2044'].every(p=>all.includes(p)));
  ok('PIN-less employee is flagged, not printed blank',
     /No PIN set|Aucun NIP/.test(all));
  ok('sheet header names the company and count',
     all.includes('Café Rivière') && all.includes('4'));
  ok('no raw i18n keys on the sheet', !/\b(pin|admin|demo)\.[a-zA-Z]+/.test(all),
     (all.match(/\b(pin|admin|demo)\.[a-zA-Z]+/g)||[]).join(','));

  // The whole point of reusing filteredEmployees(): filter the table, print that.
  const filtered = await page.evaluate(()=>{
    document.getElementById('empSiteFilter').innerHTML='<option value="">all</option><option value="s2">Vieux-Port</option>';
    document.getElementById('empSiteFilter').value='s2';
    renderEmployees(); printPinCards();
    return document.getElementById('pinCardSheet').innerText;
  });
  ok('site filter narrows the printed sheet',
     filtered.includes('Sarah Okonkwo') && !filtered.includes('Maxime Cambon'),
     filtered.includes('Maxime Cambon') ? 'Plateau staff leaked in' : 'Vieux-Port only');

  // Card count must match the table exactly.
  const counts = await page.evaluate(()=>({
    cards: document.querySelectorAll('#pinCardSheet .pcard').length,
    rows:  filteredEmployees().length
  }));
  ok('one card per visible row', counts.cards===counts.rows, `${counts.cards} cards / ${counts.rows} rows`);

  // The print stylesheet is the part that silently breaks. Emulate print and check it.
  await page.evaluate(()=>document.body.classList.add('printing-pins'));
  await page.emulateMedia({ media:'print' });
  const vis = await page.evaluate(()=>({
    sheet: getComputedStyle(document.getElementById('pinCardSheet')).display,
    app:   getComputedStyle(document.getElementById('pcToast')).display
  }));
  ok('print media shows the sheet and hides the app',
     vis.sheet!=='none' && vis.app==='none', `sheet:${vis.sheet} app:${vis.app}`);

  await page.pdf({ path:`../assets/screenshots/_pincards-${lang}.pdf`, format:'A4' }).catch(e=>console.log('  pdf:',e.message));
  await page.emulateMedia({ media:'screen' });
  await page.evaluate(()=>document.body.classList.remove('printing-pins'));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
