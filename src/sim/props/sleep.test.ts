/**
 * Prop sleep / wake (P5, U1): props settle and fall asleep, a moving object
 * wakes what it can reach (a stack wakes together), still neighbours do not
 * ping-pong, sleeping props cost ~nothing.
 */
import { describe, expect, it } from 'vitest';
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { SIM_OBJECT_FLAG_SLEEPING } from '../types';
import { SEDAN } from '../vehicle/defs/sedan';
import { setMotion } from '../vehicle/handling';

const CAP = { maxObjects: 320, nodeCapacity: 32768, beamCapacity: 131072 };
const PID = PROP_DYNAMIC_ID_BASE;
const at = (x: number, y: number, z: number) => ({ pos: [x, y, z] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] });

function engine(): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
  eng.setGroundPlane(0, MaterialId.concrete);
  return eng;
}
const asleep = (eng: SimEngine, id: number) => (eng.arena.get(id)!.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;

describe('prop sleep / wake', () => {
  it('a dropped barrel settles, then sleeps after holdS of stillness: velocities zeroed, frozen', () => {
    const eng = engine();
    eng.spawnProp(PID, 'barrel', at(0, 0.5, 0), false);
    let sleptAt = -1;
    for (let t = 0; t < 12000 && sleptAt < 0; t++) {
      eng.step();
      if (asleep(eng, PID)) sleptAt = t;
    }
    expect(sleptAt).toBeGreaterThan(0.75 * 2000); // fall + settle + hold
    expect(sleptAt).toBeLessThan(5 * 2000);
    const o = eng.arena.get(PID)!;
    const s = eng.state;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) expect(s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2).toBe(0);
    const y = s.posY.slice(o.nodeStart, o.nodeStart + o.nodeCount);
    for (let t = 0; t < 500; t++) eng.step();
    expect(s.posY.slice(o.nodeStart, o.nodeStart + o.nodeCount)).toEqual(y);
  }, 60_000);

  it('a moving car wakes a sleeping cone before touching it; a sleeping stack wakes together', () => {
    const eng = engine();
    eng.spawnVehicle(1, SEDAN, at(0, 0, 0));
    eng.spawnProp(PID, 'cone', at(0, 0, -5));
    for (let l = 0; l < 3; l++) eng.spawnProp(PID + 1 + l, 'boxCardboard', at(0.2, l * 0.6, -9));
    for (let t = 0; t < 1000; t++) eng.step();
    for (let i = 0; i < 4; i++) expect(asleep(eng, PID + i)).toBe(true);
    const veh = eng.getVehicle(1)!;
    const sim = { eng, obj: eng.arena.get(1)!, veh, cv: veh.vehicle, objectId: 1 };
    setMotion(sim, 5);
    let wokeAt = -1;
    let touchedAt = -1;
    const s = eng.state;
    const car = eng.arena.get(1)!;
    for (let t = 0; t < 4000; t++) {
      eng.step();
      if (wokeAt < 0 && !asleep(eng, PID)) wokeAt = t;
      if (touchedAt < 0 && eng.contacts.stats.active > 0) touchedAt = t;
      if (!asleep(eng, PID + 1)) {
        // The whole stack woke in the same rebuild.
        expect(asleep(eng, PID + 2)).toBe(false);
        expect(asleep(eng, PID + 3)).toBe(false);
      }
    }
    expect(wokeAt).toBeGreaterThan(0);
    expect(touchedAt).toBeGreaterThan(wokeAt);
    let front = Infinity;
    for (let i = car.nodeStart; i < car.nodeStart + car.nodeCount; i++) front = Math.min(front, s.posZ[i]!);
    expect(front).toBeLessThan(-9); // the car reached the stack
    expect(asleep(eng, PID + 1) || asleep(eng, PID + 2) || asleep(eng, PID + 3)).toBe(false);
  }, 60_000);

  it('still neighbours do not keep waking each other (a resting stack sleeps for good)', () => {
    const eng = engine();
    for (let l = 0; l < 3; l++) eng.spawnProp(PID + l, 'tire', at(0, l * 0.2, 0), false);
    eng.spawnProp(PID + 3, 'boxWood', at(0.75, 0, 0), false);
    for (let t = 0; t < 8000; t++) eng.step();
    for (let i = 0; i < 4; i++) expect(asleep(eng, PID + i)).toBe(true);
    let wakes = 0;
    for (let t = 0; t < 4000; t++) {
      eng.step();
      for (let i = 0; i < 4; i++) if (!asleep(eng, PID + i)) wakes++;
    }
    expect(wakes).toBe(0);
  }, 60_000);

  it('sleeping props cost ~nothing: 200 sleeping props add < 25 µs per tick of broadphase', () => {
    const eng = engine();
    eng.spawnVehicle(1, SEDAN, at(0, 0, 0));
    for (let i = 0; i < 200; i++) eng.spawnProp(PID + i, i % 2 ? 'cone' : 'barrel', at(20 + (i % 20) * 2, 0, 20 + Math.floor(i / 20) * 2));
    for (let t = 0; t < 400; t++) eng.step();
    eng.contacts.profile = true;
    const steps = 4000;
    for (let t = 0; t < steps; t++) eng.step();
    const st = eng.contacts.stats;
    const usPerTick = ((st.rebuildMs + st.applyMs) * 1000) / steps;
    console.log(`[sleep cost] sedan + 200 sleeping props: contacts ${usPerTick.toFixed(2)} µs/tick, ${st.pairs} pairs`);
    expect(st.pairs).toBe(0);
    expect(usPerTick).toBeLessThan(25);
    for (let i = 0; i < 200; i++) expect(asleep(eng, PID + i)).toBe(true);
  }, 120_000);
});
