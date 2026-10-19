/**
 * Water buoyancy + drag (P5, U1; WATER_PHYSICS in src/world/types.ts).
 * WORKER ONLY. Per awake object, after the node-vs-node pass and before
 * the ground pass (so the implicit ground friction sees these forces).
 *
 * Per collidable free node i inside a WaterBody rectangle with
 * y_i − h < level (h = nodeHalfDepth):
 *   f = clamp((level − y_i + h)/(2h), 0, 1)                 submerged fraction
 *   V = m_i/ρ_obj                                           node volume
 *   F_b = ρ_w·g·V·f·buoyScale_i  (up; g = |gravity|)
 *   F_d = −f·(linearDrag·m·v + 0.5·ρ_w·Cd·(V/ℓ)·|v|·v), |F_d|·dt ≤ m·|v|
 * buoyScale is 1 except for a vehicle's BODY nodes while it floods (see
 * VEHICLE FLOODING in the engine): the cabin fills, the car floats for a
 * moment, then sinks.
 *
 * NUMERICS: + − × ÷ sqrt only, no allocation, ascending node order.
 */
import { WATER_PHYSICS, type WaterBody } from '../../world/types';
import { NODE_FLAG_COLLIDABLE, type SimState } from '../types';

/**
 * VEHICLE FLOODING: the flood level rises at the body's mean submerged
 * fraction / VEHICLE_FLOOD_TIME_S per second (a car half in the water
 * floods in ~2× that), and the body nodes' buoyancy scales by
 * 1 − VEHICLE_FLOOD_LOSS·flood. With vehicleDensity 500 the dry sedan
 * floats about half submerged (≈ 2× its weight in reserve); it goes under
 * at flood ≈ 0.67 (≈ 13 s) and, fully flooded, keeps ≈ 1/2 of its weight
 * in buoyancy (tyres + residual air), sinking at drag speed.
 */
export const VEHICLE_FLOOD_TIME_S = 10;
export const VEHICLE_FLOOD_LOSS = 0.8;

/**
 * True when some water body's rectangle (padded by `pad`) intersects the
 * box [x0, x1] × [z0, z1] and its level + h is above y0 (cheap early-out
 * per object from the broadphase box).
 */
export function boxNearWater(bodies: readonly WaterBody[], x0: number, y0: number, z0: number, x1: number, z1: number, pad: number): boolean {
  const h = WATER_PHYSICS.nodeHalfDepth;
  for (let k = 0; k < bodies.length; k++) {
    const b = bodies[k]!;
    if (y0 - pad < b.level + h && x0 - pad <= b.maxX && x1 + pad >= b.minX && z0 - pad <= b.maxZ && z1 + pad >= b.minZ) return true;
  }
  return false;
}

/**
 * Applies buoyancy + drag to nodes [first, first+count) of one object.
 * Nodes [first, scaleEnd) get their buoyancy × `buoyScale` (vehicle body
 * while flooding; pass scaleEnd = first for none). Returns Σ f over
 * [first, scaleEnd) (the flooding input) — 0 when nothing is in water.
 */
export function applyWater(
  state: SimState,
  first: number,
  count: number,
  bodies: readonly WaterBody[],
  density: number,
  g: number,
  dt: number,
  scaleEnd: number,
  buoyScale: number,
): number {
  const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass, flags } = state;
  const h = WATER_PHYSICS.nodeHalfDepth;
  const inv2h = 1 / (2 * h);
  const rhoW = WATER_PHYSICS.density;
  const lin = WATER_PHYSICS.linearDrag;
  const quad = (0.5 * rhoW * WATER_PHYSICS.dragCoeff) / (WATER_PHYSICS.nodeLength * density);
  const buoyPerKg = (rhoW * g) / density;
  const invDt = 1 / dt;
  const nb = bodies.length;
  const end = first + count;
  let scaledSum = 0;
  for (let i = first; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0 || (flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue;
    const y = posY[i]!;
    const x = posX[i]!;
    const z = posZ[i]!;
    let level = 0;
    let wet = false;
    for (let k = 0; k < nb; k++) {
      const b = bodies[k]!;
      if (y - h < b.level && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
        level = b.level;
        wet = true;
        break;
      }
    }
    if (!wet) continue;
    let f = (level - y + h) * inv2h;
    if (f > 1) f = 1;
    if (!(f > 0)) continue;
    const m = 1 / im;
    let fb = buoyPerKg * m * f;
    if (i < scaleEnd) {
      fb *= buoyScale;
      scaledSum += f;
    }
    // Drag (explicit; impulse capped at the node's momentum so it never reverses v).
    const vx = velX[i]!;
    const vy = velY[i]!;
    const vz = velZ[i]!;
    const v2 = vx * vx + vy * vy + vz * vz;
    let fx = 0;
    let fy = fb;
    let fz = 0;
    if (v2 > 0) {
      const v = Math.sqrt(v2);
      // V/ℓ = m/(ρ·ℓ): quad already holds 0.5·ρw·Cd/(ℓ·ρ).
      let c = f * (lin * m + quad * m * v);
      const cap = m * invDt;
      if (c > cap) c = cap;
      fx = -c * vx;
      fy -= c * vy;
      fz = -c * vz;
    }
    frcX[i] = frcX[i]! + fx;
    frcY[i] = frcY[i]! + fy;
    frcZ[i] = frcZ[i]! + fz;
  }
  return scaledSum;
}
