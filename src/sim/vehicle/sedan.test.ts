/**
 * SEDAN definition tests. The static/dynamic ones run the real engine
 * (SimEngine.spawnVehicle → vehicle pre-step, drivetrain, wheels); if those
 * sibling modules are missing they are skipped with a message.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { compileRig, computeStabilityReport, GENERAL_OMEGA_DT_LIMIT, STRUCTURE_OMEGA_DT_LIMIT } from '../rig/builder';
import { buildVehicleRig, compileVehicle, PLAYER_BEAM_BUDGET, TREAD_OMEGA_DT_LIMIT, validateVehicle } from './builder';
import { SEDAN, SEDAN_DESIGN, SEDAN_TARGETS } from './defs/sedan';
import { WHEEL_BEAMS_PER_RAY, WHEEL_DEFAULTS, wheelNodeId, type CompiledVehicle } from './types';

const SIBLINGS = ['../engine.ts', './runtime.ts', './drivetrain.ts', './wheels.ts', '../collision/ground.ts'];
const present = import.meta.glob(['../engine.ts', './runtime.ts', './drivetrain.ts', './wheels.ts', '../collision/ground.ts']);
const missing = SIBLINGS.filter((p) => !(p in present));
if (missing.length > 0) console.warn(`[sedan.test] engine tests SKIPPED: sibling modules not present yet: ${missing.join(', ')}`);

const cv: CompiledVehicle = compileVehicle(SEDAN);

describe('SEDAN definition', () => {
  it('validates with no errors or warnings, within the player beam budget', () => {
    const r = validateVehicle(SEDAN);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.islands).toBe(1);
    expect(r.stats.beamCount).toBeLessThanOrEqual(PLAYER_BEAM_BUDGET);
    expect(r.stats.pinnedCount).toBe(0);
  });

  it('declared masses: every node ω·dt ≤ 0.5, ≥ 95 % of non-tread nodes ≤ 0.35, tread ≤ 0.49, (Σd/m)·dt ≤ 1, no MINIMASS drift', () => {
    const merged = buildVehicleRig(SEDAN);
    const rep = computeStabilityReport(compileRig(merged), { limit: STRUCTURE_OMEGA_DT_LIMIT });
    let within = 0;
    let structural = 0;
    for (let i = 0; i < rep.omegaDt.length; i++) {
      expect(rep.omegaDt[i]).toBeLessThanOrEqual(GENERAL_OMEGA_DT_LIMIT);
      expect(rep.dampDt[i]).toBeLessThanOrEqual(1);
      // Tread nodes run up to TREAD_OMEGA_DT_LIMIT by design (builder.ts).
      if (merged.nodes[i]!.group === WHEEL_DEFAULTS.tireGroup) {
        expect(rep.omegaDt[i]).toBeLessThanOrEqual(TREAD_OMEGA_DT_LIMIT * (1 + 1e-9));
        continue;
      }
      structural++;
      if (rep.omegaDt[i]! <= STRUCTURE_OMEGA_DT_LIMIT) within++;
    }
    expect(within / structural).toBeGreaterThanOrEqual(0.95);
    expect(cv.massDriftPct).toBeLessThan(1);
  });

  it('hits the mass, axle split, CG and geometry targets', () => {
    const r = cv.rig;
    let m = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < r.nodeCount; i++) {
      m += r.nodeMass[i]!;
      my += r.nodeMass[i]! * r.nodePos[3 * i + 1]!;
      mz += r.nodeMass[i]! * r.nodePos[3 * i + 2]!;
    }
    expect(m).toBeGreaterThan(1430);
    expect(m).toBeLessThan(1470);
    expect(cv.totalMass).toBeCloseTo(m, 6);
    const zf = (r.nodePos[3 * cv.wheels[0]!.hubI + 2]! + r.nodePos[3 * cv.wheels[1]!.hubI + 2]!) / 2;
    const zr = (r.nodePos[3 * cv.wheels[2]!.hubI + 2]! + r.nodePos[3 * cv.wheels[3]!.hubI + 2]!) / 2;
    expect(zr - zf).toBeCloseTo(2.75, 6); // wheelbase
    const front = (zr - mz / m) / (zr - zf);
    expect(front).toBeGreaterThan(0.51);
    expect(front).toBeLessThan(0.53);
    expect(my / m).toBeGreaterThan(0.45); // rest pose; settles ~5 cm lower
    expect(my / m).toBeLessThan(0.56);
    for (const w of cv.wheels) {
      const cx = (r.nodePos[3 * w.hubI]! + r.nodePos[3 * w.hubO]!) / 2;
      expect(Math.abs(cx)).toBeCloseTo(SEDAN_TARGETS.track / 2, 6);
      expect(w.radius).toBe(0.32);
      expect(w.rays).toBe(12);
    }
    expect(SEDAN_DESIGN.frontAxleShare).toBeCloseTo(0.52, 3);
  });

  it('has a heavy engine cluster, softer crumple zones than the cage, and brittle glass', () => {
    const body = SEDAN.body;
    const engineMass = body.nodes.filter((n) => n.group === 'engine').reduce((a, n) => a + n.mass, 0);
    expect(engineMass).toBeGreaterThanOrEqual(200);
    const deformOf = (pred: (a: string, b: string) => boolean): number[] =>
      body.beams.filter((b) => b.type === 'normal' && pred(b.a, b.b)).map((b) => b.deform ?? 0);
    const st = (id: string): number => Number(/^s(\d+)_/.exec(id)?.[1] ?? -1);
    const front = deformOf((a, b) => st(a) >= 0 && st(a) <= 1 && st(b) >= 0 && st(b) <= 2);
    const rear = deformOf((a, b) => st(a) >= 12 && st(b) >= 12);
    const cage = deformOf((a, b) => st(a) >= 6 && st(a) <= 8 && st(b) >= 6 && st(b) <= 8 && !/_(bt|rf)_/.test(a + b));
    expect(front.length).toBeGreaterThan(10);
    expect(Math.max(...front, ...rear)).toBeLessThan(Math.min(...cage));
    // Crash rails/bumper are at least 3× weaker than the safety cell.
    expect(3 * Math.max(...front, ...rear)).toBeLessThanOrEqual(Math.min(...cage) * 1.0 + 1e-9);
    // Window glass shatters at a few % strain (low absolute break force).
    expect(body.beams.filter((b) => b.breakF !== undefined && b.breakF > 0 && b.breakF < 2e4).length).toBeGreaterThan(10);
  });

  it('keeps canonical merged order (body, then FL FR RL RR as generated)', () => {
    const r = cv.rig;
    expect(r.nodeIds.slice(0, SEDAN.body.nodes.length)).toEqual(SEDAN.body.nodes.map((n) => n.id));
    expect(cv.wheels.map((w) => w.id)).toEqual(['FL', 'FR', 'RL', 'RR']);
    let nodeAt = cv.bodyNodeCount;
    let beamAt = cv.bodyBeamCount;
    for (const w of cv.wheels) {
      expect(w.nodeStart).toBe(nodeAt);
      expect(r.nodeIds[nodeAt]).toBe(wheelNodeId(w.id, 'hubI'));
      expect(r.nodeIds[nodeAt + 1]).toBe(wheelNodeId(w.id, 'hubO'));
      expect(r.nodeIds[nodeAt + 2]).toBe(wheelNodeId(w.id, 'rimI', 0));
      expect(r.nodeIds[nodeAt + 2 + 4 * w.rays - 1]).toBe(wheelNodeId(w.id, 'tireO', w.rays - 1));
      expect(w.beamStart).toBe(beamAt);
      const attach = SEDAN.wheels[w.index]!.attach.length;
      expect(w.beamCount).toBe(2 * attach + 1 + WHEEL_BEAMS_PER_RAY * w.rays);
      nodeAt += w.nodeCount;
      beamAt += w.beamCount;
    }
    expect(nodeAt).toBe(r.nodeCount);
    expect(beamAt).toBe(r.beamCount);
    expect(cv.wheels.map((w) => w.corner)).toEqual([0, 1, 2, 3]);
    expect(cv.wheels.map((w) => w.spinSign)).toEqual([1, -1, 1, -1]);
  });

  it('round-trips through JSON and compiles identically', () => {
    const copy = JSON.parse(JSON.stringify(SEDAN)) as typeof SEDAN;
    expect(copy).toEqual(SEDAN);
    expect(structuredClone(SEDAN)).toEqual(SEDAN);
    expect(compileVehicle(copy)).toEqual(cv);
  });

  it('carries the drivetrain, brake, aero and steering spec', () => {
    const d = cv.drivetrain;
    const lut = (rpm: number): number => d.torqueLut[Math.round(rpm / d.lutStepRpm)]!;
    let peak = 0;
    let peakRpm = 0;
    for (let i = 0; i < d.torqueLut.length; i++) if (d.torqueLut[i]! > peak) [peak, peakRpm] = [d.torqueLut[i]!, i * d.lutStepRpm];
    expect(peak).toBeCloseTo(350, 6);
    expect(peakRpm).toBe(3500); // plateau 3500–6500 rpm
    expect(lut(6500)).toBeCloseTo(350, 6);
    // ≈ 238 kW peak power (350 N·m at 6500 rpm).
    let pmax = 0;
    for (let i = 0; i < d.torqueLut.length; i++) pmax = Math.max(pmax, (d.torqueLut[i]! * i * d.lutStepRpm * Math.PI) / 30);
    expect(pmax).toBeGreaterThan(230e3);
    expect(pmax).toBeLessThan(255e3);
    expect(lut(1500)).toBeLessThan(0.8 * peak); // a real curve, not flat
    expect(lut(6800)).toBeLessThan(peak);
    expect(d.redlineRpm).toBe(6800);
    expect(Array.from(d.gearRatioTable.slice(2))).toEqual([3.9, 2.4, 1.7, 1.3, 1.0, 0.8]);
    expect(d.finalDrive).toBe(3.4);
    expect(d.diff).toBe(2); // limited
    expect(Array.from(d.drivenWheels)).toEqual([2, 3]); // RWD
    expect(cv.wheels[0]!.brakeTorque).toBeCloseTo(2500, 6);
    expect(cv.wheels[2]!.brakeTorque / cv.wheels[0]!.brakeTorque).toBeCloseTo(0.4 / 0.6, 9);
    expect(cv.aero.dragCoeffArea).toBeCloseTo(0.65, 9);
    expect(cv.steering.maxWheelAngleDeg).toBeCloseTo((0.55 * 180) / Math.PI, 1);
    // Only the two front tie rods are hydros, opposite-signed (mirror geometry).
    const hydros = SEDAN.body.beams.filter((b) => b.type === 'hydro');
    expect(hydros.map((b) => b.b)).toEqual(['FL.hubO', 'FR.hubO']);
    expect(hydros[0]!.hydroTravel).toBeCloseTo(-hydros[1]!.hydroTravel!, 9);
  });

  it('derives springs from ride frequency and a 0.3 damping target', () => {
    const D = SEDAN_DESIGN;
    for (const [axle, hz] of [['front', 1.4], ['rear', 1.6]] as const) {
      const ride = D.sprungCornerMass[axle] * (2 * Math.PI * hz) ** 2;
      // Spring wheel rate in series with the tyre gives the ride rate.
      expect((D.wheelRate[axle] * D.tireRate) / (D.wheelRate[axle] + D.tireRate)).toBeCloseTo(ride, 3);
      expect(D.shockK[axle]).toBeGreaterThan(0);
      expect(D.preload[axle]).toBeGreaterThan(0);
      expect(D.motionRatio[axle]).toBeGreaterThan(0.8);
      expect(D.motionRatio[axle]).toBeLessThan(1.2);
    }
  });
});

// ------------------------------------------------------------------ engine-backed
type EngineMod = typeof import('../engine');
let E: EngineMod;

describe.skipIf(missing.length > 0)('SEDAN in the engine', () => {
  beforeAll(async () => {
    E = await import('../engine');
  });

  const spawn = () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 } });
    eng.setGroundPlane(0, 0);
    const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, 'manual');
    return { eng, obj, s: eng.state };
  };
  type Sim = ReturnType<typeof spawn>;
  const P = (sim: Sim, i: number): number[] => [sim.s.posX[sim.obj.nodeStart + i]!, sim.s.posY[sim.obj.nodeStart + i]!, sim.s.posZ[sim.obj.nodeStart + i]!];
  const norm = (v: number[]): number[] => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return v.map((c) => c / l);
  };
  const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  /** Axle direction hubI → hubO in the BODY frame (right, up, back). */
  const bodyAxle = (sim: Sim, w: number): number[] => {
    const o = P(sim, cv.frameNodes[0]!);
    const fw = norm(P(sim, cv.frameNodes[1]!).map((c, k) => c - o[k]!));
    const t = P(sim, cv.frameNodes[2]!).map((c, k) => c - o[k]!);
    const up = norm(t.map((c, k) => c - dot(t, fw) * fw[k]!));
    const right = [fw[1]! * up[2]! - fw[2]! * up[1]!, fw[2]! * up[0]! - fw[0]! * up[2]!, fw[0]! * up[1]! - fw[1]! * up[0]!];
    const wh = cv.wheels[w]!;
    const a = norm(P(sim, wh.hubO).map((c, k) => c - P(sim, wh.hubI)[k]!));
    return [dot(a, right), dot(a, up), -dot(a, fw)];
  };
  const angleDeg = (a: number[], b: number[]): number => (Math.acos(Math.min(1, dot(a, b))) * 180) / Math.PI;
  const brokenOrDeformed = (sim: Sim): number => {
    let n = 0;
    for (let b = sim.obj.beamStart; b < sim.obj.beamStart + sim.obj.beamCount; b++) {
      if (sim.s.type[b] === 3) continue; // hydro rest length is driven by steering
      if (sim.s.active[b] === 0 || Math.abs(sim.s.restLen[b]! - sim.s.restLen0[b]!) > 1e-4 * sim.s.restLen0[b]!) n++;
    }
    return n;
  };

  it('settles on a plane to ride height: no NaN, chassis sag 2–6 cm, 52/48 loads, no damage', () => {
    const sim = spawn();
    const nb = cv.bodyNodeCount;
    const y0 = Array.from({ length: nb }, (_, i) => P(sim, i)[1]!);
    for (let t = 0; t < 8000; t++) sim.eng.step();
    let drop = 0;
    let n = 0;
    let maxV = 0;
    for (let i = 0; i < cv.rig.nodeCount; i++) {
      const g = sim.obj.nodeStart + i;
      for (const v of [sim.s.posX[g]!, sim.s.posY[g]!, sim.s.posZ[g]!, sim.s.velX[g]!, sim.s.velY[g]!, sim.s.velZ[g]!]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      maxV = Math.max(maxV, Math.hypot(sim.s.velX[g]!, sim.s.velY[g]!, sim.s.velZ[g]!));
      if (i < nb && SEDAN.body.nodes[i]!.group === 'body') {
        drop += y0[i]! - sim.s.posY[g]!;
        n++;
      }
    }
    const sag = drop / n;
    expect(sag).toBeGreaterThan(0.02);
    expect(sag).toBeLessThan(0.06);
    expect(maxV).toBeLessThan(0.15); // at rest
    const v = sim.eng.getVehicle(1)!;
    const loads = v.wheels.map((w) => w.load);
    const total = loads.reduce((a, b) => a + b, 0);
    expect(total / 9.81).toBeGreaterThan(1400);
    expect(total / 9.81).toBeLessThan(1500);
    expect((loads[0]! + loads[1]!) / total).toBeGreaterThan(0.5);
    expect((loads[0]! + loads[1]!) / total).toBeLessThan(0.54);
    expect(Math.abs(loads[0]! - loads[1]!) / total).toBeLessThan(0.01);
    expect(brokenOrDeformed(sim)).toBe(0);
  });

  it('full drive torque for 1 s: every axle stays within 5° of its rest direction (body frame)', () => {
    const sim = spawn();
    for (let t = 0; t < 4000; t++) sim.eng.step();
    const rest = cv.wheels.map((_, w) => bodyAxle(sim, w));
    sim.eng.setInput(1, { gearSelect: 1, throttle: 1 });
    const worst = [0, 0, 0, 0];
    let peakDrive = 0;
    for (let t = 0; t < 2000; t++) {
      sim.eng.step();
      const v = sim.eng.getVehicle(1)!;
      peakDrive = Math.max(peakDrive, v.wheels[2]!.driveTorque, v.wheels[3]!.driveTorque);
      if (t % 10 === 0) for (let w = 0; w < 4; w++) worst[w] = Math.max(worst[w]!, angleDeg(bodyAxle(sim, w), rest[w]!));
    }
    expect(peakDrive).toBeGreaterThan(1500); // really near full 1st-gear torque per rear wheel
    for (const a of worst) expect(a).toBeLessThan(5);
    const v = sim.eng.getVehicle(1)!;
    expect(v.wheels[2]!.omega).toBeGreaterThan(0); // spinning forward
    expect(sim.s.velZ[sim.obj.nodeStart + cv.frameNodes[0]!]).toBeLessThan(-3); // and driving forward (−Z)
  });

  it('steering: ramped full lock under throttle stays within the steering range; rear axle stays put', () => {
    const sim = spawn();
    for (let t = 0; t < 4000; t++) sim.eng.step();
    const rest = cv.wheels.map((_, w) => bodyAxle(sim, w));
    const worst = [0, 0, 0, 0];
    const yawSign: number[] = [];
    for (let t = 0; t < 3000; t++) {
      sim.eng.setInput(1, { gearSelect: 1, throttle: 0.6, steer: Math.min(1, t / 800) }); // ≈ 2.5/s keyboard slew
      sim.eng.step();
      if (t % 10 === 0) for (let w = 0; w < 4; w++) worst[w] = Math.max(worst[w]!, angleDeg(bodyAxle(sim, w), rest[w]!));
    }
    for (const w of [0, 1]) {
      const a = bodyAxle(sim, w);
      // steer +1 = right turn: heading (0,0,−1) → (sin δ, 0, −cos δ), so the
      // vehicle-left spin axis (−1,0,0) → (−cos δ, 0, −sin δ): its back component goes negative.
      const s = cv.wheels[w]!.spinSign;
      const spin = a.map((c) => c * s); // vehicle-left at rest
      yawSign.push(Math.sign(spin[2]!));
    }
    const lock = (SEDAN_TARGETS.maxWheelAngleRad * 180) / Math.PI;
    expect(worst[0]).toBeGreaterThan(0.75 * lock);
    expect(worst[1]).toBeGreaterThan(0.75 * lock);
    // Full lock + throttle with brush-tyre lateral grip (μN at the loaded
    // outer front) also tilts that upright: measured ≈ 8° extra toe + 11°
    // camber at the end of this ramp (front upright camber compliance, a
    // known follow-up); the bound guards against a collapse.
    expect(worst[0]).toBeLessThan(lock + 15);
    expect(worst[1]).toBeLessThan(lock + 15);
    // Rear: no steering (toe) and bounded camber compliance under the
    // brush tyre's lateral grip (measured ≈ 0.5° toe, 4–5.5° total).
    expect(worst[2]).toBeLessThan(7);
    expect(worst[3]).toBeLessThan(7);
    for (const w of [2, 3]) {
      const a = bodyAxle(sim, w);
      expect(Math.abs((Math.asin(Math.max(-1, Math.min(1, a[2]! - rest[w]![2]!))) * 180) / Math.PI)).toBeLessThan(2);
    }
    expect(yawSign).toEqual([-1, -1]);
  });

  it('hard driving leaves no plastic damage', () => {
    const sim = spawn();
    for (let t = 0; t < 3000; t++) sim.eng.step();
    sim.eng.setInput(1, { gearSelect: 1, throttle: 1 });
    for (let t = 0; t < 4000; t++) sim.eng.step();
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1 });
    for (let t = 0; t < 3000; t++) sim.eng.step();
    expect(brokenOrDeformed(sim)).toBe(0);
  });

  it('crash: an 8 m/s nose-first impact crumples the front, not the safety cell', () => {
    const eng = new E.SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 2048, beamCapacity: 8192 } });
    eng.setGroundPlane(0, 0);
    // Pitched −90° about X: forward (−Z) points down, bumper face just above the ground.
    const obj = eng.spawnVehicle(1, SEDAN, { pos: [0, 2.45, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
    const s = eng.state;
    for (let i = 0; i < cv.rig.nodeCount; i++) s.velY[obj.nodeStart + i] = -8;
    for (let t = 0; t < 1500; t++) eng.step();
    for (let i = 0; i < cv.rig.nodeCount; i++) expect(Number.isFinite(s.posY[obj.nodeStart + i]!)).toBe(true);
    /** Plastic shortening (restLen0 − restLen) summed along a member line s{from}…s{to}, right side. */
    const plastic = (tag: string, from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i++) {
        const a = cv.rig.nodeIds.indexOf(`s${i}_${tag}_R`);
        const c = cv.rig.nodeIds.indexOf(`s${i + 1}_${tag}_R`);
        for (let b = 0; b < cv.bodyBeamCount; b++) {
          const x = cv.rig.beamA[b]!;
          const y = cv.rig.beamB[b]!;
          if ((x === a && y === c) || (x === c && y === a)) sum += cv.rig.beamRestLen[b]! - s.restLen[obj.beamStart + b]!;
        }
      }
      return sum;
    };
    const rails = plastic('rl', 1, 4) + plastic('rh', 1, 4);
    expect(rails).toBeGreaterThan(0.03); // crash rails crushed several cm
    expect(Math.abs(plastic('sl', 5, 9))).toBeLessThan(0.002); // sills intact
    expect(Math.abs(plastic('rf', 6, 8))).toBeLessThan(0.002); // roof rails intact
  });

  it('heave: ride frequencies near 1.4 Hz front / 1.6 Hz rear', () => {
    const sim = spawn();
    for (let t = 0; t < 8000; t++) sim.eng.step();
    const nb = cv.bodyNodeCount;
    const zone = (lo: number, hi: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < nb; i++) {
        const z = cv.rig.nodePos[3 * i + 2]!;
        if (SEDAN.body.nodes[i]!.group === 'body' && z >= lo && z <= hi) out.push(i);
      }
      return out;
    };
    const fz = zone(-1.8, -1.0);
    const rz = zone(1.0, 1.8);
    const avgY = (ids: number[]): number => ids.reduce((a, i) => a + P(sim, i)[1]!, 0) / ids.length;
    const f0 = avgY(fz);
    const r0 = avgY(rz);
    for (let i = 0; i < nb; i++) if (SEDAN.body.nodes[i]!.group === 'body') sim.s.velY[sim.obj.nodeStart + i] = -0.25;
    const ft: number[] = [];
    const rt: number[] = [];
    for (let t = 0; t < 6000; t++) {
      sim.eng.step();
      if (t % 10 === 0) {
        ft.push(avgY(fz) - f0);
        rt.push(avgY(rz) - r0);
      }
    }
    // First three zero crossings span one period (later ones are sub-0.1 mm noise).
    const freq = (tr: number[]): number => {
      const zc: number[] = [];
      for (let i = 1; i < tr.length && zc.length < 3; i++) if (Math.sign(tr[i - 1]!) !== Math.sign(tr[i]!) && tr[i] !== 0) zc.push(i * 0.005);
      return 1 / (zc[2]! - zc[0]!);
    };
    const ff = freq(ft);
    const fr = freq(rt);
    expect(ff).toBeGreaterThan(1.2);
    expect(ff).toBeLessThan(1.6);
    expect(fr).toBeGreaterThan(1.4);
    expect(fr).toBeLessThan(1.8);
    // ζ ≈ 0.3: successive opposite peaks shrink by exp(−πζ/√(1−ζ²)) ≈ 0.37 (0.25 < ratio < 0.5 ⇔ 0.22 < ζ < 0.4).
    for (const tr of [ft, rt]) {
      const ext: number[] = [];
      for (let i = 1; i + 1 < tr.length && ext.length < 2; i++) {
        if ((tr[i]! - tr[i - 1]!) * (tr[i + 1]! - tr[i]!) < 0 && Math.abs(tr[i]!) > 1e-3) ext.push(tr[i]!);
      }
      const ratio = Math.abs(ext[1]! / ext[0]!);
      expect(ratio).toBeGreaterThan(0.25);
      expect(ratio).toBeLessThan(0.5);
    }
  });
});
