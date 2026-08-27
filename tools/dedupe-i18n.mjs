// One-off maintenance pass: strip dead duplicate keys from the EN/FR translation objects.
//
// A repeated key in a JS object literal is silently legal — the last one wins and the earlier
// one becomes dead weight. That's a quiet trap for copy edits: fix the wrong copy of a string
// and nothing changes on screen, which is exactly how contradictory wording survives a review.
//
//   node dedupe-i18n.mjs          # report only
//   node dedupe-i18n.mjs --write  # apply

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const WRITE = process.argv.includes('--write');

const lines = readFileSync(FILE, 'utf8').split('\n');
const enStart = lines.findIndex(l => l.startsWith('en:{'));
const frStart = lines.findIndex(l => l.startsWith('fr:{'));
const frEnd   = lines.findIndex((l, i) => i > frStart && l.trim().startsWith('};'));

// Walk each 'key':'value' pair, stepping over backslash escapes so apostrophes inside the
// French copy ("l\'employé") don't end the value early.
function pairs(from, to) {
  const found = [];
  const KEY = /'([A-Za-z0-9_.]+)'\s*:\s*'/g;
  for (let i = from; i < to; i++) {
    const s = lines[i];
    KEY.lastIndex = 0;
    let m;
    while ((m = KEY.exec(s))) {
      let p = m.index + m[0].length;
      while (p < s.length) {
        if (s[p] === '\\') { p += 2; continue; }
        if (s[p] === "'") break;
        p++;
      }
      let end = p + 1;
      if (s[end] === ',') end++;
      found.push({ line: i, start: m.index, end, key: m[1] });
      KEY.lastIndex = end;
    }
  }
  return found;
}

let total = 0;
for (const [name, from, to] of [['EN', enStart, frStart], ['FR', frStart, frEnd]]) {
  const found = pairs(from, to);
  const lastIdx = new Map();
  found.forEach((p, i) => lastIdx.set(p.key, i));
  const dead = found.filter((p, i) => lastIdx.get(p.key) !== i);

  for (const d of dead) console.log(`  ${name} ${d.key}  (dead copy on line ${d.line + 1})`);
  // Splice right-to-left so earlier offsets stay valid.
  for (let i = found.length - 1; i >= 0; i--) {
    if (lastIdx.get(found[i].key) === i) continue;
    const { line, start, end } = found[i];
    lines[line] = lines[line].slice(0, start) + lines[line].slice(end);
  }
  console.log(`${name}: ${found.length} keys, removed ${dead.length} dead duplicates`);
  total += dead.length;
}

if (WRITE) {
  // Drop lines that held nothing but the removed pairs.
  const out = lines.filter((l, i) => !(i > enStart && i < frEnd && l.trim() === ''));
  writeFileSync(FILE, out.join('\n'));
  console.log(`\nwrote ${total} removals to index.html`);
} else {
  console.log(`\n(dry run — pass --write to apply)`);
}
