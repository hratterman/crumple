/**
 * Vehicle damage visuals (A4, P4) — contract: types.ts "DAMAGE DATA FLOW".
 *
 * Main-side, per vehicle:
 *   - PLASTIC STRAIN per node from rest-vs-current body-beam lengths at
 *     snapshot rate: raw → min over the last `strainPersist` snapshots
 *     (drops elastic transients) → deadzone/full remap → ratchet (never
 *     decreases until the repair epoch changes).
 *   - SCUFF per node from impact (and body-scrape skid) events: deposit
 *     impulse/scuffFullImpulse with a smooth falloff over scuffRadius.
 *   - BROKEN state from the snapshot bitset (authoritative) OR'd with fresh
 *     beamBreak events (early check; an event the bitset does not confirm
 *     within EVENT_CONFIRM_SNAPSHOTS is dropped once the sim is known to
 *     write the bitset) → node BROKEN flags, sticky panel detach, glass
 *     broken fractions.
 *   - GLASS crack / shatter per pane (strain over its beams, impulses near
 *     it, broken fraction) → per-panel crack uniforms + DamageFx.
 * and the 'dmg1' ShaderPatch (color target, after flexbody): crumple
 * creases (bump from rest-space ridged noise × strain), darkening and
 * roughening, paint scraped to primer then bare metal by scuff, clearcoat
 * stripped where scraped, grime at torn edges; glass panes get the
 * spiderweb overlay (shatter.ts GLASS_CRACK_GLSL).
 *
 * update() is allocation-free (preallocated typed arrays, reused FX records).
 */
import { ShaderChunk, Vector3, Vector4 } from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';

import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../../protocol/events';
import { RIG_BEAM_TYPE_ID, type CompiledRig } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { PatchTarget, ShaderPatch } from '../types';
import { GLASS_CRACK_GLSL } from './shatter';
import {
  DAMAGE_DEFAULTS,
  NODE_TEX_FLAG_BROKEN,
  NODE_TEX_FLAG_DETACHED,
  NODE_TEX_WIDTH,
  type BindingPanel,
  type BindingSet,
  type DamageFx,
  type FlexSkin,
  type VehicleDamage,
  type VehicleFrameInput,
  type VehicleVisualDef,
} from './types';

export const DAMAGE_PATCH_KEY = 'dmg1';

/** Event queues per update (beyond: dropped — they are FX/scuff, never state). */
const IMPACT_QUEUE = 1024;
const SKID_QUEUE = 2048;
const BREAK_QUEUE = 1024;
/** Snapshots a beamBreak event is trusted without bitset confirmation (sims that write the bitset). */
const EVENT_CONFIRM_SNAPSHOTS = 4;
/** Skid/impact events closer than this to a wheel node are tyre contacts, not body scrapes. */
const TYRE_EXCLUSION = 0.25;
/** Glass: an impact this far beyond the pane's current bounding sphere still counts. */
const GLASS_IMPACT_MARGIN = 0.2;
/** Second crack centre when a new hit lands this far (m, rest space) from the first. */
const CRACK_SECOND_CENTRE = 0.25;
const SKID_SCUFF_PER_EVENT = 0.02;
/** Scuff deposits re-centre on the nearest body node up to this far away (m). */
const SCUFF_SNAP = 0.9;
/**
 * Elastic allowance per beam, as a fraction of its yield strain
 * εy = beamDeform / (k·L0). The ω·dt stiffness budget keeps this sim's body
 * lattice soft: the settled sedan carries up to ~2 % STATIC elastic strain in
 * the engine bay (yield 4–10 %), so a bare 1 % deadzone would paint a
 * pristine car crumpled. A beam can only be loaded elastically up to εy
 * before the sim ratchets its rest length, so |L/L0 − 1| − 0.6·εy is ~ the
 * plastic part (conservative) and never fires on static / driving loads.
 */
export const ELASTIC_ALLOWANCE = 0.6;

export type DamageVariant = 'paint' | 'plastic' | 'glass';

export interface DamageTuning {
  strainDeadzone: number;
  strainFull: number;
  strainPersist: number;
  scuffRadius: number;
  scuffFullImpulse: number;
}

/** Concrete VehicleDamage with a few extras for FX / debug / tests. */
export interface VehicleDamageImpl extends VehicleDamage {
  /** Per node, 0..1 (ratcheted). */
  readonly strain: Float32Array;
  readonly scuff: Float32Array;
  /** Per node glass crack 0..1 (max over panes the node belongs to). */
  readonly crack: Float32Array;
  readonly nodeFlags: Uint8Array;
  /** Object-local effective broken flags (bitset ∪ unconfirmed fresh events). */
  readonly broken: Uint8Array;
  /** Body-node centroid velocity, world m/s (from snapshot-to-snapshot motion). */
  readonly comVelocity: Float64Array;
  /** Beam indices used for the strain estimate (intact-normal body beams that can yield). */
  readonly strainBeams: Int32Array;
  readonly panelCount: number;
  /** Diagnostics: impact events processed / dropped as tyre contacts / that reached no body node. */
  readonly stats: { impacts: number; tyre: number; missed: number; skids: number };
  /** Velocity accessor for createDamageFx. */
  velocity(out: Float64Array): void;
  /** Per-panel shader variant (null = no damage patch). */
  variantOf(panelIndex: number): DamageVariant | null;
  /** Debug: scales all damage shading (0 = pristine look, 1 = normal). */
  setShadingAmount(v: number): void;
  /** Crack uniforms of a glass panel (debug / dev harness), else null. */
  crackUniforms(panelIndex: number): CrackUniforms | null;
}

export interface CrackUniforms {
  uCrackA: { value: Vector4 };
  uCrackB: { value: Vector4 };
  uCrackU: { value: Vector3 };
  uCrackV: { value: Vector3 };
  uCrackSeed: { value: number };
}

// ====================================================================== pure helpers
/**
 * The detach 'boundary' rule (types.ts DetachSpec): every beam with EXACTLY
 * one endpoint in `bindNodes`, excluding 'support' beams and beams that can
 * never break. Ascending object-local beam indices. (The binder resolves
 * DetachSpec with this rule; exported for parity tests.)
 */
export function boundaryAttachBeams(rig: CompiledRig, bindNodes: ArrayLike<number>): Int32Array {
  const inSet = new Uint8Array(rig.nodeCount);
  for (let i = 0; i < bindNodes.length; i++) inSet[bindNodes[i]!] = 1;
  const out: number[] = [];
  const support = RIG_BEAM_TYPE_ID.support;
  for (let b = 0; b < rig.beamCount; b++) {
    if (rig.beamType[b] === support) continue;
    if (!Number.isFinite(rig.beamBreakF[b]!)) continue;
    if (inSet[rig.beamA[b]!]! + inSet[rig.beamB[b]!]! === 1) out.push(b);
  }
  return Int32Array.from(out);
}

/**
 * Beams whose length change is plastic body strain: body beams of type
 * 'normal' that can yield, between two BODY nodes (suspension links to the
 * wheel hubs carry large static loads and are not sheet metal).
 */
export function strainBeamSet(compiled: CompiledVehicle): Int32Array {
  const rig = compiled.rig;
  const out: number[] = [];
  const normal = RIG_BEAM_TYPE_ID.normal;
  const n = Math.min(compiled.bodyBeamCount, rig.beamCount);
  const bodyN = compiled.bodyNodeCount;
  for (let b = 0; b < n; b++) {
    if (rig.beamType[b] !== normal) continue;
    if (rig.beamA[b]! >= bodyN || rig.beamB[b]! >= bodyN) continue;
    if (!Number.isFinite(rig.beamDeform[b]!)) continue;
    if (!(rig.beamRestLen[b]! > 1e-6)) continue;
    out.push(b);
  }
  return Int32Array.from(out);
}

/** Per strain beam: ELASTIC_ALLOWANCE × yield strain (deform / (k·L0)), 0 when k ≤ 0. */
export function elasticSlack(rig: CompiledRig, beams: Int32Array): Float32Array {
  const out = new Float32Array(beams.length);
  for (let k = 0; k < beams.length; k++) {
    const b = beams[k]!;
    const kL = rig.beamK[b]! * rig.beamRestLen[b]!;
    out[k] = kL > 0 ? (ELASTIC_ALLOWANCE * rig.beamDeform[b]!) / kL : 0;
  }
  return out;
}

/** Damage shader variant for a panel (null = no patch). */
export function damageVariant(panel: Pick<BindingPanel, 'glass' | 'material' | 'damageWeight' | 'kind'>): DamageVariant | null {
  if (panel.glass || panel.material === 'glass') return 'glass';
  let w = 0;
  for (let i = 0; i < panel.damageWeight.length; i++) if (panel.damageWeight[i]! > w) w = panel.damageWeight[i]!;
  if (w <= 0) return null;
  return panel.material === 'paint' ? 'paint' : 'plastic';
}

// ====================================================================== GLSL
const DMG_COMMON = /* glsl */ `
uniform float uDmgAmount;
float dmgHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float dmgNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = dmgHash13(i);
  float b = dmgHash13(i + vec3(1.0, 0.0, 0.0));
  float c = dmgHash13(i + vec3(0.0, 1.0, 0.0));
  float d = dmgHash13(i + vec3(1.0, 1.0, 0.0));
  float e = dmgHash13(i + vec3(0.0, 0.0, 1.0));
  float g = dmgHash13(i + vec3(1.0, 0.0, 1.0));
  float h = dmgHash13(i + vec3(0.0, 1.0, 1.0));
  float k = dmgHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float dmgRidge(vec3 x) {
  return 1.0 - abs(dmgNoise(x) * 2.0 - 1.0);
}
// Surface-gradient bump (Mikkelsen) with UNnormalized screen derivatives:
// h in metres gives a true slope, independent of distance / resolution.
vec3 dmgBump(vec3 surfPos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  vec3 nn = abs(det) * n - grad;
  float l = length(nn);
  return l > 1e-12 ? nn / l : n;
}
`;

/** Shared prologue: damage inputs + crumple height + scrape masks (all variants). */
const DMG_INPUTS = /* glsl */ `
#ifdef FLEXBODY
  vec3 dmgP = vFlexRest;
  vec4 dmgD = vFlexDamage;
#else
  vec3 dmgP = vec3(0.0);
  vec4 dmgD = vec4(0.0);
#endif
  float dmgStrain = clamp(dmgD.x * uDmgAmount, 0.0, 1.0);
  float dmgScuff = clamp(dmgD.y * uDmgAmount, 0.0, 1.0);
  float dmgTorn = clamp(dmgD.w * uDmgAmount, 0.0, 1.0);
  float dmgPx = length(fwidth(dmgP));
`;

const DMG_SURFACE = /* glsl */ `
  float dmgW1 = clamp(1.0 - dmgPx * 15.0, 0.0, 1.0);
  float dmgW2 = clamp(1.0 - dmgPx * 17.0 * 1.5, 0.0, 1.0);
  float dmgW3 = clamp(1.0 - dmgPx * 41.0 * 1.5, 0.0, 1.0);
  // Sheet-metal folds. Rest space is the vehicle frame (z = length): frontal / rear crush
  // buckles panels into accordion ridges ACROSS z, so one fold family is stretched that way;
  // a second, isotropic family breaks it up; broad low-frequency dents ripple reflections.
  float dmgR1 = dmgRidge(dmgP * vec3(2.2, 3.0, 7.5) + 3.1);
  float dmgR1b = dmgRidge(dmgP * 5.5 + 9.7);
  float dmgR2 = dmgRidge(dmgP * 14.0 + 7.7);
  float dmgN3 = dmgNoise(dmgP * 41.0);
  float dmgDent = dmgNoise(dmgP * 2.6 + 1.3);
  // tent-like crests (ridged noise is sharp at the crest): faceted folds with a crisp light/dark split
  float dmgF1 = dmgR1 * dmgR1 * dmgR1;
  float dmgF1b = dmgR1b * dmgR1b * dmgR1b;
  float dmgF2 = dmgR2 * dmgR2;
  float dmgFold = max(dmgF1, 0.7 * dmgF1b) * dmgW1;
  float dmgH = dmgStrain * (0.008 * dmgFold + 0.0025 * dmgF2 * dmgW2 + 0.001 * dmgN3 * dmgW3 + 0.005 * dmgDent);
  // scrape streaks: long horizontal scratches (stretched along y) broken up by coarse noise
  float dmgWF = clamp(1.0 - dmgPx * 90.0, 0.0, 1.0);
  float dmgS1 = mix(0.5, dmgNoise(dmgP * vec3(2.0, 90.0, 2.0)), dmgWF);
  float dmgS2 = dmgNoise(dmgP * vec3(1.3, 24.0, 1.3) + 5.0);
  float dmgS3 = dmgNoise(dmgP * 4.0 + 11.0);
  float dmgStreak = 0.42 * dmgS1 + 0.36 * dmgS2 + 0.22 * dmgS3;
  float dmgCover = clamp(dmgScuff * 0.9 + max(dmgStrain - 0.6, 0.0) * 0.5 * dmgN3, 0.0, 1.0);
  float dmgT = 0.8 - 0.62 * dmgCover;
  float dmgOn = step(0.002, dmgCover);
  float dmgPrimer = smoothstep(dmgT, dmgT + 0.035, dmgStreak) * dmgOn;
  float dmgMetal = smoothstep(dmgT + 0.1, dmgT + 0.13, dmgStreak) * dmgOn;
  float dmgHalo = smoothstep(dmgT - 0.16, dmgT, dmgStreak) * dmgOn;
  dmgH -= 0.00025 * dmgPrimer + 0.0002 * dmgMetal;
`;

const DMG_PAINT = /* glsl */ `
  diffuseColor.rgb *= 1.0 - dmgStrain * (0.08 + 0.4 * dmgFold);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.2 + 0.035, dmgHalo * 0.6 * (1.0 - dmgPrimer));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.115, 0.12, 0.118) * (0.8 + 0.4 * dmgS2), dmgPrimer);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.6, 0.62) * (0.8 + 0.35 * dmgS1), dmgMetal);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.027, 0.024), clamp(0.5 * dmgTorn + 0.1 * dmgStrain, 0.0, 0.7));
  roughnessFactor = mix(roughnessFactor, 0.5, clamp(dmgStrain * 0.15 + dmgHalo * 0.7 + dmgTorn * 0.3, 0.0, 1.0));
  roughnessFactor = mix(roughnessFactor, 0.78, dmgPrimer);
  roughnessFactor = mix(roughnessFactor, 0.36 + 0.2 * dmgS1, dmgMetal);
  metalnessFactor = mix(metalnessFactor, 0.0, dmgPrimer);
  metalnessFactor = mix(metalnessFactor, 1.0, dmgMetal);
  float dmgCoatKill = clamp(max(dmgPrimer, dmgHalo * 0.8), 0.0, 1.0);
  float dmgCoatRough = 0.12 * dmgStrain + 0.3 * dmgTorn;
  normal = dmgBump(-vViewPosition, normal, dmgH, faceDirection);
`;

const DMG_PLASTIC = /* glsl */ `
  diffuseColor.rgb *= 1.0 - dmgStrain * (0.08 + 0.35 * dmgFold);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.165), dmgPrimer * 0.8);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.6 + 0.04, dmgHalo * 0.35 * (1.0 - dmgPrimer));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), 0.4 * dmgTorn);
  roughnessFactor = mix(roughnessFactor, 0.85, clamp(dmgPrimer + dmgStrain * 0.4 + dmgHalo * 0.3, 0.0, 1.0));
  metalnessFactor = mix(metalnessFactor, 0.0, dmgPrimer);
  float dmgCoatKill = dmgPrimer;
  float dmgCoatRough = 0.4 * dmgStrain;
  normal = dmgBump(-vViewPosition, normal, dmgH * 0.7, faceDirection);
`;

const DMG_GLASS = /* glsl */ `
  float dmgCrackM = dmgCrack(dmgP, dmgPx);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.54, 0.54), dmgCrackM);
  diffuseColor.a = mix(diffuseColor.a, 1.0, dmgCrackM * 0.9);
  roughnessFactor = mix(roughnessFactor, 0.4, dmgCrackM);
  metalnessFactor = mix(metalnessFactor, 0.0, dmgCrackM);
  float dmgCoatKill = dmgCrackM;
  float dmgCoatRough = 0.0;
`;

const ANCHOR_SURFACE = '#include <clearcoat_normal_fragment_begin>';
const ANCHOR_CC_MAPS = '#include <clearcoat_normal_fragment_maps>';
const ANCHOR_LIGHTS = '#include <lights_physical_fragment>';
const ANCHOR_TRANSMISSION = '#include <transmission_fragment>';

function insertBefore(src: string, anchor: string, code: string): string {
  return src.includes(anchor) ? src.replace(anchor, `${code}\n${anchor}`) : src;
}
function insertAfter(src: string, anchor: string, code: string): string {
  return src.includes(anchor) ? src.replace(anchor, `${anchor}\n${code}`) : src;
}

/** Fragment source transform for a variant (exported for headless GLSL tests). */
export function applyDamageGlsl(fragmentShader: string, variant: DamageVariant): string {
  let fs = fragmentShader;
  if (!fs.includes(ANCHOR_SURFACE)) return fs; // not a standard/physical shader: leave untouched
  const common = DMG_COMMON + (variant === 'glass' ? GLASS_CRACK_GLSL : '');
  fs = insertAfter(fs, '#include <common>', common);
  const body =
    variant === 'glass' ? DMG_INPUTS + DMG_GLASS : DMG_INPUTS + DMG_SURFACE + (variant === 'paint' ? DMG_PAINT : DMG_PLASTIC);
  fs = insertBefore(fs, ANCHOR_SURFACE, body);
  if (variant !== 'glass') {
    fs = insertAfter(
      fs,
      ANCHOR_CC_MAPS,
      '#ifdef USE_CLEARCOAT\n  clearcoatNormal = dmgBump(-vViewPosition, clearcoatNormal, dmgH, faceDirection);\n#endif',
    );
  }
  fs = insertAfter(
    fs,
    ANCHOR_LIGHTS,
    '#ifdef USE_CLEARCOAT\n  material.clearcoat *= 1.0 - dmgCoatKill;\n  material.clearcoatRoughness = clamp(material.clearcoatRoughness + dmgCoatRough, 0.0, 1.0);\n#endif',
  );
  if (variant === 'glass' && fs.includes(ANCHOR_TRANSMISSION)) {
    const chunk = ShaderChunk.transmission_fragment.replace(
      'material.transmission = transmission;',
      'material.transmission = transmission * (1.0 - dmgCrackM);',
    );
    fs = fs.replace(ANCHOR_TRANSMISSION, chunk);
  }
  return fs;
}

// ====================================================================== factory
interface GlassState {
  panel: number;
  laminated: boolean;
  beams: Int32Array;
  crackStrain: number;
  shatterStrain: number;
  crackImpulse: number;
  shatterImpulse: number;
  shatterBrokenFraction: number;
  /** Current bounding sphere (world). */
  cx: number;
  cy: number;
  cz: number;
  r: number;
  /** Strongest impulse near the pane since the last snapshot step, and where. */
  hitImpulse: number;
  hx: number;
  hy: number;
  hz: number;
  uniforms: CrackUniforms;
  /** Widest rest triangle of the pane's nodes (iR, iX, iY): world ↔ rest mapping for crack centres. */
  triad: Int32Array;
  restCenter: readonly [number, number, number];
}

interface PanelRuntime {
  detached: boolean;
  free: boolean;
  crack: number;
  shattered: boolean;
  hidden: boolean;
  state: { detached: boolean; crack: number; shattered: boolean };
  fxDetach: { type: 'panelDetach'; panelIndex: number; mode: 'follow' | 'hide'; pos: [number, number, number] };
  fxCrack: { type: 'glassCrack'; panelIndex: number; level: number; pos: [number, number, number] };
  fxShatter: {
    type: 'glassShatter';
    panelIndex: number;
    pos: [number, number, number];
    normal: [number, number, number];
    laminated: boolean;
  };
}

/** A4 damage.ts — see types.ts CreateVehicleDamage. */
export function createVehicleDamage(
  compiled: CompiledVehicle,
  binding: BindingSet,
  def: VehicleVisualDef,
  tuning: Partial<DamageTuning> = {},
): VehicleDamageImpl {
  void def;
  const T: DamageTuning = { ...DAMAGE_DEFAULTS, ...tuning };
  const rig = compiled.rig;
  const N = rig.nodeCount;
  const B = rig.beamCount;
  const bodyN = Math.min(compiled.bodyNodeCount, N);
  const K = Math.max(1, T.strainPersist | 0);

  const strainBeams = strainBeamSet(compiled);
  const strainSlack = elasticSlack(rig, strainBeams);
  const restLen = rig.beamRestLen;
  const bA = rig.beamA;
  const bB = rig.beamB;

  const strain = new Float32Array(N);
  const scuff = new Float32Array(N);
  const crack = new Float32Array(N);
  const raw = new Float32Array(N);
  const hist = new Float32Array(K * N);
  let histPos = 0;
  let histCount = 0;
  const flags = new Uint8Array(N);
  const broken = new Uint8Array(B);
  const eventStamp = new Int32Array(B); // snapshot counter at the event (0 = none)
  let snapshots = 0;
  let bitsetSeen = false;
  const comVelocity = new Float64Array(3);
  /** Body centroid (world) of the last snapshot step. Typed array: a double in a closure slot is boxed per write. */
  const com = new Float64Array(3);
  let comTick = -1;

  // event queues
  const impQ = new Float32Array(IMPACT_QUEUE * 4);
  let impN = 0;
  const skidQ = new Float32Array(SKID_QUEUE * 4);
  let skidN = 0;
  const brkQ = new Float32Array(BREAK_QUEUE * 4);
  let brkN = 0;

  let lastTick = -1;
  let epoch = -1;
  let pendingShowAll = false;
  let lastSkin: FlexSkin | null = null;

  // ---- panels
  const P = binding.panels.length;
  const variants: (DamageVariant | null)[] = [];
  const patches: (ShaderPatch | null)[] = [];
  const runtime: PanelRuntime[] = [];
  const glass: GlassState[] = [];
  const glassOf = new Int32Array(P).fill(-1);
  const amount = { value: 1 };

  for (let i = 0; i < P; i++) {
    const p = binding.panels[i]!;
    const variant = damageVariant(p);
    variants.push(variant);
    runtime.push({
      detached: false,
      free: false,
      crack: 0,
      shattered: false,
      hidden: false,
      state: { detached: false, crack: 0, shattered: false },
      fxDetach: { type: 'panelDetach', panelIndex: i, mode: p.detach?.mode ?? 'follow', pos: [0, 0, 0] },
      fxCrack: { type: 'glassCrack', panelIndex: i, level: 0, pos: [0, 0, 0] },
      fxShatter: { type: 'glassShatter', panelIndex: i, pos: [0, 0, 0], normal: [0, 1, 0], laminated: false },
    });
    let uniforms: CrackUniforms | null = null;
    if (p.glass) {
      uniforms = makeCrackUniforms(p, i);
      glassOf[i] = glass.length;
      glass.push({
        panel: i,
        laminated: p.glass.laminated,
        beams: p.glass.beams,
        crackStrain: p.glass.crackStrain,
        shatterStrain: p.glass.shatterStrain,
        crackImpulse: p.glass.crackImpulse,
        shatterImpulse: p.glass.shatterImpulse,
        shatterBrokenFraction: p.glass.shatterBrokenFraction,
        cx: 0,
        cy: 0,
        cz: 0,
        r: p.restRadius,
        hitImpulse: 0,
        hx: 0,
        hy: 0,
        hz: 0,
        uniforms,
        triad: widestTriad(rig, p.nodes.length >= 3 ? p.nodes : p.bindNodes),
        restCenter: p.restCenter,
      });
      runtime[i]!.fxShatter.laminated = p.glass.laminated;
    } else if (variant === 'glass') {
      uniforms = makeCrackUniforms(p, i); // glass slot without a GlassSpec: never cracks, but the shader needs the uniforms
    }
    patches.push(variant ? makePatch(variant, amount, uniforms) : null);
  }

  // wheel nodes (tyre exclusion for scrapes)
  const wheelNodes = new Int32Array(Math.max(0, N - bodyN));
  for (let i = bodyN; i < N; i++) wheelNodes[i - bodyN] = i;

  let nodes: Float32Array = new Float32Array(0);
  let off = 0;

  // Event helpers take (queue, record offset), never coordinates: doubles passed to a
  // non-inlined call are boxed as HeapNumbers (an allocation per event).
  function nearWheel(q: Float32Array, e: number): boolean {
    const x = q[e]!;
    const y = q[e + 1]!;
    const z = q[e + 2]!;
    const r2 = TYRE_EXCLUSION * TYRE_EXCLUSION;
    for (let k = 0; k < wheelNodes.length; k++) {
      const o = off + wheelNodes[k]! * 3;
      const dx = nodes[o]! - x;
      const dy = nodes[o + 1]! - y;
      const dz = nodes[o + 2]! - z;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  }

  /**
   * Smooth-falloff deposit around (x, y, z). Events are processed up to a
   * frame (plus interpolation lag) after they happened, and a car bouncing
   * off a wall moves ~0.1–0.5 m in that time: when no body node is within
   * scuffRadius, the deposit re-centres on the nearest body node within
   * SCUFF_SNAP. Returns false when nothing was reached.
   */
  function depositScuff(q: Float32Array, e: number, impulseScale: boolean): boolean {
    const x = q[e]!;
    const y = q[e + 1]!;
    const z = q[e + 2]!;
    const amountAt = impulseScale ? q[e + 3]! / T.scuffFullImpulse : q[e + 3]!;
    const R = T.scuffRadius;
    const R2 = R * R;
    let best = Infinity;
    let bi = -1;
    for (let i = 0; i < bodyN; i++) {
      const o = off + i * 3;
      const dx = nodes[o]! - x;
      const dy = nodes[o + 1]! - y;
      const dz = nodes[o + 2]! - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
      }
    }
    if (bi < 0 || best > SCUFF_SNAP * SCUFF_SNAP) return false;
    const snap = best >= R2;
    const ob = off + bi * 3;
    const cx = snap ? nodes[ob]! : x;
    const cy = snap ? nodes[ob + 1]! : y;
    const cz = snap ? nodes[ob + 2]! : z;
    for (let i = 0; i < bodyN; i++) {
      const o = off + i * 3;
      const dx = nodes[o]! - cx;
      const dy = nodes[o + 1]! - cy;
      const dz = nodes[o + 2]! - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= R2) continue;
      const t = 1 - Math.sqrt(d2) / R;
      const w = t * t * (3 - 2 * t);
      const s = scuff[i]! + amountAt * w;
      scuff[i] = s > 1 ? 1 : s;
    }
    return true;
  }

  function updateGlassBounds(): void {
    for (let g = 0; g < glass.length; g++) {
      const gs = glass[g]!;
      const pn = binding.panels[gs.panel]!.nodes;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let k = 0; k < pn.length; k++) {
        const o = off + pn[k]! * 3;
        cx += nodes[o]!;
        cy += nodes[o + 1]!;
        cz += nodes[o + 2]!;
      }
      const inv = pn.length > 0 ? 1 / pn.length : 0;
      cx *= inv;
      cy *= inv;
      cz *= inv;
      let r2 = 0;
      for (let k = 0; k < pn.length; k++) {
        const o = off + pn[k]! * 3;
        const dx = nodes[o]! - cx;
        const dy = nodes[o + 1]! - cy;
        const dz = nodes[o + 2]! - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
      }
      gs.cx = cx;
      gs.cy = cy;
      gs.cz = cz;
      gs.r = Math.max(Math.sqrt(r2), binding.panels[gs.panel]!.restRadius * 0.5);
    }
  }

  /**
   * World point → rest-space point on a pane via its widest node triad
   * (the flexbody mapping inverted: exact under rigid motion and in-plane
   * affine deformation of the pane).
   */
  function worldToRest(gs: GlassState, x: number, y: number, z: number, out: Vector3): void {
    const rp = rig.nodePos;
    const iR = gs.triad[0]!;
    const iX = gs.triad[1]!;
    const iY = gs.triad[2]!;
    const oR = off + iR * 3;
    const oX = off + iX * 3;
    const oY = off + iY * 3;
    const e1x = nodes[oX]! - nodes[oR]!;
    const e1y = nodes[oX + 1]! - nodes[oR + 1]!;
    const e1z = nodes[oX + 2]! - nodes[oR + 2]!;
    const e2x = nodes[oY]! - nodes[oR]!;
    const e2y = nodes[oY + 1]! - nodes[oR + 1]!;
    const e2z = nodes[oY + 2]! - nodes[oR + 2]!;
    const dx = x - nodes[oR]!;
    const dy = y - nodes[oR + 1]!;
    const dz = z - nodes[oR + 2]!;
    const g11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const g12 = e1x * e2x + e1y * e2y + e1z * e2z;
    const g22 = e2x * e2x + e2y * e2y + e2z * e2z;
    const det = g11 * g22 - g12 * g12;
    if (!(Math.abs(det) > 1e-12)) {
      out.set(gs.restCenter[0], gs.restCenter[1], gs.restCenter[2]);
      return;
    }
    const r1 = dx * e1x + dy * e1y + dz * e1z;
    const r2 = dx * e2x + dy * e2y + dz * e2z;
    const a = (r1 * g22 - r2 * g12) / det;
    const b = (r2 * g11 - r1 * g12) / det;
    const R0x = rp[iR * 3]!;
    const R0y = rp[iR * 3 + 1]!;
    const R0z = rp[iR * 3 + 2]!;
    out.set(
      R0x + a * (rp[iX * 3]! - R0x) + b * (rp[iY * 3]! - R0x),
      R0y + a * (rp[iX * 3 + 1]! - R0y) + b * (rp[iY * 3 + 1]! - R0y),
      R0z + a * (rp[iX * 3 + 2]! - R0z) + b * (rp[iY * 3 + 2]! - R0z),
    );
  }

  const tmpRest = new Vector3();

  function emit(fx: DamageFx): void {
    if (impl.onFx) impl.onFx(fx);
  }

  /** Crack a pane (level from a 0..1 severity), centre from world point (x, y, z). */
  function crackPane(gs: GlassState, severity: number, x: number, y: number, z: number, grow = true): void {
    const rt = runtime[gs.panel]!;
    if (rt.shattered && !gs.laminated) return;
    worldToRest(gs, x, y, z, tmpRest);
    const u = gs.uniforms;
    const A = u.uCrackA.value;
    const Bv = u.uCrackB.value;
    const lvl = 0.3 + 0.7 * clamp01(severity);
    if (A.w <= 0) {
      A.set(tmpRest.x, tmpRest.y, tmpRest.z, lvl);
    } else {
      const dA = Math.hypot(tmpRest.x - A.x, tmpRest.y - A.y, tmpRest.z - A.z);
      if (dA > CRACK_SECOND_CENTRE && Bv.w <= 0) Bv.set(tmpRest.x, tmpRest.y, tmpRest.z, lvl);
      else if (Bv.w > 0 && dA > CRACK_SECOND_CENTRE) Bv.w = Math.min(1, Math.max(Bv.w, lvl) + (grow ? 0.1 : 0));
      else A.w = Math.min(1, Math.max(A.w, lvl) + (grow ? 0.1 : 0));
    }
    const level = Math.max(A.w, Bv.w);
    if (level > rt.crack + 1e-6) {
      rt.crack = level;
      rt.fxCrack.level = level;
      setV(rt.fxCrack.pos, x, y, z);
      emit(rt.fxCrack);
    }
  }

  function shatterPane(gs: GlassState, x: number, y: number, z: number): void {
    const rt = runtime[gs.panel]!;
    if (rt.shattered) return;
    rt.shattered = true;
    const u = gs.uniforms;
    if (gs.laminated) {
      // the windscreen stays in its frame, fully crazed
      if (u.uCrackA.value.w <= 0) {
        worldToRest(gs, x, y, z, tmpRest);
        u.uCrackA.value.set(tmpRest.x, tmpRest.y, tmpRest.z, 1);
      } else u.uCrackA.value.w = 1;
      rt.crack = 1;
    } else {
      rt.hidden = true;
      if (lastSkin) lastSkin.setPanelVisible(gs.panel, false);
    }
    const fx = rt.fxShatter;
    setV(fx.pos, gs.cx, gs.cy, gs.cz);
    paneNormal(gs, fx.normal);
    emit(fx);
  }

  /** Current world normal of a pane, oriented away from the body centroid. */
  function paneNormal(gs: GlassState, out: [number, number, number]): void {
    const pn = binding.panels[gs.panel]!.nodes;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    // Newell-like sum of cross products around the centroid (order-independent magnitude via abs alignment)
    for (let k = 0; k + 1 < pn.length; k++) {
      const o1 = off + pn[k]! * 3;
      const o2 = off + pn[k + 1]! * 3;
      const ax = nodes[o1]! - gs.cx;
      const ay = nodes[o1 + 1]! - gs.cy;
      const az = nodes[o1 + 2]! - gs.cz;
      const bx = nodes[o2]! - gs.cx;
      const by = nodes[o2 + 1]! - gs.cy;
      const bz = nodes[o2 + 2]! - gs.cz;
      let cx = ay * bz - az * by;
      let cy = az * bx - ax * bz;
      let cz = ax * by - ay * bx;
      if (cx * nx + cy * ny + cz * nz < 0) {
        cx = -cx;
        cy = -cy;
        cz = -cz;
      }
      nx += cx;
      ny += cy;
      nz += cz;
    }
    const ox = gs.cx - com[0]!;
    const oy = gs.cy - com[1]!;
    const oz = gs.cz - com[2]!;
    if (nx * ox + ny * oy + nz * oz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-9) setV(out, nx / l, ny / l, nz / l);
    else setV(out, 0, 1, 0);
  }

  function processEvents(): void {
    // beam breaks: early broken flag + FX
    for (let q = 0; q < brkN; q++) {
      const b = brkQ[q * 4]! | 0;
      if (b >= 0 && b < B) {
        if (eventStamp[b] === 0) eventStamp[b] = snapshots + 1;
        broken[b] = 1;
      }
      beamFx.beamIndex = b;
      setV(beamFx.pos, brkQ[q * 4 + 1]!, brkQ[q * 4 + 2]!, brkQ[q * 4 + 3]!);
      emit(beamFx);
    }
    brkN = 0;
    // impacts → scuff + glass hits
    for (let q = 0; q < impN; q++) {
      const x = impQ[q * 4]!;
      const y = impQ[q * 4 + 1]!;
      const z = impQ[q * 4 + 2]!;
      const imp = impQ[q * 4 + 3]!;
      stats.impacts++;
      if (nearWheel(impQ, q * 4)) stats.tyre++;
      else if (!depositScuff(impQ, q * 4, true)) stats.missed++;
      for (let g = 0; g < glass.length; g++) {
        const gs = glass[g]!;
        const dx = x - gs.cx;
        const dy = y - gs.cy;
        const dz = z - gs.cz;
        const rr = gs.r + GLASS_IMPACT_MARGIN;
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
        if (imp > gs.hitImpulse) {
          gs.hitImpulse = imp;
          gs.hx = x;
          gs.hy = y;
          gs.hz = z;
        }
      }
    }
    impN = 0;
    for (let q = 0; q < skidN; q++) {
      if (nearWheel(skidQ, q * 4)) continue;
      stats.skids++;
      depositScuff(skidQ, q * 4, false);
    }
    skidN = 0;
    // glass impulses (per update: the strongest hit near each pane)
    for (let g = 0; g < glass.length; g++) {
      const gs = glass[g]!;
      const imp = gs.hitImpulse;
      if (imp <= 0) continue;
      gs.hitImpulse = 0;
      if (imp >= gs.shatterImpulse) {
        crackPane(gs, 1, gs.hx, gs.hy, gs.hz);
        shatterPane(gs, gs.hx, gs.hy, gs.hz);
      } else if (imp >= gs.crackImpulse) {
        crackPane(gs, (imp - gs.crackImpulse) / Math.max(1e-6, gs.shatterImpulse - gs.crackImpulse), gs.hx, gs.hy, gs.hz);
      }
    }
  }

  function snapshotStep(frame: VehicleFrameInput): void {
    snapshots++;
    // ---- broken: bitset ∪ fresh events
    const src = frame.broken;
    const nb = Math.min(B, src.length);
    let any = false;
    for (let b = 0; b < nb; b++) {
      if (src[b]) {
        any = true;
        broken[b] = 1;
        eventStamp[b] = 0;
      } else if (eventStamp[b] !== 0) {
        // unconfirmed event: trust it for a few snapshots, forever if the sim never writes the bitset
        if (bitsetSeen && snapshots - eventStamp[b]! > EVENT_CONFIRM_SNAPSHOTS) {
          eventStamp[b] = 0;
          broken[b] = 0;
        } else broken[b] = 1;
      } else broken[b] = 0;
    }
    if (any) bitsetSeen = true;

    // ---- node flags
    flags.fill(0);
    for (let b = 0; b < B; b++) {
      if (!broken[b]) continue;
      const a = bA[b]!;
      const c = bB[b]!;
      flags[a] = flags[a]! | NODE_TEX_FLAG_BROKEN;
      flags[c] = flags[c]! | NODE_TEX_FLAG_BROKEN;
    }

    // ---- plastic strain (ratchet)
    raw.fill(0);
    for (let k = 0; k < strainBeams.length; k++) {
      const b = strainBeams[k]!;
      if (broken[b]) continue;
      const a = bA[b]!;
      const c = bB[b]!;
      const oa = off + a * 3;
      const oc = off + c * 3;
      const dx = nodes[oc]! - nodes[oa]!;
      const dy = nodes[oc + 1]! - nodes[oa + 1]!;
      const dz = nodes[oc + 2]! - nodes[oa + 2]!;
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let e = L / restLen[b]! - 1;
      if (e < 0) e = -e;
      e -= strainSlack[k]!;
      if (!(e < 10)) e = 10; // NaN-safe
      if (e > raw[a]!) raw[a] = e;
      if (e > raw[c]!) raw[c] = e;
    }
    hist.set(raw, histPos * N);
    histPos = (histPos + 1) % K;
    if (histCount < K) histCount++;
    if (histCount >= K) {
      const dz0 = T.strainDeadzone;
      const span = Math.max(1e-6, T.strainFull - dz0);
      for (let i = 0; i < N; i++) {
        let m = hist[i]!;
        for (let h = 1; h < K; h++) {
          const v = hist[h * N + i]!;
          if (v < m) m = v;
        }
        let s = (m - dz0) / span;
        if (s <= 0) continue;
        if (s > 1) s = 1;
        if (s > strain[i]!) strain[i] = s;
      }
    }

    // ---- body centroid + velocity
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < bodyN; i++) {
      const o = off + i * 3;
      cx += nodes[o]!;
      cy += nodes[o + 1]!;
      cz += nodes[o + 2]!;
    }
    const inv = bodyN > 0 ? 1 / bodyN : 0;
    cx *= inv;
    cy *= inv;
    cz *= inv;
    if (comTick >= 0 && frame.tick > comTick) {
      const dt = (frame.tick - comTick) / 2000;
      comVelocity[0] = (cx - com[0]!) / dt;
      comVelocity[1] = (cy - com[1]!) / dt;
      comVelocity[2] = (cz - com[2]!) / dt;
    }
    com[0] = cx;
    com[1] = cy;
    com[2] = cz;
    comTick = frame.tick;

    // ---- panels: detach (sticky) + glass
    for (let i = 0; i < P; i++) {
      const p = binding.panels[i]!;
      const rt = runtime[i]!;
      const d = p.detach;
      if (d && !rt.free) {
        const ab = d.attachBeams;
        let nBroken = 0;
        for (let k = 0; k < ab.length; k++) nBroken += broken[ab[k]!]!;
        const frac = ab.length > 0 ? nBroken / ab.length : 0;
        if (!rt.detached && frac >= d.minBrokenFraction) {
          rt.detached = true;
          if (d.mode === 'hide') {
            rt.hidden = true;
            if (lastSkin) lastSkin.setPanelVisible(i, false);
          }
          panelCentroid(p, rt.fxDetach.pos);
          emit(rt.fxDetach);
        }
        if (rt.detached && nBroken === ab.length) rt.free = true;
      }
      if (rt.detached && d && d.mode === 'follow') {
        const bn = p.bindNodes;
        for (let k = 0; k < bn.length; k++) {
          const ni = bn[k]!;
          flags[ni] = flags[ni]! | NODE_TEX_FLAG_DETACHED;
        }
      }
    }
    for (let g = 0; g < glass.length; g++) {
      const gs = glass[g]!;
      const rt = runtime[gs.panel]!;
      if (rt.shattered && !gs.laminated) continue;
      let maxE = 0;
      let nBroken = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      const gb = gs.beams;
      for (let k = 0; k < gb.length; k++) {
        const b = gb[k]!;
        if (broken[b]) {
          nBroken++;
          continue;
        }
        const oa = off + bA[b]! * 3;
        const oc = off + bB[b]! * 3;
        const dx = nodes[oc]! - nodes[oa]!;
        const dy = nodes[oc + 1]! - nodes[oa + 1]!;
        const dz = nodes[oc + 2]! - nodes[oa + 2]!;
        let e = Math.sqrt(dx * dx + dy * dy + dz * dz) / restLen[b]! - 1;
        if (e < 0) e = -e;
        if (e > maxE) {
          maxE = e;
          mx = (nodes[oc]! + nodes[oa]!) * 0.5;
          my = (nodes[oc + 1]! + nodes[oa + 1]!) * 0.5;
          mz = (nodes[oc + 2]! + nodes[oa + 2]!) * 0.5;
        }
      }
      const frac = gb.length > 0 ? nBroken / gb.length : 0;
      if (frac > 0 && frac >= gs.shatterBrokenFraction) {
        if (rt.crack <= 0) crackPane(gs, 1, gs.cx, gs.cy, gs.cz);
        shatterPane(gs, gs.cx, gs.cy, gs.cz);
      } else if (maxE >= gs.shatterStrain) {
        crackPane(gs, 1, mx, my, mz);
        shatterPane(gs, mx, my, mz);
      } else if (maxE >= gs.crackStrain && rt.crack < 0.3 + 0.7 * clamp01((maxE - gs.crackStrain) / Math.max(1e-6, gs.shatterStrain - gs.crackStrain)) - 1e-3) {
        crackPane(gs, (maxE - gs.crackStrain) / Math.max(1e-6, gs.shatterStrain - gs.crackStrain), mx, my, mz, false);
      }
    }
  }

  function panelCentroid(p: BindingPanel, out: [number, number, number]): void {
    const pn = p.nodes.length > 0 ? p.nodes : p.bindNodes;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < pn.length; k++) {
      const o = off + pn[k]! * 3;
      x += nodes[o]!;
      y += nodes[o + 1]!;
      z += nodes[o + 2]!;
    }
    const inv = pn.length > 0 ? 1 / pn.length : 0;
    setV(out, x * inv, y * inv, z * inv);
  }

  function clearAll(): void {
    strain.fill(0);
    scuff.fill(0);
    crack.fill(0);
    hist.fill(0);
    histPos = 0;
    histCount = 0;
    flags.fill(0);
    broken.fill(0);
    eventStamp.fill(0);
    impN = skidN = brkN = 0;
    lastTick = -1;
    for (let i = 0; i < P; i++) {
      const rt = runtime[i]!;
      rt.detached = false;
      rt.free = false;
      rt.crack = 0;
      rt.shattered = false;
      rt.hidden = false;
    }
    for (let g = 0; g < glass.length; g++) {
      const u = glass[g]!.uniforms;
      u.uCrackA.value.w = 0;
      u.uCrackB.value.w = 0;
      glass[g]!.hitImpulse = 0;
    }
    pendingShowAll = true;
  }

  const stats = { impacts: 0, tyre: 0, missed: 0, skids: 0 };

  const beamFx: { type: 'beamBreak'; beamIndex: number; pos: [number, number, number] } = {
    type: 'beamBreak',
    beamIndex: 0,
    pos: [0, 0, 0],
  };

  const impl: VehicleDamageImpl = {
    strain,
    scuff,
    crack,
    nodeFlags: flags,
    broken,
    comVelocity,
    strainBeams,
    panelCount: P,
    stats,
    onFx: null,

    patchFor(panelIndex: number): ShaderPatch | null {
      return patches[panelIndex] ?? null;
    },

    variantOf(panelIndex: number): DamageVariant | null {
      return variants[panelIndex] ?? null;
    },

    crackUniforms(panelIndex: number): CrackUniforms | null {
      const g = glassOf[panelIndex] ?? -1;
      return g >= 0 ? glass[g]!.uniforms : null;
    },

    setShadingAmount(v: number): void {
      amount.value = v;
    },

    velocity(out: Float64Array): void {
      out[0] = comVelocity[0]!;
      out[1] = comVelocity[1]!;
      out[2] = comVelocity[2]!;
    },

    update(frame: VehicleFrameInput, skin: FlexSkin): void {
      lastSkin = skin;
      nodes = frame.nodes;
      off = frame.nodeOffset * 3;
      if (frame.repairEpoch !== epoch) {
        if (epoch !== -1) clearAll();
        // events drained together with the repair snapshot may predate the repair
        impN = skidN = brkN = 0;
        epoch = frame.repairEpoch;
      }
      if (pendingShowAll) {
        pendingShowAll = false;
        for (let i = 0; i < P; i++) skin.setPanelVisible(i, true);
      }
      updateGlassBounds();
      if (frame.tick !== lastTick) {
        lastTick = frame.tick;
        snapshotStep(frame);
      }
      processEvents();

      // ---- glass crack per node
      crack.fill(0);
      for (let g = 0; g < glass.length; g++) {
        const gs = glass[g]!;
        const c = runtime[gs.panel]!.crack;
        if (c <= 0) continue;
        const pn = binding.panels[gs.panel]!.nodes;
        for (let k = 0; k < pn.length; k++) if (c > crack[pn[k]!]!) crack[pn[k]!] = c;
      }

      // ---- skin: block B + flags
      const data = skin.nodeData;
      const baseB = skin.rows * NODE_TEX_WIDTH * 4;
      const nn = Math.min(N, skin.nodeFlags.length);
      for (let i = 0; i < nn; i++) {
        const o = baseB + i * 4;
        data[o] = strain[i]!;
        data[o + 1] = scuff[i]!;
        data[o + 2] = crack[i]!;
        data[o + 3] = 0;
        skin.nodeFlags[i] = flags[i]!;
      }
    },

    onImpact(e: Readonly<ImpactEvent>): void {
      if (impN >= IMPACT_QUEUE) return;
      const o = impN++ * 4;
      impQ[o] = e.px;
      impQ[o + 1] = e.py;
      impQ[o + 2] = e.pz;
      impQ[o + 3] = e.impulse;
    },

    onBeamBreak(e: Readonly<BeamBreakEvent>): void {
      if (brkN >= BREAK_QUEUE) return;
      const o = brkN++ * 4;
      brkQ[o] = e.beamIndex;
      brkQ[o + 1] = e.px;
      brkQ[o + 2] = e.py;
      brkQ[o + 3] = e.pz;
    },

    onSkid(e: Readonly<SkidEvent>): void {
      if (skidN >= SKID_QUEUE) return;
      const o = skidN++ * 4;
      skidQ[o] = e.px;
      skidQ[o + 1] = e.py;
      skidQ[o + 2] = e.pz;
      // light scrape: grows with slip speed and load
      skidQ[o + 3] = SKID_SCUFF_PER_EVENT * clamp01(e.slip / 6) * (0.4 + 0.6 * clamp01(e.load / 3000));
    },

    panelState(panelIndex: number): { detached: boolean; crack: number; shattered: boolean } {
      const rt = runtime[panelIndex];
      if (!rt) return { detached: false, crack: 0, shattered: false };
      rt.state.detached = rt.detached;
      rt.state.crack = rt.crack;
      rt.state.shattered = rt.shattered;
      return rt.state;
    },

    reset(): void {
      clearAll();
    },

    dispose(): void {
      impl.onFx = null;
      lastSkin = null;
      const i = DAMAGE_INSTANCES.indexOf(impl);
      if (i >= 0) DAMAGE_INSTANCES.splice(i, 1);
    },
  };
  DAMAGE_INSTANCES.push(impl);
  return impl;
}

/**
 * Live damage instances (debug / e2e: also on `globalThis.__crumpleDamage`
 * in the browser). Read-only use; disposed instances are removed.
 */
export const DAMAGE_INSTANCES: VehicleDamageImpl[] = [];
if (typeof window !== 'undefined') (window as unknown as { __crumpleDamage: VehicleDamageImpl[] }).__crumpleDamage = DAMAGE_INSTANCES;

// ====================================================================== internals
/** The node triple of `set` spanning the largest rest triangle (deterministic: first max wins). */
export function widestTriad(rig: CompiledRig, set: ArrayLike<number>): Int32Array {
  const p = rig.nodePos;
  let best = -1;
  const out = new Int32Array([set[0] ?? 0, set[1] ?? set[0] ?? 0, set[2] ?? set[0] ?? 0]);
  for (let i = 0; i < set.length; i++) {
    const a = set[i]! * 3;
    for (let j = i + 1; j < set.length; j++) {
      const b = set[j]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      for (let k = j + 1; k < set.length; k++) {
        const c = set[k]! * 3;
        const vx = p[c]! - p[a]!;
        const vy = p[c + 1]! - p[a + 1]!;
        const vz = p[c + 2]! - p[a + 2]!;
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        const area2 = cx * cx + cy * cy + cz * cz;
        if (area2 > best) {
          best = area2;
          out[0] = set[i]!;
          out[1] = set[j]!;
          out[2] = set[k]!;
        }
      }
    }
  }
  return out;
}

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

function setV(out: [number, number, number], x: number, y: number, z: number): void {
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

function makeCrackUniforms(p: BindingPanel, panelIndex: number): CrackUniforms {
  // pane plane basis from the mean rest normal
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const rn = p.restNormal;
  for (let v = 0; v < p.vertexCount; v++) {
    nx += rn[v * 3]!;
    ny += rn[v * 3 + 1]!;
    nz += rn[v * 3 + 2]!;
  }
  const n = new Vector3(nx, ny, nz);
  if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
  n.normalize();
  const ref = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = new Vector3().crossVectors(ref, n).normalize();
  const w = new Vector3().crossVectors(n, u).normalize();
  return {
    uCrackA: { value: new Vector4(0, 0, 0, 0) },
    uCrackB: { value: new Vector4(0, 0, 0, 0) },
    uCrackU: { value: u },
    uCrackV: { value: w },
    uCrackSeed: { value: 1.7 + panelIndex * 3.31 },
  };
}

function makePatch(variant: DamageVariant, amount: { value: number }, crack: CrackUniforms | null): ShaderPatch {
  const targets: readonly PatchTarget[] = ['color'];
  return {
    key: `${DAMAGE_PATCH_KEY}:${variant}`,
    targets,
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      if (target !== 'color') return;
      shader.uniforms.uDmgAmount = amount;
      if (variant === 'glass') {
        const c = crack!;
        shader.uniforms.uCrackA = c.uCrackA;
        shader.uniforms.uCrackB = c.uCrackB;
        shader.uniforms.uCrackU = c.uCrackU;
        shader.uniforms.uCrackV = c.uCrackV;
        shader.uniforms.uCrackSeed = c.uCrackSeed;
      }
      shader.fragmentShader = applyDamageGlsl(shader.fragmentShader, variant);
    },
  };
}
