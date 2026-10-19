/** Catalog entry: the P2–P5 sport sedan (owner: whoever owns the sedan defs; P6 S1 may tune card copy). */
import { metallicPaint, solidPaint, type VehicleCatalogEntry } from '../catalogTypes';

export const SEDAN_ENTRY: VehicleCatalogEntry = {
  id: 'sedan',
  available: true,
  selectable: true,
  trafficEligible: false,
  stats: {
    name: 'Vela GT',
    class: 'Sport sedan',
    blurb: 'The all-rounder: a straight-six, a limited-slip diff and a crumple zone that does its job.',
    engine: '3.0 L inline-6',
    gearbox: '6-speed automatic',
    drivetrain: 'RWD',
    powerKw: 238,
    torqueNm: 350,
    massKg: 1450,
    topSpeedKmh: 214,
    zeroTo100S: 6.8,
    ratings: { speed: 3, handling: 3, toughness: 3 },
  },
  palettes: [
    {
      id: 'abyssBlue',
      name: 'Abyss Blue',
      paint: { color: 0x1f4f9a, metallic: 0.7, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.025, flake: { density: 0.7, scale: 0.6, intensity: 0.7 }, pearl: 0.12 },
    },
    { id: 'crimson', name: 'Crimson', paint: metallicPaint(0x8e0f17, 0.6, 0.55) },
    { id: 'liquidSilver', name: 'Liquid Silver', paint: metallicPaint(0xb8bcc2, 0.9, 0.7) },
    { id: 'obsidian', name: 'Obsidian Black', paint: metallicPaint(0x0c0d10, 0.5, 0.5) },
    { id: 'alpineWhite', name: 'Alpine White', paint: solidPaint(0xe9e9e4, 0.36, 1) },
    { id: 'racingGreen', name: 'Racing Green', paint: metallicPaint(0x163d2a, 0.6, 0.5) },
  ],
  beamBudget: 3500,
  chase: { distance: 5.6, height: 1.9 },
  extent: { min: [-0.95, 0, -2.35], max: [0.95, 1.47, 2.45] },
  load: async () => {
    const [{ SEDAN }, { SEDAN_VISUAL }] = await Promise.all([import('../../sim/vehicle/defs/sedan'), import('../../render/vehicle/defs/sedan')]);
    return { sim: SEDAN, visual: SEDAN_VISUAL };
  },
};
