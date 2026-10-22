/**
 * R-RIG: SYNCHRONOUS variant registry over every car's standard and HD rigs
 * (tests, tools, harnesses). Imports all rig data: never import it from
 * game code (use variants.ts `loadVehicleVariant`, which code-splits).
 */
import type { CrashProbes } from '../../crash';
import { BEATER, BEATER_CRASH_PROBES } from '../beater';
import { BOXTRUCK, BOXTRUCK_CRASH_PROBES } from '../boxtruck';
import { COUPE, COUPE_CRASH_PROBES } from '../coupe';
import { PICKUP, PICKUP_CRASH_PROBES } from '../pickup';
import { SEDAN } from '../sedan';
import { sedanVariant } from './sedan';
import type { HdCar, HdTier } from './skinSources';
import type { PhysicsQuality, VehicleVariant } from './variants';

const SEDAN_PROBES: CrashProbes = {
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

export const STANDARD_VARIANTS: Readonly<Record<HdCar, VehicleVariant>> = {
  sedan: { car: 'sedan', quality: 'standard', def: SEDAN, probes: SEDAN_PROBES },
  coupe: { car: 'coupe', quality: 'standard', def: COUPE, probes: COUPE_CRASH_PROBES },
  pickup: { car: 'pickup', quality: 'standard', def: PICKUP, probes: PICKUP_CRASH_PROBES as unknown as CrashProbes },
  boxtruck: { car: 'boxtruck', quality: 'standard', def: BOXTRUCK, probes: BOXTRUCK_CRASH_PROBES as unknown as CrashProbes },
  beater: { car: 'beater', quality: 'standard', def: BEATER, probes: BEATER_CRASH_PROBES },
};

const HD: Partial<Record<HdCar, (t: HdTier) => VehicleVariant>> = {
  sedan: sedanVariant,
};

/** Cars × tiers that exist (standard always). */
export function hdTiersOf(car: HdCar): readonly PhysicsQuality[] {
  return HD[car] ? ['standard', 'high', 'ultra'] : ['standard'];
}

/** The variant at exactly `quality` (throws when the car has no such tier). */
export function vehicleVariantSync(car: HdCar, quality: PhysicsQuality): VehicleVariant {
  if (quality === 'standard') return STANDARD_VARIANTS[car];
  const f = HD[car];
  if (!f) throw new Error(`no ${quality} variant for ${car}`);
  return f(quality);
}
