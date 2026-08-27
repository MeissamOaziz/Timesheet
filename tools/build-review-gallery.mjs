// Builds a self-contained review gallery (single HTML, images inlined) so the capture run can
// be approved without opening 36 files. Images are downscaled for review only — the published
// assets in ../assets/screenshots are untouched.
//   node build-review-gallery.mjs

import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR  = join(HERE, '..', 'assets', 'screenshots');
const OUT  = join(HERE, 'review-gallery.html');

// Titles mirror capture-screenshots.mjs. They live in markup, not pixels, so copy can change
// without re-capturing.
const HELP = [
  ['01-add-site',       'Create your first location',              'Créez votre premier emplacement'],
  ['02-site-form',      'Name it and save',                        'Nommez-le et enregistrez'],
  ['03-add-employee',   'Add your people',                         'Ajoutez votre équipe'],
  ['04-employee-form',  'Every employee needs a 4-digit PIN',      'Chaque employé a besoin d’un NIP à 4 chiffres'],
  ['05-find-pin',       'Forgot a PIN? Reveal it here',            'NIP oublié? Affichez-le ici'],
  ['06-kiosk-shortcut', 'Turn a tablet into your time clock',      'Transformez une tablette en horodateur'],
  ['07-kiosk-modal',    'Open this link on the tablet',            'Ouvrez ce lien sur la tablette'],
  ['08-punch-clock-in', 'How your staff clock in',                 'Comment votre personnel pointe'],
  ['09-pin-pad',        'Enter the 4-digit PIN',                   'Entrez le NIP à 4 chiffres'],
  ['10-reports',        'Payroll day — get your hours out',        'Jour de paie — sortez vos heures'],
  ['11-fix-a-punch',    'Someone forgot to clock out? Fix it here','Quelqu’un a oublié de pointer? Corrigez-le ici'],
];

const LANDING = [
  ['hero-dashboard',        'Dashboard — hero shot',        'Tableau de bord — image vedette'],
  ['product-punch',         'Clock in / out terminal',      'Terminal d’entrée/sortie'],
  ['product-punch-mobile',  'Terminal on a phone',          'Terminal sur téléphone'],
  ['product-reports',       'Payroll report',               'Rapport de paie'],
  ['product-schedule',      'Weekly schedule',              'Horaire hebdomadaire'],
  ['product-activity',      'Activity log',                 'Journal d’activité'],
  ['product-dashboard-dark','Dashboard in dark mode',       'Tableau de bord en mode sombre'],
];

async function inline(id, lang) {
  const buf = readFileSync(join(DIR, `${id}-${lang}.webp`));
  const small = await sharp(buf).resize({ width: 1300, withoutEnlargement: true })
                                .webp({ quality: 72 }).toBuffer();
  return `data:image/webp;base64,${small.toString('base64')}`;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function shots(list, numbered) {
  const out = [];
  for (const [i, [id, en, fr]] of list.entries()) {
    const [srcEn, srcFr] = await Promise.all([inline(id, 'en'), inline(id, 'fr')]);
    out.push(`<figure class="shot">
      <header class="shot-head">
        ${numbered ? `<span class="step">${String(i + 1).padStart(2, '0')}</span>` : ''}
        <h3 class="shot-title" data-en="${esc(en)}" data-fr="${esc(fr)}">${esc(en)}</h3>
        <code class="fname">${id}</code>
      </header>
      <div class="frame">
        <img class="lang-en" src="${srcEn}" alt="${esc(en)}" loading="lazy">
        <img class="lang-fr" src="${srcFr}" alt="${esc(fr)}" loading="lazy">
      </div>
    </figure>`);
  }
  return out.join('\n');
}

const helpHtml = await shots(HELP, true);
const landHtml = await shots(LANDING, false);

const html = `<title>PunchClock Screenshot Review</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Sans+3:wght@400;600&family=IBM+Plex+Mono:wght@400&display=swap">
<style>
  :root{
    --ground:#F4F6F9; --paper:#FFFFFF; --sunken:#EAEDF2;
    --line:#DDE2EA; --line-soft:#EBEEF3;
    --ink:#14161D; --ink-2:#3E4554; --muted:#6B7385;
    --accent:#FF5A36; --accent-ink:#FFFFFF;
    --shadow:0 1px 2px rgba(20,22,29,.05), 0 12px 32px rgba(20,22,29,.07);
    --r:12px;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ground:#101218; --paper:#181B22; --sunken:#1F232C;
      --line:#2B303B; --line-soft:#232833;
      --ink:#E9ECF3; --ink-2:#BCC3D2; --muted:#8B94A8;
      --accent:#FF6E4F; --accent-ink:#1A0D08;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 14px 36px rgba(0,0,0,.45);
    }
  }
  :root[data-theme="dark"]{
    --ground:#101218; --paper:#181B22; --sunken:#1F232C;
    --line:#2B303B; --line-soft:#232833;
    --ink:#E9ECF3; --ink-2:#BCC3D2; --muted:#8B94A8;
    --accent:#FF6E4F; --accent-ink:#1A0D08;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 14px 36px rgba(0,0,0,.45);
  }

  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font:16px/1.6 'Source Sans 3','Segoe UI',system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:1180px; margin:0 auto; padding:40px 24px 96px; display:flex; flex-direction:column; gap:40px}

  /* ── Masthead ─────────────────────────────────────────────── */
  .mast{display:flex; flex-direction:column; gap:14px; padding-bottom:28px; border-bottom:1px solid var(--line)}
  .kicker{
    font:600 11.5px/1 'Source Sans 3',sans-serif; letter-spacing:.14em; text-transform:uppercase;
    color:var(--accent);
  }
  h1{
    margin:0; font-family:'Archivo','Segoe UI',sans-serif; font-weight:700;
    font-size:clamp(28px,4vw,40px); line-height:1.1; letter-spacing:-.02em; text-wrap:balance;
  }
  .lede{margin:0; max-width:62ch; color:var(--ink-2); font-size:17px}

  .bar{display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:space-between}
  .facts{display:flex; flex-wrap:wrap; gap:8px 22px; color:var(--muted); font-size:14px}
  .facts b{color:var(--ink); font-variant-numeric:tabular-nums; font-weight:600}

  .toggle{display:inline-flex; background:var(--sunken); border:1px solid var(--line); border-radius:999px; padding:3px}
  .toggle button{
    appearance:none; border:0; background:none; cursor:pointer; color:var(--muted);
    font:600 13.5px/1 'Source Sans 3',sans-serif; letter-spacing:.06em;
    padding:8px 18px; border-radius:999px; transition:background .15s, color .15s;
  }
  .toggle button[aria-pressed="true"]{background:var(--accent); color:var(--accent-ink)}
  .toggle button:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

  /* ── Sections ─────────────────────────────────────────────── */
  section{display:flex; flex-direction:column; gap:22px}
  .sec-head{display:flex; flex-direction:column; gap:6px}
  h2{
    margin:0; font-family:'Archivo',sans-serif; font-weight:600; font-size:21px;
    letter-spacing:-.01em;
  }
  .sec-head p{margin:0; color:var(--muted); font-size:15px; max-width:66ch}

  .stack{display:flex; flex-direction:column; gap:26px}
  .grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(400px,1fr)); gap:26px}

  .shot{margin:0; display:flex; flex-direction:column; gap:10px}
  .shot-head{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap}
  .step{
    font-family:'IBM Plex Mono',monospace; font-size:13px; color:var(--accent-ink);
    background:var(--accent); border-radius:6px; padding:3px 7px; font-variant-numeric:tabular-nums;
  }
  .shot-title{margin:0; font-family:'Archivo',sans-serif; font-weight:600; font-size:16.5px; letter-spacing:-.005em}
  .fname{
    margin-left:auto; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted);
    background:var(--sunken); border:1px solid var(--line-soft); border-radius:5px; padding:2px 7px;
  }
  .frame{
    background:var(--paper); border:1px solid var(--line); border-radius:var(--r);
    box-shadow:var(--shadow); overflow:hidden; line-height:0;
  }
  .frame img{width:100%; height:auto; display:block}

  /* Language switching: one set visible at a time. */
  body[data-lang="en"] .lang-fr, body[data-lang="fr"] .lang-en{display:none}

  footer{
    border-top:1px solid var(--line); padding-top:22px; color:var(--muted); font-size:14px;
    display:flex; flex-direction:column; gap:10px;
  }
  footer code{
    font-family:'IBM Plex Mono',monospace; font-size:12.5px; color:var(--ink-2);
    background:var(--sunken); border:1px solid var(--line-soft); border-radius:5px; padding:2px 7px;
  }
  @media (prefers-reduced-motion:reduce){ *{transition:none !important} }
</style>

<div class="wrap">
  <header class="mast">
    <span class="kicker">Capture run · 27 Aug 2026</span>
    <h1>Screenshot review</h1>
    <p class="lede">Every shot below is generated by script from the live app running in demo mode,
      so nothing here contains real customer data. Callouts are drawn from the real element
      positions, which is why they keep pointing at the right control. Step titles live in the help
      article markup — not burned into the image — so wording can change without re-capturing.</p>
    <div class="bar">
      <div class="facts">
        <span><b>18</b> shots</span>
        <span><b>36</b> images (EN + FR)</span>
        <span><b>2.8 MB</b> total, WebP</span>
        <span>captured at <b>2×</b></span>
      </div>
      <div class="toggle" role="group" aria-label="Language">
        <button type="button" data-lang="en" aria-pressed="true">English</button>
        <button type="button" data-lang="fr" aria-pressed="false">Français</button>
      </div>
    </div>
  </header>

  <section>
    <div class="sec-head">
      <h2>First-run path</h2>
      <p>The eleven steps a new owner walks between signing up and a first real punch — the stretch
        where the data says most trials die. Numbered because it is genuinely a sequence.</p>
    </div>
    <div class="stack">
      ${helpHtml}
    </div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Product shots for the sales page</h2>
      <p>Clean frames, no callouts. These replace the hand-built HTML mock currently sitting in the
        landing page hero.</p>
    </div>
    <div class="grid">
      ${landHtml}
    </div>
  </section>

  <footer>
    <div>Regenerate the whole set after any UI change:</div>
    <div><code>cd tools &amp;&amp; node capture-screenshots.mjs</code></div>
    <div>Re-shoot just a few: <code>node capture-screenshots.mjs 08 kiosk</code></div>
  </footer>
</div>

<script>
  const body = document.body;
  body.dataset.lang = 'en';
  document.querySelectorAll('.toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      body.dataset.lang = lang;
      document.querySelectorAll('.toggle button').forEach(b =>
        b.setAttribute('aria-pressed', String(b === btn)));
      document.querySelectorAll('.shot-title').forEach(h => {
        h.textContent = h.dataset[lang];
      });
    });
  });
</script>
`;

writeFileSync(OUT, html);
console.log(`review-gallery.html — ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB`);
