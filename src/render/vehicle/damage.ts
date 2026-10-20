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
import { FLEX_CRUMPLE_GLSL } from './flexskin';
import { GLASS_CRACK_GLSL } from './shatter';
import {
  DAMAGE_DEFAULTS,
  FLEX_CRUMPLE_AMP,
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
/**
 * Events reach update() up to a snapshot interval + a frame + the
 * interpolation delay away from the rendered pose; at drift speed a wheel
 * moves metres in that time and its tyre skids landed behind it, were taken
 * for body scrapes and snapped onto the rear bumper (silver "scuffed" rear
 * after any drift). A wheel's exclusion zone is swept ±EVENT_LAG_S along the
 * wheels' velocity.
 */
const EVENT_LAG_S = 0.15;
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
/**
 * Strain-scan budget (beams per snapshot) while the body is quiet: the
 * strain beams are measured round-robin, so a 900-beam body is covered every
 * 4 snapshots. Any sign of new damage (telemetry damage moved, a beam broke,
 * a body impact) switches to full scans for STRAIN_ACTIVE_SNAPSHOTS.
 */
export const STRAIN_SLICE = 256;
export const STRAIN_ACTIVE_SNAPSHOTS = 48;

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
  /**
   * One 'glass' patch for a MERGED draw of several panes (flexskin): per-pane
   * crack uniforms become arrays selected by the vertex's panel index
   * (vFlexPanel). Null when none of the panels is glass.
   */
  glassGroupPatch(panelIndices: readonly number[]): ShaderPatch | null;
  /** Diagnostics: strain beams measured in the last snapshot step / snapshots in full-scan mode. */
  readonly scan: { lastBeams: number; activeSnapshots: number };
  /**
   * P7 replay: copies every piece of mutable damage state (channels, strain
   * persistence, broken / event stamps, panels, glass + crack uniforms,
   * queued events, panel visibility on the last skin) into `into` (reused
   * when it fits, else a new one). Restoring it reproduces the visuals
   * exactly (the skin's block B / flags / visibility are rewritten).
   */
  saveState(into?: DamageState | null): DamageState;
  /**
   * Restores a saveState() snapshot. `seed`: the next strain scan re-seeds
   * the persistence filter from the presented geometry (replay seeks: the
   * frame's crush shows at once).
   */
  restoreState(s: DamageState, seed?: boolean): void;
}

/** Opaque damage snapshot (VehicleDamageImpl.saveState). */
export interface DamageState {
  readonly f32: Float32Array;
  readonly i32: Int32Array;
  readonly u8: Uint8Array;
  readonly f64: Float64Array;
  /** Queued, unprocessed events (impact / skid / break records). */
  imp: Float32Array;
  skid: Float32Array;
  brk: Float32Array;
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
// Surface-gradient bump (Mikkelsen) with UNnormalized screen derivatives. The height's own
// screen derivatives (hx, hy) come from its ANALYTIC rest-space gradient by the chain rule through
// the rest-position varying (linear in a triangle, so its dFdx / dFdy are exact even where the
// hardware takes one derivative per 2x2 pixel quad); dFdx(h) of a procedural h is quad-constant
// there (SwiftShader always, many GPUs coarse) and lit every quad flat: 4x4-pixel blocks at the
// 0.5 software render scale. h in metres gives a true slope, independent of distance / resolution.
vec3 dmgBump(vec3 surfPos, vec3 n, float hx, float hy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (hx * r1 + hy * r2);
  vec3 nn = abs(det) * n - grad;
  float l = length(nn);
  return l > 1e-12 ? nn / l : n;
}
// smoothstep(a, b, x) and its slope d/dx
float dmgStep(float a, float b, float x, out float d) {
  float w = max(b - a, 1e-6);
  float t = clamp((x - a) / w, 0.0, 1.0);
  d = 6.0 * t * (1.0 - t) / w;
  return t * t * (3.0 - 2.0 * t);
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
  // rest-space step per pixel (derivatives of a linear varying: exact per triangle)
  vec3 dmgPdx = dFdx(dmgP);
  vec3 dmgPdy = dFdy(dmgP);
  float dmgPx = length(abs(dmgPdx) + abs(dmgPdy));
`;

/**
 * Damage surface: every height term carries its analytic rest-space
 * gradient (dmgGH, m/m), every mask edge is anti-aliased over the pixel
 * footprint from those gradients, and detail fades out before it aliases.
 */
const DMG_SURFACE = /* glsl */ `
  float dmgW1 = clamp(1.0 - dmgPx * 15.0, 0.0, 1.0);
  float dmgW2 = clamp(1.0 - dmgPx * 26.0, 0.0, 1.0);
  float dmgW3 = clamp(1.0 - dmgPx * 60.0, 0.0, 1.0);
  // Sheet-metal folds. Rest space is the vehicle frame (z = length): frontal / rear crush
  // buckles panels into accordion ridges ACROSS z, so one fold family is stretched that way;
  // a second, isotropic family breaks it up; broad low-frequency dents ripple reflections.
  vec3 dmgGa, dmgGb, dmgG2, dmgG3, dmgGd, dmgGc, dmgRa, dmgRb, dmgR2g;
  const vec3 dmgSa = vec3(2.2, 3.0, 7.5);
  float dmgNa = flexSnoise(dmgP * dmgSa + 3.1, dmgGa);
  dmgGa *= dmgSa;
  float dmgNb = flexSnoise(dmgP * 5.5 + 9.7, dmgGb);
  dmgGb *= 5.5;
  float dmgN2 = flexSnoise(dmgP * 14.0 + 7.7, dmgG2);
  dmgG2 *= 14.0;
  float dmgN3 = flexSnoise(dmgP * 41.0, dmgG3);
  dmgG3 *= 41.0;
  float dmgND = flexSnoise(dmgP * 2.6 + 1.3, dmgGd);
  dmgGd *= 2.6;
  // crests rounded over ~1.5 px of noise change (sharp up close, never a sub-pixel sparkle line)
  float dmgR1 = flexRidge(dmgNa, dmgGa, 0.03 + 1.5 * dmgPx * length(dmgGa), dmgRa);
  float dmgR1b = flexRidge(dmgNb, dmgGb, 0.03 + 1.5 * dmgPx * length(dmgGb), dmgRb);
  float dmgR2 = flexRidge(dmgN2, dmgG2, 0.03 + 1.5 * dmgPx * length(dmgG2), dmgR2g);
  // tent-like crests (cubed ridges): faceted folds with a crisp light/dark split
  float dmgF1 = dmgR1 * dmgR1 * dmgR1;
  float dmgF1b = 0.7 * dmgR1b * dmgR1b * dmgR1b;
  float dmgF2 = dmgR2 * dmgR2;
  bool dmgFa = dmgF1 >= dmgF1b;
  float dmgFold = (dmgFa ? dmgF1 : dmgF1b) * dmgW1;
  vec3 dmgGFold = (dmgFa ? 3.0 * dmgR1 * dmgR1 * dmgRa : 2.1 * dmgR1b * dmgR1b * dmgRb) * dmgW1;
  // + the vertex stage's geometric crumple folds (flexskin FLEX_CRUMPLE_GLSL), so they shade.
  float dmgCrum = flexCrumpleG(dmgP, 0.03 + 20.0 * dmgPx, dmgGc);
  // Crease zones: crush concentrates in buckle bands; between them panels keep broad dents.
  vec3 dmgGm;
  float dmgMask = smoothstep(-0.3, 0.45, flexSnoise(dmgP * vec3(1.5, 1.7, 2.3) + 17.3, dmgGm));
  // height h = strain · (folds + dents + crumple) in metres; only its gradient is needed
  vec3 dmgGH = dmgStrain * (0.7 * mix(0.25, 1.0, dmgMask) * (0.008 * dmgGFold + 0.005 * dmgW2 * dmgR2 * dmgR2g) + 0.0005 * dmgW3 * dmgG3 + 0.02 * dmgGd
    + 0.35 * mix(0.5, 1.0, dmgMask) * ${FLEX_CRUMPLE_AMP} * dmgGc);
  // crease valleys (inside of a fold): grime collects there
  float dmgValley = clamp(0.5 - 1.6 * dmgCrum, 0.0, 1.0) * dmgW1;
  // Scrape streaks: long horizontal scratches (stretched along y) broken up by coarse noise and a
  // fine ragged-edge term; all in [0, 1].
  vec3 dmgGs1, dmgGs2, dmgGs3, dmgGs4;
  const vec3 dmgSs1 = vec3(2.0, 90.0, 2.0);
  const vec3 dmgSs2 = vec3(1.3, 24.0, 1.3);
  float dmgWF = clamp(1.0 - dmgPx * 90.0, 0.0, 1.0);
  float dmgWE = clamp(1.0 - dmgPx * 45.0, 0.0, 1.0);
  float dmgS1 = 0.5 + 0.5 * dmgWF * flexSnoise(dmgP * dmgSs1, dmgGs1);
  float dmgS2 = 0.5 + 0.5 * flexSnoise(dmgP * dmgSs2 + 5.0, dmgGs2);
  float dmgS3 = 0.5 + 0.5 * flexSnoise(dmgP * 4.0 + 11.0, dmgGs3);
  float dmgS4 = flexSnoise(dmgP * vec3(55.0, 70.0, 55.0) + 2.0, dmgGs4) * dmgWE;
  float dmgStreak = 0.42 * dmgS1 + 0.36 * dmgS2 + 0.22 * dmgS3 + 0.05 * dmgS4;
  vec3 dmgGS = 0.21 * dmgWF * dmgSs1 * dmgGs1 + 0.18 * dmgSs2 * dmgGs2 + 0.44 * dmgGs3 + 0.05 * dmgWE * vec3(55.0, 70.0, 55.0) * dmgGs4;
  // streak change across one pixel: every scrape edge is at least that soft (no stair-stepping)
  float dmgAA = 0.7 * dmgPx * length(dmgGS);
  // Scrapes (impact / skid scuff) cut through to primer, then bare metal, in streaks.
  float dmgCover = dmgScuff * 0.9;
  float dmgOn = smoothstep(0.0, 0.02, dmgCover);
  float dmgT = 0.8 - 0.62 * dmgCover;
  float dmgDP;
  float dmgDM;
  float dmgPrimer = dmgStep(dmgT - dmgAA, dmgT + 0.03 + dmgAA, dmgStreak, dmgDP) * dmgOn;
  float dmgMetal = dmgStep(dmgT + 0.1 - dmgAA, dmgT + 0.125 + dmgAA, dmgStreak, dmgDM) * dmgOn;
  // Bent metal keeps its paint: only the sharp crest lines of hard creases crack it, in flakes
  // along the crest (primer shows), never as a wash over the whole crushed panel.
  vec3 dmgGk;
  float dmgCrest = max(dmgR1, dmgR1b);
  // crest-line width in ridge units (~1 cm) vs one pixel's ridge change: a sub-pixel line keeps its
  // average coverage (fainter), it never widens into a band
  float dmgCrestPx = 1.5 * dmgPx * max(length(dmgGa), length(dmgGb));
  float dmgCrestW = 0.035;
  float dmgFlakeN = 0.5 + 0.5 * flexSnoise(dmgP * 48.0 + 5.1, dmgGk);
  float dmgChip = smoothstep(1.0 - dmgCrestW - dmgCrestPx, 1.0 - dmgCrestW + dmgCrestPx, dmgCrest) * dmgCrestW / (dmgCrestW + dmgCrestPx)
    * smoothstep(0.55, 0.7, dmgFlakeN) * smoothstep(0.75, 1.0, dmgStrain) * dmgMask * dmgW2;
  dmgPrimer = max(dmgPrimer, dmgChip);
  // the polished-out halo around scrapes (not around crease chips)
  float dmgHalo = smoothstep(dmgT - 0.16 - dmgAA, dmgT + dmgAA, dmgStreak) * dmgOn * clamp(dmgScuff * 3.0, 0.0, 1.0);
  // the paint layers' thickness: a tiny step down at each scrape edge catches the light
  dmgGH -= (0.00025 * dmgDP + 0.0002 * dmgDM) * dmgOn * dmgGS;
  // Dirt / dust ground into the damage: in crease valleys, around scrapes, never as a flat wash.
  float dmgDirtAmt = clamp(dmgScuff * 0.75 + dmgStrain * 0.2 * dmgValley + dmgTorn * 0.4, 0.0, 1.0);
  float dmgDirtN = 0.5 * dmgS2 + 0.3 * (0.5 + 0.5 * dmgND) + 0.2 * (0.5 + 0.5 * dmgN2 * dmgW2);
  float dmgDirt = smoothstep(0.62 - 0.45 * dmgDirtAmt, 0.9 - 0.45 * dmgDirtAmt, dmgDirtN + 0.3 * dmgValley) * dmgDirtAmt;
  float dmgDx = dot(dmgGH, dmgPdx);
  float dmgDy = dot(dmgGH, dmgPdy);
`;

const DMG_PAINT = /* glsl */ `
  // shallow crease valleys read a touch darker (micro-shadowed, grimy); bent paint keeps its colour
  diffuseColor.rgb *= 1.0 - dmgStrain * (0.04 + 0.2 * dmgValley);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.2 + 0.035, dmgHalo * 0.6 * (1.0 - dmgPrimer));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.205, 0.2) * (0.75 + 0.35 * dmgS2), dmgPrimer);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.6, 0.62) * (0.8 + 0.35 * dmgS1), dmgMetal);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.072, 0.058) * (0.8 + 0.4 * dmgS3), dmgDirt * 0.6 * (1.0 - 0.6 * dmgMetal));
  // torn-edge grime: vFlexDamage.w is a smooth triad-weighted share, so square it to keep it at the tear
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.027, 0.024), clamp(0.45 * dmgTorn * dmgTorn + 0.04 * dmgStrain, 0.0, 0.6));
  roughnessFactor = mix(roughnessFactor, 0.5, clamp(dmgStrain * 0.2 + dmgHalo * 0.7 + dmgTorn * 0.3, 0.0, 1.0));
  roughnessFactor = mix(roughnessFactor, 0.78, dmgPrimer);
  roughnessFactor = mix(roughnessFactor, 0.36 + 0.2 * dmgS1, dmgMetal);
  roughnessFactor = mix(roughnessFactor, 0.88, dmgDirt * 0.8);
  metalnessFactor = mix(metalnessFactor, 0.0, dmgPrimer);
  metalnessFactor = mix(metalnessFactor, 1.0, dmgMetal);
  metalnessFactor = mix(metalnessFactor, 0.0, dmgDirt * 0.6);
  float dmgCoatKill = clamp(max(max(dmgPrimer, dmgHalo * 0.8), dmgDirt * 0.75), 0.0, 1.0);
  float dmgCoatRough = 0.3 * dmgStrain * (0.5 + 0.5 * dmgMask) + 0.3 * dmgTorn;
  normal = dmgBump(-vViewPosition, normal, dmgDx, dmgDy, faceDirection);
`;

const DMG_PLASTIC = /* glsl */ `
  dmgDx *= 0.7;
  dmgDy *= 0.7;
  diffuseColor.rgb *= 1.0 - dmgStrain * (0.04 + 0.14 * dmgValley);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.165), dmgPrimer * 0.8);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.6 + 0.04, dmgHalo * 0.35 * (1.0 - dmgPrimer));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.072, 0.058), dmgDirt * 0.5);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), 0.4 * dmgTorn);
  roughnessFactor = mix(roughnessFactor, 0.85, clamp(dmgPrimer + dmgStrain * 0.4 + dmgHalo * 0.3 + dmgDirt * 0.5, 0.0, 1.0));
  metalnessFactor = mix(metalnessFactor, 0.0, dmgPrimer);
  float dmgCoatKill = max(dmgPrimer, dmgDirt * 0.75);
  float dmgCoatRough = 0.4 * dmgStrain;
  normal = dmgBump(-vViewPosition, normal, dmgDx, dmgDy, faceDirection);
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

const CRACK_UNIFORM_DECLS = ['uniform vec4 uCrackA;', 'uniform vec4 uCrackB;', 'uniform vec3 uCrackU;', 'uniform vec3 uCrackV;', 'uniform float uCrackSeed;'];

/**
 * GLASS_CRACK_GLSL for a merged draw of `panes` panes: the five crack
 * uniforms become plain globals filled by dmgSelectPane() from uniform
 * arrays, by the fragment's panel index (vFlexPanel, flexskin) matched
 * against uCrackPanels (no match = no crack).
 */
export function mergedCrackGlsl(panes: number): string {
  let g = GLASS_CRACK_GLSL;
  for (const d of CRACK_UNIFORM_DECLS) {
    if (!g.includes(d)) throw new Error(`damage: GLASS_CRACK_GLSL lacks ${d}`);
    g = g.replace(d, d.replace('uniform ', ''));
  }
  const n = Math.max(1, panes | 0);
  return /* glsl */ `
uniform vec4 uCrackAs[ ${n} ];
uniform vec4 uCrackBs[ ${n} ];
uniform vec3 uCrackUs[ ${n} ];
uniform vec3 uCrackVs[ ${n} ];
uniform float uCrackSeeds[ ${n} ];
uniform float uCrackPanels[ ${n} ];
${g}
void dmgSelectPane() {
  uCrackA = vec4(0.0);
  uCrackB = vec4(0.0);
  uCrackU = vec3(1.0, 0.0, 0.0);
  uCrackV = vec3(0.0, 1.0, 0.0);
  uCrackSeed = 0.0;
#ifdef FLEXBODY
  float pid = vFlexPanel;
#else
  float pid = -1.0;
#endif
  for (int i = 0; i < ${n}; i++) {
    if (abs(uCrackPanels[i] - pid) < 0.5) {
      uCrackA = uCrackAs[i];
      uCrackB = uCrackBs[i];
      uCrackU = uCrackUs[i];
      uCrackV = uCrackVs[i];
      uCrackSeed = uCrackSeeds[i];
    }
  }
}
`;
}

/**
 * Fragment source transform for a variant (exported for headless GLSL
 * tests). `panes` > 0 (glass only) = a merged draw of that many panes.
 */
export function applyDamageGlsl(fragmentShader: string, variant: DamageVariant, panes = 0): string {
  let fs = fragmentShader;
  if (!fs.includes(ANCHOR_SURFACE)) return fs; // not a standard/physical shader: leave untouched
  const merged = variant === 'glass' && panes > 0;
  const crack = variant === 'glass' ? (merged ? mergedCrackGlsl(panes) : GLASS_CRACK_GLSL) : '';
  const common = DMG_COMMON + FLEX_CRUMPLE_GLSL + crack;
  fs = insertAfter(fs, '#include <common>', common);
  const body =
    variant === 'glass'
      ? DMG_INPUTS + (merged ? '  dmgSelectPane();\n' : '') + DMG_GLASS
      : DMG_INPUTS + DMG_SURFACE + (variant === 'paint' ? DMG_PAINT : DMG_PLASTIC);
  fs = insertBefore(fs, ANCHOR_SURFACE, body);
  if (variant !== 'glass') {
    fs = insertAfter(
      fs,
      ANCHOR_CC_MAPS,
      '#ifdef USE_CLEARCOAT\n  clearcoatNormal = dmgBump(-vViewPosition, clearcoatNormal, dmgDx, dmgDy, faceDirection);\n#endif',
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
  const S = strainBeams.length;
  /** Per strain beam: the last K measurements (ring, slot = count % K) and the measurement count. */
  const ehist = new Float32Array(K * S);
  const ecount = new Int32Array(S);
  let cursor = 0;
  /** Full strain scans run while snapshots < activeUntil (new damage is developing). */
  let activeUntil = 0;
  let lastTelemetryDamage = NaN;
  /** Block B / nodeFlags need rewriting (some damage channel changed, or a new skin / repair). */
  let bDirty = true;
  let flagsDirty = true;
  let crackDirty = true;
  const scan = { lastBeams: 0, activeSnapshots: 0 };
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
  /**
   * P7: the first strain scan after a repair-epoch change fills every beam's
   * persistence history with that measurement, so a replay seek (which bumps
   * the presented epochs) shows the frame's crush at once, even paused. Live,
   * a repair snapshot is at rest (≈ 0 strain), so nothing changes there.
   */
  let seedPersist = false;
  let pendingShowAll = false;
  let lastSkin: FlexSkin | null = null;
  /** The skin block B / flags were last written to (a new skin gets a full write). */
  let writtenSkin: FlexSkin | null = null;
  /** A beamBreak event set a broken flag since the last snapshot step. */
  let brokenEvents = false;
  /** Event stamps wait for bitset confirmation / expiry: merge every snapshot until resolved. */
  let pendingStamps = false;
  /** Last merged bitset (identity + copy, word views) for the unchanged fast path. */
  let lastSrc: Uint8Array | null = null;
  let lastSrcCopy = new Uint8Array(0);
  let lastSrcWords: Uint32Array | null = null;
  let lastCopyWords = new Uint32Array(0);
  /** Detach state must be re-evaluated even without a broken-set change (after a repair). */
  let detachPending = true;

  // ---- panels
  const P = binding.panels.length;
  const variants: (DamageVariant | null)[] = [];
  const patches: (ShaderPatch | null)[] = [];
  const runtime: PanelRuntime[] = [];
  const glass: GlassState[] = [];
  const glassOf = new Int32Array(P).fill(-1);
  /** Crack uniforms per panel (glass variants), else null. */
  const paneUniforms: (CrackUniforms | null)[] = [];
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
    paneUniforms.push(uniforms);
    patches.push(variant ? makePatch(variant, amount, uniforms) : null);
  }

  // wheel nodes (tyre exclusion for scrapes)
  const wheelNodes = new Int32Array(Math.max(0, N - bodyN));
  for (let i = bodyN; i < N; i++) wheelNodes[i - bodyN] = i;

  let nodes: Float32Array = new Float32Array(0);
  let off = 0;
  let wheelVx = 0;
  let wheelVy = 0;
  let wheelVz = 0;
  let wheelPx = 0;
  let wheelPy = 0;
  let wheelPz = 0;
  let wheelPrevOk = false;

  // Event helpers take (queue, record offset), never coordinates: doubles passed to a
  // non-inlined call are boxed as HeapNumbers (an allocation per event).
  function nearWheel(q: Float32Array, e: number): boolean {
    const x = q[e]!;
    const y = q[e + 1]!;
    const z = q[e + 2]!;
    const r2 = TYRE_EXCLUSION * TYRE_EXCLUSION;
    const v2 = wheelVx * wheelVx + wheelVy * wheelVy + wheelVz * wheelVz;
    const inv = v2 > 1e-6 ? 1 / v2 : 0;
    for (let k = 0; k < wheelNodes.length; k++) {
      const o = off + wheelNodes[k]! * 3;
      let dx = nodes[o]! - x;
      let dy = nodes[o + 1]! - y;
      let dz = nodes[o + 2]! - z;
      // closest point on the node's path over ±EVENT_LAG_S
      let t = -(dx * wheelVx + dy * wheelVy + dz * wheelVz) * inv;
      t = t < -EVENT_LAG_S ? -EVENT_LAG_S : t > EVENT_LAG_S ? EVENT_LAG_S : t;
      dx += wheelVx * t;
      dy += wheelVy * t;
      dz += wheelVz * t;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  }

  /** Mean wheel-node velocity (m per wall second) from successive frames (nearWheel's lag sweep). */
  function trackWheels(dtS: number): void {
    const n = wheelNodes.length;
    if (n === 0) return;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < n; k++) {
      const o = off + wheelNodes[k]! * 3;
      sx += nodes[o]!;
      sy += nodes[o + 1]!;
      sz += nodes[o + 2]!;
    }
    sx /= n;
    sy /= n;
    sz /= n;
    if (dtS > 1e-4 && wheelPrevOk) {
      wheelVx = (sx - wheelPx) / dtS;
      wheelVy = (sy - wheelPy) / dtS;
      wheelVz = (sz - wheelPz) / dtS;
      const v2 = wheelVx * wheelVx + wheelVy * wheelVy + wheelVz * wheelVz;
      if (!(v2 < 80 * 80)) wheelVx = wheelVy = wheelVz = 0; // teleport / NaN
    }
    wheelPx = sx;
    wheelPy = sy;
    wheelPz = sz;
    wheelPrevOk = Number.isFinite(sx + sy + sz);
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
    bDirty = true;
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
      crackDirty = true;
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
      crackDirty = true;
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
        pendingStamps = true;
        if (!broken[b]) brokenEvents = true;
        broken[b] = 1;
      }
      activeUntil = snapshots + STRAIN_ACTIVE_SNAPSHOTS;
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
      else {
        // a body hit: plastic strain may be developing (impacts repeat while in contact)
        activeUntil = snapshots + STRAIN_ACTIVE_SNAPSHOTS;
        if (!depositScuff(impQ, q * 4, true)) stats.missed++;
      }
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

  /** Measures n strain beams from the round-robin cursor; ratchets node strain (persistence per beam). */
  function scanStrain(n: number): number {
    const dz0 = T.strainDeadzone;
    const span = Math.max(1e-6, T.strainFull - dz0);
    let measured = 0;
    let grew = 0;
    let k = cursor;
    for (let j = 0; j < n; j++, k++) {
      if (k >= S) k = 0;
      const b = strainBeams[k]!;
      if (broken[b]) continue;
      const a = bA[b]!;
      const c = bB[b]!;
      if (strain[a]! >= 1 && strain[c]! >= 1) continue; // saturated: nothing left to show
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
      measured++;
      let cnt = ecount[k]!;
      if (seedPersist && cnt === 0) {
        for (let h = 0; h < K; h++) ehist[k * K + h] = e;
        cnt = K - 1;
      }
      ehist[k * K + (cnt % K)] = e;
      ecount[k] = cnt < 0x3fffffff ? cnt + 1 : K; // capped: only "≥ K measured" matters past K
      if (cnt + 1 < K) continue;
      // persistence: the beam's minimum over its last K measurements (drops elastic transients)
      let m = ehist[k * K]!;
      for (let h = 1; h < K; h++) {
        const v = ehist[k * K + h]!;
        if (v < m) m = v;
      }
      let st = (m - dz0) / span;
      if (st <= 0) continue;
      if (st > 1) st = 1;
      if (st > strain[a]!) {
        strain[a] = st;
        grew = 1;
      }
      if (st > strain[c]!) {
        strain[c] = st;
        grew = 1;
      }
    }
    cursor = k >= S ? 0 : k;
    if (grew) bDirty = true;
    return measured;
  }

  /** True when frame.broken differs from the copy of the last merged one (word compare: ~B/4 loads). */
  function bitsetMoved(src: Uint8Array): boolean {
    if (src !== lastSrc || src.length !== lastSrcCopy.length) {
      lastSrc = src;
      lastSrcCopy = new Uint8Array(src.length);
      lastSrcWords = src.byteOffset % 4 === 0 ? new Uint32Array(src.buffer, src.byteOffset, src.length >> 2) : null;
      lastCopyWords = new Uint32Array(lastSrcCopy.buffer, 0, src.length >> 2);
      return true;
    }
    const w = lastSrcWords;
    let from = 0;
    if (w) {
      const c = lastCopyWords;
      for (let i = 0; i < w.length; i++) if (w[i] !== c[i]) return true;
      from = w.length << 2;
    }
    for (let b = from; b < src.length; b++) if (src[b] !== lastSrcCopy[b]) return true;
    return false;
  }

  function snapshotStep(frame: VehicleFrameInput): void {
    snapshots++;
    // ---- broken: bitset ∪ fresh events (skipped while the bitset is unchanged and no event is pending)
    const src = frame.broken;
    const nb = Math.min(B, src.length);
    let any = false;
    let changed = false;
    const merge = pendingStamps || bitsetMoved(src);
    if (merge) {
      lastSrcCopy.set(src);
      pendingStamps = false;
    }
    for (let b = 0; b < nb && merge; b++) {
      const was = broken[b]!;
      let now: number;
      if (src[b]) {
        any = true;
        now = 1;
        eventStamp[b] = 0;
      } else if (eventStamp[b] !== 0) {
        // unconfirmed event: trust it for a few snapshots, forever if the sim never writes the bitset
        if (bitsetSeen && snapshots - eventStamp[b]! > EVENT_CONFIRM_SNAPSHOTS) {
          eventStamp[b] = 0;
          now = 0;
        } else {
          now = 1;
          if (bitsetSeen) pendingStamps = true; // re-check until confirmed or expired
        }
      } else now = 0;
      if (now !== was) {
        broken[b] = now;
        changed = true;
      }
    }
    if (merge && any) bitsetSeen = true;
    if (brokenEvents) {
      changed = true;
      brokenEvents = false;
    }

    // ---- activity: new damage developing → full strain scans for a while
    const td = frame.telemetry ? frame.telemetry.damage : NaN;
    if (td === td && td !== lastTelemetryDamage) {
      if (lastTelemetryDamage === lastTelemetryDamage) activeUntil = snapshots + STRAIN_ACTIVE_SNAPSHOTS;
      lastTelemetryDamage = td;
    }
    if (changed) activeUntil = snapshots + STRAIN_ACTIVE_SNAPSHOTS;

    // ---- node flags (only when the broken set changed)
    if (changed) {
      flags.fill(0);
      for (let b = 0; b < B; b++) {
        if (!broken[b]) continue;
        const a = bA[b]!;
        const c = bB[b]!;
        flags[a] = flags[a]! | NODE_TEX_FLAG_BROKEN;
        flags[c] = flags[c]! | NODE_TEX_FLAG_BROKEN;
      }
      flagsDirty = true;
    }

    // ---- plastic strain (ratchet): round-robin slice while quiet, everything while active
    const active = snapshots < activeUntil;
    if (active) scan.activeSnapshots++;
    const n = active || seedPersist || S <= STRAIN_SLICE ? S : STRAIN_SLICE;
    const measured = scanStrain(n);
    seedPersist = false;
    scan.lastBeams = measured;

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

    // ---- panels: detach (sticky; depends on the broken set only) + glass
    for (let i = 0; i < P && (changed || detachPending); i++) {
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
        for (let q = 0; q < bn.length; q++) {
          const ni = bn[q]!;
          flags[ni] = flags[ni]! | NODE_TEX_FLAG_DETACHED;
        }
        flagsDirty = true;
      }
    }
    detachPending = false;
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
    ehist.fill(0);
    ecount.fill(0);
    cursor = 0;
    activeUntil = 0;
    lastTelemetryDamage = NaN;
    bDirty = flagsDirty = crackDirty = true;
    brokenEvents = false;
    detachPending = true;
    pendingStamps = false;
    lastSrc = null;
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

    glassGroupPatch(panelIndices: readonly number[]): ShaderPatch | null {
      const panes: { panel: number; u: CrackUniforms }[] = [];
      for (const i of panelIndices) {
        if (variants[i] !== 'glass') continue;
        // a glass-slot panel without a GlassSpec never cracks: its (static) uniforms still select
        const u = paneUniforms[i];
        if (u) panes.push({ panel: i, u });
      }
      return panes.length ? makeGlassGroupPatch(panes, amount) : null;
    },

    scan,

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
      trackWheels(frame.dtS);
      if (frame.repairEpoch !== epoch) {
        wheelPrevOk = false;
        wheelVx = wheelVy = wheelVz = 0;
        if (epoch !== -1) clearAll();
        // events drained together with the repair snapshot may predate the repair
        impN = skidN = brkN = 0;
        epoch = frame.repairEpoch;
        seedPersist = true;
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

      // ---- glass crack per node (only when a pane's crack level changed)
      if (crackDirty) {
        crackDirty = false;
        crack.fill(0);
        for (let g = 0; g < glass.length; g++) {
          const gs = glass[g]!;
          const c = runtime[gs.panel]!.crack;
          if (c <= 0) continue;
          const pn = binding.panels[gs.panel]!.nodes;
          for (let k = 0; k < pn.length; k++) if (c > crack[pn[k]!]!) crack[pn[k]!] = c;
        }
        bDirty = true;
      }

      // ---- skin: block B + flags, only when something changed (or a different skin)
      const fresh = writtenSkin !== skin;
      writtenSkin = skin;
      const nn = Math.min(N, skin.nodeFlags.length);
      if (bDirty || fresh) {
        bDirty = false;
        const data = skin.nodeData;
        const baseB = skin.rows * NODE_TEX_WIDTH * 4;
        for (let i = 0; i < nn; i++) {
          const o = baseB + i * 4;
          data[o] = strain[i]!;
          data[o + 1] = scuff[i]!;
          data[o + 2] = crack[i]!;
          data[o + 3] = 0;
        }
      }
      if (flagsDirty || fresh) {
        flagsDirty = false;
        for (let i = 0; i < nn; i++) skin.nodeFlags[i] = flags[i]!;
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

    saveState(into?: DamageState | null): DamageState {
      const G = glass.length;
      const nf = 3 * N + K * S + P;
      const ni = S + B;
      const nu = 2 * N + B + 5 * P;
      const nd = 32 + 15 * G;
      const st: DamageState =
        into && into.f32.length === nf && into.i32.length === ni && into.u8.length === nu && into.f64.length === nd
          ? into
          : { f32: new Float32Array(nf), i32: new Int32Array(ni), u8: new Uint8Array(nu), f64: new Float64Array(nd), imp: new Float32Array(0), skid: new Float32Array(0), brk: new Float32Array(0) };
      const f = st.f32;
      f.set(strain, 0);
      f.set(scuff, N);
      f.set(crack, 2 * N);
      f.set(ehist, 3 * N);
      for (let i = 0; i < P; i++) f[3 * N + K * S + i] = runtime[i]!.crack;
      st.i32.set(ecount, 0);
      st.i32.set(eventStamp, S);
      const u = st.u8;
      u.set(flags, 0);
      u.set(broken, N);
      const vis = lastSkin as (FlexSkin & { panelVisible?(i: number): boolean }) | null;
      for (let i = 0; i < P; i++) {
        const rt = runtime[i]!;
        const o = N + B + 5 * i;
        u[o] = rt.detached ? 1 : 0;
        u[o + 1] = rt.free ? 1 : 0;
        u[o + 2] = rt.shattered ? 1 : 0;
        u[o + 3] = rt.hidden ? 1 : 0;
        u[o + 4] = vis && vis.panelVisible ? (vis.panelVisible(i) ? 1 : 0) : rt.hidden ? 0 : 1;
      }
      // N..2N of u8 is spare (kept for layout symmetry)
      const d = st.f64;
      const sc = [
        cursor, activeUntil, lastTelemetryDamage, snapshots, bitsetSeen ? 1 : 0, comTick, lastTick, epoch,
        seedPersist ? 1 : 0, pendingShowAll ? 1 : 0, brokenEvents ? 1 : 0, pendingStamps ? 1 : 0, detachPending ? 1 : 0,
        wheelVx, wheelVy, wheelVz, wheelPx, wheelPy, wheelPz, wheelPrevOk ? 1 : 0,
        com[0]!, com[1]!, com[2]!, comVelocity[0]!, comVelocity[1]!, comVelocity[2]!, impN, skidN, brkN,
      ];
      for (let k = 0; k < sc.length; k++) d[k] = sc[k]!;
      for (let g = 0; g < G; g++) {
        const gs = glass[g]!;
        const o = 32 + 15 * g;
        const A = gs.uniforms.uCrackA.value;
        const Bv = gs.uniforms.uCrackB.value;
        d[o] = gs.hitImpulse;
        d[o + 1] = gs.hx;
        d[o + 2] = gs.hy;
        d[o + 3] = gs.hz;
        d[o + 4] = gs.cx;
        d[o + 5] = gs.cy;
        d[o + 6] = gs.cz;
        d[o + 7] = A.x;
        d[o + 8] = A.y;
        d[o + 9] = A.z;
        d[o + 10] = A.w;
        d[o + 11] = Bv.x;
        d[o + 12] = Bv.y;
        d[o + 13] = Bv.z;
        d[o + 14] = Bv.w;
      }
      st.imp = impN > 0 ? impQ.slice(0, impN * 4) : new Float32Array(0);
      st.skid = skidN > 0 ? skidQ.slice(0, skidN * 4) : new Float32Array(0);
      st.brk = brkN > 0 ? brkQ.slice(0, brkN * 4) : new Float32Array(0);
      return st;
    },

    restoreState(st: DamageState, seed = false): void {
      const G = glass.length;
      if (st.f32.length !== 3 * N + K * S + P || st.f64.length !== 32 + 15 * G) throw new Error('damage.restoreState: snapshot of another vehicle');
      const f = st.f32;
      strain.set(f.subarray(0, N));
      scuff.set(f.subarray(N, 2 * N));
      crack.set(f.subarray(2 * N, 3 * N));
      ehist.set(f.subarray(3 * N, 3 * N + K * S));
      ecount.set(st.i32.subarray(0, S));
      eventStamp.set(st.i32.subarray(S, S + B));
      const u = st.u8;
      flags.set(u.subarray(0, N));
      broken.set(u.subarray(N, N + B));
      for (let i = 0; i < P; i++) {
        const rt = runtime[i]!;
        const o = N + B + 5 * i;
        rt.detached = u[o] === 1;
        rt.free = u[o + 1] === 1;
        rt.shattered = u[o + 2] === 1;
        rt.hidden = u[o + 3] === 1;
        rt.crack = f[3 * N + K * S + i]!;
        if (lastSkin) lastSkin.setPanelVisible(i, u[o + 4] === 1);
      }
      const d = st.f64;
      cursor = d[0]!;
      activeUntil = d[1]!;
      lastTelemetryDamage = d[2]!;
      snapshots = d[3]!;
      bitsetSeen = d[4] === 1;
      comTick = d[5]!;
      lastTick = d[6]!;
      epoch = d[7]!;
      seedPersist = d[8] === 1;
      pendingShowAll = d[9] === 1;
      brokenEvents = d[10] === 1;
      pendingStamps = d[11] === 1;
      detachPending = d[12] === 1;
      wheelVx = d[13]!;
      wheelVy = d[14]!;
      wheelVz = d[15]!;
      wheelPx = d[16]!;
      wheelPy = d[17]!;
      wheelPz = d[18]!;
      wheelPrevOk = d[19] === 1;
      com[0] = d[20]!;
      com[1] = d[21]!;
      com[2] = d[22]!;
      comVelocity[0] = d[23]!;
      comVelocity[1] = d[24]!;
      comVelocity[2] = d[25]!;
      impN = st.imp.length >> 2;
      skidN = st.skid.length >> 2;
      brkN = st.brk.length >> 2;
      impQ.set(st.imp);
      skidQ.set(st.skid);
      brkQ.set(st.brk);
      for (let g = 0; g < G; g++) {
        const gs = glass[g]!;
        const o = 32 + 15 * g;
        gs.hitImpulse = d[o]!;
        gs.hx = d[o + 1]!;
        gs.hy = d[o + 2]!;
        gs.hz = d[o + 3]!;
        gs.cx = d[o + 4]!;
        gs.cy = d[o + 5]!;
        gs.cz = d[o + 6]!;
        gs.uniforms.uCrackA.value.set(d[o + 7]!, d[o + 8]!, d[o + 9]!, d[o + 10]!);
        gs.uniforms.uCrackB.value.set(d[o + 11]!, d[o + 12]!, d[o + 13]!, d[o + 14]!);
      }
      // force the merge / block B / flags rewrite on the next update
      lastSrc = null;
      bDirty = flagsDirty = true;
      crackDirty = false;
      writtenSkin = null;
      if (seed) {
        ecount.fill(0);
        seedPersist = true;
        lastTick = -1;
      }
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

/**
 * The merged-glass patch (key dmg1:glassN): uniform arrays reference the
 * panes' own Vector4/Vector3 objects, so crackPane()'s in-place writes
 * reach the merged draw without any copying.
 */
function makeGlassGroupPatch(panes: readonly { panel: number; u: CrackUniforms }[], amount: { value: number }): ShaderPatch {
  const n = panes.length;
  const uA = { value: panes.map((p) => p.u.uCrackA.value) };
  const uB = { value: panes.map((p) => p.u.uCrackB.value) };
  const uU = { value: panes.map((p) => p.u.uCrackU.value) };
  const uV = { value: panes.map((p) => p.u.uCrackV.value) };
  const seeds = { value: Float32Array.from(panes, (p) => p.u.uCrackSeed.value) };
  const ids = { value: Float32Array.from(panes, (p) => p.panel) };
  return {
    key: `${DAMAGE_PATCH_KEY}:glass${n}`,
    targets: ['color'],
    apply(shader: WebGLProgramParametersWithUniforms, target: PatchTarget): void {
      if (target !== 'color') return;
      shader.uniforms.uDmgAmount = amount;
      shader.uniforms.uCrackAs = uA;
      shader.uniforms.uCrackBs = uB;
      shader.uniforms.uCrackUs = uU;
      shader.uniforms.uCrackVs = uV;
      shader.uniforms.uCrackSeeds = seeds;
      shader.uniforms.uCrackPanels = ids;
      shader.fragmentShader = applyDamageGlsl(shader.fragmentShader, 'glass', n);
    },
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
