/**
 * Vegetation renderer (P5, U4 owns this directory). CONTRACT: ./types.ts.
 * P5 contract STUB: an empty group, wired into main.ts.
 */
import { Group } from 'three';

import type { CreateVegetationRenderer, VegetationRenderer } from './types';

export const createVegetationRenderer: CreateVegetationRenderer = (_ctx, scatter): VegetationRenderer => {
  const object = new Group();
  object.name = 'vegetation';
  return {
    object,
    stats: { eligible: scatter.count, meshInstances: 0, impostors: 0, grassTufts: 0, drawCalls: 0 },
    update() {},
    setQuality() {},
    dispose() {},
  };
};
