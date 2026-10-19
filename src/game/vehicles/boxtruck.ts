/**
 * Catalog entry: medium box truck (owner: F3). Card numbers are the built
 * truck's (src/sim/vehicle/boxtruck.test.ts: 0–80 ≈ 16.5 s, governed at
 * ≈ 108 km/h in 6th; mass / power / torque checked by catalog.test.ts).
 */
import { metallicPaint, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

/** Cab palettes only: the box panels carry their own `PanelFinish.color` (white) under any palette. */
export const BOXTRUCK_ENTRY: VehicleCatalogEntry = {
  id: 'boxtruck',
  available: true,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Haulmaster 6500',
    class: 'Medium box truck',
    blurb: 'Six and a half tonnes, dual rear wheels and a tall box: brake early, corner gently, or lie down.',
    engine: '6.7 L turbo-diesel inline-6',
    gearbox: '6-speed automatic',
    drivetrain: 'RWD',
    powerKw: 180,
    torqueNm: 900,
    massKg: 6500,
    topSpeedKmh: 108,
    zeroTo100S: null,
    ratings: { speed: 1, handling: 1, toughness: 5 },
  },
  palettes: [
    // palettes[0] = BOXTRUCK_VISUAL.paint (src/render/vehicle/defs/boxtruck.ts BOXTRUCK_PAINT).
    { id: 'fleetWhite', name: 'Fleet White', paint: solidPaint(0xeeeeea, 0.42, 0.8) },
    { id: 'haulageYellow', name: 'Haulage Yellow', paint: solidPaint(0xe8b417, 0.4, 0.8) },
    { id: 'postalRed', name: 'Postal Red', paint: solidPaint(0xb01f1a, 0.4, 0.8) },
    { id: 'utilityOrange', name: 'Utility Orange', paint: solidPaint(0xe0621c, 0.42, 0.8) },
    { id: 'navy', name: 'Navy', paint: metallicPaint(0x1f2f55, 0.5, 0.35) },
    { id: 'depotGreen', name: 'Depot Green', paint: solidPaint(0x2f5b33, 0.45, 0.8) },
  ],
  beamBudget: 3500,
  chase: { distance: 9.5, height: 3.4 },
  extent: { min: [-1.45, 0, -3.8], max: [1.45, 3.42, 3.8] },
  load: async () => {
    const [{ BOXTRUCK }, { BOXTRUCK_VISUAL }] = await Promise.all([import('../../sim/vehicle/defs/boxtruck'), import('../../render/vehicle/defs/boxtruck')]);
    return { sim: BOXTRUCK, visual: BOXTRUCK_VISUAL };
  },
};
