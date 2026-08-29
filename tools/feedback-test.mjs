// A one-question prompt for someone who came back after being away. It must be rare, must not
// stack on the other dashboard prompts, and must never ask twice.
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

const setup = (page, o) => page.evaluate(s=>{
  window._demoMode=false;
  localStorage.setItem('pc_sess',JSON.stringify({id:'a1',email:'o@t.ca',status:'active',token:'tok'}));
  localStorage.removeItem('pc_feedback_asked');
  C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
  C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
  C.employees=[{id:'e1',name:'Ana',pin:'1',site_id:'s1',company_id:'co1',active:true}];
  C.punches=[{id:'p1',emp_id:'e1',type:'IN',company_id:'co1'}];
  Ctx.set({co:{id:'co1',name:'Acme'}});
  if(s.prevLoginDaysAgo===null) sessionStorage.removeItem('pc_prev_login');
  else sessionStorage.setItem('pc_prev_login', new Date(Date.now()-s.prevLoginDaysAgo*86400000).toISOString());
  document.getElementById('setupChecklist').style.display = s.checklist ? '' : 'none';
  document.getElementById('payrollPrompt').style.display  = s.payroll   ? '' : 'none';
  window.__rpc=[]; DB.rpc = async (fn,args)=>{ window.__rpc.push({fn,args}); return {ok:true}; };
  renderFeedbackPrompt();
}, o);
const shown = page => page.evaluate(()=>{
  const el=document.getElementById('feedbackPrompt');
  return el && getComputedStyle(el).display!=='none' ? el.innerText.replace(/\s+/g,' ').trim() : null;
});

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);

  await setup(page,{prevLoginDaysAgo:2,checklist:false,payroll:false});
  ok('not shown to someone who was here 2 days ago', (await shown(page))===null);

  await setup(page,{prevLoginDaysAgo:null,checklist:false,payroll:false});
  ok('not shown when there is no previous login to compare', (await shown(page))===null);

  await setup(page,{prevLoginDaysAgo:30,checklist:true,payroll:false});
  ok('never stacks on the setup checklist', (await shown(page))===null);
  await setup(page,{prevLoginDaysAgo:30,checklist:false,payroll:true});
  ok('never stacks on the payroll prompt', (await shown(page))===null);

  await setup(page,{prevLoginDaysAgo:30,checklist:false,payroll:false});
  const txt=await shown(page);
  ok('shown after a 30-day absence', !!txt, (txt||'').slice(0,70));
  ok('names the actual gap', /30/.test(txt||''));
  ok('offers the reason choices', await page.evaluate(()=>
    document.querySelectorAll('#feedbackPrompt button').length>=6));
  ok('no raw i18n keys', !/\b(fb|setup)\.[a-zA-Z]+/.test(txt||''),
     ((txt||'').match(/\b(fb|setup)\.[a-zA-Z]+/g)||[]).join(','));

  // Answering records the choice immediately, then offers an optional note.
  await page.evaluate(()=>submitFeedback('missing_feature'));
  await page.waitForTimeout(150);
  const call=await page.evaluate(()=>window.__rpc[0]);
  ok('the choice is written straight away',
     call && call.fn==='submit_inapp_feedback' && call.args.p_reason==='missing_feature',
     call?`${call.fn}(${call.args.p_reason})`:'(no call)');
  ok('the session token identifies the admin, not a client-supplied id',
     call && call.args.p_session==='tok' && !('p_admin_id' in call.args));
  ok('a free-text follow-up is offered', await page.evaluate(()=>!!document.getElementById('fbNote')));

  await page.evaluate(()=>{ document.getElementById('fbNote').value='Need shift swapping'; });
  await page.evaluate(()=>submitFeedbackNote('missing_feature'));
  await page.waitForTimeout(150);
  ok('the note is sent with the same reason', await page.evaluate(()=>{
    const c=window.__rpc[window.__rpc.length-1];
    return c.args.p_note==='Need shift swapping' && c.args.p_reason==='missing_feature'; }));

  // Asked once, ever.
  await page.evaluate(()=>renderFeedbackPrompt());
  ok('never asks the same account twice', (await shown(page))===null);

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
