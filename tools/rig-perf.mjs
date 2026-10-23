#!/usr/bin/env node
// R-RIG: physics cost per variant (ms of CPU per simulated second, the P6 / U1 method):
// the car on the handling harness's plane (src/sim/vehicle/handling.ts createHandlingSim),
// 0.5 s parked, then a full-throttle launch for SECONDS (the whole step: beams, contacts,
// tyres, drivetrain, shell cluster), after a warm-up run; REPEATS timed runs, min / median.
// Every variant is measured in the same process, interleaved, so a loaded box scales them
// alike: `norm` rescales to the standard sedan's quiet-box 200 ms/sim-s (U1).
//
//   node tools/rig-perf.mjs                               # sedan standard / high / ultra
//   CARS=sedan,coupe TIERS=standard,high KERNELS=js,simd SECONDS=10 REPEATS=3 node tools/rig-perf.mjs
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));

const CARS = (process.env.CARS ?? 'sedan').split(',');
const TIERS = (process.env.TIERS ?? 'standard,high,ultra').split(',');
const SECONDS = Number(process.env.SECONDS ?? 8);
const REPEATS = Number(process.env.REPEATS ?? 3);
// one module graph (rig-modules.ts): the kernel / solver set here are the ones the harness's engines use
const M = (await runnerImport(resolve(HERE, 'rig-modules.ts'))).module;
const { handling, builder, hdSim: hd } = M;
const engineMod = M.engine;
const kernelMod = M.kernel;
const wasmMod = M.wasm;
// KERNELS=js,simd: each variant is measured on each R-CORE kernel (bit-identical results, different speed)
const KERNELS = (process.env.KERNELS ?? 'js').split(',');
const kernelOf = (k) => (k === 'js' ? kernelMod.JS_KERNEL : wasmMod.wasmKernelOf(k));
const { SOLVER_PRESETS } = M.messages;

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
function drive(def, seconds, tier = 'standard') {
  // the tier's solver preset (R-CORE: high = node-vs-triangle contact, ultra + self-collision), as played
  engineMod.setDefaultSolver(SOLVER_PRESETS[tier]);
  const sim = handling.createHandlingSim({ def });
  sim.eng.setInput(1, { gearSelect: 1, throttle: 0, brake: 0, steer: 0, handbrake: 0 });
  handling.stepN(sim, 1000);
  sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 0, steer: 0, handbrake: 0 });
  const c0 = cpu();
  handling.stepN(sim, Math.round(seconds * 2000));
  return (cpu() - c0) / seconds;
}
const runs = variants.flatMap((v) => KERNELS.map((k) => ({ ...v, kernel: k })));
const driveOn = (r, seconds) => {
  kernelMod.setDefaultKernel(kernelOf(r.kernel) ?? kernelMod.JS_KERNEL);
  return drive(r.def, seconds, r.tier);
};
for (const r of runs) driveOn(r, 1); // warm-up (JIT / WASM compile)
const times = new Map(runs.map((r) => [r, []]));
for (let k = 0; k < REPEATS; k++) for (const r of runs) times.get(r).push(driveOn(r, SECONDS));
const std = runs.find((r) => r.car === 'sedan' && r.tier === 'standard' && r.kernel === KERNELS[0]);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const stdMed = std ? med(times.get(std)) : NaN;
console.log(`variant              kernel nodes  beams   min    median  (ms CPU / sim-s)  norm (sedan std on ${KERNELS[0]} = 200)`);
for (const r of runs) {
  const t = times.get(r);
  const m = med(t);
  console.log(`${`${r.car}.${r.tier}`.padEnd(20)} ${r.kernel.padEnd(6)} ${String(r.nodes).padStart(5)} ${String(r.beams).padStart(6)} ${Math.min(...t).toFixed(0).padStart(6)} ${m.toFixed(0).padStart(7)}                    ${Number.isFinite(stdMed) ? ((m / stdMed) * 200).toFixed(0) : '-'}`);
}
