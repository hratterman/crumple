import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import { bindPanels, evalFlexVertex } from './binder';
import { SEDAN_VISUAL } from './defs/sedan';
import { tessellateVehicle } from './loft';

describe('sedan flexbody bake', () => {
  const compiled = compileVehicle(SEDAN);
  const geoms = tessellateVehicle(SEDAN_VISUAL);

  it('binds every panel of SEDAN_VISUAL and reconstructs the rest pose exactly', () => {
    const t0 = performance.now();
    const b = bindPanels(compiled, SEDAN_VISUAL, geoms);
    const ms = performance.now() - t0;
    console.info(`[sedan bake] ${b.panels.length} panels, ${b.stats.vertices} verts, bind ${ms.toFixed(0)} ms, repaired ${b.stats.repaired}`);
    expect(b.panels.length).toBe(SEDAN_VISUAL.panels.length);
    // Budget at load is 300 ms (measured ~130–150 ms warm on an idle core); loose here: the full suite runs files in parallel.
    expect(ms).toBeLessThan(5000);
    const out = new Float64Array(6);
    let max = 0;
    for (const p of b.panels) {
      for (let v = 0; v < p.vertexCount; v += 7) {
        evalFlexVertex(p, v, compiled.rig.nodePos, out);
        for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(out[k]! - p.restPosition[3 * v + k]!));
      }
    }
    expect(max).toBeLessThan(1e-5);
  });
});
