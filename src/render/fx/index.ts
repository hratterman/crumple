/**
 * World FX (P5, U3). CONTRACT: ./types.ts + docs/CONTRACTS.md "FX event →
 * effect". Six draws at most: skidmarks, debris chunks, debris flakes, bits,
 * soft (smoke/dust/spray/rings), sparks. Event handlers only enqueue (typed
 * rings); update(frame) runs after the camera is final:
 *   1. per registered vehicle wheel (telemetry + hub nodes): contact point,
 *      ground class → skidmark/rut ribbons, tyre smoke, dirt spray,
 *      rooster-tail dust. Continuous emitters spread births and positions
 *      over the sim interval since the last frame (smooth trails at any
 *      frame rate; slow-mo emits per SIM second);
 *   2. queued events, classified tyre vs body by the event object's own hubs;
 *   3. water splash / wake from frame.nodes vs the water bodies;
 *   4. debris integration, uniforms, pool uploads.
 * Zero allocation per frame after warm-up.
 */
import { Group, Vector2, Vector3, type FogExp2, type Vector4 } from 'three';

import { createRng } from '../../core/rng';
import { OBJECT_FLAG_SLEEPING } from '../../protocol/layout';
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { VehicleTelemetry, WHEEL_LOAD_SLOTS, WHEEL_OMEGA_SLOTS, WHEEL_SLIP_SLOTS, cornerFlag } from '../../protocol/telemetry';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { SimObjectSlice, WorldFrame } from '../types';
import { DebrisPool, createChunkGeometry, createDebrisMaterial, createFlakeGeometry, type DebrisState } from './debris';
import {
  ParticlePool,
  SceneDepthCopy,
  createBitsMaterial,
  createLightUniforms,
  createParticleSpawn,
  createSoftMaterial,
  createSparkMaterial,
  type KindMotion,
} from './particles';
import {
  GROUND_OBJECT,
  IMPACT_CHIPS,
  IMPACT_CLOD,
  IMPACT_SPARKS,
  SCRAPE_CHIPS,
  SCRAPE_DUST,
  SCRAPE_SPARKS,
  SURF_CARDBOARD,
  SURF_CONCRETE,
  SURF_METAL,
  SURF_PLASTIC,
  SURF_TYRE,
  SURF_WOOD,
  VEHICLE_PAINT,
  WHEEL_ROOST,
  WHEEL_RUT,
  WHEEL_SKID,
  WHEEL_SMOKE,
  WHEEL_SPRAY,
  clodColor,
  dustColor,
  groundClass,
  impactEffect,
  objectMaterialSurface,
  roostRate,
  rutStrength,
  persistentTrack,
  REF_LOAD,
  rutTint,
  scrapeEffect,
  skidStrength,
  smokeRate,
  sparkBurstCount,
  sprayRate,
  surfaceCode,
  surfaceColor,
  sweptWidth,
  wheelEffects,
} from './rules';
import { SkidLayer } from './skidmarks';
import { SurfaceLift } from './surface';
import { createPuffTexture } from './textures';
import {
  FX_SKID_LIFT_M,
  FX_SPLASH_SPEED,
  FX_TYRE_CLASSIFY_MARGIN,
  FX_WAKE_SPEED,
  type CreateFxSystem,
  type FxState,
  type FxStats,
  type FxSystem,
} from './types';

// ------------------------------------------------------------------ kinds
/** Soft pool kinds. */
export const K_SMOKE = 0;
export const K_DUST = 1;
export const K_HAZE = 2;
export const K_SPRAY = 3;
export const K_RING = 4;
export const K_SHEET = 5;
const SOFT_KINDS: readonly KindMotion[] = [
  { drag: 1.5, gravity: 0, rise: 0.75, wind: 1 },
  { drag: 1.9, gravity: 0.5, rise: 0.8, wind: 1 },
  { drag: 1.0, gravity: 0, rise: 0.12, wind: 1.2 },
  { drag: 0.9, gravity: 9.81, rise: 0, wind: 0.5 },
  { drag: 2.0, gravity: 0, rise: 0, wind: 0 },
  { drag: 0.7, gravity: 9.81, rise: 0, wind: 0.3 },
];
/** (fade-in s, fade-out start fraction, turbulence m, flat) */
const SOFT_SHAPING: readonly (readonly number[])[] = [
  [0.08, 0.3, 1.1, 0],
  [0.06, 0.3, 0.5, 0],
  [0.8, 0.35, 1.1, 0],
  [0.02, 0.45, 0.05, 0],
  [0.02, 0.15, 0, 1],
  [0.02, 0.4, 0.05, 0],
];
/** Bits pool kinds. */
const B_CLOD = 0;
const B_CHIP = 1;
const B_FLAKE = 2;
const B_SPLINTER = 3;
const B_GRIT = 4;
const B_DROP = 5;
const B_GRASS = 6;
const BITS_KINDS: readonly KindMotion[] = [
  { drag: 0.35, gravity: 9.81, rise: 0, wind: 0 },
  { drag: 0.8, gravity: 9.81, rise: 0, wind: 0.1 },
  { drag: 3.2, gravity: 9.81, rise: 0, wind: 0.9 },
  { drag: 0.6, gravity: 9.81, rise: 0, wind: 0.1 },
  { drag: 0.25, gravity: 9.81, rise: 0, wind: 0 },
  { drag: 0.6, gravity: 9.81, rise: 0, wind: 0.2 },
  { drag: 2.4, gravity: 9.81, rise: 0, wind: 0.7 },
];
/** (aspect, tumble rad/s) */
const BITS_SHAPING: readonly (readonly number[])[] = [
  [1, 9],
  [0.85, 15],
  [1, 6],
  [0.22, 12],
  [1, 11],
  [1, 0],
  [0.3, 8],
];
const SPARK_KINDS: readonly KindMotion[] = [{ drag: 0.8, gravity: 9.81, rise: 0, wind: 0 }];

const MAX_OBJECT_ID = PROP_DYNAMIC_ID_BASE + 4096;
const QUEUE = 1024;
const SEG_M = 0.8;
const PATCH_LENGTH_M = 0.28;
/** Burnout (wheel spinning while its contact barely moves): a rubber patch is stamped under it every STAMP_S of slip. */
const STAMP_S = 0.2;
const STAMP_MAX_SPEED = 1.5;
const STAMP_LENGTH_M = 1.1;
const STAMP_BACK_M = 0.3;
/**
 * Optical cross-section (puff opacity × (puff size scale)²) per sim second a smoking wheel
 * may feed into its local cloud at standstill (× (1 + 0.5 · ground speed m/s) when moving).
 * A 10 s standing burnout saturates at a translucent cloud the chase camera sees the car
 * through, at every preset.
 */
export const SMOKE_OPACITY_RATE = 30;
/** Tyre smoke puffs are laid at least this far apart along the contact path (high preset), m. */
export const SMOKE_SPACING_M = 0.45;
/** Radius around the player vehicle (the first registered) inside which smoke between it and the camera thins out, m. */
const FOCUS_RADIUS_M = 3.2;
/** Sim step (s): WorldFrame.tick × SIM_DT = the latest snapshot's sim time. */
const SIM_DT = 1 / 2000;
const PLASTIC_BLACK: readonly [number, number, number] = [0.02, 0.02, 0.022];
const METAL_GREY: readonly [number, number, number] = [0.35, 0.36, 0.38];

interface WheelFx {
  corner: number;
  hubI: number;
  hubO: number;
  radius: number;
  tread: number;
  slot: number;
  hx: number;
  hy: number;
  hz: number;
  cx: number;
  cy: number;
  cz: number;
  valid: boolean;
  px: number;
  py: number;
  pz: number;
  prevValid: boolean;
  /** Hub velocity (render frames), world m/s; horizontal axle unit; hub height above ground. */
  wvx: number;
  wvy: number;
  wvz: number;
  ahx: number;
  ahz: number;
  upright: boolean;
  groundY: number;
  /** Open mark strip kind (0 none, WHEEL_SKID, WHEEL_RUT) and its last end edge. */
  strip: number;
  /** Sim seconds since the mark condition last held (hysteresis), current width + tint. */
  offT: number;
  width: number;
  tr: number;
  tg: number;
  tb: number;
  sheen: number;
  pcx: number;
  pcz: number;
  lx: number;
  ly: number;
  lz: number;
  rx: number;
  ry: number;
  rz: number;
  mx: number;
  mz: number;
  along: number;
  lastS: number;
  smokeAcc: number;
  /** Path since the last smoke puff, in units of the puff spacing. */
  smokeDist: number;
  sprayAcc: number;
  roostAcc: number;
  /** Seconds of near-stationary skid slip since the last burnout stamp. */
  stampT: number;
}

interface VehicleFx {
  id: number;
  wheels: WheelFx[];
  paint: [number, number, number];
  frameO: number;
  frameF: number;
  vx: number;
  vy: number;
  vz: number;
  /** Every attached wheel touches the ground (telemetry). */
  grounded: boolean;
  groundY: number;
}

function hexToLinear(hex: number): [number, number, number] {
  const c = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
}

/** Pool capacities for a particle budget: soft 60 %, bits 20 %, sparks the rest. */
export function particleCaps(budget: number): [number, number, number] {
  const soft = Math.round(budget * 0.6);
  const bits = Math.round(budget * 0.2);
  return [soft, bits, Math.max(1, budget - soft - bits)];
}
export function debrisCaps(budget: number): [number, number] {
  const a = Math.max(1, Math.round(budget * 0.65));
  return [a, Math.max(1, budget - a)];
}

/** P7 replay snapshot (FxSystem.saveState). */
interface FxSnapshot extends FxState {
  soft: ReturnType<ParticlePool['saveState']>;
  bits: ReturnType<ParticlePool['saveState']>;
  sparks: ReturnType<ParticlePool['saveState']>;
  chunks: DebrisState;
  flakes: DebrisState;
  clocks: number[];
  scr: Float64Array;
  prevPos: Float32Array;
  nearFrame: Int32Array;
  wakeAcc: Float32Array;
  vehicles: { id: number; vx: number; vy: number; vz: number; grounded: boolean; groundY: number; wheels: WheelFx[] }[];
  debrisHidden: boolean;
}

export const createFxSystem: CreateFxSystem = (ctx, opts): FxSystem => {
  const object = new Group();
  object.name = 'fx';
  const { sampler, lighting } = opts;
  let rng = createRng(0xf00d5);
  const lift = new SurfaceLift(opts.terrain);
  const light = createLightUniforms();
  const puff = createPuffTexture();

  let q = ctx.quality;
  const [softCap, bitsCap, sparkCap] = particleCaps(q.particleBudget);
  const soft = new ParticlePool('fx.soft', softCap, createSoftMaterial(puff, light, SOFT_KINDS, SOFT_SHAPING), SOFT_KINDS, 30);
  const softDepth = new SceneDepthCopy(soft.mesh.material);
  softDepth.attach(soft.mesh);
  const bits = new ParticlePool('fx.bits', bitsCap, createBitsMaterial(light, BITS_KINDS, BITS_SHAPING), BITS_KINDS, 25);
  const sparks = new ParticlePool('fx.sparks', sparkCap, createSparkMaterial(SPARK_KINDS), SPARK_KINDS, 35);
  const skid = new SkidLayer(q.skidSegments);

  const groundAt = (x: number, z: number): number => sampler.heightAt(x, z);
  const chunkMat = opts.patchMaterial(createDebrisMaterial('fx.debrisChunk', 0.25, 0.55), { csm: lighting.csm }).color;
  const flakeMat = opts.patchMaterial(createDebrisMaterial('fx.debrisFlake', 0.05, 0.7), { csm: lighting.csm }).color;
  const [chunkCap, flakeCap] = debrisCaps(q.debrisBudget);
  const chunks = new DebrisPool('fx.debris', createChunkGeometry(createRng(0xc4a1)), chunkMat, chunkCap, groundAt);
  const flakes = new DebrisPool('fx.flakes', createFlakeGeometry(), flakeMat, flakeCap, groundAt);
  object.add(skid.mesh, chunks.mesh, flakes.mesh, bits.mesh, soft.mesh, sparks.mesh);
  const drawn = [skid.mesh, chunks.mesh, flakes.mesh, bits.mesh, soft.mesh, sparks.mesh] as const;

  let rateScale = 1;
  let smokeSpacing = SMOKE_SPACING_M;
  let smokeArea = 1;
  const applyBudgetScales = (): void => {
    rateScale = Math.min(1.5, q.particleBudget / 3000);
    // smaller budgets draw bigger puffs (sizeScale), so they can sit further apart
    smokeSpacing = SMOKE_SPACING_M / Math.sqrt(Math.max(rateScale, 0.2));
    const sizeScale = Math.min(1.7, Math.max(1, Math.pow(3000 / q.particleBudget, 0.3)));
    smokeArea = sizeScale * sizeScale;
    (soft.mesh.material.uniforms.uSizeScale as { value: number }).value = sizeScale;
  };
  applyBudgetScales();

  // ------------------------------------------------------------ registries
  const vehicles: VehicleFx[] = [];
  const vehicleById = new Map<number, VehicleFx>();
  /** Surface code + 1 per object id (0 = unknown → metal). */
  const surfaces = new Uint8Array(MAX_OBJECT_ID);
  let hintSlots = 0;

  // ------------------------------------------------------------ event queues
  const impQ = new Float32Array(QUEUE * 9);
  let impN = 0;
  const brkQ = new Float32Array(QUEUE * 4);
  let brkN = 0;
  const skQ = new Float32Array(QUEUE * 7);
  let skN = 0;

  // ------------------------------------------------------------ scratch
  const sp = createParticleSpawn();
  const nrm = new Float64Array(3);
  const bufSize = new Vector2();
  let lastSim = Number.NaN;
  let prevLatest = Number.NaN;
  let lastDeathSoft = -1e9;
  let lastDeathBits = -1e9;
  let lastDeathSparks = -1e9;
  let lastSkidBirth = -1e9;
  let now = 0;
  const SCR = 24;
  const scr = new Float64Array(SCR * 6); // x y z t objectId live
  let scrNext = 0;
  let prevPos = new Float32Array(0);
  const nearFrame = new Int32Array(MAX_OBJECT_ID).fill(-10);
  const wakeAcc = new Float32Array(MAX_OBJECT_ID);
  let frameIndex = 0;
  /** P7: debris hidden (reverse replay playback). */
  let debrisHidden = false;

  const setSpawn = (px: number, py: number, pz: number, vx: number, vy: number, vz: number): void => {
    sp.px = px;
    sp.py = py;
    sp.pz = pz;
    sp.vx = vx;
    sp.vy = vy;
    sp.vz = vz;
  };
  const spawnSoft = (kind: number, birth: number, life: number, s0: number, s1: number, op: number, r: number, g: number, b: number, ground: number): void => {
    sp.birth = birth;
    sp.life = life;
    sp.size0 = s0;
    sp.size1 = s1;
    sp.seed = rng.float();
    sp.kind = kind;
    sp.opacity = op;
    sp.r = r;
    sp.g = g;
    sp.b = b;
    sp.ground = ground;
    sp.bounce = 0;
    soft.spawn(sp);
    if (birth + life > lastDeathSoft) lastDeathSoft = birth + life;
  };
  const spawnBit = (kind: number, birth: number, life: number, size: number, r: number, g: number, b: number, ground: number, bounce: number): void => {
    sp.birth = birth;
    sp.life = life;
    sp.size0 = size;
    sp.size1 = size;
    sp.seed = rng.float();
    sp.kind = kind;
    sp.opacity = 0.99;
    sp.r = r;
    sp.g = g;
    sp.b = b;
    sp.ground = ground;
    sp.bounce = bounce;
    sp.friction = 0.45;
    bits.spawn(sp);
    if (birth + life > lastDeathBits) lastDeathBits = birth + life;
  };
  const spawnSpark = (birth: number, life: number, width: number, intensity: number, ground: number): void => {
    sp.birth = birth;
    sp.life = life;
    sp.size0 = width;
    sp.size1 = intensity;
    sp.seed = rng.float();
    sp.kind = 0;
    sp.opacity = 0.99;
    sp.r = 1;
    sp.g = 1;
    sp.b = 1;
    sp.ground = ground;
    sp.bounce = 0.35;
    sp.friction = 0.6;
    sparks.spawn(sp);
    if (birth + life > lastDeathSparks) lastDeathSparks = birth + life;
  };

  // ------------------------------------------------------------ effect helpers
  /**
   * Spark burst at a contact with surface normal n (pointing out of the
   * surface, into the mover). Sparks keep part of the mover's TANGENTIAL
   * velocity (never into the surface: they would fly through the wall) and
   * spray out along n and across the surface plane, low and fast.
   */
  const sparkBurst = (x: number, y: number, z: number, nx: number, ny: number, nz: number, vx: number, vy: number, vz: number, count: number, t: number): void => {
    const n = Math.min(Math.round(count * Math.max(rateScale, 0.35)), Math.max(4, sparks.capacity >> 2));
    const g = groundAt(x, z);
    let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(nl > 1e-6)) {
      nx = 0;
      ny = 1;
      nz = 0;
      nl = 1;
    }
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const vn = vx * nx + vy * ny + vz * nz;
    if (vn < 0) {
      vx -= nx * vn;
      vy -= ny * vn;
      vz -= nz * vn;
    }
    // tangent basis of the surface plane
    let ux = -nz;
    let uy = 0;
    let uz = nx;
    let ul = Math.sqrt(ux * ux + uz * uz);
    if (ul < 1e-4) {
      ux = 1;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const wx = ny * uz - nz * uy;
    const wy = nz * ux - nx * uz;
    const wz = nx * uy - ny * ux;
    for (let i = 0; i < n; i++) {
      const s = 1.5 + rng.float() * 5.5;
      const a = rng.float() * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const out = 0.15 + rng.float() * 0.6;
      const keep = 0.25 + 0.6 * rng.float();
      setSpawn(
        x + nx * 0.03, y + ny * 0.03 + 0.01, z + nz * 0.03,
        vx * keep + (nx * out + (ux * ca + wx * sa)) * s,
        vy * keep + (ny * out + (uy * ca + wy * sa)) * s + 0.6 + rng.float() * 1.2,
        vz * keep + (nz * out + (uz * ca + wz * sa)) * s,
      );
      spawnSpark(t - rng.float() * 0.02, 0.2 + rng.float() * rng.float() * 0.9, 0.006 + rng.float() * 0.008, 20 + rng.float() * 22, g);
    }
  };
  const dustPuff = (x: number, y: number, z: number, mat: number, n: number, size: number, t: number): void => {
    const c = dustColor(mat);
    const g = groundAt(x, z);
    const m = Math.max(1, Math.round(n * Math.max(rateScale, 0.4)));
    for (let i = 0; i < m; i++) {
      setSpawn(
        x + (rng.float() - 0.5) * 0.4, y + 0.1, z + (rng.float() - 0.5) * 0.4,
        (rng.float() - 0.5) * 2.2, 0.4 + rng.float() * 1.2, (rng.float() - 0.5) * 2.2,
      );
      const k = 0.9 + rng.float() * 0.2;
      spawnSoft(K_DUST, t, 1.8 + rng.float() * 2.2, size * 0.4, size * (1.6 + rng.float()), 0.32 + rng.float() * 0.2, c[0] * k, c[1] * k, c[2] * k, g);
    }
  };
  const chipsOf = (surf: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, n: number, t: number, paint: readonly number[] | null): void => {
    const g = groundAt(x, z);
    const kind = surf === SURF_CARDBOARD ? B_FLAKE : surf === SURF_WOOD ? B_SPLINTER : surf === SURF_CONCRETE ? B_GRIT : B_CHIP;
    const m = Math.max(1, Math.round(n * Math.max(rateScale, 0.4)));
    for (let i = 0; i < m; i++) {
      const c = paint && rng.float() < 0.7 ? paint : surfaceColor(surf, rng.float());
      const s = 1.5 + rng.float() * 3;
      setSpawn(x, y, z, vx * 0.5 + (rng.float() - 0.5) * s, vy * 0.3 + rng.float() * s * 0.8 + 0.5, vz * 0.5 + (rng.float() - 0.5) * s);
      const size = kind === B_FLAKE ? 0.03 + rng.float() * 0.05 : kind === B_SPLINTER ? 0.05 + rng.float() * 0.07 : 0.012 + rng.float() * 0.025;
      spawnBit(kind, t, 2.5 + rng.float() * 3, size, c[0]!, c[1]!, c[2]!, g, 0.3);
    }
  };
  const clods = (mat: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, n: number, t: number, spread: number): void => {
    const c = clodColor(mat);
    const g = groundAt(x, z);
    const kind = mat === MaterialId.grass ? B_GRASS : mat === MaterialId.gravel ? B_GRIT : B_CLOD;
    for (let i = 0; i < n; i++) {
      setSpawn(
        x + (rng.float() - 0.5) * 0.15, y + 0.04, z + (rng.float() - 0.5) * 0.15,
        vx + (rng.float() - 0.5) * spread, vy + rng.float() * spread * 0.6, vz + (rng.float() - 0.5) * spread,
      );
      const k = 0.75 + rng.float() * 0.5;
      const size = kind === B_GRASS ? 0.03 + rng.float() * 0.04 : 0.012 + rng.float() * 0.03;
      spawnBit(kind, t - rng.float() * 0.02, 1.2 + rng.float() * 1.6, size, c[0] * k, c[1] * k, c[2] * k, g, 0.2);
    }
  };

  // ------------------------------------------------------------ skid strips
  const edgeY = (x: number, z: number, onObj: boolean, objY: number, slot: number): number =>
    onObj ? objY + FX_SKID_LIFT_M : sampler.heightAt(x, z) + lift.liftAt(x, z, slot) + FX_SKID_LIFT_M;

  /** Starts a strip at (x, z) (zero-coverage start edge across direction (mx, mz)). */
  const openStrip = (w: WheelFx, kind: number, x: number, y: number, z: number, mx: number, mz: number, onObj: boolean): void => {
    const hw = w.width * 0.5;
    w.strip = kind;
    w.offT = 0;
    w.mx = mx;
    w.mz = mz;
    w.lx = x - mz * hw;
    w.lz = z + mx * hw;
    w.rx = x + mz * hw;
    w.rz = z - mx * hw;
    w.ly = edgeY(w.lx, w.lz, onObj, y, w.slot);
    w.ry = edgeY(w.rx, w.rz, onObj, y, w.slot);
    w.pcx = x;
    w.pcz = z;
    w.lastS = 0;
  };
  /**
   * Burnout patch: one STAMP_LENGTH_M quad along heading (hx, hz), centred
   * STAMP_BACK_M behind the contact (a strip never grows while the contact stands still;
   * repeated stamps darken the patch).
   */
  const stampPatch = (w: WheelFx, s: number, t: number, hx: number, hz: number, onObj: boolean): void => {
    const hw = 0.5 * Math.max(0.06, w.tread);
    const hl = 0.5 * STAMP_LENGTH_M;
    // smeared rearward of the contact (the tread spins forward), so it shows behind the tyre
    const ccx = w.cx - hx * STAMP_BACK_M;
    const ccz = w.cz - hz * STAMP_BACK_M;
    const ax = ccx - hx * hl;
    const az = ccz - hz * hl;
    const bx = ccx + hx * hl;
    const bz = ccz + hz * hl;
    const l0x = ax - hz * hw;
    const l0z = az + hx * hw;
    const r0x = ax + hz * hw;
    const r0z = az - hx * hw;
    const l1x = bx - hz * hw;
    const l1z = bz + hx * hw;
    const r1x = bx + hz * hw;
    const r1z = bz - hx * hw;
    skid.add(
      l0x, edgeY(l0x, l0z, onObj, w.cy, w.slot), l0z, r0x, edgeY(r0x, r0z, onObj, w.cy, w.slot), r0z,
      l1x, edgeY(l1x, l1z, onObj, w.cy, w.slot), l1z, r1x, edgeY(r1x, r1z, onObj, w.cy, w.slot), r1z,
      w.along, w.along + 2 * hl, s, s, t, w.tr, w.tg, w.tb, w.sheen,
    );
    w.along += 2 * hl;
  };
  /** Extends wheel w's open strip to its current contact (sub-segmented), coverage → s. */
  const extendStrip = (w: WheelFx, s: number, t: number, onObj: boolean): void => {
    const cx = w.cx;
    const cz = w.cz;
    const dx = cx - w.pcx;
    const dz = cz - w.pcz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < SEG_M) return;
    const mx = dx / dist;
    const mz = dz / dist;
    if (w.lastS <= 0.001 && s <= 0.001) {
      openStrip(w, w.strip, cx, w.cy, cz, mx, mz, onObj); // nothing visible to lay: move the start edge
      return;
    }
    w.mx = mx;
    w.mz = mz;
    const hw = 0.5 * w.width;
    const n = Math.min(Math.ceil(dist / SEG_M), 24);
    const sx = w.pcx;
    const sz = w.pcz;
    const s0 = w.lastS;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const px = sx + dx * f;
      const pz = sz + dz * f;
      const lx = px - mz * hw;
      const lz = pz + mx * hw;
      const rx = px + mz * hw;
      const rz = pz - mx * hw;
      const ly = edgeY(lx, lz, onObj, w.cy, w.slot);
      const ry = edgeY(rx, rz, onObj, w.cy, w.slot);
      const a0 = w.along;
      const a1 = a0 + dist / n;
      const sa = s0 + (s - s0) * ((k - 1) / n);
      const sb = s0 + (s - s0) * f;
      skid.add(w.lx, w.ly, w.lz, w.rx, w.ry, w.rz, lx, ly, lz, rx, ry, rz, a0, a1, sa, sb, t, w.tr, w.tg, w.tb, w.sheen);
      w.lx = lx;
      w.ly = ly;
      w.lz = lz;
      w.rx = rx;
      w.ry = ry;
      w.rz = rz;
      w.along = a1;
    }
    lastSkidBirth = t;
    w.pcx = cx;
    w.pcz = cz;
    w.lastS = s;
  };

  // ------------------------------------------------------------ per-wheel pass
  const findSlice = (objects: readonly SimObjectSlice[], id: number): SimObjectSlice | null => {
    for (let i = 0; i < objects.length; i++) if (objects[i]!.objectId === id) return objects[i]!;
    return null;
  };

  const updateVehicle = (v: VehicleFx, frame: WorldFrame, t0: number, t1: number, dtSim: number): void => {
    const slice = findSlice(frame.objects, v.id);
    const tel = opts.telemetry(v.id);
    const nodes = frame.nodes;
    if (!slice || !tel || !frame.interpolated) {
      for (const w of v.wheels) {
        w.valid = false;
        w.prevValid = false;
        w.strip = 0;
      }
      return;
    }
    const base = slice.nodeOffset * 3;
    v.vx = tel[VehicleTelemetry.velX] ?? 0;
    v.vy = tel[VehicleTelemetry.velY] ?? 0;
    v.vz = tel[VehicleTelemetry.velZ] ?? 0;
    {
      const det = (tel[VehicleTelemetry.wheelsDetached] ?? 0) | 0;
      const con = (tel[VehicleTelemetry.wheelContact] ?? 0) | 0;
      v.grounded = (~det & 15) !== 0 && (con | det) === 15;
      v.groundY = sampler.heightAt(tel[VehicleTelemetry.comX] ?? 0, tel[VehicleTelemetry.comZ] ?? 0);
    }
    const oi = base + v.frameO * 3;
    const fi = base + v.frameF * 3;
    let fx = nodes[fi]! - nodes[oi]!;
    let fz = nodes[fi + 2]! - nodes[oi + 2]!;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl > 1e-6) {
      fx /= fl;
      fz /= fl;
    } else {
      fx = 0;
      fz = -1;
    }
    for (const w of v.wheels) {
      const hi = base + w.hubI * 3;
      const ho = base + w.hubO * 3;
      const Hx = (nodes[hi]! + nodes[ho]!) * 0.5;
      const Hy = (nodes[hi + 1]! + nodes[ho + 1]!) * 0.5;
      const Hz = (nodes[hi + 2]! + nodes[ho + 2]!) * 0.5;
      let ax = nodes[ho]! - nodes[hi]!;
      let ay = nodes[ho + 1]! - nodes[hi + 1]!;
      let az = nodes[ho + 2]! - nodes[hi + 2]!;
      const al = Math.sqrt(ax * ax + ay * ay + az * az);
      if (!(al > 1e-6) || !Number.isFinite(Hx + Hy + Hz)) {
        w.valid = false;
        w.strip = 0;
        continue;
      }
      ax /= al;
      ay /= al;
      az /= al;
      sampler.normalAt(Hx, Hz, nrm);
      const dn = ax * nrm[0]! + ay * nrm[1]! + az * nrm[2]!;
      let dx = -(nrm[0]! - ax * dn);
      let dy = -(nrm[1]! - ay * dn);
      let dz = -(nrm[2]! - az * dn);
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const cx = Hx + dx * w.radius;
      const cy = Hy + dy * w.radius;
      const cz = Hz + dz * w.radius;
      w.px = w.hx;
      w.py = w.hy;
      w.pz = w.hz;
      w.prevValid = w.valid;
      const prevCx = w.cx;
      const prevCy = w.cy;
      const prevCz = w.cz;
      w.hx = Hx;
      w.hy = Hy;
      w.hz = Hz;
      w.cx = cx;
      w.cy = cy;
      w.cz = cz;
      w.valid = true;
      const c = w.corner;
      if (c < 0) continue;
      const detached = cornerFlag(tel, VehicleTelemetry.wheelsDetached, c);
      const contact = !detached && cornerFlag(tel, VehicleTelemetry.wheelContact, c);
      const slip = tel[WHEEL_SLIP_SLOTS[c]!] ?? 0;
      const load = tel[WHEEL_LOAD_SLOTS[c]!] ?? 0;
      const omega = tel[WHEEL_OMEGA_SLOTS[c]!] ?? 0;
      const th = sampler.heightAt(cx, cz);
      const onObj = cy - th > 0.25;
      const mat = onObj ? MaterialId.concrete : sampler.materialAt(cx, cz);
      const groundY = onObj ? cy : th;
      let gvx = 0;
      let gvz = 0;
      const moveOk = w.prevValid && dtSim > 1e-4;
      if (moveOk) {
        gvx = (Hx - w.px) / dtSim;
        gvz = (Hz - w.pz) / dtSim;
        w.wvx = gvx;
        w.wvy = (Hy - w.py) / dtSim;
        w.wvz = gvz;
      } else {
        w.wvx = v.vx;
        w.wvy = v.vy;
        w.wvz = v.vz;
      }
      w.groundY = groundY;
      w.upright = ay * ay < 0.25 && Hy - groundY < w.radius + 0.3;
      const gs = Math.sqrt(gvx * gvx + gvz * gvz);
      if (moveOk && gs > 120) {
        // teleport / reset: break strips, no emission across the jump
        w.strip = 0;
        w.prevValid = false;
        continue;
      }
      const fxFlags = wheelEffects(mat, slip, load, gs, contact);
      let ahx = ax;
      let ahz = az;
      const ahl = Math.sqrt(ahx * ahx + ahz * ahz) || 1;
      ahx /= ahl;
      ahz /= ahl;
      w.ahx = ahx;
      w.ahz = ahz;
      // ---- marks (hysteresis: brief dropouts below the thresholds keep the strip, fading)
      const markKind = fxFlags & WHEEL_SKID ? WHEEL_SKID : fxFlags & WHEEL_RUT ? WHEEL_RUT : 0;
      if (markKind !== 0) {
        let s: number;
        if (markKind === WHEEL_SKID) {
          s = skidStrength(slip, load);
          w.width = Math.max(0.06, sweptWidth(w.tread, PATCH_LENGTH_M, ahx, ahz, w.mx || -ahz, w.mz || ahx));
          w.tr = 0.22;
          w.tg = 0.22;
          w.tb = 0.24;
          w.sheen = 0.9;
        } else {
          const track = persistentTrack(mat);
          s = Math.max(rutStrength(slip, load), track * Math.min(Math.max(load / REF_LOAD, 0.4), 1.2));
          const tint = rutTint(mat);
          w.width = Math.max(0.1, sweptWidth(w.tread * 1.2, PATCH_LENGTH_M * 1.4, ahx, ahz, w.mx || -ahz, w.mz || ahx));
          w.tr = tint[0];
          w.tg = tint[1];
          w.tb = tint[2];
          w.sheen = track > 0 ? -1 : 0.15;
        }
        if (w.strip !== markKind) {
          // start where the wheel was last frame (slow frames would otherwise lose a whole frame of path)
          const ox = moveOk ? prevCx : cx;
          const oz = moveOk ? prevCz : cz;
          const ddx = cx - ox;
          const ddz = cz - oz;
          const dd = Math.sqrt(ddx * ddx + ddz * ddz);
          openStrip(w, markKind, ox, moveOk ? prevCy : cy, oz, dd > 0.05 ? ddx / dd : -ahz, dd > 0.05 ? ddz / dd : ahx, onObj);
        }
        w.offT = 0;
        extendStrip(w, s, t1, onObj);
        if (markKind === WHEEL_SKID && moveOk && gs < STAMP_MAX_SPEED) {
          w.stampT += dtSim;
          if (w.stampT >= STAMP_S) {
            const n = Math.floor(w.stampT / STAMP_S);
            w.stampT -= n * STAMP_S;
            stampPatch(w, Math.min(1, 0.45 * n) * s, t1, fx, fz, onObj);
            lastSkidBirth = t1;
          }
        } else {
          w.stampT = 0;
        }
      } else if (w.strip !== 0) {
        w.offT += dtSim;
        extendStrip(w, 0, t1, onObj);
        if (w.offT > 0.35 && (w.lastS <= 0.001 || w.offT > 2)) w.strip = 0;
      }
      if (!moveOk) continue;
      // ---- particles (births spread over [t0, t1], positions lerped prev → current contact)
      const spin = omega >= 0 ? 1 : -1;
      if (fxFlags & WHEEL_SMOKE) {
        // Puffs are spent by MASS (rate × time) but laid at least every SMOKE_SPACING_M along the
        // contact path: a fast car at a low rate otherwise left discrete puffs metres apart. Extra
        // puffs share the mass (lower opacity each), so the amount of smoke is unchanged.
        w.smokeAcc += smokeRate(slip, load) * rateScale * dtSim;
        const pdx = cx - prevCx;
        const pdz = cz - prevCz;
        w.smokeDist += Math.sqrt(pdx * pdx + pdz * pdz) / smokeSpacing;
        let n = Math.floor(Math.max(w.smokeAcc, w.smokeDist));
        let opK = 1;
        if (n > 0) {
          opK = Math.min(1, w.smokeAcc / n);
          w.smokeAcc = Math.max(0, w.smokeAcc - n * opK);
          w.smokeDist = Math.max(0, w.smokeDist - n);
        }
        n = Math.min(n, 48);
        const heat = Math.min(1, (slip - 3) / 5);
        // Cloud density budget: the opacity a wheel may feed into its LOCAL cloud per sim second.
        // A standing burnout feeds one spot (only wind + rise carry smoke away); a moving wheel
        // spreads the same smoke along its path, so its allowance grows with ground speed.
        // feed counts optical cross-section (opacity × puff area): small budgets draw bigger puffs
        const feed = smokeRate(slip, load) * rateScale * 0.72 * (0.45 + 0.55 * heat) * smokeArea;
        const budgetK = Math.min(1, (SMOKE_OPACITY_RATE * (1 + 0.5 * gs)) / Math.max(feed, 1e-6));
        const ej = Math.min(slip, 28) * 0.12 * spin;
        const big = 0.75 + 0.5 * Math.min(slip / 18, 1);
        for (let k = 0; k < n; k++) {
          const f = (k + rng.float()) / n;
          const px = prevCx + (cx - prevCx) * f + (rng.float() - 0.5) * 0.3;
          const pz = prevCz + (cz - prevCz) * f + (rng.float() - 0.5) * 0.3;
          const py = prevCy + (cy - prevCy) * f + 0.12;
          setSpawn(
            px, py, pz,
            v.vx * 0.15 - fx * ej + (rng.float() - 0.5) * 1.4,
            0.25 + rng.float() * 0.7,
            v.vz * 0.15 - fz * ej + (rng.float() - 0.5) * 1.4,
          );
          const grey = 0.72 + rng.float() * 0.12;
          // dense young puffs that grow, thin out (shader: opacity ~ (s0/s)^0.55) and dissipate
          spawnSoft(
            K_SMOKE, t0 + (t1 - t0) * f, 4.5 + rng.float() * 3,
            0.35 + rng.float() * 0.25, (2.0 + rng.float() * 1.6) * big,
            Math.min(0.999, (0.6 + rng.float() * 0.25) * (0.45 + 0.55 * heat) * opK * budgetK),
            grey * 0.97, grey * 0.985, grey * 1.03, groundY,
          );
        }
      }
      if (fxFlags & WHEEL_SPRAY) {
        w.sprayAcc += sprayRate(slip) * rateScale * dtSim;
        let n = Math.floor(w.sprayAcc);
        w.sprayAcc -= n;
        n = Math.min(n, 30);
        const ej = Math.min(slip, 22) * 0.45 * spin;
        const dc = dustColor(mat);
        for (let k = 0; k < n; k++) {
          const f = (k + rng.float()) / n;
          const px = prevCx + (cx - prevCx) * f;
          const pz = prevCz + (cz - prevCz) * f;
          const py = prevCy + (cy - prevCy) * f;
          const tb = t0 + (t1 - t0) * f;
          clods(mat, px, py, pz, v.vx * 0.4 - fx * ej, 1.2 + Math.min(slip, 15) * 0.18, v.vz * 0.4 - fz * ej, 1, tb, 2.2);
          if (k % 2 === 0 && mat !== MaterialId.grass) {
            setSpawn(px, py + 0.15, pz, v.vx * 0.3 - fx * ej * 0.4 + (rng.float() - 0.5), 0.5 + rng.float(), v.vz * 0.3 - fz * ej * 0.4 + (rng.float() - 0.5));
            spawnSoft(K_DUST, tb, 2 + rng.float() * 2.5, 0.35, 1.8 + rng.float() * 1.6, 0.3 + rng.float() * 0.15, dc[0], dc[1], dc[2], groundY);
          }
        }
      }
      if (fxFlags & WHEEL_ROOST) {
        w.roostAcc += roostRate(gs, slip) * rateScale * dtSim;
        let n = Math.floor(w.roostAcc);
        w.roostAcc -= n;
        n = Math.min(n, 30);
        const dc = dustColor(mat);
        const inv = 1 / (gs || 1);
        for (let k = 0; k < n; k++) {
          const f = (k + rng.float()) / n;
          const px = prevCx + (cx - prevCx) * f;
          const pz = prevCz + (cz - prevCz) * f;
          const py = prevCy + (cy - prevCy) * f + 0.2;
          const tb = t0 + (t1 - t0) * f;
          setSpawn(
            px - gvx * inv * 0.3, py, pz - gvz * inv * 0.3,
            gvx * 0.3 + (rng.float() - 0.5) * 2, 0.6 + rng.float() * 1.4, gvz * 0.3 + (rng.float() - 0.5) * 2,
          );
          const k2 = 0.9 + rng.float() * 0.2;
          if (rng.float() < 0.22) spawnSoft(K_HAZE, tb, 7 + rng.float() * 5, 1.2, 5 + rng.float() * 3, 0.12 + rng.float() * 0.06, dc[0] * k2, dc[1] * k2, dc[2] * k2, groundY);
          else spawnSoft(K_DUST, tb, 2.8 + rng.float() * 3, 0.5, 2.6 + rng.float() * 2, 0.3 + rng.float() * 0.18, dc[0] * k2, dc[1] * k2, dc[2] * k2, groundY);
          if (mat === MaterialId.gravel && rng.float() < 0.5) clods(mat, px, py - 0.15, pz, gvx * 0.5, 1.5, gvz * 0.5, 1, tb, 2.5);
        }
      }
    }
  };

  /**
   * Is (x, y, z) a TYRE contact of the event object's OWN vehicle? Events
   * were generated between the previous and the latest snapshot while hubs
   * are at the (earlier) interpolated render time — under a slow main thread
   * snapshots thin out and that window grows to tenths of a second. Two
   * tests, either suffices:
   *  - capsule: the hub swept along its own velocity over the window,
   *    radius + FX_TYRE_CLASSIFY_MARGIN;
   *  - band: an upright wheel near the ground and an event at ground level
   *    within the tyre's lateral band (axle direction, insensitive to the
   *    longitudinal lag) and within the swept longitudinal reach.
   */
  let lagLo = 0;
  let lagHi = 0.03;
  const isTyreContact = (v: VehicleFx | undefined, x: number, y: number, z: number): boolean => {
    if (!v) return false;
    const lo = lagLo - 0.03;
    const hi = lagHi + 0.03;
    // Slow main thread (render pose ≫ one snapshot behind): positions cannot separate tyre from
    // body, so a ground-level event of a car standing on all its wheels counts as a tyre.
    if (hi - lo > 0.16 && v.grounded && y - v.groundY < 0.25) return true;
    for (const w of v.wheels) {
      if (!w.valid) continue;
      const r = w.radius + FX_TYRE_CLASSIFY_MARGIN;
      const ax = w.wvx * lo;
      const ay = w.wvy * lo;
      const az = w.wvz * lo;
      const ex = w.wvx * (hi - lo);
      const ey = w.wvy * (hi - lo);
      const ez = w.wvz * (hi - lo);
      const l2 = ex * ex + ey * ey + ez * ez;
      const qx = x - (w.hx + ax);
      const qy = y - (w.hy + ay);
      const qz = z - (w.hz + az);
      let f = l2 > 1e-9 ? (qx * ex + qy * ey + qz * ez) / l2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const rx = qx - ex * f;
      const ry = qy - ey * f;
      const rz = qz - ez * f;
      if (rx * rx + ry * ry + rz * rz <= r * r) return true;
      if (w.upright && y - w.groundY < 0.18) {
        const dx = x - w.hx;
        const dz = z - w.hz;
        const lat = dx * w.ahx + dz * w.ahz;
        const lon = Math.abs(-dx * w.ahz + dz * w.ahx);
        const sp = Math.sqrt(w.wvx * w.wvx + w.wvz * w.wvz);
        const reach = r + 0.1 + sp * Math.max(Math.abs(lo), Math.abs(hi));
        if (Math.abs(lat) <= w.tread * 0.5 + 0.2 && lon <= reach) return true;
      }
    }
    return false;
  };
  const moverSurface = (id: number): number => {
    const s = id >= 0 && id < MAX_OBJECT_ID ? surfaces[id]! : 0;
    return s === 0 ? SURF_METAL : s - 1;
  };

  /** Pale scrape mark: links to the nearest recent scrape point of the same object. */
  const scrapeMark = (id: number, x: number, y: number, z: number, t: number): void => {
    let best = -1;
    let bestD = 0.9 * 0.9;
    for (let k = 0; k < SCR; k++) {
      const o = k * 6;
      if (scr[o + 5] !== 1 || scr[o + 4] !== id || t - scr[o + 3]! > 0.25) continue;
      const dx = x - scr[o]!;
      const dz = z - scr[o + 2]!;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.0025 && d2 < bestD) {
        bestD = d2;
        best = k;
      }
    }
    if (best >= 0) {
      const o = best * 6;
      const ax = scr[o]!;
      const az = scr[o + 2]!;
      const dx = x - ax;
      const dz = z - az;
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      const hw = 0.035;
      const px = (-dz / l) * hw;
      const pz = (dx / l) * hw;
      const y1a = edgeY(x - px, z - pz, false, 0, 63);
      if (Math.abs(y - y1a) < 0.6) {
        const y0a = edgeY(ax - px, az - pz, false, 0, 63);
        const y0b = edgeY(ax + px, az + pz, false, 0, 63);
        const y1b = edgeY(x + px, z + pz, false, 0, 63);
        skid.add(ax - px, y0a, az - pz, ax + px, y0b, az + pz, x - px, y1a, z - pz, x + px, y1b, z + pz, 0, l, 0.8, 0.8, t, 1.32, 1.3, 1.27, 0);
        lastSkidBirth = t;
      }
      scr[o + 5] = 0; // consumed: the trail continues from the new point
    }
    const o = scrNext * 6;
    scrNext = (scrNext + 1) % SCR;
    scr[o] = x;
    scr[o + 1] = y;
    scr[o + 2] = z;
    scr[o + 3] = t;
    scr[o + 4] = id;
    scr[o + 5] = 1;
  };

  const processEvents = (t: number): void => {
    let sparkLeft = Math.max(8, sparks.capacity >> 1);
    let debrisLeft = Math.max(4, Math.round((chunks.capacity + flakes.capacity) / 10));
    for (let i = 0; i < impN; i++) {
      const o = i * 9;
      const id = impQ[o]!;
      const mat = impQ[o + 1]!;
      const x = impQ[o + 2]!;
      const y = impQ[o + 3]!;
      const z = impQ[o + 4]!;
      const nx = impQ[o + 5]!;
      const ny = impQ[o + 6]!;
      const nz = impQ[o + 7]!;
      const imp = impQ[o + 8]!;
      if (!Number.isFinite(x + y + z + nx + ny + nz + imp)) continue;
      const v = vehicleById.get(id);
      const mover = isTyreContact(v, x, y, z) ? SURF_TYRE : moverSurface(id);
      const eff = impactEffect(mover, mat, imp);
      const vx = v ? v.vx : 0;
      const vy = v ? v.vy : 0;
      const vz = v ? v.vz : 0;
      if (eff === IMPACT_SPARKS) {
        if (sparkLeft > 0) {
          const n = Math.min(sparkBurstCount(imp), sparkLeft);
          sparkLeft -= n;
          sparkBurst(x, y, z, nx, ny, nz, vx, vy, vz, n, t);
        }
        if (rng.float() < 0.5) dustPuff(x, y, z, MaterialId.concrete, 1, 0.5, t);
      } else if (eff === IMPACT_CLOD) {
        clods(mat, x, y, z, nx * 1.5 + vx * 0.2, 1.5 + Math.min(imp, 60) * 0.05, nz * 1.5 + vz * 0.2, Math.min(3 + Math.round(imp * 0.15), 14), t, 3);
        dustPuff(x, y, z, mat, 2, 0.7, t);
      } else if (eff === IMPACT_CHIPS) {
        const surf = mover === SURF_TYRE || mover === SURF_METAL || mover === SURF_CONCRETE ? objectMaterialSurface(mat) : mover;
        chipsOf(surf, x, y, z, vx, vy, vz, Math.min(2 + Math.round(imp * 0.2), 10), t, null);
      }
    }
    impN = 0;
    for (let i = 0; i < brkN && debrisLeft > 0; i++) {
      const o = i * 4;
      const id = brkQ[o]!;
      const x = brkQ[o + 1]!;
      const y = brkQ[o + 2]!;
      const z = brkQ[o + 3]!;
      if (!Number.isFinite(x + y + z)) continue;
      debrisLeft--;
      const v = vehicleById.get(id);
      if (v) {
        const r = rng.float();
        const c = r < 0.55 ? v.paint : r < 0.85 ? PLASTIC_BLACK : METAL_GREY;
        const s = 2.5;
        chunks.spawn(
          x, y, z,
          v.vx * 0.6 + (rng.float() - 0.5) * s, v.vy * 0.4 + rng.float() * s, v.vz * 0.6 + (rng.float() - 0.5) * s,
          0.03 + rng.float() * 0.06, 9 + rng.float() * 8, rng, c[0], c[1], c[2],
        );
        if (rng.float() < 0.5) chipsOf(SURF_METAL, x, y, z, v.vx, v.vy, v.vz, 2, t, v.paint);
        if (rng.float() < 0.35 && sparkLeft > 3) {
          sparkBurst(x, y, z, 0, 1, 0, v.vx, v.vy, v.vz, 3, t);
          sparkLeft -= 3;
        }
      } else {
        const surf = moverSurface(id);
        const c = surfaceColor(surf, rng.float());
        const flat = surf === SURF_CARDBOARD || surf === SURF_WOOD || surf === SURF_PLASTIC;
        const pool = flat ? flakes : chunks;
        const size = surf === SURF_CONCRETE ? 0.05 + rng.float() * 0.08 : flat ? 0.06 + rng.float() * 0.1 : 0.03 + rng.float() * 0.05;
        pool.spawn(x, y, z, (rng.float() - 0.5) * 3, 1 + rng.float() * 2.5, (rng.float() - 0.5) * 3, size, 10 + rng.float() * 8, rng, c[0], c[1], c[2]);
        chipsOf(surf, x, y, z, 0, 0, 0, 3, t, null);
        if (surf === SURF_CONCRETE) dustPuff(x, y, z, MaterialId.concrete, 2, 0.6, t);
      }
    }
    brkN = 0;
    for (let i = 0; i < skN; i++) {
      const o = i * 7;
      const id = skQ[o]!;
      const mat = skQ[o + 1]!;
      const x = skQ[o + 2]!;
      const y = skQ[o + 3]!;
      const z = skQ[o + 4]!;
      const slip = skQ[o + 5]!;
      const load = skQ[o + 6]!;
      if (!Number.isFinite(x + y + z + slip + load)) continue;
      const v = vehicleById.get(id);
      if (isTyreContact(v, x, y, z)) continue; // tyres: telemetry path
      const mover = moverSurface(id);
      const eff = scrapeEffect(mover, mat, slip, load);
      const vx = v ? v.vx : 0;
      const vy = v ? v.vy : 0;
      const vz = v ? v.vz : 0;
      if (eff === SCRAPE_SPARKS) {
        if (sparkLeft > 0) {
          const n = Math.min(Math.round(4 + Math.min(slip, 30) * 0.5 + Math.min(load, 6000) / 1000), sparkLeft);
          sparkLeft -= n;
          sparkBurst(x, y, z, 0, 0.6, 0, vx, vy, vz, n, t);
        }
        scrapeMark(id, x, y, z, t);
      } else if (eff === SCRAPE_DUST) {
        if (rng.float() < 0.35) dustPuff(x, y, z, groundClass(mat) === GROUND_OBJECT ? MaterialId.concrete : mat, 1, 0.5, t);
      } else if (eff === SCRAPE_CHIPS) {
        if (rng.float() < 0.4) chipsOf(mover, x, y, z, vx, vy, vz, 1, t, null);
      }
    }
    skN = 0;
  };

  // ------------------------------------------------------------ water (main-derived, contract decision)
  const water = opts.water;
  const splash = (x: number, level: number, z: number, I: number, v: number, t: number): void => {
    const nDrops = Math.min(Math.round((10 + I * 0.5) * Math.max(rateScale, 0.4)), 120);
    const radius = Math.min(0.4 + Math.sqrt(I) * 0.08, 2.5);
    for (let i = 0; i < nDrops; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = radius * (0.6 + 0.5 * rng.float());
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const up = Math.min(2 + v * 0.8 + rng.float() * 3, 11);
      setSpawn(x + ca * r * 0.5, level + 0.05, z + sa * r * 0.5, ca * (1 + rng.float() * 2.5), up, sa * (1 + rng.float() * 2.5));
      if (i % 3 === 0) spawnSoft(K_SHEET, t, 0.9 + rng.float() * 0.6, 0.12, 0.45 + rng.float() * 0.4, 0.45, 0.82, 0.88, 0.9, level);
      else spawnBit(B_DROP, t, 1.2 + rng.float() * 0.8, 0.015 + rng.float() * 0.02, 0.75, 0.82, 0.86, level, 0);
    }
    for (let i = 0; i < 3; i++) {
      setSpawn(x, level, z, 0, 0, 0);
      spawnSoft(K_RING, t + i * 0.12, 1.6 + rng.float() * 0.6, radius * 0.4, radius * (2.2 + i * 0.6), 0.6, 0.9, 0.95, 1.0, level);
    }
    for (let i = 0; i < 3; i++) {
      setSpawn(x + (rng.float() - 0.5) * radius, level + 0.2, z + (rng.float() - 0.5) * radius, (rng.float() - 0.5) * 1.5, 1 + rng.float() * 1.5, (rng.float() - 0.5) * 1.5);
      spawnSoft(K_SPRAY, t, 1.4 + rng.float(), 0.4, 1.6 + rng.float(), 0.28, 0.85, 0.9, 0.93, level);
    }
  };
  const wake = (id: number, x: number, level: number, z: number, vx: number, vz: number, speed: number, n: number, t0: number, t1: number, dtSim: number): void => {
    const idx = id < MAX_OBJECT_ID ? id : 0;
    wakeAcc[idx] = wakeAcc[idx]! + Math.min(speed * Math.sqrt(n) * 1.6, 160) * rateScale * dtSim;
    let m = Math.floor(wakeAcc[idx]!);
    wakeAcc[idx] = wakeAcc[idx]! - m;
    m = Math.min(m, 40);
    const inv = 1 / (speed || 1);
    for (let i = 0; i < m; i++) {
      const tb = t0 + (t1 - t0) * rng.float();
      const side = rng.float() < 0.5 ? -1 : 1;
      const px = x + (rng.float() - 0.5) * 1.5;
      const pz = z + (rng.float() - 0.5) * 1.5;
      const ox = -vz * inv * side;
      const oz = vx * inv * side;
      setSpawn(px, level + 0.05, pz, vx * 0.4 + ox * (1 + rng.float() * 2), 1.5 + rng.float() * Math.min(speed * 0.35, 5), vz * 0.4 + oz * (1 + rng.float() * 2));
      if (i % 2 === 0) spawnSoft(K_SPRAY, tb, 1.1 + rng.float() * 0.8, 0.2, 0.9 + rng.float() * 0.8, 0.3, 0.84, 0.9, 0.93, level);
      else spawnBit(B_DROP, tb, 1 + rng.float() * 0.6, 0.012 + rng.float() * 0.015, 0.75, 0.82, 0.86, level, 0);
    }
  };
  const updateWater = (frame: WorldFrame, t0: number, t1: number, dtSim: number): void => {
    if (water.length === 0 || !frame.interpolated) return;
    frameIndex++;
    const nodes = frame.nodes;
    if (prevPos.length < nodes.length) {
      const grown = new Float32Array(nodes.length);
      grown.set(prevPos);
      prevPos = grown;
    }
    for (let oi = 0; oi < frame.objects.length; oi++) {
      const ob = frame.objects[oi]!;
      if (ob.flags & OBJECT_FLAG_SLEEPING) continue;
      const id = ob.objectId;
      const b0 = ob.nodeOffset * 3;
      const nN = ob.nodeCount;
      if (nN === 0) continue;
      // coarse reject: first + middle node vs every body (8 m margin)
      let near = false;
      for (let wi = 0; wi < water.length && !near; wi++) {
        const wb = water[wi]!;
        for (let s = 0; s < 2; s++) {
          const j = b0 + (s === 0 ? 0 : (nN >> 1) * 3);
          const x = nodes[j]!;
          const y = nodes[j + 1]!;
          const z = nodes[j + 2]!;
          if (x > wb.minX - 8 && x < wb.maxX + 8 && z > wb.minZ - 8 && z < wb.maxZ + 8 && y < wb.level + 6) near = true;
        }
      }
      const idx = id < MAX_OBJECT_ID ? id : 0;
      if (!near) {
        nearFrame[idx] = -10;
        continue;
      }
      const hasPrev = nearFrame[idx] === frameIndex - 1 && dtSim > 1e-4;
      nearFrame[idx] = frameIndex;
      let splashN = 0;
      let splashV = 0;
      let sx = 0;
      let sz = 0;
      let level = 0;
      let wakeN = 0;
      let wakeV = 0;
      let wx = 0;
      let wz = 0;
      let wvx = 0;
      let wvz = 0;
      for (let k = 0; k < nN; k++) {
        const j = b0 + k * 3;
        const x = nodes[j]!;
        const y = nodes[j + 1]!;
        const z = nodes[j + 2]!;
        if (hasPrev) {
          for (let wi = 0; wi < water.length; wi++) {
            const wb = water[wi]!;
            if (x < wb.minX || x > wb.maxX || z < wb.minZ || z > wb.maxZ) continue;
            const L = wb.level;
            const py = prevPos[j + 1]!;
            if (py >= L && y < L) {
              const vy = (py - y) / dtSim;
              if (vy >= FX_SPLASH_SPEED) {
                splashN++;
                splashV += vy;
                sx += x;
                sz += z;
                level = L;
              }
            } else if (y < L && y > L - 1.2) {
              const vx = (x - prevPos[j]!) / dtSim;
              const vz = (z - prevPos[j + 2]!) / dtSim;
              const hs = Math.sqrt(vx * vx + vz * vz);
              if (hs >= FX_WAKE_SPEED) {
                wakeN++;
                wakeV += hs;
                wx += x;
                wz += z;
                wvx += vx;
                wvz += vz;
                level = L;
              }
            }
            break;
          }
        }
        prevPos[j] = x;
        prevPos[j + 1] = y;
        prevPos[j + 2] = z;
      }
      if (splashN > 0) {
        const vMean = splashV / splashN;
        splash(sx / splashN, level, sz / splashN, Math.min(splashN * vMean, 600), vMean, t1);
      }
      if (wakeN > 0) {
        const inv = 1 / wakeN;
        wake(id, wx * inv, level, wz * inv, wvx * inv, wvz * inv, wakeV * inv, wakeN, t0, t1, dtSim);
      }
    }
  };

  // ------------------------------------------------------------ lighting uniforms
  const updateLight = (): void => {
    light.uSunDir.value.copy(lighting.sunDirection);
    const s = lighting.sun;
    light.uSunColor.value.set(s.color.r, s.color.g, s.color.b).multiplyScalar(s.intensity);
    const fog = ctx.scene.fog as FogExp2 | null;
    if (fog && fog.color) {
      light.uSkyAmb.value.set(fog.color.r, fog.color.g, fog.color.b).multiplyScalar(1.35);
      light.uGroundAmb.value.set(fog.color.r * 0.45, fog.color.g * 0.4, fog.color.b * 0.32);
    }
  };

  // ------------------------------------------------------------ stats (computed on read)
  const stats: FxStats = {
    get particles(): number {
      return soft.live(now) + bits.live(now) + sparks.live(now);
    },
    get debris(): number {
      return chunks.live + flakes.live;
    },
    get skidSegments(): number {
      return skid.live(now);
    },
    get drawCalls(): number {
      let n = 0;
      for (const m of drawn) if (m.visible) n++;
      return n;
    },
  };

  /** Everything but the skidmarks (P7 replay seeks keep them). */
  const clearTransient = (): void => {
    soft.clear();
    bits.clear();
    sparks.clear();
    chunks.clear();
    flakes.clear();
    impN = brkN = skN = 0;
    scr.fill(0);
    for (const v of vehicles) {
      for (const w of v.wheels) {
        w.strip = 0;
        w.valid = w.prevValid = false;
        w.smokeAcc = w.smokeDist = w.sprayAcc = w.roostAcc = w.stampT = 0;
      }
    }
    lastDeathSoft = lastDeathBits = lastDeathSparks = -1e9;
  };

  const sys: FxSystem = {
    object,
    stats,
    update(frame: WorldFrame): void {
      const t1 = frame.simTime;
      if (!Number.isFinite(t1)) return;
      let t0 = lastSim;
      if (!Number.isFinite(t0) || t1 < t0 || t1 - t0 > 0.5) t0 = t1;
      const dtSim = t1 - t0;
      lastSim = t1;
      now = t1;
      // snapshot-time window of this frame's events relative to the render pose (see isTyreContact)
      const latest = frame.tick * SIM_DT;
      const hi = Math.min(Math.max(latest - t1, 0), 1);
      lagHi = hi + 0.012;
      lagLo = Math.min(Number.isFinite(prevLatest) ? Math.min(Math.max(prevLatest - t1, -0.1), hi) : hi - 0.1, 0) - 0.012;
      prevLatest = latest;
      for (let i = 0; i < vehicles.length; i++) updateVehicle(vehicles[i]!, frame, t0, t1, dtSim);
      {
        const focus = (soft.mesh.material.uniforms.uFocus as { value: Vector4 }).value;
        focus.w = 0;
        const pv = vehicles[0];
        if (pv) {
          let n = 0;
          let x = 0;
          let y = 0;
          let z = 0;
          for (const w of pv.wheels) {
            if (!w.valid) continue;
            x += w.hx;
            y += w.hy;
            z += w.hz;
            n++;
          }
          if (n > 0) focus.set(x / n, y / n + 0.4, z / n, FOCUS_RADIUS_M);
        }
      }
      processEvents(t1);
      updateWater(frame, t0, t1, dtSim);
      chunks.update(dtSim);
      flakes.update(dtSim);
      updateLight();
      // spark width floor: world metres per pixel at 1 m distance
      ctx.renderer.getDrawingBufferSize(bufSize);
      const p11 = frame.camera.projectionMatrix.elements[5]!;
      (sparks.mesh.material.uniforms.uPxWorld as { value: number }).value = 2 / (Math.max(p11, 1e-3) * Math.max(bufSize.y, 1));
      soft.flush(t1);
      bits.flush(t1);
      sparks.flush(t1);
      skid.flush(t1, lighting.sunDirection);
      soft.mesh.visible = soft.drawn > 0 && t1 < lastDeathSoft;
      bits.mesh.visible = bits.drawn > 0 && t1 < lastDeathBits;
      sparks.mesh.visible = sparks.drawn > 0 && t1 < lastDeathSparks;
      skid.mesh.visible = skid.drawn > 0 && t1 - lastSkidBirth < 60;
      chunks.mesh.visible = chunks.live > 0 && !debrisHidden;
      flakes.mesh.visible = flakes.live > 0 && !debrisHidden;
    },
    setQuality(nq): void {
      q = nq;
      const [a, b, c] = particleCaps(nq.particleBudget);
      soft.resize(a);
      bits.resize(b);
      sparks.resize(c);
      skid.resize(nq.skidSegments);
      const [d0, d1] = debrisCaps(nq.debrisBudget);
      chunks.resize(d0);
      flakes.resize(d1);
      applyBudgetScales();
      for (const v of vehicles) for (const w of v.wheels) w.strip = 0;
    },
    onImpact(e): void {
      if (impN >= QUEUE) return;
      const o = impN++ * 9;
      impQ[o] = e.objectId;
      impQ[o + 1] = e.materialId;
      impQ[o + 2] = e.px;
      impQ[o + 3] = e.py;
      impQ[o + 4] = e.pz;
      impQ[o + 5] = e.nx;
      impQ[o + 6] = e.ny;
      impQ[o + 7] = e.nz;
      impQ[o + 8] = e.impulse;
    },
    onBeamBreak(e): void {
      if (brkN >= QUEUE) return;
      const o = brkN++ * 4;
      brkQ[o] = e.objectId;
      brkQ[o + 1] = e.px;
      brkQ[o + 2] = e.py;
      brkQ[o + 3] = e.pz;
    },
    onSkid(e): void {
      if (skN >= QUEUE) return;
      const o = skN++ * 7;
      skQ[o] = e.objectId;
      skQ[o + 1] = e.materialId;
      skQ[o + 2] = e.px;
      skQ[o + 3] = e.py;
      skQ[o + 4] = e.pz;
      skQ[o + 5] = e.slip;
      skQ[o + 6] = e.load;
    },
    addVehicle(objectId: number, compiled: CompiledVehicle): void {
      sys.removeObject(objectId);
      const rig = compiled.rig;
      const wheels: WheelFx[] = compiled.wheels.map((w) => {
        const a = w.tireStart;
        const b = w.tireStart + w.rays;
        const dx = rig.nodePos[b * 3]! - rig.nodePos[a * 3]!;
        const dy = rig.nodePos[b * 3 + 1]! - rig.nodePos[a * 3 + 1]!;
        const dz = rig.nodePos[b * 3 + 2]! - rig.nodePos[a * 3 + 2]!;
        const planes = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const tread = Math.max(0.08, planes + (rig.nodeRadius[a] ?? 0.04) * 1.5);
        return {
          corner: w.corner, hubI: w.hubI, hubO: w.hubO, radius: w.radius, tread, slot: hintSlots++ % 60,
          hx: 0, hy: 0, hz: 0, cx: 0, cy: 0, cz: 0, valid: false, px: 0, py: 0, pz: 0, prevValid: false,
          wvx: 0, wvy: 0, wvz: 0, ahx: 1, ahz: 0, upright: false, groundY: 0,
          strip: 0, offT: 0, width: 0.2, tr: 1, tg: 1, tb: 1, sheen: 0, pcx: 0, pcz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, mx: 0, mz: 0, along: 0, lastS: 0,
          smokeAcc: 0, smokeDist: 0, sprayAcc: 0, roostAcc: 0, stampT: 0,
        };
      });
      const v: VehicleFx = {
        id: objectId,
        wheels,
        paint: hexToLinear(VEHICLE_PAINT[compiled.name] ?? 0x6b6e72),
        frameO: compiled.frameNodes[0] ?? 0,
        frameF: compiled.frameNodes[1] ?? 0,
        vx: 0,
        vy: 0,
        vz: 0,
        grounded: false,
        groundY: 0,
      };
      vehicles.push(v);
      vehicleById.set(objectId, v);
      if (objectId >= 0 && objectId < MAX_OBJECT_ID) surfaces[objectId] = SURF_METAL + 1;
    },
    addProps(instances): void {
      for (const p of instances) if (p.objectId >= 0 && p.objectId < MAX_OBJECT_ID) surfaces[p.objectId] = surfaceCode(p.surface) + 1;
    },
    removeObject(objectId: number): void {
      const v = vehicleById.get(objectId);
      if (v) {
        vehicleById.delete(objectId);
        vehicles.splice(vehicles.indexOf(v), 1);
      }
      if (objectId >= 0 && objectId < MAX_OBJECT_ID) surfaces[objectId] = 0;
    },
    clearTransient(): void {
      clearTransient();
      lastSim = Number.NaN;
      prevLatest = Number.NaN;
      frameIndex++;
    },
    reseed(seed: number): void {
      rng = createRng(seed);
    },
    saveState(into?: FxState | null): FxState {
      const prev = into as FxSnapshot | null | undefined;
      const snap: FxSnapshot = {
        kind: 'fx',
        soft: soft.saveState(prev?.soft),
        bits: bits.saveState(prev?.bits),
        sparks: sparks.saveState(prev?.sparks),
        chunks: chunks.saveState(prev?.chunks),
        flakes: flakes.saveState(prev?.flakes),
        clocks: [lastSim, prevLatest, lastDeathSoft, lastDeathBits, lastDeathSparks, lastSkidBirth, now, scrNext, frameIndex],
        scr: scr.slice(),
        prevPos: prevPos.slice(),
        nearFrame: nearFrame.slice(),
        wakeAcc: wakeAcc.slice(),
        vehicles: vehicles.map((v) => ({ id: v.id, vx: v.vx, vy: v.vy, vz: v.vz, grounded: v.grounded, groundY: v.groundY, wheels: v.wheels.map((w) => ({ ...w })) })),
        debrisHidden,
      };
      return snap;
    },
    restoreState(st: FxState): void {
      const snap = st as FxSnapshot;
      soft.restoreState(snap.soft);
      bits.restoreState(snap.bits);
      sparks.restoreState(snap.sparks);
      chunks.restoreState(snap.chunks);
      flakes.restoreState(snap.flakes);
      [lastSim, prevLatest, lastDeathSoft, lastDeathBits, lastDeathSparks, lastSkidBirth, now, scrNext, frameIndex] = snap.clocks as [number, number, number, number, number, number, number, number, number];
      scr.set(snap.scr);
      if (prevPos.length !== snap.prevPos.length) prevPos = new Float32Array(snap.prevPos.length);
      prevPos.set(snap.prevPos);
      nearFrame.set(snap.nearFrame);
      wakeAcc.set(snap.wakeAcc);
      for (const sv of snap.vehicles) {
        const v = vehicleById.get(sv.id);
        if (!v || v.wheels.length !== sv.wheels.length) continue;
        v.vx = sv.vx;
        v.vy = sv.vy;
        v.vz = sv.vz;
        v.grounded = sv.grounded;
        v.groundY = sv.groundY;
        sv.wheels.forEach((w, k) => Object.assign(v.wheels[k]!, w));
      }
      impN = brkN = skN = 0;
      sys.setDebrisHidden(snap.debrisHidden);
    },
    setDebrisHidden(hidden: boolean): void {
      debrisHidden = hidden;
      if (hidden) {
        chunks.mesh.visible = false;
        flakes.mesh.visible = false;
      }
    },
    setSkidmarksFrozen(frozen: boolean): void {
      skid.frozen = frozen;
      if (!frozen) for (const v of vehicles) for (const w of v.wheels) w.strip = 0;
    },
    clear(): void {
      clearTransient();
      skid.clear();
      lastSkidBirth = -1e9;
    },
    dispose(): void {
      soft.dispose();
      softDepth.dispose();
      bits.dispose();
      sparks.dispose();
      skid.dispose();
      chunks.dispose();
      flakes.dispose();
      chunkMat.dispose();
      flakeMat.dispose();
      puff.dispose();
      object.removeFromParent();
    },
  };
  return sys;
};

export { SURF_PLASTIC };
