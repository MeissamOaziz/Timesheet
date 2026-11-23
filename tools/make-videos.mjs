// Records the short how-to videos used on the Help centre, the Facebook page and YouTube.
//
//   cd tools && npm install            (once; playwright + sharp)
//   npx playwright install chromium    (once)
//   node make-videos.mjs               (all videos, EN + FR, wide + vertical)
//   node make-videos.mjs pin phone     (only ids containing "pin" or "phone")
//   node make-videos.mjs --lang fr --format wide
//
// Output: tools/_videos/<id>-<lang>-<wide|vertical>.mp4   (tools/_* is gitignored: these are not published
// with the site. Post them yourself.)
//
// Like capture-screenshots.mjs this drives the real index.html in DEMO MODE (a sample Québec café), with every
// outside request blocked, so no real customer data can appear and nothing is written anywhere. A visible
// cursor, a click ripple, numbered captions and a title and end card are added to the recording; headless
// Chromium records no cursor of its own. Needs ffmpeg on the PATH (winget install Gyan.FFmpeg).
//
// Adding a video: add an entry to VIDEOS. `steps(v)` uses the helpers on `v`:
//   v.nav(page)            open an app page the way a person would (sidebar, or the menu on a phone)
//   v.tap(selector)        glide the cursor there and click
//   v.type(selector, text) click a field and type
//   v.cap(n, text)         show a numbered caption (null number = plain)
//   v.wait(ms)
// and the title/end card text lives in `title` and `end`, each as { en, fr }.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, rmSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, '_videos');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = (en, fr) => ({ en, fr });

const FORMATS = {
  wide:     { viewport: { width: 1280, height: 720 }, size: { width: 1280, height: 720 } },
  // A phone-shaped page (so the app shows its phone layout) for Reels, Shorts and Stories. Playwright records at the
  // page's own size and only ever scales DOWN to `size`: asking for 1080x1920 from a 430-wide page left the picture in
  // the top-left corner of a grey frame (found 2026-11-22). So it records 432x768 (exactly 9:16) and ffmpeg scales the
  // result up to `out` when encoding.
  vertical: { viewport: { width: 432, height: 768 },  size: { width: 432, height: 768 }, out: { width: 1080, height: 1920 } },
};

// ── Videos ────────────────────────────────────────────────────────────────────
const VIDEOS = [
  {
    id: 'clock-in-with-a-pin',
    title: T('Clock in with a PIN', 'Pointer avec un NIP'),
    sub: T('30 seconds', '30 secondes'),
    end: T('Free for up to 10 employees', 'Gratuit jusqu’à 10 employés'),
    endSub: T('One flat price for the whole crew. No card needed.', 'Un prix fixe pour toute l’équipe. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Clock In/Out', 'Ouvrez Pointage'));  await v.wait(700);
      await v.nav('punch');
      await v.cap(2, T('Pick the site', 'Choisissez le site'));    await v.wait(500);
      await v.tap('#pickerSiteGrid .pick-card', 1000);
      const who = await v.page.evaluate(() => {
        const site = (Ctx.get() || {}).site; const emps = C.employees.filter(e => e.active && (!site || e.site_id === site.id));
        const last = id => (C.punches.find(x => x.emp_id === id) || {}).type;
        const e = emps.find(e => last(e.id) !== 'IN') || emps[0];
        return { id: e.id, pin: e.pin };
      });
      await v.cap(3, T('Choose your name', 'Choisissez votre nom')); await v.wait(500);
      await v.glide('#empSelect'); await v.page.selectOption('#empSelect', who.id); await v.wait(1000);
      await v.cap(4, T('Tap IN', 'Appuyez sur ENTRÉE'));            await v.wait(400);
      await v.tap('#page-punch .punch-btn', 800);
      await v.cap(5, T('Enter your 4-digit PIN', 'Entrez votre NIP à 4 chiffres')); await v.wait(400);
      for (const d of String(who.pin)) await v.tap(`#pinModal .pin-key:text-is("${d}")`, 280, 150);
      await v.wait(1500);
      await v.cap(6, T('Done. Your manager sees it right away', 'C’est fait. Votre gestionnaire le voit tout de suite')); await v.wait(1200);
      await v.nav('dashboard'); await v.wait(2200);
    },
  },
  {
    id: 'set-up-the-tablet',
    title: T('Set up the punch tablet', 'Configurer la tablette de pointage'),
    sub: T('Any tablet or spare phone works', 'Toute tablette ou vieux téléphone convient'),
    end: T('The tablet is included in every plan', 'La tablette est incluse dans tous les forfaits'),
    endSub: T('Free for up to 10 employees. No card needed.', 'Gratuit jusqu’à 10 employés. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Sites', 'Ouvrez Sites'));                 await v.wait(700);
      await v.nav('sites');
      await v.cap(2, T('Press Kiosk Shortcut on your site', 'Touchez Raccourci kiosque sur votre site')); await v.wait(600);
      await v.tap('#page-sites button[onclick^="openKioskShortcut"]', 1200);
      await v.cap(3, T('On the tablet, scan this code', 'Sur la tablette, scannez ce code'));  await v.wait(2800);
      await v.cap(4, T('Or type this address in its browser', 'Ou tapez cette adresse dans son navigateur')); await v.wait(900);
      await v.tap('#kioskCopyBtn', 1600);
      await v.cap(5, T('The tablet shows up here once it connects', 'La tablette apparaît ici dès qu’elle se connecte')); await v.wait(2800);
      await v.tap('#kioskShortcutModal .btn-primary[onclick="closeKioskWizard()"]', 1500);
    },
  },
  {
    id: 'set-up-phone-clock-in',
    title: T('Let your team clock in from their phone', 'Laissez votre équipe pointer avec son téléphone'),
    sub: T('Nothing to install', 'Rien à installer'),
    end: T('Included from the Starter plan', 'Inclus à partir du forfait Starter'),
    endSub: T('Try it free for 14 days. No card needed.', 'Essayez-le gratuitement pendant 14 jours. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Phone clock-in', 'Ouvrez Pointage par téléphone')); await v.wait(700);
      await v.nav('admin');
      await v.openMenuItem('#phoneSetupModal', 'openPhoneSetup()');
      await v.cap(2, T('Tick the people who may clock in from their phone', 'Cochez les personnes qui peuvent pointer avec leur téléphone')); await v.wait(900);
      await v.tap('#ph-cb-demo-e1', 500); await v.tap('#ph-cb-demo-e3', 500);
      await v.cap(3, T('Add an email where one is missing', 'Ajoutez un courriel s’il en manque un'));  await v.wait(500);
      await v.tap('#ph-cb-demo-e2', 400);
      await v.type('#ph-em-demo-e2', 'sofia.ricci@example.com');
      await v.cap(4, T('Choose where they can clock in', 'Choisissez où ils peuvent pointer')); await v.wait(600);
      await v.scrollModal('#phoneSetupModal .modal', 260);
      await v.wait(1700);
      await v.cap(5, T('Send their links', 'Envoyez-leur leur lien'));     await v.wait(500);
      await v.scrollModal('#phoneSetupModal .modal', 600);
      await v.tap('#phSendBtn', 900);
      await v.tap('#uiDlgOk', 1500);
      await v.cap(6, T('Each person gets an email and sets a password', 'Chaque personne reçoit un courriel et choisit un mot de passe')); await v.wait(2600);
    },
  },
  {
    id: 'add-an-employee',
    title: T('Add an employee and give them a PIN', 'Ajouter un employé et lui donner un NIP'),
    sub: T('Less than a minute', 'Moins d’une minute'),
    end: T('Free for up to 10 employees', 'Gratuit jusqu’à 10 employés'),
    endSub: T('One flat price for the whole crew. No card needed.', 'Un prix fixe pour toute l’équipe. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Employees', 'Ouvrez Employés'));            await v.wait(700);
      await v.nav('admin');
      await v.cap(2, T('Press Add Employee', 'Touchez Ajouter un employé')); await v.wait(500);
      await v.tap('#adminHeaderBtn', 1000);
      await v.cap(3, T('Type their name', 'Tapez son nom'));              await v.wait(400);
      await v.type('#empName', 'Camille Roy');
      await v.cap(4, T('Pick their site', 'Choisissez son site'));         await v.wait(400);
      await v.glide('#empSiteSelect');
      await v.page.evaluate(() => { const s = document.getElementById('empSiteSelect'); const o = [...s.options].find(o => o.value); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); });
      await v.wait(800);
      await v.cap(5, T('Press Random for a 4-digit PIN', 'Touchez Aléatoire pour un NIP à 4 chiffres')); await v.wait(400);
      await v.tap('#addEmpModal button[onclick="generatePin()"]', 1200);
      await v.cap(6, T('Save', 'Enregistrer'));                           await v.wait(400);
      await v.tap('#addEmpModal .modal-footer .btn-primary', 1500);
      await v.cap(7, T('Print PIN cards to hand out', 'Imprimez des cartes NIP à distribuer')); await v.wait(1200);
      await v.glide('#page-admin button[onclick*="printPinCards"]'); await v.wait(1800);
    },
  },
  {
    id: 'fix-a-missed-clock-out',
    title: T('Fix a forgotten clock-out', 'Corriger un oubli de pointage de départ'),
    sub: T('Every change is logged', 'Chaque modification est consignée'),
    end: T('Punch corrections are on the Starter plan', 'La correction des pointages est incluse dans Starter'),
    endSub: T('Try it free for 14 days. No card needed.', 'Essayez-le gratuitement pendant 14 jours. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Activity', 'Ouvrez Activité'));              await v.wait(700);
      await v.nav('activity');
      await v.wait(900);
      await v.cap(2, T('Press Add Punch', 'Touchez Ajouter un pointage')); await v.wait(500);
      await v.tap('#addPunchBtn', 1100);
      await v.cap(3, T('Choose the employee who forgot', 'Choisissez l’employé qui a oublié')); await v.wait(500);
      await v.page.evaluate(() => { const s = document.getElementById('addPunchEmp'); const e = C.employees.find(e => e.name.startsWith('David')); s.value = e.id; });
      await v.glide('#addPunchEmp'); await v.wait(700);
      await v.cap(4, T('Type: OUT, then the time they left', 'Type : DÉPART, puis l’heure de départ')); await v.wait(400);
      await v.page.selectOption('#addPunchType', 'OUT'); await v.wait(600);
      await v.type('#addPunchTime', '17:00:00');
      await v.cap(5, T('Add the punch', 'Ajoutez le pointage'));           await v.wait(400);
      await v.tap('#addPunchModal .modal-footer .btn-primary', 1800);
      await v.cap(6, T('The hours are right again', 'Les heures sont de nouveau justes')); await v.wait(2400);
    },
  },
  {
    id: 'export-payroll-hours',
    title: T('Get your payroll hours', 'Obtenir les heures de paie'),
    sub: T('Excel, CSV or PDF', 'Excel, CSV ou PDF'),
    end: T('No more adding hours by hand', 'Fini le calcul des heures à la main'),
    endSub: T('Free for up to 10 employees. No card needed.', 'Gratuit jusqu’à 10 employés. Sans carte.'),
    async steps(v) {
      await v.cap(1, T('Open Reports', 'Ouvrez Rapports'));              await v.wait(700);
      await v.nav('reports');
      await v.cap(2, T('Choose the pay period', 'Choisissez la période de paie')); await v.wait(500);
      await v.glide('#reportPeriod, #page-reports select'); await v.wait(900);
      await v.cap(3, T('Press Generate', 'Touchez Générer'));              await v.wait(400);
      await v.tap('#page-reports button[onclick*="generateReport"]', 1600);   // onclick is now withBusy(this,generateReport)
      await v.scrollPage(520);
      await v.cap(4, T('Total hours and overtime for each person', 'Heures totales et temps supplémentaire de chacun')); await v.wait(2800);
      await v.scrollPage(-2000);
      await v.cap(5, T('Download it: Excel, CSV or PDF', 'Téléchargez-le : Excel, CSV ou PDF')); await v.wait(500);
      await v.glide('#page-reports button[onclick*="Excel"], #page-reports button:text-is("Excel")'); await v.wait(1800);
    },
  },
];

// ── Plumbing ──────────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json', '.ico':'image/x-icon', '.webp':'image/webp' };
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const OVERLAY_CSS = `
  #pcToast{display:none!important}
  #vCur{position:fixed;left:0;top:0;width:var(--vc,26px);height:var(--vc,26px);z-index:2147483647;pointer-events:none;transform:translate(60vw,60vh)}
  #vCur svg{width:100%;height:100%;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  #vRip{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(79,142,247,.35);z-index:2147483646;pointer-events:none;opacity:0}
  #vRip.go{animation:vrip .45s ease-out}
  @keyframes vrip{0%{opacity:.9;scale:.3}100%{opacity:0;scale:1.5}}
  #vCap{position:fixed;left:50%;top:var(--vct,18px);transform:translateX(-50%);z-index:2147483645;pointer-events:none;background:rgba(20,24,44,.94);color:#fff;font:600 var(--vcf,24px)/1.3 "DM Sans",system-ui,sans-serif;padding:var(--vcp,14px 26px);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:88vw;text-align:center;opacity:0;transition:opacity .25s}
  #vCap.on{opacity:1}
  #vCap b{display:inline-grid;place-items:center;width:1.25em;height:1.25em;border-radius:50%;background:#4f8ef7;font-size:.72em;margin-right:.55em;vertical-align:.12em}
  #vCard{position:fixed;inset:0;z-index:2147483644;background:#141a33;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--vgap,18px);font-family:"DM Sans",system-ui,sans-serif;opacity:1;transition:opacity .5s;pointer-events:none;padding:0 8vw;text-align:center}
  #vCard.off{opacity:0}
  #vCard .k{font-size:var(--vk,20px);letter-spacing:.12em;text-transform:uppercase;color:#9db8ff;font-weight:600}
  #vCard .t{font-size:var(--vt,58px);font-weight:700;letter-spacing:-.02em;max-width:1000px;line-height:1.1}
  #vCard .s{font-size:var(--vs,24px);color:#c9d2ee}
  #vCard svg{width:var(--vlogo,84px);height:var(--vlogo,84px)}
  body.v-hide-cursor #vCur{display:none}`;

async function record(browser, base, video, lang, fmtName) {
  const fmt = FORMATS[fmtName];
  const tag = `${video.id}-${lang}-${fmtName}`;
  const raw = join(OUT, '_raw-' + tag);
  rmSync(raw, { recursive: true, force: true }); mkdirSync(raw, { recursive: true });
  const ctx = await browser.newContext({ viewport: fmt.viewport, recordVideo: { dir: raw, size: fmt.size }, hasTouch: false });
  await ctx.route(u => !u.href.startsWith(base) && !/fonts\.(googleapis|gstatic)\.com/.test(u.href) && !u.href.startsWith('data:'), r => r.abort());
  const t0 = Date.now();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  await page.evaluate(l => { try { localStorage.setItem('pc_tour_v1', '1'); localStorage.setItem('pc_theme', 'light'); localStorage.removeItem('pc_nav'); sessionStorage.setItem('pc_demo_coach', 'off'); } catch (e) {} try { setLang(l); } catch (e) {} }, lang);
  await page.evaluate(() => startDemo());
  // Work labels are an add-on: a plain clock-in video keeps them out of the way.
  await page.evaluate(() => { C.companies.forEach(c => { c.punch_label_mode = 'off'; }); const x = Ctx.get(); if (x && x.co) { x.co.punch_label_mode = 'off'; Ctx.set(x); } });
  await sleep(700);
  await page.evaluate(css => {
    const b = document.getElementById('demoBanner'); if (b) b.remove();
    if (typeof _syncDemoBannerH === 'function') _syncDemoBannerH();
    const dc = document.getElementById('demoCoach'); if (dc) dc.remove();
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const cur = document.createElement('div'); cur.id = 'vCur';
    cur.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.5 3.9 7-2.7 1.5-3.9-7L5 19z" fill="#111827" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const rip = document.createElement('div'); rip.id = 'vRip';
    const cap = document.createElement('div'); cap.id = 'vCap';
    const card = document.createElement('div'); card.id = 'vCard';
    document.body.append(rip, cur, cap, card);
    document.addEventListener('mousemove', e => { cur.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
    document.addEventListener('mousedown', e => { rip.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); }, true);
    window.vCap = (n, txt) => { cap.innerHTML = (n ? '<b>' + n + '</b>' : '') + txt; cap.classList.add('on'); };
    window.vCapOff = () => cap.classList.remove('on');
    window.vCard = (k, t, s, hideCursor) => { card.innerHTML = '<svg aria-hidden="true"><use href="#i-crew-mark"/></svg><div class="k">' + k + '</div><div class="t">' + t + '</div>' + (s ? '<div class="s">' + s + '</div>' : ''); card.classList.remove('off'); document.body.classList.toggle('v-hide-cursor', !!hideCursor); };
    window.vCardOff = () => { card.classList.add('off'); document.body.classList.remove('v-hide-cursor'); };
  }, OVERLAY_CSS);
  if (fmtName === 'vertical') await page.evaluate(() => { const r = document.documentElement.style; r.setProperty('--vc', '22px'); r.setProperty('--vcf', '19px'); r.setProperty('--vcp', '12px 18px'); r.setProperty('--vct', '14px'); r.setProperty('--vk', '15px'); r.setProperty('--vt', '36px'); r.setProperty('--vs', '18px'); r.setProperty('--vlogo', '70px'); });

  let mx = fmt.viewport.width * 0.6, my = fmt.viewport.height * 0.6;
  await page.mouse.move(mx, my);
  const v = {
    page,
    wait: ms => sleep(ms),
    cap: (n, o) => page.evaluate(([n, txt]) => vCap(n, txt), [n, o[lang]]),
    async glide(sel) {
      const loc = page.locator(sel).first();
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const b = await loc.boundingBox({ timeout: 5000 }).catch(() => null);
      if (!b) throw new Error('not found: ' + sel);
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await page.mouse.move(x, y, { steps: Math.max(14, Math.round(Math.hypot(x - mx, y - my) / 14)) });
      mx = x; my = y; await sleep(260);
    },
    async tap(sel, after = 700, pause) {
      await v.glide(sel);
      await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(after);
    },
    async type(sel, text) {
      await v.tap(sel, 300);
      await page.keyboard.type(text, { delay: 85 }); await sleep(500);
    },
    // The sidebar on a wide screen; the menu button on a phone.
    async nav(name) {
      if (fmt.viewport.width <= 900) {
        await v.tap('#hamburgerBtn', 600);
        await v.tap(`#mobileMenu [onclick="mobileNav('${name}')"]`, 900);
      } else {
        await v.tap(`#sideNav [data-nav="${name}"]`, 900);
      }
    },
    async openMenuItem(modalSel, call) {
      if (fmt.viewport.width <= 900) {
        await v.tap('#hamburgerBtn', 600);
        await v.tap('#mobileNavPhone', 1100);
      } else {
        await v.tap(`#sideNav [onclick="${call}"]`, 1100);
      }
      await page.waitForSelector(modalSel + '.open', { timeout: 4000 });
    },
    async scrollModal(sel, y) {
      await page.evaluate(([s, y]) => { document.querySelector(s).scrollTo({ top: y, behavior: 'smooth' }); }, [sel, y]); await sleep(900);
    },
    async scrollPage(y) {
      await page.evaluate(y => { window.scrollBy({ top: y, behavior: 'smooth' }); }, y); await sleep(1000);
    },
  };

  await page.evaluate(([k, t, s]) => vCard(k, t, s, true), ['PunchClock Crew', video.title[lang], video.sub[lang]]);
  await sleep(400);
  const cutStart = (Date.now() - t0) / 1000;
  await sleep(2400);
  await page.evaluate(() => vCardOff());
  await sleep(800);
  try { await video.steps(v); }
  catch (e) { console.warn(`  ! ${tag}: ${e.message.split('\n')[0]}`); throw e; }
  await page.evaluate(() => vCapOff());
  await page.evaluate(([k, t, s]) => vCard(k, t, s, true), ['punchclock.ca', video.end[lang], video.endSub[lang]]);
  await sleep(3200);
  const cutEnd = (Date.now() - t0) / 1000;
  await ctx.close();
  const f = readdirSync(raw).find(x => x.endsWith('.webm'));
  renameSync(join(raw, f), join(raw, 'raw.webm'));

  const out = join(OUT, tag + '.mp4');
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(cutStart), '-i', join(raw, 'raw.webm'), '-t', String(cutEnd - cutStart),
    '-vf', `fps=30,${fmt.out ? `scale=${fmt.out.width}:${fmt.out.height}:flags=lanczos,` : ''}format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-movflags', '+faststart', '-an', out], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error('ffmpeg failed: ' + (r.error ? r.error.message : r.stderr));
  rmSync(raw, { recursive: true, force: true });
  return { out, seconds: Math.round(cutEnd - cutStart), errors };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  const langs = opt('lang') ? [opt('lang')] : ['en', 'fr'];
  const fmts = opt('format') && opt('format') !== 'both' ? [opt('format')] : Object.keys(FORMATS);
  const only = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (spawnSync('ffmpeg', ['-version']).error) { console.error('ffmpeg is not on the PATH. Install it (winget install Gyan.FFmpeg) and open a new terminal.'); process.exit(1); }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  let n = 0, bad = 0;
  for (const video of VIDEOS) {
    if (only.length && !only.some(o => video.id.includes(o))) continue;
    for (const lang of langs) for (const fmt of fmts) {
      try {
        const r = await record(browser, base, video, lang, fmt);
        n++; console.log(`  ${video.id}-${lang}-${fmt}.mp4  ${r.seconds}s${r.errors.length ? '  PAGE ERRORS: ' + r.errors.join(' / ') : ''}`);
      } catch (e) { bad++; console.log(`  FAILED ${video.id}-${lang}-${fmt}: ${e.message.split('\n')[0]}`); }
    }
  }
  await browser.close(); server.close();
  console.log(`\n${n} video(s) written to ${OUT}${bad ? `, ${bad} failed` : ''}`);
  process.exit(bad ? 1 : 0);
}
main();
