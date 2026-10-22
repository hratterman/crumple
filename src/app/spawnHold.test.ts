/**
 * Spawn parking-brake hold: SpawnHold's release rules, and on the real
 * Hollow Creek trailhead spawn (≈ 10° grade) every player vehicle placed the
 * way main places it, with the hold's actions sent through `input` like main
 * does, stays within 5 cm for 5 s, then drives off on throttle.
 */
import { describe, expect, it } from 'vitest';

import { placeOnGround } from './spawn';
import { SPAWN_HOLD_BRAKE, SpawnHold } from './spawnHold';
import { GAME_CAPACITY, SPAWN_SETTLE_S, type ActionState, type WorkerToMain } from '../protocol/messages';
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

const idle = (): ActionState => ({ throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1, horn: 0 });

describe('SpawnHold', () => {
  it('holds the handbrake until the player touches a control, then passes input through', () => {
    const h = new SpawnHold();
    const a = idle();
    expect(h.apply(a)).toBe(a); // not armed
    h.arm();
    const held = h.apply(a);
    expect(held.handbrake).toBe(1);
    expect(held.brake).toBe(SPAWN_HOLD_BRAKE);
    expect(a.handbrake).toBe(0); // input untouched
    expect(h.apply({ ...a, steer: 0.01 }).handbrake).toBe(1); // below the epsilon
    for (const k of [{ throttle: 0.3 }, { brake: 0.5 }, { steer: -0.2 }, { handbrake: 1 }, { gearSelect: -1 }]) {
      h.arm();
      h.apply(a);
      const x = { ...a, ...k };
      expect(h.apply(x)).toBe(x);
      expect(h.active).toBe(false);
      expect(h.apply(a)).toBe(a); // stays released
    }
  });
});

describe('spawn hold on the trailhead slope', () => {
  const FLEET: [string, VehicleDef][] = [
    ['sedan', SEDAN],
    ['coupe', COUPE],
    ['pickup', PICKUP],
    ['boxtruck', BOXTRUCK],
    ['beater', BEATER],
  ];
  for (const [name, def] of FLEET) {
    it(`${name}: stays put for 5 s, then drives off`, { timeout: 300_000 }, () => {
      const terrain = valleyTerrain();
      const out: WorkerToMain[] = [];
      let ref: WorkerHost | null = null;
      const host = new WorkerHost(
        (m) => {
          if (m.type === 'snapshot') ref?.handle({ type: 'returnBuffer', buffer: m.buffer });
          else out.push(m);
        },
        { now: () => 0, schedule: () => {} },
        { generateTerrain: () => terrain, hashTerrain },
      );
      ref = host;
      host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
      host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
      const eng = host.engine!;
      const sp = terrain.spawns.find((s) => s.id === 'dirtTrail')!;
      const cv = compileVehicle(def);
      const t = placeOnGround(cv.rig, eng.sampler!, sp.pos[0], sp.pos[2], sp.yaw);
      // The ground really is steep here (the placement tilt ≈ the grade).
      const tilt = Math.acos(1 - 2 * (t.quat[0] * t.quat[0] + t.quat[2] * t.quat[2]));
      expect(tilt).toBeGreaterThan((8 * Math.PI) / 180);
      // Main: spawn with the settle window, arm the hold and send it at once, then filter every frame.
      host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: def, transform: t, transmission: 'auto', catalogId: name, settle: SPAWN_SETTLE_S });
      const hold = new SpawnHold();
      hold.arm();
      host.handle({ type: 'input', objectId: 1, actions: { handbrake: 1, brake: SPAWN_HOLD_BRAKE } });
      const origin = cv.frameNodes[0]!;
      const pos = (): [number, number, number] => {
        const g = eng.arena.get(1)!.nodeStart + origin;
        return [eng.state.posX[g]!, eng.state.posY[g]!, eng.state.posZ[g]!];
      };
      const frames = (n: number, player: ActionState): void => {
        for (let f = 0; f < n; f++) {
          host.handle({ type: 'input', objectId: 1, actions: { ...hold.apply(player) } });
          for (let k = 0; k < 33; k++) eng.step(); // ~60 Hz frames
          eng.events.clear();
        }
      };
      frames(30, idle()); // 0.5 s: settle window + onto the suspension
      const p0 = pos();
      frames(153, idle());
      const pm = pos();
      frames(120, idle()); // + 4.5 s → 5 s after the spawn
      const p1 = pos();
      const late = Math.hypot(p1[0] - pm[0], p1[1] - pm[1], p1[2] - pm[2]);
      const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      expect(hold.active).toBe(true);
      // Throttle releases the hold and the car drives off (uphill or down, whichever way it faces).
      frames(240, { ...idle(), throttle: 0.6 });
      const p2 = pos();
      const drove = Math.hypot(p2[0] - p1[0], p2[2] - p1[2]);
      const g = eng.arena.get(1)!.nodeStart + origin;
      const speed = Math.hypot(eng.state.velX[g]!, eng.state.velZ[g]!);
      console.log(`[hold] ${name.padEnd(8)} tilt ${((tilt * 180) / Math.PI).toFixed(1)}°  moved ${(moved * 100).toFixed(2)} cm in 4.5 s held (${(late * 100).toFixed(2)} cm in the last 2 s)  then ${drove.toFixed(1)} m in 4 s at throttle 0.6 (${(speed * 3.6).toFixed(0)} km/h)`);
      expect(out.filter((m) => m.type === 'error' || m.type === 'fatal')).toEqual([]);
      expect(hold.active).toBe(false);
      expect(moved).toBeLessThan(0.05);
      expect(late).toBeLessThan(0.01); // settled, not creeping
      expect(drove).toBeGreaterThan(3);
      // R-TYRE: 2 → 1.5 m/s. The trail is soft soil now (dirt: C_rr ≈ 0.026, grip rising with slip): the beater
      // (FWD, open diff) climbs the 10° trail at 7 km/h (1.96 m/s) after 4 s at 0.6 throttle, the others faster
      expect(speed).toBeGreaterThan(1.5);
    });
  }
});
