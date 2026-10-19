/**
 * Catalog entry: derby beater (owner: F4). Stats = P6 targets until F4
 * lands (see coupe.ts). Palettes are the faded single-stage base colour;
 * the mismatched doors / primer / rust are per-panel `PanelFinish` in the
 * visual def and survive palette swaps.
 */
import { notYetBuilt, type VehicleCatalogEntry } from '../catalogTypes';
import type { PaintDef } from '../../render/vehicle/types';

const faded = (color: number): PaintDef => ({ color, metallic: 0, roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.4, flake: null });

export const BEATER_ENTRY: VehicleCatalogEntry = {
  id: 'beater',
  available: false,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Junker 1.6',
    class: 'Derby beater',
    blurb: 'Thirty winters, four owners, one working wing mirror. Folds like paper.',
    engine: '1.6 L inline-4',
    gearbox: '4-speed automatic',
    drivetrain: 'FWD',
    powerKw: 75,
    torqueNm: 140,
    massKg: 1050,
    topSpeedKmh: 165,
    zeroTo100S: 12.5,
    ratings: { speed: 1, handling: 2, toughness: 1 },
  },
  palettes: [
    { id: 'fadedTeal', name: 'Faded Teal', paint: faded(0x3f7f7a) },
    { id: 'maroon', name: 'Tired Maroon', paint: faded(0x5a1f22) },
    { id: 'beige', name: 'Nicotine Beige', paint: faded(0xb9ab8a) },
    { id: 'babyBlue', name: 'Chalky Blue', paint: faded(0x7d9cb8) },
    { id: 'olive', name: 'Army Surplus', paint: faded(0x6b6a3a) },
    { id: 'white', name: 'Once White', paint: faded(0xd9d6cc) },
  ],
  beamBudget: 2600,
  chase: { distance: 5.2, height: 1.8 },
  extent: { min: [-0.9, 0, -2.1], max: [0.9, 1.45, 2.1] },
  load: notYetBuilt('beater'),
};
