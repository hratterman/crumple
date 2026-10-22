/**
 * TYRE STATE ON THE CAR (sedan): wet braking, burnout heating and wear,
 * warm-up, punctures / TPMS / repair, airing down, and the determinism of
 * the logged tyre commands. Sources:
 *  [ADAC]  ADAC / TÜV SÜD summer-tyre tests, 205/55 R16 on a compact /
 *          mid-size car: wet braking 80 → 20 km/h in 26–34 m; dry 100 → 0 in
 *          34–40 m.
 *  [BURN]  Burnout practice: the driven tyres smoke (surface ≳ 150–200 °C)
 *          within seconds; the undriven ones stay cold.
 *  [FMVSS138] TPMS: warn at 25 % below the cold placard pressure.
 *  [TIRE]  Tyre makers: a sudden deflation pulls the car toward the flat
 *          corner and the flat wheel drags (C_rr of a flat ≈ 0.1–0.3).
 *  [KERB]  Tyre makers' impact-damage guidance: rolling over a kerb at
 *          walking pace is harmless; hitting a square kerb at town speed
 *          pinches the tyre against the rim (sidewall cut / bent rim: air
 *          loss).
 */
import { describe, expect, it } from 'vitest';
import { MaterialId } from '../../../protocol/messages';
import type { ColliderDef } from '../../../world/types';
import { createWheelFrame, WHEEL_FLAG_FLAT, WHEEL_FLAG_TPMS } from '../../../protocol/wheels';
import { hashSimState } from '../../replay/hash';
import { SEDAN } from '../defs/sedan';
import { createHandlingSim, headingOf, kinematics, setMotion, stepN, type HandlingSim } from '../handling';
import type { VehicleRuntimeEx } from '../runtime';
import { fillWheelFrame } from '../tyre';

const HZ = 2000;
const ex = (sim: HandlingSim): VehicleRuntimeEx => sim.veh as VehicleRuntimeEx;

function settled(materialId = MaterialId.asphalt): HandlingSim {
  const sim = createHandlingSim({ def: SEDAN, materialId });
  sim.eng.setInput(1, { gearSelect: 1, throttle: 0, brake: 0, handbrake: 0 });
  stepN(sim, Math.round(0.6 * HZ));
  return sim;
}

/** Full-pedal ABS stop from `from` to `to` km/h; distance, m. */
function stopDistance(sim: HandlingSim, from: number, to: number): number {
  setMotion(sim, from / 3.6);
  sim.eng.setInput(1, { throttle: 0, brake: 1 });
  const k0 = kinematics(sim);
  for (let i = 0; i < 10 * HZ; i++) {
    sim.eng.step();
    const k = kinematics(sim);
    if (Math.hypot(k.vx, k.vz) * 3.6 <= to) return Math.hypot(k.cx - k0.cx, k.cz - k0.cz);
  }
  return Infinity;
}

describe('tyre state on the car (sedan)', () => {
  it('wet braking 80 → 20 km/h: 26–36 m on a wet test track, 20–45 % longer than dry [ADAC]', () => {
    const dry = stopDistance(settled(), 80, 20);
    const wetSim = settled();
    wetSim.eng.setSurfaceWetness(1, 0.3);
    const wet = stopDistance(wetSim, 80, 20);
    expect(wet).toBeGreaterThan(26);
    expect(wet).toBeLessThan(36);
    expect(wet / dry).toBeGreaterThan(1.2);
    expect(wet / dry).toBeLessThan(1.45);
  }, 120_000);

  it('burnout (TC off, line lock): the rear surface passes 150 °C within 4 s and the tread wears; the fronts stay cool [BURN]', () => {
    const sim = settled();
    sim.eng.setAssists(1, { tractionControl: false });
    sim.eng.setInput(1, { gearSelect: 1, throttle: 1, brake: 1 });
    stepN(sim, 4 * HZ);
    const ty = ex(sim).tyres;
    const rear = Math.max(ty[2]!.thermal.tSurf, ty[3]!.thermal.tSurf);
    const front = Math.max(ty[0]!.thermal.tSurf, ty[1]!.thermal.tSurf);
    expect(rear).toBeGreaterThan(150);
    expect(front).toBeLessThan(45);
    expect(ty[2]!.thermal.tread).toBeLessThan(ty[2]!.thermalP.treadNew - 0.05);
  }, 120_000);

  it('cruising warms the tyres: 30 s at 100 km/h raises the carcass and the pressure (ideal gas) [TIRE]', () => {
    const sim = settled();
    setMotion(sim, 100 / 3.6);
    const t0 = ex(sim).tyres[0]!.thermal;
    const p0 = t0.pressure;
    for (let i = 0; i < 30; i++) {
      // hold ≈ 100 km/h
      const v = Math.hypot(kinematics(sim).vx, kinematics(sim).vz) * 3.6;
      sim.eng.setInput(1, { throttle: v < 100 ? 0.35 : 0.1, brake: 0 });
      stepN(sim, HZ);
    }
    const t = ex(sim).tyres[0]!.thermal;
    expect(t.tCarc).toBeGreaterThan(21);
    expect(t.tGas).toBeGreaterThan(20.3);
    expect(t.pressure).toBeGreaterThan(p0);
  }, 180_000);

  it('a cut at 60 km/h: flat within 2 s, TPMS and flat flags, the car pulls toward the flat corner and drags [TIRE][FMVSS138]', () => {
    const run = (cut: boolean): { heading: number; speed: number; sim: HandlingSim } => {
      const sim = settled();
      setMotion(sim, 60 / 3.6);
      sim.eng.setInput(1, { throttle: 0, brake: 0, steer: 0 });
      stepN(sim, Math.round(0.3 * HZ));
      if (cut) sim.eng.setTyre({ objectId: 1, wheel: 0, puncture: 'fast' });
      const h0 = headingOf(kinematics(sim));
      stepN(sim, 3 * HZ);
      const k = kinematics(sim);
      return { heading: headingOf(k) - h0, speed: Math.hypot(k.vx, k.vz), sim };
    };
    const ok = run(false);
    const flat = run(true);
    const t = ex(flat.sim).tyres[0]!;
    expect(t.thermal.pressure).toBeLessThan(25e3);
    const fr = fillWheelFrame(flat.sim.eng.state, flat.sim.veh.wheels[0]!, t, 1, 25, createWheelFrame());
    expect(fr.flags & WHEEL_FLAG_FLAT).not.toBe(0);
    expect(fr.flags & WHEEL_FLAG_TPMS).not.toBe(0);
    // FL flat: the car yaws left (heading − = left) relative to the intact run, and loses more speed
    expect(flat.heading - ok.heading).toBeLessThan(-0.01);
    expect(flat.speed).toBeLessThan(ok.speed - 0.3);
  }, 180_000);

  it('repair restores pressure, carcass and grip', () => {
    const sim = settled();
    const s = sim.eng.state;
    const t = ex(sim).tyres[0]!;
    const k0 = Array.from(t.sideBeams, (b) => s.k[t.beamBase + b]!);
    sim.eng.setTyre({ objectId: 1, wheel: 0, puncture: 'fast' });
    stepN(sim, 2 * HZ);
    expect(s.k[t.beamBase + t.sideBeams[0]!]!).toBeLessThan(0.5 * k0[0]!);
    sim.eng.setTyre({ objectId: 1, wheel: 0, repair: true });
    stepN(sim, 10);
    expect(t.thermal.pressure).toBeGreaterThan(220e3);
    for (let q = 0; q < k0.length; q++) expect(s.k[t.beamBase + t.sideBeams[q]!]!).toBeCloseTo(k0[q]!, 6);
  }, 120_000);

  it('airing down to 1.2 bar lowers the car on its tyres (vertical stiffness ≈ 70 % inflation, MF-Swift)', () => {
    const sim = settled();
    const y0 = kinematics(sim).cy;
    sim.eng.setTyre({ objectId: 1, pressureKpa: 120 });
    stepN(sim, Math.round(1.5 * HZ));
    const t = ex(sim).tyres[0]!;
    expect(t.thermal.pressure / 1000).toBeGreaterThan(110);
    expect(t.thermal.pressure / 1000).toBeLessThan(130);
    expect(kinematics(sim).cy).toBeLessThan(y0 - 0.005);
  }, 120_000);

  it('wetness and tyre service are deterministic state (same commands → same hash, different without)', () => {
    const go = (puncture: boolean): number => {
      const sim = settled();
      setMotion(sim, 50 / 3.6);
      sim.eng.setSurfaceWetness(0.7, 0.4);
      stepN(sim, 500);
      if (puncture) sim.eng.setTyre({ objectId: 1, wheel: 3, puncture: 'slow' });
      sim.eng.setInput(1, { brake: 0.6 });
      stepN(sim, 1500);
      return hashSimState(sim.eng);
    };
    const a = go(true);
    expect(go(true)).toBe(a);
    expect(go(false)).not.toBe(a);
  }, 120_000);

  it('kerb strike: a 15 cm square kerb at 8 km/h is harmless; at 45 km/h the front tyres bottom on their rims and lose air [KERB]', () => {
    const hit = (kmh: number): { leak: number[]; strike: number } => {
      const sim = settled();
      const k = kinematics(sim);
      // a kerb across the path 4 m ahead of the car's centre (box half extents: 3 m wide, 7.5 cm tall, 15 cm deep)
      const yaw = Math.atan2(k.fx, k.fz);
      const kerb: ColliderDef = {
        id: 'kerb',
        kind: 'box',
        pos: [k.cx + 4 * k.fx, 0.075, k.cz + 4 * k.fz],
        quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        size: [3, 0.075, 0.15],
        material: MaterialId.concrete,
      };
      sim.eng.setExtraColliders([kerb]);
      setMotion(sim, kmh / 3.6);
      sim.eng.setInput(1, { throttle: 0, brake: 0, steer: 0 });
      let strike = 0;
      for (let i = 0; i < 1.5 * HZ; i++) {
        sim.eng.step();
        for (const t of ex(sim).tyres) if (t.rimStrike > strike) strike = t.rimStrike;
      }
      return { leak: ex(sim).tyres.map((t) => t.thermal.leakArea), strike };
    };
    const slow = hit(8);
    expect(slow.leak.every((a) => a === 0)).toBe(true);
    const fast = hit(45);
    expect(fast.strike).toBeGreaterThan(1.5);
    expect(fast.leak[0]! > 0 || fast.leak[1]! > 0).toBe(true);
  }, 120_000);
});
