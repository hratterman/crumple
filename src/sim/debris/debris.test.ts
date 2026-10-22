/**
 * Debris (R-PHYS2): a part torn off a vehicle stays physical (falls, slides,
 * lands), FREEZES once it has lain still for DEBRIS_SLEEP_S (no integration
 * or contact cost), and WAKES when something moving comes near — here its own
 * car reversing onto it. Whole-wreck tumbling: the FMVSS 208 dolly rollover
 * against staged-test ranges.
 */
import { describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { SEDAN } from '../vehicle/defs/sedan';
import { runDollyRollover } from './dolly';

describe('debris islands', () => {
  it('a detached rear bumper ring falls, freezes when still, and wakes when its car backs onto it', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 16384 } });
    eng.setGroundPlane(0, MaterialId.asphalt);
    eng.spawnVehicle(1, SEDAN, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] });
    for (let t = 0; t < 1000; t++) eng.step();
    const v = eng.getVehicle(1)!;
    const s = eng.state;
    const ids = v.vehicle.rig.nodeIds;
    const ring = new Set<number>();
    for (let k = 0; k < v.vehicle.bodyNodeCount; k++) if (ids[k]!.startsWith('s13_')) ring.add(v.nodeStart + k);
    expect(ring.size).toBeGreaterThan(3);
    // Tear it off: every body beam with exactly one end on the ring.
    let cut = 0;
    for (let b = v.beamStart; b < v.beamStart + v.vehicle.bodyBeamCount; b++) {
      if (s.active[b] === 0) continue;
      if (ring.has(s.aIdx[b]!) !== ring.has(s.bIdx[b]!)) {
        s.active[b] = 0;
        cut++;
      }
    }
    expect(cut).toBeGreaterThan(0);
    // …and out of the rigid shell cluster (what the shell's release does to a part torn off in a crash).
    for (const sh of v.shell ?? []) {
      for (let k = 0; k < sh.nodes.length; k++) {
        if (!ring.has(sh.nodes[k]!)) continue;
        sh.w[k] = 0;
        sh.gone[k] = 1;
      }
    }
    const y0 = Math.min(...[...ring].map((i) => s.posY[i]!));
    for (let t = 0; t < 2 * 2000; t++) eng.step();
    const frozen = () => [...ring].every((i) => s.invMass[i] === 0);
    // It fell to the road and froze there (asleep: pinned in place, still).
    expect(Math.min(...[...ring].map((i) => s.posY[i]!))).toBeLessThan(y0 - 0.1);
    for (let t = 0; t < 2 * 2000 && !frozen(); t++) eng.step();
    expect(frozen()).toBe(true);
    for (const i of ring) expect(Number.isFinite(s.posY[i]!)).toBe(true);
    // Reverse onto it: it wakes (masses back) before the car reaches it.
    eng.setInput(1, { gearSelect: -1, throttle: 0.35, brake: 0, handbrake: 0 });
    let woke = -1;
    for (let t = 0; t < 4 * 2000 && woke < 0; t++) {
      eng.step();
      if (t % 100 === 0 && !frozen()) woke = t;
    }
    expect(woke).toBeGreaterThanOrEqual(0);
    for (const i of ring) expect(s.invMass[i]!).toBeGreaterThan(0);
  }, 120_000);
});

describe('wreck tumbling (dolly rollover)', () => {
  it('48 km/h sedan dolly rollover on soil: rolls, roll rate and decel inside staged-test ranges', () => {
    const r = runDollyRollover(SEDAN, 48, MaterialId.dirt, 7);
    console.log(
      `[dolly] sedan 48 km/h dirt: ${r.quarterTurns.toFixed(1)} quarter turns, peak ${r.peakRollRateDeg.toFixed(0)} deg/s, ${r.travel.toFixed(1)} m in ${r.duration.toFixed(2)} s, drag factor ${r.dragG.toFixed(2)}, COM bounce ${r.bounce.toFixed(2)} m, plastic ${r.plastic}`,
    );
    // Staged dolly rollovers (48 km/h passenger cars): 4–10 quarter turns, 3–5 s, peak 250–500 °/s, drag factor
    // v²/(2·g·d) 0.38–0.5.
    // (The roll count of a tumbling wreck is chaotic — small changes move it by whole quarter turns — so the band
    // is wide; it must roll over its roof at least.)
    expect(r.quarterTurns).toBeGreaterThan(3);
    expect(r.quarterTurns).toBeLessThan(11);
    expect(r.peakRollRateDeg).toBeGreaterThan(250);
    expect(r.peakRollRateDeg).toBeLessThan(600);
    expect(r.duration).toBeGreaterThan(2.5);
    expect(r.duration).toBeLessThan(6);
    expect(r.travel).toBeGreaterThan(8);
    expect(r.travel).toBeLessThan(40);
    expect(r.dragG).toBeGreaterThan(0.3);
    expect(r.dragG).toBeLessThan(0.7);
    // Roll rate decays in bursts at the ground contacts: the last second is far below the peak.
    const tail = r.rollRate.slice(Math.round((r.duration - 1) / 0.05), Math.round(r.duration / 0.05));
    expect(Math.max(...tail)).toBeLessThan(0.5 * r.peakRollRateDeg);
    expect(r.plastic).toBeGreaterThan(0);
  }, 120_000);
});
