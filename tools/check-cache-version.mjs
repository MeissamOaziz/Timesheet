// The service worker serves the cached app shell when the network fails, and it only drops an
// old cache when CACHE_NAME changes. So a change to a precached file that ships without a new
// CACHE_NAME leaves installed tablets able to fall back to the previous version of the app.
// This used to be a thing to remember on every commit; this check makes forgetting it fail.
//
//   node check-cache-version.mjs [base-ref]     base-ref defaults to origin/main
//
// Compares the working tree against base-ref: if any precached file differs, the number in
// CACHE_NAME must be higher than it is at base-ref.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'origin/main';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

function cacheVersion(source, where) {
  const m = source.match(/const CACHE_NAME\s*=\s*'punchclock-v(\d+)'/);
  if (!m) { console.error(`FAIL  no CACHE_NAME = 'punchclock-vN' in sw.js (${where})`); process.exit(1); }
  return Number(m[1]);
}

// The files the worker precaches, read from sw.js itself so the two cannot drift apart.
function precachedFiles(source) {
  const list = source.match(/const PRECACHE\s*=\s*\[([^\]]*)\]/);
  if (!list) { console.error('FAIL  no PRECACHE list in sw.js'); process.exit(1); }
  const files = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\//, '')).filter(Boolean);
  return [...new Set(files)];
}

try { git('rev-parse', '--verify', '--quiet', `${base}^{commit}`); }
catch { console.error(`FAIL  base ref "${base}" not found (fetch it, or pass another ref)`); process.exit(1); }

const swNow = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const files = precachedFiles(swNow);
const changed = git('diff', '--name-only', base, '--', ...files).split('\n').filter(Boolean);

if (!changed.length) {
  console.log(`  PASS  no precached file (${files.join(', ')}) differs from ${base}`);
  process.exit(0);
}

const now = cacheVersion(swNow, 'working tree');
const before = cacheVersion(git('show', `${base}:sw.js`), base);
if (now > before) {
  console.log(`  PASS  ${changed.join(', ')} changed and CACHE_NAME went v${before} -> v${now}`);
  process.exit(0);
}
console.error(`  FAIL  ${changed.join(', ')} changed since ${base} but CACHE_NAME is still v${now}.`);
console.error(`        Fix: set CACHE_NAME to 'punchclock-v${before + 1}' in sw.js, in the same commit.`);
process.exit(1);
