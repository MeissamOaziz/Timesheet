// Work labels (jobs) at remote clock-in on the employee portal (employee.html). fetch is stubbed, so
// this checks the page's behaviour only; the SQL (supabase/migrations/20261031_portal_punch_label.sql)
// is reviewed, not run, by this suite.
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
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

const LABELS=[{id:'11111111-1111-1111-1111-111111111111',name:'Client A',color:'#e11d48'},
              {id:'22222222-2222-2222-2222-222222222222',name:'Client <B>',color:'#2563eb'}];

const browser=await chromium.launch();

// Opens the portal as a signed-in employee whose company uses labels in `mode` ('off' = server returns
// no labels). Records every rpc call so the test can see what was sent.
async function open(mode, {punchReply, lastType='OUT'}={}){
  const ctx=await browser.newContext({viewport:{width:390,height:800}});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const calls=[];
  await page.route('**/rest/v1/rpc/*',async route=>{
    const fn=route.request().url().split('/rpc/')[1];
    const body=JSON.parse(route.request().postData()||'{}');
    calls.push({fn,body});
    let out=[];
    if(fn==='portal_get_company_payroll') out=[{remote_punch_enabled:true}];
    else if(fn==='portal_get_punches') out=lastType==='IN'?[{type:'IN',punched_at:new Date(Date.now()-3600e3).toISOString()}]:[];
    else if(fn==='portal_get_punch_labels') out=mode==='off'?[]:LABELS.map(l=>({mode,...l}));
    else if(fn==='portal_punch') out=[punchReply||{ok:true,error_code:null}];
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(out)});
  });
  await page.goto(BASE+'/employee.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{
    _session={token:'tok',siteId:'33333333-3333-3333-3333-333333333333',employeeId:'e1'};
    _employee={remote_punch_enabled:true};
    document.getElementById('screenApp').style.display='block';
  });
  await page.evaluate(()=>initPunchBar());
  return {ctx,page,calls,errs};
}
const punchCalls=c=>c.filter(x=>x.fn==='portal_punch');
const shown=page=>page.evaluate(()=>getComputedStyle(document.getElementById('plOverlay')).display!=='none');

console.log('\n── labels off: the punch bar behaves exactly as before ──');
{
  const {ctx,page,calls,errs}=await open('off');
  await page.evaluate(()=>{doPunch();});
  await page.waitForFunction(()=>true);
  await page.waitForTimeout(300);
  ok('no picker is shown', !(await shown(page)));
  ok('the punch is sent straight away', punchCalls(calls).length===1);
  ok('and carries no p_label_id', !('p_label_id' in punchCalls(calls)[0].body));
  ok('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

console.log('\n── optional: the picker opens on the way IN ──');
{
  const {ctx,page,calls,errs}=await open('optional');
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(200);
  ok('the picker is shown before anything is sent', (await shown(page)) && punchCalls(calls).length===0);
  const names=await page.$$eval('#plList button',b=>b.map(x=>x.textContent));
  ok('it lists the company labels', names.length===2 && names[0]==='Client A');
  ok('label names are escaped, not injected as HTML', names[1]==='Client <B>' && (await page.$$('#plList button b')).length===0);
  ok('Skip is offered when optional', await page.$eval('#plSkipBtn',e=>getComputedStyle(e).display!=='none'));
  await page.click('#plList button:nth-child(2)');
  await page.waitForTimeout(300);
  const sent=punchCalls(calls);
  ok('choosing a job sends one punch with that job', sent.length===1 && sent[0].body.p_label_id===LABELS[1].id && sent[0].body.p_type==='IN');
  ok('the picker closes', !(await shown(page)));
  ok('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}
{
  const {ctx,page,calls}=await open('optional');
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(200);
  await page.click('#plSkipBtn');
  await page.waitForTimeout(300);
  ok('Skip clocks in without a job', punchCalls(calls).length===1 && !('p_label_id' in punchCalls(calls)[0].body));
  await ctx.close();
}
{
  const {ctx,page,calls}=await open('optional');
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(200);
  await page.click('#plCancelBtn');
  await page.waitForTimeout(300);
  ok('Cancel records nothing', punchCalls(calls).length===0);
  ok('and the Clock In button is usable again', await page.$eval('#punchBtn',b=>!b.disabled));
  ok('with its label restored', (await page.textContent('#punchBtnLabel'))==='Clock In');
  await ctx.close();
}

console.log('\n── required: no way to skip ──');
{
  const {ctx,page,calls}=await open('required');
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(200);
  ok('Skip is hidden', await page.$eval('#plSkipBtn',e=>getComputedStyle(e).display==='none'));
  await page.click('#plList button:nth-child(1)');
  await page.waitForTimeout(300);
  ok('the chosen job is sent', punchCalls(calls)[0]?.body.p_label_id===LABELS[0].id);
  await ctx.close();
}

console.log('\n── clocking OUT never asks ──');
{
  const {ctx,page,calls}=await open('required',{lastType:'IN'});
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(300);
  ok('no picker on the way out', !(await shown(page)));
  const sent=punchCalls(calls);
  ok('an OUT is sent with no job', sent.length===1 && sent[0].body.p_type==='OUT' && !('p_label_id' in sent[0].body));
  await ctx.close();
}

console.log('\n── server refusals reach the employee in both languages ──');
{
  const {ctx,page}=await open('optional',{punchReply:{ok:false,error_code:'label_required'}});
  await page.evaluate(()=>{doPunch();});
  await page.waitForTimeout(200);
  await page.click('#plList button:nth-child(1)');
  await page.waitForTimeout(300);
  ok('label_required shows its message', (await page.textContent('#punchError')).includes('choose what you are working on'));
  await ctx.close();
}
{
  const {ctx,page}=await open('optional');
  await page.evaluate(()=>{_empLang='fr';doPunch();});
  await page.waitForTimeout(200);
  ok('the picker is in French', (await page.textContent('#plTitle'))==='Sur quoi travaillez-vous?' && (await page.textContent('#plSkipBtn'))==='Passer');
  await ctx.close();
}

// My Hours: the job chosen at clock-in must be visible afterwards. Stubs portal_get_punches with the
// columns the 20261102 migration adds (label_name, label_color on the IN punch).
async function openHours(punches){
  const ctx=await browser.newContext({viewport:{width:1200,height:800}});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/rest/v1/rpc/*',async route=>{
    const fn=route.request().url().split('/rpc/')[1];
    let out=[];
    if(fn==='portal_get_company_payroll') out=[{remote_punch_enabled:true,payroll_frequency:'weekly',week_start:'monday'}];
    else if(fn==='portal_get_punches') out=punches;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(out)});
  });
  await page.goto(BASE+'/employee.html',{waitUntil:'networkidle'});
  await page.evaluate(()=>{_session={token:'tok',siteId:'33333333-3333-3333-3333-333333333333',employeeId:'e1'};_employee={remote_punch_enabled:true};
    document.getElementById('screenApp').style.display='block';});
  await page.evaluate(()=>renderReports());
  await page.waitForTimeout(300);
  return {ctx,page,errs};
}
const today=new Date().toLocaleDateString('en-CA');
const iso=(h,m)=>{const d=new Date();d.setHours(h,m,0,0);return d.toISOString();};
const pt=(h,m)=>`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
const P=(type,h,m,extra={})=>({id:`${type}${h}${m}`,type,punch_date:today,punch_time:pt(h,m),punched_at:iso(h,m),site_name:'S',...extra});

console.log('\n── My Hours shows the job chosen at clock-in ──');
{
  const {ctx,page,errs}=await openHours([
    P('IN',8,0,{label_id:LABELS[1].id,label_name:'Client <B>',label_color:'#2563eb'}),P('OUT',10,0),
    P('IN',10,30),P('OUT',12,0)]);
  ok('the Job column header is visible', await page.evaluate(()=>getComputedStyle(document.getElementById('thLabel')).display!=='none'));
  const rows=await page.$$eval('#punchBody tr',r=>r.map(x=>[...x.children].map(c=>c.textContent.trim())));
  ok('a labelled shift shows its job', rows.length===2 && rows[0].includes('Client <B>'), JSON.stringify(rows));
  ok('an unlabelled shift shows a dash in that column', rows[1] && rows[1][3]==='—', JSON.stringify(rows[1]));
  ok('the name is escaped, not injected as HTML', (await page.$$('#punchBody b')).length===0);
  ok('the phone cards carry the job too', (await page.$eval('#punchCards',e=>e.textContent)).includes('Client <B>'));
  ok('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}
{
  const {ctx,page,errs}=await openHours([P('IN',8,0),P('OUT',10,0)]);
  ok('no labels in the period: no Job column, page exactly as before',
     !(await page.evaluate(()=>getComputedStyle(document.getElementById('thLabel')).display!=='none'))
     && (await page.$$eval('#punchBody tr:first-child td',c=>c.length))===4);
  ok('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}
{
  // A page talking to the OLD function (no label columns at all) must still work.
  const {ctx,page,errs}=await openHours([{id:'a',type:'IN',punch_date:today,punch_time:'08:00:00',punched_at:iso(8,0),site_name:'S'},
                                         {id:'b',type:'OUT',punch_date:today,punch_time:'10:00:00',punched_at:iso(10,0),site_name:'S'}]);
  ok('old server shape (no label columns) renders without errors', errs.length===0 && (await page.$$('#punchBody tr')).length===1, errs.join(' | '));
  await ctx.close();
}
{
  const {ctx,page}=await openHours([P('IN',8,0,{label_name:'Client A',label_color:'#e11d48'})]);
  await page.evaluate(()=>initPunchBar());
  await page.waitForTimeout(300);
  const sub=await page.textContent('#punchStatusSub');
  ok('the clocked-in bar names the job', sub.includes('Client A'), sub);
  await ctx.close();
}
{
  const {ctx,page}=await openHours([P('IN',8,0,{label_name:'Client A',label_color:'#e11d48'}),P('OUT',9,0)]);
  await page.evaluate(()=>initPunchBar());
  await page.waitForTimeout(300);
  const sub=await page.textContent('#punchStatusSub');
  ok('once clocked out the bar does not show a job', !sub.includes('Client A'), sub);
  await ctx.close();
}
{
  const {ctx,page}=await openHours([P('IN',8,0,{label_name:'Client A',label_color:'#e11d48'}),P('OUT',9,0)]);
  await page.evaluate(()=>{setEmpLang('fr');});
  ok('the column header is translated', (await page.textContent('#thLabel'))==='Travail');
  await ctx.close();
}

console.log('\n── the migration ──');
const sql2=readFileSync(join(ROOT,'supabase/migrations/20261102_portal_punches_label.sql'),'utf8');
ok('portal_get_punches returns the label, drops the old signature first', /drop function if exists public\.portal_get_punches\(text, date, date\);/.test(sql2) && /label_id uuid, label_name text, label_color text/.test(sql2));
ok('the label join is limited to the punch\'s own company', /left join work_labels w on w\.id = p\.label_id and w\.company_id = p\.company_id/.test(sql2));
ok('still only the session\'s own punches', /where p\.emp_id = v_emp/.test(sql2));
ok('grants stay anon + service_role only', /grant execute on function public\.portal_get_punches\(text, date, date\) to anon, service_role;/.test(sql2) && /revoke all on function[^;]*from authenticated;/.test(sql2));

console.log('\n── the migration (portal_punch) ──');
const sql=readFileSync(join(ROOT,'supabase/migrations/20261031_portal_punch_label.sql'),'utf8');
ok('replaces the old nine-argument portal_punch (no ambiguous overload)', /drop function if exists public\.portal_punch\(text, text, uuid, date, text, timestamptz, double precision, double precision, double precision\);/.test(sql));
ok('keeps the 48h late-sync window', sql.includes("interval '48 hours'") && !sql.includes("interval '72 hours'"));
ok('label list is gated on the add-on or its trial', (sql.match(/scheduling_trial_ends_at > now\(\)/g)||[]).length>=2);
ok('a label is only recorded on an IN', /if p_type = 'IN' then[\s\S]*label_id/.test(sql));
ok('label must belong to the employee\'s company and be active', /l\.id = p_label_id and l\.company_id = v_company_id and l\.active/.test(sql));

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
