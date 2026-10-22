/**
 * Physics kernel bench (R-CORE): ms CPU (process CPU time) per simulated second and beam-updates/s
 * of the whole engine step, per scene × kernel (js / wasm / simd). Bundled and
 * run by tools/bench-physics.mjs. Each scene is built fresh per kernel (the
 * default kernel is set before construction), warmed up, then timed over
 * `rounds` alternating windows so load drift hits every kernel alike.
 */
import { JS_KERNEL, setDefaultKernel, type KernelFactory } from '../../src/sim/kernel';
import { SIMD_KERNEL, WASM_KERNEL } from '../../src/sim/wasm/kernel';
import { stateHashOf } from './hash';
import { SCENES, type Scene } from './scenes';

declare const process: { argv: string[]; cpuUsage(prev?: { user: number; system: number }): { user: number; system: number } };

/** CPU ms of this process since `t0` (user + system): robust against other processes on a shared box. */
const cpuNow = (): { user: number; system: number } => process.cpuUsage();
const cpuMs = (t0: { user: number; system: number }): number => {
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const seconds = Number(opt('seconds', '1'));
const rounds = Number(opt('rounds', '3'));
const only = opt('scenes', Object.keys(SCENES).join(',')).split(',');
const kernels: KernelFactory[] = [JS_KERNEL, WASM_KERNEL, SIMD_KERNEL].filter((k) => opt('kernels', 'js,wasm,simd').split(',').includes(k.kind));

interface Row {
  scene: string;
  beams: number;
  ms: Record<string, number[]>;
  hash: Record<string, number>;
}

/**
 * Kernel-only: the beam pass over every awake object's beams (no integration, so the state is
 * unchanged apart from force accumulators, which are zeroed each pass) — beam-updates/s of the kernel itself.
 */
function kernelOnly(sc: Scene, passes: number): number {
  const eng = sc.eng;
  const k = eng.kernel;
  const s = eng.state;
  const objs = eng.objects.filter((o) => (o.flags & 1) === 0);
  let beams = 0;
  const t0 = cpuNow();
  for (let p = 0; p < passes; p++) {
    for (const o of objs) {
      k.beams(o.beamStart, o.beamCount, eng.events, false);
      beams += o.beamCount;
    }
    s.frcX.fill(0, 0, s.nodeCount);
    s.frcY.fill(0, 0, s.nodeCount);
    s.frcZ.fill(0, 0, s.nodeCount);
  }
  return beams / cpuMs(t0) / 1000;
}

const rows: Row[] = [];
for (const key of only) {
  const build = SCENES[key];
  if (!build) throw new Error(`unknown scene ${key}`);
  const scenes = new Map<string, Scene>();
  for (const k of kernels) {
    setDefaultKernel(k);
    scenes.set(k.kind, build());
  }
  setDefaultKernel(JS_KERNEL);
  const first = scenes.get(kernels[0]!.kind)!;
  const row: Row = { scene: first.name, beams: first.beams, ms: {}, hash: {} };
  for (const k of kernels) row.ms[k.kind] = [];
  for (let r = 0; r < rounds; r++) {
    for (const k of kernels) {
      const sc = scenes.get(k.kind)!;
      const t0 = cpuNow();
      for (let i = 0; i < seconds * 2000; i++) {
        sc.eng.step();
        if ((i & 1023) === 1023) sc.eng.events.clear();
      }
      row.ms[k.kind]!.push(cpuMs(t0) / seconds);
    }
  }
  for (const k of kernels) row.hash[k.kind] = stateHashOf(scenes.get(k.kind)!.eng);
  const kern: Record<string, number> = {};
  for (const k of kernels) kern[k.kind] = 0;
  for (let r = 0; r < rounds; r++) for (const k of kernels) kern[k.kind] = Math.max(kern[k.kind]!, kernelOnly(scenes.get(k.kind)!, 400));
  (row as Row & { kernelOnly?: Record<string, number> }).kernelOnly = kern;
  rows.push(row);
  const best = (k: string): number => Math.min(...row.ms[k]!);
  const parts = kernels.map((k) => `${k.kind} ${best(k.kind).toFixed(0)} ms/sim-s (${((row.beams * 2000) / best(k.kind) / 1000).toFixed(1)} M beam-upd/s)`);
  const same = new Set(Object.values(row.hash)).size === 1;
  console.log(`${row.scene} [${row.beams} awake beams]: ${parts.join(' | ')} | hashes ${same ? 'identical' : 'DIFFER ' + JSON.stringify(row.hash)}`);
  console.log(`  beam pass alone: ${kernels.map((k) => `${k.kind} ${kern[k.kind]!.toFixed(1)} M/s`).join(' | ')}`);
}
console.log(JSON.stringify(rows));
