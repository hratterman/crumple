/**
 * Catalog entry: the TRAFFIC sedan (owner: T1 — sim rig `SEDAN_TRAFFIC` in
 * src/sim/vehicle/defs/sedanTraffic.ts, ≤ 1500 beams; T2 — its visual
 * binding). Not selectable. `available` flips to true when T1 lands the rig
 * and T2 the visual (load() must then resolve).
 */
import { metallicPaint, notYetBuilt, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

export const SEDAN_TRAFFIC_ENTRY: VehicleCatalogEntry = {
  id: 'sedanTraffic',
  available: false,
  selectable: false,
  trafficEligible: true,
  stats: {
    name: 'Vela',
    class: 'Commuter sedan (traffic)',
    blurb: 'Everybody else on the road.',
    engine: '3.0 L inline-6',
    gearbox: '6-speed automatic',
    drivetrain: 'RWD',
    powerKw: 238,
    torqueNm: 350,
    massKg: 1450,
    topSpeedKmh: 210,
    zeroTo100S: null,
    ratings: { speed: 3, handling: 3, toughness: 2 },
  },
  // Everyday colours: traffic must read as "other cars", not as the player's showroom paint.
  palettes: [
    { id: 'silver', name: 'Silver', paint: metallicPaint(0xa9adb3, 0.85, 0.6) },
    { id: 'white', name: 'White', paint: solidPaint(0xe4e4df, 0.4, 0.9) },
    { id: 'black', name: 'Black', paint: metallicPaint(0x111216, 0.5, 0.4) },
    { id: 'graphite', name: 'Graphite', paint: metallicPaint(0x45484d, 0.7, 0.5) },
    { id: 'navy', name: 'Navy', paint: metallicPaint(0x1b2a47, 0.6, 0.5) },
    { id: 'red', name: 'Red', paint: solidPaint(0x9b1b1f, 0.4, 0.9) },
    { id: 'beige', name: 'Beige', paint: metallicPaint(0xb7a88a, 0.55, 0.4) },
    { id: 'teal', name: 'Teal', paint: metallicPaint(0x1f5a5c, 0.6, 0.5) },
  ],
  beamBudget: 1500,
  chase: { distance: 5.6, height: 1.9 },
  extent: { min: [-0.95, 0, -2.35], max: [0.95, 1.47, 2.45] },
  load: notYetBuilt('sedanTraffic'),
};
