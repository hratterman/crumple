/**
 * WORLD CONTENT — layout v6 contract (R-WORLD; docs/CONTRACTS.md "R-WORLD
 * contracts"). Everything the map holds beyond terrain, roads and the
 * hand-placed layout colliders / props: Millbrook's buildings, kerbs and
 * street furniture, bridges, tunnels, the interchange, the mode areas
 * (raceway, rally stage, dragway, off-road park, proving ground + crash lab,
 * quarry) and the natural detail scatter.
 *
 * `buildWorldContent(layout, terrain, opts)` (src/world/content/index.ts) is
 * a PURE function of (layout, terrain) with the generator's numeric rules for
 * every field that reaches the sim (colliders, props, signals: only
 * + − × ÷ sqrt floor abs min max, core/rng seeded from layout.seed, fixed
 * iteration order). The physics worker and main's terrain helper worker both
 * call it on identical terrain and compare `hash` (terrainReady.contentHash).
 *
 * WHY generated (not layout data): kerbs, guardrails, parapets, street lights
 * and tape follow the RESOLVED road profiles (terrain-dependent), and the
 * content code (~100 kB) must stay out of main's app chunk: it runs only in
 * the two workers; main receives the result.
 *
 * ORDER in the worker (`groundHeightfield`): generate → content →
 * vegetation scatter (excluding content footprints) → colliders =
 * [...layout.colliders, ...content.colliders, ...vegetation colliders] →
 * water → props = resolvePropInstances([...layout.props, ...content.props]).
 * Content collider ids start `w:`, content prop ids `w:`.
 */
import type { ColliderDef, PropPlacement, Vec2, WorldVec3 } from '../types';
import type { SignalPlan } from '../signals';

export interface WorldContentOptions {
  /** Build the render-only part (main's helper worker); the physics worker passes false. */
  render: boolean;
}

/** Plan-view footprint the vegetation scatter keeps clear (buildings, lots, structures, areas). */
export interface ContentExclusion {
  /** Oriented rectangle: centre, unit axis (local +X), half extents (x along axis, z across). */
  cx: number;
  cz: number;
  ax: number;
  az: number;
  hx: number;
  hz: number;
  /** Also keep the render-only detail scatter (flowers, rubbish, grass clumps) out. */
  detail: boolean;
}

/**
 * LIGHT SOURCES for night lighting (R-GFX consumes; R-WORLD only places them).
 *  - street:  a street-light luminaire (cut-off, points down: dir (0, −1, 0) tilted to the road).
 *  - flood:   a floodlight (stadium / yard / gantry), dir = aim.
 *  - tunnel:  a tunnel lining fitting (continuous rows, low and dense).
 *  - signal:  a traffic-signal head lamp (colour changes; see `signal`).
 *  - window:  lit window glow of a building (area-ish, dim, warm).
 *  - sign:    an illuminated sign / gantry panel.
 *  - beacon:  an aircraft-warning beacon (radio mast, crane), blinking red.
 *  - prop:    a light on a SOFT prop (lightPole): follow node `lamp_0` of layout prop `propIndex`
 *             (objectId PROP_LAYOUT_ID_BASE + propIndex) — it moves when the pole is knocked down.
 * `intensity` is luminous intensity in candela along `dir` (street ≈ 12 000 cd peak for a
 * 150 W LED), `range` the useful reach in m, `angle` the cone half-angle (rad; 0 = point /
 * omni). `color` sRGB hex. `night` true = only on at dusk / night (all but signals).
 */
export type WorldLightKind = 'street' | 'flood' | 'tunnel' | 'signal' | 'window' | 'sign' | 'beacon' | 'prop';
export interface WorldLight {
  kind: WorldLightKind;
  pos: WorldVec3;
  dir: WorldVec3;
  color: number;
  intensity: number;
  range: number;
  angle: number;
  night: boolean;
  /** kind 'prop': layout prop instance index (objectId = PROP_LAYOUT_ID_BASE + propIndex). */
  propIndex?: number;
  /** kind 'signal': which plan / leg / lamp ('red' | 'amber' | 'green') this head lamp shows. */
  signal?: { plan: number; leg: number; lamp: 'red' | 'amber' | 'green' };
  /** Area id (R-GFX may budget lights per area). */
  area?: string;
}

/**
 * RENDER-ONLY content (main). The record shapes below are R-WORLD-internal:
 * they may change without a contract note (only src/render/world/content/**
 * reads them). Every array is in generation order.
 */
export interface ContentRender {
  buildings: BuildingInstance[];
  /** Instanced furniture / detail: one record per instance. */
  items: ItemInstance[];
  /** Flat decals on the ground / road (markings, crosswalks, oil, puddles, parking bays). */
  decals: DecalInstance[];
  /** Sidewalk / kerb strips (render meshes over the kerb colliders + raised terrain). */
  strips: StripInstance[];
  /** Cables (power lines, tape lines, bunting): catenaries between support points. */
  cables: CableInstance[];
  /** Bridges, tunnels, gantries: structure meshes generated from their road spans. */
  structures: StructureInstance[];
}

/** Building styles (modular kit). */
export type BuildingStyle =
  | 'house'
  | 'houseTwoStorey'
  | 'bungalow'
  | 'shop'
  | 'shopRow'
  | 'diner'
  | 'gasStation'
  | 'garage'
  | 'warehouse'
  | 'church'
  | 'office'
  | 'barn'
  | 'silo'
  | 'hangar'
  | 'tower'
  | 'pitGarage'
  | 'lab'
  | 'shed'
  | 'cabin'
  | 'grandstand';
export interface BuildingInstance {
  id: string;
  style: BuildingStyle;
  /** Footprint centre on the ground, ground y. */
  pos: WorldVec3;
  /** Unit (x, z) the FRONT (door / shopfront) faces. */
  front: Vec2;
  /** Footprint half width (across front) and half depth, wall height to the eaves, m. */
  hw: number;
  hd: number;
  height: number;
  /** Storeys (window rows). */
  floors: number;
  roof: 'gable' | 'hip' | 'flat' | 'shed' | 'barrel' | 'none';
  /** Linear-ish palette picks (sRGB hex): walls, trim, roof. */
  wall: number;
  trim: number;
  roofColor: number;
  /** Deterministic variety seed (window layout, interior mapping room set, rooftop clutter). */
  seed: number;
  /** Optional sign text (shops, diner, gas station, garage). */
  sign?: string;
}

/** Instanced static items. Kinds are R-WORLD-internal. */
export interface ItemInstance {
  kind: string;
  pos: WorldVec3;
  /** Unit (x, z) facing. */
  dir: Vec2;
  scale: number;
  variant: number;
  /** Optional tint (sRGB hex) — parked car paint, fence colour… */
  color?: number;
}

export interface DecalInstance {
  kind: string;
  /** Centre on the surface, unit (x, z) along the decal's length axis, half length / half width, m. */
  pos: WorldVec3;
  dir: Vec2;
  hl: number;
  hw: number;
  variant: number;
}

export interface StripInstance {
  kind: 'sidewalk' | 'kerbRedWhite' | 'kerbConcrete' | 'gutter' | 'tape';
  /** Polyline along the strip's inner edge: x, y, z triples; the strip extends `width` to the right of travel (`side` +1) or left (−1). */
  points: number[];
  width: number;
  height: number;
  side: 1 | -1;
}

export interface CableInstance {
  kind: 'power' | 'tape' | 'bunting' | 'wire';
  /** Support points x, y, z triples (a catenary hangs between consecutive points). */
  points: number[];
  sag: number;
}

export interface StructureInstance {
  id: string;
  kind: 'bridge' | 'tunnel' | 'overpass' | 'gantry' | 'startGantry' | 'tree' | 'crane' | 'mast';
  road?: string;
  s0?: number;
  s1?: number;
  pos?: WorldVec3;
  dir?: Vec2;
  /** Free-form numeric params (span width, clearance…), R-WORLD-internal. */
  params?: Record<string, number>;
  /** Gantry sign texts. */
  texts?: string[];
}

export interface WorldContent {
  layoutId: string;
  layoutVersion: number;
  colliders: ColliderDef[];
  props: PropPlacement[];
  exclusions: ContentExclusion[];
  /** Signal plans (buildSignalPlans): the same array the route network's RoutePath.signal indexes. */
  signals: SignalPlan[];
  lights: WorldLight[];
  /** Null in the physics worker (opts.render false). */
  render: ContentRender | null;
  /** FNV-1a 32 over colliders (ids, kinds, numbers), props and signal plans (the sim-relevant part). */
  hash: number;
}

/** Pure, deterministic (src/world/content/index.ts). */
export type BuildWorldContent = (
  layout: import('../types').WorldLayout,
  terrain: import('../types').TerrainData,
  opts: WorldContentOptions,
) => WorldContent;
