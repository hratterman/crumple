import { describe, expect, it } from 'vitest';

import { compileVehicle } from '../../../sim/vehicle/builder';
import { SEDAN_TRAFFIC } from '../../../sim/vehicle/defs/sedanTraffic';
import { bindTolerant } from '../index';
import { tessellateVehicle } from '../loft';
import { visualExtras } from '../lods';
import { SEDAN_VISUAL } from './sedan';
import { SEDAN_TRAFFIC_VISUAL } from './sedanTraffic';

const compiled = compileVehicle(SEDAN_TRAFFIC);

describe('SEDAN_TRAFFIC_VISUAL', { timeout: 120_000 }, () => {
  it('names the traffic rig and keeps every sedan panel', () => {
    expect(SEDAN_TRAFFIC_VISUAL.vehicle).toBe(SEDAN_TRAFFIC.name);
    expect(SEDAN_TRAFFIC_VISUAL.panels.map((p) => p.id)).toEqual(SEDAN_VISUAL.panels.map((p) => p.id));
  });

  const extras = visualExtras(SEDAN_TRAFFIC_VISUAL);
  const levels = [() => SEDAN_TRAFFIC_VISUAL, ...(extras.lods ?? [])];
  it('registers LOD1 / LOD2 and the door-card followers', () => {
    expect(extras.lods?.length).toBe(2);
    expect(extras.follow?.doorCardRF).toBe('doorRF');
  });
  levels.forEach((build, lod) => {
    it(`binds to SEDAN_TRAFFIC with zero dropped panels (LOD${lod})`, () => {
      const def = build();
      const bound = bindTolerant(compiled, def, tessellateVehicle(def));
      expect(bound.dropped).toEqual([]);
      expect(bound.binding.panels.length).toBe(def.panels.length);
    });
  });
});
