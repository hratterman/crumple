/**
 * BEATER high-density variants (R-RIG): the standard BEATER as the backbone, every exterior panel a sampled sheet
 * (skins/beater.<tier>.ts). A 1990s compact: 0.8 mm mild-steel panels (DC04), thicker PP bumpers; the weakened
 * structure is the backbone's (it folds like paper).
 * PURE DATA MODULE, generated on first use.
 */
import type { SkinPanelData, SkinSpec } from '../../../rig/gen/types';
import { SHELL_RELEASE_CRUMPLE } from '../../shellDefs';
import { BEATER, BEATER_CRASH_PROBES } from '../beater';
import { defaultSkinSpec, hdVariants, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/beater.high';
import { SKINS as ULTRA } from './skins/beater.ultra';

export function beaterSkinSpec(p: SkinPanelData): SkinSpec | null {
  // the front fascia's lip (below the 0.30 m bumper beam) is left to the render: the beater noses down ≈ 16 cm in a
  // 1 g stop (R-PHYS's soft suspension) and a sheet lip at 0.19 m met the road (71 mm deflection in bodyflex)
  if (p.kind === 'bumper') return { panel: p.id, grade: 'PP_EPDM', gauge: 0.0035, seam: 'bolt', standoff: 0.2, ...(p.id === 'bumperF' ? { clipBelowY: 0.27 } : {}) };
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
  // no box-section members: a 1990s compact has no crash cans, and the sleeve walls' elastic push-back (its
  // crush unloading is off) took the 30 km/h crush from 42 to 27 cm (spring-back 6 → 35 %)
  detachable: ['hood', 'bumperF', 'bumperR', 'trunk'],
};

const HD = hdVariants(BEATER_HD_CONFIG);
export const beaterHD = HD.raw;
export const beaterVariant = HD.variant;
export const BEATER_HD_CRASH_PROBES = HD.probes;
