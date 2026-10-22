/**
 * R-CORE solver kernel seam. The engine's hot loops (beam forces, node
 * integration) run through a `SimKernel` bound to the engine's SimState:
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
import { integrateNodes } from './integrator';
import { createSimState } from './state';
import type { EventSink, SimState } from './types';
import { applyShell, type ShellRuntime } from './vehicle/shell';

export type KernelKind = 'js' | 'wasm' | 'simd';

/** One kernel bound to one SimState (the WASM kernels own its memory). */
export interface SimKernel {
  readonly kind: KernelKind;
  readonly state: SimState;
  /** applyBeamForces over beams [first, first + count) (events in discovery order). */
  beams(first: number, count: number, events: EventSink, debugStrains: boolean): void;
  /** integrateNodes over nodes [first, first + count). */
  integrate(first: number, count: number, dt: number, gx: number, gy: number, gz: number): void;
  /** applyShell (vehicle/shell.ts) for one cluster runtime. */
  shell(rt: ShellRuntime, dt: number, gx: number, gy: number, gz: number): void;
  /** The cluster runtime is gone (despawn): a WASM kernel frees its block. */
  releaseShell(rt: ShellRuntime): void;
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
      beams: (first, count, events, dbg) => applyBeamForces(state, first, count, events, dbg),
      integrate: (first, count, dt, gx, gy, gz) => integrateNodes(state, first, count, dt, gx, gy, gz),
      shell: (rt, dt, gx, gy, gz) => applyShell(state, rt, dt, gx, gy, gz),
      releaseShell: () => {},
    };
  },
};

let defaultFactory: KernelFactory = JS_KERNEL;

/** The kernel new engines use when EngineConfig.kernel is omitted. */
export function defaultKernel(): KernelFactory {
  return defaultFactory;
}

export function setDefaultKernel(f: KernelFactory): void {
  defaultFactory = f;
}
