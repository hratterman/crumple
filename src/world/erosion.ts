/**
 * Particle hydraulic erosion on the generator's coarse grid (A). Droplets
 * roll downhill with inertia, pick up sediment ∝ speed·water·drop and lay it
 * down when they slow or climb; erosion uses a radial brush so channels are
 * smooth. Sequential, seeded, only + − × ÷ sqrt floor (DETERMINISM rules).
 *
 * Positions are in cell units, heights in metres, so `capacity` etc. are in
 * metres of sediment per metre of drop.
 */
import type { Rng } from '../core/rng';

export interface ErosionParams {
  droplets: number;
  maxSteps: number;
  inertia: number;
  capacity: number;
  minCapacity: number;
  erodeRate: number;
  depositRate: number;
  evaporate: number;
  gravity: number;
  maxSpeed: number;
  /** Brush radius in cells. */
  radius: number;
  /** Max erosion per step at a single cell, m (keeps it from digging pits). */
  maxErodeStep: number;
}

export const DEFAULT_EROSION: ErosionParams = {
  droplets: 40000,
  maxSteps: 40,
  inertia: 0.3,
  capacity: 1.5,
  minCapacity: 0.01,
  erodeRate: 0.2,
  depositRate: 0.25,
  evaporate: 0.02,
  gravity: 4,
  maxSpeed: 6,
  radius: 2.2,
  maxErodeStep: 0.2,
};

/**
 * Erode `h` (nx × nz, row-major) in place. `spawn` (same size, 0..1) is the
 * droplet spawn probability (rejection sampled), so plains stay untouched.
 */
export function erodeHeightfield(
  h: Float64Array,
  nx: number,
  nz: number,
  rng: Rng,
  p: ErosionParams,
  spawn: Float32Array,
): void {
  // Brush offsets / weights (linear falloff), normalized.
  const r = p.radius;
  const ri = Math.ceil(r);
  const bOff: number[] = [];
  const bDx: number[] = [];
  const bDz: number[] = [];
  const bW: number[] = [];
  let wSum = 0;
  for (let dz = -ri; dz <= ri; dz++) {
    for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= r) continue;
      const w = r - d;
      bOff.push(dz * nx + dx);
      bDx.push(dx);
      bDz.push(dz);
      bW.push(w);
      wSum += w;
    }
  }
  const nb = bW.length;
  const brushOff = Int32Array.from(bOff);
  const brushDx = Int32Array.from(bDx);
  const brushDz = Int32Array.from(bDz);
  const brushW = Float64Array.from(bW, (w) => w / wSum);

  const xMax = nx - 2;
  const zMax = nz - 2;
  let attempts = 0;
  const maxAttempts = p.droplets * 40;
  let made = 0;
  while (made < p.droplets && attempts < maxAttempts) {
    attempts++;
    let px = 1 + rng.float() * (xMax - 1);
    let pz = 1 + rng.float() * (zMax - 1);
    const sIdx = Math.floor(pz) * nx + Math.floor(px);
    if (rng.float() >= spawn[sIdx]!) continue;
    made++;
    let dirX = 0;
    let dirZ = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let life = 0; life < p.maxSteps; life++) {
      const cx = Math.floor(px);
      const cz = Math.floor(pz);
      const fx = px - cx;
      const fz = pz - cz;
      const i = cz * nx + cx;
      const h00 = h[i]!;
      const h10 = h[i + 1]!;
      const h01 = h[i + nx]!;
      const h11 = h[i + nx + 1]!;
      const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const height = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;

      dirX = dirX * p.inertia - gx * (1 - p.inertia);
      dirZ = dirZ * p.inertia - gz * (1 - p.inertia);
      const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (len < 1e-10) break;
      dirX /= len;
      dirZ /= len;
      px += dirX;
      pz += dirZ;
      if (px < 1 || px >= xMax || pz < 1 || pz >= zMax) break;

      const nx0 = Math.floor(px);
      const nz0 = Math.floor(pz);
      const nfx = px - nx0;
      const nfz = pz - nz0;
      const j = nz0 * nx + nx0;
      const newH =
        h[j]! * (1 - nfx) * (1 - nfz) + h[j + 1]! * nfx * (1 - nfz) + h[j + nx]! * (1 - nfx) * nfz + h[j + nx + 1]! * nfx * nfz;
      const dh = newH - height;

      let cap = -dh * speed * water * p.capacity;
      if (cap < p.minCapacity) cap = p.minCapacity;
      if (sediment > cap || dh > 0) {
        const amount = dh > 0 ? (dh < sediment ? dh : sediment) : (sediment - cap) * p.depositRate;
        sediment -= amount;
        h[i] = h00 + amount * (1 - fx) * (1 - fz);
        h[i + 1] = h10 + amount * fx * (1 - fz);
        h[i + nx] = h01 + amount * (1 - fx) * fz;
        h[i + nx + 1] = h11 + amount * fx * fz;
      } else {
        let amount = (cap - sediment) * p.erodeRate;
        if (amount > -dh) amount = -dh;
        if (amount > p.maxErodeStep) amount = p.maxErodeStep;
        for (let k = 0; k < nb; k++) {
          const bx = cx + brushDx[k]!;
          const bz = cz + brushDz[k]!;
          if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) continue;
          h[i + brushOff[k]!] = h[i + brushOff[k]!]! - amount * brushW[k]!;
        }
        sediment += amount;
      }
      let v2 = speed * speed - dh * p.gravity;
      if (v2 < 0) v2 = 0;
      speed = Math.sqrt(v2);
      if (speed > p.maxSpeed) speed = p.maxSpeed;
      water *= 1 - p.evaporate;
    }
  }
}
