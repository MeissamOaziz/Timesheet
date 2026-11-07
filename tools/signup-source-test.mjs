// Signup source (marketing attribution, 2026-11-06). The landing page remembers how a visitor arrived
// (utm_* tags of a campaign link, or the referring site's domain) and registration sends it, with the
// optional "How did you hear about us?" answer, to verify_code_and_register. These checks guard what can
// go wrong: hostile values kept as-is, the ?demo=1 link losing its tags, terminals recording anything,
// stale data living forever, and above all registration failing because of the tracking.
// Nothing here touches the network: every server call is stubbed inside the page.
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
const BASE=`http://127.0.0.1:${server.address().port}`;

let pass=0,fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`  ${c?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`);};
const browser=await chromium.launch();
// A fresh context per scenario, so localStorage starts empty. Supabase calls are blocked outright.
async function fresh(){
  const ctx=await browser.newContext({viewport:{width:1100,height:900}});
  await ctx.route(/supabase\.co/, r=>r.fulfill({status:200,contentType:'application/json',body:'[]'}));
  const page=await ctx.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  return {ctx,page,errs};
}
const stored = page => page.evaluate(()=>JSON.parse(localStorage.getItem('pc_signup_src')||'null'));

console.log('\n── capture ──────────────────────────────');
{ const {ctx,page,errs}=await fresh();
  await page.goto(`${BASE}/index.html?utm_source=Facebook&utm_medium=social&utm_campaign=launch&utm_content=p03-demo`,{waitUntil:'networkidle'});
  const v=await stored(page);
  ok('campaign tags are remembered (lower-cased)', v && v.s==='facebook' && v.m==='social' && v.c==='launch' && v.t==='p03-demo', JSON.stringify(v));
  ok('a timestamp is kept for expiry', v && v.at>0);
  // a later visit with no tags keeps the first campaign
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  ok('a later plain visit keeps the campaign', (await stored(page))?.s==='facebook');
  // a newer campaign link replaces it
  await page.goto(`${BASE}/index.html?utm_source=linkedin&utm_medium=social&utm_campaign=launch&utm_content=p08`,{waitUntil:'networkidle'});
  ok('a newer campaign link wins', (await stored(page))?.s==='linkedin');
  ok('no page errors', errs.length===0, errs.join(' / '));
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  const long='x'.repeat(200);
  await page.goto(`${BASE}/index.html?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E&utm_medium=so%20cial&utm_campaign=a'b%22c&utm_content=${long}`,{waitUntil:'networkidle'});
  const v=await stored(page);
  ok('hostile tags are reduced to plain tokens', v && v.s==='scriptalert1script' && v.m==='social' && v.c==='abc', JSON.stringify(v&&{s:v.s,m:v.m,c:v.c}));
  ok('tags are cut to 60 characters', v && v.t.length===60);
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html?demo=1&lang=fr&utm_source=facebook&utm_medium=social&utm_campaign=launch&utm_content=p01`,{waitUntil:'networkidle'});
  await page.waitForTimeout(400);
  const v=await stored(page);
  const url=await page.evaluate(()=>location.search);
  ok('the ?demo=1 link still records its tags', v && v.t==='p01', JSON.stringify(v));
  ok('the demo link still cleans its address', !/utm_/.test(url), url);
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle',referer:'https://m.facebook.com/some/path?fbclid=abc'});
  const v=await stored(page);
  ok('an outside referrer is kept as a host only', v && v.r==='m.facebook.com' && !v.s, JSON.stringify(v));
  await page.goto(`${BASE}/index.html?utm_source=facebook&utm_medium=social&utm_campaign=launch&utm_content=p02`,{waitUntil:'networkidle'});
  ok('a campaign visit keeps the earlier referrer', (await stored(page))?.r==='m.facebook.com');
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle',referer:'https://www.punchclock.ca/employee.html'});
  ok('our own site is not counted as a referrer', (await stored(page))===null);
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html?kiosk=00000000-0000-0000-0000-000000000000&utm_source=facebook`,{waitUntil:'networkidle'});
  ok('a kiosk terminal records nothing', (await stored(page))===null);
  await ctx.close(); }

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  const r=await page.evaluate(()=>{
    localStorage.setItem('pc_signup_src',JSON.stringify({s:'facebook',m:'',c:'',t:'',r:'',at:Date.now()-91*864e5}));
    const got=getSignupSource();
    return {got, left:localStorage.getItem('pc_signup_src')};
  });
  ok('a record older than 90 days is dropped', r.got===null && r.left===null);
  const junk=await page.evaluate(()=>{ localStorage.setItem('pc_signup_src','{not json'); return getSignupSource(); });
  ok('a corrupt record is ignored', junk===null);
  await ctx.close(); }

// ── registration ─────────────────────────────────────────────────────────────
// Fill the form, then run doRegister + doVerify with every server call stubbed; record what reaches rpc().
async function register(page,{record,heard,rpcMode}){
  return page.evaluate(async ({record,heard,rpcMode})=>{
    if(record) localStorage.setItem('pc_signup_src',JSON.stringify({...record,at:Date.now()}));
    else localStorage.removeItem('pc_signup_src');
    navigate('register');
    document.getElementById('regFirstName').value='Jane';
    document.getElementById('regLastName').value='Smith';
    document.getElementById('regEmail').value='jane@example.test';
    document.getElementById('regPass').value='secret123';
    document.getElementById('regCompany').value='Acme Corp';
    document.getElementById('regHeard').value=heard||'';
    DB.requestRegistrationCode=async()=>({ok:true});
    await doRegister();
    const calls=[];
    DB.rpc=async(fn,params)=>{
      calls.push({fn,params:JSON.parse(JSON.stringify(params))});
      if(rpcMode==='old-db' && calls.length===1){ const e=new Error('Could not find the function'); e._raw='{"code":"PGRST202","message":"Could not find the function public.verify_code_and_register"}'; throw e; }
      if(rpcMode==='network' ){ throw new Error('Failed to fetch'); }
      return {ok:true,id:'a1',name:'Jane Smith',email:'jane@example.test',company:null};
    };
    window._mintSessionToken=async()=>'tok';
    DB.update=async()=>[]; window.sendAppEmail=async()=>{}; window.refreshCache=async()=>{};
    document.getElementById('codeInput').value='123456';
    try{ await doVerify(); }catch(e){ return {calls,threw:String(e)}; }
    return {calls,left:localStorage.getItem('pc_signup_src'),msg:document.getElementById('registerMsg').innerText};
  },{record,heard,rpcMode});
}

for(const lang of ['en','fr']){
  console.log(`\n── registration (${lang.toUpperCase()}) ──────────────────────────────`);
  const {ctx,page,errs}=await fresh();
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await page.evaluate(()=>navigate('register'));
  const label=await page.evaluate(()=>document.querySelector('label[for="regHeard"]').innerText);
  ok('the question is translated', lang==='fr' ? /entendu parler/.test(label) : /hear about us/.test(label), label);
  const opts=await page.evaluate(()=>[...document.querySelectorAll('#regHeard option')].map(o=>o.value).join(','));
  ok('the answers match what the server accepts', opts===',facebook,instagram,linkedin,google,friend,accountant,other', opts);
  ok('the question is optional (blank by default)', await page.evaluate(()=>document.getElementById('regHeard').value===''));

  const a=await register(page,{record:{s:'facebook',m:'social',c:'launch',t:'p03-demo',r:'m.facebook.com'},heard:'accountant'});
  const p=a.calls[0]?.params||{};
  ok('registration sends the remembered campaign', p.p_signup_utm_source==='facebook' && p.p_signup_utm_medium==='social' && p.p_signup_utm_campaign==='launch' && p.p_signup_utm_content==='p03-demo', JSON.stringify(p).slice(0,120));
  ok('registration sends the referrer and the answer', p.p_signup_referrer_host==='m.facebook.com' && p.p_signup_heard==='accountant');
  ok('the usual registration fields are unchanged', p.p_email==='jane@example.test' && p.p_company_name==='Acme Corp' && p.p_week_start==='monday' && p.p_payroll_frequency==='weekly');
  ok('the remembered source is cleared after the account exists', a.left===null);

  const b=await register(page,{record:null,heard:''});
  const q=b.calls[0]?.params||{};
  ok('no source and no answer send nulls', ['p_signup_utm_source','p_signup_utm_medium','p_signup_utm_campaign','p_signup_utm_content','p_signup_referrer_host','p_signup_heard'].every(k=>q[k]===null));

  const c=await register(page,{record:{s:'facebook',m:'',c:'',t:'',r:''},heard:'google',rpcMode:'old-db'});
  ok('an older database (PGRST202) is retried once without the new fields', c.calls.length===2 && !Object.keys(c.calls[1].params).some(k=>k.startsWith('p_signup_')), `calls=${c.calls.length}`);
  ok('...and the account is still created', c.calls[1]?.params?.p_email==='jane@example.test' && !c.threw, c.threw||'');

  const d=await register(page,{record:{s:'facebook',m:'',c:'',t:'',r:''},heard:'',rpcMode:'network'});
  ok('a network failure is not retried as a signature problem', d.calls.length===1);
  ok('no page errors', errs.length===0, errs.join(' / '));
  await ctx.close();
}

{ const {ctx,page}=await fresh();
  await page.goto(`${BASE}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(()=>setLang('fr'));
  const li=await page.evaluate(()=>document.querySelector('[data-i18n="priv.liSignup"]').innerText);
  ok('the privacy policy says it, in French too', /Comment vous nous avez trouvés/.test(li), li.slice(0,60));
  await ctx.close(); }

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
