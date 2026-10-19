/**
 * Water renderer (P5, U5 owns this directory). CONTRACT: ./types.ts.
 * P5 contract STUB: an empty group, wired into main.ts.
 */
import { Group } from 'three';

import type { CreateWaterRenderer, WaterRenderer } from './types';

export const createWaterRenderer: CreateWaterRenderer = (_ctx, bodies): WaterRenderer => {
  const object = new Group();
  object.name = 'water';
  return {
    object,
    stats: { bodies: bodies.length, reflectionRendered: false, reflectionDraws: 0 },
    update() {},
    setQuality() {},
    dispose() {},
  };
};
