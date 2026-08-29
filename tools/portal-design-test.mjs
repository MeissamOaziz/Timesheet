// The portal was a hand-forked dark-only copy of the design system. These check the three
// things that were actually broken for an employee: no light theme, tabs that overflowed
// with nowhere to scroll, and a punch table that vanished on a phone leaving a blank card.
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
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};
const lum=h=>{const m=h.match(/\d+/g).slice(0,3).map(Number);
  const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
  return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]);};
const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+0.05)/(y+0.05);};

const browser=await chromium.launch();

console.log('\n── theme ──────────────────────────────────────');
// An explicit context so the portal and the admin app share one localStorage —
// which is the whole point of them agreeing on the pc_theme key.
const ctx=await browser.newContext({viewport:{width:1100,height:900}});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto(BASE+'/employee.html',{waitUntil:'networkidle'});

ok('defaults to light, like the admin app', await page.evaluate(()=>
   document.documentElement.getAttribute('data-theme')==='light'));

const light = await page.evaluate(()=>{
  const cs=getComputedStyle(document.body);
  return {bg:cs.backgroundColor, fg:cs.color};
});
ok('light theme is genuinely light', lum(light.bg)>0.5, light.bg);
ok('light theme text is readable on it', ratio(light.fg,light.bg)>=4.5,
   ratio(light.fg,light.bg).toFixed(2)+':1');

const dark = await page.evaluate(()=>{
  toggleEmpTheme();
  const cs=getComputedStyle(document.body);
  return {theme:document.documentElement.getAttribute('data-theme'),
          bg:cs.backgroundColor, fg:cs.color,
          stored:localStorage.getItem('pc_theme')};
});
ok('toggling reaches dark', dark.theme===null||dark.theme!=='light', String(dark.theme));
ok('dark theme is genuinely dark', lum(dark.bg)<0.2, dark.bg);
ok('dark theme text is readable on it', ratio(dark.fg,dark.bg)>=4.5,
   ratio(dark.fg,dark.bg).toFixed(2)+':1');
ok('the choice is stored under the shared pc_theme key', dark.stored==='dark', dark.stored);

// The whole point of the shared key: the admin app must agree.
// browser.newPage() opens its own context with its own localStorage, so reusing the
// portal's context is what actually proves the key is shared.
const admin=await ctx.newPage();
await admin.goto(BASE+'/index.html',{waitUntil:'domcontentloaded'});
ok('the admin app honours the portal\'s choice in the same browser',
   await admin.evaluate(()=>document.documentElement.getAttribute('data-theme')!=='light'));
await admin.close();

await page.evaluate(()=>{ localStorage.setItem('pc_theme','light'); });
await page.reload({waitUntil:'networkidle'});
ok('the choice survives a reload with no flash of the wrong theme', await page.evaluate(()=>
   document.documentElement.getAttribute('data-theme')==='light'));

console.log('\n── design tokens ──────────────────────────────');
const tok = await page.evaluate(()=>{
  const cs=getComputedStyle(document.documentElement);
  return ['--s4','--r-md','--r-lg','--h-sm'].map(v=>cs.getPropertyValue(v).trim());
});
ok('shares the admin app\'s scales', tok.every(Boolean), tok.join(' '));

console.log('\n── phone ──────────────────────────────────────');
await page.setViewportSize({width:390,height:844});
await page.waitForTimeout(250);
const mob = await page.evaluate(()=>{
  const tabs=document.querySelector('.tabs-bar');
  return {tableHidden:getComputedStyle(document.querySelector('#punchBody').closest('table')).display==='none',
          cardsShown:getComputedStyle(document.getElementById('punchCards')).display!=='none',
          tabsScroll:getComputedStyle(tabs).overflowX,
          tabsOverflow:tabs.scrollWidth>tabs.clientWidth};
});
ok('the punch table steps aside', mob.tableHidden);
ok('cards take over so the screen is not blank', mob.cardsShown);
ok('the tab bar can scroll when it overflows', mob.tabsScroll==='auto'||mob.tabsScroll==='scroll', mob.tabsScroll);

ok('no horizontal page scroll', await page.evaluate(()=>
   document.documentElement.scrollWidth<=window.innerWidth+1));
ok('no page errors', errs.length===0, errs.join(' / '));
await page.close();
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
