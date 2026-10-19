import { describe, expect, it } from 'vitest';

import { PROP_KEYS } from '../../sim/props/types';
import { evalFlexVertex } from '../vehicle/binder';
import { bindPropVisual } from './visuals';

describe('prop visuals bind to the catalog rigs', () => {
  for (const key of PROP_KEYS) {
    it(`${key}: every vertex binds and reconstructs its rest pose (LOD0 + LOD1)`, () => {
      for (const lod of [0, 1] as const) check(key, lod);
    }, 60_000);
  }
  function check(key: (typeof PROP_KEYS)[number], lod: 0 | 1): void {
    {
      const pb = bindPropVisual(key, lod);
      const nodes = pb.rig.nodePos;
      const out = new Float64Array(6);
      let maxErr = 0;
      let maxNrm = 0;
      let verts = 0;
      for (const p of pb.binding.panels) {
        expect(p.vertexCount).toBeGreaterThan(0);
        for (let v = 0; v < p.vertexCount; v++) {
          evalFlexVertex(p, v, nodes, out);
          for (let k = 0; k < 3; k++) {
            maxErr = Math.max(maxErr, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
            maxNrm = Math.max(maxNrm, Math.abs(out[3 + k]! - p.restNormal[3 * v + k]!));
          }
        }
        verts += p.vertexCount;
      }
      expect(maxErr).toBeLessThan(1e-4);
      expect(maxNrm).toBeLessThan(1e-3);
      expect(verts).toBeLessThan(12000);
      // anchors are never bound
      const anchors = new Set(pb.rig.nodeIds.map((id, i) => (id.startsWith('anchor_') ? i : -1)).filter((i) => i >= 0));
      for (const p of pb.binding.panels) for (const n of p.nodes) expect(anchors.has(n)).toBe(false);
      expect(pb.variants.length).toBe(pb.binding.panels.length);
    }
  }

  it('a rigid motion of the nodes moves every vertex rigidly', () => {
    const pb = bindPropVisual('barrel');
    const src = pb.rig.nodePos;
    const moved = new Float64Array(src.length);
    const c = Math.cos(0.7), s = Math.sin(0.7);
    for (let i = 0; i < src.length; i += 3) {
      moved[i] = c * src[i]! + s * src[i + 2]! + 3;
      moved[i + 1] = src[i + 1]! + 1;
      moved[i + 2] = -s * src[i]! + c * src[i + 2]! - 2;
    }
    const out = new Float64Array(6);
    let err = 0;
    for (const p of pb.binding.panels) {
      for (let v = 0; v < p.vertexCount; v += 7) {
        evalFlexVertex(p, v, moved, out);
        const x = p.restPosition[3 * v]!, y = p.restPosition[3 * v + 1]!, z = p.restPosition[3 * v + 2]!;
        err = Math.max(err, Math.abs(out[0]! - (c * x + s * z + 3)), Math.abs(out[1]! - (y + 1)), Math.abs(out[2]! - (-s * x + c * z - 2)));
      }
    }
    expect(err).toBeLessThan(1e-4);
  }, 60_000);
});
