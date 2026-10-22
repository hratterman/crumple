#!/usr/bin/env node
// R-RIG: offline crash image sequences, standard vs high-density rigs.
//
//   node tools/rig-crash-shots.mjs                       # sedan: offset 50 + 64, pole 30, frontal 50
//   CAR=sedan TIERS=standard,high,ultra CASES=offset64,pole30 OUT=/tmp/x node tools/rig-crash-shots.mjs
//
// Runs the headless crash harness (src/sim/vehicle/crash.ts, the same set-up the
// crash tests use) for each variant, captures the node positions at fixed times
// after first contact, deforms the car's REAL render body with the flexbody CPU
// mirror (binder.ts evalFlexVertex, i.e. what the GPU skin draws minus the
// cosmetic crumple folds) and rasterizes it (tools/rig-raster.mjs). One PNG per
// case: rows = variants, columns = times; plus a 3/4 close-up of the final state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { blit, camera, createCanvas, drawLine, drawText, drawTriangle, encodePng } from './rig-raster.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const imp = async (p) => (await runnerImport(resolve(ROOT, 'src', p))).module;

const CAR = process.env.CAR ?? 'sedan';
const TIERS = (process.env.TIERS ?? 'standard,high').split(',');
const CASES = (process.env.CASES ?? 'offset50,offset64,pole30,frontal50').split(',');
const OUT = resolve(process.env.OUT ?? resolve(ROOT, 'test-results/rig'));
const TIMES_MS = (process.env.TIMES ?? '0,30,60,90,140,2000').split(',').map(Number);
const TW = Number(process.env.TW ?? 420);
const TH = Number(process.env.TH ?? 250);
/** body = the render body (flexbody CPU mirror); structure = the rig's beams (members orange→red by plastic set, backbone grey, sheets faint). */
const VIEW = process.env.VIEW ?? 'body';
/** Optional fixed close-up camera relative to the car's body centroid: "ex,ey,ez|tx,ty,tz|fov" (metres, degrees). */
const CLOSE = process.env.CLOSE ? process.env.CLOSE.split('|').map((p) => p.split(',').map(Number)) : null;
mkdirSync(OUT, { recursive: true });

const crash = await imp('sim/vehicle/crash.ts');
const builder = await imp('sim/vehicle/builder.ts');
const hdSim = await imp('sim/vehicle/defs/hd/index.ts');
const hdVis = await imp('render/vehicle/defs/hd/index.ts');
const loft = await imp('render/vehicle/loft.ts');
const binder = await imp('render/vehicle/binder.ts');
const lods = await imp('render/vehicle/lods.ts');

const MAT = {
  paint: [176, 32, 38], trim: [38, 40, 44], chrome: [190, 194, 200], glass: [60, 74, 92], rubber: [24, 24, 26], lightHead: [220, 224, 230],
  lightTail: [170, 20, 24], lightIndicator: [230, 140, 30], lightReverse: [230, 230, 230], interior: [70, 66, 62], interiorTrim: [52, 52, 56],
  grille: [30, 30, 32], underbody: [48, 48, 50], mirror: [140, 150, 160], plate: [230, 230, 220], caliper: [150, 150, 150],
};

function variant(tier) {
  const v = hdSim.vehicleVariantSync(CAR, tier);
  const visual = hdVis.vehicleVisualSync(CAR, tier);
  const cv = builder.compileVehicle(v.def);
  const geoms = loft.tessellateVehicle(visual);
  const bound = binder.applyFollowers(cv.rig, binder.bindPanels(cv, visual, geoms), lods.visualExtras(visual).follow);
  return { tier, def: v.def, probes: v.probes, cv, visual, binding: bound };
}

function parseCase(c) {
  const m = /^(frontal|offset|pole)(\d+)$/.exec(c);
  if (!m) throw new Error(`bad case ${c}`);
  return { kind: m[1], kmh: Number(m[2]) };
}

/** Runs one crash; returns frames (object-local node positions) at TIMES_MS after contact + the collider description. */
function run(v, c) {
  const want = TIMES_MS.map((ms) => Math.round((ms / 1000) * 2000));
  const frames = new Map();
  let collider = null;
  const res = crash.runCrash({
    kind: c.kind,
    speedKmh: c.kmh,
    def: v.def,
    probes: v.probes,
    ...(c.kind === 'offset' ? { overlap: 0.4 } : {}),
    afterContactS: Math.max(...TIMES_MS) / 1000,
    onStep(eng, obj, since) {
      if (!collider) collider = eng.extraColliders?.[0] ?? null;
      if (!want.includes(since)) return;
      const s = eng.state;
      const n = obj.nodeCount;
      const p = new Float64Array(3 * n);
      for (let i = 0; i < n; i++) {
        p[3 * i] = s.posX[obj.nodeStart + i];
        p[3 * i + 1] = s.posY[obj.nodeStart + i];
        p[3 * i + 2] = s.posZ[obj.nodeStart + i];
      }
      const b0 = obj.beamStart;
      const rest = new Float64Array(obj.beamCount);
      const active = new Uint8Array(obj.beamCount);
      for (let b = 0; b < obj.beamCount; b++) {
        rest[b] = s.restLen[b0 + b] / s.restLen0[b0 + b];
        active[b] = s.active[b0 + b];
      }
      p.rest = rest;
      p.active = active;
      frames.set(since, p);
    },
  });
  return { res, frames: want.map((t) => frames.get(t) ?? null), collider };
}

function drawStructure(cv, cam, v, nodes) {
  const rig = v.cv.rig;
  const ids = rig.nodeIds;
  const P = (i) => [nodes[3 * i], nodes[3 * i + 1], nodes[3 * i + 2]];
  const order = [];
  for (let b = 0; b < v.cv.bodyBeamCount; b++) order.push(b);
  // sheets first (faint), backbone, members last (on top)
  const rank = (b) => {
    const a = ids[rig.beamA[b]];
    const c = ids[rig.beamB[b]];
    if (a.startsWith('m_') || c.startsWith('m_')) return 2;
    if (a.startsWith('k_') || c.startsWith('k_')) return 0;
    return 1;
  };
  order.sort((x, y) => rank(x) - rank(y));
  for (const b of order) {
    if (nodes.active && !nodes.active[b]) continue;
    const r = rank(b);
    const set = nodes.rest ? Math.abs(nodes.rest[b] - 1) : 0;
    const t = Math.min(1, set / 0.3);
    const col = r === 2 ? [Math.round(240 - 40 * t), Math.round(150 - 130 * t), 20] : r === 1 ? [Math.round(110 + 120 * t), Math.round(118 - 60 * t), Math.round(130 - 80 * t)] : [200, 202, 210];
    drawLine(cv, cam, P(rig.beamA[b]), P(rig.beamB[b]), col, r === 2 ? 0.01 : 0.002);
  }
}

function drawCar(cv, cam, v, nodes) {
  if (VIEW === 'structure') return drawStructure(cv, cam, v, nodes);
  const out = new Float64Array(6);
  for (const panel of v.binding.panels) {
    if (panel.kind === 'interior' && panel.material === 'interior') continue;
    const col = MAT[panel.material] ?? [128, 128, 128];
    const nV = panel.vertexCount;
    const P = new Float64Array(3 * nV);
    for (let i = 0; i < nV; i++) {
      binder.evalFlexVertex(panel, i, nodes, out);
      P[3 * i] = out[0];
      P[3 * i + 1] = out[1];
      P[3 * i + 2] = out[2];
    }
    const idx = panel.index;
    const spec = panel.material === 'paint' ? 0.5 : panel.material === 'glass' ? 0.7 : 0.15;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      drawTriangle(cv, cam, [P[3 * a], P[3 * a + 1], P[3 * a + 2]], [P[3 * b], P[3 * b + 1], P[3 * b + 2]], [P[3 * c], P[3 * c + 1], P[3 * c + 2]], col, { specular: spec });
    }
  }
  // wheels: tyre ring (outer plane) as a fan, rim ring lighter
  for (const w of v.cv.wheels) {
    const ring = (start) => Array.from({ length: w.rays }, (_, k) => [nodes[3 * (start + k)], nodes[3 * (start + k) + 1], nodes[3 * (start + k) + 2]]);
    for (const [start, col] of [[w.tireStart, [28, 28, 30]], [w.tireStart + w.rays, [28, 28, 30]], [w.rimStart + w.rays, [170, 172, 178]]]) {
      const r = ring(start);
      const c = r.reduce((a, p) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length, a[2] + p[2] / r.length], [0, 0, 0]);
      for (let k = 0; k < r.length; k++) drawTriangle(cv, cam, c, r[k], r[(k + 1) % r.length], col, { specular: 0.05 });
    }
  }
}

function drawScene(cv, cam, collider, groundY = 0) {
  // ground grid
  for (let x = -6; x <= 6; x += 0.5) drawLine(cv, cam, [x, groundY, -8], [x, groundY, 8], [205, 208, 214], 0);
  for (let z = -8; z <= 8; z += 0.5) drawLine(cv, cam, [-6, groundY, z], [6, groundY, z], [205, 208, 214], 0);
  if (!collider) return;
  const col = [150, 154, 160];
  if (collider.kind === 'box') {
    const [cx, cy, cz] = collider.pos;
    const [hx, hy, hz] = collider.size;
    const v = (sx, sy, sz) => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const faces = [
      [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)],
      [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)],
      [v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1)],
      [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
      [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)],
    ];
    for (const f of faces) {
      drawTriangle(cv, cam, f[0], f[1], f[2], col, { specular: 0 });
      drawTriangle(cv, cam, f[0], f[2], f[3], col, { specular: 0 });
    }
  } else if (collider.kind === 'cylinder') {
    const [cx, , cz] = collider.pos;
    const r = collider.size[0];
    const N = 24;
    for (let k = 0; k < N; k++) {
      const a0 = (2 * Math.PI * k) / N;
      const a1 = (2 * Math.PI * (k + 1)) / N;
      const p = (a, y) => [cx + r * Math.cos(a), y, cz + r * Math.sin(a)];
      drawTriangle(cv, cam, p(a0, 0), p(a1, 0), p(a1, 3), col, { specular: 0.3 });
      drawTriangle(cv, cam, p(a0, 0), p(a1, 3), p(a0, 3), col, { specular: 0.3 });
    }
  }
}

function centroid(nodes, n) {
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += nodes[3 * i + k] / n;
  return c;
}

const variants = TIERS.map(variant);
for (const name of CASES) {
  const c = parseCase(name);
  const runs = variants.map((v) => ({ v, ...run(v, c) }));
  // side view: frontal / offset from the struck side (offset: vehicle left = −X), pole: 3/4 from above on the struck side (+X)
  const sheet = createCanvas(TW * TIMES_MS.length + 120, TH * runs.length + 64, [250, 250, 252]);
  drawText(sheet, 10, 8, `${CAR} ${c.kind} ${c.kmh} KM/H`, [20, 20, 20], 3);
  TIMES_MS.forEach((ms, j) => drawText(sheet, 120 + j * TW + 8, 44, `${ms} MS`, [60, 60, 60], 2));
  runs.forEach((r, i) => {
    drawText(sheet, 8, 64 + i * TH + TH / 2 - 10, r.v.tier.slice(0, 8), [20, 20, 20], 2);
    r.frames.forEach((nodes, j) => {
      const tile = createCanvas(TW, TH);
      if (nodes) {
        const cen = centroid(nodes, r.v.cv.bodyNodeCount);
        const side = c.kind === 'offset' ? -1 : 1;
        const eye = c.kind === 'pole' ? [cen[0] + 5, cen[1] + 3.5, cen[2] + 4.2] : [cen[0] + side * 9, cen[1] + 0.9, cen[2] - 0.4];
        const cam = camera({ eye, target: [cen[0], cen[1] - 0.05, cen[2] - (c.kind === 'pole' ? 0 : 0.4)], fov: c.kind === 'pole' ? 34 : 30 }, TW, TH);
        drawScene(tile, cam, r.collider);
        drawCar(tile, cam, r.v, nodes);
      }
      blit(sheet, tile, 120 + j * TW, 64 + i * TH);
    });
  });
  const file = resolve(OUT, `${CAR}-${name}-${VIEW === 'body' ? '' : VIEW + '-'}sequence.png`);
  writeFileSync(file, encodePng(sheet));
  // final-state close-ups, 3/4 views
  const close = createCanvas(560 * runs.length, 420, [250, 250, 252]);
  runs.forEach((r, i) => {
    const nodes = r.frames[r.frames.length - 1];
    const tile = createCanvas(560, 420);
    if (nodes) {
      const cen = centroid(nodes, r.v.cv.bodyNodeCount);
      const eye = CLOSE ? CLOSE[0].map((v, k) => cen[k] + v) : c.kind === 'pole' ? [cen[0] + 4.2, cen[1] + 2.4, cen[2] - 3.4] : c.kind === 'offset' ? [cen[0] - 3.6, cen[1] + 1.8, cen[2] - 4.4] : [cen[0] - 3.2, cen[1] + 2.0, cen[2] - 4.8];
      const target = CLOSE ? CLOSE[1].map((v, k) => cen[k] + v) : [cen[0], cen[1] - 0.1, cen[2] - (c.kind === 'pole' ? 0 : 1.1)];
      const cam = camera({ eye, target, fov: CLOSE ? CLOSE[2][0] : 38 }, 560, 420);
      drawScene(tile, cam, r.collider);
      drawCar(tile, cam, r.v, nodes);
    }
    drawText(tile, 10, 10, `${r.v.tier}`, [20, 20, 20], 3);
    blit(close, tile, i * 560, 0);
  });
  const file2 = resolve(OUT, `${CAR}-${name}-${VIEW === 'body' ? '' : VIEW + '-'}final34.png`);
  writeFileSync(file2, encodePng(close));
  for (const r of runs) console.log(`${r.v.tier.padEnd(8)} ${crash.formatCrash(r.res)}`);
  console.log(`wrote ${file}\n      ${file2}`);
}
