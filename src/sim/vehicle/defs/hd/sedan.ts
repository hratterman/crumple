/**
 * SEDAN high-density variants (R-RIG; docs/CONTRACTS.md "R-RIG"): the
 * standard SEDAN as the backbone (ids, hardpoints, suspension, drivetrain,
 * shell zones unchanged; the wheels as R-TYRE's high-resolution tyre) with every exterior panel rebuilt as a sheet-metal
 * skin sampled from the render body (skins/sedan.<tier>.ts) at the tier's
 * pitch, fastened by its real seam (spot-weld / hem / bolts / clips), and the
 * mass redistributed so total and CG match the standard car.
 *
 * PURE DATA MODULE (main-importable like the standard defs). Generation runs
 * on first use (`sedanHD(tier)`), so importing it lazily keeps it out of the
 * app chunk.
 */
import type { BoxMemberSpec } from '../../../rig/gen/member';
import type { SkinPanelData, SkinSet, SkinSpec } from '../../../rig/gen/types';
import type { CrashProbes } from '../../crash';
import { hiResWheels, HIRES_ROLL_DELTA_205_55R16 } from '../../tyreHiRes';
import { SEDAN } from '../sedan';
import { hdVariants, stationDonorWeight, stationMembers, type HdCarConfig } from './build';
import { SKINS as HIGH } from './skins/sedan.high';
import { SKINS as ULTRA } from './skins/sedan.ultra';
import type { HdTier } from './skinSources';

/**
 * Sheet construction per panel (real gauges: outer panels 0.7–0.75 mm
 * bake-hardening steel, rear panel 0.8 mm mild steel, fascias 3 mm PP/EPDM).
 * Standoffs = the inner structure behind the sheet (door inner panel, hood /
 * deck-lid inner frame, roof bows, fender brackets).
 */
export function sedanSkinSpec(p: SkinPanelData): SkinSpec | null {
  switch (p.kind) {
    case 'hood':
    case 'trunk':
      return { panel: p.id, grade: 'BH220', gauge: 0.0007, seam: 'hem', standoff: 0.3 };
    case 'door':
      return { panel: p.id, grade: 'BH220', gauge: 0.0007, seam: 'hem', standoff: 0.3 };
    case 'fender':
      return { panel: p.id, grade: 'BH220', gauge: 0.0007, seam: 'bolt', standoff: 0.2 };
    case 'roof':
      return { panel: p.id, grade: 'BH220', gauge: 0.00075, seam: 'weld', standoff: 0.3 };
    case 'bumper':
      return { panel: p.id, grade: 'PP_EPDM', gauge: 0.003, seam: 'bolt', standoff: 0.2 };
    case 'body':
      if (p.material === 'trim') return { panel: p.id, grade: 'PP_EPDM', gauge: 0.0025, seam: 'glue', standoff: 0.15 };
      return { panel: p.id, grade: p.id === 'rearPanel' ? 'DC04' : 'BH220', gauge: p.id === 'rearPanel' ? 0.0008 : 0.00075, seam: 'weld', standoff: 0.25 };
    default:
      return null;
  }
}

const SKINS: Readonly<Record<HdTier, SkinSet>> = { high: HIGH, ultra: ULTRA };

/** The standard sedan's crash probes (crash.ts SEDAN_CRASH_PROBES; restated: crash.ts imports the engine). */
export const SEDAN_PROBES: CrashProbes = {
  front: ['s1_rl_*', 's1_rh_*'],
  cabin: ['s7_fl_*', 's7_sl_*'],
  firewall: ['s5_fl_*', 's5_sl_*', 's5_hp_*', 's5_cw_*'],
  cellRear: ['s9_*'],
  cellFront: ['s5_*'],
  doorMid: ['s6_dm_*'],
  doorR: 's6_dm_R',
  doorL: 's6_dm_L',
  sillR: 's6_sl_R',
  sillL: 's6_sl_L',
  exemptPrefixes: ['s0_', 's13_', 'hood_'],
  latch: [['hood_0C', 's2_rt']],
  bumperPrefix: 's0_',
  windscreen: ['s5_cw', 's6_rf'],
};

/**
 * Closed-section members (member.ts, walls carried by the backbone stations): beaded crash cans (5 cm pitch: they
 * fold first, accordion), front rails s1→s4 (beads over their front 40 %); ultra adds the rear rails + cans.
 */
export function sedanMembers(tier: HdTier): BoxMemberSpec[] {
  return stationMembers(tier, { frontRail: [1, 2, 3, 4], rearRail: [10, 11, 12], rearBumper: 13 });
}

/** Mass donors (build.ts stationDonorWeight): the cell spans stations 5–9. */
export const sedanMassDonorWeight = stationDonorWeight(9);
/** The sedan's HD build recipe (build.ts). */
export const SEDAN_HD_CONFIG: HdCarConfig = {
  car: 'sedan',
  // R-TYRE: the high-resolution tyre (16 rays, carcass compliance: tyreHiRes.ts) on both HD tiers
  base: { ...SEDAN, wheels: hiResWheels(SEDAN.wheels, { rollDelta: HIRES_ROLL_DELTA_205_55R16 }) },
  probes: SEDAN_PROBES,
  skins: SKINS,
  skinSpec: sedanSkinSpec,
  donorWeight: sedanMassDonorWeight,
  members: sedanMembers,
  detachable: ['hood', 'bumperF', 'bumperR', 'trunk'],
};

const HD = hdVariants(SEDAN_HD_CONFIG);
/** The generated sedan variant (memoized RefinedVehicle). */
export const sedanHD = HD.raw;
/** The sedan at an HD tier as a VehicleVariant (variants.ts loader). */
export const sedanVariant = HD.variant;
/** Crash probes of the HD sedans: the standard sedan's + generated-node handling (build.ts hdProbes). */
export const SEDAN_HD_CRASH_PROBES: CrashProbes = HD.probes;
