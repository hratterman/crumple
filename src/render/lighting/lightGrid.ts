/**
 * Clustered (world-space tiled) forward lighting for the many cheap lights of
 * the night: streetlights, floodlights, traffic head / tail lamps.
 *
 * Every frame the CPU bins the active lights into a GRID_N × GRID_N grid of
 * GRID_CELL_M cells (XZ, snapped around the camera, ≈ 0.8 km): up to
 * CELL_SLOTS light indices per cell (nearest-to-cell-centre win when a cell
 * overflows). ONE float texture carries it to the GPU (texture units are
 * scarce on the car paint): rows 0–3 hold the light records (4 RGBA32F
 * texels each, 256 per row), rows 4–35 the cell lists (2 texels per cell,
 * index + 1 per channel, 0 = end). The
 * env patch's fragment loop looks up its own cell and runs three's RE_Direct
 * for each listed light, so every world-lit material (terrain, roads, cars,
 * props, foliage) is lit with the full BRDF — no per-light program variants
 * and no recompiles as lights come and go. Unshadowed by design (the player's
 * headlights are the shadowed spot lights, vehicleLights.ts).
 *
 * Cost when no light is near: one uniform branch. Lights are skipped while
 * the sun is well up (the stack sets the global gain to 0).
 */
import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2 } from 'three';

export const GRID_N = 32;
export const GRID_CELL_M = 24;
export const CELL_SLOTS = 8;
export const MAX_GRID_LIGHTS = 255;
const TEXELS_PER_LIGHT = 4;
/** Packed texture: width 256; rows [0, 4) lights, rows [4, 4 + GRID_N) cells. */
export const GRID_TEX_W = 256;
export const GRID_LIGHT_ROWS = 4;
export const GRID_TEX_H = GRID_LIGHT_ROWS + GRID_N;

export interface GridLight {
  x: number;
  y: number;
  z: number;
  /** Cut-off distance, m (three's getDistanceAttenuation cutoff; ~4–6 × the light's "size"). */
  range: number;
  /** Linear RGB × intensity (candela-like: irradiance at 1 m). */
  r: number;
  g: number;
  b: number;
  /** Spot axis (unit) or all 0 for a point light. */
  dx: number;
  dy: number;
  dz: number;
  /** Spot cone cosines (outer < inner); ignored for points. */
  cosOuter: number;
  cosInner: number;
}

export function makeGridLight(p: Partial<GridLight> = {}): GridLight {
  return { x: 0, y: 0, z: 0, range: 20, r: 1, g: 1, b: 1, dx: 0, dy: 0, dz: 0, cosOuter: -2, cosInner: -1, ...p };
}

export interface LightGrid {
  /** Lights + cell lists (see the header). */
  readonly texture: DataTexture;
  /** World XZ of the grid's (0, 0) corner. */
  readonly origin: Vector2;
  /** Number of lights uploaded this frame. */
  readonly count: number;
  /** Bins `lights` (first `n`) around the camera and uploads; lights beyond MAX_GRID_LIGHTS are dropped (nearest kept). */
  build(lights: readonly GridLight[], n: number, camX: number, camZ: number): void;
  readonly stats: { lights: number; cellsUsed: number; overflow: number };
  dispose(): void;
}

/** Cells (ix, iz) a light's sphere of influence touches, clamped to the grid (pure). */
export function cellRange(l: Pick<GridLight, 'x' | 'z' | 'range'>, ox: number, oz: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.floor((l.x - l.range - ox) / GRID_CELL_M));
  const x1 = Math.min(GRID_N - 1, Math.floor((l.x + l.range - ox) / GRID_CELL_M));
  const z0 = Math.max(0, Math.floor((l.z - l.range - oz) / GRID_CELL_M));
  const z1 = Math.min(GRID_N - 1, Math.floor((l.z + l.range - oz) / GRID_CELL_M));
  return [x0, x1, z0, z1];
}

export function createLightGrid(): LightGrid {
  const data = new Float32Array(GRID_TEX_W * GRID_TEX_H * 4);
  const texture = new DataTexture(data, GRID_TEX_W, GRID_TEX_H, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const lightData = data;
  const cellBase = GRID_LIGHT_ROWS * GRID_TEX_W * 4;

  const origin = new Vector2();
  const counts = new Uint8Array(GRID_N * GRID_N);
  /** squared distance of the slot's light to its cell centre (overflow replacement). */
  const slotD = new Float32Array(GRID_N * GRID_N * CELL_SLOTS);
  const order: number[] = [];
  const dist: number[] = [];
  let count = 0;
  const stats = { lights: 0, cellsUsed: 0, overflow: 0 };

  return {
    texture,
    origin,
    get count() {
      return count;
    },
    stats,
    build(lights, n, camX, camZ) {
      const half = (GRID_N * GRID_CELL_M) / 2;
      origin.set(Math.floor((camX - half) / GRID_CELL_M) * GRID_CELL_M, Math.floor((camZ - half) / GRID_CELL_M) * GRID_CELL_M);
      // keep the nearest MAX_GRID_LIGHTS whose influence reaches the grid
      order.length = 0;
      dist.length = n;
      for (let i = 0; i < n; i++) {
        const l = lights[i]!;
        const dx = l.x - camX;
        const dz = l.z - camZ;
        const reach = half + l.range;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
        if (!(l.r + l.g + l.b > 0)) continue;
        dist[i] = dx * dx + dz * dz;
        order.push(i);
      }
      if (order.length > MAX_GRID_LIGHTS) order.sort((a, b) => dist[a]! - dist[b]!);
      count = Math.min(order.length, MAX_GRID_LIGHTS);
      counts.fill(0);
      data.fill(0, cellBase);
      stats.overflow = 0;
      for (let k = 0; k < count; k++) {
        const l = lights[order[k]!]!;
        const o = k * TEXELS_PER_LIGHT * 4; // 4 texels per light, 64 lights per 256-texel row
        lightData[o] = l.x;
        lightData[o + 1] = l.y;
        lightData[o + 2] = l.z;
        lightData[o + 3] = l.range;
        lightData[o + 4] = l.r;
        lightData[o + 5] = l.g;
        lightData[o + 6] = l.b;
        lightData[o + 7] = l.cosInner;
        lightData[o + 8] = l.dx;
        lightData[o + 9] = l.dy;
        lightData[o + 10] = l.dz;
        lightData[o + 11] = l.dx === 0 && l.dy === 0 && l.dz === 0 ? -2 : l.cosOuter;
        const [x0, x1, z0, z1] = cellRange(l, origin.x, origin.y);
        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            // sphere vs cell rectangle
            const nx = Math.max(origin.x + cx * GRID_CELL_M, Math.min(l.x, origin.x + (cx + 1) * GRID_CELL_M));
            const nz = Math.max(origin.y + cz * GRID_CELL_M, Math.min(l.z, origin.y + (cz + 1) * GRID_CELL_M));
            const ddx = l.x - nx;
            const ddz = l.z - nz;
            if (ddx * ddx + ddz * ddz > l.range * l.range) continue;
            const c = cz * GRID_N + cx;
            const ccx = origin.x + (cx + 0.5) * GRID_CELL_M - l.x;
            const ccz = origin.y + (cz + 0.5) * GRID_CELL_M - l.z;
            const dc = ccx * ccx + ccz * ccz;
            let slot = counts[c]!;
            if (slot >= CELL_SLOTS) {
              stats.overflow++;
              // replace the farthest listed light if this one is nearer to the cell centre
              let worst = 0;
              for (let s = 1; s < CELL_SLOTS; s++) if (slotD[c * CELL_SLOTS + s]! > slotD[c * CELL_SLOTS + worst]!) worst = s;
              if (slotD[c * CELL_SLOTS + worst]! <= dc) continue;
              slot = worst;
            } else counts[c] = slot + 1;
            slotD[c * CELL_SLOTS + slot] = dc;
            // cell c → texels (2cx, 4 + cz) and (2cx + 1, 4 + cz); slot s → texel s >> 2, channel s & 3
            data[cellBase + (cz * GRID_TEX_W + cx * 2 + (slot >> 2)) * 4 + (slot & 3)] = k + 1;
          }
        }
      }
      let used = 0;
      for (let c = 0; c < counts.length; c++) if (counts[c]! > 0) used++;
      stats.lights = count;
      stats.cellsUsed = used;
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

/** Fragment loop (inserted before <lights_fragment_end> by the env patch under CRUMPLE_LIGHTS). */
export const LIGHT_GRID_GLSL = /* glsl */ `
#if defined( RE_Direct ) && defined( CRUMPLE_LIGHTS )
  if ( crumpleLightGain > 0.0 ) {
    vec3 clWorld = transpose( mat3( viewMatrix ) ) * ( geometryPosition - viewMatrix[ 3 ].xyz );
    vec2 clG = ( clWorld.xz - crumpleGridOrigin ) / ${GRID_CELL_M}.0;
    if ( clG.x >= 0.0 && clG.y >= 0.0 && clG.x < ${GRID_N}.0 && clG.y < ${GRID_N}.0 ) {
      ivec2 clC = ivec2( floor( clG ) );
      vec4 clA = texelFetch( crumpleLightGrid, ivec2( clC.x * 2, ${GRID_LIGHT_ROWS} + clC.y ), 0 );
      vec4 clB = texelFetch( crumpleLightGrid, ivec2( clC.x * 2 + 1, ${GRID_LIGHT_ROWS} + clC.y ), 0 );
      float clIds[ 8 ] = float[ 8 ]( clA.x, clA.y, clA.z, clA.w, clB.x, clB.y, clB.z, clB.w );
      for ( int k = 0; k < 8; k ++ ) {
        int id = int( clIds[ k ] + 0.5 ) - 1;
        if ( id < 0 ) break;
        ivec2 lt = ivec2( ( id * 4 ) % ${GRID_TEX_W}, ( id * 4 ) / ${GRID_TEX_W} );
        vec4 lp = texelFetch( crumpleLightGrid, lt, 0 );
        vec3 lw = lp.xyz - clWorld;
        float ld = length( lw );
        if ( ld >= lp.w ) continue;
        vec4 lc = texelFetch( crumpleLightGrid, lt + ivec2( 1, 0 ), 0 );
        vec4 ls = texelFetch( crumpleLightGrid, lt + ivec2( 2, 0 ), 0 );
        vec3 ldir = lw / max( ld, 1e-4 );
        float lspot = ls.w < -1.5 ? 1.0 : smoothstep( ls.w, lc.w, dot( -ldir, ls.xyz ) );
        float latt = getDistanceAttenuation( ld, lp.w, 2.0 ) * lspot;
        if ( latt <= 0.0 ) continue;
        IncidentLight clLight;
        clLight.color = lc.rgb * latt * crumpleLightGain;
        clLight.direction = normalize( mat3( viewMatrix ) * ldir );
        clLight.visible = true;
        RE_Direct( clLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
      }
    }
  }
#endif
`;
