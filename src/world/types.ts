/**
 * World / terrain contracts — FROZEN (P3). Pure data + type-only function
 * signatures shared by the sim worker (heightfield collision) and the main
 * thread (terrain mesh, road ribbons, cameras, AI). No three, no DOM, no
 * imports from src/sim or src/render (see the boundary amendment in
 * docs/CONTRACTS.md).
 *
 * Coordinates: SI metres, Y up, right-handed (three.js default). The map is
 * a square centred on the origin; "north" is −Z (top of the ASCII sketch in
 * layout.ts), east is +X. Yaw is a rotation about +Y; yaw 0 faces −Z and
 * yaw π/2 faces −X (same convention as main.ts / the vehicle frame).
 *
 * ======================================================================
 * DETERMINISM (the reason the worker regenerates instead of receiving
 * arrays): generateTerrain(layout) is a PURE function. Given the same
 * WorldLayout it must produce bit-identical TerrainData in the worker, on
 * main and in node tests, and hashTerrain() of both must match. Rules:
 *   - randomness only from core/rng + core/noise seeded by layout.seed
 *     (fork per zone/purpose with fixed stream ids), never Math.random;
 *   - only + − × ÷ sqrt floor abs min max and simplex-noise in the
 *     generator (no Math.sin/cos/pow/exp/atan2 — they are not IEEE-exact
 *     across engines, and replays carry the terrain hash). Rotations in
 *     layout data are given as unit direction vectors, never angles;
 *   - fixed iteration order (rows ascending, cols ascending; zones, pads
 *     and roads in declaration order except where a rule below says
 *     otherwise).
 * ======================================================================
 */
import type { MaterialId } from '../protocol/messages';

// ============================================================ primitives
/** Plan-view point (x, z). */
export type Vec2 = readonly [x: number, z: number];
/** World point (x, y, z). */
export type WorldVec3 = readonly [x: number, y: number, z: number];
/**
 * Road control point. y = null means "follow the terrain": the generator
 * resolves it to the pre-carve terrain height averaged over a disc of
 * radius ROAD_KIND_DEFAULTS[kind].smoothRadius around (x, z).
 */
export type RoadPoint = readonly [x: number, y: number | null, z: number];

/**
 * Plan-view shape with a soft edge. Mask m(x,z) = 1 inside, falling to 0 at
 * `blend` metres outside the boundary with smoothstep(1 − dist/blend)
 * (smoothstep(t) = t²(3 − 2t)). `axis` is a UNIT (x, z) direction giving the
 * local +X of rect/ellipse shapes (no angles: see DETERMINISM). Omitted
 * axis = world +X.
 */
export type ZoneShape =
  | { type: 'circle'; center: Vec2; radius: number; blend: number }
  | { type: 'ellipse'; center: Vec2; radiusX: number; radiusZ: number; axis?: Vec2; blend: number }
  | { type: 'rect'; center: Vec2; halfX: number; halfZ: number; axis?: Vec2; blend: number }
  /** Simple polygon (no self-intersections), either winding. */
  | { type: 'polygon'; points: readonly Vec2[]; blend: number };

// ============================================================ terrain params
export interface NoiseParams {
  /** Peak deviation, m (the normalized fbm/ridged output is scaled by this). */
  amplitude: number;
  /** Base feature size, m (noise is sampled at x / wavelength). */
  wavelength: number;
  octaves: number;
  /** Default 2 / 0.5. */
  lacunarity?: number;
  gain?: number;
}

export interface TerrainParams {
  /** Grid spacing, m. 1.0 for the default map (see TerrainData). */
  spacing: number;
  /** Datum of the plains, m. Every zone contribution is relative to it. */
  baseHeight: number;
  /** Map-wide gentle fbm undulation (applied everywhere, before zones). */
  detail: NoiseParams;
  /**
   * Rim that encloses the world: within `width` m of the map edge the
   * height rises by `height`·smoothstep(1 − edgeDist/width). Hides the edge
   * and keeps cars in.
   */
  edgeRise: { width: number; height: number };
  /** Final clamp of all heights, m. */
  minHeight: number;
  maxHeight: number;
}

// ============================================================ zones
/**
 * One mountain mass: macro height = height·(1 − u²)² for u < 1, where
 * u = elliptical distance sqrt((dx'/radiusX)² + (dz'/radiusZ)²) in the
 * peak's local frame (axis = local +X). The mountains zone takes the MAX
 * over its peaks (overlapping peaks form ridges/saddles, not stacks).
 */
export interface MountainPeak {
  name: string;
  center: Vec2;
  height: number;
  radiusX: number;
  radiusZ: number;
  axis?: Vec2;
}

interface ZoneBase {
  id: string;
  name: string;
  shape: ZoneShape;
}
/**
 * Zones, applied in this FIXED order regardless of declaration order
 * (declaration order breaks ties within a kind):
 *   1. plains     h += mask·fbm(params.detail)           (extra undulation)
 *   2. hills      h += mask·(lift + fbm(params.noise))   (rolling, signed)
 *   3. mountains  h += max_peaks(bump) + mask·(bump/peakMax)·ridged(params.ridged)
 *                 (peak bumps are NOT masked: each peak's radii bound it)
 *   4. lake       h = lerp(h, waterLevel − depth·(1 − r²)… see LakeZone, mask)
 *   5. town / arena pads: h = lerp(h, height, mask)
 * then the edge rise (TerrainParams.edgeRise), then layout.pads
 * (declaration order), then roads (resolve profiles, then carve; see
 * RoadDef / JunctionDef), then the clamp. The final step paints splat +
 * material (zones → pads → road verges → carriageways, later wins).
 */
export interface PlainsZone extends ZoneBase {
  kind: 'plains';
  params: { detail: NoiseParams };
}
export interface HillsZone extends ZoneBase {
  kind: 'hills';
  params: {
    noise: NoiseParams;
    /** Constant lift inside the zone (m), added with the mask. */
    lift: number;
  };
}
export interface MountainsZone extends ZoneBase {
  kind: 'mountains';
  params: {
    peaks: readonly MountainPeak[];
    /** Ridged detail, scaled by mask × (macro / max peak height) so it vanishes on the plains. */
    ridged: NoiseParams;
    /** Macro slope (rise/run) above which the splat turns to rock. */
    rockSlope: number;
  };
}
/**
 * Lake basin. Shape MUST be a circle or ellipse. With r = normalized
 * elliptical distance from the centre (0 centre, 1 shoreline), inside:
 *   h = waterLevel − depth·(1 − r²)
 * The shoreline band is the shape's `blend` (m outside r = 1): there the
 * natural terrain is first clamped to ≥ waterLevel + shoreLift (a dry,
 * drivable beach), then blended with the mask. Splat: underwater dirt,
 * shore band gravel → grass.
 */
export interface LakeZone extends ZoneBase {
  kind: 'lake';
  /**
   * `water` (P5, render-only optics; default WATER_OPTICS_DEFAULTS) is ignored by the generator.
   * `level` (layout v6, R-WORLD; default layout.waterLevel): this basin's own surface height, m —
   * ponds, fords and water splashes above the valley's water plane. The generator carves the basin
   * to it and resolveWater floods it to it (WaterBody.level).
   */
  params: { depth: number; shoreLift: number; water?: Partial<WaterOptics>; level?: number };
}
/** Flattened, paved crash-test pad. Splat paved, material = params.material (concrete). */
export interface ArenaZone extends ZoneBase {
  kind: 'arena';
  params: { height: number; material: MaterialId };
}
/** Flattened town plateau (streets are RoadDefs; ground stays grass/paved lots in P5). */
export interface TownZone extends ZoneBase {
  kind: 'town';
  params: { height: number };
}
export type ZoneDef = PlainsZone | HillsZone | MountainsZone | LakeZone | ArenaZone | TownZone;
export type ZoneKind = ZoneDef['kind'];

// ============================================================ pads / P5 placeholders
/**
 * Extra flat pad (summit lookout, prop yards, spawn aprons). height null =
 * the mean pre-pad terrain height inside the shape. `material` (optional)
 * paints the pad core (mask ≥ 0.5) for physics and the splat.
 */
export interface PadDef {
  id: string;
  /** v6 adds: apron (airfield / paddock concrete), yard (industrial / quarry floor), lot (building plot), pit (quarry bench), field (farm). */
  purpose: 'lookout' | 'spawn' | 'props' | 'parking' | 'apron' | 'yard' | 'lot' | 'pit' | 'field';
  shape: ZoneShape;
  height: number | null;
  material?: MaterialId;
}

/**
 * STATIC COLLIDER — P4 contract (replaces the P3 placeholder; nothing
 * consumed it). Pure layout data shared by the sim (static-primitive
 * contact pass, src/sim/collision/types.ts) and render (barrier / pole /
 * ramp meshes). Lives HERE, not in src/sim, because render must draw
 * exactly what the sim collides with and may not import src/sim, and the
 * worker already receives the WorldLayout in `groundHeightfield`.
 *
 * LOCAL FRAME of a collider: centre at `pos`, axes = columns of the
 * rotation `quat` ([x, y, z, w], unit; layout rule: rotations are data,
 * never angles). `size` per kind (all metres):
 *   box       [hx, hy, hz]  half extents (an OBB).
 *   cylinder  [r, hh, 0]    radius, half height; axis = local +Y (poles).
 *   sphere    [r, 0, 0].
 *   plane     [hx, 0, hz]   finite one-sided rectangle in local y = 0,
 *                           solid side local −Y (slab COLLIDER_PLANE_DEPTH
 *                           deep, src/sim/collision/types.ts); e.g. a steel
 *                           plate or a test deck over terrain.
 *   ramp      [hx, hy, hz]  WEDGE inside the box |x| ≤ hx, |z| ≤ hz,
 *                           −hy ≤ y ≤ −hy + 2hy·(hz − z)/(2hz): the driving
 *                           surface rises from y = −hy at z = +hz (toe, flush
 *                           with the ground) to y = +hy at z = −hz (lip, with a
 *                           vertical back face). With quat identity a car
 *                           driving forward (vehicle −Z) climbs it.
 * pos y = null: rests on the terrain — y = heightAt(x, z) + hy (box,
 * cylinder, ramp), + r (sphere), + 0 (plane). Only valid with a yaw-only
 * quat (rotation about +Y); resolveColliders() (src/world/colliders.ts,
 * P4 agent 5) rejects a tilted collider with y null.
 */
/** 'mesh' (R-CORE, additive): static triangle mesh (`ColliderDef.mesh`), node-vs-triangle contact with CCD. */
export type ColliderKind = 'box' | 'cylinder' | 'sphere' | 'plane' | 'ramp' | 'mesh';
/**
 * R-CORE static collision mesh (kind 'mesh'): local-space positions (x, y, z
 * per vertex) and triangles (3 vertex indices each, wound counter-clockwise
 * seen from the solid's outside: right-hand normal points out). Transformed by
 * the collider's pos / quat; `size` = the local AABB half extents (validation,
 * broadphase), as for a box. One-sided unless `twoSided` (thin decks, walls,
 * guard rails: collide from the side the node came from).
 */
export interface ColliderMesh {
  positions: number[];
  indices: number[];
  twoSided?: boolean;
}
/** Render style hint (the sim ignores it). Default by kind: box 'block', cylinder 'pole', sphere 'block', plane 'plate', ramp 'ramp'. */
export type ColliderVisual =
  | 'wall'
  | 'jersey'
  | 'pole'
  | 'ramp'
  | 'block'
  | 'plate'
  | 'none'
  // P8 stunt park (additive; docs/CONTRACTS.md "P8 contracts"):
  | 'container' //  corrugated shipping container (box)
  | 'wreck' //      static crushed car hulk (box collider, car-shaped visual)
  | 'tires' //      static stacked tyre wall (box)
  | 'kicker' //     steel kicker ramp (ramp)
  | 'deck' //       steel-framed deck plate: ski-jump in-run / landing hill, quarter-pipe staves (box)
  | 'floodlight' // floodlight tower (cylinder = the mast base; the lattice + lamp head are drawn above it)
  | 'grandstand' // stepped grandstand (box = its bulk)
  // Layout v6 (R-WORLD, additive; docs/CONTRACTS.md "R-WORLD contracts"). Drawn by
  // src/render/world/content/** from WorldContent, NOT by render/world/colliders.ts (it skips them):
  | 'building' //   a building's solid (box); the façade / roof / interior come from WorldContent.render
  | 'kerb' //       kerb stone + the first metres of sidewalk slab (box, top at sidewalk level)
  | 'armco' //      W-beam / armco barrier run (box)
  | 'railing' //    bridge / tunnel parapet (box)
  | 'deckSlab' //   bridge deck segment (box; the ribbon draws its surface)
  | 'tunnelWall' // tunnel lining / roof (box)
  | 'pier' //       bridge pier / gantry leg (box or cylinder)
  | 'parked' //     parked car (box; the car model comes from WorldContent.render)
  | 'log' //        fallen log (cylinder, tilted)
  | 'pipe' //       steel / concrete pipe (cylinder, tilted)
  | 'crashBarrier' // crash-lab rigid barrier block (box)
  | 'sled' //       crash-lab side-impact sled (box)
  | 'lid'; //       invisible tunnel-cover lid (plane): keeps cars on the ridge drawn over a tunnel
export interface ColliderDef {
  id: string;
  kind: ColliderKind;
  pos: RoadPoint;
  quat: readonly [number, number, number, number];
  size: WorldVec3;
  /** Contact μ = node friction × material friction (same table as the ground). */
  material: MaterialId;
  /**
   * RESERVED (P5 breakable poles/signs): the collider snaps (becomes
   * inactive, P5 swaps in a dynamic prop) once the summed contact force on
   * it exceeds anchorForce N within one tick. P4 kernels treat every
   * collider as static and unbreakable.
   */
  breakable?: { anchorForce: number };
  visual?: ColliderVisual;
  /** R-CORE: kind 'mesh' only (required there). */
  mesh?: ColliderMesh;
}
/** A ColliderDef with y resolved against the terrain (resolveColliders output, both sides). */
export interface ResolvedCollider extends Omit<ColliderDef, 'pos'> {
  pos: WorldVec3;
}
/**
 * Pure, deterministic (src/world/colliders.ts, P4 agent 5): validates
 * (unique ids, unit quat ±1e-6, positive sizes per kind, y null ⇒ yaw-only)
 * and resolves y. Throws WorldLayoutError. Both the worker (collision) and
 * main (meshes) call it with the same terrain sampler, so visual ==
 * collision by construction.
 */
export type ResolveColliders = (
  colliders: readonly ColliderDef[],
  heightAt: (x: number, z: number) => number,
) => ResolvedCollider[];
/**
 * PROP PLACEMENT — P5 contract (replaces the P3 placeholder). Soft-body
 * props are separate sim objects spawned by the WORKER itself on
 * `groundHeightfield` (like the layout colliders: collision == visual by
 * construction), expanded by the pure resolvePropInstances
 * (src/sim/props/placement.ts, docs/CONTRACTS.md "P5 contracts"):
 *   per placement (declaration order) → row copies k = 0..count−1 at
 *   pos + k·row.step (x, z) → stack levels l = 0..stack−1 at
 *   y_ground + l·PropDef.stackHeight. Instance index = expansion order;
 *   layout objectId = PROP_LAYOUT_ID_BASE + index.
 * `prop` is a catalog key (src/sim/props/types.ts PropKey; validated by
 * resolvePropInstances, not here: world never imports sim).
 * `facing` is a UNIT (x, z) direction the prop's local −Z faces (layout
 * rule: rotations are data, never angles — the spawn quat is built with
 * sqrt only). Default (0, −1).
 */
export interface PropPlacement {
  id: string;
  prop: string;
  /** Base point; y null = terrain height at (x, z) (per row copy). */
  pos: RoadPoint;
  facing?: Vec2;
  /** Identical props stacked vertically (tires, boxes); default 1. */
  stack?: number;
  /** A straight row of copies: copy k sits at pos + k·step (plan metres). */
  row?: { count: number; step: Vec2 };
  /** Pad it sits on (documentation + validation that the pad exists). */
  padId?: string;
}

// ============================================================ water (P5)
/**
 * Render-only optics of a lake (LakeZone.params.water; defaults
 * WATER_OPTICS_DEFAULTS). Colours are sRGB hex.
 */
export interface WaterOptics {
  /** Colour seen through very shallow water / at the shore. */
  shallowColor: number;
  /** Scattering colour of deep water (what you see when absorption saturates). */
  deepColor: number;
  /** Beer–Lambert absorption per metre of water path, linear RGB (red dies first). */
  absorption: readonly [number, number, number];
  /** Shoreline foam band: depth (m of water) below which foam appears. */
  foamDepth: number;
  /** Wave normal-map tile size, m, and peak wave height (normal strength only; the surface is flat). */
  waveScale: number;
  waveSpeed: number;
}
export const WATER_OPTICS_DEFAULTS: WaterOptics = {
  shallowColor: 0x6fa59a,
  deepColor: 0x0d2f38,
  absorption: [0.45, 0.12, 0.08],
  foamDepth: 0.35,
  waveScale: 6,
  waveSpeed: 0.6,
};

/**
 * One water body, resolved from a LakeZone + the generated terrain by the
 * pure resolveWater (src/world/water.ts) — the worker (buoyancy) and main
 * (water mesh, FX splashes) call it on identical terrain. The flat surface
 * is y = level over the plan rectangle [minX, maxX] × [minZ, maxZ]: the
 * AABB of the grid samples with height < level that are 4-connected to the
 * sample nearest the zone centre (flood fill), grown by WATER_AABB_MARGIN_M.
 * Inside that rectangle and below `level` a point is "in water" (the
 * shoreline rises above level, so dry land never qualifies above ground).
 */
export interface WaterBody {
  /** The LakeZone id. */
  id: string;
  name: string;
  level: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** level − min terrain height inside the flood region, m. */
  maxDepth: number;
  /** Flooded sample count (diagnostics / tests). */
  samples: number;
  optics: WaterOptics;
  /**
   * Layout v6: the flood-fill seed (the sample nearest the zone centre), world x / z. waterField
   * seeds its mask here: a small pond's rectangle can hold lower, disconnected ground.
   */
  seedX?: number;
  seedZ?: number;
}
export const WATER_AABB_MARGIN_M = 2;
/** Pure, deterministic; one body per lake zone (declaration order). A lake whose centre sample is dry yields no body. */
export type ResolveWater = (layout: WorldLayout, terrain: TerrainData) => WaterBody[];

/**
 * WATER PHYSICS (U1, worker; per awake collidable node i, after beams and
 * node-vs-node, before ground — so the implicit ground/collider friction
 * sees it). Only + − × ÷ sqrt. With h = WATER_PHYSICS.nodeHalfDepth:
 *   f_i = clamp((level − y_i + h) / (2h), 0, 1)          submerged fraction (depth-proportional)
 *   V_i = m_i / ρ_obj                                     ρ_obj = PropDef.density | vehicleDensity
 *   F_buoy = ρ_w·g·V_i·f_i  (up, g = |gravity|)
 *   F_drag = −f_i·(linearDrag·m_i·v + 0.5·ρ_w·Cd·(V_i/ℓ)·|v|·v),  ℓ = nodeLength
 *   (explicit; |drag impulse| capped at m_i·|v| per step so it never reverses v)
 * Node in water ⇔ inside a WaterBody rectangle and y_i − h < level.
 */
export const WATER_PHYSICS = {
  density: 1000,
  nodeHalfDepth: 0.15,
  linearDrag: 0.8,
  dragCoeff: 1.0,
  nodeLength: 0.3,
  /**
   * Effective density of a DRY vehicle (≈ 1450 kg around ≈ 3 m³ of cabin
   * and body air): it floats with the roof out, then floods — the sim
   * scales its BODY nodes' buoyancy down as the cabin fills
   * (src/sim/collision/water.ts VEHICLE FLOODING) and it sinks within ~20 s.
   * U1 amendment: was 900 (the sedan never floated: it plunged under on
   * entry and flooded straight away).
   */
  vehicleDensity: 500,
} as const;

// ============================================================ vegetation (P5)
/** Vegetation kinds (Uint8 ids in VegetationScatter.kind). Grass tufts are NOT scattered (render-side, around the camera). */
export const VegetationKind = {
  conifer: 0,
  broadleaf: 1,
  shrub: 2,
  rock: 3,
  boulder: 4,
} as const;
export type VegetationKind = (typeof VegetationKind)[keyof typeof VegetationKind];
export const VEGETATION_KIND_COUNT = 5;

/**
 * Deterministic scatter (U4: src/world/vegetation.ts `scatterVegetation`),
 * a PURE function of (layout, terrain) with the generator's numeric rules
 * (core/rng forked from layout.seed, core/noise, + − × ÷ sqrt floor
 * abs min max only, fixed loop order) — the worker derives the tree
 * colliders from it, so main and worker must agree bit for bit
 * (hashVegetation, compared via terrainReady.vegetationHash).
 * SoA, instance order = generation order (kinds interleaved), `count` used.
 * Always generated at FULL density; render keeps instance i iff
 * rank[i] < QualityPreset.vegetationDensity OR collider[i] ≥ 0 (collider
 * instances are always drawn: you never hit an invisible tree).
 *
 * PLACEMENT RULES (U4; numbers are contract, tests assert them):
 *   - no instance within VEG_ROAD_CLEARANCE_M[kind] of any road
 *     carriageway + shoulder edge (all roads, incl. dirt), inside a pad
 *     shape, an arena/town zone (mask > 0.1), a static collider's AABB
 *     (+ 2 m), a layout prop placement (+ 3 m), a spawn point (12 m);
 *   - none in water: terrain height < waterLevel + 0.4;
 *   - trees/shrubs need normal.y ≥ 0.8 and rock splat < 0.5; rocks and
 *     boulders prefer rock splat / steep ground;
 *   - minimum trunk spacing VEG_TREE_MIN_SPACING_M between trees;
 *   - totals ≤ VEG_MAX_INSTANCES.
 * TREE / BOULDER COLLIDER RULE: a conifer/broadleaf whose trunk is within
 * VEG_COLLIDER_REACH_M of a carriageway + shoulder edge, a pad or the arena
 * zone becomes a static CYLINDER collider (ColliderDef id `veg:${i}`,
 * material wood, visual 'none' — the vegetation renderer draws it), radius
 * = trunk radius at the base (VEG_TRUNK_RADIUS_M[kind]·scale), half
 * height VEG_TRUNK_HALF_HEIGHT_M, pos y null; a boulder within reach becomes
 * a SPHERE collider (material rock, visual 'none', radius r =
 * VEG_BOULDER_RADIUS_M·scale, centre y = terrain(x, z) + VEG_BOULDER_CENTER_LIFT·r:
 * a half-buried dome; the mesh is drawn on the same sphere). Small rocks
 * never collide. Collider trees keep
 * ≥ VEG_TREE_MIN_SPACING_M apart and total ≤ VEG_MAX_COLLIDERS (so the
 * 8 m collider grid stays under COLLIDER_MAX_CANDIDATES per object).
 * The worker appends `scatter.colliders` after the layout colliders and
 * before the setColliders extra set (one id space).
 */
export interface VegetationScatter {
  count: number;
  /** VegetationKind per instance. */
  kind: Uint8Array;
  /** Base point (trunk foot / rock centre on the ground), world m. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Uniform size multiplier around the kind's reference size (≈ 0.6–1.6). */
  scale: Float32Array;
  /** Render yaw, rad in [0, 2π) (render only — never feeds the sim). */
  yaw: Float32Array;
  /** Mesh variant 0..3 within the kind. */
  variant: Uint8Array;
  /** Density threshold 0..1 (uniform over instances of a kind). */
  rank: Float32Array;
  /** Index into `colliders`, or −1. */
  collider: Int32Array;
  colliders: ColliderDef[];
  /** hashVegetation(this). */
  hash: number;
}
/** Layout v6: 60 k → 200 k (the map grew 3.3×; the render keeps density by rank and distance). */
export const VEG_MAX_INSTANCES = 200000;
/** Layout v6: 2500 → 7000 (more roads, three times the land). */
export const VEG_MAX_COLLIDERS = 7000;
export const VEG_COLLIDER_REACH_M = 25;
export const VEG_TREE_MIN_SPACING_M = 4;
export const VEG_TRUNK_HALF_HEIGHT_M = 2.5;
/** Per VegetationKind (conifer, broadleaf, shrub, rock, boulder). */
export const VEG_ROAD_CLEARANCE_M: readonly number[] = [4, 5, 1.5, 1, 3];
export const VEG_TRUNK_RADIUS_M: readonly number[] = [0.2, 0.28, 0, 0, 0];
export const VEG_BOULDER_RADIUS_M = 1.1;
export const VEG_BOULDER_CENTER_LIFT = 0.35;
/**
 * Pure, deterministic (U4). Layout v6: `extra` = the WorldContent's colliders, props and
 * exclusion footprints (src/world/content/types.ts) — kept clear exactly like the layout's
 * own (collider AABB + 2 m, prop + 3 m, footprint rectangles). Worker and main pass the same.
 */
export interface VegetationExtra {
  colliders: readonly ColliderDef[];
  props: readonly PropPlacement[];
  exclusions: readonly { cx: number; cz: number; ax: number; az: number; hx: number; hz: number }[];
  /**
   * Hand-placed plantings (street trees, yard trees, hedges): appended after the natural scatter,
   * rank 0 (always drawn), same collider rule (a tree within VEG_COLLIDER_REACH_M of a road becomes
   * a trunk collider). kind = VegetationKind; scale ≈ 0.6–1.6.
   */
  plantings?: readonly { kind: number; x: number; z: number; scale: number }[];
}
export type ScatterVegetation = (layout: WorldLayout, terrain: TerrainData, extra?: VegetationExtra | null) => VegetationScatter;
/** FNV-1a 32 word-wise over count, kind, x, y, z, scale, collider (U4). */
export type HashVegetation = (scatter: VegetationScatter) => number;

// ============================================================ roads
/**
 * Road kinds. Carve PRIORITY (low → high) decides who wins where roads
 * overlap at junctions: dirt < street < country < mountain < arena = track < highway.
 * `track` (layout v6): a closed racing circuit / pit lane — paved, wide, graded like a
 * country road, painted kerbs on its verges, no traffic.
 */
export type RoadKind = 'highway' | 'country' | 'mountain' | 'dirt' | 'street' | 'arena' | 'track';
/**
 * Marking styles for the ribbon shader (E):
 *  - highway: white solid edge lines, white dashed lane dividers (3 m dash,
 *    9 m gap), double yellow centre line;
 *  - center:  white solid edge lines, single yellow dashed centre line
 *    (solid where |curvature| > 1/120 m⁻¹ — "no passing" on bends);
 *  - edge:    white solid edge lines only;
 *  - none.
 */
export type RoadMarkings = 'highway' | 'center' | 'edge' | 'none';

/**
 * PROFILE RESOLUTION + CARVING (generator, after zones/edge/pads):
 *  1. Resolve null control-point y (see RoadPoint) on the pre-road terrain.
 *  2. Centreline = core/spline createSpline(points, closed) (y included);
 *     stations every ROAD_STATION_SPACING m of arc (ArcTable). Tangent and
 *     curvature come from the plan (x, z) projection.
 *  3. bank(s) = −sign(κ)·bank·min(1, |κ|·bankFullRadius), then a moving
 *     average over 30 m so superelevation runs in/out smoothly.
 *  4. Junctions: resolve roads by priority DESC (ties: declaration order).
 *     A road meeting an already-resolved road at a junction has its station
 *     y within JUNCTION_EASE_M of pos pulled to that road's surface height
 *     at pos (smoothstep weight, 1 at pos) and its bank faded to 0 there.
 *  5. Carve in priority ASC (higher priority wins overlaps). Per grid
 *     sample near a road, (s, d) = projection; a = width/2, b = a + shoulder:
 *       |d| ≤ b           h = y(s) + bank(s)·clamp(d, −a, a)  (verge level)
 *       b < |d| < b+blend h = lerp(surface(±b), h, smoothstep((|d|−b)/blend))
 *     Open road ends get the same falloff along s (round ends).
 *  6. Paint: carriageway → road material + splat (ribbon roads paved; splat
 *     roads their material's channel), verge → gravel; the blend band keeps
 *     the zone paint.
 * Road ribbons (E) sit ON the carved terrain, never on the raw spline.
 */
export interface RoadDef {
  id: string;
  name: string;
  kind: RoadKind;
  closed: boolean;
  /**
   * Centripetal Catmull-Rom control points (core/spline). Explicit y pins
   * the design grade; null follows the terrain (see RoadPoint).
   */
  points: readonly RoadPoint[];
  /** Carriageway width, m (edge to edge). */
  width: number;
  /** Lanes per direction (marking layout). */
  lanes: number;
  /** Verge width each side beyond the carriageway, m (gravel, drivable). */
  shoulder: number;
  /**
   * Max superelevation as cross-slope (m/m ≈ rad for these magnitudes).
   * Applied ∝ curvature, full at ROAD_KIND_DEFAULTS[kind].bankFullRadius,
   * outside of the bend high. Omitted = 0 (flat).
   */
  bank?: number;
  /** Physics material of the carriageway (shoulders are gravel). */
  material: MaterialId;
  markings: RoadMarkings;
  // ---- layout v6 (R-WORLD, additive; docs/CONTRACTS.md "R-WORLD contracts") ----
  /** Bridge / tunnel spans along this road (see RoadStructureDef). */
  structures?: readonly RoadStructureDef[];
  /**
   * One-way road (slip ramps): traffic only travels toward increasing s. The route network
   * builds dir +1 lanes only, lane k centred at d = (k + 0.5 − lanes/2)·width/lanes, and
   * no dead-end U-turns. Markings: edge lines + lane dividers.
   */
  oneWay?: boolean;
  /** Raised sidewalks with real kerbs on both sides (see SidewalkDef). */
  sidewalk?: SidewalkDef;
  /** Render hint for the carriageway's wear (ribbon + decals): default 'fresh'. */
  wear?: 'fresh' | 'worn' | 'patched';
}

/**
 * BRIDGE / TUNNEL span of a road (layout v6). `from` / `to` are plan points the
 * generator projects onto the road's centreline (s0 < s1 after sorting); the
 * span is [s0, s1] in road arc metres (RoadProfile.structures).
 *  - bridge: the road is NOT carved inside the span (the terrain below — lake,
 *    valley, another road — stays as it is); its profile y (pin it with explicit
 *    control-point y) is the deck surface. WorldContent adds the deck slabs
 *    (box colliders `deckSlab`, top = the profile surface, ≤ 12 m long),
 *    parapets (`railing`) and piers; the ribbon draws the deck surface from the
 *    profile instead of the terrain. Roads may cross a bridge span without a
 *    junction (the overpass exception to "roads meet only at junctions").
 *  - tunnel: the road IS carved (physics drives the cut floor); the generator
 *    also records the uncarved ridge over the span as a render-only
 *    TerrainCover (TerrainData.covers) so the terrain is drawn closed over the
 *    bore. WorldContent adds the lining / roof (`tunnelWall`), portals, lights
 *    and invisible `lid` planes over the cover so cars on the ridge stay on it.
 */
export interface RoadStructureDef {
  id: string;
  kind: 'bridge' | 'tunnel';
  from: Vec2;
  to: Vec2;
}
/** Resolved span (RoadProfile.structures), s0 < s1 in road arc metres. */
export interface RoadStructure {
  id: string;
  kind: 'bridge' | 'tunnel';
  s0: number;
  s1: number;
}

/**
 * SIDEWALKS (layout v6, streets). Beyond the carriageway + shoulder edge (the
 * KERB LINE, |d| = width/2 + shoulder) the generator raises the terrain by
 * `kerb` m from |d| ≥ kerb line + SIDEWALK_RAMP_M out to kerb line + `width`,
 * then blends back to the town ground over the road's blend band. The 1 m
 * grid cannot hold a vertical step, so WorldContent places `kerb` box
 * colliders (top = carriageway surface + kerb, inner face exactly on the kerb
 * line, SIDEWALK_RAMP_M wide) over the ramp: tyres meet a real 12–15 cm step.
 * Kerbs drop (no collider, no raise) across junction mouths and driveways.
 */
export interface SidewalkDef {
  /** Sidewalk width from the kerb line, m (≥ SIDEWALK_RAMP_M + 0.5). */
  width: number;
  /** Kerb height above the carriageway edge, m (0.10–0.18). */
  kerb: number;
}
/** Width of the kerb collider / grid ramp band behind the kerb line, m. */
export const SIDEWALK_RAMP_M = 2;

/**
 * Per-kind tuning used by the generator and checks. All roads of a kind
 * share these (not per-road data so the layout stays small).
 *  - priority:       carve order (higher overwrites lower).
 *  - smoothRadius:   m; disc radius for y = null control points.
 *  - maxGrade:       design check (tests assert the resolved profile).
 *  - bankFullRadius: m; bend radius at which `bank` is fully applied.
 *  - blend:          m; embankment/cutting width from verge edge back to
 *                    natural terrain (smoothstep).
 *  - surface:        'ribbon' = a road mesh (E) draws the carriageway;
 *                    'splat' = only the terrain splat (dirt trails).
 */
export interface RoadKindDefaults {
  priority: number;
  smoothRadius: number;
  maxGrade: number;
  bankFullRadius: number;
  blend: number;
  surface: 'ribbon' | 'splat';
}
export const ROAD_KIND_DEFAULTS: Readonly<Record<RoadKind, RoadKindDefaults>> = {
  dirt: { priority: 0, smoothRadius: 6, maxGrade: 0.22, bankFullRadius: 30, blend: 6, surface: 'splat' },
  street: { priority: 1, smoothRadius: 20, maxGrade: 0.08, bankFullRadius: 60, blend: 8, surface: 'ribbon' },
  country: { priority: 2, smoothRadius: 25, maxGrade: 0.1, bankFullRadius: 120, blend: 14, surface: 'ribbon' },
  mountain: { priority: 3, smoothRadius: 15, maxGrade: 0.13, bankFullRadius: 45, blend: 12, surface: 'ribbon' },
  arena: { priority: 4, smoothRadius: 30, maxGrade: 0.02, bankFullRadius: 200, blend: 10, surface: 'ribbon' },
  track: { priority: 4, smoothRadius: 30, maxGrade: 0.09, bankFullRadius: 70, blend: 14, surface: 'ribbon' },
  highway: { priority: 5, smoothRadius: 60, maxGrade: 0.07, bankFullRadius: 300, blend: 26, surface: 'ribbon' },
};

/**
 * Junction: every listed road passes within 1 m of `pos`. The through road
 * is the highest-priority one; every other road must START or END at `pos`
 * (a branch). The generator snaps a branch's end y to the through road's
 * surface height there and eases the branch profile into it over
 * JUNCTION_EASE_M. Roads may only meet at junctions (overpass-free map; a
 * test asserts no other centreline approaches).
 */
export interface JunctionDef {
  id: string;
  pos: Vec2;
  roads: readonly string[];
  /**
   * Layout v6: traffic control (default 'none' = the priority rules above).
   *  - signal:  traffic lights, a SignalPlan (src/world/signals.ts): the through road's legs
   *             and the branch legs take turns; RoutePath.signal links connectors to it.
   *  - stop:    stop signs on every BRANCH leg (RoutePath.stop on their connectors).
   *  - allStop: stop signs on every leg.
   *  - yield:   give-way signs on the branch legs (the default right of way, signed).
   */
  control?: JunctionControl;
}
export type JunctionControl = 'none' | 'signal' | 'stop' | 'allStop' | 'yield';
export const JUNCTION_EASE_M = 40;

// ============================================================ spawns / layout
/**
 * Named spawn. Either on a road (`road`: arc distance s from the road start
 * in m, signed lateral offset d, + = right of travel; heading = direction
 * of travel, or reversed when `reverse`) or free (`pos` + `yaw`). The
 * generator resolves both forms into TerrainData.spawns (surface y).
 */
export interface SpawnPoint {
  id: string;
  name: string;
  road?: { id: string; s: number; d: number; reverse?: boolean };
  pos?: Vec2;
  yaw?: number;
  /** Layout v6: the WorldArea this spawn is the teleport entry of (menus group by it). */
  area?: string;
}

// ============================================================ areas, POIs, surfaces (layout v6)
/**
 * WORLD AREA (layout v6, R-WORLD): a named region for menus, modes and
 * ambience. `bounds` is a plan shape (its blend is ignored); `spawn` is the
 * teleport entry (a SpawnPoint id). Areas may overlap (the crash lab sits in
 * the proving ground); the frozen ids are listed in docs/CONTRACTS.md.
 */
export type AreaKind =
  | 'town'
  | 'arena'
  | 'lake'
  | 'mountain'
  | 'trail'
  | 'highway'
  | 'interchange'
  | 'bridge'
  | 'tunnel'
  | 'circuit'
  | 'rally'
  | 'drag'
  | 'offroad'
  | 'proving'
  | 'crashLab'
  | 'quarry'
  | 'farm'
  | 'campsite'
  | 'landmark';
export interface WorldArea {
  id: string;
  name: string;
  kind: AreaKind;
  bounds: ZoneShape;
  /** Teleport entry: a SpawnPoint id. */
  spawn: string;
}

/**
 * POINT OF INTEREST (layout v6): a named world location game modes key on
 * (start lines, grid slots, timing beams, split points, crash-lab targets,
 * delivery depots, police posts, landmarks). Pure data; `pos` y null = on
 * the ground (resolvePois: terrain, or the top of a box / ramp collider
 * under it). `heading` is the unit (x, z) direction a car starting there
 * faces / a gate's travel direction; `radius` the trigger radius, m;
 * `width` a line's / gate's width across `heading`, m.
 */
export type PoiKind =
  | 'start'
  | 'finish'
  | 'grid'
  | 'checkpoint'
  | 'split'
  | 'pitEntry'
  | 'pitExit'
  | 'pitBox'
  | 'stage'
  | 'timingBeam'
  | 'tree'
  | 'barrier'
  | 'pole'
  | 'sled'
  | 'runup'
  | 'depot'
  | 'delivery'
  | 'police'
  | 'roadblock'
  | 'parking'
  | 'fuel'
  | 'repair'
  | 'jump'
  | 'target'
  | 'landmark'
  | 'lookout'
  | 'hazard';
export interface PointOfInterest {
  id: string;
  area: string;
  kind: PoiKind;
  name: string;
  pos: RoadPoint;
  heading?: Vec2;
  radius?: number;
  width?: number;
}
/** resolvePois output: y on the support surface. */
export interface ResolvedPoi extends Omit<PointOfInterest, 'pos'> {
  pos: WorldVec3;
}

/**
 * SURFACE PATCH (layout v6): paint-only (plus an optional gentle depression)
 * material area — mud pits, sand / gravel traps, wet meadows, worn asphalt
 * lots. Applied after the zones / pads paint and before the roads paint
 * (carriageways win). Inside the shape's core the material byte becomes
 * `material` and the splat is repainted to match (mud / wetGrass → dirt /
 * grass weights darkened through the surface mask, sand → gravel + dirt);
 * `depth` lowers the terrain by depth·mask (m, before road carving).
 */
export interface SurfacePatchDef {
  id: string;
  shape: ZoneShape;
  material: MaterialId;
  depth?: number;
}

export interface WorldLayout {
  /** Stable id (protocol, saves, replays). */
  id: string;
  name: string;
  /**
   * Bump on ANY change that alters generated terrain OR the static
   * colliders OR the props / vegetation (replays key on the terrain hash
   * and this version; colliders, props and the scatter are not in
   * hashTerrain). v4 = P5 (props, vegetation colliders, water); P5 units
   * edit layout content under v4 without further bumps until P5 exits.
   */
  version: number;
  seed: number;
  /** Square map edge length, m, centred on the origin. size/terrain.spacing must be an integer multiple of TERRAIN_CHUNK_CELLS. */
  size: number;
  terrain: TerrainParams;
  /** Single global water plane height, m; water bodies = lake zones resolved by resolveWater (P5). */
  waterLevel: number;
  zones: readonly ZoneDef[];
  pads: readonly PadDef[];
  roads: readonly RoadDef[];
  junctions: readonly JunctionDef[];
  spawnPoints: readonly SpawnPoint[];
  /**
   * Static colliders (P4). The worker installs them on `groundHeightfield`
   * (resolved against its own terrain) in declaration order = collider index.
   */
  colliders: readonly ColliderDef[];
  /** Soft-body props (P5), spawned by the worker on groundHeightfield; see PropPlacement. */
  props: readonly PropPlacement[];
  /** Layout v6: named regions (menus, modes, ambience). */
  areas?: readonly WorldArea[];
  /** Layout v6: mode locations (see PointOfInterest). */
  pois?: readonly PointOfInterest[];
  /** Layout v6: paint-only material patches (see SurfacePatchDef). */
  surfaces?: readonly SurfacePatchDef[];
}

// ============================================================ TerrainData
/**
 * Splat layout: 4 explicit RGBA8 weights + an IMPLICIT fifth.
 *   R paved (asphalt set; concrete is the same set tinted, see material)
 *   G dirt, B rock, A gravel, grass = 255 − (R+G+B+A).
 * The generator guarantees R+G+B+A ≤ 255 per sample, so the five weights
 * are an exact partition of unity — and stay one under bilinear texture
 * filtering. Why: 5 PBR sets in ONE RGBA8 texture (no second array, one
 * fetch); grass is the default ground cover so it costs no channel.
 */
export const SPLAT_PAVED = 0;
export const SPLAT_DIRT = 1;
export const SPLAT_ROCK = 2;
export const SPLAT_GRAVEL = 3;
export const SPLAT_CHANNELS = 4;

/** Render chunk size in cells (B's LOD0 chunk; 1408 m / 1 m / 64 = 22 × 22 chunks). */
export const TERRAIN_CHUNK_CELLS = 64;

/** Road station spacing, m, of RoadProfile. */
export const ROAD_STATION_SPACING = 2;
/** Floats per station in RoadProfile.stations. */
export const ROAD_STATION_STRIDE = 7;
/** Offsets inside a station record. */
export const RoadStation = {
  /** Centreline position (y = carriageway surface height at the centre). */
  x: 0,
  y: 1,
  z: 2,
  /** Unit HORIZONTAL tangent (direction of travel). Right = (−tz, 0, tx). */
  tx: 3,
  tz: 4,
  /** Cross-slope m/m, + = right side higher. Surface y(d) = y + bank·d. */
  bank: 5,
  /** Signed plan curvature 1/m, + = turning right. */
  curvature: 6,
} as const;

/**
 * Resolved road (generator output; the ribbon mesher (E), AI routes and
 * spawns consume THIS, never re-deriving heights from RoadDef).
 * Stations are at s = i·ROAD_STATION_SPACING (i < stationCount − 1); the
 * last station is at s = length (open) or i·spacing (closed: the last
 * station is NOT a duplicate of the first; wrap when sampling).
 */
export interface RoadProfile {
  id: string;
  kind: RoadKind;
  closed: boolean;
  width: number;
  lanes: number;
  shoulder: number;
  material: MaterialId;
  markings: RoadMarkings;
  surface: 'ribbon' | 'splat';
  /** Layout v6 (copied from RoadDef / resolved): bridge + tunnel spans, ascending s0. */
  structures?: readonly RoadStructure[];
  oneWay?: boolean;
  sidewalk?: SidewalkDef;
  wear?: 'fresh' | 'worn' | 'patched';
  /** Total arc length, m (plan + vertical chord sum of the stations). */
  length: number;
  stationCount: number;
  /** stationCount × ROAD_STATION_STRIDE. */
  stations: Float64Array;
}

/** Resolved spawn (world surface point; place the vehicle by its own clearance). */
export interface ResolvedSpawn {
  id: string;
  name: string;
  pos: WorldVec3;
  yaw: number;
}

/**
 * Generated terrain — FROZEN (P3). Grid sample (col, row) sits at
 *   x = originX + col·spacing,  z = originZ + row·spacing,
 * row-major: index = row·cols + col (rows run along +Z, cols along +X).
 * cols = rows = size/spacing + 1 (samples on both edges).
 *
 * Default map: size 1408 m, spacing 1 m → 1409² = 1 985 281 samples
 * (1.98 km²; 1408 = 22 × 64 so LOD chunks tile exactly).
 *   heights  f32  7.9 MB   splat u8×4  7.9 MB   material u8  2.0 MB
 * ≈ 18 MB per side. 1 m resolves a 7 m lane with 7+ samples across and a
 * 30 m hairpin cleanly; 2 m would alias road crowns and kerbs against
 * 2 kHz tyre contact. f32 heights: ulp at 200 m is 1.5e-5 m, far below
 * contact penetration scales.
 *
 * Transfer: NONE. The worker regenerates from the WorldLayout (a few KB of
 * JSON) via the `groundHeightfield` command; both sides compare
 * hashTerrain(). Structured-cloning 18 MB would cost ~20–40 ms of main
 * stall plus a second copy; regenerating costs ~1 s of worker time at load
 * that overlaps main's own generation, and makes collision == visual by
 * construction. The worker may drop `splat` after generation.
 */
export interface TerrainData {
  layoutId: string;
  layoutVersion: number;
  seed: number;
  originX: number;
  originZ: number;
  spacing: number;
  cols: number;
  rows: number;
  /** World Y per sample, rows × cols. */
  heights: Float32Array;
  /** rows × cols × SPLAT_CHANNELS (see SPLAT_*), R+G+B+A ≤ 255. */
  splat: Uint8Array;
  /** Dominant MaterialId per sample (physics friction; nearest-sample lookup). */
  material: Uint8Array;
  minHeight: number;
  maxHeight: number;
  waterLevel: number;
  /** Same order as layout.roads. */
  roads: readonly RoadProfile[];
  /** Same order as layout.spawnPoints. */
  spawns: readonly ResolvedSpawn[];
  /** hashTerrain(this) — u32. */
  hash: number;
  /**
   * Layout v6: render-only terrain over tunnels (see RoadStructureDef). NOT
   * hashed, never used for collision, cameras or placement: only the terrain
   * MESH / its splat read it (the physics worker may drop it).
   */
  covers?: readonly TerrainCover[];
}

/**
 * Render-only terrain patch (tunnel covers): a sub-grid of samples whose drawn
 * height / splat replace the carved ones. Sample (c, r) of the patch is grid
 * sample (col0 + c, row0 + r); heights NaN = keep the terrain's sample there.
 */
export interface TerrainCover {
  id: string;
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  heights: Float32Array;
  /** cols × rows × SPLAT_CHANNELS. */
  splat: Uint8Array;
}

// ============================================================ samplers / helpers
/**
 * Terrain query. STRUCTURALLY IDENTICAL to sim's HeightSampler (FROZEN P1,
 * src/sim/types.ts) so the same object plugs into the ground kernel; world
 * must not import sim, hence the duplicate. Semantics:
 *  - heightAt: bilinear interpolation of the 4 surrounding samples
 *    (penetration depth); outside the grid the edge samples extend (clamp).
 *  - normalAt: C0-continuous smoothed normal = bilinear blend of the 4
 *    corner VERTEX normals, each from central differences
 *    (−(h[c+1]−h[c−1])/2s, 1, −(h[r+1]−h[r−1])/2s) normalized, then the
 *    blend renormalized. (Raw bilinear-patch normals jump across cell
 *    edges → 2 kHz contact chatter.) Writes out[0..2].
 *  - materialAt: material[nearest sample].
 * Allocation-free, only + − × ÷ sqrt floor (sim numerics contract).
 */
export interface TerrainSampler {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: Float64Array): void;
  materialAt(x: number, z: number): number;
  /** Splat weights at the nearest sample (0..1 each, 5 values: paved, dirt, rock, gravel, grass) into out[0..4]. */
  splatAt(x: number, z: number, out: Float64Array): void;
  /** True when (x, z) is inside the grid. */
  contains(x: number, z: number): boolean;
}

/** Reusable output of sampleRoad (no allocation per call). */
export interface RoadSample {
  /** Arc distance actually sampled (clamped open / wrapped closed). */
  s: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  /** Right vector (−tz, tx). */
  rx: number;
  rz: number;
  bank: number;
  curvature: number;
}
/** Reusable output of projectToRoad. */
export interface RoadProjection {
  s: number;
  /** Signed lateral offset, + = right of travel. */
  d: number;
  /** Plan distance to the centreline (|d| unless past an open end). */
  dist: number;
  /** Carriageway surface height at (s, d) = y(s) + bank(s)·d. */
  y: number;
}

/** Pure, deterministic generator (A: src/world/terrain.ts). Validates the layout and throws WorldLayoutError on bad data. */
export type GenerateTerrain = (layout: WorldLayout) => TerrainData;
/**
 * FNV-1a 32 (per u32 word: h = Math.imul(h ^ w, 0x01000193) >>> 0, seed
 * 0x811c9dc5) over: cols, rows, then heights as raw u32 words, then
 * material and splat as u32 words (zero-padded tail), then per road
 * stationCount + stations as raw u32 words (f64 → 2 words). Returns u32.
 * Word-wise (not byte-wise) keeps it ~20 ms for 18 MB. Shared by worker and
 * main (A: src/world/terrain.ts).
 */
export type HashTerrain = (terrain: TerrainData) => number;
/** D: src/world/sampler.ts. */
export type CreateTerrainSampler = (terrain: TerrainData) => TerrainSampler;
/**
 * Road helpers (A: src/world/roads.ts). Linear interpolation between
 * stations (2 m: chord error < 2 cm on a 25 m hairpin); tangent
 * renormalized. Allocation-free.
 */
export type SampleRoad = (road: RoadProfile, s: number, out: RoadSample) => RoadSample;
/** Closest centreline point in plan view; `hintS` (optional) enables a local search for per-frame tracking. */
export type ProjectToRoad = (
  road: RoadProfile,
  x: number,
  z: number,
  out: RoadProjection,
  hintS?: number,
) => RoadProjection;

/** Thrown by generateTerrain for an invalid layout (bad junction, size not chunk-aligned, unknown road id…). */
export class WorldLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldLayoutError';
  }
}

// ============================================================ P6 route network (AI traffic)
/**
 * ROUTE NETWORK (P6; T1 implements `buildRouteNetwork` in
 * src/world/routes.ts; docs/CONTRACTS.md "P6 contracts"). PURE and
 * deterministic: a function of (layout, terrain) only, generator numerics
 * (only + − × ÷ sqrt floor abs min max; fixed iteration order: roads in
 * layout order, directions +1 then −1, lanes inner → outer, junctions in
 * layout order). The worker builds it on `setTraffic`; main may build the
 * same one (minimap, debug) and compare `hash`.
 *
 * TRAFFIC DRIVES ON THE RIGHT. A road with `lanes` = n per direction has
 * 2n lanes of width laneW = width / (2n); lane k (0 = next to the centre
 * line, n−1 = kerb side) of direction dir sits at road-frame lateral
 * offset d = dir · (k + 0.5) · laneW (d + = right of increasing s; the
 * right of travel for dir +1, the left for dir −1).
 *
 * ROUTED KINDS: TRAFFIC_ROAD_KINDS (highway, country, mountain, street).
 * dirt trails and the arena runway carry no traffic: a junction leg onto
 * an unrouted road gets no connector.
 *
 * PATHS. Everything an agent follows is a RoutePath with its own station
 * polyline (ROUTE_STATION_SPACING, lane offset and bank already applied,
 * y = carved surface + 0 at the lane centre), so ghosts and the driver
 * model never touch RoadProfiles at runtime:
 *  - LANE: one direction-lane of one road between two junction boxes (or a
 *    road end). Each road is cut at every junction it crosses: the lane
 *    stops JUNCTION_BOX_M before the junction centre and resumes the same
 *    distance after it (closed roads wrap; a road with no junction is one
 *    looping lane per direction-lane).
 *  - CONNECTOR: the drivable curve across a junction box from the end of
 *    an incoming lane to the start of an outgoing lane (a cubic Hermite
 *    between the two lane ends, tangent length 0.5·chord), sampled at the
 *    same spacing. Connectors exist for straight-on (same road, same lane
 *    index), right and left turns onto every other routed leg (kerb lane ↔
 *    kerb lane for right turns, inner ↔ inner for left), and a U-turn at
 *    a DEAD END (an open road end not at a junction: the connector joins
 *    the end of each lane to the start of the opposite direction's kerb
 *    lane on a radius max(width/2 + shoulder, 6 m) semicircle; T1 may
 *    trim it onto the adjacent pad).
 *  - RIGHT-OF-WAY: connectors along the junction's THROUGH road (the
 *    highest-priority road, ROAD_KIND_DEFAULTS.priority; ties layout
 *    order) never yield, except left turns, which yield to the opposing
 *    straight connector. Every connector starting on a branch yields to
 *    every through connector it conflicts with. Two connectors CONFLICT
 *    when their polylines come within 2.5 m of each other anywhere other
 *    than a shared start lane, or end in the same lane (merge).
 *
 * POSE. `routePose(path, s, out)` (T1, routes.ts) gives the vehicle-frame
 * placement of a car whose rig-local ground plane y = 0 stands on the lane
 * at arc s: position = station point (lerp), forward = unit 3D tangent
 * (grade included), r = horizontal right (−tz, 0, tx) raised by the
 * station bank (r + bank·Y, normalized), up = r × forward, then
 * Gram-Schmidt (forward kept exact, right = forward × up); quat from that
 * basis (Shepperd, sqrt only). Rig forward is −Z, so the quat
 * maps local −Z → forward, +Y → up. Ghost poses and promotions use it, so
 * a promoted car spawns where its ghost was drawn.
 */
/** Road kinds that carry AI traffic (dirt / arena: none). */
export const TRAFFIC_ROAD_KINDS: readonly RoadKind[] = ['highway', 'country', 'mountain', 'street'];
/** Speed limit per road kind, m/s (0 = not routed): highway 110, country 80, mountain 60, street 50 km/h. */
export const ROUTE_SPEED_LIMITS: Readonly<Record<RoadKind, number>> = {
  highway: 110 / 3.6,
  country: 80 / 3.6,
  mountain: 60 / 3.6,
  street: 50 / 3.6,
  dirt: 0,
  arena: 0,
  track: 0,
};
/** Station spacing along every RoutePath, m (the last station sits at `length`). */
export const ROUTE_STATION_SPACING = 2;
/**
 * f64 per route station: [x, y, z, tx, ty, tz, bank, curvature]
 *   x, y, z     lane-centre point on the carved surface (world m)
 *   tx, ty, tz  unit 3D tangent in the direction of travel
 *   bank        cross-slope m/m in the PATH frame (+ = right of travel higher)
 *   curvature   signed plan curvature of the lane line, 1/m (+ = turning right)
 */
export const ROUTE_STATION_STRIDE = 8;
export const RouteStation = { x: 0, y: 1, z: 2, tx: 3, ty: 4, tz: 5, bank: 6, curvature: 7 } as const;
/** Lanes stop / resume this far from a junction centre, m (the connector spans the box). */
export const JUNCTION_BOX_M = 12;

export type RouteTurn = 'straight' | 'left' | 'right' | 'uturn';

export interface RoutePath {
  /** Index in RouteNetwork.paths (lanes first in build order, then connectors). */
  index: number;
  kind: 'lane' | 'connector';
  /** Lane: RoadProfile id. Connector: null. */
  road: string | null;
  /** Lane: +1 travels toward increasing road s, −1 toward decreasing. Connector: 0. */
  dir: 1 | -1 | 0;
  /** Lane: 0 = inner (centre line) … lanes−1 = kerb. Connector: −1. */
  lane: number;
  /** Lane: road-frame lateral offset of the lane centre, m (see the module doc). Connector: 0. */
  offset: number;
  /** Lane: road arc range covered, travel order (sFrom > sTo for dir −1; a closed road may wrap). Connector: 0, length. */
  sFrom: number;
  sTo: number;
  /** Arc length along the path polyline, m. */
  length: number;
  /** m/s: lane = ROUTE_SPEED_LIMITS[kind]; connector = min of its two lanes' limits, ≤ 40 km/h for turns, ≤ 15 km/h for U-turns. */
  speedLimit: number;
  stationCount: number;
  /** stationCount × ROUTE_STATION_STRIDE. */
  stations: Float64Array;
  /** Successor / predecessor path indices (ascending). A lane's successors are connectors (or the next lane of a closed road with no junction); a connector's single successor is a lane. */
  next: readonly number[];
  prev: readonly number[];
  /** Lane: the junction id at its END (null = dead end / loop). Connector: the junction it crosses (null for a dead-end U-turn). */
  junction: string | null;
  /** Connector turn type; lanes null. */
  turn: RouteTurn | null;
  /** Connector must give way (see RIGHT-OF-WAY). Lanes false. */
  yield: boolean;
  /** Connector: indices of conflicting connectors (ascending). Lanes: []. */
  conflicts: readonly number[];
  /** Lane: the same-direction neighbour lanes (lane change), −1 = none. Connector: −1, −1. */
  left: number;
  right: number;
  /**
   * Layout v6 (R-WORLD, additive; not hashed): connector of a SIGNALLED junction — its
   * incoming leg's signal (`plan` = index into buildSignalPlans(layout, net), `leg` = index
   * into that plan's legs); query the aspect with signalAspect(plan, leg, tick). Null otherwise.
   */
  signal?: { plan: number; leg: number } | null;
  /** Layout v6: connector that must STOP at the junction entry (stop / allStop control) before yielding. */
  stop?: boolean;
}

export interface RouteJunction {
  id: string;
  pos: Vec2;
  /** Layout v6: JunctionDef.control (default 'none'). */
  control?: JunctionControl;
  /** Highest-priority routed road through the junction. */
  through: string;
  /** Connector path indices crossing it (ascending). */
  connectors: readonly number[];
}

export interface RouteNetwork {
  layoutId: string;
  layoutVersion: number;
  paths: readonly RoutePath[];
  junctions: readonly RouteJunction[];
  /** Number of lane paths (paths[0, laneCount) are lanes). */
  laneCount: number;
  /** Σ lane lengths, m (density bookkeeping). */
  laneLength: number;
  /** FNV-1a 32 over path count, then per path kind/dir/lane/next and the stations as raw u32 words (hashTerrain's word rule). */
  hash: number;
}

/** Vehicle-frame placement on a path (routePose output). */
export interface RoutePose {
  pos: [number, number, number];
  quat: [number, number, number, number];
  /** Unit forward / up in world space (convenience for the driver model). */
  forward: [number, number, number];
  up: [number, number, number];
  curvature: number;
  speedLimit: number;
}

/** T1: src/world/routes.ts. Throws WorldLayoutError on a layout it cannot route (should not happen for validated layouts). */
export type BuildRouteNetwork = (layout: WorldLayout, terrain: TerrainData) => RouteNetwork;
/** T1: allocation-free; s clamped to [0, path.length]. */
export type RoutePoseFn = (path: RoutePath, s: number, out: RoutePose) => RoutePose;
