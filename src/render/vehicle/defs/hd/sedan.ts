/**
 * SEDAN high-density visuals (R-RIG): the player sedan's body
 * (buildSedanVisual, every LOD) re-pointed at sedanHD(tier): each exterior
 * panel skins to its own sheet, parts mounted on a sheet follow it, the rest
 * binds to the backbone exactly as on the standard car.
 */
import { sedanHD } from '../../../../sim/vehicle/defs/hd/sedan';
import type { HdTier } from '../../../../sim/vehicle/defs/hd/skinSources';
import { once, setVisualExtras } from '../../lods';
import type { VehicleVisualDef } from '../../types';
import { buildSedanVisual, SEDAN_FOLLOW } from '../sedan';
import { repointToSkins } from './repoint';

/** Parts carried by a sheet (render panel → sheet panel). */
export const SEDAN_MOUNTED: Readonly<Record<string, string>> = {
  fuelDoor: 'quarterR',
  handleRF: 'doorRF',
  handleRR: 'doorRR',
  handleLF: 'doorLF',
  handleLR: 'doorLR',
  grille: 'bumperF',
  intakeFins: 'bumperF',
  grilleSlats: 'bumperF',
  splitter: 'bumperF',
  indicatorFR: 'bumperF',
  indicatorFL: 'bumperF',
  bumperFSeal: 'bumperF',
  diffuser: 'bumperR',
  reverseLamps: 'bumperR',
  reflectors: 'bumperR',
  bumperRSeal: 'bumperR',
  plate: 'rearPanel',
  plateFrame: 'rearPanel',
  rearPanelSeal: 'rearPanel',
};

function build(tier: HdTier, lod: 0 | 1 | 2): VehicleVisualDef {
  const hd = sedanHD(tier);
  return repointToSkins(buildSedanVisual({ lod }), { vehicle: hd.def.name, skins: hd.skinNodes, mounted: SEDAN_MOUNTED });
}

const visuals = new Map<HdTier, VehicleVisualDef>();

/** The sedan's HD visual for a tier (LOD0; LOD1 / LOD2 + door-card followers registered). Memoized. */
export function sedanHDVisual(tier: HdTier): VehicleVisualDef {
  let v = visuals.get(tier);
  if (!v) {
    v = build(tier, 0);
    setVisualExtras(v, { lods: [once(() => build(tier, 1)), once(() => build(tier, 2))], follow: SEDAN_FOLLOW });
    visuals.set(tier, v);
  }
  return v;
}
