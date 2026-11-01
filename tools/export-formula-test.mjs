// Spreadsheet formula injection in the CSV and Excel exports (security audit 2026-11-01).
// Names, sites, labels and visitor fields are typed by people; an export cell that begins with = + - @ (or a
// tab / CR) runs as a formula when an admin opens it in Excel or Google Sheets. Text cells must come out
// neutralised (CSV: a leading apostrophe; XLSX: an explicit string cell, no formula), while numbers, hours,
// dates and the normal values are exactly what they were. The network is stubbed; the real exportReport() and
// exportVisitorReport() of the real index.html run, with the real SheetJS library.
//
// APP_ROOT=<dir> runs the same checks against another copy of the site (to prove the test fails before the fix).
// The SheetJS file is read from tools/_xlsx.full.min.js, XLSX_JS=<path>, or downloaded once from cdnjs (the same
// version the page uses); without it the Excel checks are reported as SKIP and the CSV checks still run.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : join(HERE, '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json','.ico':'image/x-icon'};
const server=await new Promise(r=>{const s=createServer(async(q,res)=>{try{
  const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  const f=normalize(join(ROOT,rel));
  if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(f).pipe(res);}catch{res.writeHead(404).end();}});s.listen(0,'127.0.0.1',()=>r(s));});
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0,skip=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};
const skipped=(n)=>{skip++;console.log(`  SKIP  ${n}`);};

// ── SheetJS (real library, so the xlsx writer is really exercised) ──
let XLSX_SRC=null;
{
  const cache=process.env.XLSX_JS||join(HERE,'_xlsx.full.min.js');
  try{
    if(existsSync(cache)) XLSX_SRC=await readFile(cache,'utf8');
    else{
      const r=await fetch('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      if(r.ok){ XLSX_SRC=await r.text(); await writeFile(cache,XLSX_SRC).catch(()=>{}); }
    }
  }catch(_){}
}

// Hostile values, one per leading character that spreadsheets treat as a formula.
const HOSTILE = {
  hyperlink: '=HYPERLINK("http://evil.example/steal","Click")',
  plus:      "+cmd|' /C calc'!A0",
  minus:     '-1+1',
  at:        '@SUM(A1)',
  tab:       '\t=1+1',
  cr:        '\r=1+1',
};
const NORMAL_NAME = 'Ann Lee';

const browser=await chromium.launch();
const ctx=await browser.newContext({viewport:{width:1280,height:900}, acceptDownloads:true});
await ctx.addInitScript(()=>{
  try{ localStorage.setItem('pc_sess',JSON.stringify({id:'00000000-0000-4000-8000-0000000000aa',name:'Owner',email:'owner@example.test',role:'admin',plan:'starter',token:'tok-test'})); }catch(_){}
});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
page.on('dialog',d=>d.dismiss().catch(()=>{}));
await page.route('**/*', route=>{
  const u=route.request().url();
  if(u.startsWith(BASE)) return route.continue();
  if(/xlsx\.full\.min\.js/.test(u)) return route.fulfill({status:200,contentType:'text/javascript',body:XLSX_SRC||''});
  if(/\.js(\?|$)/.test(u)) return route.fulfill({status:200,contentType:'text/javascript',body:''});
  if(/\.css(\?|$)|fonts\./.test(u)) return route.fulfill({status:200,contentType:'text/css',body:''});
  return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'[]'});
});
await page.goto(BASE+'/index.html',{waitUntil:'load'});
await page.waitForTimeout(800);

// Put report data in place and capture what the export writes (the blob text, the workbook).
await page.evaluate(({H,N})=>{
  window.refreshCache=async()=>{};
  window.__csv=null; window.__wb=null;
  URL.createObjectURL=(blob)=>{ window.__csvPromise=blob.text().then(t=>{window.__csv=t;}); return 'blob:stub'; };
  HTMLAnchorElement.prototype.click=function(){};
  if(window.XLSX){ XLSX.writeFile=(wb)=>{ window.__wb=wb; }; }
  // minimum DOM the exporters read
  for(const [id,txt] of [['reportCompany',H.hyperlink],['reportSite',H.at]]){
    const s=document.getElementById(id); if(s){ s.innerHTML=''; const o=document.createElement('option'); o.value='all'; o.textContent=txt; s.appendChild(o); s.selectedIndex=0; }
  }
  document.getElementById('reportStart').value='2026-10-01';
  document.getElementById('reportEnd').value='2026-10-31';
  // time report rows: normal, hostile names/sites, a negative number of hours, a still-clocked-in row, headings and totals
  const row=(name,code,site,reg,extra={})=>({empName:name,empCode:code,siteName:site,date:'2026-10-19',punchIn:'08:00 AM',punchOut:'04:00 PM',hours:reg,regHours:reg,otHours:0,labelId:extra.labelId||null,...extra});
  reportData=[
    {isSiteHeader:true,siteName:H.hyperlink},
    row(N,'A1','Main shop',8),
    row(H.hyperlink,'=1+1',H.plus,8,{labelId:'L1'}),
    row(H.plus,H.at,'Main shop',7.5),
    row(H.minus,'-2+3','Main shop',-1.5),
    row(H.at,'+5','Main shop',8,{otHours:2}),
    row(H.tab,'B2','Main shop',8),
    row(H.cr,'B3','Main shop',8),
    row('Still Sam','S1','Main shop',null,{punchOut:''}),
    {isSubtotal:true,subtotalLabel:H.minus,hours:23.5,otHours:2},
    {isSiteTotal:true,siteName:H.at,hours:23.5,otHours:2},
  ];
  _reportTimeOff=[]; _repShowLabel=true; _repShowEvening=false;
  _reportLabelSummary=[{name:H.at,reg:8,ot:0,emps:{[H.hyperlink]:8},empsRO:{[H.hyperlink]:{reg:8,ot:0}}}];
  window.labelByIdAny=(id)=>id?{name:H.hyperlink}:null;
  visitorReportData=[
    {full_name:N,company_name:'Acme',phone:'514-555-0100',email:'ann@example.test',company_id:'c1',site_id:'s1',checked_in_at:'2026-10-19T12:00:00Z',checked_out_at:null},
    {full_name:H.hyperlink,company_name:H.plus,phone:H.minus,email:H.at,company_id:'c1',site_id:'s1',checked_in_at:'2026-10-19T12:00:00Z',checked_out_at:'2026-10-19T13:00:00Z'},
    {full_name:H.tab,company_name:H.cr,phone:'+1 514 555 0101',email:'-',company_id:'c1',site_id:'s1',checked_in_at:'2026-10-19T12:00:00Z',checked_out_at:null},
  ];
  C.companies=[{id:'c1',name:H.hyperlink}]; C.sites=[{id:'s1',name:H.at,company_id:'c1'}];
},{H:HOSTILE,N:NORMAL_NAME});

// minimal CSV parser (every cell is quoted by the exporter)
function parseCsv(t){
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<t.length;i++){
    const c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){cell+='"';i++;} else q=false; } else cell+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(cell);cell=''; }
    else if(c==='\n'){ row.push(cell);rows.push(row);row=[];cell=''; }
    else cell+=c;
  }
  if(cell!==''||row.length){ row.push(cell); rows.push(row); }
  return rows;
}
const FORMULA=/^[=+\-@\t\r]/, PLAIN_NUM=/^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/;
const dangerous=(cells)=>cells.filter(c=>FORMULA.test(c)&&!PLAIN_NUM.test(c));

async function getCsv(fn){
  await page.evaluate(()=>{window.__csv=null;window.__csvPromise=null;});
  await page.evaluate(fn);
  await page.evaluate(()=>window.__csvPromise);
  return page.evaluate(()=>window.__csv);
}

// ───────────────────────── time report, CSV ─────────────────────────
console.log('Time report, CSV');
{
  const csv=await getCsv(()=>exportReport('csv'));
  ok('csv produced', typeof csv==='string' && csv.length>0);
  const rows=parseCsv(csv); const all=rows.flat();
  ok('no cell can start a formula (every text cell neutralised)', dangerous(all).length===0, JSON.stringify(dangerous(all)).slice(0,160));
  const has=(v)=>all.includes(v);
  ok('=HYPERLINK(...) name is prefixed with an apostrophe', has("'"+HOSTILE.hyperlink));
  ok('+cmd name is prefixed', has("'"+HOSTILE.plus));
  ok('-1+1 name is prefixed', has("'"+HOSTILE.minus));
  ok('@SUM(A1) name is prefixed', has("'"+HOSTILE.at));
  ok('a leading tab is prefixed', has("'"+HOSTILE.tab));
  ok('a leading carriage return is prefixed', has("'"+HOSTILE.cr));
  ok('the hostile employee code and site are prefixed too', has("'=1+1") && has("'"+HOSTILE.plus));
  ok('the hostile label (extra column) is prefixed', rows.some(r=>r[3]==="'"+HOSTILE.hyperlink));
  ok('site heading, subtotal and total rows are neutralised', all.some(c=>c.startsWith("'=== SITE: ")) && has("'"+HOSTILE.minus) && all.some(c=>c.startsWith("'@SUM(A1)")));
  ok('the normal name is unchanged', has(NORMAL_NAME));
  ok('hours stay as they were ("8.00", "7.50", "23.50")', has('8.00') && has('7.50') && has('23.50'));
  ok('a negative number of hours stays a plain number ("-1.50", not "\'-1.50")', has('-1.50') && !has("'-1.50"));
  ok('a plain "+5" code stays as typed', has('+5') && !has("'+5"));
  ok('dates, times and "Still In" are unchanged', has('2026-10-19') && has('08:00 AM') && has('Still In'));
  ok('OT hours column unchanged', has('2.00'));
  ok('the header row is unchanged', rows[0].slice(0,3).join('|')==='Employee|Employee ID|Site');
  ok('the original text is still readable after the apostrophe', rows.some(r=>r[0]==="'"+HOSTILE.hyperlink));
}

// ───────────────────────── time report, Excel ─────────────────────────
console.log('Time report, Excel');
if(!XLSX_SRC){ skipped('SheetJS not available (no network and no tools/_xlsx.full.min.js): Excel checks not run'); }
else{
  await page.evaluate(()=>{ window.__wb=null; exportReport('excel'); });
  const out=await page.evaluate((H)=>{
    const wb=window.__wb; if(!wb) return {err:'no workbook'};
    const b64=XLSX.write(wb,{type:'base64',bookType:'xlsx'});
    const back=XLSX.read(b64,{type:'base64'});
    const ws=back.Sheets[back.SheetNames[0]];
    const cells=Object.keys(ws).filter(k=>k[0]!=='!').map(k=>({a:k,t:ws[k].t,v:ws[k].v,f:ws[k].f||null,l:!!ws[k].l}));
    return {names:back.SheetNames,cells};
  },HOSTILE);
  ok('workbook written', !out.err && out.cells && out.cells.length>20, out.err||'');
  const cells=out.cells||[];
  const hostileVals=Object.values(HOSTILE);
  const hostile=cells.filter(c=>typeof c.v==='string' && hostileVals.some(h=>c.v===h || c.v.includes(h)));
  ok('every hostile cell is an explicit string cell with no formula', hostile.length>=10 && hostile.every(c=>c.t==='s' && !c.f && !c.l), `${hostile.length} cells`);
  ok('no cell in the sheet carries a formula', cells.every(c=>!c.f));
  ok('hostile text is stored as typed (not prefixed): the string type is what protects it', cells.some(c=>c.v===HOSTILE.hyperlink) && cells.some(c=>c.v===HOSTILE.at));
  const byV=(v)=>cells.find(c=>c.v===v);
  ok('hours are unchanged ("8.00", "-1.50")', !!byV('8.00') && !!byV('-1.50'));
  ok('the normal name is unchanged', !!byV(NORMAL_NAME));
}

// ───────────────────────── visitor report ─────────────────────────
console.log('Visitor report, CSV');
{
  const csv=await getCsv(()=>exportVisitorReport('csv'));
  const rows=parseCsv(csv); const all=rows.flat();
  ok('visitor csv produced', rows.length===4);
  ok('no visitor cell can start a formula', dangerous(all).length===0, JSON.stringify(dangerous(all)).slice(0,160));
  ok('hostile visitor name, company, phone and email are prefixed', all.includes("'"+HOSTILE.hyperlink) && all.includes("'"+HOSTILE.plus) && all.includes("'"+HOSTILE.minus) && all.includes("'"+HOSTILE.at));
  ok('a normal visitor row is unchanged', rows[1].slice(0,4).join('|')==='Ann Lee|Acme|514-555-0100|ann@example.test');
  ok('a phone number that starts with + stays as typed when it is a plain number, is neutralised when it has text', all.includes("'+1 514 555 0101"));
  ok('"Still in" and the company/site cell', all.includes('Still in') && all.some(c=>c.includes(HOSTILE.hyperlink)));
}
console.log('Visitor report, Excel');
if(!XLSX_SRC){ skipped('SheetJS not available: Excel checks not run'); }
else{
  await page.evaluate(()=>{ window.__wb=null; exportVisitorReport('excel'); });
  const out=await page.evaluate(()=>{
    const wb=window.__wb; if(!wb) return {err:'no workbook'};
    const back=XLSX.read(XLSX.write(wb,{type:'base64',bookType:'xlsx'}),{type:'base64'});
    const ws=back.Sheets[back.SheetNames[0]];
    return {cells:Object.keys(ws).filter(k=>k[0]!=='!').map(k=>({t:ws[k].t,v:ws[k].v,f:ws[k].f||null}))};
  });
  const cells=out.cells||[];
  const h=cells.filter(c=>typeof c.v==='string'&&Object.values(HOSTILE).includes(c.v));
  ok('visitor xlsx: hostile cells are explicit strings, no formula anywhere', h.length>=5 && h.every(c=>c.t==='s'&&!c.f) && cells.every(c=>!c.f), `${h.length} cells`);
  ok('visitor xlsx: normal values unchanged', cells.some(c=>c.v==='Ann Lee') && cells.some(c=>c.v==='514-555-0100'));
}

ok('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed${skip?`, ${skip} skipped`:''}`);
process.exit(fail?1:0);
