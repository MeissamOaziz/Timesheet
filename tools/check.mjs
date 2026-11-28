// One command that runs every check in this folder, for people, agents and CI alike:
//
//   node check.mjs                    everything
//   node check.mjs kiosk portal       only tests whose file name contains "kiosk" or "portal"
//   node check.mjs --base <ref>       ref the cache-version check compares against (default origin/main)
//   node check.mjs --jobs 2           how many tests run at once (default: half the cores, 2 to 4)
//
// Exit code 0 means nothing got worse. A new test needs no registration: any file here named
// *-test.mjs is picked up.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_TIMEOUT_MS = 6 * 60 * 1000;

// Tests that were already failing when this runner was introduced (2026-11-26), with how many of
// their cases fail. They still run. The run fails if one of them fails MORE cases than listed
// (it got worse) or FEWER (it got better: lower the number, or delete the entry at zero), so the
// list can only shrink. Do not add to it to get a change through; fix the code or the test.
const KNOWN_FAILURES = {
  'addpunch-test.mjs': { failed: 4, why: 'a second IN while clocked in is confirmed instead of refused (EN and FR)' },
  'help-test.mjs': { failed: 2, why: 'expects 23 help articles; the help centre has 29 (EN and FR)' },
  'mobiletables-test.mjs': { failed: 2, why: 'time off list: no .mcards container inside #toListWrap on a phone' },
};

// Tests whose pages need a library from the public CDN the app itself uses. Where that host is
// blocked they cannot pass, and saying so beats a page of unrelated-looking failures.
const NEEDS_CDN = ['entitlement-test.mjs', 'map-test.mjs'];
const CDN_PROBE = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

const args = process.argv.slice(2);
const take = flag => { const i = args.indexOf(flag); return i < 0 ? null : args.splice(i, 2)[1]; };
const base = take('--base') || 'origin/main';
const jobs = Number(take('--jobs')) || Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));
const filters = args;

function run(file, extra = []) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [file, ...extra], { cwd: HERE });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += `\n[check.mjs] killed after ${TEST_TIMEOUT_MS / 60000} minutes\n`; child.kill('SIGKILL'); }, TEST_TIMEOUT_MS);
    child.on('close', code => { clearTimeout(timer); resolve({ file, code, out, secs: Math.round((Date.now() - started) / 1000) }); });
  });
}

// "42 passed, 4 failed" is the summary line the suites print; a crash prints none.
function failedCount(out) {
  const m = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  return m ? Number(m[2]) : null;
}

function verdict(r) {
  const known = KNOWN_FAILURES[r.file];
  const failed = failedCount(r.out);
  if (!known) return r.code === 0 ? { ok: true, label: 'PASS' } : { ok: false, label: 'FAIL' };
  if (r.code === 0) return { ok: false, label: 'FIXED', note: `now passes: delete its entry from KNOWN_FAILURES in check.mjs` };
  if (failed === known.failed) return { ok: true, label: 'KNOWN', note: `${failed} failing as before: ${known.why}` };
  if (failed !== null && failed < known.failed) return { ok: false, label: 'BETTER', note: `${failed} failing, list says ${known.failed}: lower the number in KNOWN_FAILURES` };
  return { ok: false, label: 'WORSE', note: `${failed === null ? 'crashed' : failed + ' failing'}, was ${known.failed}` };
}

const tests = readdirSync(HERE)
  .filter(f => /-test\.mjs$/.test(f) || f === 'qrtest.mjs')
  .filter(f => !filters.length || filters.some(s => f.includes(s)))
  .sort();

const results = [];
const problems = [];

if (!filters.length) {
  const r = await run('check-cache-version.mjs', [base]);
  process.stdout.write(r.out);
  if (r.code !== 0) problems.push({ ...r, label: 'FAIL' });
}

console.log(`\nRunning ${tests.length} test files, ${jobs} at a time\n`);
const queue = [...tests];
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let file; (file = queue.shift());) {
    const r = await run(file);
    const v = verdict(r);
    results.push({ ...r, ...v });
    if (!v.ok) problems.push({ ...r, ...v });
    console.log(`  ${v.label.padEnd(6)} ${file.padEnd(34)} ${String(r.secs).padStart(4)}s${v.note ? '  ' + v.note : ''}`);
  }
}));

for (const p of problems) {
  if (p.file === 'check-cache-version.mjs') continue;
  console.log(`\n──── ${p.label}: ${p.file} ────`);
  const lines = p.out.trimEnd().split('\n');
  const failing = lines.filter(l => /\bFAIL\b/.test(l));
  console.log((failing.length ? failing : lines.slice(-30)).join('\n'));
}

const count = label => results.filter(r => r.label === label).length;
console.log(`\n${count('PASS')} passed, ${count('KNOWN')} known failures unchanged, ${problems.length} problem${problems.length === 1 ? '' : 's'}`);

if (problems.some(p => NEEDS_CDN.includes(p.file))) {
  const reachable = await fetch(CDN_PROBE, { method: 'HEAD', signal: AbortSignal.timeout(10000) }).then(r => r.ok, () => false);
  if (!reachable) console.log(`\nNote: cdnjs.cloudflare.com is not reachable from here, and ${NEEDS_CDN.join(' and ')} load the map library from it.\nThose failures are this machine's network, not the code. Allow that host and run again.`);
}

process.exit(problems.length ? 1 : 0);
