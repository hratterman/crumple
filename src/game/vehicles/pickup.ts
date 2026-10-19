/**
 * Catalog entry: crew-cab pickup (owner: F2). Card numbers are the built
 * vehicle's (src/sim/vehicle/pickup.test.ts harness: 0–100 7.8 s, top speed
 * ≈ 182 km/h at the 6200 rpm limiter in 6th; mass / power / torque checked by
 * catalog.test.ts against the def).
 */
import { metallicPaint, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

export const PICKUP_ENTRY: VehicleCatalogEntry = {
  id: 'pickup',
  available: true,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Brute 5.0',
    class: 'Crew-cab pickup',
    blurb: 'Body-on-frame, a live rear axle, a big V8 and a bed for whatever falls off. The cab and bed can tear off the frame.',
    engine: '5.0 L V8',
    gearbox: '6-speed automatic',
    drivetrain: 'RWD',
    powerKw: 295,
    torqueNm: 550,
    massKg: 2100,
    topSpeedKmh: 182,
    zeroTo100S: 7.8,
    ratings: { speed: 3, handling: 2, toughness: 4 },
  },
  palettes: [
    // palettes[0] = PICKUP_VISUAL.paint (src/render/vehicle/defs/pickup.ts PICKUP_PAINT).
    { id: 'oxfordWhite', name: 'Oxford White', paint: solidPaint(0xe6e6e1, 0.4, 0.9) },
    { id: 'shadowBlack', name: 'Shadow Black', paint: metallicPaint(0x0e0f12, 0.5, 0.4) },
    { id: 'forestGreen', name: 'Forest Green', paint: metallicPaint(0x2b4a2f, 0.6, 0.5) },
    { id: 'desertTan', name: 'Desert Tan', paint: metallicPaint(0xb59b74, 0.45, 0.35) },
    { id: 'brickRed', name: 'Brick Red', paint: metallicPaint(0x7a1f19, 0.55, 0.45) },
    { id: 'glacierBlue', name: 'Glacier Blue', paint: metallicPaint(0x5c7fa3, 0.7, 0.55) },
  ],
  beamBudget: 3500,
  chase: { distance: 6.8, height: 2.4 },
  extent: { min: [-1.05, 0, -2.95], max: [1.05, 1.95, 3.31] },
  load: async () => {
    const [{ PICKUP }, { PICKUP_VISUAL }] = await Promise.all([import('../../sim/vehicle/defs/pickup'), import('../../render/vehicle/defs/pickup')]);
    return { sim: PICKUP, visual: PICKUP_VISUAL };
  },
};
