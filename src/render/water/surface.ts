/**
 * Water surface geometry: a flat grid at y = level over the body's field,
 * keeping only cells that touch the flooded region (dilated by one terrain
 * sample) so the mesh hugs the shoreline. The kept cells' outer parts lie
 * over land ABOVE the level, where the terrain occludes them and the shader
 * fades alpha by the true (bilinear) depth: no rectangle edge is ever seen.
 */
import { BufferAttribute, BufferGeometry } from 'three';

import type { WaterField } from '../../world/water';

/** Grid cell size, m (the surface is flat: the cells only need to follow the shoreline). */
export const WATER_CELL_M = 4;

export interface SurfaceCells {
  /** Cells along x / z. */
  nx: number;
  nz: number;
  cell: number;
  originX: number;
  originZ: number;
  /** 1 = cell kept (nz × nx, row-major). */
  keep: Uint8Array;
  kept: number;
}

/** Which grid cells the water mesh needs (pure; exported for tests). */
export function selectSurfaceCells(field: WaterField, cellM = WATER_CELL_M): SurfaceCells {
  const { cols, rows, spacing, mask } = field;
  const per = Math.max(1, Math.round(cellM / spacing));
  const cell = per * spacing;
  const nx = Math.max(1, Math.ceil((cols - 1) / per));
  const nz = Math.max(1, Math.ceil((rows - 1) / per));
  const keep = new Uint8Array(nx * nz);
  let kept = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      // samples covered by the cell, grown by one sample (bilinear shoreline reaches half a sample out)
      const c0 = Math.max(0, i * per - 1);
      const c1 = Math.min(cols - 1, (i + 1) * per + 1);
      const r0 = Math.max(0, j * per - 1);
      const r1 = Math.min(rows - 1, (j + 1) * per + 1);
      let hit = false;
      for (let r = r0; r <= r1 && !hit; r++) {
        for (let c = c0; c <= c1; c++) {
          if (mask[r * cols + c]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        keep[j * nx + i] = 1;
        kept++;
      }
    }
  }
  return { nx, nz, cell, originX: field.originX, originZ: field.originZ, keep, kept };
}

/** Indexed geometry of the kept cells at y = level (world space; the mesh has an identity transform). */
export function buildSurfaceGeometry(cells: SurfaceCells, level: number): BufferGeometry {
  const { nx, nz, cell, originX, originZ, keep } = cells;
  const vid = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const pos: number[] = [];
  const idx: number[] = [];
  const vert = (i: number, j: number): number => {
    const k = j * (nx + 1) + i;
    if (vid[k]! < 0) {
      vid[k] = pos.length / 3;
      pos.push(originX + i * cell, level, originZ + j * cell);
    }
    return vid[k]!;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!keep[j * nx + i]) continue;
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c = vert(i, j + 1);
      const d = vert(i + 1, j + 1);
      // CCW seen from above (+Y normal)
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  const p = new Float32Array(pos);
  g.setAttribute('position', new BufferAttribute(p, 3));
  const n = new Float32Array(p.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new BufferAttribute(n, 3));
  g.setIndex(pos.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(idx), 1) : new BufferAttribute(new Uint16Array(idx), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
