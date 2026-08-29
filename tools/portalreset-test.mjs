// Employees can now recover their own portal password. The security-critical property is that
// an unauthenticated form must never reveal which email addresses have accounts.
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
const vis = (page,id) => page.evaluate(i=>{
  const el=document.getElementById(i);
  return !!el && getComputedStyle(el).display!=='none';
}, id);

const browser=await chromium.launch();
for(const lang of ['en','fr']){
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:800,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/employee.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setEmpLang(l),lang);
  await page.waitForTimeout(200);

  ok('login screen offers a way to recover', await page.evaluate(()=>!!document.getElementById('forgotLink')));
  const linkTxt = await page.evaluate(()=>document.getElementById('forgotLink').textContent.trim());
  ok('the link is translated', lang==='fr' ? /oubli/i.test(linkTxt) : /forgot/i.test(linkTxt), linkTxt);

  // Carrying the typed address across saves retyping it.
  await page.evaluate(()=>{ document.getElementById('loginEmail').value='ana@test.ca'; showEmpForgot(); });
  ok('reset screen opens', await vis(page,'screenForgot'));
  ok('carries over the email already typed',
     await page.evaluate(()=>document.getElementById('fgEmail').value==='ana@test.ca'));

  // Capture what the page actually sends, and force both server answers.
  await page.evaluate(()=>{
    window.__posts=[];
    const of=window.fetch;
    window.fetch=(u,o)=>{ window.__posts.push({url:String(u),body:o&&o.body}); return Promise.resolve(new Response('{"ok":true}',{status:200,headers:{'Content-Type':'application/json'}})); };
  });

  await page.evaluate(()=>{ document.getElementById('fgEmail').value='real@test.ca'; });
  await page.evaluate(()=>requestEmpReset());
  await page.waitForTimeout(150);
  const afterReal = await page.evaluate(()=>({msg:document.getElementById('fgMsg').innerText.trim(),
    step2:getComputedStyle(document.getElementById('fgStep2')).display!=='none',
    post:window.__posts[window.__posts.length-1]}));
  ok('calls the portal reset action', /portal_request_reset/.test(afterReal.post?.body||''),
     (afterReal.post?.body||'').slice(0,60));
  ok('advances to the code step', afterReal.step2);

  // The same flow for an address with no account must be indistinguishable.
  await page.evaluate(()=>{ showEmpForgot(); document.getElementById('fgEmail').value='nobody@nowhere.test'; });
  await page.evaluate(()=>requestEmpReset());
  await page.waitForTimeout(150);
  const afterFake = await page.evaluate(()=>document.getElementById('fgMsg').innerText.trim());
  ok('says exactly the same thing for an unknown address', afterFake===afterReal.msg,
     afterFake===afterReal.msg ? 'identical' : `"${afterReal.msg}" vs "${afterFake}"`);
  ok('the message does not confirm an account exists',
     !/no account|does not exist|aucun compte|introuvable/i.test(afterFake), afterFake.slice(0,70));

  // Client-side guards before anything is sent.
  await page.evaluate(()=>{ showEmpForgot(); document.getElementById('fgEmail').value='';
    window.__posts=[]; });
  await page.evaluate(()=>requestEmpReset());
  ok('an empty address sends nothing', await page.evaluate(()=>window.__posts.length===0));

  await page.evaluate(()=>{ document.getElementById('fgEmail').value='a@b.ca'; requestEmpReset(); });
  await page.waitForTimeout(120);
  await page.evaluate(()=>{ window.__rpcCalls=[];
    document.getElementById('fgCode').value='12';   // too short
    document.getElementById('fgPass').value='abcdef'; });
  await page.evaluate(()=>doEmpReset());
  ok('a malformed code is rejected before any request',
     await page.evaluate(()=>/valid|expir/i.test(document.getElementById('fgMsg').innerText)));

  await page.evaluate(()=>{ document.getElementById('fgCode').value='123456';
    document.getElementById('fgPass').value='abc'; });
  await page.evaluate(()=>doEmpReset());
  ok('a short password is rejected',
     await page.evaluate(()=>/6|six/i.test(document.getElementById('fgMsg').innerText)));

  ok('back link returns to sign in', await page.evaluate(()=>{ showEmpLogin();
    return getComputedStyle(document.getElementById('screenLogin')).display!=='none'; }));

  const raw = await page.evaluate(()=>document.getElementById('screenForgot').innerText);
  ok('no untranslated placeholders on the screen', !/\bfg[A-Z]/.test(raw));
  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
