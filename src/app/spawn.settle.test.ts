/**
 * Spawning never damages a vehicle: every player vehicle at every layout
 * spawn point of Crumple Valley, placed exactly as main places it
 * (placeOnGround: ground plane under the whole footprint, lowest node 6 cm
 * up) and sent with the spawn-settle window — as a first spawn, as a
 * teleport (`reset`, the pause menu's spawn list) and as a respawn
 * (`despawn` + `spawnVehicle`, the showroom's DRIVE). Over the first 3 s:
 * no broken beam, no plastic deformation beyond 1e-5, every glass pane's
 * strain below its crack threshold (the render's GlassSpec), no impact
 * above IMPACT_LIMIT. Plus: the settle window is exact (thresholds lifted,
 * then the rig's values back) and part of the replay log.
 */
import { describe, expect, it } from 'vitest';

import { placeOnGround } from './spawn';
import { SnapshotReader } from '../protocol/codec';
import { GAME_CAPACITY, MaterialId, SPAWN_SETTLE_S, type MainToWorker, type WorkerToMain } from '../protocol/messages';
import type { ReplayFile } from '../protocol/replay';
import { resolveBeamSelector } from '../render/vehicle/binder';
import { BEATER_VISUAL } from '../render/vehicle/defs/beater';
import { BOXTRUCK_VISUAL } from '../render/vehicle/defs/boxtruck';
import { COUPE_VISUAL } from '../render/vehicle/defs/coupe';
import { PICKUP_VISUAL } from '../render/vehicle/defs/pickup';
import { SEDAN_VISUAL } from '../render/vehicle/defs/sedan';
import type { VehicleVisualDef } from '../render/vehicle/types';
import { hashSimState } from '../sim/replay/hash';
import { resimulate } from '../sim/replay/resim';
import { RIG_BEAM_TYPE_ID } from '../sim/rig/types';
import { valleyTerrain } from '../sim/traffic/testkit';
import { compileVehicle } from '../sim/vehicle/builder';
import { BEATER } from '../sim/vehicle/defs/beater';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { COUPE } from '../sim/vehicle/defs/coupe';
import { PICKUP } from '../sim/vehicle/defs/pickup';
import { SEDAN } from '../sim/vehicle/defs/sedan';
import type { VehicleDef } from '../sim/vehicle/types';
import { WorkerHost } from '../sim/worker';
import { DEFAULT_LAYOUT } from '../world/layout';
import { hashTerrain } from '../world/terrain';

/** Largest impact allowed after the settle window, N·s (glass cracks at 120–200, a scuff is impulse / 300). */
const IMPACT_LIMIT = 10;
/** Plastic deformation epsilon: |restLen / rest0 − 1|. */
const PLASTIC_EPS = 1e-5;
const TICKS = 6000; // 3 s

const FLEET: [string, VehicleDef, VehicleVisualDef][] = [
  ['sedan', SEDAN, SEDAN_VISUAL],
  ['coupe', COUPE, COUPE_VISUAL],
  ['pickup', PICKUP, PICKUP_VISUAL],
  ['boxtruck', BOXTRUCK, BOXTRUCK_VISUAL],
  ['beater', BEATER, BEATER_VISUAL],
];

type Method = 'spawn' | 'teleport' | 'respawn';

interface Row {
  vehicle: string;
  spawn: string;
  method: Method;
  broken: number;
  plastic: number;
  plasticBeams: number;
  glass: number;
  glassPane: string;
  glassRatio: number;
  impacts: number;
  maxImpact: number;
}

function valleyHost(): { host: WorkerHost; out: WorkerToMain[] } {
  const out: WorkerToMain[] = [];
  let ref: WorkerHost | null = null;
  const host = new WorkerHost(
    (m) => {
      if (m.type === 'snapshot') ref?.handle({ type: 'returnBuffer', buffer: m.buffer });
      else out.push(m);
    },
    { now: () => 0, schedule: () => {} },
    { generateTerrain: () => valleyTerrain(), hashTerrain },
  );
  ref = host;
  host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
  host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
  return { host, out };
}

describe('spawn settle: every vehicle × every spawn point stays pristine', () => {
  const terrain = valleyTerrain();
  const rows: Row[] = [];

  for (const [name, def, visual] of FLEET) {
    it(`${name}`, { timeout: 600_000 }, () => {
      const rig = compileVehicle(def).rig;
      const panes = visual.panels
        .filter((p) => p.glass)
        .map((p) => ({ id: p.id, beams: resolveBeamSelector(rig, p.glass!.beams, p.id), crack: p.glass!.crackStrain }));
      const { host, out } = valleyHost();
      const eng = host.engine!;
      const s = eng.state;
      terrain.spawns.forEach((sp, si) => {
        const t = placeOnGround(rig, eng.sampler!, sp.pos[0], sp.pos[2], sp.yaw);
        // First spawn, then alternate teleports (reset) and showroom-style respawns (despawn + spawnVehicle).
        const method: Method = si === 0 ? 'spawn' : si % 2 === 1 ? 'teleport' : 'respawn';
        if (method === 'teleport') host.handle({ type: 'reset', objectId: 1, transform: t, settle: SPAWN_SETTLE_S });
        else {
          if (method === 'respawn') host.handle({ type: 'despawn', objectId: 1 });
          host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: def, transform: t, transmission: 'auto', catalogId: name, settle: SPAWN_SETTLE_S });
        }
        expect(out.filter((m) => m.type === 'error' || m.type === 'fatal')).toEqual([]);
        const obj = eng.arena.get(1)!;
        eng.events.clear();
        const row: Row = { vehicle: name, spawn: sp.id, method, broken: 0, plastic: 0, plasticBeams: 0, glass: 0, glassPane: '', glassRatio: 0, impacts: 0, maxImpact: 0 };
        for (let k = 0; k < TICKS; k++) {
          eng.step();
          const ev = eng.events;
          for (let i = 0; i < ev.impactCount; i++) {
            if (ev.impacts[i * 9] !== 1) continue;
            row.impacts++;
            row.maxImpact = Math.max(row.maxImpact, ev.impacts[i * 9 + 8]!);
          }
          for (let i = 0; i < ev.breakCount; i++) if (ev.breaks[i * 5] === 1) row.broken++;
          ev.clear();
          if ((k & 7) !== 0) continue;
          for (const p of panes) {
            for (let q = 0; q < p.beams.length; q++) {
              const b = p.beams[q]!;
              const a = obj.nodeStart + rig.beamA[b]!;
              const c = obj.nodeStart + rig.beamB[b]!;
              const dx = s.posX[c]! - s.posX[a]!;
              const dy = s.posY[c]! - s.posY[a]!;
              const dz = s.posZ[c]! - s.posZ[a]!;
              const e = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) / rig.beamRestLen[b]! - 1);
              if (e / p.crack > row.glassRatio) {
                row.glassRatio = e / p.crack;
                row.glass = e;
                row.glassPane = p.id;
              }
            }
          }
        }
        for (let b = 0; b < rig.beamCount; b++) {
          const g = obj.beamStart + b;
          if (!s.active[g]) row.broken++;
          if (rig.beamType[b] === RIG_BEAM_TYPE_ID.hydro) continue;
          const d = Math.abs(s.restLen[g]! / rig.beamRestLen[b]! - 1);
          if (d > PLASTIC_EPS) row.plasticBeams++;
          row.plastic = Math.max(row.plastic, d);
        }
        rows.push(row);
        console.log(
          `[spawn] ${name.padEnd(8)} ${sp.id.padEnd(12)} ${method.padEnd(8)} broken ${row.broken}  plastic ${row.plasticBeams} (max ${(row.plastic * 100).toFixed(4)} %)  glass ${(row.glass * 100).toFixed(2)} % = ${(row.glassRatio * 100).toFixed(0)} % of crack (${row.glassPane || '-'})  impacts ${row.impacts} (max ${row.maxImpact.toFixed(1)} N·s)`,
        );
      });
      for (const r of rows.filter((x) => x.vehicle === name)) {
        const where = `${r.vehicle} @ ${r.spawn} (${r.method})`;
        expect(r.broken, `${where}: broken beams`).toBe(0);
        expect(r.plasticBeams, `${where}: plastically deformed beams`).toBe(0);
        expect(r.glassRatio, `${where}: glass strain / crack strain`).toBeLessThan(0.6);
        expect(r.maxImpact, `${where}: largest impact`).toBeLessThan(IMPACT_LIMIT);
      }
    });
  }
});

describe('spawn settle window (engine)', () => {
  function planeHost(): WorkerHost {
    const host = new WorkerHost(() => {}, { now: () => 0, schedule: () => {} });
    host.handle({ type: 'init', seed: 3, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 8, nodeCapacity: 8192, beamCapacity: 32768 } });
    host.handle({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
    return host;
  }

  it('lifts the thresholds for exactly the window, mutes the object, then restores the rig values', () => {
    const host = planeHost();
    const eng = host.engine!;
    const rig = compileVehicle(SEDAN).rig;
    host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [0, 0.3, 0], quat: [0, 0, 0, 1] }, settle: 0.25 });
    const obj = eng.arena.get(1)!;
    expect(eng.settleTicksLeft(1)).toBe(500);
    expect(eng.state.deform[obj.beamStart]).toBe(Infinity);
    expect(eng.state.breakF[obj.beamStart + rig.beamCount - 1]).toBe(Infinity);
    let impacts = 0;
    for (let k = 0; k < 500; k++) {
      eng.step();
      impacts += eng.events.impactCount;
      eng.events.clear();
    }
    expect(impacts).toBe(0); // a 25 cm drop lands inside the window: muted
    expect(eng.settleTicksLeft(1)).toBe(0);
    eng.step();
    for (let b = 0; b < rig.beamCount; b++) {
      expect(eng.state.deform[obj.beamStart + b]).toBe(rig.beamDeform[b]);
      expect(eng.state.breakF[obj.beamStart + b]).toBe(rig.beamBreakF[b]);
    }
    // reset without settle closes nothing open; with settle it opens a new window.
    host.handle({ type: 'reset', objectId: 1, transform: { pos: [0, 0.3, 0], quat: [0, 0, 0, 1] }, settle: 0.1 });
    expect(eng.settleTicksLeft(1)).toBe(200);
    host.handle({ type: 'reset', objectId: 1, transform: { pos: [0, 0.3, 0], quat: [0, 0, 0, 1] } });
    expect(eng.settleTicksLeft(1)).toBe(0);
    expect(eng.state.deform[obj.beamStart]).toBe(rig.beamDeform[0]);
    // invalid values are rejected
    const errs: WorkerToMain[] = [];
    const h2 = new WorkerHost((m) => errs.push(m), { now: () => 0, schedule: () => {} });
    h2.handle({ type: 'init', seed: 3, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false });
    h2.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [0, 0.3, 0], quat: [0, 0, 0, 1] }, settle: -1 });
    expect(errs.some((m) => m.type === 'error')).toBe(true);
  });

  it('a respawn of the same objectId continues its repair epoch (main never interpolates old → new body)', () => {
    const snaps: ArrayBuffer[] = [];
    const host = new WorkerHost((m) => {
      if (m.type === 'snapshot') {
        snaps.push(m.buffer.slice(0));
        host.handle({ type: 'returnBuffer', buffer: m.buffer });
      }
    }, { now: () => 0, schedule: () => {} });
    host.handle({ type: 'init', seed: 3, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 8, nodeCapacity: 8192, beamCapacity: 32768 } });
    host.handle({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
    const reader = new SnapshotReader();
    const epoch = (): number => {
      host.runSteps(40);
      reader.attach(snaps[snaps.length - 1]!);
      return reader.objectRepairEpoch(reader.findObject(1));
    };
    const at = (x: number): MainToWorker => ({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [x, 0.3, 0], quat: [0, 0, 0, 1] } });
    host.handle(at(0));
    expect(epoch()).toBe(0);
    host.handle({ type: 'reset', objectId: 1, transform: { pos: [0, 0.3, 0], quat: [0, 0, 0, 1] } });
    expect(epoch()).toBe(1);
    host.handle({ type: 'despawn', objectId: 1 });
    host.handle(at(5));
    expect(epoch()).toBe(2);
  });

  it('is part of the replay log: re-simulation reproduces the hash, dropping the settle diverges', () => {
    const out: WorkerToMain[] = [];
    const host = new WorkerHost((m) => {
      if (m.type === 'snapshot') host.handle({ type: 'returnBuffer', buffer: m.buffer });
      else out.push(m);
    }, { now: () => 0, schedule: () => {} });
    const send = (m: MainToWorker): void => host.handle(m);
    send({ type: 'init', seed: 11, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 8, nodeCapacity: 8192, beamCapacity: 32768 } });
    send({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
    // A 4 m drop (the rigid body shell rides out 2 m untouched): without the window it yields beams, with it nothing yields.
    send({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [0, 4, 0], quat: [0, 0, 0, 1] }, catalogId: 'sedan', settle: 1 });
    host.runSteps(1500);
    send({ type: 'reset', objectId: 1, transform: { pos: [3, 4, 2], quat: [0, Math.sin(1), 0, Math.cos(1)] }, settle: 1 });
    host.runSteps(1500);
    send({ type: 'input', objectId: 1, actions: { throttle: 0.5, gearSelect: 1 } });
    host.runSteps(1000);
    const hash = hashSimState(host.engine!);
    send({ type: 'replayFileRequest', requestId: 1 });
    const file = (out.filter((m) => m.type === 'replayFile').pop() as Extract<WorkerToMain, { type: 'replayFile' }>).file;
    expect(file.commands.filter((c) => 'settle' in c.cmd && (c.cmd as { settle?: number }).settle === 1).length).toBe(2);
    expect(resimulate(file).hash).toBe(hash);
    const stripped: ReplayFile = {
      ...file,
      commands: file.commands.map((c) => {
        if (!('settle' in c.cmd)) return c;
        const { settle: _drop, ...cmd } = c.cmd as typeof c.cmd & { settle?: number };
        return { ...c, cmd: cmd as typeof c.cmd };
      }),
    };
    expect(resimulate(stripped).hash).not.toBe(hash);
  }, 120_000);
});
