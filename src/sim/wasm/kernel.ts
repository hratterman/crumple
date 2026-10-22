/**
 * WASM kernel factories (R-CORE). Imported LAZILY by the worker (its own
 * chunk with the base64 binaries) and synchronously by tests / tools.
 *
 * Each engine gets its own WebAssembly.Memory sized for its capacity at
 * creation (never grown, so the typed-array views of SimState never detach):
 * [0, KERNEL_RESERVED) stack + kernel statics, then the SimState arrays
 * (16-byte aligned, order of createSimState) and the break list.
 */
import { BOUND_STIFFNESS_RAMP, PLASTIC_COMPRESS_FLOOR, PLASTIC_K_FLOOR, PLASTIC_RATCHET, PLASTIC_REVERSE_FACTOR, PLASTIC_WEAKEN, BEAM_MIN_DIST } from '../beams';
import type { KernelFactory, KernelKind, SimKernel } from '../kernel';
import { createSimState, simStateBytes, type StateAllocator } from '../state';
import type { EventSink, SimState } from '../types';
import { applyShell, shellRecaptureCheck, type ShellRuntime } from '../vehicle/shell';
import { CONTACT_RELEASE } from '../vehicle/shellDefs';
import { KERNEL_SCALAR_WASM, KERNEL_SIMD_WASM } from './binary';

/** Bytes below the SimState arrays (stack-first layout: 64 KiB stack, then statics). */
const KERNEL_RESERVED = 1 << 20;
const PAGE = 65536;

interface KernelExports {
  ptr_table(): number;
  bind_state(): void;
  set_params(boundRamp: number, ratchet: number, compressFloor: number, weaken: number, reverse: number, kFloor: number, minDist: number): void;
  beams(first: number, count: number, dbg: number): number;
  integrate(first: number, count: number, dt: number, gx: number, gy: number, gz: number): void;
  shell(header: number, dt: number, gx: number, gy: number, gz: number): number;
  __heap_base: WebAssembly.Global;
}

/** Shell header slots (kernel.c SH_*). */
const SH = {
  N: 0, NTIERS: 1, NODES: 2, W: 3, MASS: 4, REST: 5, VS: 6, TIER: 7, GONE: 8, RELEASE: 9, WHOLE: 10, YIELDS: 11,
  TRIPPED: 12, R: 13, K: 14, CD: 15, CONTACT_RELEASE: 16,
  RELEASED_INC: 17, NEW_RELEASE: 18, MAX_DEV2: 19, MAX_REL2: 20, SUM_REL2: 21, NREL: 22, CX: 23, CY: 24, CZ: 25,
  HEADER: 26,
} as const;

/**
 * First-fit free-list heap over a fixed byte range of the kernel memory (per-runtime
 * blocks such as shell clusters). 16-byte granularity; frees coalesce. Offsets never
 * influence results (determinism is unaffected by where a block lands).
 */
class AuxHeap {
  /** Free ranges [offset, size] sorted by offset. */
  private readonly free: number[][];
  constructor(base: number, size: number) {
    this.free = [[base, size]];
  }
  alloc(bytes: number): number {
    const need = (bytes + 15) & ~15;
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i]!;
      if (f[1]! >= need) {
        const at = f[0]!;
        f[0] = at + need;
        f[1] = f[1]! - need;
        if (f[1] === 0) this.free.splice(i, 1);
        return at;
      }
    }
    return -1;
  }
  release(at: number, bytes: number): void {
    const size = (bytes + 15) & ~15;
    let i = 0;
    while (i < this.free.length && this.free[i]![0]! < at) i++;
    this.free.splice(i, 0, [at, size]);
    // Coalesce with the next, then the previous range.
    const cur = this.free[i]!;
    const next = this.free[i + 1];
    if (next && cur[0]! + cur[1]! === next[0]) {
      cur[1] = cur[1]! + next[1]!;
      this.free.splice(i + 1, 1);
    }
    const prev = this.free[i - 1];
    if (prev && prev[0]! + prev[1]! === cur[0]) {
      prev[1] = prev[1]! + cur[1]!;
      this.free.splice(i, 1);
    }
  }
}

interface ShellBlock {
  at: number;
  bytes: number;
  header: Float64Array;
}

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when this runtime validates wasm simd128 (a tiny module using v128). */
export function simdSupported(): boolean {
  if (typeof WebAssembly !== 'object') return false;
  // (module (func (result v128) i32.const 0 i32x4.splat))
  const probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 17, 11]);
  try {
    return WebAssembly.validate(probe);
  } catch {
    return false;
  }
}

export function wasmSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function';
}

const modules: Partial<Record<'wasm' | 'simd', WebAssembly.Module>> = {};

function moduleFor(kind: 'wasm' | 'simd'): WebAssembly.Module {
  let m = modules[kind];
  if (!m) {
    m = new WebAssembly.Module(decode(kind === 'simd' ? KERNEL_SIMD_WASM : KERNEL_SCALAR_WASM));
    modules[kind] = m;
  }
  return m;
}

/** Number of u32 entries in kernel.c's pointer table (enum order below). */
const STATE_PTRS = 27;

function createWasmKernel(kind: 'wasm' | 'simd', nodeCapacity: number, beamCapacity: number): SimKernel {
  const auxBytes = 96 * nodeCapacity + (256 << 10);
  const bytes = KERNEL_RESERVED + simStateBytes(nodeCapacity, beamCapacity) + 4 * beamCapacity + 64 + auxBytes;
  const pages = Math.ceil(bytes / PAGE);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const inst = new WebAssembly.Instance(moduleFor(kind), { env: { memory } });
  const ex = inst.exports as unknown as KernelExports;
  const heapBase = ex.__heap_base.value as number;
  if (heapBase > KERNEL_RESERVED) throw new Error(`wasm kernel statics (${heapBase} B) exceed the reserved ${KERNEL_RESERVED} B`);
  const buf = memory.buffer;
  let off = KERNEL_RESERVED;
  const take = (bytesPer: number, n: number): number => {
    const at = off;
    off += (bytesPer * n + 15) & ~15;
    return at;
  };
  const alloc: StateAllocator = {
    f64: (n) => new Float64Array(buf, take(8, n), n),
    f32: (n) => new Float32Array(buf, take(4, n), n),
    i32: (n) => new Int32Array(buf, take(4, n), n),
    u8: (n) => new Uint8Array(buf, take(1, n), n),
  };
  const state: SimState = createSimState(nodeCapacity, beamCapacity, alloc);
  const breakList = alloc.i32(beamCapacity);
  const aux = new AuxHeap(off, bytes - off);
  const table = new Uint32Array(buf, ex.ptr_table(), STATE_PTRS);
  const ptrs = [
    state.posX, state.posY, state.posZ, state.velX, state.velY, state.velZ, state.frcX, state.frcY, state.frcZ, state.invMass,
    state.aIdx, state.bIdx, state.k, state.d, state.restLen, state.restLen0, state.k0, state.deform, state.breakF,
    state.boundsLow, state.boundsHigh, state.preload, state.type, state.active, state.strainOut, breakList,
    state.flags,
  ];
  if (ptrs.length !== STATE_PTRS) throw new Error('kernel pointer table mismatch');
  for (let i = 0; i < ptrs.length; i++) table[i] = ptrs[i]!.byteOffset;
  ex.bind_state();
  ex.set_params(BOUND_STIFFNESS_RAMP, PLASTIC_RATCHET, PLASTIC_COMPRESS_FLOOR, PLASTIC_WEAKEN, PLASTIC_REVERSE_FACTOR, PLASTIC_K_FLOOR, BEAM_MIN_DIST);
  const wBeams = ex.beams;
  const wIntegrate = ex.integrate;
  const wShell = ex.shell;

  // Shell clusters: each runtime's arrays move into a block of the aux heap (re-pointed views: JS
  // reset / recapture / diagnostics and the kernel share them). A full heap leaves the runtime in JS
  // (applyShell is bit-identical), so nothing can fail here.
  const shellBlocks = new WeakMap<ShellRuntime, ShellBlock | null>();
  const adoptShell = (rt: ShellRuntime): ShellBlock | null => {
    const n = rt.nodes.length;
    const sh = rt.shell;
    const T = sh.whole.length;
    const al = (b: number): number => (b + 15) & ~15;
    const total = al(8 * SH.HEADER) + al(4 * n) + 2 * al(8 * n) + 2 * al(24 * n) + 2 * al(n) + al(32 * T) + 3 * al(T) + al(72);
    const at = aux.alloc(total);
    if (at < 0) {
      shellBlocks.set(rt, null);
      return null;
    }
    let p = at;
    const put = (bytesPer: number, count: number): number => {
      const q = p;
      p += al(bytesPer * count);
      return q;
    };
    const header = new Float64Array(buf, put(8, SH.HEADER), SH.HEADER);
    const move = <T extends Float64Array | Int32Array | Uint8Array>(src: T, ctor: new (b: ArrayBuffer, o: number, n: number) => T): T => {
      const v = new ctor(buf, put(src.BYTES_PER_ELEMENT, src.length), src.length);
      v.set(src as never);
      return v;
    };
    rt.nodes = move(rt.nodes, Int32Array);
    rt.w = move(rt.w, Float64Array);
    rt.mass = move(rt.mass, Float64Array);
    rt.rest = move(rt.rest, Float64Array);
    rt.vs = move(rt.vs, Float64Array);
    const tier = move(sh.tier, Uint8Array);
    rt.gone = move(rt.gone, Uint8Array);
    const release = move(sh.release, Float64Array);
    const whole = move(sh.whole, Uint8Array);
    const yields = move(sh.yields, Uint8Array);
    rt.tripped = move(rt.tripped, Uint8Array);
    rt.R = move(rt.R, Float64Array);
    header[SH.N] = n;
    header[SH.NTIERS] = T;
    header[SH.NODES] = rt.nodes.byteOffset;
    header[SH.W] = rt.w.byteOffset;
    header[SH.MASS] = rt.mass.byteOffset;
    header[SH.REST] = rt.rest.byteOffset;
    header[SH.VS] = rt.vs.byteOffset;
    header[SH.TIER] = tier.byteOffset;
    header[SH.GONE] = rt.gone.byteOffset;
    header[SH.RELEASE] = release.byteOffset;
    header[SH.WHOLE] = whole.byteOffset;
    header[SH.YIELDS] = yields.byteOffset;
    header[SH.TRIPPED] = rt.tripped.byteOffset;
    header[SH.R] = rt.R.byteOffset;
    header[SH.K] = sh.k;
    header[SH.CD] = sh.cd;
    header[SH.CONTACT_RELEASE] = CONTACT_RELEASE;
    const block: ShellBlock = { at, bytes: total, header };
    shellBlocks.set(rt, block);
    return block;
  };
  const { posX, posY, posZ } = state;
  return {
    kind,
    state,
    beams(first: number, count: number, events: EventSink, dbg: boolean): void {
      const n = wBeams(first, count, dbg ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const b = breakList[i]!;
        const ia = state.aIdx[b]!;
        const ib = state.bIdx[b]!;
        events.beamBreak(b, (posX[ia]! + posX[ib]!) * 0.5, (posY[ia]! + posY[ib]!) * 0.5, (posZ[ia]! + posZ[ib]!) * 0.5);
      }
    },
    integrate(first: number, count: number, dt: number, gx: number, gy: number, gz: number): void {
      wIntegrate(first, count, dt, gx, gy, gz);
    },
    shell(rt: ShellRuntime, dt: number, gx: number, gy: number, gz: number): void {
      let block = shellBlocks.get(rt);
      if (block === undefined) block = adoptShell(rt);
      if (block === null) {
        applyShell(state, rt, dt, gx, gy, gz);
        return;
      }
      const H = block.header;
      if (wShell(H.byteOffset, dt, gx, gy, gz) === 0) return;
      rt.released += H[SH.RELEASED_INC]!;
      rt.maxDev = Math.sqrt(H[SH.MAX_DEV2]!);
      shellRecaptureCheck(state, rt, dt, H[SH.NEW_RELEASE] !== 0, H[SH.MAX_REL2]!, H[SH.SUM_REL2]!, H[SH.NREL]!, H[SH.CX]!, H[SH.CY]!, H[SH.CZ]!);
    },
    releaseShell(rt: ShellRuntime): void {
      const block = shellBlocks.get(rt);
      shellBlocks.delete(rt);
      if (!block) return;
      // Hand the runtime JS-owned copies (a released runtime may still be inspected).
      rt.nodes = rt.nodes.slice();
      rt.w = rt.w.slice();
      rt.mass = rt.mass.slice();
      rt.rest = rt.rest.slice();
      rt.vs = rt.vs.slice();
      rt.gone = rt.gone.slice();
      rt.tripped = rt.tripped.slice();
      rt.R = rt.R.slice();
      aux.release(block.at, block.bytes);
    },
  };
}

function factory(kind: 'wasm' | 'simd'): KernelFactory {
  return { kind, create: (n, m) => createWasmKernel(kind, n, m) };
}

export const WASM_KERNEL: KernelFactory = factory('wasm');
export const SIMD_KERNEL: KernelFactory = factory('simd');

/** The best kernel this runtime supports (compiles it now): simd → wasm → null (use JS). */
export function bestWasmKernel(): KernelFactory | null {
  try {
    if (wasmSupported() && simdSupported()) {
      moduleFor('simd');
      return SIMD_KERNEL;
    }
    if (wasmSupported()) {
      moduleFor('wasm');
      return WASM_KERNEL;
    }
  } catch {
    // CSP without wasm-unsafe-eval, or a validation failure: stay on JS.
  }
  return null;
}

export function wasmKernelOf(kind: KernelKind): KernelFactory | null {
  return kind === 'simd' ? SIMD_KERNEL : kind === 'wasm' ? WASM_KERNEL : null;
}
