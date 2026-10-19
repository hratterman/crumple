/**
 * Catalog entry: the "Vortex RS" sports coupe (owner: F1). Card numbers are
 * the BUILT vehicle's: mass / power / torque from the defs, 0–100 from the
 * handling harness (src/sim/vehicle/coupe.test.ts prints it) and top speed
 * from a long full-throttle run (it settles at ≈ 285 km/h).
 */
import { metallicPaint, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

export const COUPE_ENTRY: VehicleCatalogEntry = {
  id: 'coupe',
  available: true,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Vortex RS',
    class: 'Sports coupe',
    blurb: 'Twin-turbo V8, rear-drive, short wheelbase: quick to turn, quicker to bite.',
    engine: '4.0 L twin-turbo V8',
    gearbox: '7-speed automatic',
    drivetrain: 'RWD',
    powerKw: 300,
    torqueNm: 520,
    massKg: 1300,
    topSpeedKmh: 285,
    zeroTo100S: 4.5,
    ratings: { speed: 5, handling: 5, toughness: 2 },
  },
  palettes: [
    { id: 'velocityYellow', name: 'Velocity Yellow', paint: { ...solidPaint(0xf2b705, 0.3, 1), pearl: 0.15 } },
    { id: 'lavaOrange', name: 'Lava Orange', paint: metallicPaint(0xe2531b, 0.55, 0.5, 0.1) },
    { id: 'rosso', name: 'Rosso', paint: solidPaint(0xb5121b, 0.32, 1) },
    { id: 'electricBlue', name: 'Electric Blue', paint: metallicPaint(0x1a5fd6, 0.7, 0.7, 0.15) },
    { id: 'arcticWhite', name: 'Arctic White', paint: { ...solidPaint(0xf0f0ec, 0.3, 1), pearl: 0.25 } },
    { id: 'carbonBlack', name: 'Carbon Black', paint: metallicPaint(0x0a0a0c, 0.55, 0.45) },
  ],
  beamBudget: 3000,
  chase: { distance: 5.3, height: 1.7 },
  extent: { min: [-1.0, 0, -2.21], max: [1.0, 1.26, 2.25] },
  load: async () => {
    const [{ COUPE }, { COUPE_VISUAL }] = await Promise.all([import('../../sim/vehicle/defs/coupe'), import('../../render/vehicle/defs/coupe')]);
    return { sim: COUPE, visual: COUPE_VISUAL };
  },
};
