/**
 * R-CRASH hinged closures (closures.ts; sedan / coupe doors + trunk lid, pickup crew-cab doors; data: CASES): an unlatched door swings on its hinge
 * axis as a stiff panel (its dormant shell cluster wakes), out to its open stop under braking and back
 * toward closed under acceleration; a 64 km/h frontal leaves the latched doors latched and undented (the
 * open stop on the crushing fender breaks instead of pushing the door in); a 30 km/h side pole leaves
 * them latched (FMVSS 214 / 206: 11 kN latches; at 6 kN the struck door popped).
 */
import { describe, expect, it } from 'vitest';
import type { SimObject, SimState } from '../types';
import { compileVehicle } from './builder';
import { runCrash } from './crash';
import { COUPE, COUPE_CRASH_PROBES } from './defs/coupe';
import { PICKUP, PICKUP_CRASH_PROBES, PICKUP_DESIGN } from './defs/pickup';
import { SEDAN } from './defs/sedan';
import { createHandlingSim, stepN } from './handling';
import type { CompiledVehicle, VehicleDef } from './types';
import type { CrashProbes } from './crash';

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

/** Per vehicle: the front-right door (its shut-edge node, the latch-pillar reference, the hinge axis) and every door prefix. */
interface ClosureCase {
  def: VehicleDef;
  probes?: CrashProbes;
  door: string;
  edge: string;
  ref: string;
  axis: readonly [string, string];
  doors: readonly string[];
  /** Worst door-skin strain allowed after the 64 km/h frontal (default 3 %). */
  maxSkinStrain?: number;
}
const CASES: readonly ClosureCase[] = [
  { def: SEDAN, door: 'dFR', edge: 'dFR_12', ref: 's7_dm_R', axis: ['s5_sl_R', 's5_hp_R'], doors: ['dFR_', 'dFL_', 'dRR_', 'dRL_'] },
  { def: COUPE, probes: COUPE_CRASH_PROBES, door: 'dR', edge: 'dR_12', ref: 's7_dm_R', axis: ['s5_sl_R', 's5_hp_R'], doors: ['dR_', 'dL_'] },
  { def: PICKUP, probes: PICKUP_CRASH_PROBES, door: 'dFR', edge: 'dFR_12', ref: 'c2_dm_R', axis: ['c0_sl_R', 'c0_hp_R'], doors: ['dFR_', 'dFL_', 'dRR_', 'dRL_'], maxSkinStrain: 0.1 },
];

for (const c of CASES) {
  describe(`${c.def.name} hinged closures`, () => {
    it('an unlatched front door swings as a stiff panel: out to its stop braking, back toward closed accelerating', () => {
      const sim = createHandlingSim({ def: c.def });
      const s = sim.eng.state;
      const ids = sim.cv.rig.nodeIds;
      const n0 = sim.obj.nodeStart;
      const at = new Map(ids.map((id, i) => [id, i] as const));
      const P = (id: string): V3 => {
        const i = n0 + at.get(id)!;
        return [s.posX[i]!, s.posY[i]!, s.posZ[i]!];
      };
      const ang = () => hingeAngle(P, c.edge, c.ref, c.axis[0], c.axis[1]);
      stepN(sim, 1000);
      const a0 = ang();
      // pop the latch: break one of its latch beams; the zone's latch pass lets the rest go
      const body = sim.veh.shell![0]!;
      const sh = sim.cv.shell[0]!;
      const latch = Array.from(sh.latchBeams).find((b) => [sim.cv.rig.beamA[b]!, sim.cv.rig.beamB[b]!].some((i) => ids[i]!.startsWith(`${c.door}_`)));
      expect(latch).toBeDefined();
      s.active[sim.obj.beamStart + latch!] = 0;
      stepN(sim, 4000);
      expect(Array.from(body.latchOff).filter((x) => x === 1)).toHaveLength(1);
      // its own cluster woke (weights 1) and the panel is held (not a sagging node lattice)
      const door = sim.veh.shell!.find((rt) => rt !== body && Array.from(rt.nodes).some((i) => ids[i - n0] === c.edge))!;
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
      const skin = closureSkin(sim.cv, s, sim.obj, `${c.door}_`);
      expect(skin.strain).toBeLessThan(0.02);
      expect(skin.set).toBe(0);
    }, 900_000);

    it('a 64 km/h frontal leaves the doors latched and undented (the open stop breaks, not the door)', () => {
      const cv = compileVehicle(c.def);
      let checked = false;
      runCrash({
        kind: 'frontal',
        speedKmh: 64,
        def: c.def,
        ...(c.probes ? { probes: c.probes } : {}),
        onStep: (eng, obj, since) => {
          if (since !== 3000) return;
          checked = true;
          const rt = eng.getVehicle(obj.objectId)!.shell![0]!;
          expect(Array.from(rt.latchOff).every((x) => x === 0)).toBe(true);
          for (const d of c.doors) {
            const skin = closureSkin(cv, eng.state, obj, d);
            // no dent (no member set); the strain bound catches a door pushed in (29 % with the open stop on
            // the crushing fender unbreakable): the pickup's cab racks on its frame mounts, so its inner panel
            // node sits up to 9 % off (elastic) in a door frame that is no longer square
            expect(skin.strain, d).toBeLessThan(c.maxSkinStrain ?? 0.03);
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
        def: c.def,
        ...(c.probes ? { probes: c.probes } : {}),
        onStep: (eng, obj, since) => {
          if (since === 3000) off = Array.from(eng.getVehicle(obj.objectId)!.shell![0]!.latchOff).filter((x) => x !== 0).length;
        },
      });
      expect(off).toBe(0);
    }, 900_000);
  });
}

describe('pickup tailgate', () => {
  it('an unlatched tailgate drops open and hangs level on its support cables', () => {
    const sim = createHandlingSim({ def: PICKUP });
    const s = sim.eng.state;
    const ids = sim.cv.rig.nodeIds;
    const n0 = sim.obj.nodeStart;
    const at = new Map(ids.map((id, i) => [id, i] as const));
    const P = (id: string): V3 => {
      const i = n0 + at.get(id)!;
      return [s.posX[i]!, s.posY[i]!, s.posZ[i]!];
    };
    const ang = () => hingeAngle(P, 'tg_1Ci', 'b3_rl_R', 'b3_bo_L', 'b3_bo_R');
    stepN(sim, 1000);
    const a0 = ang();
    expect(PICKUP_DESIGN.tailgateCables).toHaveLength(2);
    const [la, lb] = PICKUP_DESIGN.tailgateLatches[0]!;
    for (let b = 0; b < sim.cv.bodyBeamCount; b++) {
      if (ids[sim.cv.rig.beamA[b]!] === la && ids[sim.cv.rig.beamB[b]!] === lb) s.active[sim.obj.beamStart + b] = 0;
    }
    stepN(sim, 6000);
    const open = Math.abs(ang() - a0);
    // drops to its cables (≈ 90°, their compliance) and stays there; the gate keeps its shape (its cluster woke)
    expect(open).toBeGreaterThan(80);
    expect(open).toBeLessThan(105);
    const gate = sim.veh.shell!.find((rt) => Array.from(rt.nodes).some((i) => ids[i - n0] === 'tg_1Ci') && rt.shell.dormant !== null)!;
    expect(Math.min(...Array.from(gate.w))).toBe(1);
  }, 600_000);
});
