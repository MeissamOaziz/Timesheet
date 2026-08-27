import { chromium } from 'playwright';
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE,'..','assets','screenshots');
const lang = process.argv[2] || 'en';
const files = readdirSync(DIR).filter(f=>f.endsWith(`-${lang}.webp`)).sort();
// Relative srcs + an HTML file written into the image folder: a page loaded over file://
// can read sibling files, whereas setContent() runs on about:blank and cannot.
const cells = files.map(f=>`<figure><img src="${f}"><figcaption>${f}</figcaption></figure>`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#111;font-family:system-ui;padding:14px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden}
img{width:100%;display:block}
figcaption{font:12px/1.4 ui-monospace,monospace;color:#fff;background:#222;padding:6px 8px}
</style><div class="grid">${cells}</div>`;
const sheetHtml = join(DIR, `_sheet-${lang}.html`);
writeFileSync(sheetHtml, html);
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1500,height:1000}, deviceScaleFactor:1 });
await p.goto(pathToFileURL(sheetHtml).href, { waitUntil:'load' });
await p.waitForTimeout(1200);
await p.screenshot({ path: join(HERE, `sheet-${lang}.png`), fullPage:true });
await b.close();
unlinkSync(sheetHtml);
console.log('sheet-'+lang+'.png', files.length+' images');
