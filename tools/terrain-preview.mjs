#!/usr/bin/env node
// Top-down shaded-relief PNG of a world layout (hillshade × splat colours,
// water, optional 10 m contours; roads show through their paved / dirt splat).
// Node built-ins only: TypeScript is loaded through node's type stripping
// with a resolve hook for the repo's extensionless imports.
//
//   node tools/terrain-preview.mjs <out.png> [--layout id] [--scale k]
//        [--crop x0,z0,x1,z1]   (world metres; default the whole map)
//        [--contours]           (faint 10 m contour lines)
import { registerHooks } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && !/^[-\d.,]+$/.test(a)) ?? 'test-results/terrain-relief.png';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const { generateTerrain } = await import('../src/world/terrain.ts');
const { WORLD_LAYOUTS, DEFAULT_LAYOUT } = await import('../src/world/layout.ts');
const layout = WORLD_LAYOUTS[opt('layout', DEFAULT_LAYOUT.id)];
if (!layout) throw new Error(`unknown layout ${opt('layout')}`);

const cpu0 = process.cpuUsage();
const t0 = performance.now();
const tg = await import("../src/world/terrain.ts");
const t = generateTerrain(layout);
console.log(JSON.stringify(Object.fromEntries(Object.entries(tg.lastTerrainTimings).map(([k, v]) => [k, Math.round(v)]))));
const ms = performance.now() - t0;
const cpuMs = (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000;
const { cols, rows, heights, splat, spacing, originX, originZ, waterLevel } = t;

// ---------------------------------------------------------------- stats
let sum = 0;
let under = 0;
for (let i = 0; i < heights.length; i++) {
  sum += heights[i];
  if (heights[i] < waterLevel) under++;
}
console.log(`generateTerrain(${layout.id}): ${ms.toFixed(0)} ms wall (${cpuMs.toFixed(0)} ms cpu), ${cols}×${rows}, hash 0x${t.hash.toString(16)}`);
console.log(
  `heights: min ${t.minHeight.toFixed(2)}  max ${t.maxHeight.toFixed(2)}  mean ${(sum / heights.length).toFixed(2)}  ` +
    `below water ${((100 * under) / heights.length).toFixed(1)} %`,
);
for (const r of t.roads) {
  let g = 0;
  const st = r.stations;
  for (let i = 1; i < r.stationCount; i++) {
    const dy = Math.abs(st[i * 7 + 1] - st[(i - 1) * 7 + 1]);
    const dx = Math.hypot(st[i * 7] - st[(i - 1) * 7], st[i * 7 + 2] - st[(i - 1) * 7 + 2]);
    if (dx > 0.5) g = Math.max(g, dy / dx);
  }
  let bank = 0;
  for (let i = 0; i < r.stationCount; i++) bank = Math.max(bank, Math.abs(st[i * 7 + 5]));
  console.log(
    `  road ${r.id.padEnd(12)} ${r.kind.padEnd(8)} ${r.length.toFixed(0).padStart(5)} m  ` +
      `y ${st[1].toFixed(1)}→${st[(r.stationCount - 1) * 7 + 1].toFixed(1)}  max grade ${(g * 100).toFixed(1)} %  max bank ${(bank * 100).toFixed(1)} %`,
  );
}

// ---------------------------------------------------------------- render
const contours = args.includes('--contours');
const crop = opt('crop', null)?.split(',').map(Number);
const scale = Number(opt('scale', crop ? 4 : 1));
const x0 = crop ? crop[0] : originX;
const z0 = crop ? crop[1] : originZ;
const x1 = crop ? crop[2] : originX + (cols - 1) * spacing;
const z1 = crop ? crop[3] : originZ + (rows - 1) * spacing;
const W = Math.round(((x1 - x0) / spacing) * (crop ? scale : 1) / (crop ? 1 : scale));
const H = Math.round(((z1 - z0) / spacing) * (crop ? scale : 1) / (crop ? 1 : scale));

const hAt = (x, z) => {
  let u = (x - originX) / spacing;
  let v = (z - originZ) / spacing;
  u = Math.min(Math.max(u, 0), cols - 1.001);
  v = Math.min(Math.max(v, 0), rows - 1.001);
  const c = Math.floor(u);
  const r = Math.floor(v);
  const fu = u - c;
  const fv = v - r;
  const i = r * cols + c;
  const a = heights[i] + (heights[i + 1] - heights[i]) * fu;
  const b = heights[i + cols] + (heights[i + cols + 1] - heights[i + cols]) * fu;
  return a + (b - a) * fv;
};
const near = (x, z) => {
  const c = Math.min(Math.max(Math.round((x - originX) / spacing), 0), cols - 1);
  const r = Math.min(Math.max(Math.round((z - originZ) / spacing), 0), rows - 1);
  return r * cols + c;
};

// Linear-ish sRGB palette per splat set.
const PAL = {
  paved: [72, 72, 76],
  concrete: [168, 166, 158],
  dirt: [128, 98, 66],
  rock: [128, 124, 118],
  gravel: [164, 152, 130],
  grass: [92, 124, 58],
};
// Light from the north-west (−X, −Z: top-left of the image), 40° up.
const L = (() => {
  const v = [-0.54, 0.64, -0.54];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

const px = Buffer.alloc(W * H * 3);
const step = (x1 - x0) / W;
const e = Math.max(spacing, step);
for (let j = 0; j < H; j++) {
  const z = z0 + (j + 0.5) * ((z1 - z0) / H);
  for (let i = 0; i < W; i++) {
    const x = x0 + (i + 0.5) * step;
    const h = hAt(x, z);
    const gx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e);
    const gz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
    const nl = Math.hypot(gx, 1, gz);
    const shade = Math.max(0, (-gx * L[0] + L[1] - gz * L[2]) / nl);
    const k = near(x, z);
    const s0 = splat[k * 4] / 255;
    const s1 = splat[k * 4 + 1] / 255;
    const s2 = splat[k * 4 + 2] / 255;
    const s3 = splat[k * 4 + 3] / 255;
    const sg = Math.max(0, 1 - s0 - s1 - s2 - s3);
    const paved = t.material[k] === 5 ? PAL.concrete : PAL.paved;
    let col = [0, 1, 2].map((c) => paved[c] * s0 + PAL.dirt[c] * s1 + PAL.rock[c] * s2 + PAL.gravel[c] * s3 + PAL.grass[c] * sg);
    // Height tint: drier / paler grass up high.
    const hk = Math.min(1, Math.max(0, (h - 30) / 120));
    col = col.map((v, c) => v * (1 - 0.25 * hk) + [150, 140, 120][c] * 0.25 * hk);
    let lit = 0.3 + 0.95 * shade;
    // Faint 10 m contours.
    const cf = h / 10 - Math.floor(h / 10);
    if (contours && cf < 0.04 * Math.max(1, Math.hypot(gx, gz) * 2) && h > waterLevel) lit *= 0.9;
    col = col.map((v) => v * lit);
    if (h < waterLevel) {
      const d = Math.min(1, (waterLevel - h) / 6);
      const water = [40 + 30 * (1 - d), 90 + 40 * (1 - d), 120 + 30 * (1 - d)];
      col = col.map((v, c) => v * 0.25 + water[c] * 0.75);
    }
    const o = (j * W + i) * 3;
    px[o] = Math.max(0, Math.min(255, Math.round(col[0])));
    px[o + 1] = Math.max(0, Math.min(255, Math.round(col[1])));
    px[o + 2] = Math.max(0, Math.min(255, Math.round(col[2])));
  }
}

// ---------------------------------------------------------------- PNG
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let j = 0; j < H; j++) {
  raw[j * (W * 3 + 1)] = 0;
  px.copy(raw, j * (W * 3 + 1) + 1, j * W * 3, (j + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const outPath = resolve(out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${W}×${H})`);
