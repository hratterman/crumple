import { describe, expect, it } from 'vitest';

import { patchMaterial } from '../material';
import type { LightingStack, RenderContext } from '../types';
import { bodyVisibleIn, createVehicleVisual, VEHICLE_DEBUG_VIEWS } from './index';
import { syntheticCubeSubject } from './synthetic';
import type { VehicleFrameInput } from './types';

const ctx = {
  renderer: { capabilities: { getMaxAnisotropy: () => 1 } },
  quality: { level: 'low' },
} as unknown as RenderContext;
const lighting = { csm: null } as unknown as LightingStack;

describe('createVehicleVisual (synthetic subject)', () => {
  const s = syntheticCubeSubject(10);
  const visual = createVehicleVisual(ctx, s.compiled, s.def, { lighting, patchMaterial, geoms: s.geoms, fx: false });

  it('assembles binding, skin, wheels and damage', () => {
    expect(visual.binding.panels.length).toBe(2);
    expect(visual.skin.meshes.length).toBe(1); // both synthetic panels are paint: one merged draw
    expect(visual.lodBindings.length).toBe(0); // no registered LOD defs for the synthetic subject
    expect(visual.object.children).toContain(visual.skin.object);
    expect(visual.object.children).toContain(visual.wheels.object);
    expect(visual.timings.bindMs).toBeGreaterThanOrEqual(0);
  });

  it('update writes the node texture at the anchor', () => {
    const rig = s.compiled.rig;
    const nodes = new Float32Array(rig.nodeCount * 3);
    for (let i = 0; i < nodes.length; i += 3) {
      nodes[i] = rig.nodePos[i]! + 100;
      nodes[i + 1] = rig.nodePos[i + 1]! + 5;
      nodes[i + 2] = rig.nodePos[i + 2]!;
    }
    const frame: VehicleFrameInput = {
      nodes,
      nodeOffset: 0,
      tick: 10,
      broken: new Uint8Array(rig.beamCount),
      repairEpoch: 0,
      telemetry: null,
      dtS: 1 / 60,
    };
    visual.update(frame);
    const a = s.compiled.frameNodes[0]!;
    expect(visual.skin.anchor[0]).toBeCloseTo(nodes[3 * a]!, 5);
    expect(visual.skin.nodeData[4 * a]).toBe(0);
  });

  it('debug views toggle the body only in body modes', () => {
    expect(VEHICLE_DEBUG_VIEWS).toEqual(['body', 'body+beams', 'beams', 'nodes']);
    for (const v of VEHICLE_DEBUG_VIEWS) {
      visual.setDebugView(v);
      expect(visual.debugView).toBe(v);
      expect(visual.skin.object.visible).toBe(bodyVisibleIn(v));
      expect(visual.wheels.object.visible).toBe(bodyVisibleIn(v));
    }
    visual.dispose();
  });
});
