/** Catalog entry: crew-cab pickup (owner: F2). Stats = P6 targets until F2 lands (see coupe.ts). */
import { metallicPaint, notYetBuilt, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

export const PICKUP_ENTRY: VehicleCatalogEntry = {
  id: 'pickup',
  available: false,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Brute 5.0',
    class: 'Crew-cab pickup',
    blurb: 'Body-on-frame, leaf-sprung live axle, a big V8 and a bed for whatever falls off.',
    engine: '5.0 L V8',
    gearbox: '6-speed automatic',
    drivetrain: 'RWD',
    powerKw: 295,
    torqueNm: 550,
    massKg: 2100,
    topSpeedKmh: 185,
    zeroTo100S: 7.0,
    ratings: { speed: 3, handling: 2, toughness: 4 },
  },
  palettes: [
    { id: 'oxfordWhite', name: 'Oxford White', paint: solidPaint(0xe6e6e1, 0.4, 0.9) },
    { id: 'shadowBlack', name: 'Shadow Black', paint: metallicPaint(0x0e0f12, 0.5, 0.4) },
    { id: 'forestGreen', name: 'Forest Green', paint: metallicPaint(0x2b4a2f, 0.6, 0.5) },
    { id: 'desertTan', name: 'Desert Tan', paint: metallicPaint(0xb59b74, 0.45, 0.35) },
    { id: 'brickRed', name: 'Brick Red', paint: metallicPaint(0x7a1f19, 0.55, 0.45) },
    { id: 'glacierBlue', name: 'Glacier Blue', paint: metallicPaint(0x5c7fa3, 0.7, 0.55) },
  ],
  beamBudget: 3500,
  chase: { distance: 6.6, height: 2.3 },
  extent: { min: [-1.05, 0, -2.95], max: [1.05, 1.95, 2.95] },
  load: notYetBuilt('pickup'),
};
