// Private photo and logo buckets (2026-11-01). The avatars and logos buckets are private: the page only ever
// shows SIGNED urls handed back by secure-db, it uploads with the admin's session and a company id, and what it
// writes to the database is the stored address of the object (never a signed url it merely displayed).
// The network is stubbed; the server side is covered by tools/secure-db-regression/diff-test.mjs (group images).
//
// APP_ROOT=<dir> runs the same checks against another copy of the site (to prove the test fails before the change).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, resolve } from 'node:path';

const ROOT = process.env.APP_ROOT ? resolve(process.env.APP_ROOT) : join(dirname(fileURLToPath(import.meta.url)), '..');
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

const SUPA='https://uziwymrwaeojhqaagqcm.supabase.co';
const SITE='11111111-1111-4111-8111-111111111111', CO='22222222-2222-4222-8222-222222222222';
const PUB=`${SUPA}/storage/v1/object/public`, SIGNED=`${SUPA}/storage/v1/object/sign`;
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const E1='00000000-0000-4000-8000-0000000000a1', E2='00000000-0000-4000-8000-0000000000a2';

const browser=await chromium.launch();
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)});

// ───────────────────────── terminal ─────────────────────────
console.log('\n── terminal (kiosk) ──');
{
  const ctx=await browser.newContext({viewport:{width:1100,height:900}, permissions:['geolocation'], geolocation:{latitude:45.5,longitude:-73.5}});
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const calls=[], imgReqs=[];
  const boot={ok:true,site:{id:SITE,name:'Front desk',company_id:CO,lang:'en',geo_strict:false},
    company:{id:CO,name:'Acme',punch_label_mode:'off',logo_url:`${SIGNED}/logos/${CO}/logo-aaa.png?token=T1`},
    employees:[{id:E1,name:'Ann Lee',emp_code:'A1',site_id:SITE,company_id:CO,active:true,has_pin:true,has_email:false,photo_url:`${SIGNED}/avatars/${CO}/emp-1.png?token=T2`},
               {id:E2,name:'Bob Roy',emp_code:'A2',site_id:SITE,company_id:CO,active:true,has_pin:true,has_email:false,photo_url:null}]};
  await page.route('**/rest/v1/rpc/**', async route=>{ const fn=route.request().url().split('/rpc/')[1]; calls.push({kind:'rpc',fn}); return json(route,{ok:false,error:'direct bootstrap must not be needed'}); });
  await page.route('**/functions/v1/secure-db', async route=>{
    const b=JSON.parse(route.request().postData()||'{}'); calls.push({kind:'db',...b});
    if(b.action==='kiosk_bootstrap') return json(route,boot);
    if(b.table==='employees'&&b.method==='GET') return json(route,boot.employees);
    return json(route,[]);
  });
  await page.route('**/storage/v1/object/**', route=>{ imgReqs.push(route.request().url()); return route.fulfill({status:200,contentType:'image/png',body:PNG}); });
  await page.goto(`${BASE}/index.html?kiosk=${SITE}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof C!=='undefined'&&C.employees&&C.employees.length>0,null,{timeout:15000}).catch(()=>{});
  ok('the terminal asks secure-db for its bootstrap (signed urls), with its site id', calls.some(c=>c.kind==='db'&&c.action==='kiosk_bootstrap'&&c.kioskSiteId===SITE));
  ok('and does not read it straight from the database', !calls.some(c=>c.kind==='rpc'&&/get_kiosk_bootstrap/.test(c.fn)));
  const logoSrc=await page.evaluate(()=>document.querySelector('#punchCoLogo img')?.getAttribute('src')||null);
  ok('the company logo on the punch card is the signed url', typeof logoSrc==='string'&&logoSrc.includes('/object/sign/logos/')&&logoSrc.includes('token=T1'), String(logoSrc).slice(0,90));
  ok('the page never asks for a public (bare) storage address', !imgReqs.some(u=>u.includes('/object/public/')), JSON.stringify(imgReqs.filter(u=>u.includes('/object/public/'))));
  ok('employees keep their photo field as received', await page.evaluate(()=>C.employees[0].photo_url.includes('/object/sign/avatars/')&&C.employees[1].photo_url===null));
  ok('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  await ctx.close();
}

console.log('\n── terminal falls back when secure-db has no bootstrap action ──');
{
  const ctx=await browser.newContext({viewport:{width:1100,height:900}});
  const page=await ctx.newPage();
  const calls=[];
  await page.route('**/rest/v1/rpc/**', async route=>{ const fn=route.request().url().split('/rpc/')[1]; calls.push(fn);
    return json(route,fn==='get_kiosk_bootstrap_v2'?{ok:true,site:{id:SITE,name:'S',company_id:CO,lang:'en'},company:{id:CO,name:'Acme',punch_label_mode:'off'},employees:[{id:E1,name:'Ann Lee',site_id:SITE,company_id:CO,active:true,has_pin:true}]}:{}); });
  await page.route('**/functions/v1/secure-db', route=>{ const b=JSON.parse(route.request().postData()||'{}');
    if(b.action==='kiosk_bootstrap') return json(route,{error:'Unknown action'},400);
    if(b.table==='employees'&&b.method==='GET') return json(route,[{id:E1,name:'Ann Lee',site_id:SITE,company_id:CO,active:true,has_pin:true}]);
    return json(route,[]); });
  await page.route('**/storage/v1/**', r=>r.fulfill({status:400,body:''}));
  await page.goto(`${BASE}/index.html?kiosk=${SITE}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof C!=='undefined'&&C.employees&&C.employees.length>0,null,{timeout:15000}).catch(()=>{});
  ok('the terminal still loads (direct bootstrap is the fallback)', await page.evaluate(()=>typeof C!=='undefined'&&C.employees.length===1)&&calls.includes('get_kiosk_bootstrap_v2'));
  await ctx.close();
}

// ───────────────────────── admin: uploads ─────────────────────────
console.log('\n── admin uploads ──');
{
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  await ctx.addInitScript(()=>{ try{ localStorage.setItem('pc_sess',JSON.stringify({id:'00000000-0000-4000-8000-0000000000aa',name:'Owner',email:'owner@example.test',role:'admin',plan:'starter',token:'tok-test'})); }catch(_){} });
  const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  page.on('dialog',d=>d.dismiss().catch(()=>{}));
  const uploads=[], writes=[];
  await page.route('**/functions/v1/storage-upload', route=>{
    const b=JSON.parse(route.request().postData()||'{}'); uploads.push(b);
    const name=`${b.companyId}/${b.fileName.replace(/\.[a-z]+$/,'')}-abc123.png`;
    return json(route,{ok:true,url:`${PUB}/${b.bucket}/${name}`,signedUrl:`${SIGNED}/${b.bucket}/${name}?token=PREVIEW`});
  });
  await page.route('**/functions/v1/secure-db', route=>{ const b=JSON.parse(route.request().postData()||'{}'); if(b.method&&b.method!=='GET') writes.push(b); return json(route,[]); });
  await page.route('**/rest/v1/**', route=>json(route,[]));
  await page.route('**/storage/v1/object/**', route=>route.fulfill({status:200,contentType:'image/png',body:PNG}));
  await page.goto(BASE+'/index.html',{waitUntil:'load'});
  await page.waitForTimeout(900);
  const res=await page.evaluate(async({PNG,CO})=>{
    const bytes=Uint8Array.from(atob(PNG),c=>c.charCodeAt(0));
    const file=new File([bytes],'photo.png',{type:'image/png'});
    const url=await uploadImage(file,'avatars','emp-1',{companyId:CO,employeeId:null});
    return {url,view:viewUrl(url),other:viewUrl('https://x.example/y.png'),none:viewUrl(null)};
  },{PNG:PNG.toString('base64'),CO});
  ok('the upload carries the admin session token and the company', uploads.length===1&&uploads[0].sessionToken==='tok-test'&&uploads[0].companyId===CO&&uploads[0].bucket==='avatars');
  ok('the stored address is returned for the database (public-style, in the company folder)', res.url===`${PUB}/avatars/${CO}/emp-1-abc123.png`.replace(/emp-1-abc123/, res.url.split('/').pop().replace('.png','')) && res.url.includes(`/object/public/avatars/${CO}/`), res.url);
  ok('the page shows the signed preview for that address', res.view.includes('/object/sign/avatars/')&&res.view.includes('token=PREVIEW'));
  ok('addresses it did not upload are shown unchanged', res.other==='https://x.example/y.png'&&res.none===null);
  ok('uploadImage never sends the public key as the only credential', uploads.every(u=>!!u.sessionToken));
  const demo=await page.evaluate(async({PNG})=>{
    window._demoMode=true; const before=0;
    const bytes=Uint8Array.from(atob(PNG),c=>c.charCodeAt(0));
    const u=await uploadImage(new File([bytes],'d.png',{type:'image/png'}),'logos','x',{});
    window._demoMode=false; return u;
  },{PNG:PNG.toString('base64')});
  ok('the sandboxed demo keeps the picture local (no upload)', typeof demo==='string'&&demo.startsWith('data:')&&uploads.length===1);
  ok('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
