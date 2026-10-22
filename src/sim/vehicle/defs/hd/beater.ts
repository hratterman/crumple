/**
 * BEATER high-density variants (R-RIG): the standard BEATER as the backbone, every exterior panel a sampled sheet
 * (skins/beater.<tier>.ts). A 1990s compact: 0.8 mm mild-steel panels (DC04), thicker PP bumpers; the weakened
 * structure is the backbone's (it folds like paper).
 * PURE DATA MODULE, generated on first use.
 */
import type { SkinPanelData, SkinSpec } from '../../../rig/gen/types';
import { SHELL_RELEASE_CRUMPLE } from '../../shellDefs';
import { BEATER, BEATER_CRASH_PROBES } from '../beater';
import { defaultSkinSpec, hdVariants, stationMembers, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/beater.high';
import { SKINS as ULTRA } from './skins/beater.ultra';

export function beaterSkinSpec(p: SkinPanelData): SkinSpec | null {
  if (p.kind === 'bumper') return { panel: p.id, grade: 'PP_EPDM', gauge: 0.0035, seam: 'bolt', standoff: 0.2 };
  return defaultSkinSpec(p, { grade: 'DC04', gauge: 0.0008 });
}

export const BEATER_HD_CONFIG: HdCarConfig = {
  car: 'beater',
  base: BEATER,
  probes: BEATER_CRASH_PROBES,
  skins: { high: HIGH, ultra: ULTRA },
  skinSpec: beaterSkinSpec,
  // its sheets let go on impact and buckle with the (whole-release) shell instead of stiffening it: the 30 km/h
  // crush stays ≥ 1.5× the sedan's (38.5 cm with the zone's own thresholds, 42 on the standard beater)
  wholeZoneSheetRelease: SHELL_RELEASE_CRUMPLE,
  members: (tier) => stationMembers(tier, { frontRail: [1, 2, 3, 4], rearRail: [10, 11, 12], rearBumper: 13, grade: 'S235', gauge: 0.0016 }),
  detachable: ['hood', 'bumperF', 'bumperR', 'trunk'],
};

const HD = hdVariants(BEATER_HD_CONFIG);
export const beaterHD = HD.raw;
export const beaterVariant = HD.variant;
export const BEATER_HD_CRASH_PROBES = HD.probes;
