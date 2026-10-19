/**
 * Far land: a render-only ring of hills and mountains around the playable
 * square, from its border out to FARLAND_OUTER_M, so the valley sits in a
 * mountain bowl instead of ending at a void (from the summit or any high
 * point the map edge is in view). Not part of the world contract or
 * collision: the layout's edge rise walls the playable area in.
 *
 * Polar grid around the map centre: the inner edge lies exactly on the
 * square border with the terrain's border heights (a hair lower, so a LOD
 * crack never shows sky); heights blend over FARLAND_BLEND_M into ridged
 * mountains that grow with distance (higher to the north, behind the
 * Crumple Range) and close the outer edge above the sight line from the
 * summit. Vertex-coloured lit material (patched with CSM like every lit
 * material); the height fog gives it aerial perspective.
 */
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, type Object3D } from 'three';

import { createFbm2, createRidged2, createSeededNoise2D } from '../../core/noise';
import type { TerrainData } from '../../world/types';
import type { PatchMaterial, LightingStack } from '../types';

/** Outer radius of the ring from the map centre, m (camera.far must cover it from any map corner). */
export const FARLAND_OUTER_M = 1750;
/** Distance beyond the border over which border heights hand over to the far relief, m. */
const FARLAND_BLEND_M = 420;
const ANGULAR = 960;
const RADIAL = 48;

export interface FarLand {
  readonly object: Object3D;
  dispose(): void;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear terrain height, clamped to the grid. */
function borderHeight(t: TerrainData, x: number, z: number): number {
  const u = Math.min(Math.max((x - t.originX) / t.spacing, 0), t.cols - 1.0001);
  const v = Math.min(Math.max((z - t.originZ) / t.spacing, 0), t.rows - 1.0001);
  const c = Math.floor(u);
  const r = Math.floor(v);
  const fx = u - c;
  const fz = v - r;
  const H = t.heights;
  const i = r * t.cols + c;
  const a = H[i]! + (H[i + 1]! - H[i]!) * fx;
  const b = H[i + t.cols]! + (H[i + t.cols + 1]! - H[i + t.cols]!) * fx;
  return a + (b - a) * fz;
}

export function createFarLand(terrain: TerrainData, opts: { lighting: LightingStack; patchMaterial: PatchMaterial }): FarLand {
  const half = ((terrain.cols - 1) * terrain.spacing) / 2;
  const cx = terrain.originX + half;
  const cz = terrain.originZ + half;
  const seed = (terrain.seed ^ 0x6a09e667) >>> 0;
  const base = createFbm2(createSeededNoise2D(seed), 4);
  const massif = createFbm2(createSeededNoise2D(seed + 3), 3);
  const ridge = createRidged2(createSeededNoise2D(seed + 1), 3, 2.1, 0.45);
  const tint = createFbm2(createSeededNoise2D(seed + 2), 3);

  const cols = ANGULAR + 1;
  const n = cols * (RADIAL + 1);
  const pos = new Float32Array(n * 3);
  for (let j = 0; j <= RADIAL; j++) {
    const s = j / RADIAL;
    for (let i = 0; i <= ANGULAR; i++) {
      const th = ((i % ANGULAR) / ANGULAR) * Math.PI * 2;
      const dx = Math.cos(th);
      const dz = Math.sin(th);
      const rIn = half / Math.max(Math.abs(dx), Math.abs(dz));
      const r = rIn + (FARLAND_OUTER_M - rIn) * s ** 1.6;
      const x = cx + dx * r;
      const z = cz + dz * r;
      const beyond = r - rIn;
      let h: number;
      if (j === 0) {
        h = borderHeight(terrain, x, z) - 0.25;
      } else {
        const hb = borderHeight(terrain, cx + dx * rIn, cz + dz * rIn);
        const north = Math.max(0, -dz); // Crumple Range side
        const amp = (60 + 230 * smooth(80, 1000, beyond)) * (0.8 + 0.5 * north);
        // Rounded massifs with a soft ridge line (sharp ridged crests alias into slivers at this tessellation).
        const m = 0.55 * ridge(x / 1400, z / 1400) ** 2 + 0.45 * (0.5 + 0.5 * massif(x / 900, z / 900));
        const far = 42 + 26 * base(x / 520, z / 520) + amp * m;
        // close the outer edge above the summit's sight line (~150 m)
        const rim = (150 + 60 * base(x / 300 + 7, z / 300)) * smooth(0.82, 1, s);
        h = hb + (Math.max(far, rim) - hb) * smooth(0, FARLAND_BLEND_M, beyond);
      }
      const o = (j * cols + i) * 3;
      pos[o] = x;
      pos[o + 1] = h;
      pos[o + 2] = z;
    }
  }
  const index = new Uint32Array(ANGULAR * RADIAL * 6);
  let k = 0;
  for (let j = 0; j < RADIAL; j++) {
    for (let i = 0; i < ANGULAR; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Counter-clockwise seen from above (normals up).
      index[k++] = a;
      index[k++] = b;
      index[k++] = c;
      index[k++] = b;
      index[k++] = d;
      index[k++] = c;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  // Seam at θ = 0 / 2π: average the duplicated column's normals.
  const nrm = geometry.getAttribute('normal') as BufferAttribute;
  for (let j = 0; j <= RADIAL; j++) {
    const a = j * cols;
    const b = a + ANGULAR;
    for (let c = 0; c < 3; c++) {
      const v = (nrm.array[a * 3 + c]! + nrm.array[b * 3 + c]!) / 2;
      (nrm.array as Float32Array)[a * 3 + c] = v;
      (nrm.array as Float32Array)[b * 3 + c] = v;
    }
  }

  // Vertex colours (linear), matched to the terrain layer means: dry grass low, scrub, rock on slopes and heights.
  const col = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3]!;
    const y = pos[v * 3 + 1]!;
    const z = pos[v * 3 + 2]!;
    const ny = nrm.array[v * 3 + 1]!;
    const tn = tint(x / 180, z / 180);
    // Forested slopes (dark, so ridges layer against the haze), dry grass low near the map, rock on steep or high ground.
    const rock = Math.min(1, smooth(0.8, 0.6, ny) + 0.7 * smooth(200, 330, y));
    const forest = smooth(70, 120, y) * smooth(-0.6, 0.2, tn) * (1 - rock);
    const dry = smooth(-0.3, 0.5, tn) * 0.7;
    const grass = [0.07 + 0.05 * dry, 0.085 + 0.012 * dry, 0.032 + 0.025 * dry];
    const g = [grass[0]! + (0.022 - grass[0]!) * forest, grass[1]! + (0.034 - grass[1]!) * forest, grass[2]! + (0.016 - grass[2]!) * forest];
    const rk = [0.085, 0.079, 0.072];
    const shade = 0.85 + 0.3 * tint(x / 60 + 3, z / 60);
    for (let c = 0; c < 3; c++) col[v * 3 + c] = (g[c]! + (rk[c]! - g[c]!) * rock) * shade;
  }
  geometry.setAttribute('color', new BufferAttribute(col, 3));
  geometry.computeBoundingSphere();

  const material = new MeshStandardMaterial({ name: 'farland', vertexColors: true, roughness: 0.96, metalness: 0 });
  const set = opts.patchMaterial(material, { csm: opts.lighting.csm });
  const mesh = new Mesh(geometry, set.color);
  mesh.name = 'farland';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;

  return {
    object: mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
