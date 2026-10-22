/**
 * PICKUP high-density variants (R-RIG): the standard body-on-frame PICKUP as the backbone (ladder frame, cab, bed
 * sub-rigs and their breakable mounts unchanged), every exterior panel a sampled sheet (skins/pickup.<tier>.ts):
 * 0.8 mm cab steel, 0.9 mm bed sides, 3 mm PP fascia.
 * PURE DATA MODULE, generated on first use.
 */
import type { SkinPanelData, SkinSpec } from '../../../rig/gen/types';
import type { CrashProbes } from '../../crash';
import { PICKUP, PICKUP_CRASH_PROBES } from '../pickup';
import { defaultSkinSpec, hdVariants, shellDonorWeight, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/pickup.high';
import { SKINS as ULTRA } from './skins/pickup.ultra';

export function pickupSkinSpec(p: SkinPanelData): SkinSpec | null {
  if (p.id.startsWith('bedSide') || p.id === 'bedFront' || p.id === 'tailgate') return { panel: p.id, grade: 'DC04', gauge: 0.0009, seam: p.id === 'tailgate' ? 'hem' : 'weld', standoff: 0.3 };
  return defaultSkinSpec(p, { grade: 'BH220', gauge: 0.0008 });
}

const SHELL_W = shellDonorWeight(PICKUP);
/**
 * Mass donors: the crew cab (`c{i}_*`, the safety cell) gives little (0.1): with the default weights the cab's
 * hinge-pillar base swung past the pole plane ~1 s into the 30 km/h pole case; the bed, frame-free shell and
 * clip give the rest.
 */
export function pickupDonorWeight(id: string): number {
  return /^c\d+_/.test(id) ? Math.min(0.1, SHELL_W(id)) : SHELL_W(id);
}

export const PICKUP_HD_CONFIG: HdCarConfig = {
  car: 'pickup',
  base: PICKUP,
  probes: PICKUP_CRASH_PROBES as unknown as CrashProbes,
  skins: { high: HIGH, ultra: ULTRA },
  skinSpec: pickupSkinSpec,
  donorWeight: pickupDonorWeight,
  detachable: ['hood', 'fascia', 'tailgate'],
};

const HD = hdVariants(PICKUP_HD_CONFIG);
export const pickupHD = HD.raw;
export const pickupVariant = HD.variant;
export const PICKUP_HD_CRASH_PROBES = HD.probes;
