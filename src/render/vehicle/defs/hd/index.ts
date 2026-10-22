/**
 * R-RIG render side: visual def per (car, physics quality). The standard
 * tier is the car's own visual; HD tiers re-point it at the HD rig's sheets
 * (repoint.ts). Synchronous registry (tests, tools, lazily loaded game code).
 */
import type { HdCar } from '../../../../sim/vehicle/defs/hd/skinSources';
import type { PhysicsQuality } from '../../../../sim/vehicle/defs/hd/variants';
import type { VehicleVisualDef } from '../../types';
import { BEATER_VISUAL } from '../beater';
import { BOXTRUCK_VISUAL } from '../boxtruck';
import { COUPE_VISUAL } from '../coupe';
import { PICKUP_VISUAL } from '../pickup';
import { SEDAN_VISUAL } from '../sedan';
import { sedanHDVisual } from './sedan';

const STANDARD: Readonly<Record<HdCar, VehicleVisualDef>> = {
  sedan: SEDAN_VISUAL,
  coupe: COUPE_VISUAL,
  pickup: PICKUP_VISUAL,
  boxtruck: BOXTRUCK_VISUAL,
  beater: BEATER_VISUAL,
};

const HD: Partial<Record<HdCar, (t: 'high' | 'ultra') => VehicleVisualDef>> = {
  sedan: sedanHDVisual,
};

export function vehicleVisualSync(car: HdCar, quality: PhysicsQuality): VehicleVisualDef {
  if (quality === 'standard') return STANDARD[car];
  const f = HD[car];
  if (!f) throw new Error(`no ${quality} visual for ${car}`);
  return f(quality);
}
