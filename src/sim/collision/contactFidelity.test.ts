/**
 * R-CORE contact fidelity at the engine level (real rigs, real kernels):
 *  - a sedan at 250 km/h into a ZERO-THICKNESS static mesh wall: no node
 *    ever crosses the wall plane (speculative CCD);
 *  - a sedan at 250 km/h into the side of a parked traffic sedan: the cars
 *    collide instead of passing through each other (node-vs-triangle +
 *    CCD), compared with the node-vs-node spheres alone;
 *  - typical penetration depth of resting / sliding / crash contacts.
 * Numbers are logged for docs/CONTRACTS.md "R-CORE as built".
 */
import { describe, expect, it } from 'vitest';
import { MaterialId, SOLVER_PRESETS, type SolverOptions } from '../../protocol/messages';
import type { ColliderDef } from '../../world/types';
import { setDefaultSolver, SimEngine, SOLVER_DEFAULTS } from '../engine';
import { setMotion } from '../vehicle/handling';
import { runCrash } from '../vehicle/crash';
import type { RigDef } from '../rig/types';
import { deriveCollisionTriangles, setDeriveCaps } from '../rig/triangles';
import { compileVehicle } from '../vehicle/builder';
import { NODE_FLAG_COLLIDABLE } from '../types';
import { SEDAN } from '../vehicle/defs/sedan';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import type { VehicleDef } from '../vehicle/types';

const KMH = 1 / 3.6;

function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

function engine(solver: Partial<SolverOptions>): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(0, MaterialId.concrete);
  eng.setSolver(solver);
  return eng;
}

function spawnSettled(eng: SimEngine, id: number, def: VehicleDef, x: number, z: number, yaw: number): void {
  eng.spawnVehicle(id, def, { pos: [x, 0.05, z], quat: yawQuat(yaw) }, 'auto');
}

/** Every node of object `id` gets velocity v (rigid launch; wheels keep their spin 0: a sliding launch). */
function launch(eng: SimEngine, id: number, vx: number, vz: number): void {
  const obj = eng.arena.get(id)!;
  const s = eng.state;
  for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
    s.velX[i] = vx;
    s.velY[i] = 0;
    s.velZ[i] = vz;
  }
}

function com(eng: SimEngine, id: number): [number, number, number] {
  const obj = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0, x = 0, y = 0, z = 0;
  for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
    const im = s.invMass[i]!;
    if (im === 0) continue;
    const mi = 1 / im;
    m += mi;
    x += mi * s.posX[i]!;
    y += mi * s.posY[i]!;
    z += mi * s.posZ[i]!;
  }
  return [x / m, y / m, z / m];
}

function comVel(eng: SimEngine, id: number): [number, number, number] {
  const obj = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0, x = 0, y = 0, z = 0;
  for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
    const im = s.invMass[i]!;
    if (im === 0) continue;
    const mi = 1 / im;
    m += mi;
    x += mi * s.velX[i]!;
    y += mi * s.velY[i]!;
    z += mi * s.velZ[i]!;
  }
  return [x / m, y / m, z / m];
}

describe('contact fidelity (engine, real rigs)', () => {
  it('sedan at 250 km/h into a zero-thickness static mesh wall: no node crosses it', () => {
    const rows: string[] = [];
    const results: number[] = [];
    for (const ccd of [true, false]) {
      const eng = engine({ ...SOLVER_PRESETS.high, ccd });
      // Two-sided quad, 12 m wide, 6 m tall, in the plane z = −8 (the sedan drives along −Z).
      const wall: ColliderDef = {
        id: 'thinWall',
        kind: 'mesh',
        pos: [0, 3, -8],
        quat: [0, 0, 0, 1],
        size: [6, 3, 0.01],
        material: MaterialId.concrete,
        mesh: { positions: [-6, -3, 0, 6, -3, 0, 6, 3, 0, -6, 3, 0], indices: [0, 1, 2, 0, 2, 3], twoSided: true },
      };
      eng.setExtraColliders([wall]);
      spawnSettled(eng, 1, SEDAN, 0, 0, 0);
      for (let i = 0; i < 1000; i++) eng.step();
      launch(eng, 1, 0, -250 * KMH);
      const obj = eng.arena.get(1)!;
      const s = eng.state;
      let crossed = 0;
      let maxBeyond = -Infinity;
      for (let t = 0; t < 2000; t++) {
        eng.step();
        eng.events.clear();
        let c = 0;
        for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
          if ((s.flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue; // hubs / knuckle tops: no contact pass by design
          const beyond = -8 - s.posZ[i]!;
          if (beyond > maxBeyond) maxBeyond = beyond;
          if (beyond > 0) c++;
        }
        if (c > crossed) crossed = c;
      }
      const v = comVel(eng, 1);
      rows.push(`ccd ${ccd ? 'on ' : 'off'}: max collidable nodes beyond the wall ${crossed}, deepest node centre ${(100 * maxBeyond).toFixed(1)} cm past the plane, COM v_z after 1 s ${v[2].toFixed(1)} m/s`);
      results.push(crossed);
    }
    console.log(`[fidelity] 250 km/h into a zero-thickness wall:\n  ${rows.join('\n  ')}`);
    expect(results[0]).toBe(0);
  }, 120_000);

  it('sedan at 250 km/h into the side of a parked traffic sedan: the cars collide, never pass through', () => {
    const rows: string[] = [];
    const results: Record<string, { minGap: number; vB: number }> = {};
    for (const mode of ['triangles', 'spheres'] as const) {
      const eng = engine(mode === 'triangles' ? SOLVER_PRESETS.high : SOLVER_PRESETS.standard);
      spawnSettled(eng, 1, SEDAN, 0, 0, 0);
      // Parked broadside 9 m ahead: its forward axis along +X.
      spawnSettled(eng, 2, SEDAN_TRAFFIC, 0, -9, Math.PI / 2);
      for (let i = 0; i < 1000; i++) eng.step();
      launch(eng, 1, 0, -250 * KMH);
      let minGap = Infinity;
      for (let t = 0; t < 1400; t++) {
        eng.step();
        eng.events.clear();
        // A's COM ahead of B's COM along the impact axis (−Z): a pass-through drives this negative.
        const gap = com(eng, 1)[2] - com(eng, 2)[2];
        if (gap < minGap) minGap = gap;
      }
      const vB = -comVel(eng, 2)[2];
      results[mode] = { minGap, vB };
      rows.push(`${mode}: min (COM_A − COM_B) along the impact axis ${minGap.toFixed(2)} m, struck car's COM speed after 0.7 s ${vB.toFixed(1)} m/s, triangle pairs ${eng.tris.stats.pairs}`);
    }
    console.log(`[fidelity] 250 km/h into a car side (sedan 1410 kg → traffic sedan broadside):\n  ${rows.join('\n  ')}`);
    // Never through: the striking car's centre stays behind the struck car's centre, and momentum is shared.
    expect(results.triangles!.minGap).toBeGreaterThan(0);
    expect(results.triangles!.vB).toBeGreaterThan(20);
  }, 180_000);

  it('high: the sedan at 50 km/h into the side of a parked traffic sedan through triangles: no NaN, no interlock, separable', () => {
    const eng = engine(SOLVER_PRESETS.high);
    eng.setGroundPlane(0, MaterialId.asphalt);
    const h = Math.SQRT1_2;
    eng.spawnVehicle(1, SEDAN, { pos: [-3.2, 0.01, 0.3], quat: [0, -h, 0, h] });
    eng.spawnVehicle(2, SEDAN_TRAFFIC, { pos: [0, 0.01, 0], quat: [0, 0, 0, 1] });
    eng.setInput(2, { brake: 1, handbrake: 1, gearSelect: 0 });
    for (let i = 0; i < 1000; i++) eng.step();
    const p = eng.arena.get(1)!;
    const t = eng.arena.get(2)!;
    const veh = eng.getVehicle(1)!;
    setMotion({ eng, obj: p, veh, cv: veh.vehicle, objectId: 1 }, 50 / 3.6);
    const s = eng.state;
    let contacted = 0;
    let maxDepth = 0;
    for (let i = 0; i < 4000; i++) {
      eng.step();
      eng.events.clear();
      contacted = Math.max(contacted, eng.tris.stats.active);
      maxDepth = Math.max(maxDepth, eng.tris.stats.maxDepth);
    }
    for (let n = 0; n < s.nodeCount; n++) expect(Number.isFinite(s.posX[n]! + s.posY[n]! + s.posZ[n]!)).toBe(true);
    expect(eng.contacts.pairCount).toBe(0); // vehicle pairs collide through triangles at high
    expect(contacted).toBeGreaterThan(10);
    setMotion({ eng, obj: p, veh, cv: veh.vehicle, objectId: 1 }, -4);
    for (let i = 0; i < 3000; i++) {
      eng.step();
      eng.events.clear();
    }
    const box = (o: typeof p): number[] => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let n = o.nodeStart; n < o.nodeStart + o.nodeCount; n++) {
        b[0] = Math.min(b[0]!, s.posX[n]!);
        b[1] = Math.min(b[1]!, s.posZ[n]!);
        b[2] = Math.max(b[2]!, s.posX[n]!);
        b[3] = Math.max(b[3]!, s.posZ[n]!);
      }
      return b;
    };
    const a = box(p);
    const b = box(t);
    const gap = Math.max(b[0]! - a[2]!, a[0]! - b[2]!, b[1]! - a[3]!, a[1]! - b[3]!);
    console.log(`[fidelity] high, 50 km/h into a car side: max ${contacted} triangle contacts at once, max penetration ${(100 * maxDepth).toFixed(1)} cm, gap after backing out ${(100 * gap).toFixed(1)} cm`);
    expect(gap).toBeGreaterThan(0.05);
    expect(eng.tris.stats.active).toBe(0);
  }, 120_000);

  it('self-collision: a node of the same object never passes through its own triangles (and does without)', () => {
    // A pinned 2 × 2 m plate (two triangles, normal +Y) and, on the same object, a 5 kg node hung from a
    // pinned anchor by a soft beam, fired down at the plate at 15 m/s with 20 kN behind it.
    const rig: RigDef = {
      name: 'selfPlate',
      nodes: [
        { id: 'p0', pos: [-1, 0, -1], mass: 0 },
        { id: 'p1', pos: [1, 0, -1], mass: 0 },
        { id: 'p2', pos: [1, 0, 1], mass: 0 },
        { id: 'p3', pos: [-1, 0, 1], mass: 0 },
        { id: 'anchor', pos: [3, 1, 0], mass: 0 },
        { id: 'bob', pos: [0.2, 0.4, 0.1], mass: 5 },
      ],
      beams: [
        { a: 'p0', b: 'p1', type: 'normal' },
        { a: 'p1', b: 'p2', type: 'normal' },
        { a: 'p2', b: 'p3', type: 'normal' },
        { a: 'p3', b: 'p0', type: 'normal' },
        { a: 'p0', b: 'p2', type: 'normal' },
        { a: 'p1', b: 'anchor', type: 'normal' },
        { a: 'anchor', b: 'bob', type: 'normal', k: 10, d: 0 },
      ],
      triangles: [
        { a: 'p0', b: 'p2', c: 'p1' },
        { a: 'p0', b: 'p3', c: 'p2' },
      ],
    };
    const run = (self: boolean): number => {
      const eng = new SimEngine({ gravity: [0, 0, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 64, beamCapacity: 64 } });
      eng.setSolver({ triangleContact: true, selfCollision: self, ccd: true });
      const obj = eng.spawn(1, rig, { pos: [0, 1, 0], quat: [0, 0, 0, 1] });
      const bob = obj.nodeStart + 5;
      const s = eng.state;
      s.velY[bob] = -15;
      let minY = Infinity;
      for (let i = 0; i < 400; i++) {
        s.frcY[bob] = s.frcY[bob]! - 20e3;
        eng.step();
        minY = Math.min(minY, s.posY[bob]!);
      }
      return minY - 1; // relative to the plate
    };
    const withSelf = run(true);
    const without = run(false);
    console.log(`[fidelity] self-collision: lowest node centre relative to its own plate: with ${(100 * withSelf).toFixed(1)} cm, without ${(100 * without).toFixed(1)} cm`);
    expect(withSelf).toBeGreaterThan(0);
    expect(without).toBeLessThan(-0.5);
  });

  it('ultra (triangles + self-collision + CCD): the sedan crash harness stays sane', () => {
    setDefaultSolver(SOLVER_PRESETS.ultra);
    try {
      const r50 = runCrash({ kind: 'frontal', speedKmh: 50 });
      const r100 = runCrash({ kind: 'frontal', speedKmh: 100, afterContactS: 1 });
      console.log(`[fidelity] ultra sedan frontal: 50 km/h crush ${(100 * r50.crush).toFixed(1)} cm (peak ${(100 * r50.crushMax).toFixed(1)}), intrusion ${(100 * r50.intrusion).toFixed(1)} cm; 100 km/h crush ${(100 * r100.crush).toFixed(1)} cm, finite ${r100.finite}`);
      expect(r50.finite && r100.finite).toBe(true);
      expect(r50.crush).toBeGreaterThan(0.3);
      expect(r50.crush).toBeLessThan(0.65);
    } finally {
      setDefaultSolver(SOLVER_DEFAULTS);
    }
  }, 300_000);

  it('penetration: how deep the striking car gets behind the struck car\'s surface (spheres vs triangles), 50 km/h side impact', () => {
    // B's true surface = its derived collision triangles; A's collidable nodes inside a triangle's
    // projection and behind it (≤ 0.5 m) count as penetrating by that depth. Sampled every 10 ticks.
    const cvB = compileVehicle(SEDAN_TRAFFIC);
    // (the beam surface only: the caps' interior side is not "inside the car" for this measure)
    const trisB = deriveCollisionTriangles(cvB.rig, { nodeCount: cvB.bodyNodeCount, caps: false });
    const rows: string[] = [];
    const stats: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
    for (const mode of ['standard', 'high'] as const) {
      const eng = engine(SOLVER_PRESETS[mode]);
      eng.setGroundPlane(0, MaterialId.asphalt);
      const h = Math.SQRT1_2;
      eng.spawnVehicle(1, SEDAN, { pos: [-3.2, 0.01, 0.3], quat: [0, -h, 0, h] });
      eng.spawnVehicle(2, SEDAN_TRAFFIC, { pos: [0, 0.01, 0], quat: [0, 0, 0, 1] });
      eng.setInput(2, { brake: 1, handbrake: 1, gearSelect: 0 });
      for (let i = 0; i < 1000; i++) eng.step();
      const A = eng.arena.get(1)!;
      const B = eng.arena.get(2)!;
      const veh = eng.getVehicle(1)!;
      setMotion({ eng, obj: A, veh, cv: veh.vehicle, objectId: 1 }, 50 / 3.6);
      const s = eng.state;
      const depths: number[] = [];
      for (let t = 0; t < 1500; t++) {
        eng.step();
        eng.events.clear();
        if (t % 10 !== 0) continue;
        for (let i = A.nodeStart; i < A.nodeStart + A.nodeCount; i++) {
          if ((s.flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue;
          let worst = 0;
          for (let k = 0; k < trisB.count; k++) {
            const a = B.nodeStart + trisB.a[k]!, b = B.nodeStart + trisB.b[k]!, c = B.nodeStart + trisB.c[k]!;
            const e1 = [s.posX[b]! - s.posX[a]!, s.posY[b]! - s.posY[a]!, s.posZ[b]! - s.posZ[a]!];
            const e2 = [s.posX[c]! - s.posX[a]!, s.posY[c]! - s.posY[a]!, s.posZ[c]! - s.posZ[a]!];
            const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
            const ln = Math.hypot(n[0]!, n[1]!, n[2]!);
            if (!(ln > 1e-9)) continue;
            const w = [s.posX[i]! - s.posX[a]!, s.posY[i]! - s.posY[a]!, s.posZ[i]! - s.posZ[a]!];
            const d = (w[0]! * n[0]! + w[1]! * n[1]! + w[2]! * n[2]!) / ln;
            if (d >= 0 || d < -0.5) continue;
            const d00 = e1[0]! ** 2 + e1[1]! ** 2 + e1[2]! ** 2, d11 = e2[0]! ** 2 + e2[1]! ** 2 + e2[2]! ** 2;
            const d01 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
            const d20 = w[0]! * e1[0]! + w[1]! * e1[1]! + w[2]! * e1[2]!, d21 = w[0]! * e2[0]! + w[1]! * e2[1]! + w[2]! * e2[2]!;
            const den = d00 * d11 - d01 * d01;
            const v = (d11 * d20 - d01 * d21) / den, u2 = (d00 * d21 - d01 * d20) / den;
            if (v < 0 || u2 < 0 || v + u2 > 1) continue;
            if (-d > worst) worst = -d;
          }
          if (worst > 0) depths.push(worst);
        }
      }
      depths.sort((x, y) => x - y);
      const q = (f: number): number => (depths.length ? depths[Math.min(depths.length - 1, Math.floor(f * depths.length))]! : 0);
      stats[mode] = { n: depths.length, p50: q(0.5), p95: q(0.95), max: q(1) };
      rows.push(`${mode} (${mode === 'standard' ? 'node spheres' : 'node vs triangle'}): ${depths.length} node-samples behind B's surface, median ${(100 * q(0.5)).toFixed(1)} cm, 95th ${(100 * q(0.95)).toFixed(1)} cm, max ${(100 * q(1)).toFixed(1)} cm`);
    }
    console.log(`[fidelity] penetration behind the struck car's surface, sedan 50 km/h into a traffic sedan's side:\n  ${rows.join('\n  ')}`);
    // Node-vs-triangle keeps most of the striking car's nodes out of the struck car (spheres let them slip
    // between the struck car's node spheres into its interior).
    expect(stats.high!.n).toBeLessThan(stats.standard!.n / 3);
  }, 300_000);

  it('caps: a sedan rear-ending a parked traffic sedan at 50 km/h (high) — striking nodes inside the struck car with and without end / underbody caps', () => {
    // Measured against B's derived surface WITH caps (its bumper-cover / underbody closure) in both runs;
    // the runs differ only in whether the simulation has the caps. Fresh def objects per run (the engine
    // caches derived triangles per def).
    const cvB = compileVehicle(SEDAN_TRAFFIC);
    const trisB = deriveCollisionTriangles(cvB.rig, { nodeCount: cvB.bodyNodeCount, caps: true });
    const res: Record<string, { n: number; p95: number; gap: number }> = {};
    for (const caps of [false, true]) {
      setDeriveCaps(caps);
      try {
        const eng = engine(SOLVER_PRESETS.high);
        eng.setGroundPlane(0, MaterialId.asphalt);
        eng.spawnVehicle(1, { ...SEDAN }, { pos: [0, 0.01, 5.6], quat: [0, 0, 0, 1] });
        eng.spawnVehicle(2, { ...SEDAN_TRAFFIC }, { pos: [0, 0.01, 0], quat: [0, 0, 0, 1] });
        eng.setInput(2, { brake: 1, handbrake: 1, gearSelect: 0 });
        for (let i = 0; i < 1000; i++) eng.step();
        const A = eng.arena.get(1)!;
        const B = eng.arena.get(2)!;
        const veh = eng.getVehicle(1)!;
        setMotion({ eng, obj: A, veh, cv: veh.vehicle, objectId: 1 }, 50 / 3.6);
        const s = eng.state;
        const depths: number[] = [];
        for (let t = 0; t < 1200; t++) {
          eng.step();
          eng.events.clear();
          if (t % 10 !== 0) continue;
          for (let i = A.nodeStart; i < A.nodeStart + A.nodeCount; i++) {
            if ((s.flags[i]! & NODE_FLAG_COLLIDABLE) === 0) continue;
            let worst = 0;
            for (let k = 0; k < trisB.count; k++) {
              const a = B.nodeStart + trisB.a[k]!, b = B.nodeStart + trisB.b[k]!, c = B.nodeStart + trisB.c[k]!;
              const e1 = [s.posX[b]! - s.posX[a]!, s.posY[b]! - s.posY[a]!, s.posZ[b]! - s.posZ[a]!];
              const e2 = [s.posX[c]! - s.posX[a]!, s.posY[c]! - s.posY[a]!, s.posZ[c]! - s.posZ[a]!];
              const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
              const ln = Math.hypot(n[0]!, n[1]!, n[2]!);
              if (!(ln > 1e-9)) continue;
              const w = [s.posX[i]! - s.posX[a]!, s.posY[i]! - s.posY[a]!, s.posZ[i]! - s.posZ[a]!];
              const d = (w[0]! * n[0]! + w[1]! * n[1]! + w[2]! * n[2]!) / ln;
              if (d >= 0 || d < -0.5) continue;
              const d00 = e1[0]! ** 2 + e1[1]! ** 2 + e1[2]! ** 2, d11 = e2[0]! ** 2 + e2[1]! ** 2 + e2[2]! ** 2;
              const d01 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
              const d20 = w[0]! * e1[0]! + w[1]! * e1[1]! + w[2]! * e1[2]!, d21 = w[0]! * e2[0]! + w[1]! * e2[1]! + w[2]! * e2[2]!;
              const den = d00 * d11 - d01 * d01;
              const v = (d11 * d20 - d01 * d21) / den, u2 = (d00 * d21 - d01 * d20) / den;
              if (v < 0 || u2 < 0 || v + u2 > 1) continue;
              if (-d > worst) worst = -d;
            }
            if (worst > 0) depths.push(worst);
          }
        }
        depths.sort((x, y) => x - y);
        const gap = com(eng, 2)[2] - com(eng, 1)[2];
        res[caps ? 'caps' : 'none'] = { n: depths.length, p95: depths.length ? depths[Math.floor(0.95 * (depths.length - 1))]! : 0, gap };
        for (let i = 0; i < s.nodeCount; i++) expect(Number.isFinite(s.posX[i]!)).toBe(true);
      } finally {
        setDeriveCaps(true);
      }
    }
    console.log(
      `[fidelity] high, sedan 50 km/h into a parked traffic sedan's rear: striking-car node samples inside the struck car (caps surface) — without caps ${res.none!.n} (95th ${(100 * res.none!.p95).toFixed(1)} cm), with caps ${res.caps!.n} (95th ${(100 * res.caps!.p95).toFixed(1)} cm); COM gap at the end ${res.none!.gap.toFixed(2)} / ${res.caps!.gap.toFixed(2)} m`,
    );
    // the cars met (A ends up within a car length of B, momentum shared)
    expect(Math.abs(res.caps!.gap)).toBeLessThan(4.5);
    expect(res.caps!.n).toBeLessThanOrEqual(res.none!.n);
  }, 300_000);
});
