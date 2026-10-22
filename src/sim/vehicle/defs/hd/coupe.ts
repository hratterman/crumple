/**
 * COUPE high-density variants (R-RIG): the standard COUPE as the backbone, every exterior panel a sampled sheet
 * (skins/coupe.<tier>.ts). A sports coupe: aluminium hood, deck lid and doors (AL6016 1.0 mm), steel elsewhere.
 * PURE DATA MODULE, generated on first use.
 */
import type { SkinPanelData, SkinSpec } from '../../../rig/gen/types';
import { COUPE, COUPE_CRASH_PROBES } from '../coupe';
import { defaultSkinSpec, hdVariants, stationDonorWeight, stationMembers, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/coupe.high';
import { SKINS as ULTRA } from './skins/coupe.ultra';

export function coupeSkinSpec(p: SkinPanelData): SkinSpec | null {
  if (p.kind === 'hood' || p.kind === 'trunk' || p.kind === 'door') return { panel: p.id, grade: 'AL6016', gauge: 0.001, seam: 'hem', standoff: 0.3 };
  return defaultSkinSpec(p);
}

export const COUPE_HD_CONFIG: HdCarConfig = {
  car: 'coupe',
  base: COUPE,
  probes: COUPE_CRASH_PROBES,
  skins: { high: HIGH, ultra: ULTRA },
  skinSpec: coupeSkinSpec,
  donorWeight: stationDonorWeight(9),
  members: (tier) => stationMembers(tier, { frontRail: [1, 2, 3, 4], rearRail: [9, 10, 11], rearBumper: 12 }),
  detachable: ['hood', 'bumperF', 'bumperR', 'trunk'],
};

const HD = hdVariants(COUPE_HD_CONFIG);
export const coupeHD = HD.raw;
export const coupeVariant = HD.variant;
export const COUPE_HD_CRASH_PROBES = HD.probes;
