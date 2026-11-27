// png-squeeze: a lossless PNG re-encoder that squeezes screenshots as small as it can.
// One program, Node 22, no dependencies: it decodes each 1280x720 RGBA screenshot, picks
// the best lossless form for it (palette / grey / RGB / RGBA, with a tRNS key where one
// fits), chooses each row's filter, and writes the result with its own optimal-parse
// DEFLATE encoder (hash-chain match search, forward dynamic-programming parse, per-block
// dynamic Huffman tables), falling back to zlib level 9 where that is smaller. Every
// output is decoded again and compared pixel for pixel before it is written; on any
// mismatch the entry falls back to a plain Paeth-filtered RGBA PNG at zlib level 9.
// Deterministic: fixed work budgets only, no clock, no randomness, no environment reads
// beyond the input/output directories.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CHUNKS_OK = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0); out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2); out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Decode a PNG the contest reads (8-bit, non-interlaced, colour types 0/2/3/4/6,
// only IHDR/PLTE/tRNS/IDAT/IEND) to RGBA, or {ok:false, why}.
function decodePng(bytes) {
  const fail = (why) => ({ ok: false, why });
  if (!(bytes instanceof Uint8Array)) return fail('not bytes');
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null, palette = null, trns = null;
  const idat = [];
  let idatDone = false, ended = false;
  while (at < bytes.length) {
    if (ended) return fail('bytes after IEND');
    if (at + 12 > bytes.length) return fail('cut chunk');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNKS_OK.includes(type)) return fail('chunk ' + type);
    if (header === null && type !== 'IHDR') return fail('first chunk not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null || len !== 13) return fail('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('zero size');
      if (header.depth !== 8) return fail('bit depth ' + header.depth);
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail('colour type ' + header.colourType);
      if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) return fail('bad IHDR flags');
    } else if (type === 'PLTE') {
      if (palette !== null || header.colourType !== 3 || idat.length > 0) return fail('bad PLTE');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('bad PLTE length');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || idat.length > 0) return fail('bad tRNS');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null || len > palette.length / 3) return fail('bad tRNS for palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail('bad tRNS length');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('tRNS sample over 255');
      } else return fail('tRNS with colour type ' + ct);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('IDAT not in a row');
      if (header.colourType === 3 && palette === null) return fail('IDAT before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('IEND not empty');
      ended = true;
    }
  }
  if (!ended || idat.length === 0) return fail('no IEND/IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (e) {
    return fail('IDAT does not inflate');
  }
  if (raw.length !== expected) return fail('inflated length ' + raw.length);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail('filter ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail('palette index ' + e);
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

// ---------------------------------------------------------------- forms & filters

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

// What the image holds: opaque?, grey?, and its colours when at most 256.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS instead
// of an alpha channel: every non-opaque pixel is that exact value at alpha 0, and no
// opaque pixel uses the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// Palette entries in trial order: transparent ones first (by alpha), then by `order`.
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// The lossless forms an image can take: {colourType, bpp, samples, plte, trns}.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// The fewest-distinct-pairs heuristic's cost for a filtered row.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Filtered data for a form's samples: `choice` is a fixed filter (0-4), 'minsum'
// (least signed-sum per row) or 'pairs' (fewest distinct byte pairs per row).
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const cost = choice === 'minsum' ? signedSum(trial[t]) : pairsOf(trial[t], seen, ++stamp);
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// Screen every form with a few cheap filter choices at zlib level 6; return the
// smallest (form, filtered data). Palette forms try unfiltered and pairs; channel
// forms try unfiltered, Paeth and pairs.
function screen(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const choices = form.colourType === 3 ? [0, 'pairs'] : [0, 4, 'pairs'];
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, { level: 6 }).length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  return best;
}

// ---------------------------------------------------------------- optimal-parse DEFLATE
// A small optimal-parse DEFLATE encoder (zopfli-style, one cost iteration), written from
// scratch for the png-squeeze contest. Pure Node, no dependencies.
//   deflateZlib(data: Uint8Array, opts) -> Uint8Array   (a whole zlib stream)
// The encoder: hash-chain match finder, forward dynamic-programming optimal parse with a
// cost model from the data's own byte histogram, block splitting by fixed input size, and
// per-block dynamic Huffman tables with length-limited canonical codes.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// length code index for every match length 3..258 (and the extra-bit value)
const LEN_CODE = new Uint8Array(259);
const LEN_EXT = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const lo = LBASE[c];
  const hi = c === 28 ? 258 : LBASE[c + 1] - 1;
  for (let l = lo; l <= hi; l++) { LEN_CODE[l] = c; LEN_EXT[l] = LEXT[c]; }
}
// distance code index for every distance 1..32768
const DIST_CODE = new Uint8Array(32769);
const DIST_EXT = new Uint8Array(32769);
for (let c = 0; c < 30; c++) {
  const lo = DBASE[c];
  const hi = c === 29 ? 32768 : DBASE[c + 1] - 1;
  for (let d = lo; d <= hi; d++) { DIST_CODE[d] = c; DIST_EXT[d] = DEXT[c]; }
}

/** Length-limited Huffman code lengths from symbol frequencies (max 15, zlib-style overflow fix). */
function codeLengths(freq, maxBits) {
  const n = freq.length;
  const len = new Uint16Array(n);
  // Count non-zero symbols.
  let nz = 0;
  for (let i = 0; i < n; i++) if (freq[i] > 0) nz++;
  if (nz === 0) return len;
  if (nz === 1) {
    for (let i = 0; i < n; i++) if (freq[i] > 0) { len[i] = 1; break; }
    return len;
  }
  // Build a Huffman tree with two queues over symbols sorted by frequency.
  const order = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
  order.sort((a, b) => freq[a] - freq[b] || a - b);
  // Tree nodes: leaves are symbol indices; internal nodes get ids >= n.
  const weight = new Float64Array(2 * n);
  const left = new Int32Array(2 * n);
  const right = new Int32Array(2 * n);
  const parent = new Int32Array(2 * n).fill(-1);
  for (const s of order) weight[s] = freq[s];
  let q1 = 0; // index into order
  let q2 = n; // next internal node id to consume
  let next = n; // next internal node id to create
  const smallest = () => {
    let a = -1, wa = Infinity;
    if (q1 < order.length) { a = order[q1]; wa = weight[a]; }
    let b = -1, wb = Infinity;
    if (q2 < next) { b = q2; wb = weight[b]; }
    if (b >= 0 && wb < wa) { q2++; return b; }
    q1++;
    return a;
  };
  // Number of internal nodes to create: nz - 1.
  const total = nz - 1;
  for (let k = 0; k < total; k++) {
    const a = smallest();
    const b = smallest();
    const id = next++;
    weight[id] = weight[a] + weight[b];
    left[id] = a; right[id] = b;
    parent[a] = id; parent[b] = id;
  }
  const root = next - 1;
  // Depths.
  const depth = new Int32Array(2 * n);
  const stack = [root];
  let maxLen = 0;
  while (stack.length) {
    const v = stack.pop();
    if (v < n) { len[v] = depth[v]; if (depth[v] > maxLen) maxLen = depth[v]; continue; }
    depth[left[v]] = depth[v] + 1;
    depth[right[v]] = depth[v] + 1;
    stack.push(left[v], right[v]);
  }
  if (maxLen <= maxBits) return len;
  // Overflow fix (zlib's gen_bitlen): codes longer than maxBits are counted at maxBits,
  // then leaves are moved down until none exceed it.
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (len[i] > 0) {
      if (len[i] > maxBits) { overflow++; blCount[maxBits]++; }
      else blCount[len[i]]++;
    }
  }
  while (overflow > 0) {
    let bits = maxBits - 1;
    while (bits > 0 && blCount[bits] === 0) bits--;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxBits]--;
    overflow -= 2;
  }
  // Reassign lengths: shortest to most frequent.
  const byFreq = [...order].sort((a, b) => freq[b] - freq[a] || a - b);
  len.fill(0);
  let p = 0;
  for (let b = 1; b <= maxBits; b++) {
    for (let k = 0; k < blCount[b]; k++) len[byFreq[p++]] = b;
  }
  return len;
}

/** Canonical Huffman codes from lengths: returns {codes: Uint32Array, lens: Uint8Array}. */
function canonicalCodes(len) {
  const n = len.length;
  const maxBits = Math.max(0, ...len);
  const blCount = new Int32Array(maxBits + 1);
  for (let i = 0; i < n; i++) if (len[i] > 0) blCount[len[i]]++;
  const nextCode = new Int32Array(maxBits + 2);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const l = len[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return { codes, lens: len };
}

/** Bit writer (LSB-first within bytes, as DEFLATE wants). */
class BitWriter {
  constructor(cap) {
    this.buf = new Uint8Array(cap);
    this.at = 0; // byte position
    this.bit = 0; // bits used in current byte
  }
  grow() {
    const nb = new Uint8Array(this.buf.length * 2);
    nb.set(this.buf);
    this.buf = nb;
  }
  write(code, len) {
    // code's low `len` bits, LSB first.
    let v = code;
    let l = len;
    while (l > 0) {
      if (this.at >= this.buf.length) this.grow();
      const free = 8 - this.bit;
      const take = Math.min(free, l);
      this.buf[this.at] |= (v & ((1 << take) - 1)) << this.bit;
      v >>>= take;
      l -= take;
      this.bit += take;
      if (this.bit === 8) { this.at++; this.bit = 0; }
    }
  }
  writeRev(code, len) {
    // Huffman codes are written MSB-first: reverse `len` bits then write LSB-first.
    let r = 0;
    for (let i = 0; i < len; i++) r = (r << 1) | ((code >>> i) & 1);
    this.write(r, len);
  }
  align() {
    if (this.bit !== 0) { this.at++; this.bit = 0; }
  }
  get length() { return this.at + (this.bit ? 1 : 0); }
  bytes() { return this.buf.subarray(0, this.length); }
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Emit one dynamic-Huffman block for a token list. Tokens: {lit:number}|{len:number,dist:number} in order. */
function emitBlock(bw, tokens, litFreq, distFreq, isFinal) {
  const litLen = codeLengths(litFreq, 15);
  const distLen = codeLengths(distFreq, 15);
  // A block with no matches still needs usable distance codes so inflate can build the
  // table: give two dummy codes of length 1.
  let distUsed = 0;
  for (let i = 0; i < 30; i++) if (distLen[i] > 0) distUsed++;
  if (distUsed === 0) { distLen[0] = 1; distLen[1] = 1; }
  // Count lit/len codes: HLIT = max used symbol index + 1, at least 257.
  let hlit = 257;
  for (let i = 286; i >= 257; i--) if (litLen[i] > 0) { hlit = i + 1; break; }
  let hdist = 1;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { hdist = i + 1; break; }
  // Build the code-length sequence for litLen[0..hlit) + distLen[0..hdist), RLE'd.
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  // RLE into (symbol, extra, extrabits) triples.
  const rle = [];
  {
    let i = 0;
    while (i < seq.length) {
      const v = seq[i];
      let run = 1;
      while (i + run < seq.length && seq[i + run] === v) run++;
      if (v === 0) {
        let left = run;
        while (left >= 11) { const take = Math.min(left, 138); rle.push([18, take - 11, 7]); left -= take; }
        if (left >= 3) { rle.push([17, left - 3, 3]); left = 0; }
        while (left > 0) { rle.push([0, 0, 0]); left--; }
      } else {
        rle.push([v, 0, 0]);
        let left = run - 1;
        while (left >= 3) { const take = Math.min(left, 6); rle.push([16, take - 3, 2]); left -= take; }
        while (left > 0) { rle.push([v, 0, 0]); left--; }
      }
      i += run;
    }
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of rle) clFreq[s]++;
  const clLen = codeLengths(clFreq, 7);
  let hclen = 4;
  for (let i = 19; i > 4; i--) if (clLen[CL_ORDER[i - 1]] > 0) { hclen = i; break; }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  bw.write(isFinal ? 1 : 0, 1);
  bw.write(2, 2); // dynamic Huffman
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) bw.write(clLen[CL_ORDER[i]], 3);
  for (const [s, extra, eb] of rle) {
    bw.writeRev(clCode.codes[s], clLen[s]);
    if (eb) bw.write(extra, eb);
  }
  for (const t of tokens) {
    if (t.lit !== undefined) {
      bw.writeRev(litCode.codes[t.lit], litLen[t.lit]);
    } else {
      const lc = LEN_CODE[t.len];
      bw.writeRev(litCode.codes[257 + lc], litLen[257 + lc]);
      if (LEXT[lc]) bw.write(t.len - LBASE[lc], LEXT[lc]);
      const dc = DIST_CODE[t.dist];
      bw.writeRev(distCode.codes[dc], distLen[dc]);
      if (DEXT[dc]) bw.write(t.dist - DBASE[dc], DEXT[dc]);
    }
  }
  bw.writeRev(litCode.codes[256], litLen[256]); // end of block
}


/** Longest match at every position, by bounded hash-chain walk. Returns, per position,
 * the breakpoints of the best match: (length, distance) pairs where, walking the chain in
 * increasing-distance order, a longer match first appears. Lengths up to the first
 * breakpoint's length use its distance, lengths past it use the next one's, and so on
 * (zopfli's sublen, compacted). */
function findMatches(data, maxChain, goodLen) {
  const n = data.length;
  const HSIZE = 131072;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(n);
  const hashAt = (i) => (((data[i] << 8 | data[i + 1]) << 8 | data[i + 2]) * 0x9e3779b1) >>> 15 & 0x1ffff;
  // Flat breakpoint storage: brkOff[i] is the start index in brkLen/brkDist for position i.
  const brkLen = [];
  const brkDist = [];
  const brkOff = new Int32Array(n + 1);
  let inserted = 0;
  for (let i = 0; i + 3 <= n; i++) {
    while (inserted < i && inserted + 2 < n) {
      const h = hashAt(inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
      inserted++;
    }
    const h = hashAt(i);
    let p = head[h];
    let bestLen = 0, steps = 0;
    const maxLen = Math.min(258, n - i);
    let nb = 0;
    while (p >= 0 && steps < maxChain) {
      const dist = i - p;
      if (dist > 32768) break;
      // To beat bestLen, the candidate must match at offset bestLen (and at 0: the
      // hash can collide). Probe those two bytes before comparing the whole run.
      if (bestLen >= 3) {
        if (data[p + bestLen] !== data[i + bestLen] || data[p] !== data[i]) { p = prev[p]; steps++; continue; }
      } else if (data[p] !== data[i] || data[p + 1] !== data[i + 1] || data[p + 2] !== data[i + 2]) { p = prev[p]; steps++; continue; }
      let m = 0;
      const end = i + maxLen;
      let a = i, b = p;
      while (a < end && data[a] === data[b]) { a++; b++; m++; }
      if (m > bestLen) {
        // This (nearer) candidate is the first to reach lengths bestLen+1..m.
        if (nb < 6) { brkLen.push(m); brkDist.push(dist); nb++; }
        bestLen = m;
        if (bestLen >= goodLen || bestLen >= maxLen) break;
      }
      p = prev[p];
      steps++;
    }
    brkOff[i + 1] = brkOff[i] + nb;
  }
  // Positions n-2 and n-1 hold fewer than 3 bytes: no breakpoints there.
  brkOff[n - 1] = brkOff[n - 2];
  brkOff[n] = brkOff[n - 2];
  return { brkLen: Uint16Array.from(brkLen), brkDist: Int32Array.from(brkDist), brkOff };
}

/** Forward DP optimal parse with a cost model; returns tokens with positions. */
function parse(data, brk, litCost, lenCost, distCost, dpMaxLen, jumpLen = 160) {
  const { brkLen, brkDist, brkOff } = brk;
  const n = data.length;
  const dp = new Float64Array(n + 1).fill(Infinity);
  const blen = new Int32Array(n + 1);
  const bdist = new Int32Array(n + 1);
  dp[0] = 0;
  for (let i = 0; i < n;) {
    const base = dp[i];
    if (base === Infinity) { i++; continue; }
    const bo = brkOff[i];
    const bn = brkOff[i + 1] - bo;
    const maxLen = bn === 0 ? 0 : brkLen[bo + bn - 1];
    if (maxLen >= jumpLen) {
      // Greedy jump: the longest match dominates any alternative parse of the span.
      const dist = brkDist[bo + bn - 1];
      const c = base + lenCost[maxLen] + distCost[dist];
      if (c < dp[i + maxLen]) { dp[i + maxLen] = c; blen[i + maxLen] = maxLen; bdist[i + maxLen] = dist; }
      i += maxLen;
      continue;
    }
    const lc = base + litCost[data[i]];
    if (lc < dp[i + 1]) { dp[i + 1] = lc; blen[i + 1] = 1; bdist[i + 1] = 0; }
    if (bn === 0 || maxLen < 3) { i++; continue; }
    // Walk the breakpoint segments: lengths (prevLen+1 .. len] use dist.
    let prevLen = 2;
    for (let sgm = 0; sgm < bn; sgm++) {
      const segLen = brkLen[bo + sgm];
      const dist = brkDist[bo + sgm];
      const dc = distCost[dist];
      const upto = Math.min(segLen, dpMaxLen);
      for (let l = Math.max(3, prevLen + 1); l <= upto; l++) {
        const c = base + lenCost[l] + dc;
        if (c < dp[i + l]) { dp[i + l] = c; blen[i + l] = l; bdist[i + l] = dist; }
      }
      if (segLen > dpMaxLen && sgm === bn - 1) {
        const c = base + lenCost[segLen] + dc;
        if (c < dp[i + segLen]) { dp[i + segLen] = c; blen[i + segLen] = segLen; bdist[i + segLen] = dist; }
      }
      prevLen = segLen;
    }
    i++;
  }
  const tokens = [];
  let j = n;
  const rev = [];
  while (j > 0) {
    const l = blen[j] || 1;
    const d = bdist[j];
    if (l === 1) rev.push({ lit: data[j - 1], pos: j - 1 });
    else rev.push({ len: l, dist: d, pos: j - l });
    j -= l;
  }
  rev.reverse();
  for (const t of rev) tokens.push(t);
  return tokens;
}

/** Symbol frequencies of a token list. */
function tokenFreqs(tokens) {
  const lf = new Uint32Array(286);
  const df = new Uint32Array(30);
  for (const t of tokens) {
    if (t.lit !== undefined) lf[t.lit]++;
    else { lf[257 + LEN_CODE[t.len]]++; df[DIST_CODE[t.dist]]++; }
  }
  lf[256] = 1;
  return { lf, df };
}

/** Cost tables from literal/length and distance code lengths. */
function costsFrom(litLen, distLen) {
  const litCost = new Float64Array(286);
  for (let i = 0; i < 286; i++) litCost[i] = litLen[i] > 0 ? litLen[i] : 12;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = (litLen[257 + LEN_CODE[l]] || 8) + LEXT[LEN_CODE[l]];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distCost[d] = (distLen[DIST_CODE[d]] || 8) + DEXT[DIST_CODE[d]];
  return { litCost, lenCost, distCost };
}

/**
 * Optimal-parse tokenize `data` with a cost model, then emit dynamic-Huffman blocks.
 * opts: {maxChain, goodLen, dpMaxLen, blockSize, iterations}
 */
function deflateZlib(data, opts = {}) {
  const n = data.length;
  const maxChain = opts.maxChain ?? 48;
  const goodLen = opts.goodLen ?? 64;
  const dpMaxLen = opts.dpMaxLen ?? 32;
  const blockSize = opts.blockSize ?? 131072;
  const iterations = opts.iterations ?? 2;
  const jumpLen = opts.jumpLen ?? 1000000;

  // ---- initial cost model from the raw byte histogram ----
  const hist = new Uint32Array(286);
  for (let i = 0; i < n; i++) hist[data[i]]++;
  hist[256] = 1;
  const litLen0 = codeLengths(hist, 15);
  const distLen0 = new Uint16Array(30);
  let { litCost, lenCost, distCost } = costsFrom(litLen0, distLen0);

  // ---- matches once, DP iterations refine the cost model ----
  const brk = findMatches(data, maxChain, goodLen);
  let tokens = null;
  for (let it = 0; it < iterations; it++) {
    tokens = parse(data, brk, litCost, lenCost, distCost, dpMaxLen, jumpLen);
    if (it + 1 < iterations) {
      const { lf, df } = tokenFreqs(tokens);
      const ll = codeLengths(lf, 15);
      const dl = codeLengths(df, 15);
      ({ litCost, lenCost, distCost } = costsFrom(ll, dl));
    }
  }

  // ---- emit blocks, split by input position ----
  const bw = new BitWriter(data.length + 65536);
  bw.write(0x78, 8);
  bw.write(0xda, 8);
  let ti = 0;
  let blockStart = 0;
  while (ti < tokens.length) {
    const blockEndPos = blockStart + blockSize;
    const btokens = [];
    const lf = new Uint32Array(286);
    const df = new Uint32Array(30);
    let pos = blockStart;
    while (ti < tokens.length) {
      const t = tokens[ti];
      if (t.pos >= blockEndPos && btokens.length > 0) break;
      btokens.push(t);
      if (t.lit !== undefined) lf[t.lit]++;
      else { lf[257 + LEN_CODE[t.len]]++; df[DIST_CODE[t.dist]]++; }
      ti++;
      pos = t.pos + (t.lit !== undefined ? 1 : t.len);
    }
    lf[256] = 1;
    blockStart = pos;
    const isFinal = ti >= tokens.length;
    emitBlock(bw, btokens, lf, df, isFinal);
  }
  bw.align();
  const ad = adler32(data);
  const out = bw.bytes();
  const res = new Uint8Array(out.length + 4);
  res.set(out, 0);
  res[out.length] = (ad >>> 24) & 0xff;
  res[out.length + 1] = (ad >>> 16) & 0xff;
  res[out.length + 2] = (ad >>> 8) & 0xff;
  res[out.length + 3] = ad & 0xff;
  return res;
}

// ---------------------------------------------------------------- driver

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Plain fallback: RGBA, every row Paeth-filtered, zlib level 9.
function fallbackPng(rgba, width, height) {
  const raw = filtered(rgba, width, height, 4, 4);
  const form = { colourType: 6, plte: null, trns: null };
  return pngOfForm(width, height, form, deflateSync(raw, { level: 9 }));
}

function sameRgba(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

for (const id of readdirSync(INPUT).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
  if (!image.ok) throw new Error(id + '/image.png: ' + image.why);
  const { rgba, width, height } = image;
  const { form, data } = screen(rgba, width, height);
  // Best zlib stream for the screened data: our optimal-parse encoder vs zlib 9.
  const mine = deflateZlib(data, { iterations: 3, blockSize: 262144, dpMaxLen: 64, maxChain: 128, goodLen: 258 });
  const z9 = deflateSync(data, { level: 9 });
  const idat = mine.length <= z9.length ? mine : z9;
  let out = pngOfForm(width, height, form, idat);
  // Self-verify: the written PNG must decode to exactly these pixels.
  const check = decodePng(out);
  if (!check.ok || !sameRgba(check.rgba, rgba)) out = fallbackPng(rgba, width, height);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), out);
}
