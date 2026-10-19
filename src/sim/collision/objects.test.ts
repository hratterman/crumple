/**
 * Node-vs-node contact (P5, U1): the sedan against catalog props, stacks,
 * breakaway posts, tunnelling, canonical pair order, determinism.
 */
import { describe, expect, it } from 'vitest';
import { BufferPool, SnapshotWriter } from '../../protocol/codec';
import { computeSnapshotLayout } from '../../protocol/layout';
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { compilePropRig } from '../props/catalog';
import type { PropKey } from '../props/types';
import { SEDAN } from '../vehicle/defs/sedan';
import { kinematics, setMotion, type HandlingSim } from '../vehicle/handling';
import type { SimState } from '../types';

const CAP = { maxObjects: 64, nodeCapacity: 8192, beamCapacity: 32768 };
const PID = PROP_DYNAMIC_ID_BASE;

interface PropAt {
  key: PropKey;
  x: number;
  z: number;
  y?: number;
  asleep?: boolean;
}

/** Sedan at the origin facing −Z (front bumper z ≈ −2.3) on asphalt, props placed, settled 0.5 s. */
function scene(props: PropAt[]): HandlingSim {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
  eng.setGroundPlane(0, MaterialId.asphalt);
  const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] });
  const veh = eng.getVehicle(1)!;
  props.forEach((p, i) => eng.spawnProp(PID + i, p.key, { pos: [p.x, p.y ?? 0, p.z], quat: [0, 0, 0, 1] }, p.asleep ?? true));
  for (let i = 0; i < 1000; i++) eng.step();
  return { eng, obj, veh, cv: veh.vehicle, objectId: 1 };
}

function centroid(eng: SimEngine, id: number): { x: number; y: number; z: number } {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    if (s.invMass[i] === 0) continue;
    x += s.posX[i]!;
    y += s.posY[i]!;
    z += s.posZ[i]!;
    n++;
  }
  return { x: x / n, y: y / n, z: z / n };
}

function carFrontZ(sim: HandlingSim): number {
  const s = sim.eng.state;
  let z = Infinity;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) z = Math.min(z, s.posZ[i]!);
  return z;
}

function allFinite(s: SimState): boolean {
  for (let i = 0; i < s.nodeCount; i++) {
    if (!Number.isFinite(s.posX[i]!) || !Number.isFinite(s.posY[i]!) || !Number.isFinite(s.posZ[i]!)) return false;
  }
  return true;
}

function plasticBeams(eng: SimEngine, id: number): { plastic: number; broken: number; maxStrain: number } {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let plastic = 0;
  let broken = 0;
  let maxStrain = 0;
  for (let b = o.beamStart; b < o.beamStart + o.beamCount; b++) {
    if (s.active[b] === 0) broken++;
    else if (s.restLen[b] !== s.restLen0[b]) {
      plastic++;
      maxStrain = Math.max(maxStrain, Math.abs(s.restLen[b]! / s.restLen0[b]! - 1));
    }
  }
  return { plastic, broken, maxStrain };
}

function hash(s: SimState): string {
  let h = 0x811c9dc5;
  for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.restLen, s.active]) {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i]!, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const CONE_GRID: PropAt[] = [];
for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) CONE_GRID.push({ key: 'cone', x: (a - 1) * 0.6, z: -6 - b * 0.6 });

describe('node-vs-node contact: sedan vs props', () => {
  it('30 km/h into a 3 × 3 cone cluster scatters them; nothing explodes', () => {
    const sim = scene(CONE_GRID);
    const eng = sim.eng;
    const before = CONE_GRID.map((_, i) => centroid(eng, PID + i));
    setMotion(sim, 30 / 3.6);
    let impacts = 0;
    for (let t = 0; t < 3000; t++) {
      eng.step();
      for (let k = 0; k < eng.events.impactCount; k++) if (eng.events.impacts[9 * k + 1]! >= MaterialId.metal) impacts++;
      eng.events.clear();
    }
    expect(allFinite(eng.state)).toBe(true);
    const after = CONE_GRID.map((_, i) => centroid(eng, PID + i));
    const moved = after.filter((c, i) => Math.hypot(c.x - before[i]!.x, c.z - before[i]!.z) > 1).length;
    const toppled = after.filter((c) => c.y < 0.2).length;
    expect(moved).toBeGreaterThanOrEqual(8);
    expect(toppled).toBeGreaterThanOrEqual(3);
    expect(impacts).toBeGreaterThan(9); // car ↔ cone impact events (both objects)
    // The car keeps most of its speed (36 kg of cones vs 1450 kg).
    const k = kinematics(sim);
    expect(Math.hypot(k.vx, k.vz)).toBeGreaterThan(0.6 * (30 / 3.6));
    expect(eng.contacts.stats.overflow).toBe(0);
  }, 60_000);

  it('30 km/h into a barrel dents it (plastic shell) without tearing it apart', () => {
    const sim = scene([{ key: 'barrel', x: 0, z: -6 }]);
    setMotion(sim, 30 / 3.6);
    for (let t = 0; t < 2000; t++) sim.eng.step();
    expect(allFinite(sim.eng.state)).toBe(true);
    const d = plasticBeams(sim.eng, PID);
    expect(d.plastic).toBeGreaterThanOrEqual(8);
    expect(d.maxStrain).toBeGreaterThan(0.02);
    expect(d.broken).toBeLessThan(10);
  }, 60_000);

  it('a sign post snaps at its anchor at 50 km/h but not at walking pace; a light pole snaps at 50 km/h', () => {
    const slow = scene([{ key: 'signPost', x: 0, z: -4 }]);
    setMotion(slow, 5 / 3.6);
    for (let t = 0; t < 3000; t++) slow.eng.step();
    const s0 = slow.eng.getProp(PID)!;
    const anchorsSlow = Array.from(s0.anchorBeams).filter((b) => slow.eng.state.active[slow.eng.arena.get(PID)!.beamStart + b] === 0).length;
    expect(anchorsSlow).toBe(0);

    for (const key of ['signPost', 'lightPole'] as const) {
      const sim = scene([{ key, x: 0, z: -6 }]);
      const o = sim.eng.arena.get(PID)!;
      const rt = sim.eng.getProp(PID)!;
      setMotion(sim, 50 / 3.6);
      let snappedAt = -1;
      for (let t = 0; t < 2000; t++) {
        sim.eng.step();
        if (snappedAt < 0 && rt.anchorBeams.some((b) => sim.eng.state.active[o.beamStart + b] === 0)) snappedAt = t;
      }
      expect(snappedAt, key).toBeGreaterThan(0);
      // Breakaway: the whole anchor released, the post fell (its top came well down).
      expect(Array.from(rt.anchorBeams).every((b) => sim.eng.state.active[o.beamStart + b] === 0), key).toBe(true);
      const top = o.nodeStart + compilePropRig(key).nodeIds.indexOf(key === 'signPost' ? 'post_2_0' : 'pole_4_0');
      expect(sim.eng.state.posY[top]!, key).toBeLessThan(key === 'signPost' ? 2.0 : 5.0);
      expect(allFinite(sim.eng.state)).toBe(true);
    }
  }, 120_000);

  it.each([['boxWood'], ['boxCardboard']] as const)('100 km/h into a %s: no pass-through', (key) => {
    const sim = scene([{ key, x: 0, z: -12 }]);
    const eng = sim.eng;
    setMotion(sim, 100 / 3.6);
    let hit = false;
    for (let t = 0; t < 1500; t++) {
      eng.step();
      const c = centroid(eng, PID);
      const front = carFrontZ(sim);
      if (front < c.z + 1) hit = true;
      // The box never ends up inside / behind the car's front.
      if (hit) expect(c.z, `tick ${t}`).toBeLessThan(front + 0.35);
    }
    expect(hit).toBe(true);
    expect(allFinite(eng.state)).toBe(true);
  }, 60_000);
});

describe('node-vs-node contact: stacks, order, determinism', () => {
  it('an awake 3-box cardboard stack and a tyre stack stand on each other without sinking or jitter', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: CAP });
    eng.setGroundPlane(0, MaterialId.concrete);
    for (let l = 0; l < 3; l++) eng.spawnProp(PID + l, 'boxCardboard', { pos: [0, l * 0.6, 0], quat: [0, 0, 0, 1] }, false);
    for (let l = 0; l < 3; l++) eng.spawnProp(PID + 3 + l, 'tire', { pos: [3, l * 0.2, 0], quat: [0, 0, 0, 1] }, false);
    for (let t = 0; t < 1200; t++) eng.step();
    for (let l = 0; l < 3; l++) {
      const c = centroid(eng, PID + l);
      expect(c.y).toBeGreaterThan(0.3 + l * 0.6 - 0.04);
      expect(Math.hypot(c.x, c.z)).toBeLessThan(0.02);
      const t = centroid(eng, PID + 3 + l);
      expect(t.y).toBeGreaterThan(0.1 + l * 0.2 - 0.03);
    }
    // Still → they fall asleep together (and stay asleep: nothing moving wakes them).
    for (let t = 0; t < 4000; t++) eng.step();
    for (const o of eng.objects) expect(o.flags & 1).toBe(1);
  }, 60_000);

  it('pairs are canonical: lower object node first, sorted by (a, b), never same-object', () => {
    const sim = scene(CONE_GRID);
    setMotion(sim, 30 / 3.6);
    const c = sim.eng.contacts;
    let checked = 0;
    for (let t = 0; t < 1400; t++) {
      sim.eng.step();
      for (let i = 0; i < c.pairCount; i++) {
        expect(c.pairIdA[i]!).toBeLessThan(c.pairIdB[i]!);
        expect(c.pairA[i]!).toBeLessThan(c.pairB[i]!);
        if (i > 0) expect(c.pairA[i - 1]! < c.pairA[i]! || (c.pairA[i - 1] === c.pairA[i] && c.pairB[i - 1]! < c.pairB[i]!)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  }, 60_000);

  it('is deterministic with contacts (same hash with and without snapshot writes)', () => {
    const run = (snapshots: boolean) => {
      const sim = scene([...CONE_GRID, { key: 'barrel', x: 1.2, z: -9 }, { key: 'boxCardboard', x: -1.2, z: -9 }]);
      const eng = sim.eng;
      const layout = computeSnapshotLayout(CAP.maxObjects, CAP.nodeCapacity, CAP.beamCapacity, false);
      const pool = new BufferPool(layout.totalBytes);
      const writer = new SnapshotWriter(layout);
      setMotion(sim, 40 / 3.6);
      eng.setInput(1, { steer: 0.3 });
      for (let t = 0; t < 2500; t++) {
        eng.step();
        if (snapshots && t % 17 === 0) {
          const buf = pool.acquire()!;
          writer.attach(buf);
          eng.writeSnapshot(writer);
          pool.release(buf);
        }
      }
      return { h: hash(eng.state), pairs: eng.contacts.stats.rebuilds };
    };
    const a = run(false);
    const b = run(false);
    const c = run(true);
    expect(b.h).toBe(a.h);
    expect(c.h).toBe(a.h);
    expect(a.pairs).toBeGreaterThan(100);
  }, 120_000);

  it('cost: sedan driving through 40 props (report ns per candidate pair, ms per sim second)', () => {
    // 40 props within a few metres of the car's path: cone slalom, barrels, box stacks, tyres, a sign.
    const props: PropAt[] = [];
    for (let i = 0; i < 12; i++) props.push({ key: 'cone', x: (i % 2 ? 1 : -1) * 1.6, z: -5 - i * 1.5 });
    for (let i = 0; i < 8; i++) props.push({ key: 'barrel', x: (i % 2 ? 1 : -1) * 2.6, z: -6 - i * 2.2 });
    for (let i = 0; i < 8; i++) props.push({ key: 'boxCardboard', x: -3.5 + (i % 4) * 0.62, y: 0, z: -14 - Math.floor(i / 4) * 0.62 });
    for (let i = 0; i < 9; i++) props.push({ key: 'tire', x: 3.4, y: (i % 3) * 0.2, z: -6 - Math.floor(i / 3) * 0.7 });
    props.push({ key: 'signPost', x: -2.6, z: -20 }, { key: 'boxWood', x: 0.3, z: -24 }, { key: 'concreteBlock', x: 2.5, z: -24 });
    expect(props).toHaveLength(40);
    const sim = scene(props);
    const eng = sim.eng;
    const c = eng.contacts;
    // Wake everything so the measurement covers 40 AWAKE props near the car.
    for (const o of eng.objects) eng.setAsleep(o, false);
    setMotion(sim, 30 / 3.6);
    c.profile = true;
    const steps = 4000; // 2 s
    const t0 = performance.now();
    let maxPairs = 0;
    for (let t = 0; t < steps; t++) {
      eng.step();
      if (c.pairCount > maxPairs) maxPairs = c.pairCount;
      eng.events.clear();
    }
    const total = performance.now() - t0;
    const st = c.stats;
    const perSimS = (ms: number) => (ms / steps) * 2000;
    const nsPerTest = (st.rebuildMs * 1e6) / Math.max(1, st.testsTotal);
    const nsPerPairTick = (st.applyMs * 1e6) / Math.max(1, st.pairTicks);
    console.log(
      `[contact cost] sedan + 40 awake props, 2 s @ 2 kHz: step total ${perSimS(total).toFixed(0)} ms/sim-s; ` +
        `contacts ${perSimS(st.rebuildMs + st.applyMs).toFixed(1)} ms/sim-s (rebuild ${perSimS(st.rebuildMs).toFixed(1)}, apply ${perSimS(st.applyMs).toFixed(1)}); ` +
        `${st.rebuilds} rebuilds, ${(st.testsTotal / st.rebuilds).toFixed(0)} candidate tests/rebuild at ${nsPerTest.toFixed(1)} ns each; ` +
        `${(st.pairTicks / steps).toFixed(0)} pairs/tick (max ${maxPairs}) at ${nsPerPairTick.toFixed(1)} ns per pair-tick; overflow ${st.overflow}`,
    );
    expect(allFinite(eng.state)).toBe(true);
    expect(st.overflow).toBe(0);
    // Generous regression ceilings (loaded CI machines): contacts well under the step total.
    expect(st.rebuildMs + st.applyMs).toBeLessThan(0.5 * total);
  }, 120_000);
});
