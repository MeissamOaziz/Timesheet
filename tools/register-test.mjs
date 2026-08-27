// Registration is down to the fields an account actually needs. These checks guard the two
// ways that goes wrong: a removed field still being read (a crash at submit), and the
// defaults silently differing from what the untouched form used to send.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.ico':'image/x-icon'};
const server = await new Promise(r=>{const s=createServer(async(q,res)=>{try{
  const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';
  const f=normalize(join(ROOT,rel));
  if(!f.startsWith(normalize(ROOT))||!(await stat(f)).isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':MIME[extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
  createReadStream(f).pipe(res);}catch{res.writeHead(404).end();}});s.listen(0,'127.0.0.1',()=>r(s));});

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await page.evaluate(()=>navigate('register'));
  await page.waitForTimeout(250);

  const fields = await page.evaluate(()=>
    [...document.querySelectorAll('#regStep1 input, #regStep1 select')].map(e=>e.id).filter(Boolean));
  ok('only the essential fields remain',
     JSON.stringify(fields)===JSON.stringify(['regFirstName','regLastName','regEmail','regPass','regCompany']),
     fields.join(', '));

  ok('no raw i18n keys on the form', await page.evaluate(()=>
    !/\b(reg|login|modal)\.[a-zA-Z]+/.test(document.getElementById('regStep1').innerText)),
    await page.evaluate(()=>(document.getElementById('regStep1').innerText.match(/\b(reg|login|modal)\.[a-zA-Z]+/g)||[]).join(',')));

  // Submitting must reach the network step, not die on a missing element. Stub the lookup
  // so nothing is actually created, and capture what would have been sent.
  const sent = await page.evaluate(async ()=>{
    document.getElementById('regFirstName').value='Jane';
    document.getElementById('regLastName').value='Smith';
    document.getElementById('regEmail').value='jane@example.test';
    document.getElementById('regPass').value='secret123';
    document.getElementById('regCompany').value='Acme Corp';
    DB.all = async ()=>[];                             // email not taken
    DB.requestRegistrationCode = async ()=>({ok:true}); // don't send a real email
    await doRegister();
    return { pending: pendingVerify, step2: document.getElementById('regStep2').style.display!=='none' };
  });
  ok('submit advances to the verification step', sent.step2);
  ok('defaults match what the untouched form used to send',
     sent.pending && sent.pending.weekStart==='monday' && sent.pending.payrollFreq==='weekly'
       && sent.pending.anchorDate===null && sent.pending.trackOvertime===false
       && sent.pending.logoFile===null && sent.pending.address==='' && sent.pending.phone===''
       && sent.pending.industry==='',
     sent.pending ? `week=${sent.pending.weekStart} freq=${sent.pending.payrollFreq} ot=${sent.pending.trackOvertime}` : 'no payload');
  ok('the entered values survive', sent.pending
     && sent.pending.company==='Acme Corp' && sent.pending.firstName==='Jane'
     && sent.pending.email==='jane@example.test');

  // Missing company must still be caught now that the check moved.
  const blocked = await page.evaluate(async ()=>{
    document.getElementById('regStep2').style.display='none';
    document.getElementById('regStep1').style.display='';
    document.getElementById('regCompany').value='';
    await doRegister();
    return document.getElementById('regStep1').style.display!=='none';
  });
  ok('missing company name is still rejected', blocked);

  // ── the payroll prompt that replaced those fields ──
  const st = async o => page.evaluate(s=>{
    window._demoMode=false;
    localStorage.setItem('pc_sess',JSON.stringify({id:'a1',email:'o@t.ca',status:'active'}));
    localStorage.removeItem('pc_payroll_prompt');
    C.companies=[{id:'co1',name:'Acme',admin_id:'a1'}];
    C.sites=[{id:'s1',name:'S1',company_id:'co1'}];
    C.employees=[{id:'e1',name:'Ana',pin:'1',site_id:'s1',company_id:'co1',active:true}];
    C.punches = s.punches ? [{id:'p1',emp_id:'e1',type:'IN',company_id:'co1'}] : [];
    Ctx.set({co:{id:'co1',name:'Acme'}});
    document.getElementById('setupChecklist').style.display = s.checklist ? '' : 'none';
    renderPayrollPrompt();
    return document.getElementById('payrollPrompt');
  }, o);

  await st({punches:false, checklist:false});
  ok('no prompt before any punches exist', await page.evaluate(()=>
    document.getElementById('payrollPrompt').style.display==='none'));

  await st({punches:true, checklist:true});
  ok('no prompt while the setup checklist is still up', await page.evaluate(()=>
    document.getElementById('payrollPrompt').style.display==='none'));

  await st({punches:true, checklist:false});
  const shown = await page.evaluate(()=>({
    vis: document.getElementById('payrollPrompt').style.display!=='none',
    txt: document.getElementById('payrollPrompt').innerText }));
  ok('prompt appears once punches exist and setup is done', shown.vis);
  ok('prompt copy resolved', !/\bpayroll\.[a-zA-Z]+/.test(shown.txt),
     shown.txt.replace(/\n/g,' | ').trim().slice(0,90));

  ok('dismiss sticks', await page.evaluate(()=>{
    dismissPayrollPrompt(); renderPayrollPrompt();
    return document.getElementById('payrollPrompt').style.display==='none'; }));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
