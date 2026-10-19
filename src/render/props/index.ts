/**
 * Prop renderer (P5, U2 owns this directory). CONTRACT: ./types.ts.
 * P5 contract STUB: an empty group, wired into main.ts so U2 only fills
 * this module.
 */
import { Group } from 'three';

import type { CreatePropRenderer, PropRenderer } from './types';

export const createPropRenderer: CreatePropRenderer = (_ctx, instances, _opts): PropRenderer => {
  const root = new Group();
  root.name = 'props';
  const stats = { instances: instances.length, visibleInstances: 0, awake: 0, drawCalls: 0 };
  return {
    object: root,
    root,
    stats,
    update() {},
    setQuality() {},
    addInstances(list) {
      stats.instances += list.length;
    },
    removeInstance() {},
    onImpact() {},
    onBeamBreak() {},
    dispose() {},
  };
};
