/** Catalog entry: medium box truck (owner: F3). Stats = P6 targets until F3 lands (see coupe.ts). */
import { metallicPaint, notYetBuilt, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

/** Cab palettes only: the box panels carry their own `PanelFinish.color` (white) under any palette. */
export const BOXTRUCK_ENTRY: VehicleCatalogEntry = {
  id: 'boxtruck',
  available: false,
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
    topSpeedKmh: 110,
    zeroTo100S: null,
    ratings: { speed: 1, handling: 1, toughness: 5 },
  },
  palettes: [
    { id: 'fleetWhite', name: 'Fleet White', paint: solidPaint(0xeeeeea, 0.42, 0.8) },
    { id: 'haulageYellow', name: 'Haulage Yellow', paint: solidPaint(0xe8b417, 0.4, 0.8) },
    { id: 'postalRed', name: 'Postal Red', paint: solidPaint(0xb01f1a, 0.4, 0.8) },
    { id: 'utilityOrange', name: 'Utility Orange', paint: solidPaint(0xe0621c, 0.42, 0.8) },
    { id: 'navy', name: 'Navy', paint: metallicPaint(0x1f2f55, 0.5, 0.35) },
    { id: 'depotGreen', name: 'Depot Green', paint: solidPaint(0x2f5b33, 0.45, 0.8) },
  ],
  beamBudget: 3500,
  chase: { distance: 9.5, height: 3.4 },
  extent: { min: [-1.25, 0, -3.8], max: [1.25, 3.4, 3.8] },
  load: notYetBuilt('boxtruck'),
};
