/**
 * Vegetation scatter (P5, U4 owns this file). CONTRACT: VegetationScatter /
 * ScatterVegetation / HashVegetation in ./types (placement + collider
 * rules there). This is the P5 contract STUB: an empty scatter, so the
 * worker (collider install) and main (terrain helper worker, renderer)
 * are wired before U4 lands the real generator.
 */
import type { HashVegetation, ScatterVegetation, VegetationScatter } from './types';

export function emptyScatter(): VegetationScatter {
  return {
    count: 0,
    kind: new Uint8Array(0),
    x: new Float32Array(0),
    y: new Float32Array(0),
    z: new Float32Array(0),
    scale: new Float32Array(0),
    yaw: new Float32Array(0),
    variant: new Uint8Array(0),
    rank: new Float32Array(0),
    collider: new Int32Array(0),
    colliders: [],
    hash: 0,
  };
}

export const hashVegetation: HashVegetation = (s) => {
  let h = 0x811c9dc5;
  const mix = (w: number): void => {
    h = Math.imul(h ^ w, 0x01000193) >>> 0;
  };
  mix(s.count);
  const f = new Uint32Array(1);
  const ff = new Float32Array(f.buffer);
  for (let i = 0; i < s.count; i++) {
    mix(s.kind[i]!);
    for (const a of [s.x, s.y, s.z, s.scale]) {
      ff[0] = a[i]!;
      mix(f[0]!);
    }
    mix(s.collider[i]! >>> 0);
  }
  return h >>> 0;
};

/** STUB (U4 replaces): no instances. */
export const scatterVegetation: ScatterVegetation = (_layout, _terrain) => {
  const s = emptyScatter();
  s.hash = hashVegetation(s);
  return s;
};

/** Typed-array buffers of a scatter (transfer list for the terrain helper worker). */
export function scatterBuffers(s: VegetationScatter): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const a of [s.kind, s.x, s.y, s.z, s.scale, s.yaw, s.variant, s.rank, s.collider]) {
    if (a.buffer instanceof ArrayBuffer && a.buffer.byteLength > 0 && !out.includes(a.buffer)) out.push(a.buffer);
  }
  return out;
}
