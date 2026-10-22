#!/usr/bin/env node
// R-RIG: physics cost per variant (ms of CPU per simulated second, the P6 / U1 method):
// the car on the handling harness's plane (src/sim/vehicle/handling.ts createHandlingSim),
// 0.5 s parked, then a full-throttle launch for SECONDS (the whole step: beams, contacts,
// tyres, drivetrain, shell cluster), after a warm-up run; REPEATS timed runs, min / median.
// Every variant is measured in the same process, interleaved, so a loaded box scales them
// alike: `norm` rescales to the standard sedan's quiet-box 200 ms/sim-s (U1).
//
//   node tools/rig-perf.mjs                               # sedan standard / high / ultra
//   CARS=sedan,coupe TIERS=standard,high SECONDS=10 REPEATS=3 node tools/rig-perf.mjs
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const imp = async (p) => (await runnerImport(resolve(ROOT, 'src', p))).module;

const CARS = (process.env.CARS ?? 'sedan').split(',');
const TIERS = (process.env.TIERS ?? 'standard,high,ultra').split(',');
const SECONDS = Number(process.env.SECONDS ?? 8);
const REPEATS = Number(process.env.REPEATS ?? 3);
const handling = await imp('sim/vehicle/handling.ts');
const builder = await imp('sim/vehicle/builder.ts');
const hd = await imp('sim/vehicle/defs/hd/index.ts');

const variants = [];
for (const car of CARS) for (const tier of TIERS) {
  try {
    const v = hd.vehicleVariantSync(car, tier);
    const cv = builder.compileVehicle(v.def);
    variants.push({ car, tier, def: v.def, nodes: cv.rig.nodeCount, beams: cv.rig.beamCount });
  } catch (e) {
    console.log(`${car}.${tier}: ${e.message}`);
  }
}
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
function drive(def, seconds) {
  const sim = handling.createHandlingSim({ def });
  sim.eng.setInput(1, { gearSelect: 1, throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  handling.stepN(sim, 1000);
  sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0, steer: 0, handbrake: 0 });
  const c0 = cpu();
  handling.stepN(sim, Math.round(seconds * 2000));
  return (cpu() - c0) / seconds;
}
for (const v of variants) drive(v.def, 1); // warm-up (JIT)
const times = new Map(variants.map((v) => [v, []]));
for (let r = 0; r < REPEATS; r++) for (const v of variants) times.get(v).push(drive(v.def, SECONDS));
const std = variants.find((v) => v.car === 'sedan' && v.tier === 'standard');
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const stdMed = std ? med(times.get(std)) : NaN;
console.log('variant              nodes  beams   min    median  (ms CPU / sim-s)  norm (sedan std = 200)');
for (const v of variants) {
  const t = times.get(v);
  const m = med(t);
  console.log(`${`${v.car}.${v.tier}`.padEnd(20)} ${String(v.nodes).padStart(5)} ${String(v.beams).padStart(6)} ${Math.min(...t).toFixed(0).padStart(6)} ${m.toFixed(0).padStart(7)}                    ${Number.isFinite(stdMed) ? ((m / stdMed) * 200).toFixed(0) : '-'}`);
}
