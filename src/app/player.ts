/**
 * The player's vehicle (P6 S1, docs/CONTRACTS.md "Showroom + vehicle
 * select"): which catalog vehicle + palette the player drives (persisted),
 * its loaded assets (sim def, visual def, the compiled rig main renders),
 * and the live visual fed from the interpolated nodes each frame.
 *
 * Choice persistence: localStorage[VEHICLE_CHOICE_KEY] = {id, palette}, read
 * at boot before the first spawn, written on every confirmed choice; unknown
 * or unavailable ids fall back to the sedan, unknown palettes to
 * palettes[0]; storage errors are ignored. `?vehicle=<id>` (and
 * `?paint=<palette id>`) override it for tests and are not persisted.
 *
 * Swapping is despawn + spawn of the same objectId (traffic keeps its focus):
 * the new visual is built and its programs compiled BEFORE the old car
 * disappears, then the old visual is disposed (GPU resources, shadow-LOD
 * hooks) so repeated swaps never leak.
 */
import type { Camera, Object3D } from 'three';

import {
  DEFAULT_VEHICLE_ID,
  getVehicleEntry,
  isVehicleId,
  paletteOf,
  PLAYER_VEHICLE_IDS,
  VEHICLE_CHOICE_KEY,
  type PaintPalette,
  type VehicleCatalogEntry,
  type VehicleChoice,
} from '../game/catalog';
import { createVehicleTelemetryFrame } from '../protocol/telemetry';
import type { PatchMaterial, LightingStack, RenderContext } from '../render/types';
import { createVehicleVisual, type VehicleVisualHandle } from '../render/vehicle/index';
import type { PaintDef, VehicleFrameInput, VehicleVisualDef } from '../render/vehicle/types';
import { compileVehicle } from '../sim/vehicle/builder';
import type { CompiledVehicle, VehicleDef } from '../sim/vehicle/types';
import type { StorageLike } from './quality';
import { unitsPerKmh, type SpeedUnits } from './settings';
import type { RestPose } from './spawn';

// ------------------------------------------------------------ choice (pure)
function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A drivable entry for `id` (available + selectable), else the default vehicle's. */
export function drivableEntry(id: unknown): VehicleCatalogEntry {
  if (isVehicleId(id)) {
    const e = getVehicleEntry(id);
    if (e.available && e.selectable && PLAYER_VEHICLE_IDS.includes(e.id)) return e;
  }
  return getVehicleEntry(DEFAULT_VEHICLE_ID);
}

/** Validates a raw choice: unknown/unavailable → default vehicle, unknown palette → palettes[0]. */
export function sanitizeChoice(raw: unknown): VehicleChoice {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const entry = drivableEntry(o.id);
  const palette = paletteOf(entry, typeof o.palette === 'string' ? o.palette : null);
  return { id: entry.id, palette: palette.id };
}

/** True when a choice was stored before (a returning player). */
export function hasStoredChoice(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return !!storage?.getItem(VEHICLE_CHOICE_KEY);
  } catch {
    return false;
  }
}

/** The boot choice: `?vehicle=` / `?paint=` override, else storage, else the default. */
export function loadVehicleChoice(search = '', storage: StorageLike | null = defaultStorage()): VehicleChoice {
  let raw: unknown = null;
  try {
    const s = storage?.getItem(VEHICLE_CHOICE_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  const params = new URLSearchParams(search);
  const v = params.get('vehicle');
  const p = params.get('paint');
  if (v || p) {
    const base = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = v ?? base.id;
    raw = { id, palette: p ?? (id === base.id ? base.palette : null) };
  }
  return sanitizeChoice(raw);
}

export function saveVehicleChoice(choice: VehicleChoice, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(VEHICLE_CHOICE_KEY, JSON.stringify(sanitizeChoice(choice)));
  } catch {
    // storage blocked: the choice lasts this session
  }
}

// ------------------------------------------------------------ per-vehicle HUD / camera facts (pure)
/**
 * Speedometer full scale in DISPLAY units: ≥ topSpeed + 20 % (contract),
 * rounded up to a multiple of 20 (≤ 160) or 40 (above) so the last major
 * tick is labelled; at least 120 km/h / 80 mph.
 */
export function speedoMax(topSpeedKmh: number, units: SpeedUnits): number {
  const want = Math.max(topSpeedKmh, 1) * 1.2 * unitsPerKmh(units);
  const step = want <= 160 ? 20 : 40;
  return Math.max(units === 'mph' ? 80 : 120, Math.ceil(want / step) * step);
}

export interface ChaseFramingOut {
  distance: number;
  height: number;
}

/** Catalog framing × the settings' near/normal/far scale. */
export function chaseFramingFor(entry: VehicleCatalogEntry, scale: number): ChaseFramingOut {
  return { distance: entry.chase.distance * scale, height: entry.chase.height * scale };
}

// ------------------------------------------------------------ assets
export interface PlayerAssets {
  entry: VehicleCatalogEntry;
  sim: VehicleDef;
  visual: VehicleVisualDef;
  /** What the worker compiles (canonical order; triads, FX and placement index into it). */
  compiled: CompiledVehicle;
  /** compiled.rig as a RestPose (spawn placement). */
  rest: RestPose;
}

const assetCache = new Map<string, Promise<PlayerAssets>>();

/** Loads (dynamic import) and compiles a catalog vehicle once per page; rejects for unbuilt entries. */
export function loadPlayerAssets(entry: VehicleCatalogEntry): Promise<PlayerAssets> {
  let p = assetCache.get(entry.id);
  if (!p) {
    p = entry.load().then(({ sim, visual }) => {
      const compiled = compileVehicle(sim);
      return { entry, sim, visual, compiled, rest: compiled.rig };
    });
    // A failed load (network hiccup on a lazy chunk) may be retried later.
    p.catch(() => assetCache.delete(entry.id));
    assetCache.set(entry.id, p);
  }
  return p;
}

// ------------------------------------------------------------ live player visual
export interface PlayerVisualDeps {
  ctx: RenderContext;
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  groundAt: (x: number, z: number) => number;
}

/** Node/visual state of the player car (one per spawned vehicle; dispose on swap). */
export class PlayerVehicle {
  readonly assets: PlayerAssets;
  readonly palette: PaintPalette;
  /** null when the body failed to build (the beam wireframe shows instead) or ?body=0. */
  readonly visual: VehicleVisualHandle | null;
  readonly broken: Uint8Array;
  private readonly telemetry = createVehicleTelemetryFrame();
  private brokenTick = -1;
  private readonly frame: VehicleFrameInput;
  /** R-GFX: the player's lamp switches (headlights / high beam) merged over the telemetry lamps each frame. */
  readonly lamps: { head: boolean; highBeam: boolean } = { head: true, highBeam: false };

  constructor(assets: PlayerAssets, paletteId: string | null, deps: PlayerVisualDeps | null) {
    this.assets = assets;
    this.palette = paletteOf(assets.entry, paletteId);
    this.broken = new Uint8Array(assets.compiled.rig.beamCount);
    this.frame = { nodes: new Float32Array(0), nodeOffset: 0, tick: 0, broken: this.broken, repairEpoch: 0, telemetry: null, dtS: 0 };
    let visual: VehicleVisualHandle | null = null;
    if (deps) {
      try {
        visual = createVehicleVisual(deps.ctx, assets.compiled, assets.visual, {
          lighting: deps.lighting,
          patchMaterial: deps.patchMaterial,
          groundAt: deps.groundAt,
        });
        visual.object.visible = false;
        visual.setPaint(this.palette.paint);
      } catch (e) {
        console.error(`[vehicle] ${assets.entry.id} body failed; showing the beam wireframe`, e);
        visual = null;
      }
    }
    this.visual = visual;
  }

  get id(): string {
    return this.assets.entry.id;
  }
  get nodeCount(): number {
    return this.assets.compiled.rig.nodeCount;
  }
  get object(): Object3D | null {
    return this.visual ? this.visual.object : null;
  }

  setPaint(paint: PaintDef): void {
    this.visual?.setPaint(paint);
  }

  /**
   * Feeds this frame's interpolated nodes; `range` null (object absent or
   * another rig in the slot, e.g. right after a swap) hides the body.
   */
  update(
    source: {
      latestTick: number;
      brokenBeams(id: number, out: Uint8Array): number;
      repairEpoch(id: number): number;
      readTelemetry(id: number, out: ReturnType<typeof createVehicleTelemetryFrame>): boolean;
    },
    objectId: number,
    range: { nodeOffset: number; nodeCount: number } | null,
    positions: Float32Array,
    dt: number,
    camera: Camera,
  ): void {
    const v = this.visual;
    if (!v) return;
    const ok = !!range && range.nodeCount === this.nodeCount;
    v.object.visible = ok;
    if (!ok) return;
    const tick = source.latestTick;
    if (tick !== this.brokenTick) {
      this.brokenTick = tick;
      if (source.brokenBeams(objectId, this.broken) < 0) this.broken.fill(0);
    }
    const f = this.frame;
    f.nodes = positions;
    f.nodeOffset = range.nodeOffset;
    f.tick = tick;
    f.repairEpoch = source.repairEpoch(objectId);
    f.telemetry = source.readTelemetry(objectId, this.telemetry) ? this.telemetry : null;
    f.dtS = dt;
    f.camera = camera;
    f.lights = this.lamps;
    v.update(f);
  }

  dispose(): void {
    this.visual?.dispose();
  }
}
