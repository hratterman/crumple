/**
 * R-RIG render side: re-points a standard VehicleVisualDef at a
 * high-density rig (src/sim/rig/gen). The HD rig keeps every standard node
 * id, so panels that have no sheet of their own (glass, seals, lamps, trim,
 * interior, underbody) bind exactly as before; every panel that was sampled
 * into a sheet binds to ITS OWN sheet nodes (`k_<panel>_*`: they lie on the
 * render surface, so the triads are near-coplanar with the vertices), and
 * small parts mounted on a sheet (handles, fuel door, fascia grilles, plates)
 * follow that sheet. A sheet joined to the structure by tearable seams gets
 * a `follow`-mode detach on those seams (boundary beams of its bind set), so
 * damage reports it once most seams have let go.
 */
import type { PanelDef, VehicleVisualDef } from '../../types';

export interface RepointOptions {
  /** Variant VehicleDef name (VehicleVisualDef.vehicle must equal it). */
  vehicle: string;
  /** Render panel id → its sheet's node ids (RefinedVehicle.skinNodes). */
  skins: Readonly<Record<string, readonly string[]>>;
  /** Small parts carried by a sheet: render panel id → the sheet's panel id. */
  mounted?: Readonly<Record<string, string>>;
  /** Seams broken (fraction) before a sheet reports detached. Default 0.6. */
  detachFraction?: number;
}

export function sheetGlob(panelId: string): string {
  return `k_${panelId}_*`;
}

export function repointToSkins(def: VehicleVisualDef, o: RepointOptions): VehicleVisualDef {
  const frac = o.detachFraction ?? 0.6;
  const panels = def.panels.map((p): PanelDef => {
    if (o.skins[p.id]) {
      return { ...p, bind: [sheetGlob(p.id)], detach: p.detach && p.detach.attach !== 'boundary' ? p.detach : { attach: 'boundary', minBrokenFraction: p.detach?.minBrokenFraction ?? frac, mode: p.detach?.mode ?? 'follow' } };
    }
    const host = o.mounted?.[p.id];
    if (host && o.skins[host]) {
      const detach = p.detach && p.detach.attach === 'boundary' ? p.detach : p.detach ?? null;
      return { ...p, bind: [sheetGlob(host)], detach };
    }
    return p;
  });
  return { ...def, vehicle: o.vehicle, panels };
}
