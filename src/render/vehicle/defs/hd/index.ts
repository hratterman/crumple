/**
 * R-RIG render side: the visual def per (car, physics quality). 'standard' is the car's own visual; an HD tier is
 * that visual (every LOD) re-pointed at the HD rig (repoint.ts): each exterior panel skins to its own sheet,
 * parts mounted on a sheet follow it, everything else binds to the backbone exactly as on the standard car. The
 * render-side extras (LOD1 / LOD2 builders, door-card followers, panel-finish extras) carry over.
 * Synchronous registry (tests, tools, lazily loaded game code).
 */
import { vehicleVariantSync } from '../../../../sim/vehicle/defs/hd/index';
import type { HdCar, HdTier } from '../../../../sim/vehicle/defs/hd/skinSources';
import type { PhysicsQuality } from '../../../../sim/vehicle/defs/hd/variants';
import { once, setVisualExtras, visualExtras } from '../../lods';
import type { VehicleVisualDef } from '../../types';
import { finishExtras, setFinishExtras } from '../../weathering';
import { BEATER_VISUAL, buildBeaterVisual } from '../beater';
import { BOXTRUCK_VISUAL, buildBoxtruckVisual } from '../boxtruck';
import { buildCoupeVisual, COUPE_VISUAL } from '../coupe';
import { buildPickupVisual, PICKUP_VISUAL } from '../pickup';
import { buildSedanVisual, SEDAN_VISUAL } from '../sedan';
import { repointToSkins } from './repoint';

interface Source {
  standard: VehicleVisualDef;
  build: (lod: 0 | 1 | 2) => VehicleVisualDef;
}

const SOURCES: Readonly<Record<HdCar, Source>> = {
  sedan: { standard: SEDAN_VISUAL, build: (lod) => buildSedanVisual({ lod }) },
  coupe: { standard: COUPE_VISUAL, build: (lod) => buildCoupeVisual({ lod }) },
  pickup: { standard: PICKUP_VISUAL, build: (lod) => buildPickupVisual({ lod }) },
  boxtruck: { standard: BOXTRUCK_VISUAL, build: (lod) => buildBoxtruckVisual({ lod }) },
  beater: { standard: BEATER_VISUAL, build: (lod) => buildBeaterVisual({ lod }) },
};

const cache = new Map<string, VehicleVisualDef>();

function hdVisual(car: HdCar, tier: HdTier): VehicleVisualDef {
  const key = `${car}.${tier}`;
  let v = cache.get(key);
  if (v) return v;
  const src = SOURCES[car];
  const variant = vehicleVariantSync(car, tier);
  const skins = variant.skinNodes ?? {};
  const at = (lod: 0 | 1 | 2): VehicleVisualDef => repointToSkins(lod === 0 ? src.standard : src.build(lod), { vehicle: variant.def.name, skins });
  v = at(0);
  const extras = visualExtras(src.standard);
  setVisualExtras(v, { ...extras, lods: [once(() => at(1)), once(() => at(2))] });
  const fin = finishExtras(src.standard);
  if (Object.keys(fin).length > 0) setFinishExtras(v, fin);
  cache.set(key, v);
  return v;
}

export function vehicleVisualSync(car: HdCar, quality: PhysicsQuality): VehicleVisualDef {
  return quality === 'standard' ? SOURCES[car].standard : hdVisual(car, quality);
}
