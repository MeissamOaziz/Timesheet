// One knowledge base behind two surfaces. The failure modes: a landing FAQ full of questions
// only existing customers ask, a help centre that cannot find the thing someone is stuck on,
// and structured data describing a page that does not exist.
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
  console.log(`\n── ${lang.toUpperCase()} ──────────────────────────────`);
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'networkidle'});
  await page.evaluate(l=>setLang(l),lang);
  await page.waitForTimeout(300);

  // ── landing FAQ is pre-sale only ──
  const faq = await page.evaluate(()=>{
    renderFAQ();
    return {count:document.querySelectorAll('#faqAccordion .faq-item').length,
            text:document.getElementById('faqAccordion').innerText};
  });
  // 12, not 11: FAQ_SALES gained q24 (the employee self-service portal), added because the
  // portal existed nowhere in the landing page, the meta tags, or the FAQPage rich-result data.
  ok('landing FAQ is trimmed to the pre-sale set', faq.count===12, faq.count+' questions');
  ok('troubleshooting is no longer on the sales page',
     !/reset it|réinitialiser/i.test(faq.text) && !/alert emails|courriels d.alerte/i.test(faq.text));
  ok('the buying questions are still there',
     /free plan|plan gratuit|forfait gratuit/i.test(faq.text) && /secure|sécur/i.test(faq.text));

  // ── the help centre absorbed them ──
  const arts = await page.evaluate(()=>HELP_ARTICLES.length);
  ok('help centre carries the whole knowledge base', arts===23, arts+' articles');

  // The article a locked-out customer needs must be findable by what they would type.
  for(const term of ['reset','kiosk','stuck','tablet']){
    const hit = await page.evaluate(q=>{
      const terms=_helpNorm(q).split(/\s+/).filter(Boolean);
      return HELP_ARTICLES.map(a=>({id:a.id,s:_helpScore(a,terms)}))
        .filter(x=>x.s>0).sort((a,b)=>b.s-a.s).map(x=>x.id);
    }, term);
    ok(`searching "${term}" surfaces the device-reset article`, hit.includes('kioskreset'),
       hit.slice(0,4).join(', ')||'(nothing)');
  }
  // And in French, since half the customers search in French.
  const fr = await page.evaluate(()=>{
    const terms=_helpNorm('réinitialiser').split(/\s+/).filter(Boolean);
    return HELP_ARTICLES.map(a=>({id:a.id,s:_helpScore(a,terms)}))
      .filter(x=>x.s>0).sort((a,b)=>b.s-a.s).map(x=>x.id);
  });
  ok('and "réinitialiser" does too', fr.includes('kioskreset'), fr.slice(0,3).join(', ')||'(nothing)');

  // ── every article resolves to real copy ──
  const broken = await page.evaluate(()=>HELP_ARTICLES
    .filter(a=>{const ti=t(a.tk), de=t(a.dk); return !ti||ti===a.tk||!de||de===a.dk;})
    .map(a=>a.id));
  ok('every article has a title and body in this language', broken.length===0, broken.join(', '));

  const badCat = await page.evaluate(()=>{
    const known=HELP_CATS.map(c=>c[0]);
    return HELP_ARTICLES.filter(a=>!known.includes(a.cat)).map(a=>a.id);
  });
  ok('every article sits in a real category', badCat.length===0, badCat.join(', '));

  // ── page-aware section ──
  const rel = await page.evaluate(()=>{
    showHelpModal('punch');
    const secs=[...document.querySelectorAll('#helpBody .help-sec')].map(s=>s.textContent.trim());
    const first=document.querySelector('#helpBody .help-art.hot');
    closeModal('helpModal');
    return {secs, hasHot:!!first};
  });
  ok('help opens with a "for this screen" section', rel.hasHot, rel.secs[0]||'(none)');
  ok('section headings are translated', !rel.secs.some(x=>/^help\./.test(x)), rel.secs.join(' | '));

  ok('no page errors', errs.length===0, errs.join(' / '));
  await page.close();
}

// ── structured data ──
console.log('\n── structured data ────────────────────────────');
const page=await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`,{waitUntil:'domcontentloaded'});
const ld = await page.evaluate(()=>{
  for(const s of document.querySelectorAll('script[type="application/ld+json"]')){
    let d; try{ d=JSON.parse(s.textContent); }catch(e){ return {bad:e.message}; }
    if(d['@type']==='FAQPage') return {n:d.mainEntity.length, lang:d.inLanguage,
      names:d.mainEntity.map(q=>q.name), answers:d.mainEntity.map(q=>q.acceptedAnswer.text)};
  }
  return null;
});
ok('FAQPage JSON is valid', ld && !ld.bad, ld&&ld.bad?ld.bad:'parsed');
ok('it declares a single language', ld && ld.lang==='en-CA', ld&&ld.lang);
ok('no French entries in the English block', ld && !ld.names.some(n=>/[àâçéèêëîïôùûü]/.test(n)));
ok('no duplicate questions', ld && new Set(ld.names).size===ld.names.length);
// 9, not 8: raised by one to fit q24 (employee self-service portal) into the rich-result set
// without demoting any of the eight questions already curated here.
ok('it lists the real top questions', ld && ld.n===9, ld&&String(ld.n));
ok('answers carry no leftover markup', ld && !ld.answers.some(a=>/<[a-z]/i.test(a)));
await page.close();

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
