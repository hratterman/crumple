/**
 * Vehicle visuals + flexbody contracts — P4 (BindingSet FREEZES at the end
 * of P4). Types, constants and factory signatures only; implementations
 * live in the modules named on each factory (ownership: docs/CONTRACTS.md
 * "P4 work split"). Main thread only (three allowed); never imports sim
 * internals — CompiledVehicle comes from the pure src/sim/vehicle modules
 * (P2 boundary amendment).
 *
 * ======================================================================
 * PIPELINE (per vehicle, at spawn; all pure/deterministic except GPU
 * resource creation):
 *   compiled = compileVehicle(vehicleDef)                 (src/sim/vehicle/builder, pure)
 *   geoms    = tessellateVehicle(visualDef)               (A1 loft.ts)
 *   binding  = bindPanels(compiled, visualDef, geoms)     (A2 binder.ts)  → BindingSet
 *   mats     = createVehicleMaterials(ctx, visualDef)     (A3 materials.ts)
 *   damage   = createVehicleDamage(compiled, binding, visualDef)          (A4 damage.ts)
 *   skin     = createFlexSkin(binding, {mats, damage, lighting, patchMaterial}) (A2 flexskin.ts)
 *   wheels   = createWheelVisuals(compiled, visualDef.wheels, {...})      (A3 wheels.ts)
 *   visual   = createVehicleVisual(...) wraps all of it   (A2 index.ts)
 * PER FRAME (VehicleVisual.update, after SimClient.interpolate):
 *   damage.update(frame)  → node block B + nodeFlags + panel visibility
 *   skin.update(frame)    → node block A (positions, flags), anchor, bounds, upload
 *   wheels.update(skin)   → rims / tyres from the same node data
 *   mats.setLights(...)   → emissive lamps from telemetry
 *
 * SPACES:
 *   rig-local / REST  — VehicleDef coordinates (vehicle frame: up +Y,
 *     forward −Z, right +X), rest pose of the CompiledRig. Every surface,
 *     PanelGeometry and BindingSet rest attribute is in this space.
 *   world             — SimClient.interpolate output.
 *   SKIN space        — world − anchor, anchor = the interpolated world
 *     position of the frame-origin node (CompiledVehicle.frameNodes[0])
 *     this frame. The vehicle root Object3D sits at `anchor` with identity
 *     rotation/scale; panel meshes are its identity children. The node
 *     texture stores skin-space positions (subtracted in f64 on the CPU:
 *     f32 precision stays ~1e-6 m near the car, not 6e-5 m at 700 m).
 *     Object-space normals of skinned meshes are therefore world normals.
 * NODE INDICES in triads / bind sets / node textures are OBJECT-LOCAL
 * (canonical merged order = CompiledRig order = snapshot order within the
 * object), never global.
 * ======================================================================
 */
import type {
  DataTexture,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';

import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../../protocol/events';
import type { VehicleTelemetryFrame } from '../../protocol/telemetry';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { LightingStack, PatchMaterial, RenderContext, ShaderPatch } from '../types';

export type Vec3T = readonly [number, number, number];

// ====================================================================== selectors
/**
 * Node selector: rig node ids, each entry an exact id or a glob where `*`
 * matches any run of characters (e.g. 's0_*', 'hood_*', 's5_cw*'),
 * resolved against CompiledRig.nodeIds (object-local index order). An
 * entry matching nothing is a BindError (catches rig/visual drift).
 */
export type NodeSelector = readonly string[];

/**
 * Beam selector, resolved to OBJECT-LOCAL beam indices (ascending) against
 * CompiledRig.beamA/beamB. Node ids, never beam indices: sim retuning
 * (adding/removing beams) shifts indices but keeps ids.
 *   pairs:   exact endpoint pairs (either order); a pair with no beam is a BindError.
 *   between: every beam with one endpoint in A and the other in B.
 */
export type BeamSelector =
  | { readonly pairs: readonly (readonly [string, string])[] }
  | { readonly between: readonly [NodeSelector, NodeSelector] };

// ====================================================================== surfaces (A1 emits)
/**
 * LOFT — the minimal surface schema the body generator emits. Cross-section
 * curves ordered along the car ("rail" order, usually +Z); every section
 * has the same control-point count. Evaluation (A1 tessellator, pure):
 *   u: along each section, centripetal Catmull-Rom (src/core/spline)
 *      through its control points (closed when closedU);
 *   v: for each u-sample, centripetal Catmull-Rom through the sections'
 *      points at that u (this IS the spline rail family).
 * (u, v) are arc-length normalized to [0, 1] on the master surface, so
 * panels cut from one loft by `window` share edges exactly (shut lines =
 * `inset` on each side). UV attribute = arc length in METRES (u across,
 * v along): uniform texel density for flake, scuffs and cracks.
 * Normals point OUT of the car (`flip` corrects authoring order).
 */
export interface LoftSurface {
  type: 'loft';
  /** ≥ 2 sections × ≥ 2 control points, rig-local REST metres. */
  sections: readonly (readonly Vec3T[])[];
  closedU?: boolean;
  /** Target max edge length, m (A1 picks per-span segment counts; ≤ 0.08 for body panels). */
  resolution: number;
  /** Window on the master (u, v) ∈ [0, 1]², default full. */
  window?: { u0: number; u1: number; v0: number; v1: number };
  /** Inset of each window edge, m (default VISUAL_DEFAULTS.shutGap / 2 for windowed panels, 0 otherwise). */
  inset?: number;
  /** > 0: inner shell offset along −normal plus an edge strip (torn / detached panels show thickness). */
  thickness?: number;
  flip?: boolean;
  /** Also emit the mirror image across x = 0 (winding corrected) into the SAME panel. */
  mirrorX?: boolean;
}
/** Explicit small parts (lamp lenses, grille bars, interior blocks, mirror housings). Rig-local REST metres. */
export interface MeshSurface {
  type: 'mesh';
  position: readonly number[];
  index: readonly number[];
  /** Optional; A1 computes smooth normals / planar UVs (metres) when absent. */
  normal?: readonly number[];
  uv?: readonly number[];
}
export type SurfaceSpec = LoftSurface | MeshSurface;

/**
 * Tessellated panel in REST rig-local space (A1 output, A2 input). Panels
 * are SEPARATE meshes: no vertex is shared across panels; duplicated
 * vertices inside a panel (UV seams, hard creases, mirror seam) carry
 * identical positions (bit-equal) so the binder can weld their triads.
 */
export interface PanelGeometry {
  panelId: string;
  /** xyz per vertex. */
  position: Float32Array;
  /** Unit outward normal per vertex. */
  normal: Float32Array;
  /** uv per vertex, metres (LoftSurface doc). */
  uv: Float32Array;
  /** xyzw (MikkTSpace-style, w = ±1) or null: A2 computes when a material needs tangents. */
  tangent: Float32Array | null;
  /** Triangles, CCW seen from outside. */
  index: Uint32Array;
  /** Per-vertex damage visibility 0..1 (null = PanelDef.damageWeight everywhere). */
  damageWeight: Float32Array | null;
}

// ====================================================================== panels
export type PanelKind =
  | 'body'
  | 'hood'
  | 'trunk'
  | 'door'
  | 'fender'
  | 'bumper'
  | 'roof'
  | 'glass'
  | 'light'
  | 'trim'
  | 'interior'
  | 'grille'
  | 'mirror';

/**
 * Material slots (A3 creates one base material per slot; A2 clones +
 * patches per panel). Wheel slots are used by wheels.ts only.
 */
export type MaterialSlot =
  | 'paint'
  | 'trim' //        black textured plastic (bumper lowers, pillars, mirror bases)
  | 'chrome'
  | 'glass' //       body glass (transmission; tint per PaintDef-independent default)
  | 'rubber' //      seals, wiper blades
  | 'lightHead' //   lamp lenses: emissive driven by setLights
  | 'lightTail'
  | 'lightIndicator'
  | 'lightReverse'
  | 'interior' //    seats / dash fabric-plastic
  | 'interiorTrim'
  | 'grille'
  | 'mirror' //      mirror glass (high metalness, low roughness)
  | 'underbody'
  | 'plate'
  | 'rim'
  | 'tire'
  | 'brakeDisc'
  | 'caliper';

export type LightFunction = 'head' | 'highBeam' | 'tail' | 'brake' | 'reverse' | 'indicatorL' | 'indicatorR' | 'fog';

/**
 * Detachment. ATTACH SET = the beams that hold the panel's own nodes to
 * the rest of the car:
 *   'boundary' — every beam with EXACTLY one endpoint in the panel's bind
 *     node set, excluding type 'support' (compression-only rests) and
 *     beams that can never break (breakF ∞);
 *   BeamSelector — explicit.
 * DETACHED ⇔ broken(attach set) / |attach set| ≥ minBrokenFraction
 * (broken = snapshot bitset, authoritative). Sticky until repair epoch
 * changes. An empty attach set is a BindError.
 * mode:
 *   'follow' — the panel's nodes are a physical sub-rig (hood, bumper
 *     station): nothing is hidden, the panel keeps skinning to its own
 *     flying nodes; detaching only fires FX (DamageFx 'panelDetach') and
 *     sets NODE_TEX_FLAG_DETACHED on its nodes.
 *   'hide'   — no own sub-rig (mirrors, trim): the panel mesh is hidden
 *     and a DamageFx 'panelDetach' carries its rest geometry index so the
 *     FX layer can throw a rigid debris copy.
 */
export interface DetachSpec {
  attach: 'boundary' | BeamSelector;
  /** 0 < f ≤ 1. */
  minBrokenFraction: number;
  mode: 'follow' | 'hide';
}

/**
 * Glass behaviour (glass panels; also allowed on lamp lenses). Strain =
 * max |L/L0 − 1| over `beams` (main-side, current interpolated lengths vs
 * CompiledRig.beamRestLen); impulses from ImpactEvents whose position lies
 * within the pane's current bounding sphere + 0.2 m.
 *   crack   when strain ≥ crackStrain or impulse ≥ crackImpulse (crack
 *           overlay grows with further hits, centre = nearest impact);
 *   shatter when strain ≥ shatterStrain, impulse ≥ shatterImpulse, or
 *           broken(beams)/|beams| ≥ shatterBrokenFraction.
 * laminated (windscreen): never disappears — crack level → 1 and it keeps
 * deforming with its frame. Tempered (side/rear): hidden on shatter +
 * DamageFx 'glassShatter' (particle burst of cubes).
 */
export interface GlassSpec {
  laminated: boolean;
  beams: BeamSelector;
  crackStrain: number;
  shatterStrain: number;
  /** N·s (ImpactEvent.impulse). */
  crackImpulse: number;
  shatterImpulse: number;
  shatterBrokenFraction: number;
}

export interface PanelDef {
  /** Unique within the vehicle; [A-Za-z0-9_]+ (e.g. 'hood', 'doorFL', 'glassRear'). */
  id: string;
  kind: PanelKind;
  material: MaterialSlot;
  surface: SurfaceSpec;
  /**
   * The ONLY nodes this panel may bind to ("panels bind only to their own
   * nodes"): a panel never spans a joint that can tear (hood ⟂ fenders,
   * bumper ⟂ crash cans), so a torn joint separates panels instead of
   * stretching one.
   */
  bind: NodeSelector;
  detach: DetachSpec | null;
  glass?: GlassSpec;
  /** Lamp functions lit on this panel (material must be a light* slot). */
  lights?: readonly LightFunction[];
  /** Default 1 for paint/trim/grille/bumper, 0.3 lights, 0 glass/interior/rubber. */
  damageWeight?: number;
  /** Default true (glass: false — transmission glass casting full shadows reads as dark panes). */
  castShadow?: boolean;
}

/** Car paint (A3 materials: MeshPhysicalMaterial clearcoat + procedural flake). */
export interface PaintDef {
  /** sRGB hex (Color.setHex converts to linear). */
  color: number;
  /** 0..1 → metalness. */
  metallic: number;
  /** Base-coat roughness 0..1. */
  roughness: number;
  /** 0..1 clearcoat weight and its roughness. */
  clearcoat: number;
  clearcoatRoughness: number;
  /** Metallic flake normal perturbation in REST space (vFlexRest), or null for solid paint. */
  flake: { density: number; scale: number; intensity: number } | null;
  /** 0..1 pearl / iridescence tint (0 = none). */
  pearl?: number;
}

/** Wheel visuals (A3 wheels.ts). One style for all wheels; per-axle tweaks via `rear`. */
export interface WheelVisualDef {
  rim: {
    style: 'spoke' | 'mesh' | 'steel' | 'turbine';
    spokes: number;
    /** Spoke width as a fraction of the spoke pitch, 0..1. */
    spokeWidth: number;
    /** Face depth from the outer lip, m. */
    dish: number;
    /** Outer lip radial width, m. */
    lip: number;
    finish: 'silver' | 'gunmetal' | 'chrome' | 'black' | 'gold';
    boltCount: number;
  };
  tire: {
    tread: 'street' | 'sport' | 'allTerrain';
    /** Raised sidewall lettering (procedural canvas texture), or null. */
    sidewallText: string | null;
    /** Sidewall bulge as a fraction of section height (0.05–0.15). */
    bulge: number;
  };
  brake: { discRadius: number; caliperColor: number };
  /** Optional rear override of rim/tire fields. */
  rear?: Partial<Pick<WheelVisualDef, 'rim' | 'tire'>>;
}

/** Everything that makes a vehicle visible. Pure data (A1 authors the sedan's: src/render/vehicle/defs/sedan.ts). */
export interface VehicleVisualDef {
  /** Must equal VehicleDef.name / CompiledVehicle.name (bindPanels checks). */
  vehicle: string;
  panels: readonly PanelDef[];
  paint: PaintDef;
  wheels: WheelVisualDef;
  /** Licence plate text (procedural texture on 'plate' panels), optional. */
  plate?: string;
}

export const VISUAL_DEFAULTS = {
  /** Panel shut-line gap, m (each side of a cut is inset by half). */
  shutGap: 0.004,
  /** Glass sits this far inside its frame lofts, m. */
  glassInset: 0.012,
} as const;

/** (vehicleDef) → one PanelGeometry per PanelDef, same order. Pure, deterministic; throws Error on malformed specs. */
export type TessellateVehicle = (def: VehicleVisualDef) => PanelGeometry[];

// ====================================================================== BindingSet (A2 binder, FREEZES end of P4)
/**
 * FLEXBODY RECONSTRUCTION — EXACTLY what the vertex shader (and the CPU
 * mirror evalFlexVertex) computes, per vertex with triad (iR, iX, iY),
 * coefficients (a, b, c, d0) and frame-local normal/tangent (fn, ft):
 *
 *   R = node(iR), X = node(iX), Y = node(iY)          (skin space, block A .xyz)
 *   e1 = X − R ;  e2 = Y − R
 *   cr = cross(e1, e2) ;  L = length(cr)
 *   n̂  = cr / max(L, FLEX_CROSS_FLOOR)               ONLY the cross product is normalized
 *   P  = R + a·e1 + b·e2 + c·n̂                       e1, e2 stay UNnormalized (RoR flexbody)
 *   clamp: if !(length(P − R) ≤ FLEX_MAX_STRETCH·d0 + FLEX_MAX_SLACK) then P = R
 *          (NaN-safe: the negated comparison also collapses NaN; a collapsed
 *          vertex degenerates its triangles → torn / exploded triads vanish
 *          instead of spiking across the screen)
 *   Gram–Schmidt frame (normals/tangents only):
 *     f1 = e1 / max(|e1|, FLEX_GS_FLOOR)
 *     t  = e2 − (e2·f1)·f1 ;  f2 = t / max(|t|, FLEX_GS_FLOOR)
 *     f3 = cross(f1, f2)                               (= n̂ direction)
 *   N = normalize(fn.x·f1 + fn.y·f2 + fn.z·f3)
 *   T = normalize(ft.x·f1 + ft.y·f2 + ft.z·f3), handedness ft.w
 *
 * BIND (rest, f64): (a, b, c) solve P_rest = R0 + a·e1₀ + b·e2₀ + c·n̂₀
 * (c = (P−R0)·n̂₀; a, b from the 2×2 Gram system); d0 = |P_rest − R0|;
 * fn = (n·f1₀, n·f2₀, n·f3₀), ft likewise, with the same GS frame at rest.
 *
 * TRIAD SELECTION (deterministic):
 *   candidates = the k nearest bind-set nodes to the vertex (ties: lower
 *   index), k = FLEX_CANDIDATE_STEPS[0]; enumerate R among the first 3,
 *   X < Y among the rest; ACCEPT iff
 *     angle(e1₀, e2₀) ∈ [FLEX_MIN_ANGLE_DEG, 180 − FLEX_MIN_ANGLE_DEG],
 *     |e1₀|, |e2₀| ∈ [FLEX_MIN_EDGE, FLEX_MAX_EDGE], max/min ≤ FLEX_MAX_EDGE_RATIO,
 *     |c| ≤ FLEX_MAX_ABS_C, |a|, |b| ≤ FLEX_MAX_AB;
 *   score = |c| + 0.5·|P − R0| + 0.2·max(0, |a| + |b| − 1); lowest wins,
 *   ties → lexicographic (iR, iX, iY).
 *   REPAIR: none accepted → next k in FLEX_CANDIDATE_STEPS (finally the
 *   whole bind set); still none → BindError naming panel + vertex. Never
 *   falls back to nodes outside the panel's bind set. Repairs are counted
 *   in BindingStats.
 * SEAMS: vertices of one panel with bit-equal rest positions (quantized to
 * FLEX_SEAM_QUANTUM) are bound ONCE and share the identical triad +
 * coefficients (normals/tangents stay per-vertex), so UV seams and creases
 * never crack. Panels never share vertices (shut lines are real gaps).
 */
export const FLEX_MIN_ANGLE_DEG = 25;
export const FLEX_MIN_EDGE = 0.04;
export const FLEX_MAX_EDGE = 1.6;
export const FLEX_MAX_EDGE_RATIO = 6;
export const FLEX_MAX_ABS_C = 0.3;
export const FLEX_MAX_AB = 3;
export const FLEX_CANDIDATE_STEPS: readonly number[] = [8, 16, Infinity];
export const FLEX_SEAM_QUANTUM = 1e-5;
/** |cross| floor, m² (rest |cross| of a 4 cm × 4 cm 25° triad ≈ 6.8e-4). */
export const FLEX_CROSS_FLOOR = 1e-4;
export const FLEX_GS_FLOOR = 1e-6;
/** Runtime clamp: |P − R| ≤ FLEX_MAX_STRETCH·d0 + FLEX_MAX_SLACK (m) else collapse to R. */
export const FLEX_MAX_STRETCH = 2;
export const FLEX_MAX_SLACK = 0.15;
/** Triads are Uint16: objects above this node count cannot be skinned. */
export const FLEX_MAX_OBJECT_NODES = 65535;

/** Per-panel binder output. All arrays per vertex unless noted; vertex order = PanelGeometry order. */
export interface BindingPanel {
  panelId: string;
  /** Index in VehicleVisualDef.panels / BindingSet.panels. */
  panelIndex: number;
  kind: PanelKind;
  material: MaterialSlot;
  vertexCount: number;
  /** REST rig-local (geometry `position` attribute; also feeds vFlexRest). */
  restPosition: Float32Array;
  restNormal: Float32Array;
  /** xyzw or null. */
  restTangent: Float32Array | null;
  uv: Float32Array;
  index: Uint32Array;
  /** iR, iX, iY per vertex (object-local node indices). */
  triad: Uint16Array;
  /** a, b, c, d0 per vertex. */
  coef: Float32Array;
  /** Rest normal in the triad's rest GS frame, xyz per vertex. */
  frameNormal: Float32Array;
  /** Rest tangent in the GS frame, xyzw (w = handedness) per vertex, or null. */
  frameTangent: Float32Array | null;
  /** 0..1 per vertex (PanelGeometry.damageWeight or PanelDef default). */
  damageWeight: Float32Array;
  /** Sorted unique object-local node indices referenced by this panel's triads (bounds, FX). */
  nodes: Uint16Array;
  /** Resolved bind set (sorted object-local indices): the detach 'boundary' rule uses it. */
  bindNodes: Uint16Array;
  /** Rest bounding sphere (rig-local). */
  restCenter: Vec3T;
  restRadius: number;
  detach: {
    /** Object-local beam indices, ascending, non-empty. */
    attachBeams: Int32Array;
    minBrokenFraction: number;
    mode: 'follow' | 'hide';
  } | null;
  glass: (Omit<GlassSpec, 'beams'> & { beams: Int32Array }) | null;
  lights: readonly LightFunction[];
  castShadow: boolean;
}

export interface BindingStats {
  vertices: number;
  triangles: number;
  /** Vertices that needed a larger candidate set (FLEX_CANDIDATE_STEPS > 0). */
  repaired: number;
  /** Seam-welded duplicate vertices. */
  welded: number;
  maxAbsC: number;
  minAngleDeg: number;
}

export interface BindingSet {
  /** CompiledVehicle.name. */
  vehicle: string;
  /** CompiledRig.nodeCount (node texture sizing). */
  nodeCount: number;
  /** FNV-1a over node ids, rest positions (f32) and beam endpoint pairs: a binding is valid only for this rig. */
  rigHash: number;
  panels: BindingPanel[];
  stats: BindingStats;
}

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

/**
 * Pure, deterministic (A2 binder.ts): resolves selectors, binds every
 * vertex, resolves detach/glass beam sets. Throws BindError on: vehicle
 * name mismatch, selector matching nothing, unbindable vertex, empty
 * attach set, nodeCount > FLEX_MAX_OBJECT_NODES.
 */
export type BindPanels = (
  compiled: CompiledVehicle,
  def: VehicleVisualDef,
  geoms: readonly PanelGeometry[],
) => BindingSet;

/**
 * CPU mirror of the shader (A2 exports `evalFlexVertex` from binder.ts):
 * writes vertex v of `panel` (position xyz, normal xyz) into out[0..6) from
 * node positions `nodes` (xyz interleaved, object-local). Bit-for-bit the
 * formula above in f64; tests assert rest-pose round trip ≤ 1e-5 m and
 * rigid-motion invariance.
 */
export type EvalFlexVertex = (panel: BindingPanel, v: number, nodes: ArrayLike<number>, out: Float64Array) => void;

// ====================================================================== node texture (A2 flexskin)
/**
 * NODE TEXTURE — one per vehicle: DataTexture RGBA32F (FloatType),
 * NearestFilter, no mipmaps, flipY false, width NODE_TEX_WIDTH,
 * height 2·rows, rows = ceil(nodeCount / 64). Texel of node i in block k:
 * (i & 63, (i >> 6) + k·rows)  — read with texelFetch only.
 *   block A (k = 0): xyz = skin-space position, w = node flags (integer
 *     value stored as float: NODE_TEX_FLAG_* bits). Written every frame by
 *     skin.update from SimClient.interpolate.
 *   block B (k = 1): x = plastic strain 0..1, y = scuff 0..1,
 *     z = glass crack 0..1, w = reserved 0. Written by damage.update.
 * Uploaded once per frame (texture.needsUpdate) after both blocks are written.
 */
export const NODE_TEX_WIDTH = 64;
/** Node lost ≥ 1 incident beam (broken-attachment bit, from the snapshot bitset). */
export const NODE_TEX_FLAG_BROKEN = 1;
/** Node belongs to a detached 'follow' panel. */
export const NODE_TEX_FLAG_DETACHED = 2;

/**
 * FLEXBODY SHADER PATCH (FlexSkin.patch, MaterialFeatures.flexbody;
 * targets color + depth + distance). GLSL contract:
 *   uniforms  `uFlexNodes` (sampler2D, the node texture),
 *             `uFlexRows` (int, rows per block);
 *   attributes `flexTriad` vec3 (node indices as EXACT floats; decoded
 *             `ivec3(flexTriad + 0.5)` — float attributes avoid the
 *             signedness pitfalls of integer attributes in three/ANGLE),
 *             `flexCoef` vec4 (a, b, c, d0), `flexNormal` vec3 (frameNormal),
 *             `flexTangent` vec4 (only under USE_TANGENT), `flexDamage` float
 *             (damageWeight);
 *   replaces  <begin_vertex>, <beginnormal_vertex> (objectNormal, and
 *             objectTangent under USE_TANGENT) with the reconstruction;
 *   defines   `FLEXBODY`; on the COLOR target also the varyings
 *             `vFlexRest` vec3 (REST rig-local position = `position`
 *             attribute: stable coordinates for flake / crack / scuff
 *             noise that never swim) and `vFlexDamage` vec4 =
 *             (strain, scuff, crack from block B blended over the triad
 *             with weights wX = clamp(a,0,1), wY = clamp(b,0,1),
 *             wR = max(0, 1 − wX − wY), renormalized; × flexDamage;
 *             w = 1 if any triad node has NODE_TEX_FLAG_BROKEN).
 *   key       'flex1' (identical GLSL for every vehicle; uniforms per material).
 * Material hooks (A3 flake, A4 damage) may read vFlexRest / vFlexDamage
 * under `#ifdef FLEXBODY`, in fragment chunks after <normal_fragment_maps>.
 * Bounds: skin.update sets each panel geometry's boundingSphere from its
 * `nodes` (skin space, + 0.1 m) every frame, so frustum and shadow culling
 * stay correct for flying panels; the `position` attribute is REST and is
 * never used for bounds.
 */
export const FLEXBODY_PATCH_KEY = 'flex1';

/** One frame of sim input for a vehicle (built by the app from SimClient). */
export interface VehicleFrameInput {
  /** SimClient.interpolate output: global, xyz interleaved, world space. */
  nodes: Float32Array;
  /** The object's first node in `nodes` (elements). */
  nodeOffset: number;
  /** Latest snapshot tick: snapshot-rate work (strain ratchet, bitset) runs only when it changes. */
  tick: number;
  /** Object-local broken flags of the latest snapshot (SimClient.brokenBeams), 1 = broken. */
  broken: Uint8Array;
  /** OBJ_REPAIR_EPOCH of the latest snapshot. */
  repairEpoch: number;
  telemetry: VehicleTelemetryFrame | null;
  dtS: number;
}

export interface FlexSkin {
  /** Root at the anchor; children = one Mesh per BindingPanel (same order). */
  readonly object: Group;
  readonly meshes: readonly Mesh[];
  readonly nodeTexture: DataTexture;
  readonly rows: number;
  /** CPU mirror of the texture (block A then block B), 4 floats per texel. */
  readonly nodeData: Float32Array;
  /** Per-node NODE_TEX_FLAG_* (written by damage, merged into block A .w by update). */
  readonly nodeFlags: Uint8Array;
  /** World position of the anchor this frame (root.position). */
  readonly anchor: Vec3T;
  readonly patch: ShaderPatch;
  /** Writes block A from frame.nodes (minus anchor), updates bounds, uploads the texture. */
  update(frame: VehicleFrameInput): void;
  setPanelVisible(panelIndex: number, visible: boolean): void;
  dispose(): void;
}
export interface FlexSkinOptions {
  materials: VehicleMaterialSet;
  /** Per-panel damage patch provider (A4); null = no damage shading. */
  damage: VehicleDamage | null;
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
}
/**
 * A2 flexskin.ts. Per panel: BufferGeometry (position = restPosition,
 * normal, uv, flexTriad, flexCoef, flexNormal, [tangent, flexTangent],
 * flexDamage, index), material = patchMaterial(materials.base(slot).clone(),
 * {csm, flexbody: skin.patch, damage: damage?.patchFor(panelIndex)});
 * mesh.material / customDepthMaterial / customDistanceMaterial from the
 * set; castShadow per panel, receiveShadow true.
 */
export type CreateFlexSkin = (binding: BindingSet, opts: FlexSkinOptions) => FlexSkin;

// ====================================================================== materials (A3)
export interface LightState {
  head: boolean;
  highBeam: boolean;
  /** 0..1 (brake pedal → brake lamps). */
  brake: number;
  reverse: boolean;
  indicatorL: boolean;
  indicatorR: boolean;
  fog: boolean;
}
export interface VehicleMaterialSet {
  /**
   * Base (unpatched) material for a slot. Consumers CLONE before patching
   * (patchMaterial throws on a second patch). A material may carry its own
   * onBeforeCompile (flake, lamp emissive) + customProgramCacheKey: it
   * becomes patchMaterial's "prior hook" and runs before CSM/flexbody/damage.
   */
  base(slot: MaterialSlot): MeshStandardMaterial | MeshPhysicalMaterial;
  /** Apply a new paint to every material (and clone) derived from 'paint'. */
  setPaint(paint: PaintDef): void;
  /** Lamp emissive state (all clones of light* slots); called each frame. */
  setLights(state: LightState): void;
  dispose(): void;
}
/** A3 materials.ts (procedural textures in textures.ts; never hard-requires downloaded files). */
export type CreateVehicleMaterials = (ctx: RenderContext, def: VehicleVisualDef) => VehicleMaterialSet;

// ====================================================================== wheels (A3)
/**
 * WHEEL SKIN (A3 wheels.ts). Per CompiledWheel, from the skin's node data
 * (block A, skin space):
 *   axle  s = normalize(hubO − hubI), centre = (hubI + hubO)/2;
 *   spin  angle from the rim ring (mean phase of rim nodes about s vs rest)
 *         → rigid rim + brake disc transform (calipers: no spin, yaw with
 *         the upright: frame from hubs + WheelDef.attach node);
 *   tyre  rigid frame + per-vertex radial scale from the tyre ring: vertex
 *         at rest angle θ between rays k, k+1 and side (inner/outer row)
 *         gets r·lerp(ρ_k, ρ_k+1) with ρ = current/rest radial distance of
 *         the tyre nodes from the axle (flat spots, squash, blow-outs) —
 *         never per-node triads (a 12-ray polygon would facet the tyre).
 * Done in a ShaderPatch passed as MaterialFeatures.flexbody (key 'wheel1',
 * color + depth + distance), so wheel shadows deform too. A detached wheel
 * just follows its hub/rim/tyre nodes.
 */
export interface WheelVisuals {
  readonly object: Group;
  update(skin: FlexSkin, dtS: number): void;
  dispose(): void;
}
export type CreateWheelVisuals = (
  compiled: CompiledVehicle,
  def: WheelVisualDef,
  opts: { materials: VehicleMaterialSet; lighting: LightingStack; patchMaterial: PatchMaterial },
) => WheelVisuals;

// ====================================================================== damage (A4)
/**
 * DAMAGE DATA FLOW (no new snapshot section for strain):
 *   snapshot broken bitset (layout.ts, authoritative) → per node
 *     NODE_TEX_FLAG_BROKEN (any incident beam broken), detach state of
 *     every panel (attachBeams), glass shatterBrokenFraction;
 *   beamBreak events → immediate FX (sparks/crunch at pos, DamageFx) and an
 *     early detach/shatter check (the bitset confirms on the next snapshot);
 *   impact events → scuff (block B .y += impulse/scuffFullImpulse ×
 *     smooth falloff over scuffRadius around pos) and glass crack/shatter
 *     by impulse;
 *   skid events not near a tyre node (> 0.25 m) → light scuff (scrapes);
 *   PLASTIC STRAIN is derived on main from rest-vs-current edge lengths:
 *     per snapshot (tick change), e_b = |L/L0 − 1| for every intact BODY
 *     beam (L0 = CompiledRig.beamRestLen, L from frame.nodes), node raw
 *     strain s_i = max over incident intact beams; persistence filter
 *     ŝ_i = min(s_i over the last strainPersist snapshots) (drops elastic
 *     transients shorter than ~25 ms); ratchet S_i = max(S_i,
 *     clamp((ŝ_i − strainDeadzone)/(strainFull − strainDeadzone), 0, 1)).
 *     WHY main-side: plastic yield in this sim IS a lasting length change
 *     (restLen ratchet), visible as current-vs-original length, so ~2 k
 *     beams × 120 Hz of + − × ÷ sqrt on main (< 0.1 ms) replaces a
 *     per-beam/per-node protocol section; elastic driving loads stay
 *     < 1 % strain (deadzone).
 *   repairEpoch change → clear strain/scuff/crack/flags, show all panels.
 * Shading (damage ShaderPatch, color only, after flexbody): darken +
 * roughen + normal-perturb paint by vFlexDamage.x (crumple wrinkles from
 * vFlexRest noise), scuff = exposed primer/metal by .y, torn-edge darkening
 * by .w, glass crack overlay by per-panel uniforms (centre in rest space +
 * level).
 */
export const DAMAGE_DEFAULTS = {
  strainDeadzone: 0.01,
  strainFull: 0.08,
  strainPersist: 3,
  scuffRadius: 0.35,
  scuffFullImpulse: 300,
} as const;

export type DamageFx =
  | { type: 'panelDetach'; panelIndex: number; mode: 'follow' | 'hide'; pos: Vec3T }
  | { type: 'glassCrack'; panelIndex: number; level: number; pos: Vec3T }
  | { type: 'glassShatter'; panelIndex: number; pos: Vec3T; normal: Vec3T; laminated: boolean }
  | { type: 'beamBreak'; beamIndex: number; pos: Vec3T };

export interface VehicleDamage {
  /** Per-panel damage ShaderPatch (key 'dmg1'; glass panels get crack uniforms), or null for undamageable panels. */
  patchFor(panelIndex: number): ShaderPatch | null;
  /** Snapshot-rate + per-frame work; writes skin block B, skin.nodeFlags, panel visibility. Runs BEFORE skin.update. */
  update(frame: VehicleFrameInput, skin: FlexSkin): void;
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  /** Detached / shattered state per panel (UI damage schematic, tests). */
  panelState(panelIndex: number): { detached: boolean; crack: number; shattered: boolean };
  /** FX sink (glass burst, debris, sparks); P5 FX replaces the P4 minimal one. */
  onFx: ((fx: DamageFx) => void) | null;
  reset(): void;
  dispose(): void;
}
export type CreateVehicleDamage = (compiled: CompiledVehicle, binding: BindingSet, def: VehicleVisualDef) => VehicleDamage;

// ====================================================================== assembly (A2 index.ts)
export interface VehicleVisual {
  /** Add to the scene. */
  readonly object: Object3D;
  readonly binding: BindingSet;
  readonly skin: FlexSkin;
  readonly wheels: WheelVisuals;
  readonly materials: VehicleMaterialSet;
  readonly damage: VehicleDamage;
  /** damage.update → skin.update → wheels.update → materials.setLights (from telemetry). */
  update(frame: VehicleFrameInput): void;
  /** Event fan-out (app filters by objectId). */
  onImpact(e: Readonly<ImpactEvent>): void;
  onBeamBreak(e: Readonly<BeamBreakEvent>): void;
  onSkid(e: Readonly<SkidEvent>): void;
  setPaint(paint: PaintDef): void;
  dispose(): void;
}
export type CreateVehicleVisual = (
  ctx: RenderContext,
  compiled: CompiledVehicle,
  def: VehicleVisualDef,
  opts: { lighting: LightingStack; patchMaterial: PatchMaterial },
) => VehicleVisual;
