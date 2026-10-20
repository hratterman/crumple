/**
 * buildWorldContent (layout v6, R-WORLD): the map's generated content —
 * contract in ./types.ts and docs/CONTRACTS.md "R-WORLD contracts".
 * Pure; generator numerics for everything hashed (colliders, props, signals).
 */
import { buildSignalPlans } from '../signals';
import type { TerrainData, WorldLayout } from '../types';
import type { ContentRender, WorldContent, WorldContentOptions } from './types';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Word-wise FNV-1a over the sim-relevant content (ids as UTF-16 units, numbers as f64 words). */
export function hashContent(c: Pick<WorldContent, 'colliders' | 'props' | 'signals'>): number {
  let h = FNV_OFFSET;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const num = (v: number): void => {
    f64[0] = v;
    h = Math.imul(h ^ u32[0]!, FNV_PRIME) >>> 0;
    h = Math.imul(h ^ u32[1]!, FNV_PRIME) >>> 0;
  };
  const str = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ 0xffff, FNV_PRIME) >>> 0;
  };
  num(c.colliders.length);
  for (const k of c.colliders) {
    str(k.id);
    str(k.kind);
    num(k.pos[0]);
    num(k.pos[1] ?? NaN);
    num(k.pos[2]);
    for (const q of k.quat) num(q);
    for (const v of k.size) num(v);
    num(k.material);
  }
  num(c.props.length);
  for (const p of c.props) {
    str(p.id);
    str(p.prop);
    num(p.pos[0]);
    num(p.pos[1] ?? NaN);
    num(p.pos[2]);
    num(p.facing ? p.facing[0] : 0);
    num(p.facing ? p.facing[1] : -1);
    num(p.stack ?? 1);
    num(p.row ? p.row.count : 1);
  }
  num(c.signals.length);
  for (const s of c.signals) {
    str(s.junction);
    num(s.cycleTicks);
    num(s.offsetTicks);
    num(s.legs.length);
  }
  return h >>> 0;
}

export function emptyRender(): ContentRender {
  return { buildings: [], items: [], decals: [], strips: [], cables: [], structures: [] };
}

/** Pure, deterministic. `opts.render` false (physics worker) skips the render-only part. */
export function buildWorldContent(layout: WorldLayout, terrain: TerrainData, opts: WorldContentOptions): WorldContent {
  const signals = buildSignalPlans(layout, terrain);
  const content: WorldContent = {
    layoutId: layout.id,
    layoutVersion: layout.version,
    colliders: [],
    props: [],
    exclusions: [],
    signals,
    lights: [],
    render: opts.render ? emptyRender() : null,
    hash: 0,
  };
  content.hash = hashContent(content);
  return content;
}
