// Minimal QR encoder — byte mode, error-correction level M, versions 1..10.
//
// Written so the kiosk URL never leaves the browser. The previous implementation handed that
// URL to api.qrserver.com to render, but the URL *is* the kiosk credential (anyone holding it
// can punch at that site), so it has no business being sent to a third party. Versions up to 10
// hold ~213 bytes at level M — far more than the ~70-character kiosk URL needs.
//
// Returns a square array of 0/1 rows. Rendering is the caller's problem.
(function (root) {
  'use strict';

  // ── GF(256) arithmetic for Reed–Solomon, generator polynomial x^8+x^4+x^3+x^2+1 ──
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    for (var i = 0, x = 1; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ── Version tables (level M only) ──
  // [ total data codewords, EC codewords per block, group1 blocks, group2 blocks ]
  var VERSIONS = {
    1:  [16,  10, 1, 0],
    2:  [28,  16, 1, 0],
    3:  [44,  26, 1, 0],
    4:  [64,  18, 2, 0],
    5:  [86,  24, 2, 0],
    6:  [108, 16, 4, 0],
    7:  [124, 18, 4, 0],
    8:  [154, 22, 2, 2],
    9:  [182, 22, 3, 2],
    10: [216, 26, 4, 1]
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var cap = VERSIONS[v][0];
      var lenBits = v < 10 ? 8 : 16;              // byte-mode count length
      var needed = Math.ceil((4 + lenBits + byteLen * 8) / 8);
      if (needed <= cap) return v;
    }
    throw new Error('QR: payload too long (max ~200 bytes)');
  }

  // ── Bit stream → data codewords ──
  function buildCodewords(bytes, version) {
    var cap = VERSIONS[version][0];
    var lenBits = version < 10 ? 8 : 16;
    var bits = [];
    function push(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }

    push(0b0100, 4);                 // byte mode
    push(bytes.length, lenBits);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capBits = cap * 8;
    push(0, Math.min(4, capBits - bits.length));       // terminator
    while (bits.length % 8) bits.push(0);              // pad to byte boundary

    var words = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      words.push(v);
    }
    var padBytes = [0xEC, 0x11], p = 0;
    while (words.length < cap) words.push(padBytes[p++ % 2]);
    return words;
  }

  // ── Split into blocks, add EC, interleave ──
  function interleave(words, version) {
    var spec = VERSIONS[version];
    var ecLen = spec[1], g1 = spec[2], g2 = spec[3];
    var totalBlocks = g1 + g2;
    var shortLen = Math.floor(spec[0] / totalBlocks);

    var blocks = [], ecs = [], pos = 0;
    for (var i = 0; i < totalBlocks; i++) {
      var len = shortLen + (i >= g1 ? 1 : 0);
      var blk = words.slice(pos, pos + len); pos += len;
      blocks.push(blk);
      ecs.push(rsEncode(blk, ecLen));
    }
    var out = [], maxLen = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    for (var c = 0; c < maxLen; c++)
      for (var b2 = 0; b2 < blocks.length; b2++)
        if (c < blocks[b2].length) out.push(blocks[b2][c]);
    for (var e = 0; e < ecLen; e++)
      for (var b3 = 0; b3 < ecs.length; b3++) out.push(ecs[b3][e]);
    return out;
  }

  // ── Matrix construction ──
  function makeMatrix(version) {
    var size = version * 4 + 17;
    var m = [], reserved = [];
    for (var i = 0; i < size; i++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    function finder(r, c) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                 (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                 (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        m[rr][cc] = on ? 1 : 0; reserved[rr][cc] = true;
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var t = 8; t < size - 8; t++) {                 // timing patterns
      var bit = (t % 2 === 0) ? 1 : 0;
      m[6][t] = bit; reserved[6][t] = true;
      m[t][6] = bit; reserved[t][6] = true;
    }
    var centers = ALIGN[version];
    for (var a = 0; a < centers.length; a++) for (var b = 0; b < centers.length; b++) {
      var ar = centers[a], ac = centers[b];
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      for (var dr2 = -2; dr2 <= 2; dr2++) for (var dc2 = -2; dc2 <= 2; dc2++) {
        m[ar + dr2][ac + dc2] = (Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1) ? 1 : 0;
        reserved[ar + dr2][ac + dc2] = true;
      }
    }
    m[size - 8][8] = 1; reserved[size - 8][8] = true;    // dark module

    for (var f = 0; f <= 8; f++) {                        // format info areas
      if (!reserved[8][f]) reserved[8][f] = true;
      if (!reserved[f][8]) reserved[f][8] = true;
    }
    for (var f2 = 0; f2 < 8; f2++) {
      reserved[8][size - 1 - f2] = true;
      reserved[size - 1 - f2][8] = true;
    }
    if (version >= 7) {                                   // version info blocks
      for (var vr = 0; vr < 6; vr++) for (var vc = 0; vc < 3; vc++) {
        reserved[vr][size - 11 + vc] = true;
        reserved[size - 11 + vc][vr] = true;
      }
    }
    return { m: m, reserved: reserved, size: size };
  }

  function placeData(state, words) {
    var m = state.m, reserved = state.reserved, size = state.size;
    var bits = [];
    for (var i = 0; i < words.length; i++)
      for (var b = 7; b >= 0; b--) bits.push((words[i] >> b) & 1);

    var idx = 0, up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                               // skip vertical timing column
      for (var n = 0; n < size; n++) {
        var row = up ? size - 1 - n : n;
        for (var c2 = 0; c2 < 2; c2++) {
          var cc = col - c2;
          if (reserved[row][cc]) continue;
          m[row][cc] = idx < bits.length ? bits[idx++] : 0;
        }
      }
      up = !up;
    }
  }

  function maskFn(k) {
    return [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
    ][k];
  }

  // Level M format bits, pre-computed per mask (BCH 15,5 with the standard 0x5412 XOR).
  var FORMAT_M = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0];

  var VERSION_INFO = {
    7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3
  };

  // Format info is 15 bits, written twice. Bit 14 is the MSB. The layout is irregular because
  // row 6 / column 6 are the timing patterns and get stepped over.
  function applyFormat(state, mask) {
    var m = state.m, size = state.size, fmt = FORMAT_M[mask], i;
    // Copy 1 — around the top-left finder.
    for (i = 0; i <= 5; i++) m[8][i] = (fmt >> (14 - i)) & 1;   // (8,0..5) = bits 14..9
    m[8][7] = (fmt >> 8) & 1;                                    // step over timing column
    m[8][8] = (fmt >> 7) & 1;
    m[7][8] = (fmt >> 6) & 1;                                    // step over timing row
    for (i = 0; i <= 5; i++) m[i][8] = (fmt >> i) & 1;           // (0..5,8) = bits 0..5
    // Copy 2 — split between the bottom-left and top-right finders.
    for (i = 0; i <= 6; i++) m[size - 1 - i][8] = (fmt >> (14 - i)) & 1;  // bits 14..8
    for (i = 0; i <= 7; i++) m[8][size - 8 + i] = (fmt >> (7 - i)) & 1;   // bits 7..0
    m[size - 8][8] = 1;                                          // dark module, always set
  }

  function applyVersionInfo(state, version) {
    if (version < 7) return;
    var bits = VERSION_INFO[version], size = state.size;
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      state.m[r][size - 11 + c] = bit;
      state.m[size - 11 + c][r] = bit;
    }
  }

  function penalty(m, size) {
    var score = 0, i, j, run, dark = 0;
    for (i = 0; i < size; i++) {                          // rule 1: runs of 5+
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[j][i] === m[j - 1][i]) { run++; } else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {   // rule 2: 2x2 blocks
      var v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, start, pat) {
      for (var k = 0; k < 11; k++) if (get(start + k) !== pat[k]) return false;
      return true;
    }
    for (i = 0; i < size; i++) for (j = 0; j <= size - 11; j++) {     // rule 3: finder-like
      var rowGet = function (x) { return m[i][x]; };
      var colGet = function (x) { return m[x][i]; };
      if (matches(rowGet, j, pat1) || matches(rowGet, j, pat2)) score += 40;
      if (matches(colGet, j, pat1) || matches(colGet, j, pat2)) score += 40;
    }
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    var pct = (dark * 100) / (size * size);               // rule 4: dark/light balance
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function encode(text) {
    var bytes = [];
    var utf8 = unescape(encodeURIComponent(String(text)));
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff);

    var version = pickVersion(bytes.length);
    var words = interleave(buildCodewords(bytes, version), version);

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var st = makeMatrix(version);
      placeData(st, words);
      applyVersionInfo(st, version);
      for (var r = 0; r < st.size; r++) for (var c = 0; c < st.size; c++) {
        if (!st.reserved[r][c] && maskFn(mask)(r, c)) st.m[r][c] ^= 1;
      }
      applyFormat(st, mask);
      var s = penalty(st.m, st.size);
      if (s < bestScore) { bestScore = s; best = st; }
    }
    return best.m;
  }

  var api = { encode: encode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PCQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
