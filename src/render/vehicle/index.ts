/**
 * Vehicle visual assembly (A2): tessellate → bind → materials → damage →
 * flex skin → wheels → damage FX, behind one `update(frame)` per frame.
 * Contract: ./types.ts "assembly"; frame order inside update():
 *   damage.update → skin.update (one node-texture upload) → wheels.update
 *   → materials.setLights → fx.update.
 *
 * `object` is an identity Group in world space: the skin root sits at the
 * anchor (skin space), the wheels and FX manage their own transforms.
 */
import { Group } from 'three';

import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { LightingStack, PatchMaterial, RenderContext } from '../types';
import { bindPanels } from './binder';
import { createVehicleDamage } from './damage';
import { createFlexSkin } from './flexskin';
import { tessellateVehicle } from './loft';
import { createLightState, createVehicleMaterials, lightStateFromTelemetry } from './materials';
import { createDamageFx, type DamageFxSystem } from './shatter';
import {
  BindError,
  type BindingSet,
  type LightState,
  type PanelDef,
  type PanelGeometry,
  type PaintDef,
  type VehicleFrameInput,
  type VehicleVisual,
  type VehicleVisualDef,
} from './types';
import { createWheelVisuals } from './wheels';

/** What the B key cycles through: the body alone, body + strain wireframe, wireframe only, nodes only. */
export type VehicleDebugView = 'body' | 'body+beams' | 'beams' | 'nodes';
export const VEHICLE_DEBUG_VIEWS: readonly VehicleDebugView[] = ['body', 'body+beams', 'beams', 'nodes'];

export interface VehicleVisualOptions {
  lighting: LightingStack;
  patchMaterial: PatchMaterial;
  /** Pre-tessellated panels (tests, synthetic subjects); default tessellateVehicle(def). */
  geoms?: readonly PanelGeometry[];
  /** Terrain height for debris/glass shards to land on (null = no ground). */
  groundAt?: ((x: number, z: number) => number) | null;
  /** Damage FX (glass shards, debris) — default true. */
  fx?: boolean;
}

export interface VehicleVisualHandle extends VehicleVisual {
  readonly fx: DamageFxSystem | null;
  /** Bake timings, ms (tessellate, bind, total incl. GPU resource creation). */
  readonly timings: { tessellateMs: number; bindMs: number; totalMs: number };
  /** Body (skin + wheels) visible for 'body' / 'body+beams'. The caller drives the beam view. */
  setDebugView(view: VehicleDebugView): void;
  readonly debugView: VehicleDebugView;
}

export function bodyVisibleIn(view: VehicleDebugView): boolean {
  return view === 'body' || view === 'body+beams';
}

/**
 * bindPanels, but a panel that cannot bind (BindError) is dropped with a
 * warning instead of losing the whole body; the returned def lists only the
 * bound panels (panelIndex stays consistent for damage / FX). Other errors
 * (name mismatch, malformed input) still throw.
 */
export function bindTolerant(
  compiled: CompiledVehicle,
  def: VehicleVisualDef,
  geoms: readonly PanelGeometry[],
): { binding: BindingSet; def: VehicleVisualDef; dropped: string[] } {
  try {
    return { binding: bindPanels(compiled, def, geoms), def, dropped: [] };
  } catch (e) {
    if (!(e instanceof BindError) || geoms.length !== def.panels.length) throw e;
  }
  const keepPanels: PanelDef[] = [];
  const keepGeoms: PanelGeometry[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < def.panels.length; i++) {
    const panel = def.panels[i]!;
    const geom = geoms[i]!;
    try {
      bindPanels(compiled, { ...def, panels: [panel] }, [geom]);
      keepPanels.push(panel);
      keepGeoms.push(geom);
    } catch (e) {
      if (!(e instanceof BindError)) throw e;
      dropped.push(panel.id);
      console.warn(`[vehicle] ${compiled.name}: panel '${panel.id}' dropped: ${e.message}`);
    }
  }
  const kept: VehicleVisualDef = { ...def, panels: keepPanels };
  return { binding: bindPanels(compiled, kept, keepGeoms), def: kept, dropped };
}

export function createVehicleVisual(
  ctx: RenderContext,
  compiled: CompiledVehicle,
  def: VehicleVisualDef,
  opts: VehicleVisualOptions,
): VehicleVisualHandle {
  const t0 = performance.now();
  const allGeoms = opts.geoms ?? tessellateVehicle(def);
  const t1 = performance.now();
  const { binding, def: boundDef } = bindTolerant(compiled, def, allGeoms);
  def = boundDef;
  const t2 = performance.now();
  const materials = createVehicleMaterials(ctx, def);
  const damage = createVehicleDamage(compiled, binding, def);
  const skin = createFlexSkin(binding, {
    materials,
    damage,
    lighting: opts.lighting,
    patchMaterial: opts.patchMaterial,
    anchorNode: compiled.frameNodes[0] ?? 0,
  });
  const wheels = createWheelVisuals(compiled, def.wheels, {
    materials,
    lighting: opts.lighting,
    patchMaterial: opts.patchMaterial,
  });
  const fx =
    opts.fx === false
      ? null
      : createDamageFx({ binding, def, damage, velocity: (out) => damage.velocity(out), groundAt: opts.groundAt ?? null });

  const object = new Group();
  object.name = `vehicleVisual:${compiled.name}`;
  object.add(skin.object, wheels.object);
  if (fx) object.add(fx.object);

  const lights: LightState = createLightState();
  const game = { head: true };
  let view: VehicleDebugView = 'body';
  let lastEpoch = -1;

  const handle: VehicleVisualHandle = {
    object,
    binding,
    skin,
    wheels,
    materials,
    damage,
    fx,
    timings: { tessellateMs: t1 - t0, bindMs: t2 - t1, totalMs: performance.now() - t0 },
    get debugView(): VehicleDebugView {
      return view;
    },
    update(frame: VehicleFrameInput): void {
      if (frame.repairEpoch !== lastEpoch) {
        if (lastEpoch >= 0) fx?.clear();
        lastEpoch = frame.repairEpoch;
      }
      damage.update(frame, skin);
      skin.update(frame);
      wheels.update(skin, frame.dtS);
      materials.setLights(lightStateFromTelemetry(frame.telemetry, lights, game));
      fx?.update(frame.dtS);
    },
    onImpact: (e) => damage.onImpact(e),
    onBeamBreak: (e) => damage.onBeamBreak(e),
    onSkid: (e) => damage.onSkid(e),
    setPaint(paint: PaintDef): void {
      materials.setPaint(paint);
    },
    setDebugView(v: VehicleDebugView): void {
      view = v;
      const body = bodyVisibleIn(v);
      skin.object.visible = body;
      wheels.object.visible = body;
    },
    dispose(): void {
      object.removeFromParent();
      fx?.dispose();
      wheels.dispose();
      skin.dispose();
      damage.dispose();
      materials.dispose();
    },
  };
  return handle;
}
