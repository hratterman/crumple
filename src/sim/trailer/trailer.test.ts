/**
 * Trailers, couplings and cargo (R-PHYS2): rig validity, tongue weight,
 * towing, hitch failure + safety chains, cargo on a deck (rests, slides
 * under braking unless strapped, falls out over an opened gate), and a
 * deterministic re-simulation of a ReplayFile with trailer + cargo commands.
 */
import { describe, expect, it, vi } from 'vitest';
import { MaterialId, PROP_DYNAMIC_ID_BASE, SOLVER_PRESETS, type MainToWorker, type WorkerToMain } from '../../protocol/messages';
import { SimEngine } from '../engine';
import { hashSimState } from '../replay/hash';
import { resimulate } from '../replay/resim';
import { compileVehicle, validateVehicle } from '../vehicle/builder';
import { PICKUP } from '../vehicle/defs/pickup';
import { WorkerHost } from '../worker';
import { buildTrailer, HITCH, SAFETY_CHAIN } from './defs';
import { JointKind, JointSet } from './joints';
import { runSway } from './sway';

// Full rigs (pickup + trailer + cargo) at 2 kHz for 5–10 s per case: 10–15 s alone, several × on a loaded box.
vi.setConfig({ testTimeout: 240_000 });

const G = 9.81;
const PID = PROP_DYNAMIC_ID_BASE;

function rig(): { eng: SimEngine } {
  const eng = new SimEngine({ gravity: [0, -G, 0], debugStrains: false, capacity: { maxObjects: 16, nodeCapacity: 8192, beamCapacity: 32768 } });
  eng.setGroundPlane(0, MaterialId.asphalt);
  eng.spawnVehicle(1, PICKUP, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] }, 'auto');
  eng.setInput(1, { handbrake: 1, brake: 0.5 });
  for (let t = 0; t < 1000; t++) eng.step();
  return { eng };
}

function com(eng: SimEngine, id: number): [number, number, number, number] {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    if (s.invMass[i] === 0) continue;
    const mi = 1 / s.invMass[i]!;
    m += mi;
    x += mi * s.posX[i]!;
    y += mi * s.posY[i]!;
    z += mi * s.posZ[i]!;
  }
  return [x / m, y / m, z / m, m];
}

describe('trailer rigs', () => {
  it('validate within the traffic-size beam budget with realistic masses', () => {
    for (const [kind, lo, hi] of [
      ['utility', 280, 420],
      ['box', 850, 1100],
    ] as const) {
      const def = buildTrailer(kind);
      const rep = validateVehicle(def, 1500);
      expect(rep.ok, `${kind}: ${rep.errors.join('; ')}`).toBe(true);
      const cv = compileVehicle(def);
      expect(cv.totalMass, kind).toBeGreaterThan(lo);
      expect(cv.totalMass, kind).toBeLessThan(hi);
      expect(cv.rig.beamCount, kind).toBeLessThan(1000);
    }
  });
});

describe('towing', () => {
  it('hitched to the pickup: ≈ 10 % tongue weight at rest, follows a launch on a tight coupling, chains slack', () => {
    const { eng } = rig();
    eng.spawnTrailer(2, 'utility', { towObjectId: 1 });
    for (let t = 0; t < 3000; t++) eng.step();
    const link = eng.towing.trailers.get(2)!;
    const mass = eng.getVehicle(2)!.vehicle.totalMass;
    const tongue = link.hitch!.fy / (mass * G);
    expect(tongue).toBeGreaterThan(0.07);
    expect(tongue).toBeLessThan(0.15);
    eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 0.6 });
    let maxGap = 0;
    const s = eng.state;
    const h = link.hitch!;
    for (let t = 0; t < 6000; t++) {
      eng.step();
      const a = h.objA.nodeStart + h.nodeA;
      const b = h.objB.nodeStart + h.nodeB;
      maxGap = Math.max(maxGap, Math.hypot(s.posX[a]! - s.posX[b]!, s.posY[a]! - s.posY[b]!, s.posZ[a]! - s.posZ[b]!));
    }
    // 3 s of full-ish throttle: the combination moved off together.
    expect(com(eng, 2)[2]).toBeLessThan(-6);
    expect(h.broken).toBe(false);
    expect(maxGap).toBeLessThan(0.02);
    for (const c of link.chains) expect(c.force).toBe(0);
  });

  it('a ball joint breaks above its rating; the crossed safety chains catch the tongue', () => {
    const { eng } = rig();
    eng.spawnTrailer(2, 'utility', { towObjectId: 1 });
    for (let t = 0; t < 2000; t++) eng.step();
    const link = eng.towing.trailers.get(2)!;
    // A weak ball (a failing mount) under a hard launch.
    link.hitch!.breakF = 1500;
    eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 1 });
    for (let t = 0; t < 4000; t++) eng.step();
    expect(link.hitch!.broken).toBe(true);
    // The chains now tow it: still following, not left behind.
    const peak = Math.max(...link.chains.map((c) => c.peak));
    expect(peak).toBeGreaterThan(200);
    expect(peak).toBeLessThan(SAFETY_CHAIN.breakF);
    const gap = com(eng, 2)[2] - com(eng, 1)[2];
    // (coupled the COMs are ≈ 5.7 m apart; the chains' slack lets it trail ≈ 0.5 m more, never more)
    expect(gap).toBeLessThan(7);
  });

  it('joint law: an implicit link holds any stiffness without blowing up and breaks at breakF', () => {
    const eng = new SimEngine({ gravity: [0, -G, 0], debugStrains: false });
    eng.setGroundPlane(0, MaterialId.concrete);
    eng.spawnProp(PID, 'concreteBlock', { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, false);
    eng.spawnProp(PID + 1, 'boxWood', { pos: [0, 0, 2], quat: [0, 0, 0, 1] }, false);
    const set = eng.towing.joints;
    const a = eng.arena.get(PID)!;
    const b = eng.arena.get(PID + 1)!;
    const j = set.add({ kind: JointKind.rope, tag: 't', objA: a, nodeA: 0, objB: b, nodeB: 0, k: 1e9, c: 1e4, rest: 1.6, play: 0, breakF: 2500 });
    // Throw the crate away: the rope snaps taut (impulse ≫ 2.5 kN) and breaks.
    const s = eng.state;
    for (let i = b.nodeStart; i < b.nodeStart + b.nodeCount; i++) s.velZ[i] = 6;
    for (let t = 0; t < 2000; t++) eng.step();
    expect(j.broken).toBe(true);
    for (let i = 0; i < s.nodeCount; i++) expect(Number.isFinite(s.posX[i]!)).toBe(true);
    expect(set instanceof JointSet).toBe(true);
    expect(HITCH.breakF).toBeGreaterThan(4e4);
  });
});

describe('physics quality', () => {
  it('high (triangle contact): trailer and tow stay on spheres (the tongue under the bumper), a tight turn loads the hitch < 10 kN', () => {
    const { eng } = rig();
    eng.setSolver(SOLVER_PRESETS.high);
    eng.spawnTrailer(2, 'utility', { towObjectId: 1 });
    for (let t = 0; t < 3000; t++) eng.step();
    const link = eng.towing.trailers.get(2)!;
    eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 0.6, steer: 0.6 });
    let peak = 0;
    for (let t = 0; t < 8000; t++) {
      eng.step();
      peak = Math.max(peak, link.hitch!.force);
    }
    // (Triangle contact between the drawbar and the bumper fought the coupling at 44 kN.)
    expect(peak).toBeLessThan(10_000);
    expect(link.hitch!.broken).toBe(false);
  });
});

describe('cargo', () => {
  /** Pickup towing a utility trailer with crates on its deck (one strapped). */
  function loaded(strapSecond: boolean): SimEngine {
    const { eng } = rig();
    eng.spawnTrailer(2, 'utility', { towObjectId: 1 });
    for (let t = 0; t < 1000; t++) eng.step();
    eng.spawnCargo([
      { objectId: PID, prop: 'boxWood', carrierObjectId: 2, pos: [0, 0.62, -0.7] },
      { objectId: PID + 1, prop: 'boxWood', carrierObjectId: 2, pos: [0, 0.62, 0.6], strap: strapSecond },
    ]);
    for (let t = 0; t < 2000; t++) eng.step();
    return eng;
  }

  function onDeck(eng: SimEngine, id: number): [number, number] {
    const c = com(eng, id);
    const t = eng.getVehicle(2)!;
    const s = eng.state;
    const o = t.nodeStart + t.vehicle.rig.nodeIds.indexOf('dk2');
    return [c[1] - s.posY[o]!, c[2] - s.posZ[o]!];
  }

  it('crates rest on the deck (surface contact, no sinking between deck nodes) and ride along', () => {
    const eng = loaded(false);
    const [dy] = onDeck(eng, PID);
    // Crate centre 0.4 m above the deck surface (≈ 0.02 above the dk nodes).
    expect(dy).toBeGreaterThan(0.38);
    expect(dy).toBeLessThan(0.5);
    eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 0.4 });
    const z0 = onDeck(eng, PID)[1];
    const w0 = com(eng, PID)[2];
    for (let t = 0; t < 4000; t++) eng.step();
    // Gentle launch: μ ≈ 0.6 holds the crate (it barely moves on the deck).
    expect(Math.abs(onDeck(eng, PID)[1] - z0)).toBeLessThan(0.1);
    expect(w0 - com(eng, PID)[2]).toBeGreaterThan(1.5);
  });

  it('a hard stop slides the loose crate forward; the strapped one stays', () => {
    const eng = loaded(true);
    eng.setInput(1, { handbrake: 0, brake: 0, gearSelect: 1, throttle: 1 });
    for (let t = 0; t < 8000; t++) eng.step();
    const loose0 = onDeck(eng, PID)[1];
    const tied0 = onDeck(eng, PID + 1)[1];
    eng.setInput(1, { throttle: 0, brake: 0.6 });
    let loose = 0;
    let tied = 0;
    for (let t = 0; t < 4000; t++) {
      eng.step();
      if (t % 50 === 0) {
        loose = Math.min(loose, onDeck(eng, PID)[1] - loose0);
        const d = onDeck(eng, PID + 1)[1] - tied0;
        if (Math.abs(d) > Math.abs(tied)) tied = d;
      }
    }
    // Forward = −Z: the loose crate slid ahead (to the front wall), the strapped one held.
    expect(loose).toBeLessThan(-0.1);
    expect(Math.abs(tied)).toBeLessThan(0.08);
    expect(eng.towing.cargo.get(PID + 1)!.straps.every((j) => !j.broken)).toBe(true);
  });

  it('a crate shoved rearward stops at the latched gate; with the gate down it slides out onto the road', () => {
    const run = (open: boolean) => {
      const eng = loaded(false);
      if (open) eng.setCargoDoor(2, true);
      for (let t = 0; t < 2000; t++) eng.step();
      // A 3.2 m/s rearward shove (a rear-end jolt): μ ≈ 0.6 slides it ≈ 0.85 m — past the deck's end (0.65 m).
      const o = eng.arena.get(PID + 1)!;
      for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) eng.state.velZ[i] = eng.state.velZ[i]! + 3.2;
      for (let t = 0; t < 6000; t++) eng.step();
      return eng;
    };
    const shut = run(false);
    expect(shut.towing.cargo.has(PID + 1)).toBe(true);
    expect(onDeck(shut, PID + 1)[0]).toBeGreaterThan(0.3);
    const open = run(true);
    // Out over the ramp gate, unloaded (an ordinary prop again), on the road behind the trailer.
    expect(open.towing.cargo.has(PID + 1)).toBe(false);
    expect(com(open, PID + 1)[1]).toBeLessThan(0.7);
    expect(com(open, PID + 1)[2] - com(open, 2)[2]).toBeGreaterThan(1.5);
  });
});

describe('trailer + cargo replay', () => {
  it('re-simulates a run with spawnTrailer / spawnCargo / setCargoDoor / hitchTrailer to the same hash', () => {
    const out: WorkerToMain[] = [];
    const host = new WorkerHost((m) => {
      if (m.type !== 'snapshot') out.push(m);
    }, { now: () => 0, schedule: () => {} });
    const send = (m: MainToWorker): void => host.handle(m);
    send({ type: 'init', seed: 3, gravity: [0, -G, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 16, nodeCapacity: 8192, beamCapacity: 32768 } });
    send({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
    send({ type: 'spawnVehicle', objectId: 1, vehicle: PICKUP, transform: { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] } });
    host.runSteps(800);
    send({ type: 'spawnTrailer', objectId: 2, kind: 'utility', towObjectId: 1 });
    host.runSteps(400);
    send({ type: 'spawnCargo', items: [{ objectId: PID, prop: 'barrel', carrierObjectId: 2, pos: [0, 0.62, 0], strap: true }, { objectId: PID + 1, prop: 'boxCardboard', carrierObjectId: 1, pos: [0, 0.97, 2.2] }] });
    send({ type: 'input', objectId: 1, actions: { throttle: 0.8, gearSelect: 1, steer: 0.2 } });
    host.runSteps(2000);
    send({ type: 'setCargoDoor', objectId: 2, open: true });
    send({ type: 'input', objectId: 1, actions: { throttle: 0, brake: 1, steer: 0 } });
    host.runSteps(1500);
    send({ type: 'hitchTrailer', objectId: 2, towObjectId: null });
    host.runSteps(500);
    const hash = hashSimState(host.engine!);
    send({ type: 'replayFileRequest', requestId: 1 });
    const file = (out.find((m) => m.type === 'replayFile') as Extract<WorkerToMain, { type: 'replayFile' }>).file;
    expect(out.filter((m) => m.type === 'error')).toEqual([]);
    const re = resimulate(file);
    expect(re.hash).toBe(hash);
  }, 120_000);
});

describe('trailer sway (Bundorf 1967; Darling, Tilley & Gao 2009: a critical speed that rises with nose weight)', () => {
  // Pickup + utility trailer, ESC off (pure vehicle dynamics), 0.04 steer pulse, 10 s of articulation.
  const run = (speedKmh: number, ballastKg: number, ballastZ: number) => runSway({ tow: PICKUP, kind: 'utility', speedKmh, ballastKg, ballastZ, pulse: 0.04, recordS: 10, esc: false });
  it('10 % tongue weight: damped at 100 km/h, sustained sway at 120 km/h', () => {
    const r100 = run(100, 0, 0);
    const r120 = run(120, 0, 0);
    console.log(`[sway] std: 100 km/h ${r100.early.toFixed(2)} → ${r100.late.toFixed(2)}°, 120 km/h ${r120.early.toFixed(2)} → ${r120.late.toFixed(2)}° (tongue ${r100.tongueN.toFixed(0)} N)`);
    expect(r100.late).toBeLessThan(0.3 * r100.early);
    expect(r120.late).toBeGreaterThan(0.5 * r120.early);
  }, 300_000);
  it('a tail-heavy trailer (negative tongue weight) already sways at 100 km/h', () => {
    const r = run(100, 150, 1.25);
    console.log(`[sway] tail-heavy 100 km/h: ${r.early.toFixed(2)} → ${r.late.toFixed(2)}° (tongue ${r.tongueN.toFixed(0)} N)`);
    expect(r.tongueN).toBeLessThan(0);
    expect(r.late).toBeGreaterThan(0.7 * r.early);
  }, 300_000);
});
