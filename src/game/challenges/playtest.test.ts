/**
 * Headless playtests (opt-in: PLAYTEST=1 [PLAYTEST_ONLY=id,id]): every
 * challenge on the real Crumple Valley worker host (terrain, colliders,
 * props, opponents' ram autopilot), driven by the playtest bot at a few
 * skill settings, scored by the real runtime from real snapshots. The
 * printed scores are what the medal thresholds in catalog.ts were tuned
 * from (docs/CONTRACTS.md "P8 challenges as built").
 */
import { describe, expect, it } from 'vitest';

import { SnapshotReader } from '../../protocol/codec';
import { GAME_CAPACITY, type ActionState, type WorkerToMain } from '../../protocol/messages';
import { compileVehicle } from '../../sim/vehicle/builder';
import { BEATER } from '../../sim/vehicle/defs/beater';
import { BOXTRUCK } from '../../sim/vehicle/defs/boxtruck';
import { COUPE } from '../../sim/vehicle/defs/coupe';
import { PICKUP } from '../../sim/vehicle/defs/pickup';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import { SEDAN_TRAFFIC } from '../../sim/vehicle/defs/sedanTraffic';
import type { VehicleDef } from '../../sim/vehicle/types';
import { valleyTerrain } from '../../sim/traffic/testkit';
import { WorkerHost } from '../../sim/worker';
import { hashTerrain } from '../../world/terrain';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { createTerrainSampler } from '../../world/sampler';
import { resolveColliders } from '../../world/colliders';
import { Bot, type BotConfig } from './bot';
import { challengeCatalog } from './catalog';
import { ChallengeRun } from './runtime';
import { rigInfo, SampleBuilder } from './sample';
import { challengeProps, OPPONENT_ID_BASE, spawnTransform } from './setup';
import type { ChallengeDef, ChallengeResult, ChallengeSample } from './types';
import { surfaceIndex } from '../../world/surface';

const DEFS: Record<string, VehicleDef> = { sedan: SEDAN, coupe: COUPE, pickup: PICKUP, boxtruck: BOXTRUCK, beater: BEATER, sedanTraffic: SEDAN_TRAFFIC };

export interface PlaytestOptions {
  vehicle?: string;
  bot: Partial<BotConfig> | null;
  /** Override the bot's actions (t = run clock, s; null before GO). */
  script?: (t: number | null, s: ChallengeSample, a: ActionState) => void;
  maxS?: number;
}

export function playtest(def: ChallengeDef, opts: PlaytestOptions): { result: ChallengeResult | null; run: ChallengeRun; popups: string[] } {
  const terrain = valleyTerrain();
  const smp = createTerrainSampler(terrain);
  const heightAt = (x: number, z: number): number => smp.heightAt(x, z);
  const surfIdx = surfaceIndex(resolveColliders(DEFAULT_LAYOUT.colliders, heightAt), heightAt);
  const surf = (x: number, z: number): number => surfIdx.at(x, z);
  const vid = def.vehicle.kind === 'forced' ? def.vehicle.id : (opts.vehicle ?? 'sedan');
  const vdef = DEFS[vid]!;
  const cv = compileVehicle(vdef);
  const snaps: ArrayBuffer[] = [];
  let ref: WorkerHost | null = null;
  const errors: string[] = [];
  const host = new WorkerHost(
    (m: WorkerToMain) => {
      if (m.type === 'snapshot') {
        snaps.push(m.buffer.slice(0));
        ref?.handle({ type: 'returnBuffer', buffer: m.buffer });
      } else if (m.type === 'error' || m.type === 'fatal') errors.push(`${m.type}: ${'message' in m ? m.message : ''}`);
    },
    { now: () => 0, schedule: () => {} },
    { generateTerrain: () => terrain, hashTerrain },
  );
  ref = host;
  host.handle({ type: 'init', seed: 1234, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
  host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
  host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: vdef, transform: spawnTransform(def.spawn, cv.rig, heightAt), catalogId: vid });
  if (def.tractionControl === false) host.handle({ type: 'setAssists', objectId: 1, tractionControl: false });
  const props = challengeProps(def, heightAt);
  if (props.spawns.length) host.handle({ type: 'spawnProps', items: props.spawns });
  const opp = (def.opponents ?? []).map((o, k) => {
    const od = DEFS[o.vehicle]!;
    const ocv = compileVehicle(od);
    const id = OPPONENT_ID_BASE + k;
    host.handle({ type: 'spawnVehicle', objectId: id, vehicle: od, transform: spawnTransform(o.spawn, ocv.rig, heightAt), catalogId: o.vehicle });
    return { id, rig: rigInfo(ocv), aggression: o.aggression ?? 0.7 };
  });
  const builder = new SampleBuilder({ playerId: 1, player: rigInfo(cv), surfaceAt: surf, pins: props.pins, opponents: opp.map((o) => ({ id: o.id, rig: o.rig })) });
  const run = new ChallengeRun(def, { groundAt: heightAt, vehicle: vid, palette: null });
  const reader = new SnapshotReader();
  const line = opts.bot?.line ?? def.botLine ?? [];
  const bot = opts.bot ? new Bot({ line, speedKmh: 60, ...opts.bot }) : null;
  const a: ActionState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1 };
  const popups: string[] = [];
  let calibrated = false;
  let started = false;
  const maxS = opts.maxS ?? 240;
  for (let f = 0; f < maxS * 60; f++) {
    host.runSteps(f % 3 === 2 ? 34 : 33);
    for (const b of snaps.splice(0)) {
      reader.attach(b);
      const s = builder.build(reader);
      if (!started && s.valid && s.tick > 1200) {
        if (!calibrated) {
          builder.calibrate();
          calibrated = true;
        }
        run.startCountdown(s.simTime);
        started = true;
        for (const o of opp) host.handle({ type: 'setAutopilot', objectId: o.id, mode: 'ram', targetObjectId: 1, aggression: o.aggression, seed: o.id });
      }
      run.onSample(s);
      for (const e of run.drainEvents()) if (e.type === 'popup') popups.push(`${e.text}${e.sub ? ` (${e.sub})` : ''}`);
    }
    if (run.over) break;
    const s = builder.sample;
    if (bot && s.valid) Object.assign(a, bot.update(s));
    if (!run.running) {
      a.throttle = 0;
      a.brake = 1;
      a.handbrake = 1;
    } else a.handbrake = a.handbrake ?? 0;
    opts.script?.(run.running ? run.state.clock : null, s, a);
    host.handle({ type: 'input', objectId: 1, actions: { ...a } });
  }
  expect(errors).toEqual([]);
  const ls = builder.sample;
  popups.push(`end@(${ls.pos.map((v) => v.toFixed(1)).join(',')}) v ${ls.speed.toFixed(1)} up ${ls.up[1].toFixed(2)}`);
  return { result: run.result, run, popups };
}

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const ON = !!ENV.PLAYTEST;
const ONLY = (ENV.PLAYTEST_ONLY ?? '').split(',').filter(Boolean);
const want = (id: string): boolean => ON && (ONLY.length === 0 || ONLY.includes(id));

function report(id: string, label: string, r: { result: ChallengeResult | null; popups: string[] }): void {
  const res = r.result;
  console.log(`[playtest] ${id} ${label}: ${res ? (res.completed ? `${res.scoreText} → ${res.medal}` : `FAILED ${res.failReason}`) : 'no result'} | ${res?.stats.map((x) => `${x.label} ${x.value}`).join(', ')} | popups: ${r.popups.slice(-12).join('; ')}`);
}

describe.skipIf(!ON)('challenge playtests (PLAYTEST=1)', () => {
  const defs = (): readonly ChallengeDef[] => challengeCatalog(valleyTerrain());
  const def = (id: string): ChallengeDef => defs().find((d) => d.id === id)!;

  it.runIf(want('wall-of-fame'))('wall-of-fame', () => {
    for (const kmh of [95, 110, 125]) report('wall-of-fame', `${kmh} km/h`, playtest(def('wall-of-fame'), { bot: { speedKmh: kmh } }));
  }, 900_000);

  it.runIf(want('bowling'))('bowling', () => {
    for (const [kmh, dz] of [[45, 0], [70, 0], [70, 0.9], [70, 1.8], [100, 0.4]] as const) {
      const z = 330 + dz;
      report('bowling', `${kmh} km/h offset ${dz}`, playtest(def('bowling'), { bot: { speedKmh: kmh, line: [[437, 330], [425, z], [370, z]] } }));
    }
  }, 900_000);

  it.runIf(want('long-jump'))('long-jump', () => {
    for (const thr of [0, 0.4, 0.7, 1]) report('long-jump', `throttle ${thr}`, playtest(def('long-jump'), { bot: { speedKmh: 200, maxThrottle: Math.max(thr, 0.001), latAcc: 50 } }));
  }, 900_000);

  it.runIf(want('barrel-roll'))('barrel-roll', () => {
    for (const kmh of [40, 55, 70, 85]) report('barrel-roll', `${kmh} km/h`, playtest(def('barrel-roll'), { bot: { speedKmh: kmh, latAcc: 50 } }));
  }, 900_000);

  it.runIf(want('truck-topple'))('truck-topple', () => {
    for (const lat of [2.5, 3.5, 4.5]) report('truck-topple', `latAcc ${lat}`, playtest(def('truck-topple'), { bot: { speedKmh: 70, latAcc: lat, lookahead: [6, 14] } }));
  }, 900_000);

  it.runIf(want('hill-climb'))('hill-climb', () => {
    for (const lat of [5, 7]) report('hill-climb', `sedan latAcc ${lat}`, playtest(def('hill-climb'), { vehicle: 'sedan', bot: { speedKmh: 150, latAcc: lat } }));
    report('hill-climb', 'coupe latAcc 7', playtest(def('hill-climb'), { vehicle: 'coupe', bot: { speedKmh: 170, latAcc: 7 } }));
  }, 1_800_000);

  it.runIf(want('drift-king'))('drift-king', () => {
    for (const lat of [6, 9]) report('drift-king', `latAcc ${lat}`, playtest(def('drift-king'), { bot: { speedKmh: 140, latAcc: lat } }));
  }, 1_800_000);

  it.runIf(want('precision-park'))('precision-park', () => {
    for (const kmh of [12, 20]) report('precision-park', `${kmh} km/h`, playtest(def('precision-park'), { bot: { speedKmh: kmh, stopAtEnd: true, latAcc: 3 } }));
  }, 900_000);

  it.runIf(want('stunt-jam'))('stunt-jam', () => {
    report('stunt-jam', 'wreck jump line', playtest(def('stunt-jam'), { bot: { speedKmh: 80, latAcc: 50 }, maxS: 80 }));
  }, 900_000);

  it.runIf(want('demolition-derby'))('demolition-derby', () => {
    report('demolition-derby', 'parked', playtest(def('demolition-derby'), { bot: null, maxS: 160 }));
  }, 1_800_000);
});
