import { describe, expect, it } from 'vitest';
import { MATERIAL_COUNT, MaterialId, TERRAIN_SURFACE_IDS, isTerrainMaterial } from '../protocol/messages';
import { MATERIAL_FRICTION } from '../sim/collision/materials';
import { SURFACE_PHYSICS, isSoftSurface } from './surfaces';

describe('surface physics table (layout v6)', () => {
  it('covers every MaterialId and matches the sim friction table', () => {
    expect(SURFACE_PHYSICS.length).toBe(MATERIAL_COUNT);
    for (const [name, id] of Object.entries(MaterialId)) {
      const e = SURFACE_PHYSICS[id]!;
      expect(e.name).toBe(name);
      expect(e.friction).toBe(MATERIAL_FRICTION[name as keyof typeof MaterialId]);
    }
  });
  it('classifies terrain and soft surfaces', () => {
    for (const id of TERRAIN_SURFACE_IDS) expect(isTerrainMaterial(id)).toBe(true);
    for (const id of [7, 8, 9, 10, 15, -1]) expect(isTerrainMaterial(id)).toBe(false);
    expect(isSoftSurface(MaterialId.mud)).toBe(true);
    expect(isSoftSurface(MaterialId.sand)).toBe(true);
    expect(isSoftSurface(MaterialId.asphaltWorn)).toBe(false);
    expect(SURFACE_PHYSICS[MaterialId.mud]!.rolling).toBeGreaterThan(SURFACE_PHYSICS[MaterialId.asphalt]!.rolling * 10);
  });
});
