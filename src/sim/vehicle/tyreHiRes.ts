/**
 * HIGH-RESOLUTION TYRE (R-TYRE; physics quality high / ultra, CONTRACTS
 * "R-TYRE"). The standard rigs keep their 10–12-ray wheels; a high / ultra
 * variant (R-RIG `defs/hd`) maps every WheelDef through `hiResWheel`:
 *
 *  - HIRES_RAYS rays (16, the render shader's TYRE_MAX_RAYS): 2–3 tread
 *    nodes per row in the contact patch instead of 1–2, a rounder rolling
 *    polygon (less tread-impact vibration, smoother Fz and rolling radius);
 *  - every PER-RAY stiffness and damping scaled by rays/HIRES_RAYS (node
 *    masses scale the same way: each node keeps its ω·dt, the wheel keeps
 *    its total radial, lateral and contact stiffness);
 *  - the CARCASS lateral compliance on (wheels.ts applyTreadBrush,
 *    brush-on-string; `tyreLateralStiffness`) with the brush stiffened by
 *    `HIRES_BRUSH_GAIN` so the steady cornering stiffness stays the
 *    standard tyre's, while a change of slip now builds over a real
 *    relaxation length (bench: realism/tyreHiRes.test.ts);
 *  - the rolling-loss correction table (R-PHYS, calibrated on the 12-ray
 *    car) plus the 16-gon's EXTRA tread-vibration loss per speed bin
 *    (`rollDelta`, measured: bare 16-ray minus bare 12-ray free-rolling C_rr
 *    on the bench, 3-bin median, only where positive and below 110 km/h —
 *    above it both polygons' losses are resonance-dominated and the
 *    difference is noise; HIRES_ROLL_DELTA_205_55R16 for the sedan tyre).
 * Hoop tension (wheels.ts): its geometric stiffness grows with the ray
 * count (∝ 1/sin(π/rays)); at the HOOP_OMEGA_MAX cap (≈ 245 km/h) the
 * 16-ray tread / rim reach ω·dt ≈ 0.53 (12 rays: 0.50 / 0.46), inside the
 * explicit integrator's stability margin (2) and reached only at top speed.
 */
import type { WheelDef } from './types';

/** Ray count of the high-resolution tyre. */
export const HIRES_RAYS = 16;
/** Default carcass lateral stiffness C_y per unit of the standard per-node brush stiffness (N/m ÷ N/m; bench). */
export const HIRES_CARCASS_PER_BRUSH = 1.25;
/** Brush stiffness gain that restores the standard tyre's cornering stiffness with the carcass in series. */
export const HIRES_BRUSH_GAIN = 1.2;
/** Sidewall / tread-ring gains on top of the per-ray scaling (see hiResWheel). */
export const HIRES_SIDE_GAIN = 1;
export const HIRES_RING_GAIN = 1.45;
/** Extra rolling loss of the 16-ray 205/55R16 over the 12-ray one, per 10 km/h of tread speed (see the doc). */
export const HIRES_ROLL_DELTA_205_55R16: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0.0023, 0.0044, 0.0129, 0.0129];

/** Per-ray stiffness / damping fields of a WheelDef (scaled with the ray count). */
const PER_RAY = [
  'tireContactSpring',
  'treadBrushStiffness',
  'treadBrushDamping',
  'tireRingSpring',
  'tireRingDamp',
  'rimSpring',
  'rimDamp',
  'sidewallSpring',
  'sidewallDamp',
] as const;

export interface HiResOptions {
  rays?: number;
  /** Carcass lateral stiffness C_y, N/m (default HIRES_CARCASS_PER_BRUSH × the standard brush; 0 = rigid carcass). */
  carcass?: number;
  brushGain?: number;
  /** Added to the wheel's rollingLossComp bin by bin (default none). */
  rollDelta?: readonly number[];
  /** Extra gain on the sidewall beams (tangential / lateral carcass shear), default HIRES_SIDE_GAIN. */
  sideGain?: number;
  /** Extra gain on the tread-ring beams, default HIRES_RING_GAIN. */
  ringGain?: number;
}

/** The high-resolution version of a standard wheel (same tyre, finer rig). */
export function hiResWheel(w: WheelDef, o: HiResOptions = {}): WheelDef {
  const rays = o.rays ?? HIRES_RAYS;
  const s = w.rays / rays;
  const out: WheelDef = { ...w, rays };
  const rec = out as unknown as Record<string, number | undefined>;
  const src = w as unknown as Record<string, number | undefined>;
  for (const f of PER_RAY) {
    const v = src[f];
    if (typeof v === 'number') rec[f] = v * s;
  }
  const sg = o.sideGain ?? HIRES_SIDE_GAIN;
  const rg = o.ringGain ?? HIRES_RING_GAIN;
  if (out.sidewallSpring !== undefined) out.sidewallSpring *= sg;
  if (out.sidewallDamp !== undefined) out.sidewallDamp *= sg;
  if (out.tireRingSpring !== undefined) out.tireRingSpring *= rg;
  if (out.tireRingDamp !== undefined) out.tireRingDamp *= rg;
  const k0 = w.treadBrushStiffness ?? 0;
  if (k0 > 0) {
    const cy = o.carcass ?? w.tyreLateralStiffness ?? HIRES_CARCASS_PER_BRUSH * k0;
    out.tyreLateralStiffness = cy;
    if (cy > 0) out.treadBrushStiffness = k0 * s * (o.brushGain ?? HIRES_BRUSH_GAIN);
  }
  const rd = o.rollDelta;
  if (rd && rd.length > 0) {
    const base = w.rollingLossComp ?? [];
    const n = base.length > rd.length ? base.length : rd.length;
    const t: number[] = [];
    for (let i = 0; i < n; i++) t.push((base[i] ?? base[base.length - 1] ?? 0) + (rd[i] ?? 0));
    out.rollingLossComp = t;
  }
  return out;
}

/** Every wheel of a vehicle def through hiResWheel. */
export function hiResWheels(wheels: readonly WheelDef[], o: HiResOptions = {}): WheelDef[] {
  return wheels.map((w) => hiResWheel(w, o));
}
