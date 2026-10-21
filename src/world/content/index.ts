/**
 * buildWorldContent (layout v6, R-WORLD): the map's generated content —
 * contract in ./types.ts and docs/CONTRACTS.md "R-WORLD contracts".
 * Pure; generator numerics for everything hashed (colliders, props, signals).
 */
import { buildSignalPlans } from '../signals';
import { buildStructures } from './structures';
import { buildTown } from './town';
import { buildAreas } from './areas';
import { buildDetail } from './detail';
import type { TerrainData, WorldLayout } from '../types';
import type { ContentRender, WorldContent, WorldContentOptions } from './types';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Word-wise FNV-1a over the sim-relevant content (ids as UTF-16 units, numbers as f64 words). */
export function hashContent(c: Pick<WorldContent, 'colliders' | 'props' | 'signals' | 'plantings'>): number {
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
  num(c.plantings.length);
  for (const p of c.plantings) {
    num(p.kind);
    num(p.x);
    num(p.z);
    num(p.scale);
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
  // A terrain that is not this layout's (test doubles: synthetic grids without the roads) gets no content.
  const ours = terrain.roads.length === layout.roads.length && terrain.roads.every((r, i) => r.id === layout.roads[i]!.id);
  if (!ours) {
    const empty: WorldContent = { layoutId: layout.id, layoutVersion: layout.version, colliders: [], props: [], exclusions: [], plantings: [], signals: [], lights: [], render: opts.render ? emptyRender() : null, hash: 0 };
    empty.hash = hashContent(empty);
    return empty;
  }
  const signals = buildSignalPlans(layout, terrain);
  const render = opts.render ? emptyRender() : null;
  const content: WorldContent = {
    layoutId: layout.id,
    layoutVersion: layout.version,
    colliders: [],
    props: [],
    exclusions: [],
    plantings: [],
    signals,
    lights: [],
    render,
    hash: 0,
  };
  // Bridges + tunnels (every RoadProfile.structures span).
  const st = buildStructures(terrain);
  content.colliders.push(...st.colliders);
  content.lights.push(...st.lights);
  content.exclusions.push(...st.exclusions);
  render?.structures.push(...st.render);
  // Millbrook (buildings, kerbs, furniture, lights, signals, trees). Content prop instance indices
  // follow the layout's expanded props (rows × stacks), which the light records reference.
  let propBase = 0;
  for (const pr of layout.props) propBase += (pr.row ? pr.row.count : 1) * (pr.stack ?? 1);
  const town = buildTown(layout, terrain, signals, propBase + content.props.length);
  content.colliders.push(...town.colliders);
  content.props.push(...town.props);
  content.exclusions.push(...town.exclusions);
  content.lights.push(...town.lights);
  content.plantings.push(...town.plantings);
  if (render) {
    render.buildings.push(...town.buildings);
    render.items.push(...town.items);
    render.decals.push(...town.decals);
    render.strips.push(...town.strips);
    render.cables.push(...town.cables);
  }
  // Mode areas, interchange furniture, landmarks.
  const areas = buildAreas(layout, terrain, propBase + content.props.length);
  content.colliders.push(...areas.colliders);
  content.props.push(...areas.props);
  content.exclusions.push(...areas.exclusions);
  content.lights.push(...areas.lights);
  content.plantings.push(...areas.plantings);
  if (render) {
    render.buildings.push(...areas.buildings);
    render.items.push(...areas.items);
    render.decals.push(...areas.decals);
    render.strips.push(...areas.strips);
    render.cables.push(...areas.cables);
    render.structures.push(...areas.structures);
  }
  // Natural detail: fallen logs (solid) + render-only flowers, tussocks, rubbish, stones.
  const detail = buildDetail(layout, terrain, content.exclusions, opts.render);
  content.colliders.push(...detail.colliders);
  content.exclusions.push(...detail.exclusions);
  render?.items.push(...detail.items);
  content.hash = hashContent(content);
  return content;
}
