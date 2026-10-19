/**
 * Stand-in TerrainData for the terrain preview while src/world/terrain.ts
 * (generateTerrain, agent A) is absent. Loosely follows DEFAULT_LAYOUT
 * (peaks, lake, arena, rim) so the showcase viewpoints frame something
 * sensible. Dev only — never shipped, never used once generateTerrain exists.
 */
import { createFbm2, createRidged2, createSeededNoise2D } from '../src/core/noise';
import { MaterialId } from '../src/protocol/messages';
import type { MountainsZone, TerrainData, WorldLayout } from '../src/world/types';

const sstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function syntheticTerrain(layout: WorldLayout): TerrainData {
  const spacing = layout.terrain.spacing;
  const cols = layout.size / spacing + 1;
  const rows = cols;
  const originX = -layout.size / 2;
  const originZ = -layout.size / 2;
  const n = cols * rows;
  const heights = new Float32Array(n);
  const splat = new Uint8Array(n * 4);
  const material = new Uint8Array(n);
  const detail = createFbm2(createSeededNoise2D(layout.seed), 4);
  const ridged = createRidged2(createSeededNoise2D(layout.seed + 1), 5);
  const patch = createFbm2(createSeededNoise2D(layout.seed + 2), 3);
  const range = layout.zones.find((z) => z.kind === 'mountains') as MountainsZone | undefined;
  const peaks = range?.params.peaks ?? [];
  const half = layout.size / 2;
  for (let r = 0; r < rows; r++) {
    const z = originZ + r * spacing;
    for (let c = 0; c < cols; c++) {
      const x = originX + c * spacing;
      let h = layout.terrain.baseHeight + detail(x / 220, z / 220) * 2.5;
      let m = 0;
      for (const p of peaks) {
        const dx = (x - p.center[0]) / p.radiusX;
        const dz = (z - p.center[1]) / p.radiusZ;
        const u2 = dx * dx + dz * dz;
        if (u2 < 1) m = Math.max(m, p.height * (1 - u2) * (1 - u2));
      }
      h += m + (m / 150) * ridged(x / 140, z / 140) * 18;
      // lake
      const lx = (x + 330) / 165;
      const lz = (z - 340) / 135;
      const lr = Math.sqrt(lx * lx + lz * lz);
      if (lr < 1) h = layout.waterLevel - 8 * (1 - lr * lr);
      else if (lr < 1 + 30 / 150) h = h + (layout.waterLevel + 1.2 - h) * (1 - sstep((lr - 1) / 0.2));
      // arena pad
      const ax = Math.max(0, Math.abs(x - 360) - 90);
      const az = Math.max(0, Math.abs(z - 330) - 90);
      const ad = Math.sqrt(ax * ax + az * az);
      const arenaM = 1 - sstep(ad / 30);
      h = h + (10.5 - h) * arenaM;
      // rim
      const edge = half - Math.max(Math.abs(x), Math.abs(z));
      h += 40 * sstep(1 - edge / 90);
      heights[r * cols + c] = h;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = originX + c * spacing;
      const z = originZ + r * spacing;
      const cm = Math.max(c - 1, 0);
      const cp = Math.min(c + 1, cols - 1);
      const rm = Math.max(r - 1, 0);
      const rp = Math.min(r + 1, rows - 1);
      const gx = (heights[r * cols + cp]! - heights[r * cols + cm]!) / ((cp - cm) * spacing);
      const gz = (heights[rp * cols + c]! - heights[rm * cols + c]!) / ((rp - rm) * spacing);
      const slope = Math.sqrt(gx * gx + gz * gz);
      const h = heights[i]!;
      let paved = 0;
      let dirt = 0;
      let rock = 0;
      let gravel = 0;
      const ax = Math.abs(x - 360) - 90;
      const az = Math.abs(z - 330) - 90;
      const inArena = ax < 0 && az < 0;
      if (inArena) paved = 1;
      else {
        rock = sstep((slope - 0.45) / 0.35) + sstep((h - 120) / 40) * 0.6;
        const pn = patch(x / 60, z / 60);
        dirt = sstep((pn - 0.15) / 0.3) * 0.8;
        const shore = h - layout.waterLevel;
        gravel = sstep(1 - Math.abs(shore - 0.6) / 1.4) * 0.9;
        if (shore < 0) dirt = 1;
      }
      let s = paved + dirt + rock + gravel;
      if (s > 1) {
        paved /= s;
        dirt /= s;
        rock /= s;
        gravel /= s;
        s = 1;
      }
      const R = Math.floor(paved * 255);
      const G = Math.floor(dirt * 255);
      const B = Math.floor(rock * 255);
      const A = Math.max(0, Math.min(255 - R - G - B, Math.floor(gravel * 255)));
      splat[i * 4] = R;
      splat[i * 4 + 1] = G;
      splat[i * 4 + 2] = B;
      splat[i * 4 + 3] = A;
      const grass = 255 - R - G - B - A;
      const best = Math.max(R, G, B, A, grass);
      material[i] = inArena
        ? MaterialId.concrete
        : best === B
          ? MaterialId.rock
          : best === G
            ? MaterialId.dirt
            : best === A
              ? MaterialId.gravel
              : MaterialId.grass;
    }
  }
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < n; i++) {
    minHeight = Math.min(minHeight, heights[i]!);
    maxHeight = Math.max(maxHeight, heights[i]!);
  }
  return {
    layoutId: layout.id,
    layoutVersion: layout.version,
    seed: layout.seed,
    originX,
    originZ,
    spacing,
    cols,
    rows,
    heights,
    splat,
    material,
    minHeight,
    maxHeight,
    waterLevel: layout.waterLevel,
    roads: [],
    spawns: [],
    hash: 0,
  };
}
