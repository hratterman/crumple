#!/usr/bin/env node
// R-RIG: samples every car's lofted render panels into skin node grids for the
// high-density rigs (docs/CONTRACTS.md "R-RIG").
//
//   node tools/rig-skins.mjs                 # all cars, all tiers
//   CARS=sedan TIERS=high node tools/rig-skins.mjs
//
// The sim may not import src/render, so the outer sheets cross the boundary as
// generated data: src/sim/vehicle/defs/hd/skins/<car>.<tier>.ts (SkinSet). Run it
// after a body-shape change; src/render/vehicle/defs/hd/hd.test.ts fails
// when the committed data drifts from the render surfaces.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const src = (p) => resolve(ROOT, 'src', p);
const imp = async (p) => (await runnerImport(src(p))).module;

const { SKIN_SOURCES, SKIN_TIERS, extractSkins, formatSkinModule } = await imp('sim/vehicle/defs/hd/skinSources.ts');
const cars = (process.env.CARS ?? Object.keys(SKIN_SOURCES).join(',')).split(',');
const tiers = (process.env.TIERS ?? Object.keys(SKIN_TIERS).join(',')).split(',');
const { tessellateVehicle } = await imp('render/vehicle/loft.ts');

for (const car of cars) {
  const s = SKIN_SOURCES[car];
  if (!s) throw new Error(`unknown car ${car}`);
  const vis = (await imp(s.visualModule))[s.visualExport];
  const def = (await imp(s.simModule))[s.simExport];
  const geoms = tessellateVehicle(vis);
  for (const tier of tiers) {
    const t0 = Date.now();
    const set = extractSkins(car, vis, geoms, def, SKIN_TIERS[tier]);
    const file = src(`sim/vehicle/defs/hd/skins/${car}.${tier}.ts`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, formatSkinModule(set, `${car} ${tier}`));
    const nodes = set.panels.reduce((a, p) => a + p.pos.length / 3, 0);
    const tris = set.panels.reduce((a, p) => a + p.tris.length / 3, 0);
    console.log(`${car}.${tier}: pitch ${SKIN_TIERS[tier]} m, ${set.panels.length} panels, ${nodes} nodes, ${tris} tris, hash ${set.hash.toString(16)} (${Date.now() - t0} ms)`);
    for (const p of set.panels) console.log(`  ${p.id.padEnd(14)} ${String(p.pos.length / 3).padStart(4)} nodes ${String(p.edge.length).padStart(4)} edge  A ${p.area.toFixed(2)} m²  attach ${p.attach.length}`);
  }
}
