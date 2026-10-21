/**
 * World-content materials (R-WORLD render): one shared set, every lit material
 * patched with CSM. Procedural tileable textures (no asset downloads):
 * concrete (structures), tunnel lining tiles, galvanised steel, painted metal
 * (vertex colour), lamp lenses (emissive). UVs are metres; `repeat` = 1 / tile.
 */
import { MeshStandardMaterial, Vector2, type DataTexture, type Material, type Texture } from 'three';
import { createRng } from '../../../core/rng';
import { concreteTextures, grimeTexture, makeTexture, normalFromHeight, tileableFbm } from '../colliders';
import type { LightingStack, PatchMaterial } from '../../types';

export interface ContentMaterials {
  concrete: MeshStandardMaterial;
  concreteDark: MeshStandardMaterial;
  tile: MeshStandardMaterial;
  steel: MeshStandardMaterial;
  painted: MeshStandardMaterial;
  lamp: MeshStandardMaterial;
  /** Sidewalk paving: concrete slabs with saw-cut joints every 1.5 m. */
  paving: MeshStandardMaterial;
  all: Material[];
  textures: Texture[];
}

const TEX = 256;

/** Tunnel lining: cream ceramic tiles 0.3 m with grout, traffic grime toward the bottom (v = 0 → 1 over 6 m tile). */
function tileTextures(): { albedo: Uint8Array; normal: Uint8Array } {
  const fine = tileableFbm(311, 16, 3);
  const rng = createRng(313);
  const albedo = new Uint8Array(TEX * TEX * 4);
  const height = new Float32Array(TEX * TEX);
  const tiles = 8; // per texture side
  const tone = new Float32Array(tiles * tiles);
  for (let i = 0; i < tone.length; i++) tone[i] = rng.range(-10, 10);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const tx = (x / TEX) * tiles;
      const ty = (y / TEX) * tiles;
      const fx = tx - Math.floor(tx);
      const fy = ty - Math.floor(ty);
      const grout = Math.min(fx, 1 - fx, fy, 1 - fy) < 0.035;
      const t = tone[Math.floor(ty) * tiles + Math.floor(tx)]!;
      const n = fine(x / TEX, y / TEX);
      const o = (y * TEX + x) * 4;
      const base = grout ? 128 + n * 20 : 214 + t + n * 10;
      albedo[o] = base + 4;
      albedo[o + 1] = base;
      albedo[o + 2] = base - 14;
      albedo[o + 3] = 255;
      height[y * TEX + x] = grout ? 0 : 1;
    }
  }
  return { albedo, normal: normalFromHeight(height, TEX, 1.2) };
}

export function createContentMaterials(maxAniso: number, lighting: LightingStack, patch: PatchMaterial): ContentMaterials {
  const textures: Texture[] = [];
  const tex = (data: Uint8Array, srgb: boolean, tileU: number, tileV: number, size = TEX): DataTexture => {
    const t = makeTexture(data, size, srgb, 1 / tileU, 1 / tileV);
    t.anisotropy = Math.min(8, maxAniso);
    textures.push(t);
    return t;
  };
  const cc = concreteTextures({ seed: 601, tone: 158, tint: [4, 2, -3], formwork: true, streaks: 0.28 });
  const cd = concreteTextures({ seed: 607, tone: 118, tint: [2, 1, -2], streaks: 0.34 });
  const tt = tileTextures();
  const concrete = new MeshStandardMaterial({
    name: 'wc-concrete',
    map: tex(cc.albedo, true, 2.4, 1.2),
    normalMap: tex(cc.normal, false, 2.4, 1.2),
    normalScale: new Vector2(0.9, 0.9),
    roughness: 0.9,
  });
  const concreteDark = new MeshStandardMaterial({
    name: 'wc-concrete-dark',
    map: tex(cd.albedo, true, 3, 3),
    normalMap: tex(cd.normal, false, 3, 3),
    roughness: 0.95,
  });
  const tile = new MeshStandardMaterial({
    name: 'wc-tile',
    map: tex(tt.albedo, true, 2.4, 2.4),
    normalMap: tex(tt.normal, false, 2.4, 2.4),
    normalScale: new Vector2(0.6, 0.6),
    roughness: 0.32,
  });
  const steel = new MeshStandardMaterial({ name: 'wc-steel', color: 0xb4b9be, metalness: 0.8, roughness: 0.42, map: tex(grimeTexture(611), true, 1.5, 1.5, 128) });
  const painted = new MeshStandardMaterial({ name: 'wc-painted', vertexColors: true, metalness: 0.2, roughness: 0.55, map: tex(grimeTexture(613), true, 1.2, 1.2, 128) });
  const lamp = new MeshStandardMaterial({ name: 'wc-lamp', color: 0xfff4e0, emissive: 0xffd9a8, emissiveIntensity: 1.6, roughness: 0.3 });
  const pv = concreteTextures({ seed: 619, tone: 176, tint: [3, 2, -2], formwork: true, streaks: 0.05 });
  const paving = new MeshStandardMaterial({
    name: 'wc-paving',
    map: tex(pv.albedo, true, 1.5, 1.5),
    normalMap: tex(pv.normal, false, 1.5, 1.5),
    roughness: 0.92,
  });
  const all: Material[] = [concrete, concreteDark, tile, steel, painted, lamp, paving];
  for (const m of all) patch(m, { csm: lighting.csm });
  return { concrete, concreteDark, tile, steel, painted, lamp, paving, all, textures };
}
