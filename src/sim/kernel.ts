/**
 * R-CORE solver kernel seam. The engine's hot loops (beam forces, node
 * integration, shell clusters, ground contact) run through a `SimKernel` bound to the engine's SimState:
 *   'js'     src/sim/beams.ts + integrator.ts (reference, always available)
 *   'wasm'   src/sim/wasm/kernel.c built without SIMD
 *   'simd'   the same with f64x2 lanes (wasm simd128)
 * All three are BIT-IDENTICAL (kernel.c header; `kernelParity.test.ts`), so
 * replays, state hashes and every tuned result are independent of the kernel.
 *
 * Worker-only. The WASM factories live in src/sim/wasm/kernel.ts, which the
 * worker imports lazily and installs as the default (`setDefaultKernel`);
 * code that never installs one (tools, most tests) gets the JS kernel unless
 * the vitest setup installs WASM (CRUMPLE_KERNEL, see vitest.setup.ts).
 */
import { applyBeamForces } from './beams';
import { applyGroundContacts } from './collision/ground';
import { integrateNodes } from './integrator';
import { createSimState } from './state';
import type { EventSink, HeightSampler, MaterialTable, SimState } from './types';
import type { WheelRuntime } from './vehicle/types';
import { applyShell, type ShellRuntime } from './vehicle/shell';

export type KernelKind = 'js' | 'wasm' | 'simd';

/** One kernel bound to one SimState (the WASM kernels own its memory). */
export interface SimKernel {
  readonly kind: KernelKind;
  readonly state: SimState;
  /** applyBeamForces over beams [first, first + count) (events in discovery order; crashArmed: R-CRASH crush unloading). */
  beams(first: number, count: number, events: EventSink, debugStrains: boolean, crashArmed?: boolean): void;
  /** integrateNodes over nodes [first, first + count). */
  integrate(first: number, count: number, dt: number, gx: number, gy: number, gz: number): void;
  /** applyShell (vehicle/shell.ts) for one cluster runtime. */
  shell(rt: ShellRuntime, dt: number, gx: number, gy: number, gz: number): void;
  /** applyGroundContacts (collision/ground.ts) over nodes [first, first + count) of one object. */
  ground(first: number, count: number, sampler: HeightSampler, materials: MaterialTable, dt: number, objectId: number, events: EventSink, gx: number, gy: number, gz: number): void;
  /** Vehicle body passes (absent on the JS kernel: the TS runs). */
  readonly body?: BodyKernel;
  /** Wheel node loops (absent on the JS kernel). */
  readonly wheels?: WheelKernel;
  /** Start of an engine step (per-tick caches). */
  beginTick?(): void;
  /** The vehicle is gone (despawn): a WASM kernel frees its wheel blocks. */
  releaseWheels?(wheels: readonly WheelRuntime[]): void;
  /** The cluster runtime is gone (despawn): a WASM kernel frees its block. */
  releaseShell(rt: ShellRuntime): void;
}

/**
 * Whole-body node passes of the vehicle pre-step (R-PHYS's runtime.ts applyAero /
 * applyDriveReaction; the TS stays the reference). WASM kernels only.
 */
export interface BodyKernel {
  /** Σ (1/im)·v over nodes [start, end) with im ≠ 0, in node order → out[0..2]. */
  momentum(start: number, end: number, out: Float64Array): void;
  /** frc += a·(1/im) over nodes [start, end) with im ≠ 0. */
  accel(start: number, end: number, ax: number, ay: number, az: number): void;
  /** applyDriveReaction's three body passes for the unit couple axis u and |T| = tl. */
  driveReaction(start: number, end: number, ux: number, uy: number, uz: number, tl: number): void;
}

/**
 * R-PHYS's per-wheel node loops (wheels.ts; the TS stays the reference). WASM
 * kernels only. Every method returns false when the kernel cannot run it (an
 * unmirrored ground, no valid sample cache): wheels.ts then runs the TS.
 */
export interface WheelKernel {
  /** estimateWheelOmega against the registered ground (null = none). */
  omega(w: WheelRuntime, sampler: HeightSampler | null, materials: MaterialTable, dt: number): boolean;
  /** applyAxleTorque (tau ≠ 0). */
  axleTorque(w: WheelRuntime, tau: number): boolean;
  /** applyUprightReaction (tau ≠ 0). */
  uprightReaction(w: WheelRuntime, tau: number): boolean;
  /** applyTreadBrush incl. the rim torque (brushK > 0), after this pre-step's omega. */
  treadBrush(w: WheelRuntime, sampler: HeightSampler | null, dt: number): boolean;
  /** applyHoopTension. */
  hoop(w: WheelRuntime): boolean;
}

export interface KernelFactory {
  readonly kind: KernelKind;
  create(nodeCapacity: number, beamCapacity: number): SimKernel;
}

export const JS_KERNEL: KernelFactory = {
  kind: 'js',
  create(nodeCapacity, beamCapacity) {
    const state = createSimState(nodeCapacity, beamCapacity);
    return {
      kind: 'js',
      state,
      beams: (first, count, events, dbg, armed) => applyBeamForces(state, first, count, events, dbg, armed ?? false),
      integrate: (first, count, dt, gx, gy, gz) => integrateNodes(state, first, count, dt, gx, gy, gz),
      shell: (rt, dt, gx, gy, gz) => applyShell(state, rt, dt, gx, gy, gz),
      ground: (first, count, sampler, materials, dt, objectId, events, gx, gy, gz) =>
        applyGroundContacts(state, first, count, sampler, materials, dt, objectId, events, gx, gy, gz),
      releaseShell: () => {},
    };
  },
};

let defaultFactory: KernelFactory = JS_KERNEL;

/**
 * The kernel of the engine that is stepping (SimEngine.step sets it): code that
 * only receives a SimState (the vehicle pre-step) finds its kernel here. Only
 * returned for that kernel's own state, so direct calls on another state run TS.
 */
let activeKernel: SimKernel | null = null;
export function setActiveKernel(k: SimKernel | null): void {
  activeKernel = k;
}
export function activeKernelFor(state: SimState): SimKernel | null {
  const k = activeKernel;
  return k !== null && k.state === state ? k : null;
}

/** The kernel new engines use when EngineConfig.kernel is omitted. */
export function defaultKernel(): KernelFactory {
  return defaultFactory;
}

export function setDefaultKernel(f: KernelFactory): void {
  defaultFactory = f;
}

/**
 * Boot kernel bench (R-CORE physics-quality 'auto'): million beam-updates per
 * second of `f`'s beam pass on a synthetic 600-node / 3000-beam lattice (car-like
 * spacing and stiffness, every beam within its plastic limit), timed for about
 * `budgetMs` after a warm-up. One core, wall clock; deterministic setup.
 */
export function benchKernel(f: KernelFactory, budgetMs = 60): number {
  const N = 600;
  const M = 3000;
  const k = f.create(N, M);
  const s = k.state;
  s.nodeCount = N;
  s.beamCount = M;
  let seed = 0x2545f491;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < N; i++) {
    s.posX[i] = (i % 10) * 0.25 + 0.05 * rnd();
    s.posY[i] = (Math.floor(i / 10) % 6) * 0.25 + 0.05 * rnd();
    s.posZ[i] = Math.floor(i / 60) * 0.25 + 0.05 * rnd();
    s.velX[i] = rnd() - 0.5;
    s.invMass[i] = 1 / (2 + 8 * rnd());
  }
  for (let b = 0; b < M; b++) {
    const a = Math.floor(rnd() * N);
    let c = a + 1 + Math.floor(rnd() * 70);
    if (c >= N) c = a - 1 - Math.floor(rnd() * 70);
    if (c < 0) c = (a + 1) % N;
    const dx = s.posX[c]! - s.posX[a]!, dy = s.posY[c]! - s.posY[a]!, dz = s.posZ[c]! - s.posZ[a]!;
    s.aIdx[b] = a;
    s.bIdx[b] = c;
    s.k[b] = s.k0[b] = 2e5;
    s.d[b] = 400;
    s.restLen[b] = s.restLen0[b] = Math.sqrt(dx * dx + dy * dy + dz * dz) * (0.99 + 0.02 * rnd());
    s.deform[b] = Infinity;
    s.breakF[b] = Infinity;
    s.active[b] = 1;
  }
  const sink: EventSink = { impact() {}, beamBreak() {}, skid() {} };
  // Short windows, best one wins: the first runs execute baseline code (V8 Liftoff for wasm, the
  // interpreter for JS) until the optimizing tier lands in the background; a busy page steals slices.
  const window = budgetMs / 4;
  let best = 0;
  const start = performance.now();
  while (performance.now() - start < 4 * budgetMs) {
    let passes = 0;
    const t0 = performance.now();
    let t = t0;
    while (t - t0 < window) {
      for (let r = 0; r < 10; r++) k.beams(0, M, sink, false);
      passes += 10;
      t = performance.now();
    }
    const rate = (passes * M) / ((t - t0) * 1000);
    if (rate > best) best = rate;
  }
  return best;
}
