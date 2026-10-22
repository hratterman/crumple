/**
 * WASM kernel factories (R-CORE). Imported LAZILY by the worker (its own
 * chunk with the base64 binaries) and synchronously by tests / tools.
 *
 * Each engine gets its own WebAssembly.Memory sized for its capacity at
 * creation (never grown, so the typed-array views of SimState never detach):
 * [0, KERNEL_RESERVED) stack + kernel statics, then the SimState arrays
 * (16-byte aligned, order of createSimState) and the break list.
 */
import {
  BOUND_STIFFNESS_RAMP,
  PLASTIC_COMPRESS_FLOOR,
  PLASTIC_K_FLOOR,
  PLASTIC_RATCHET,
  PLASTIC_REVERSE_FACTOR,
  PLASTIC_WEAKEN,
  BEAM_MIN_DIST,
  CRUSH_HELD_HOLD,
  CRUSH_HYST_DT,
  CRUSH_RELAX_KEEP,
  CRUSH_RELAX_KEEP_CRUMPLE,
  CRUSH_UNLOAD_HOLD,
} from '../beams';
import {
  adoptGroundCooldowns,
  applyGroundContacts,
  CONTACT_ZETA,
  IMPACT_MIN_IMPULSE,
  isMirroredSampler,
  KC_MAX,
  KC_STABILITY,
  PlaneSampler,
  SKID_COOLDOWN_STEPS,
  SKID_MIN_LOAD,
  SKID_MIN_SLIP,
  SLOPE_SKIP,
  SOFT_LAYER_ZETA,
} from '../collision/ground';
import type { BodyKernel, KernelFactory, KernelKind, SimKernel, WheelKernel } from '../kernel';
import type { WheelRuntime } from '../vehicle/types';
import { WHEEL_KERNEL_PARAMS } from '../vehicle/wheels';
import { createSimState, simStateBytes, type StateAllocator } from '../state';
import type { EventSink, HeightSampler, MaterialTable, SimState } from '../types';
import type { HeightfieldSampler } from '../../world/sampler';
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
  set_crash_params(hystDt: number, relaxKeep: number, relaxKeepCrumple: number, unloadHold: number, heldHold: number): void;
  beams(first: number, count: number, dbg: number, armed: number): number;
  integrate(first: number, count: number, dt: number, gx: number, gy: number, gz: number): void;
  shell(header: number, dt: number, gx: number, gy: number, gz: number): number;
  set_ground_params(kcMax: number, kcStab: number, zeta: number, softZeta: number, slopeSkip: number, impactMin: number, skidSlip: number, skidLoad: number, skidCooldown: number): void;
  set_ground(header: number): void;
  ground(first: number, count: number, dt: number, gx: number, gy: number, gz: number): number;
  ground_sample(x: number, z: number, out: number): number;
  body_momentum(start: number, end: number, out: number): void;
  body_accel(start: number, end: number, ax: number, ay: number, az: number): void;
  drive_reaction(start: number, end: number, ux: number, uy: number, uz: number, tl: number): void;
  set_wheel_params(slipMin: number, inv2pi: number, inv4pi: number, rollAlpha: number, treadDamp: number, attachMin: number, deadzone: number, shareV0: number, hoopMax: number): void;
  wheel_omega(header: number, ground: number, dt: number): number;
  wheel_axle(header: number, tau: number): void;
  wheel_upright(header: number, tau: number, si: number): void;
  wheel_brush(header: number, ground: number, dt: number, slipRatio: number, latMu: number): void;
  wheel_hoop(header: number): void;
  __heap_base: WebAssembly.Global;
}

/** Shell header slots (kernel.c SH_*). */
const SH = {
  N: 0, NTIERS: 1, NODES: 2, W: 3, MASS: 4, REST: 5, VS: 6, TIER: 7, GONE: 8, RELEASE: 9, WHOLE: 10, YIELDS: 11,
  TRIPPED: 12, R: 13, K: 14, CD: 15, CONTACT_RELEASE: 16,
  RELEASED_INC: 17, NEW_RELEASE: 18, MAX_DEV2: 19, MAX_REL2: 20, SUM_REL2: 21, NREL: 22, CX: 23, CY: 24, CZ: 25,
  HEADER: 26,
} as const;

/** Ground header slots (kernel.c G_*). */
const G = {
  KIND: 0, PLANE_Y: 1, PLANE_MAT: 2,
  OX: 3, OZ: 4, NOX: 5, NOZ: 6, INVS: 7, MAXU: 8, MAXV: 9, NMAXU: 10, NMAXV: 11, COLS: 12, LASTU: 13, LASTV: 14,
  HTILES: 15, HTX: 16, NTILES: 17, NTX: 18, MTILES: 19, MTX: 20,
  MATF: 21, COOLDOWN: 22, EVENTS: 23, EV_CAP: 24,
  CSTAMP: 25, CREF: 26, STAMP: 27,
  EV_COUNT: 28, MISS_GRID: 29, MISS_TILE: 30,
  HEADER: 31,
} as const;
/** Ground events buffered per kernel call (9 f64 each). */
const GROUND_EV_CAP = 256;
/** Heightfield tile edge in cells (kernel.c TILE) and samples per edge with the apron. */
const TILE = 32;
const TILE_S = 33;
/** Resident tiles per grid (heights / normals / material), FIFO-recycled. */
const TILE_POOL = 128;
const TERRAIN_POOL_BYTES = TILE_POOL * (4 * TILE_S * TILE_S + 12 * TILE_S * TILE_S + TILE * TILE);
/** Kernel-memory region for the terrain tile cache: the pools plus the three tile tables. */
const TERRAIN_BYTES = TERRAIN_POOL_BYTES + (512 << 10);

/** Wheel header slots (kernel.c W_*). */
const W = {
  HUBI: 0, HUBO: 1, RIM: 2, TIRE: 3, N: 4, RAYS: 5, SPIN: 6, TRR: 7, RIMR: 8, RIMHOOP: 9, TREADHOOP: 10, BRUSHK: 11, BRUSHC: 12,
  NLINK: 13, LINKS: 14, NATT: 15, ATT: 16, NREACT: 17, REACT: 18, TLOAD: 19, TNRM: 20, TBRUSH: 21, SAMP: 22,
  OMEGA: 23, ROLLR: 24, DETACHED: 25, LOAD: 26, CONTACT: 27, SLIPSPEED: 28, SLIPRATIO: 29, CACHE: 30,
  HEADER: 31,
} as const;

interface WheelBlock {
  at: number;
  bytes: number;
  H: Float64Array;
}

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
const STATE_PTRS = 38;

function createWasmKernel(kind: 'wasm' | 'simd', nodeCapacity: number, beamCapacity: number): WasmSimKernel {
  const auxBytes = 96 * nodeCapacity + (256 << 10);
  const groundBytes = 8 * G.HEADER + 8 * 256 + 9 * nodeCapacity + 72 * GROUND_EV_CAP + 192 + TERRAIN_BYTES;
  const bytes = KERNEL_RESERVED + simStateBytes(nodeCapacity, beamCapacity) + 4 * beamCapacity + 64 + groundBytes + auxBytes;
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
  const gH = alloc.f64(G.HEADER);
  const gMatF = alloc.f64(256);
  const gCooldown = alloc.u8(nodeCapacity);
  const gCStamp = alloc.i32(nodeCapacity);
  const gCRef = alloc.i32(nodeCapacity);
  const gEvents = alloc.f64(9 * GROUND_EV_CAP);
  const sampleOut = alloc.f64(5);
  const bodyOut = alloc.f64(3);
  const terrainBase = take(1, TERRAIN_BYTES);
  adoptGroundCooldowns(state, gCooldown);
  const aux = new AuxHeap(off, bytes - off);
  const table = new Uint32Array(buf, ex.ptr_table(), STATE_PTRS);
  const ptrs = [
    state.posX, state.posY, state.posZ, state.velX, state.velY, state.velZ, state.frcX, state.frcY, state.frcZ, state.invMass,
    state.aIdx, state.bIdx, state.k, state.d, state.restLen, state.restLen0, state.k0, state.deform, state.breakF,
    state.boundsLow, state.boundsHigh, state.preload, state.type, state.active, state.strainOut, breakList,
    state.flags,
    state.unloadGain, state.unloadTrig, state.crushHold, state.hystOff,
    state.radius, state.friction, state.contactK, state.treadAxX, state.treadAxY, state.treadAxZ, state.treadF,
  ];
  if (ptrs.length !== STATE_PTRS) throw new Error('kernel pointer table mismatch');
  for (let i = 0; i < ptrs.length; i++) table[i] = ptrs[i]!.byteOffset;
  ex.bind_state();
  ex.set_params(BOUND_STIFFNESS_RAMP, PLASTIC_RATCHET, PLASTIC_COMPRESS_FLOOR, PLASTIC_WEAKEN, PLASTIC_REVERSE_FACTOR, PLASTIC_K_FLOOR, BEAM_MIN_DIST);
  ex.set_crash_params(CRUSH_HYST_DT, CRUSH_RELAX_KEEP, CRUSH_RELAX_KEEP_CRUMPLE, CRUSH_UNLOAD_HOLD, CRUSH_HELD_HOLD);
  ex.set_ground_params(KC_MAX, KC_STABILITY, CONTACT_ZETA, SOFT_LAYER_ZETA, SLOPE_SKIP, IMPACT_MIN_IMPULSE, SKID_MIN_SLIP, SKID_MIN_LOAD, SKID_COOLDOWN_STEPS);
  gH[G.MATF] = gMatF.byteOffset;
  gH[G.COOLDOWN] = gCooldown.byteOffset;
  gH[G.EVENTS] = gEvents.byteOffset;
  gH[G.EV_CAP] = GROUND_EV_CAP;
  gH[G.CSTAMP] = gCStamp.byteOffset;
  gH[G.CREF] = gCRef.byteOffset;
  gH[G.STAMP] = 1;
  ex.set_ground(gH.byteOffset);
  const wGround = ex.ground;
  const terrain = new TerrainCache(buf, terrainBase, TERRAIN_BYTES, gH);
  /** The sampler the header describes (null: none yet / unsupported → JS kernel). */
  let gSampler: HeightSampler | null = null;
  let gMirrored = false;
  const groundJs = (first: number, count: number, sampler: HeightSampler, materials: MaterialTable, dt: number, objectId: number, events: EventSink, gx: number, gy: number, gz: number): void =>
    applyGroundContacts(state, first, count, sampler, materials, dt, objectId, events, gx, gy, gz);
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
  const wMomentum = ex.body_momentum;
  const wAccel = ex.body_accel;
  const wDrive = ex.drive_reaction;
  const bodyAt = bodyOut.byteOffset;
  const body: BodyKernel = {
    momentum(start: number, end: number, out: Float64Array): void {
      wMomentum(start, end, bodyAt);
      out[0] = bodyOut[0]!;
      out[1] = bodyOut[1]!;
      out[2] = bodyOut[2]!;
    },
    accel: (start, end, ax, ay, az) => wAccel(start, end, ax, ay, az),
    driveReaction: (start, end, ux, uy, uz, tl) => wDrive(start, end, ux, uy, uz, tl),
  };
  const wp = WHEEL_KERNEL_PARAMS;
  ex.set_wheel_params(wp.slipRatioMinSpeed, wp.inv2pi, wp.inv4pi, wp.rollRadiusAlpha, wp.treadNodeDamp, wp.attachMinHeight, wp.brushSlipDeadzone, wp.brushShareV0, wp.hoopOmegaMax);
  const wOmega = ex.wheel_omega;
  const wAxle = ex.wheel_axle;
  const wUpright = ex.wheel_upright;
  const wBrush = ex.wheel_brush;
  const wHoop = ex.wheel_hoop;
  // Wheels: each runtime's tread / index arrays move into a block of the aux heap (re-pointed views:
  // rebase / reset / telemetry write and read them in place). A full heap leaves the wheel on TS.
  const wheelBlocks = new WeakMap<WheelRuntime, WheelBlock | null>();
  const adoptWheel = (w: WheelRuntime): WheelBlock | null => {
    const n = w.ringCount;
    const cw = w.wheel;
    if (w.treadLoad.length < n || w.treadNormal.length < 3 * n || w.treadBrush.length < 3 * n || 2 * cw.rays > n + n) {
      wheelBlocks.set(w, null);
      return null;
    }
    const react = w.reactNodes ?? new Int32Array(0);
    const al = (b: number): number => (b + 15) & ~15;
    const total =
      al(8 * W.HEADER) + al(4 * w.hubLinkBeams.length) + al(4 * w.attachNodes.length) + al(4 * react.length) +
      al(8 * w.treadLoad.length) + al(8 * w.treadNormal.length) + al(8 * w.treadBrush.length) + al(48 * n);
    const at = aux.alloc(total);
    if (at < 0) {
      wheelBlocks.set(w, null);
      return null;
    }
    let p = at;
    const put = (bytes: number): number => {
      const q = p;
      p += al(bytes);
      return q;
    };
    const H = new Float64Array(buf, put(8 * W.HEADER), W.HEADER);
    const move = <T extends Float64Array | Int32Array>(src: T, ctor: new (b: ArrayBuffer, o: number, n: number) => T): T => {
      const v = new ctor(buf, put(src.BYTES_PER_ELEMENT * src.length), src.length);
      v.set(src as never);
      return v;
    };
    w.hubLinkBeams = move(w.hubLinkBeams, Int32Array);
    w.attachNodes = move(w.attachNodes, Int32Array);
    const reactV = move(react, Int32Array);
    if (w.reactNodes !== undefined) w.reactNodes = reactV;
    w.treadLoad = move(w.treadLoad, Float64Array);
    w.treadNormal = move(w.treadNormal, Float64Array);
    w.treadBrush = move(w.treadBrush, Float64Array);
    const samp = put(48 * n);
    H[W.N] = n;
    H[W.RAYS] = cw.rays;
    H[W.SPIN] = cw.spinSign;
    H[W.TRR] = cw.tireRingRadius;
    H[W.RIMR] = cw.rimRadius;
    H[W.RIMHOOP] = cw.rimHoop;
    H[W.TREADHOOP] = cw.treadHoop;
    H[W.BRUSHK] = cw.brushK;
    H[W.BRUSHC] = cw.brushC;
    H[W.NLINK] = w.hubLinkBeams.length;
    H[W.LINKS] = w.hubLinkBeams.byteOffset;
    H[W.NATT] = w.attachNodes.length;
    H[W.ATT] = w.attachNodes.byteOffset;
    H[W.NREACT] = reactV.length;
    H[W.REACT] = reactV.byteOffset;
    H[W.TLOAD] = w.treadLoad.byteOffset;
    H[W.TNRM] = w.treadNormal.byteOffset;
    H[W.TBRUSH] = w.treadBrush.byteOffset;
    H[W.SAMP] = samp;
    const block: WheelBlock = { at, bytes: total, H };
    wheelBlocks.set(w, block);
    return block;
  };
  /** The wheel's header with this tick's indices (a rebase moves them). */
  const wheelHeader = (w: WheelRuntime): Float64Array | null => {
    let b = wheelBlocks.get(w);
    if (b === undefined) b = adoptWheel(w);
    if (b === null) return null;
    const H = b.H;
    H[W.HUBI] = w.hubI;
    H[W.HUBO] = w.hubO;
    H[W.RIM] = w.rimStart;
    H[W.TIRE] = w.tireStart;
    return H;
  };
  /** Points the ground header at `sampler`; false when the kernel cannot mirror it. */
  const groundFor = (sampler: HeightSampler): boolean => {
    if (sampler !== gSampler) {
      // A sampler the kernel cannot mirror (R-PHYS2's rutted SoftGroundSampler, used only near ruts) runs on
      // the JS path WITHOUT uninstalling the mirrored one: its tile cache stays warm for the other objects.
      if (!(sampler instanceof PlaneSampler) && !isMirroredSampler(sampler)) return false;
      gSampler = sampler;
      gMirrored = terrain.install(sampler);
    }
    if (gMirrored && gH[G.KIND] === 1) {
      const p = sampler as PlaneSampler;
      gH[G.PLANE_Y] = p.y;
      gH[G.PLANE_MAT] = p.materialId;
    }
    return gMirrored;
  };
  const wheels: WheelKernel = {
    omega(w: WheelRuntime, sampler: HeightSampler | null, materials: MaterialTable, dt: number): boolean {
      if (sampler !== null) {
        if (!groundFor(sampler)) return false;
        gMatF.set(materials.friction);
      }
      const H = wheelHeader(w);
      if (H === null) return false;
      H[W.ROLLR] = w.rollRadius;
      H[W.DETACHED] = w.detached;
      H[W.LOAD] = w.load;
      H[W.CONTACT] = w.contact;
      H[W.SLIPSPEED] = w.slipSpeed;
      H[W.SLIPRATIO] = w.slipRatio;
      const at = H.byteOffset;
      const g = sampler !== null ? 1 : 0;
      while (wOmega(at, g, dt) === 0) terrain.load(gH[G.MISS_GRID]!, gH[G.MISS_TILE]!);
      w.omega = H[W.OMEGA]!;
      w.rollRadius = H[W.ROLLR]!;
      w.detached = H[W.DETACHED]!;
      w.load = H[W.LOAD]!;
      w.contact = H[W.CONTACT]!;
      w.slipSpeed = H[W.SLIPSPEED]!;
      w.slipRatio = H[W.SLIPRATIO]!;
      return true;
    },
    axleTorque(w: WheelRuntime, tau: number): boolean {
      const H = wheelHeader(w);
      if (H === null) return false;
      wAxle(H.byteOffset, tau);
      return true;
    },
    uprightReaction(w: WheelRuntime, tau: number): boolean {
      const H = wheelHeader(w);
      if (H === null) return false;
      H[W.DETACHED] = w.detached;
      wUpright(H.byteOffset, tau, w.caliperInboard ?? 0.5);
      return true;
    },
    treadBrush(w: WheelRuntime, sampler: HeightSampler | null, dt: number): boolean {
      const H = wheelHeader(w);
      if (H === null) return false;
      if (sampler !== null && (sampler !== gSampler || !gMirrored || H[W.CACHE] !== 1)) return false;
      wBrush(H.byteOffset, sampler !== null ? 1 : 0, dt, w.slipRatio, w.latMu ?? 1);
      H[W.CACHE] = 0;
      return true;
    },
    hoop(w: WheelRuntime): boolean {
      const H = wheelHeader(w);
      if (H === null) return false;
      H[W.OMEGA] = w.omega;
      wHoop(H.byteOffset);
      return true;
    },
  };
  const kernel: WasmSimKernel = {
    kind,
    body,
    wheels,
    beginTick(): void {
      // A new tick: samples cached by the last one are stale (stamps never hit 0, the cleared value).
      const st = gH[G.STAMP]!;
      gH[G.STAMP] = st >= 0xfffffffe ? 1 : st + 1;
    },
    releaseWheels(list: readonly WheelRuntime[]): void {
      for (const w of list) {
        const b = wheelBlocks.get(w);
        wheelBlocks.delete(w);
        if (!b) continue;
        w.hubLinkBeams = w.hubLinkBeams.slice();
        w.attachNodes = w.attachNodes.slice();
        if (w.reactNodes !== undefined) w.reactNodes = w.reactNodes.slice();
        w.treadLoad = w.treadLoad.slice();
        w.treadNormal = w.treadNormal.slice();
        w.treadBrush = w.treadBrush.slice();
        aux.release(b.at, b.bytes);
      }
    },
    state,
    beams(first: number, count: number, events: EventSink, dbg: boolean, armed?: boolean): void {
      const n = wBeams(first, count, dbg ? 1 : 0, armed ? 1 : 0);
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
    ground(first: number, count: number, sampler: HeightSampler, materials: MaterialTable, dt: number, objectId: number, events: EventSink, gx: number, gy: number, gz: number): void {
      if (!groundFor(sampler)) {
        groundJs(first, count, sampler, materials, dt, objectId, events, gx, gy, gz);
        return;
      }
      gMatF.set(materials.friction);
      const end = first + count;
      let i = first;
      for (;;) {
        const stop = wGround(i, end - i, dt, gx, gy, gz);
        const ne = gH[G.EV_COUNT]!;
        for (let e = 0; e < ne; e++) {
          const o = 9 * e;
          if (gEvents[o] === 1) events.impact(objectId, gEvents[o + 1]!, gEvents[o + 2]!, gEvents[o + 3]!, gEvents[o + 4]!, gEvents[o + 5]!, gEvents[o + 6]!, gEvents[o + 7]!, gEvents[o + 8]!);
          else events.skid(objectId, gEvents[o + 1]!, gEvents[o + 2]!, gEvents[o + 3]!, gEvents[o + 4]!, gEvents[o + 5]!, gEvents[o + 6]!);
        }
        if (stop >= end) return;
        const grid = gH[G.MISS_GRID]!;
        if (grid !== 0) terrain.load(grid, gH[G.MISS_TILE]!);
        i = stop;
      }
    },
    groundSample(sampler: HeightSampler, x: number, z: number): Float64Array | null {
      if (!groundFor(sampler) || gH[G.KIND] !== 2) return null;
      while (ex.ground_sample(x, z, sampleOut.byteOffset) === 0) terrain.load(gH[G.MISS_GRID]!, gH[G.MISS_TILE]!);
      return sampleOut.slice();
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
  return kernel;
}

/**
 * The kernel's view of the engine's ground (kernel.c `ground`): a PlaneSampler, or a
 * heightfield sampler registered by the engine (`markMirroredSampler`), whose grids are
 * copied into kernel memory TILE × TILE cells at a time on demand (FIFO pools).
 * Anything else stays on the JS kernel.
 */
class TerrainCache {
  private hf: HeightfieldSampler | null = null;
  private tables: Uint32Array | null = null;
  private hTX = 0;
  private nTX = 0;
  private mTX = 0;
  private hTab = 0;
  private nTab = 0;
  private mTab = 0;
  private hPool = 0;
  private nPool = 0;
  private mPool = 0;
  private readonly owner = [new Int32Array(TILE_POOL), new Int32Array(TILE_POOL), new Int32Array(TILE_POOL)];
  private readonly next = [0, 0, 0];
  constructor(
    private readonly buf: ArrayBuffer,
    private readonly base: number,
    private readonly bytes: number,
    private readonly H: Float64Array,
  ) {}

  /** Points the header at `s`; false when the kernel cannot mirror it. */
  install(s: HeightSampler): boolean {
    const H = this.H;
    this.hf = null;
    if (s instanceof PlaneSampler) {
      H[G.KIND] = 1;
      return true;
    }
    if (!isMirroredSampler(s)) {
      H[G.KIND] = 0;
      return false;
    }
    const hf = s as HeightfieldSampler;
    const { cols, rows, spacing, originX, originZ } = hf;
    const hTX = ((cols - 2) >> 5) + 1;
    const hTY = ((rows - 2) >> 5) + 1;
    const nTX = ((cols + 1) >> 5) + 1;
    const nTY = ((rows + 1) >> 5) + 1;
    const mTX = ((cols - 1) >> 5) + 1;
    const mTY = ((rows - 1) >> 5) + 1;
    const nTab = hTX * hTY + nTX * nTY + mTX * mTY;
    if (TERRAIN_POOL_BYTES + 4 * nTab + 64 > this.bytes || hf.normals.stride !== cols + 3) {
      H[G.KIND] = 0;
      return false;
    }
    const tabAt = this.base + TERRAIN_POOL_BYTES;
    this.tables = new Uint32Array(this.buf, tabAt, nTab);
    this.tables.fill(0);
    this.hTab = tabAt;
    this.nTab = tabAt + 4 * hTX * hTY;
    this.mTab = this.nTab + 4 * nTX * nTY;
    this.hTX = hTX;
    this.nTX = nTX;
    this.mTX = mTX;
    this.hPool = this.base;
    this.nPool = this.hPool + TILE_POOL * 4 * TILE_S * TILE_S;
    this.mPool = this.nPool + TILE_POOL * 12 * TILE_S * TILE_S;
    for (const o of this.owner) o.fill(-1);
    this.next.fill(0);
    this.hf = hf;
    // The sampler's own constants (bindMethods' parameters), computed the same way.
    H[G.KIND] = 2;
    H[G.OX] = originX;
    H[G.OZ] = originZ;
    H[G.NOX] = originX - spacing;
    H[G.NOZ] = originZ - spacing;
    H[G.INVS] = 1 / spacing;
    H[G.MAXU] = cols - 1;
    H[G.MAXV] = rows - 1;
    H[G.NMAXU] = cols + 1;
    H[G.NMAXV] = rows + 1;
    H[G.COLS] = cols;
    H[G.LASTU] = cols - 2;
    H[G.LASTV] = rows - 2;
    H[G.HTILES] = this.hTab;
    H[G.HTX] = hTX;
    H[G.NTILES] = this.nTab;
    H[G.NTX] = nTX;
    H[G.MTILES] = this.mTab;
    H[G.MTX] = mTX;
    return true;
  }

  /** Copies tile `t` of grid 1 (heights) / 2 (normals) / 3 (material) into a pool slot. */
  load(grid: number, t: number): void {
    const hf = this.hf;
    if (hf === null) throw new Error('terrain tile requested without a heightfield');
    const g = grid - 1;
    const tabOff = grid === 1 ? this.hTab : grid === 2 ? this.nTab : this.mTab;
    const tx = grid === 1 ? this.hTX : grid === 2 ? this.nTX : this.mTX;
    const slot = this.next[g]!;
    this.next[g] = slot + 1 === TILE_POOL ? 0 : slot + 1;
    const table = new Uint32Array(this.buf, tabOff, 1 + t);
    const prev = this.owner[g]![slot]!;
    if (prev >= 0) new Uint32Array(this.buf, tabOff, prev + 1)[prev] = 0;
    this.owner[g]![slot] = t;
    const c0 = (t % tx) * TILE;
    const r0 = Math.floor(t / tx) * TILE;
    const { cols, rows } = hf;
    if (grid === 1) {
      const at = this.hPool + slot * 4 * TILE_S * TILE_S;
      copyTile(new Float32Array(this.buf, at, TILE_S * TILE_S), hf.heights, cols, cols, rows, c0, r0, TILE_S);
      table[t] = at;
    } else if (grid === 2) {
      const at = this.nPool + slot * 12 * TILE_S * TILE_S;
      const n = hf.normals;
      const pc = cols + 3;
      const pr = rows + 3;
      const sz = TILE_S * TILE_S;
      copyTile(new Float32Array(this.buf, at, sz), n.x, pc, pc, pr, c0, r0, TILE_S);
      copyTile(new Float32Array(this.buf, at + 4 * sz, sz), n.y, pc, pc, pr, c0, r0, TILE_S);
      copyTile(new Float32Array(this.buf, at + 8 * sz, sz), n.z, pc, pc, pr, c0, r0, TILE_S);
      table[t] = at;
    } else {
      const at = this.mPool + slot * TILE * TILE;
      copyTile(new Uint8Array(this.buf, at, TILE * TILE), hf.material, cols, cols, rows, c0, r0, TILE);
      table[t] = at;
    }
  }
}

/** dst (edge × edge) = src rows r0.., cols c0.. (row stride `stride`, valid w × h), zero outside. */
function copyTile<T extends Float32Array | Uint8Array>(dst: T, src: T, stride: number, w: number, h: number, c0: number, r0: number, edge: number): void {
  dst.fill(0);
  const cw = Math.min(edge, w - c0);
  for (let r = 0; r < edge && r0 + r < h; r++) {
    const o = (r0 + r) * stride + c0;
    dst.set(src.subarray(o, o + cw) as never, r * edge);
  }
}

/** A WASM kernel, plus a test hook: the kernel's mirrored terrain sampler at (x, z) → [h, nx, ny, nz, material] (null: not mirrored). */
export interface WasmSimKernel extends SimKernel {
  groundSample(sampler: HeightSampler, x: number, z: number): Float64Array | null;
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
