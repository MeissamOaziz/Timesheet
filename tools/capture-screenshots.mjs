// Regenerates every product screenshot used by the help centre and the landing page.
//
//   cd tools && npm install          (once)
//   node capture-screenshots.mjs     (writes ../assets/screenshots)
//
// Shots are declarative so the whole set can be regenerated after a UI change instead of
// being re-taken by hand. Everything runs against demo mode, which seeds a realistic
// Québec café — so the images show a busy shop rather than empty tables, and no real
// customer data can ever leak into a marketing asset.

import { chromium } from 'playwright';
import sharp from 'sharp';
import { ANNOTATE_SRC } from './annotate.mjs';
import { mkdirSync, existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT  = join(ROOT, 'assets', 'screenshots');
const LANGS = ['en', 'fr'];

// The tool serves the site itself rather than depending on a separate terminal running
// http-server — one command, no port juggling, no half-finished runs when that process dies.
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png',
               '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon' };

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                           'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const T = (en, fr) => ({ en, fr });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Shot list ────────────────────────────────────────────────────────────────
// kind: 'help'    → annotated, viewport-sized, for the help centre
//       'landing' → clean, no callouts, for the sales page
const SHOTS = [
  // ---------- Help: the first-run path, in the order a new owner walks it ----------
  {
    id: '01-add-site', kind: 'help', page: 'sites',
    title: T('Step 1 — Create your first location', 'Étape 1 — Créez votre premier emplacement'),
    annotate: [
      { fn:'ring',  sel:'#page-sites button' },
      { fn:'arrow', sel:'#page-sites button', side:'auto',
        text: T('Click + Add Site to create\nyour first location', 'Cliquez sur + Ajouter un site pour\ncréer votre premier emplacement') },
    ],
  },
  {
    id: '02-site-form', kind: 'help', page: 'sites',
    before: async p => { await p.evaluate(() => openAddSiteModal()); await sleep(500); },
    title: T('Step 1 — Name it and save', 'Étape 1 — Nommez-le et enregistrez'),
    annotate: [
      { fn:'badge', sel:'#siteName', n:'1', corner:'left' },
      { fn:'ring',  sel:'#siteName' },
      { fn:'arrow', sel:'#siteName', side:'auto',
        text: T('Give it a name your team\nwill recognise', 'Donnez-lui un nom que votre\néquipe reconnaîtra') },
      { fn:'badge', sel:'#addSiteModal .modal-footer button:last-child', n:'2', corner:'tr' },
      { fn:'ring',  sel:'#addSiteModal .modal-footer button:last-child' },
    ],
  },
  {
    id: '03-add-employee', kind: 'help', page: 'admin',
    title: T('Step 2 — Add your people', 'Étape 2 — Ajoutez votre équipe'),
    annotate: [
      { fn:'ring',  sel:'#adminHeaderBtn' },
      { fn:'arrow', sel:'#adminHeaderBtn', side:'auto',
        text: T('Add each employee here', 'Ajoutez chaque employé ici') },
    ],
  },
  {
    id: '04-employee-form', kind: 'help', page: 'admin',
    before: async p => { await p.evaluate(() => openAddEmpModal()); await sleep(500); },
    title: T('Step 2 — Every employee needs a 4-digit PIN', 'Étape 2 — Chaque employé a besoin d\'un NIP à 4 chiffres'),
    annotate: [
      { fn:'badge', sel:'#empName', n:'1', corner:'left' },
      { fn:'ring',  sel:'#empName' },
      { fn:'badge', sel:'#empPin', n:'2', corner:'left' },
      { fn:'ring',  sel:'#empPin' },
      { fn:'arrow', sel:'#empPin', side:'auto',
        text: T('This is what they type\nto clock in — write it down', 'C\'est ce qu\'ils taperont pour\npointer — notez-le') },
    ],
  },
  {
    id: '05-find-pin', kind: 'help', page: 'admin',
    title: T('Forgot a PIN? Reveal it here', 'NIP oublié? Affichez-le ici'),
    annotate: [
      { fn:'ring',  sel:'[id^=pincell-] button' },
      { fn:'arrow', sel:'[id^=pincell-] button', side:'auto',
        text: T('Click Show to reveal an\nemployee\'s PIN', 'Cliquez sur Afficher pour voir\nle NIP d\'un employé') },
    ],
  },
  {
    id: '06-kiosk-shortcut', kind: 'help', page: 'sites',
    title: T('Step 3 — Turn a tablet into your time clock', 'Étape 3 — Transformez une tablette en horodateur'),
    annotate: [
      { fn:'ring',  sel:'#page-sites button[onclick^="openKioskShortcut"]' },
      { fn:'arrow', sel:'#page-sites button[onclick^="openKioskShortcut"]', side:'auto',
        text: T('Open Kiosk Shortcut to set up\nthe tablet your staff will use', 'Ouvrez Raccourci kiosque pour\nconfigurer la tablette du personnel') },
    ],
  },
  {
    id: '07-kiosk-modal', kind: 'help', page: 'sites',
    before: async p => {
      await p.evaluate(() => { const s = C.sites[0]; openKioskShortcut(s.id); });
      await sleep(650);
    },
    title: T('Step 3 — Open this link on the tablet', 'Étape 3 — Ouvrez ce lien sur la tablette'),
    annotate: [
      { fn:'ring',  sel:'#kioskUrlDisplay' },
      { fn:'arrow', sel:'#kioskUrlDisplay', side:'bottom',
        text: T('Copy this link, or scan the QR\ncode with the tablet', 'Copiez ce lien, ou scannez le\ncode QR avec la tablette') },
    ],
  },
  {
    id: '08-punch-clock-in', kind: 'help', page: 'punch',
    context: ['.punch-card'],   // keep the clock + company header so the screen is recognisable
    title: T('Step 4 — How your staff clock in', 'Étape 4 — Comment votre personnel pointe'),
    annotate: [
      { fn:'badge', sel:'#empSelect', n:'1', corner:'left' },
      { fn:'ring',  sel:'#empSelect' },
      { fn:'badge', sel:'.punch-btn.btn-in', n:'2', corner:'left' },
      { fn:'ring',  sel:'.punch-btn.btn-in' },
    ],
  },
  {
    id: '09-pin-pad', kind: 'help', page: 'punch',
    before: async p => {
      await p.evaluate(() => {
        // Must pick someone who is currently clocked OUT, otherwise requestPunch() shows the
        // "already clocked in" warning instead of the PIN pad we're trying to photograph.
        const sel = document.getElementById('empSelect');
        const ids = Array.from(sel.options).map(o => o.value).filter(Boolean);
        const free = ids.find(id => getEmpStatus(id).status !== 'IN') || ids[0];
        sel.value = free;
        requestPunch('IN');
      });
      await sleep(550);
    },
    title: T('Step 4 — Enter the 4-digit PIN', 'Étape 4 — Entrez le NIP à 4 chiffres'),
    annotate: [
      { fn:'ring', sel:'.pin-pad', pad:10 },
      { fn:'arrow', sel:'.pin-pad', side:'auto',
        text: T('The PIN you set for this\nemployee — that\'s it, they\'re in', 'Le NIP défini pour cet employé —\nc\'est tout, le pointage est fait') },
    ],
  },
  {
    id: '10-reports', kind: 'help', page: 'reports',
    before: async p => { await p.evaluate(() => { try { generateReport(); } catch(e){} }); await sleep(900); },
    title: T('Payroll day — get your hours out', 'Jour de paie — sortez vos heures'),
    annotate: [
      { fn:'badge', sel:'#page-reports .filter-bar', n:'1', corner:'tl' },
      { fn:'arrow', sel:'#page-reports .filter-bar', side:'bottom',
        text: T('Pick the period, then Generate', 'Choisissez la période, puis Générer') },
      { fn:'badge', sel:'.export-btns', n:'2', corner:'tr' },
      { fn:'ring',  sel:'.export-btns' },
    ],
  },
  {
    id: '11-fix-a-punch', kind: 'help', page: 'activity',
    title: T('Someone forgot to clock out? Fix it here', 'Quelqu\'un a oublié de pointer? Corrigez-le ici'),
    annotate: [
      { fn:'ring',  sel:'#activityBody tr:first-child button' },
      { fn:'arrow', sel:'#activityBody tr:first-child button', side:'auto',
        text: T('Edit any punch — every change\nis logged', 'Modifiez tout pointage — chaque\nchangement est journalisé') },
    ],
  },

  {
    id: '12-geofence', kind: 'help', page: 'sites',
    before: async p => {
      await p.evaluate(() => editSite(C.sites[0].id));
      await sleep(600);
      // The geofence block is collapsed by default; expand it so the radius control shows.
      await p.evaluate(() => {
        const sec = document.getElementById('geoExpandedSection');
        if (sec && getComputedStyle(sec).display === 'none') toggleGeoSection();
      });
      await sleep(500);
    },
    title: T("Optional — only accept punches near the site", "Optionnel — n'accepter les pointages qu'à proximité du site"),
    annotate: [
      { fn:'ring',  sel:'#geoRadiusSlider' },
      { fn:'arrow', sel:'#geoRadiusSlider', side:'auto',
        text: T("Set how close someone must be\nbefore a punch is accepted", "Choisissez la distance maximale\npour qu'un pointage soit accepté") },
    ],
  },
  {
    id: '13-export-report', kind: 'help', page: 'reports',
    before: async p => { await p.evaluate(() => { try { generateReport(); } catch (e) {} }); await sleep(900); },
    title: T("Export it for payroll", "Exportez-le pour la paie"),
    annotate: [
      { fn:'ring',  sel:'.btn-export' },
      { fn:'arrow', sel:'.btn-export', side:'auto',
        text: T("Excel, CSV or PDF — the same\nhours you see on screen", "Excel, CSV ou PDF — les mêmes\nheures qu'à l'écran") },
    ],
  },
  {
    id: '14-reset-device', kind: 'help', page: 'punch', viewport: { width:1440, height:1250 },
    before: async p => {
      // This escape only appears on a device bound as a kiosk — which is exactly the person
      // who needs the picture.
      await p.evaluate(() => {
        const f = document.getElementById('kioskResetFooter');
        if (f) f.style.display = '';
        // The live "currently clocked in" panel pushes the footer off the frame. It is demo
        // detail, not part of what this picture is explaining.
        const ci = document.querySelector('.ci-panel, .ci-header') &&
                   (document.querySelector('.ci-panel') || document.querySelector('.ci-header').parentElement);
        if (ci) ci.style.display = 'none';
      });
      await sleep(350);
    },
    title: T("This device isn't meant to be a kiosk?", "Cet appareil ne devrait pas être un kiosque?"),
    // Without context the crop collapses onto the footer itself and produces an unrecognisable
    // strip — the reader needs to see it is the bottom of the punch card.
    context: ['.punch-card'],
    annotate: [
      { fn:'ring',  sel:'#kioskResetFooter' },
      { fn:'arrow', sel:'#kioskResetFooter', side:'auto',
        text: T("Sign in as admin, or reset the\ndevice back to a normal browser", "Connectez-vous comme admin, ou\nremettez l'appareil à la normale") },
    ],
  },
  {
    id: '15-time-off', kind: 'help', page: 'timeoff',
    before: async p => { await p.evaluate(() => openTimeOffModal()); await sleep(600); },
    title: T("Record vacation, sick days and unpaid leave", "Enregistrez vacances, congés maladie et congés sans solde"),
    annotate: [
      { fn:'ring',  sel:'#toKind' },
      { fn:'arrow', sel:'#toKind', side:'auto',
        text: T("Paid leave feeds the hours on\nyour payroll report", "Les congés payés alimentent les\nheures de votre rapport de paie") },
    ],
  },
  // ---------- Landing: clean product shots ----------
  { id:'hero-dashboard', kind:'landing', page:'dashboard' },
  { id:'product-punch',  kind:'landing', page:'punch' },
  {
    id:'product-reports', kind:'landing', page:'reports',
    before: async p => { await p.evaluate(() => { try { generateReport(); } catch(e){} }); await sleep(900); },
  },
  { id:'product-schedule', kind:'landing', page:'schedule' },
  { id:'product-activity', kind:'landing', page:'activity' },
  { id:'product-punch-mobile', kind:'landing', page:'punch', viewport:{ width:414, height:860 } },
  { id:'product-dashboard-dark', kind:'landing', page:'dashboard', theme:'dark' },
];

// ── Runner ───────────────────────────────────────────────────────────────────
async function newPage(browser, { width, height, theme, lang, url }) {
  const page = await browser.newPage({ viewport:{ width, height }, deviceScaleFactor:2 });
  page.on('pageerror', e => console.warn('   page error:', e.message));
  await page.goto(url, { waitUntil:'domcontentloaded' });
  await page.evaluate(t => {
    try { localStorage.setItem('pc_theme', t); } catch(e) {}
    try { localStorage.setItem('pc_nav', 'top'); } catch(e) {}
    try { localStorage.setItem('pc_tour_v1', '1'); } catch(e) {}   // don't let the tour cover shots
  }, theme);
  await page.reload({ waitUntil:'networkidle' });
  await page.evaluate(l => { try { setLang(l); } catch(e) {} }, lang);
  await page.evaluate(() => startDemo());
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    // The demo banner, its toast and the guided coach are all true in the app but noise in a
    // product shot — and the coach in particular would put "STEP 1 OF 4" over the marketing
    // hero, advertising the demo walkthrough rather than the product.
    const b = document.getElementById('demoBanner'); if (b) b.remove();
    const dc = document.getElementById('demoCoach'); if (dc) dc.remove();
    try { sessionStorage.setItem('pc_demo_coach', 'off'); } catch (e) {}
    const style = document.createElement('style');
    style.textContent = '#pcToast{display:none !important}';
    document.head.appendChild(style);
  });
  await page.addScriptTag({ content: ANNOTATE_SRC });
  return page;
}

async function run() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive:true });

  const server = await startServer();
  const URL = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  let n = 0;

  // `node capture-screenshots.mjs 09 kiosk` re-shoots only the ids matching those substrings.
  const only = process.argv.slice(2);
  const todo = only.length ? SHOTS.filter(s => only.some(o => s.id.includes(o))) : SHOTS;

  for (const shot of todo) {
    for (const lang of LANGS) {
      const vp = shot.viewport || { width:1440, height:900 };
      const page = await newPage(browser, { ...vp, theme: shot.theme || 'light', lang, url: URL });
      try {
        await page.evaluate(p => navigate(p), shot.page);
        await page.waitForTimeout(700);
        if (shot.before) await shot.before(page);

        if (shot.kind === 'help') {
          // The step title is deliberately NOT burned into the image — it lives in the help
          // article markup, where it stays editable and translatable without re-capturing,
          // and where it can't collide with the UI underneath.
          await page.evaluate(({ steps }) => {
            window.__ann.clear();
            for (const s of steps) {
              if (s.fn === 'ring')  window.__ann.ring(s.sel, s.pad);
              if (s.fn === 'badge') window.__ann.badge(s.sel, s.n, s.corner);
              if (s.fn === 'arrow') window.__ann.arrow(s.sel, { side:s.side, text:s.text, len:s.len });
            }
          }, {
            steps: (shot.annotate || []).map(a => ({ ...a, text: a.text ? a.text[lang] : undefined })),
          });
          await page.waitForTimeout(220);
        }

        // Crop help shots to the region that actually carries the instruction, keeping full
        // width so the set stays visually consistent. Landing shots stay full-frame.
        let clip;
        if (shot.kind === 'help') {
          // `context` widens the crop to include surrounding chrome the reader needs in order
          // to recognise which screen they're on — without it, a tightly-annotated control can
          // end up cropped down to an unrecognisable strip.
          const targets = [...(shot.annotate || []).map(a => a.sel), ...(shot.context || [])];
          const b = await page.evaluate(t => window.__ann.bounds(t), targets);
          if (b) {
            const padTop = 26, padBottom = 42, minH = 420;
            const y = Math.max(0, Math.floor(b.top - padTop));
            let h = Math.ceil(b.bottom - y + padBottom);
            h = Math.max(h, minH);
            const pageH = await page.evaluate(() => Math.max(document.body.scrollHeight, window.innerHeight));
            clip = { x:0, y, width:vp.width, height:Math.min(h, pageH - y) };
          }
        }

        // Captured at 2x for crisp text, then published as WebP — these are flat-colour UI
        // shots, so WebP holds up losslessly-looking at a fraction of the PNG weight, which
        // matters because several of them land on the landing page.
        const raw = await page.screenshot({ ...(clip ? { clip } : {}) });
        const file = join(OUT, `${shot.id}-${lang}.webp`);
        await sharp(raw).webp({ quality: 82 }).toFile(file);
        console.log(`  ✓ ${shot.id}-${lang}.webp`);
        n++;
      } catch (e) {
        console.error(`  ✗ ${shot.id}-${lang}: ${e.message}`);
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
  server.close();
  console.log(`\n${n} screenshots → assets/screenshots/`);
}

run();
