/**
 * R-CRASH hinged closures (closures.ts, sedan doors + trunk lid): an unlatched door swings on its hinge
 * axis as a stiff panel (its dormant shell cluster wakes), out to its open stop under braking and back
 * toward closed under acceleration; a 64 km/h frontal leaves the latched doors latched and undented (the
 * open stop on the crushing fender breaks instead of pushing the door in); a 30 km/h side pole leaves
 * them latched (FMVSS 214 / 206: 11 kN latches; at 6 kN the struck door popped).
 */
import { describe, expect, it } from 'vitest';
import type { SimObject, SimState } from '../types';
import { compileVehicle } from './builder';
import { runCrash } from './crash';
import { SEDAN } from './defs/sedan';
import { createHandlingSim, stepN } from './handling';
import type { CompiledVehicle } from './types';

type V3 = [number, number, number];

/** Door / lid opening angle about its hinge axis (deg, signed about the axis a → b) of `edge` vs `ref`. */
function hingeAngle(P: (id: string) => V3, edge: string, ref: string, a: string, b: string): number {
  const A = P(a);
  const B = P(b);
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const l = Math.hypot(u[0]!, u[1]!, u[2]!);
  const n = u.map((x) => x / l);
  const radial = (q: V3) => {
    const w = [q[0] - A[0], q[1] - A[1], q[2] - A[2]];
    const d = w[0]! * n[0]! + w[1]! * n[1]! + w[2]! * n[2]!;
    return w.map((x, k) => x - d * n[k]!);
  };
  const p = radial(P(edge));
  const q = radial(P(ref));
  const dot = p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
  const cr = [p[1]! * q[2]! - p[2]! * q[1]!, p[2]! * q[0]! - p[0]! * q[2]!, p[0]! * q[1]! - p[1]! * q[0]!];
  return (Math.atan2(cr[0]! * n[0]! + cr[1]! * n[1]! + cr[2]! * n[2]!, dot) * 180) / Math.PI;
}

/** Worst |strain| and plastically set beams among a closure's own skin / inner beams. */
function closureSkin(cv: CompiledVehicle, s: SimState, obj: SimObject, prefix: string): { strain: number; set: number } {
  const ids = cv.rig.nodeIds;
  let strain = 0;
  let set = 0;
  for (let b = 0; b < cv.bodyBeamCount; b++) {
    if (!ids[cv.rig.beamA[b]!]!.startsWith(prefix) || !ids[cv.rig.beamB[b]!]!.startsWith(prefix)) continue;
    const g = obj.beamStart + b;
    const ia = s.aIdx[g]!;
    const ib = s.bIdx[g]!;
    const L = Math.hypot(s.posX[ib]! - s.posX[ia]!, s.posY[ib]! - s.posY[ia]!, s.posZ[ib]! - s.posZ[ia]!);
    strain = Math.max(strain, Math.abs(L / s.restLen0[g]! - 1));
    if (s.restLen[g] !== s.restLen0[g]) set++;
  }
  return { strain, set };
}

describe('sedan hinged closures', () => {
  it('an unlatched front door swings as a stiff panel: out to its stop braking, back toward closed accelerating', () => {
    const sim = createHandlingSim({ def: SEDAN });
    const s = sim.eng.state;
    const ids = sim.cv.rig.nodeIds;
    const n0 = sim.obj.nodeStart;
    const at = new Map(ids.map((id, i) => [id, i] as const));
    const P = (id: string): V3 => {
      const i = n0 + at.get(id)!;
      return [s.posX[i]!, s.posY[i]!, s.posZ[i]!];
    };
    const ang = () => hingeAngle(P, 'dFR_12', 's7_dm_R', 's5_sl_R', 's5_hp_R');
    stepN(sim, 1000);
    const a0 = ang();
    // pop the front-right latch: break one of its latch beams; the zone's latch pass lets the rest go
    const body = sim.veh.shell![0]!;
    const sh = sim.cv.shell[0]!;
    const latch = Array.from(sh.latchBeams).find((b) => [sim.cv.rig.beamA[b]!, sim.cv.rig.beamB[b]!].some((i) => ids[i]!.startsWith('dFR_')));
    expect(latch).toBeDefined();
    s.active[sim.obj.beamStart + latch!] = 0;
    stepN(sim, 4000);
    expect(Array.from(body.latchOff).filter((x) => x === 1)).toHaveLength(1);
    // its own cluster woke (weights 1) and the panel is held (not a sagging node lattice)
    const door = sim.veh.shell!.find((rt) => rt !== body && Array.from(rt.nodes).some((i) => ids[i - n0] === 'dFR_12'))!;
    expect(door).toBeDefined();
    expect(Math.min(...Array.from(door.w))).toBe(1);
    const popped = Math.abs(ang() - a0);
    expect(popped).toBeGreaterThan(5); // it hangs open under its check strap

    sim.eng.setInput(sim.objectId, { throttle: 1, gearSelect: 1, handbrake: 0, brake: 0 });
    let minAccel = Infinity;
    for (let k = 0; k < 40; k++) {
      stepN(sim, 200);
      minAccel = Math.min(minAccel, Math.abs(ang() - a0));
    }
    sim.eng.setInput(sim.objectId, { throttle: 0, brake: 1 });
    let maxBrake = 0;
    for (let k = 0; k < 20; k++) {
      stepN(sim, 200);
      maxBrake = Math.max(maxBrake, Math.abs(ang() - a0));
    }
    // accelerating swings it toward the closed door (inertia); braking throws it out to its 68° stop (+ compliance)
    expect(minAccel).toBeLessThan(popped);
    expect(maxBrake).toBeGreaterThan(55);
    expect(maxBrake).toBeLessThan(85);
    const skin = closureSkin(sim.cv, s, sim.obj, 'dFR_');
    expect(skin.strain).toBeLessThan(0.02);
    expect(skin.set).toBe(0);
  }, 900_000);

  it('a 64 km/h frontal leaves the doors latched and undented (the open stop breaks, not the door)', () => {
    const cv = compileVehicle(SEDAN);
    let checked = false;
    runCrash({
      kind: 'frontal',
      speedKmh: 64,
      onStep: (eng, obj, since) => {
        if (since !== 3000) return;
        checked = true;
        const rt = eng.getVehicle(obj.objectId)!.shell![0]!;
        expect(Array.from(rt.latchOff).every((x) => x === 0)).toBe(true);
        for (const d of ['dFR_', 'dFL_', 'dRR_', 'dRL_']) {
          const skin = closureSkin(cv, eng.state, obj, d);
          expect(skin.strain, d).toBeLessThan(0.03);
          expect(skin.set, d).toBe(0);
        }
      },
    });
    expect(checked).toBe(true);
  }, 900_000);

  it('a 30 km/h side pole (FMVSS 214) leaves every door latched', () => {
    let off = -1;
    runCrash({
      kind: 'pole',
      speedKmh: 30,
      onStep: (eng, obj, since) => {
        if (since === 3000) off = Array.from(eng.getVehicle(obj.objectId)!.shell![0]!.latchOff).filter((x) => x !== 0).length;
      },
    });
    expect(off).toBe(0);
  }, 900_000);
});
