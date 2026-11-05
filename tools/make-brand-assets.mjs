// Generates the web brand assets from one description of the PunchClock Crew mark (the "crew ring": twelve dots round a
// clock, the 12 o'clock dot amber, one hand pointing at it). Run from the repo root:  node tools/make-brand-assets.mjs
// Writes: favicon.svg, favicon-32.png, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, og-image.png,
// PunchClockCrew-Logo.png (for light backgrounds), PunchClockCrew-Logo-dark.png (for dark backgrounds) and a legacy
// copy PunchClockPro-Logo.png (old emails and bookmarks still point at that URL, so it keeps working with the new look).
// The mobile app has the same mark in its own repo (scripts/make-icons.mjs); keep the two in step.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, copyFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sharp = require('./node_modules/sharp');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (f) => join(ROOT, f);

const NAVY = '#1B2A5C';
const AMBER = '#FFB020';
const AMBER_ON_LIGHT = '#E08A00';
const WHITE = '#FFFFFF';
const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// The mark on a 120-unit grid, scaled by s about (cx, cy). "bold" thickens it for 16 to 48 px sizes.
function mark({ cx, cy, s, bold = false }) {
  const R = (bold ? 35 : 34) * s;
  const dot = (bold ? 7.2 : 5.5) * s;
  const top = (bold ? 10 : 8) * s;
  let o = '';
  for (let k = 0; k < 12; k++) {
    const a = (k * 30 * Math.PI) / 180;
    const x = cx + R * Math.sin(a);
    const y = cy - R * Math.cos(a);
    o += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${(k === 0 ? top : dot).toFixed(2)}" fill="${k === 0 ? AMBER : WHITE}"/>`;
  }
  o += `<path d="M${cx} ${cy}V${(cy - (bold ? 18 : 17) * s).toFixed(2)}" fill="none" stroke="${WHITE}" stroke-width="${((bold ? 7 : 5) * s).toFixed(2)}" stroke-linecap="round"/>`;
  return o;
}
const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const tile = (size, r) => `<rect width="${size}" height="${size}" rx="${r}" fill="${NAVY}"/>`;
const png = (svg, file, w, h) => sharp(Buffer.from(svg)).resize(w, h).png().toFile(out(file)).then(() => console.log('wrote', file, `${w}x${h}`));

// Favicon: rounded tile, bold mark. SVG scales; PNG 32 and an ICO that carries PNGs of 32 and 48.
const favSvg = svgDoc(120, 120, tile(120, 28) + mark({ cx: 60, cy: 60, s: 1, bold: true }));
writeFileSync(out('favicon.svg'), favSvg);
console.log('wrote favicon.svg');
await png(favSvg, 'favicon-32.png', 32, 32);
const ico = async () => {
  const sizes = [32, 48];
  const bufs = await Promise.all(sizes.map((n) => sharp(Buffer.from(favSvg)).resize(n, n).png().toBuffer()));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = bufs.map((b, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(sizes[i], 0); e.writeUInt8(sizes[i], 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(b.length, 8); e.writeUInt32LE(offset, 12);
    offset += b.length;
    return e;
  });
  writeFileSync(out('favicon.ico'), Buffer.concat([head, ...entries, ...bufs]));
  console.log('wrote favicon.ico 32+48');
};
await ico();

// Home-screen icons: full-bleed navy (the system rounds or masks it), mark well inside the maskable safe zone.
const fullBleed = (n) => svgDoc(n, n, `<rect width="${n}" height="${n}" fill="${NAVY}"/>` + mark({ cx: n / 2, cy: n / 2, s: n / 120 }));
await png(fullBleed(512), 'icon-512.png', 512, 512);
await png(fullBleed(512), 'icon-192.png', 192, 192);
await png(fullBleed(512), 'apple-touch-icon.png', 180, 180);

// Horizontal lockup: tile + wordmark. Light-background and dark-background versions.
function lockup(textMain, textCrew) {
  return svgDoc(1500, 320,
    `<g transform="translate(40,40)">${tile(240, 56)}${mark({ cx: 120, cy: 120, s: 2 })}</g>` +
    `<text x="320" y="214" font-family="${FONT}" font-size="132" font-weight="700" letter-spacing="-3" fill="${textMain}">PunchClock<tspan dx="30" font-weight="500" fill="${textCrew}">Crew</tspan></text>`);
}
await png(lockup(NAVY, AMBER_ON_LIGHT), 'PunchClockCrew-Logo.png', 1500, 320);
await png(lockup(WHITE, AMBER), 'PunchClockCrew-Logo-dark.png', 1500, 320);
copyFileSync(out('PunchClockCrew-Logo.png'), out('PunchClockPro-Logo.png'));
console.log('wrote PunchClockPro-Logo.png (legacy URL, new look)');

// Social preview (Open Graph / Twitter), 1200x630. Bilingual because the site is.
const og = svgDoc(1200, 630,
  `<rect width="1200" height="630" fill="${NAVY}"/>` +
  `<g transform="translate(90,150)"><rect width="330" height="330" rx="76" fill="#24367A"/>${mark({ cx: 165, cy: 165, s: 2.75 })}</g>` +
  `<text x="480" y="270" font-family="${FONT}" font-size="86" font-weight="700" letter-spacing="-2" fill="${WHITE}">PunchClock</text>` +
  `<text x="480" y="362" font-family="${FONT}" font-size="86" font-weight="500" letter-spacing="-2" fill="${AMBER}">Crew</text>` +
  `<text x="482" y="436" font-family="${FONT}" font-size="36" fill="#D5DCF5">Le pointage simple pour votre équipe</text>` +
  `<text x="482" y="486" font-family="${FONT}" font-size="30" fill="#9FACD9">Simple time tracking for your crew</text>` +
  `<text x="482" y="560" font-family="${FONT}" font-size="30" font-weight="600" fill="${AMBER}">punchclock.ca</text>`);
await png(og, 'og-image.png', 1200, 630);
