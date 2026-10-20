/**
 * Physics budget (P5 integration): the real game scene — Crumple Valley
 * heightfield, layout + vegetation colliders, water, all 198 layout props
 * asleep — through the worker host, with the sedan ploughing through the
 * runway barrel wall and the cardboard pyramid. Reports CPU ms per simulated
 * second (real time = 1000) and the awake prop count; the ceiling is
 * generous (shared CI boxes), the target in the plan is ≤ 500.
 */
import { describe, expect, it } from 'vitest';
import { GAME_CAPACITY, type WorkerToMain } from '../../protocol/messages';
import { DEFAULT_LAYOUT } from '../../world/layout';
import type { SimEngine } from '../engine';
import { SIM_OBJECT_FLAG_SLEEPING } from '../types';
import { SEDAN } from '../vehicle/defs/sedan';
import { setMotion } from '../vehicle/handling';
import { WorkerHost } from '../worker';

const STEPS_PER_S = 2000;

/**
 * CPU ms of this process: stepping is synchronous on one thread, so this is the step cost even when
 * an oversubscribed box deschedules the test (wall time then overstates it several times over).
 */
function cpuMs(): number {
  const u = (globalThis as unknown as { process: { cpuUsage(): { user: number; system: number } } }).process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function awakeProps(eng: SimEngine): number {
  let n = 0;
  for (const o of eng.objects) if (o.objectId >= 4096 && (o.flags & SIM_OBJECT_FLAG_SLEEPING) === 0) n++;
  return n;
}

/** Yaw-only quaternion facing (fx, fz) (vehicle forward = local −Z). */
function facing(fx: number, fz: number): [number, number, number, number] {
  const a = Math.atan2(-fx, -fz);
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}

interface Run {
  msPerSimS: number;
  worstMsPerSimS: number;
  maxAwake: number;
  awakeEnd: number;
  pairsMax: number;
}

function plough(host: WorkerHost, x: number, z: number, fx: number, fz: number, kmh: number, seconds: number): Run {
  const eng = host.engine!;
  eng.resetProps();
  const y = eng.sampler!.heightAt(x, z) + 0.05;
  eng.reset(1, { pos: [x, y, z], quat: facing(fx, fz) });
  const obj = eng.arena.get(1)!;
  const veh = eng.getVehicle(1)!;
  for (let i = 0; i < 400; i++) eng.step(); // settle on the wheels
  setMotion({ eng, obj, veh, cv: veh.vehicle, objectId: 1 }, kmh / 3.6);
  eng.setInput(1, { throttle: 0.4, brake: 0, gearSelect: 1 });
  let total = 0;
  let worst = 0;
  let maxAwake = 0;
  let pairsMax = 0;
  for (let s = 0; s < seconds * 4; s++) {
    const t0 = cpuMs();
    for (let i = 0; i < STEPS_PER_S / 4; i++) {
      eng.step();
      if (eng.contacts.pairCount > pairsMax) pairsMax = eng.contacts.pairCount;
    }
    const dt = cpuMs() - t0;
    eng.events.clear();
    total += dt;
    worst = Math.max(worst, dt * 4);
    maxAwake = Math.max(maxAwake, awakeProps(eng));
  }
  return { msPerSimS: total / seconds, worstMsPerSimS: worst, maxAwake, awakeEnd: awakeProps(eng), pairsMax };
}

describe('physics budget: sedan through the arena props (real scene)', () => {
  it('reports CPU ms per simulated second (barrel wall at 50 km/h, cardboard pyramid at 40 km/h)', () => {
    const out: WorkerToMain[] = [];
    const host = new WorkerHost((m) => out.push(m), { now: () => 0, schedule: () => {} });
    host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
    host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
    host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [470, 12, 327.6], quat: facing(-1, 0) } });
    expect(out.filter((m) => m.type === 'error')).toEqual([]);
    const eng = host.engine!;
    for (let i = 0; i < 200; i++) eng.step();

    const alone = plough(host, 360, 330, 0, -1, 50, 3);
    eng.contacts.profile = true;
    const barrels = plough(host, 462, 327.6, -1, 0, 50, 3);
    const st = eng.contacts.stats;
    console.log(`[physics budget] contacts during the barrel run: rebuild ${(st.rebuildMs / 3).toFixed(0)} ms/sim-s, apply ${(st.applyMs / 3).toFixed(0)} ms/sim-s`);
    eng.contacts.profile = false;
    const pyramid = plough(host, 334.1, 356, 0, -1, 40, 3);
    const fmt = (r: Run): string =>
      `${r.msPerSimS.toFixed(0)} ms/sim-s (worst 0.25 s window ${r.worstMsPerSimS.toFixed(0)}), awake props max ${r.maxAwake} / end ${r.awakeEnd}, pairs max ${r.pairsMax}`;
    console.log(`[physics budget] sedan alone 50 km/h: ${fmt(alone)}`);
    console.log(`[physics budget] barrel wall 50 km/h: ${fmt(barrels)}`);
    console.log(`[physics budget] cardboard pyramid 40 km/h: ${fmt(pyramid)}`);
    expect(barrels.maxAwake).toBeGreaterThan(5);
    expect(pyramid.maxAwake).toBeGreaterThan(5);
    // Generous regression ceiling (loaded CI machines); the target is ≤ 500.
    expect(barrels.msPerSimS).toBeLessThan(1500);
    expect(pyramid.msPerSimS).toBeLessThan(1500);
  }, 300_000);
});
