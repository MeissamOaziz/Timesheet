// Maps of where people punched: the one-punch map (colour by status, accuracy circle, dashed line with the distance,
// IN/OUT + time label), the crew map opened from Activity, and the geofence radius hint / site card. Runs in demo
// mode (sample data, nothing real). Leaflet itself comes from the same public CDN the app uses; map tiles are not
// fetched (the map is simply grey), everything else that leaves the browser is blocked.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon' };
const server = await new Promise(r => {
  const s = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(f).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  s.listen(0, '127.0.0.1', () => r(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };

const browser = await chromium.launch();
async function demoPage(width, height, lang) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.route(u => !u.href.startsWith(BASE) && !/fonts\.(googleapis|gstatic)\.com/.test(u.href) && !/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet/.test(u.href) && !u.href.startsWith('data:'), r => r.abort());
  const p = await ctx.newPage(); p._errs = []; p.on('pageerror', e => p._errs.push(e.message));
  await p.goto(BASE + 'index.html', { waitUntil: 'load' }); await sleep(500);
  await p.evaluate(l => { try { localStorage.setItem('pc_tour_v1', '1'); sessionStorage.setItem('pc_demo_coach', 'off'); setLang(l); } catch (e) {} }, lang);
  await p.evaluate(() => startDemo()); await sleep(600);
  await p.evaluate(() => { const b = document.getElementById('demoBanner'); if (b) b.remove(); _syncDemoBannerH(); const d = document.getElementById('demoCoach'); if (d) d.remove(); });
  return p;
}
// Give the first site a geofence and today's punches of its people a position, one of each kind.
const seed = p => p.evaluate(() => {
  const site = C.sites[0]; site.geo_lat = 45.52; site.geo_lng = -73.58; site.geo_radius_m = 75; site.geo_strict = true;
  const today = new Date().toLocaleDateString('en-CA');
  const mine = C.punches.filter(x => x.site_id === site.id && x.punch_date === today).sort((a, b) => a.punched_at < b.punched_at ? -1 : 1);
  const spec = [
    { type: 'IN', geo_lat: 45.52015, geo_lng: -73.58, geo_status: 'ok', geo_distance_m: 17, geo_accuracy_m: 12 },
    { type: 'OUT', geo_lat: 45.5216, geo_lng: -73.58, geo_status: 'outside', geo_distance_m: 178, geo_accuracy_m: 35 },
    { type: 'IN', geo_lat: null, geo_lng: null, geo_status: 'unavailable', geo_distance_m: null, geo_accuracy_m: null },
    { type: 'OUT', geo_lat: 45.5199, geo_lng: -73.5805, geo_status: 'ok', geo_distance_m: 9, geo_accuracy_m: 8 },
  ];
  const used = [];
  spec.forEach((g, i) => { const q = mine[i]; if (q) { Object.assign(q, g); used.push(q.id + ':' + q.type + ':' + g.geo_status); } });
  return { site: site.id, used, n: mine.length };
});
const info = p => p.evaluate(() => {
  const layers = []; _punchMap.eachLayer(l => layers.push(l));
  const circles = layers.filter(l => l instanceof L.Circle && !(l instanceof L.CircleMarker && !l.getRadius)), poly = layers.filter(l => l instanceof L.Polyline && !(l instanceof L.Polygon));
  return {
    circlesM: layers.filter(l => l.constructor === L.Circle).map(l => Math.round(l.getRadius())),
    marks: layers.filter(l => l.constructor === L.CircleMarker).map(l => ({ c: l.options.color, f: l.options.fillOpacity })),
    dashed: layers.filter(l => l.constructor === L.Polyline).map(l => l.options.dashArray),
    tips: [...document.querySelectorAll('#punchMapContainer .leaflet-tooltip')].map(e => e.innerText),
  };
});

console.log('\n── One-punch map ────────────────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  ok('Leaflet loaded', await p.evaluate(() => typeof L !== 'undefined'));
  const sd = await seed(p);
  ok('demo has today\'s punches to work with', sd.n >= 4, JSON.stringify(sd));
  const outsideId = await p.evaluate(() => C.punches.find(x => x.geo_status === 'outside').id);
  const insideId = await p.evaluate(() => C.punches.find(x => x.geo_status === 'ok' && x.type === 'IN').id);
  await p.evaluate(id => openPunchLocationMap(id), outsideId); await sleep(600);
  let r = await info(p);
  ok('outside punch: orange dot', r.marks.some(m => m.c === '#f59e0b'), JSON.stringify(r.marks));
  ok('outside punch: a light circle for the GPS accuracy (35 m) next to the site circle (75 m)', r.circlesM.includes(35) && r.circlesM.includes(75), JSON.stringify(r.circlesM));
  ok('outside punch: a dashed line to the site, with the distance written on it', r.dashed.includes('6 6') && r.tips.some(t => /^178 m$/.test(t)), JSON.stringify({ d: r.dashed, t: r.tips }));
  ok('outside punch: the label says OUT, the time and the name', r.tips.some(t => /^OUT \d\d:\d\d · \S+/.test(t)), JSON.stringify(r.tips));
  const sum = await p.evaluate(() => document.getElementById('punchMapSummary').innerText);
  ok('the summary gives status, distance and accuracy', /Outside the geofence/.test(sum) && /178 m/.test(sum) && /±35 m/.test(sum), sum);
  const lg = await p.evaluate(() => document.getElementById('punchMapLegend').innerText);
  ok('the legend explains colours, filled/ring and the accuracy circle', /Inside the geofence/.test(lg) && /Outside the geofence/.test(lg) && /Filled = IN/.test(lg) && /Ring = OUT/.test(lg) && /GPS accuracy/.test(lg), lg.replace(/\n/g, ' | '));
  const sz = await p.evaluate(() => { const m = document.querySelector('#punchMapModal .modal').getBoundingClientRect(), c = document.getElementById('punchMapContainer').getBoundingClientRect(); return { mw: Math.round(m.width), ch: Math.round(c.height) }; });
  ok('the window is bigger than before (was 520 x 280)', sz.mw > 700 && sz.ch >= 400, JSON.stringify(sz));
  await p.evaluate(() => { destroyPunchMap(); closeModal('punchMapModal'); });
  await p.evaluate(id => openPunchLocationMap(id), insideId); await sleep(600);
  r = await info(p);
  ok('inside punch: green dot, and an IN is a filled dot', r.marks.some(m => m.c === '#22c55e' && m.f > 0.5), JSON.stringify(r.marks));
  await p.evaluate(() => { destroyPunchMap(); closeModal('punchMapModal'); });
  // a name that tries to be markup must stay text
  await p.evaluate(id => { C.punches.find(x => x.id === id).emp_name = '<img src=x onerror=window.__x=1>Eve'; openPunchLocationMap(id); }, outsideId); await sleep(600);
  const xss = await p.evaluate(() => ({ img: document.querySelectorAll('#punchMapContainer img[src="x"], #punchMapSummary img').length, flag: !!window.__x }));
  ok('a name written as markup is shown as text on the map and in the summary', xss.img === 0 && !xss.flag, JSON.stringify(xss));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── Crew map from Activity ───────────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  const sd = await seed(p);
  await p.evaluate(() => navigate('activity')); await sleep(1500);
  ok('Activity has a Map button', await p.evaluate(() => { const b = document.getElementById('actMapBtn'); return !!b && b.offsetParent !== null && /Map/.test(b.innerText); }));
  const located = await p.evaluate(() => _actFiltered.filter(x => x.geo_lat != null).length);
  ok('the filtered list the map uses is the one Activity shows', await p.evaluate(() => _actFiltered.length > 0 && document.querySelectorAll('#activityBody tr').length >= _actFiltered.length - 1), 'located=' + located);
  await p.click('#actMapBtn'); await sleep(900);
  const m = await p.evaluate(() => {
    let dots = 0, rings = 0, siteC = 0; _crewMap.eachLayer(l => { if (l.constructor === L.CircleMarker) { if (l.options.fillOpacity > 0.5) dots++; else rings++; } if (l.constructor === L.Circle) siteC++; });
    return { open: document.getElementById('crewMapModal').classList.contains('open'), dots, rings, siteC, sum: document.getElementById('crewMapSummary').innerText, legend: document.getElementById('crewMapLegend').innerText };
  });
  ok('the crew map opens with one mark per located punch, the site circle, and a summary', m.open && m.dots + m.rings - 1 === located && m.siteC >= 1 && new RegExp(`${located} punches with a location, 1 outside`).test(m.sum), JSON.stringify(m));
  ok('IN are filled and OUT are rings', m.dots >= 1 && m.rings >= 1, JSON.stringify({ d: m.dots, r: m.rings }));
  const pop = await p.evaluate(() => { let c = null; _crewMap.eachLayer(l => { if (l.constructor === L.CircleMarker && l.getPopup && l.getPopup() && !c) c = l.getPopup().getContent(); }); return c; });
  ok('tapping a dot gives the name, IN/OUT, date and time, and the status', /<strong>.+<\/strong>/.test(pop) && /(IN|OUT) · \d{4}-\d\d-\d\d \d\d:\d\d/.test(pop) && /geofence/.test(pop), pop);
  await p.evaluate(() => { destroyCrewMap(); closeModal('crewMapModal'); });
  // nothing located
  await p.evaluate(() => { window._saveActF = _actFiltered; _actFiltered = _actFiltered.map(x => Object.assign({}, x, { geo_lat: null, geo_lng: null })); });
  await p.click('#actMapBtn'); await sleep(500);
  ok('with no located punch it says why instead of opening an empty map', await p.evaluate(() => !document.getElementById('crewMapModal').classList.contains('open') && /No punches with a location/.test(document.body.innerText)));
  // cap
  await p.evaluate(() => { const base = window._saveActF.find(x => x.geo_lat != null); _actFiltered = Array.from({ length: 305 }, (_, i) => Object.assign({}, base, { id: 'cap' + i, geo_lat: 45.52 + i * 1e-5, punched_at: new Date(Date.now() - i * 60000).toISOString() })); });
  await p.click('#actMapBtn'); await sleep(900);
  const c = await p.evaluate(() => { let n = 0; _crewMap.eachLayer(l => { if (l.constructor === L.CircleMarker) n++; }); return { n, sum: document.getElementById('crewMapSummary').innerText }; });
  ok('more than 300 located punches: 300 are drawn and the summary says so', c.n === 301 && /Showing the latest 300/.test(c.sum), JSON.stringify(c));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── French ────────────────────────────────────────');
{
  const p = await demoPage(1440, 900, 'fr');
  await seed(p);
  await p.evaluate(() => navigate('activity')); await sleep(1500);
  ok('the button reads Carte', await p.evaluate(() => /Carte/.test(document.getElementById('actMapBtn').innerText)));
  await p.click('#actMapBtn'); await sleep(900);
  const f = await p.evaluate(() => ({ title: document.querySelector('#crewMapModal h3').innerText, sum: document.getElementById('crewMapSummary').innerText, lg: document.getElementById('crewMapLegend').innerText }));
  ok('title, summary and legend are French', /O. les pointages/.test(f.title) && /pointages avec position/.test(f.sum) && /Plein = ENTR/.test(f.lg) && /Anneau = SORTIE/.test(f.lg), JSON.stringify(f));
  await p.evaluate(() => { destroyCrewMap(); closeModal('crewMapModal'); });
  const oid = await p.evaluate(() => C.punches.find(x => x.geo_status === 'outside').id);
  await p.evaluate(id => openPunchLocationMap(id), oid); await sleep(600);
  const g = await p.evaluate(() => ({ sum: document.getElementById('punchMapSummary').innerText, tips: [...document.querySelectorAll('#punchMapContainer .leaflet-tooltip')].map(e => e.innerText) }));
  ok('the one-punch map is French too (accuracy, SORTIE label)', /Précision GPS : ±35 m/.test(g.sum) && g.tips.some(t => /^SORTIE \d\d:\d\d · /.test(t)), JSON.stringify(g));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── On a phone ────────────────────────────────────');
{
  const p = await demoPage(390, 844, 'en');
  await seed(p);
  const oid = await p.evaluate(() => C.punches.find(x => x.geo_status === 'outside').id);
  await p.evaluate(id => openPunchLocationMap(id), oid); await sleep(700);
  const r = await p.evaluate(() => { const m = document.querySelector('#punchMapModal .modal').getBoundingClientRect(), c = document.getElementById('punchMapContainer').getBoundingClientRect(); return { w: Math.round(m.width), h: Math.round(m.height), ih: innerHeight, ch: Math.round(c.height), sideways: document.documentElement.scrollWidth > innerWidth + 1, closeVisible: (() => { const b = [...document.querySelectorAll('#punchMapModal button')].find(x => /Close/.test(x.innerText)).getBoundingClientRect(); return b.bottom <= innerHeight + 1 && b.top >= 0; })() }; });
  ok('the one-punch map fills the phone screen, with the map tall and the Close button on screen', r.w === 390 && r.h >= r.ih - 2 && r.ch >= 300 && r.closeVisible && !r.sideways, JSON.stringify(r));
  await p.evaluate(() => { destroyPunchMap(); closeModal('punchMapModal'); });
  await p.evaluate(() => navigate('activity')); await sleep(1500);
  await p.evaluate(() => document.getElementById('actMapBtn').click()); await sleep(900);
  const q = await p.evaluate(() => { const m = document.querySelector('#crewMapModal .modal').getBoundingClientRect(); return { w: Math.round(m.width), h: Math.round(m.height), ih: innerHeight, open: document.getElementById('crewMapModal').classList.contains('open') }; });
  ok('the crew map also fills the phone', q.open && q.w === 390 && q.h >= q.ih - 2, JSON.stringify(q));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

console.log('\n── Geofence editor and site card ─────────────────');
{
  const p = await demoPage(1440, 900, 'en');
  const sd = await seed(p);
  await p.evaluate(() => navigate('sites')); await sleep(1500);
  const card = await p.evaluate(() => [...document.querySelectorAll('.geo-status-badge')].map(b => b.innerText.trim()));
  ok('a site card shows its radius and mode (75 m · Strict)', card.some(t => /75 m · Strict/.test(t)), JSON.stringify(card));
  await p.evaluate(id => editSite(id), sd.site); await sleep(900);
  const h = await p.evaluate(() => ({ hint: document.getElementById('geoRadiusHint').innerText, hv: document.getElementById('geoRadiusHint').offsetParent !== null, warn: document.getElementById('geoRadiusWarn').offsetParent !== null }));
  ok('the editor shows the radius hint (50 to 100 m, phones 10 to 30 m off indoors)', h.hv && /50 to 100 m/.test(h.hint) && /10 to 30 m/.test(h.hint), JSON.stringify(h));
  ok('at 75 m in Strict mode there is no warning', !h.warn);
  await p.evaluate(() => { const s = document.getElementById('geoRadiusSlider'); s.value = 25; onGeoRadiusChange('25'); });
  ok('at 25 m in Strict mode a warning appears', await p.evaluate(() => document.getElementById('geoRadiusWarn').offsetParent !== null));
  await p.evaluate(() => selectGeoMode('lenient'));
  ok('and goes away in Lenient mode', await p.evaluate(() => document.getElementById('geoRadiusWarn').offsetParent === null));
  ok('no page errors', p._errs.length === 0, p._errs.join(' / '));
  await p.context().close();
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
