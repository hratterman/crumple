/**
 * Per-surface physics + look table (layout v6, R-WORLD) — pure data shared by
 * the sim worker (R-PHYS applies it in the tyre / ground contact), FX, audio
 * and render. Indexed by MaterialId (src/protocol/messages.ts); only terrain
 * surfaces carry ground behaviour (object materials 6..10 are listed for
 * completeness with rolling / sinkage 0).
 *
 * FIELDS (docs/CONTRACTS.md "R-WORLD contracts" → surfaces):
 *  - friction:  contact μ multiplier (= src/sim/collision/materials.ts MATERIAL_FRICTION;
 *               the sim table is the authority, a test keeps both equal).
 *  - rolling:   rolling-resistance coefficient C_rr of a car tyre on it
 *               (F = C_rr · N against the wheel's rolling direction; asphalt 0.012,
 *               sand 0.15). Applied by R-PHYS as a drag torque on the wheel hub.
 *  - sinkage:   static sinkage of a loaded car tyre, m (the soft layer the tread
 *               sinks into before full support: the contact surface sits this
 *               much below the heightfield). 0 = rigid ground.
 *  - drag:      extra viscous resistance per tyre node in contact, N·s/m per kg
 *               of node mass at full sinkage (mud suction / sand plough).
 *  - soft:      FX / audio class: loose ground (dust, ruts, clods, rumble).
 *  - persistentRuts: ruts / tyre tracks stay drawn (render: rut decals persist).
 *  - wet:       visual wetness 0..1 (render: darker, glossier; puddles collect).
 */
import { MaterialId } from '../protocol/messages';

export interface SurfacePhysics {
  name: string;
  friction: number;
  rolling: number;
  sinkage: number;
  drag: number;
  soft: boolean;
  persistentRuts: boolean;
  wet: number;
}

const S = (
  name: string,
  friction: number,
  rolling: number,
  sinkage: number,
  drag: number,
  soft: boolean,
  persistentRuts: boolean,
  wet: number,
): SurfacePhysics => ({ name, friction, rolling, sinkage, drag, soft, persistentRuts, wet });

/** Indexed by MaterialId (dense, length MATERIAL_COUNT). */
export const SURFACE_PHYSICS: readonly SurfacePhysics[] = (() => {
  const t: SurfacePhysics[] = [];
  t[MaterialId.asphalt] = S('asphalt', 1.0, 0.012, 0, 0, false, false, 0);
  t[MaterialId.grass] = S('grass', 0.6, 0.06, 0.015, 0.4, true, true, 0);
  t[MaterialId.dirt] = S('dirt', 0.7, 0.05, 0.02, 0.5, true, true, 0.05);
  t[MaterialId.rock] = S('rock', 0.9, 0.02, 0, 0, false, false, 0);
  t[MaterialId.gravel] = S('gravel', 0.65, 0.04, 0.012, 0.6, true, false, 0);
  t[MaterialId.concrete] = S('concrete', 1.0, 0.011, 0, 0, false, false, 0);
  t[MaterialId.metal] = S('metal', 0.4, 0.01, 0, 0, false, false, 0);
  t[MaterialId.plastic] = S('plastic', 0.5, 0.015, 0, 0, false, false, 0);
  t[MaterialId.rubber] = S('rubber', 1.1, 0.02, 0, 0, false, false, 0);
  t[MaterialId.wood] = S('wood', 0.6, 0.015, 0, 0, false, false, 0);
  t[MaterialId.cardboard] = S('cardboard', 0.55, 0.03, 0, 0, false, false, 0);
  t[MaterialId.mud] = S('mud', 0.45, 0.2, 0.12, 3.0, true, true, 0.85);
  t[MaterialId.sand] = S('sand', 0.55, 0.15, 0.08, 2.0, true, true, 0);
  t[MaterialId.wetGrass] = S('wetGrass', 0.42, 0.07, 0.03, 0.8, true, true, 0.5);
  t[MaterialId.asphaltWorn] = S('asphaltWorn', 0.93, 0.014, 0, 0, false, false, 0);
  return t;
})();

/** Loose ground (FX dust / ruts / clods, audio rumble): grass, dirt, gravel, mud, sand, wet grass. */
export function isSoftSurface(id: number): boolean {
  return SURFACE_PHYSICS[id]?.soft ?? false;
}

/**
 * The P1 terrain material (0..6) a v6 surface behaves like for consumers keyed on the P1 set
 * (FX palettes / ground class, audio surface voice): mud → dirt, sand → gravel,
 * wetGrass → grass, asphaltWorn → asphalt; every other id maps to itself.
 */
export function baseSurface(id: number): number {
  switch (id) {
    case MaterialId.mud:
      return MaterialId.dirt;
    case MaterialId.sand:
      return MaterialId.gravel;
    case MaterialId.wetGrass:
      return MaterialId.grass;
    case MaterialId.asphaltWorn:
      return MaterialId.asphalt;
    default:
      return id;
  }
}
