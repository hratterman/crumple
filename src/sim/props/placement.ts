/**
 * Layout prop expansion (P5, U1 owns this file). CONTRACT:
 * ResolvePropInstances in ./types. P5 contract STUB: the layout has no
 * props until U2 places them, so an empty list resolves to [] and anything
 * else throws until U1 lands the catalog + this resolver.
 */
import { WorldLayoutError } from '../../world/types';
import type { ResolvePropInstances } from './types';

export const resolvePropInstances: ResolvePropInstances = (placements, _heightAt) => {
  if (placements.length === 0) return [];
  throw new WorldLayoutError('resolvePropInstances: prop catalog not implemented yet (P5 U1)');
};
