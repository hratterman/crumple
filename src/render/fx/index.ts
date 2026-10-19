/**
 * World FX (P5, U3 owns this directory). CONTRACT: ./types.ts.
 * P5 contract STUB: an empty group, wired into main.ts (events, vehicles,
 * props) so U3 only fills this module.
 */
import { Group } from 'three';

import type { CreateFxSystem, FxSystem } from './types';

export const createFxSystem: CreateFxSystem = (_ctx, _opts): FxSystem => {
  const object = new Group();
  object.name = 'fx';
  return {
    object,
    stats: { particles: 0, debris: 0, skidSegments: 0, drawCalls: 0 },
    update() {},
    setQuality() {},
    onImpact() {},
    onBeamBreak() {},
    onSkid() {},
    addVehicle() {},
    addProps() {},
    removeObject() {},
    clear() {},
    dispose() {},
  };
};
