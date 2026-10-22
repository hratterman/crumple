/**
 * R-CRASH roof structure helpers (pure data, main-importable like the defs). See defs/sedan.ts "roof
 * strength" for the why: the roof / pillar members yield at a realistic collapse load (the platen SWR of
 * roofStrength.ts) instead of carrying the roof elastically to 25 % strain.
 */
import type { RigBeamDef } from '../rig/types';

/** Node-id glob test (`*` = any suffix). */
export function matchesAny(id: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
}

/**
 * Caps the yield force of every normal beam touching a roof-ring node at `cap` N (its break force scales
 * with it). Returns the number of beams capped.
 */
export function capRoofYield(beams: RigBeamDef[], ring: readonly string[], cap: number): number {
  let n = 0;
  for (const b of beams) {
    if (b.type !== 'normal' || !(b.deform !== undefined && b.deform > cap)) continue;
    if (!matchesAny(b.a, ring) && !matchesAny(b.b, ring)) continue;
    const f = cap / b.deform;
    b.deform = cap;
    if (b.breakF !== undefined && b.breakF > 0) b.breakF = Number((b.breakF * f).toPrecision(3));
    n++;
  }
  return n;
}
