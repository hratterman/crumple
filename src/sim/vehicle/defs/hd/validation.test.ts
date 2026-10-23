/**
 * R-RIG: the high-density variants against each standard car's own acceptance targets — the same harnesses
 * (crash.ts, handling.ts, bodyflex.ts, rollover.ts) and the same numbers its tests assert (validation.ts restates
 * them per car: crash.test / coupe / pickup / boxtruck / beater tests, crashRing, bodyflex, launchFeel, rollover).
 * Each block prints its table, so the file doubles as the HD tuning report. Every tier runs under its quality's
 * solver preset (SOLVER_PRESETS: high adds node-vs-triangle contact, ultra self-collision), as played.
 *
 * Opt-in (≈ 15 min of CPU per car × tier: it is the full acceptance suite): RIG_VALIDATE=1 runs every car's
 * VALIDATED tiers (HD_STATUS) — re-run it after a change to a standard car or the generator, before flipping a
 * tier to 'validated'. RIG_TIERS=standard,high,ultra and RIG_CARS=sedan,coupe pick others
 * ('standard' re-runs the standard rig through the same rows, for the side-by-side table); RIG_REPORT=<file>
 * collects the tables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLVER_PRESETS } from '../../../../protocol/messages';
import { setDefaultSolver, SOLVER_DEFAULTS } from '../../../engine';
import { runCrash } from '../../crash';
import { STANDARD_VARIANTS, vehicleVariantSync } from './index';
import type { HdCar } from './skinSources';
import { HD_STATUS, type PhysicsQuality } from './variants';
import {
  asStandard,
  beaterTargets,
  BOXTRUCK_TARGETS_ALL,
  COUPE_TARGETS_ALL,
  crashChecks,
  feelChecks,
  formatChecks,
  handlingChecks,
  kcChecks,
  PICKUP_TARGETS_ALL,
  rolloverChecks,
  SEDAN_TARGETS_ALL,
  type Check,
  type VariantTargets,
} from './validation';

declare const process: { env: Record<string, string | undefined>; getBuiltinModule(id: 'node:fs'): { appendFileSync(path: string, data: string): void } };

/** RIG_REPORT=<file>: every table is also appended there (vitest hides passing tests' output). */
const expectAll = (title: string, rows: Check[]): void => {
  const table = formatChecks(title, rows);
  console.log(table);
  if (process.env.RIG_REPORT) process.getBuiltinModule('node:fs').appendFileSync(process.env.RIG_REPORT, table + '\n');
  for (const r of rows) expect(r.ok, `${r.name}: ${r.value}`).toBe(true);
};

const CARS = (process.env.RIG_CARS ?? 'sedan,coupe,pickup,boxtruck,beater').split(',') as HdCar[];
/** Default: each car's VALIDATED tiers (variants.ts HD_STATUS): what the quality setting can deliver is what CI holds. */
const tiersOf = (car: HdCar): PhysicsQuality[] =>
  process.env.RIG_TIERS ? (process.env.RIG_TIERS.split(',') as PhysicsQuality[]) : (['high', 'ultra'] as const).filter((q) => HD_STATUS[car]?.[q] === 'validated');

let beater: VariantTargets | null = null;
/** The beater's targets are relative to the standard sedan (beater.test.ts): measured once. */
function beaterTargetsOnce(): VariantTargets {
  if (beater) return beater;
  const sedan = STANDARD_VARIANTS.sedan;
  const run = (kind: 'frontal' | 'pole', v: number): number => {
    const r = asStandard(() => runCrash({ kind, speedKmh: v, def: sedan.def, probes: sedan.probes }));
    return kind === 'pole' ? r.doorIntrusion : r.crush;
  };
  beater = beaterTargets({ f50: run('frontal', 50), f30: run('frontal', 30), pole: run('pole', 30) });
  return beater;
}

const TARGETS: Record<HdCar, () => VariantTargets> = {
  sedan: () => SEDAN_TARGETS_ALL,
  coupe: () => COUPE_TARGETS_ALL,
  pickup: () => PICKUP_TARGETS_ALL,
  boxtruck: () => BOXTRUCK_TARGETS_ALL,
  beater: beaterTargetsOnce,
};

const ENABLED = !!(process.env.RIG_VALIDATE || process.env.RIG_TIERS || process.env.RIG_CARS);
if (!ENABLED) it.skip('HD acceptance suite (opt-in: RIG_VALIDATE=1)', () => {});

for (const car of ENABLED ? CARS : []) {
  for (const tier of tiersOf(car)) {
    describe(`${car}.${tier} validation`, () => {
      // as played: the quality's solver preset (R-CORE: high = node-vs-triangle contact, ultra + self-collision)
      beforeAll(() => setDefaultSolver(SOLVER_PRESETS[tier]));
      afterAll(() => setDefaultSolver(SOLVER_DEFAULTS));
      const v = () => (tier === 'standard' ? STANDARD_VARIANTS[car] : vehicleVariantSync(car, tier));
      it('crash targets', () => {
        expectAll(`[hd] ${car}.${tier} crash`, crashChecks(v().def, v().probes, TARGETS[car]().crash, {}, STANDARD_VARIANTS[car]));
      }, 1_800_000);
      it('handling targets', () => {
        expectAll(`[hd] ${car}.${tier} handling`, handlingChecks(v().def, TARGETS[car]().handling, STANDARD_VARIANTS[car].def));
      }, 1_800_000);
      it('body stiffness + launch feel targets', () => {
        expectAll(`[hd] ${car}.${tier} feel`, feelChecks(v().def, TARGETS[car]().feel, tier === 'standard' ? undefined : STANDARD_VARIANTS[car].def));
      }, 1_800_000);
      if (tier !== 'standard')
        it('K&C matches the standard car', () => {
          expectAll(`[hd] ${car}.${tier} K&C`, kcChecks(v().def, STANDARD_VARIANTS[car].def));
        }, 1_800_000);
      const roll = TARGETS[car] === beaterTargetsOnce ? undefined : TARGETS[car]().rollover;
      if (roll)
        it('rollover targets', () => {
          expectAll(`[hd] ${car}.${tier} rollover`, rolloverChecks(v().def, roll));
        }, 1_800_000);
    });
  }
}
