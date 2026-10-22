/**
 * BOX TRUCK high-density variants (R-RIG): the standard BOXTRUCK as the backbone (ladder frame lattice, cab and box
 * clusters, mounts unchanged), the cab panels as 0.8 mm steel sheets and the box as 1.2 mm aluminium panels on its
 * posts and bows (sampled coarser: skinSources SKIN_PITCH_SCALE).
 * PURE DATA MODULE, generated on first use.
 */
import type { SkinPanelData, SkinSpec } from '../../../rig/gen/types';
import type { CrashProbes } from '../../crash';
import { BOXTRUCK, BOXTRUCK_CRASH_PROBES } from '../boxtruck';
import { defaultSkinSpec, hdVariants, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/boxtruck.high';
import { SKINS as ULTRA } from './skins/boxtruck.ultra';

export function boxtruckSkinSpec(p: SkinPanelData): SkinSpec | null {
  if (p.id.startsWith('box') || p.id === 'rollerDoor') return { panel: p.id, grade: 'AL6016', gauge: p.id === 'rollerDoor' ? 0.0008 : 0.0012, seam: p.id === 'rollerDoor' ? 'bolt' : 'glue', standoff: 0.4 };
  return defaultSkinSpec(p, { grade: 'DC04', gauge: 0.0008 });
}

export const BOXTRUCK_HD_CONFIG: HdCarConfig = {
  car: 'boxtruck',
  base: BOXTRUCK,
  probes: BOXTRUCK_CRASH_PROBES as unknown as CrashProbes,
  skins: { high: HIGH, ultra: ULTRA },
  skinSpec: boxtruckSkinSpec,
  detachable: ['hood', 'noseFace'],
};

const HD = hdVariants(BOXTRUCK_HD_CONFIG);
export const boxtruckHD = HD.raw;
export const boxtruckVariant = HD.variant;
export const BOXTRUCK_HD_CRASH_PROBES = HD.probes;
