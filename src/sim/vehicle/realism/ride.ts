/**
 * Ride metrics (harness only): body-bounce frequency and damping per axle
 * (impulse on the sprung mass, free decay) and a bump crossing (a full-width
 * cosine cleat on an otherwise flat road: peak sprung vertical acceleration,
 * the body's settle after the crossing, wheel contact loss).
 */
import type { HeightSampler } from '../../types';
import { createHandlingSim, setMotion, stepN, type HandlingSim } from '../handling';
import type { VehicleDef } from '../types';

const DT = 1 / 2000;
const UNSPRUNG = new Set(['knuckle', 'wheelHub', 'wheelRim', 'wheelTire', 'axle']);

/** Flat ground with one full-width cosine bump (height h, length len) between z = zEnd − len and zEnd. */
export class BumpSampler implements HeightSampler {
  constructor(
    public zEnd: number,
    public h: number,
    public len: number,
    public materialId = 0,
  ) {}
  heightAt(_x: number, z: number): number {
    const u = (this.zEnd - z) / this.len;
    if (u <= 0 || u >= 1) return 0;
    return 0.5 * this.h * (1 - Math.cos(2 * Math.PI * u));
  }
  normalAt(_x: number, z: number, out: Float64Array): void {
    const u = (this.zEnd - z) / this.len;
    // dh/dz = −(h/2)·sin(2πu)·2π/len
    const g = u <= 0 || u >= 1 ? 0 : (-0.5 * this.h * Math.sin(2 * Math.PI * u) * 2 * Math.PI) / this.len;
    const n = Math.sqrt(1 + g * g);
    out[0] = 0;
    out[1] = 1 / n;
    out[2] = -g / n;
  }
  materialAt(): number {
    return this.materialId;
  }
}

/** Sprung node ids (outside the unsprung groups), optionally limited to a z band of the rest pose. */
export function sprungNodes(sim: HandlingSim, zLo = -Infinity, zHi = Infinity): number[] {
  const rig = sim.cv.rig;
  const out: number[] = [];
  for (let i = 0; i < sim.cv.bodyNodeCount; i++) {
    const g = rig.nodeGroup[i]!;
    if (g >= 0 && UNSPRUNG.has(rig.groups[g]!)) continue;
    const z = rig.nodePos[3 * i + 2]!;
    if (z < zLo || z > zHi) continue;
    if (rig.nodeInvMass[i]! === 0) continue;
    out.push(i);
  }
  return out;
}

function massY(sim: HandlingSim, ids: number[], vel: boolean): number {
  const s = sim.eng.state;
  const arr = vel ? s.velY : s.posY;
  let m = 0;
  let y = 0;
  for (const i of ids) {
    const g = sim.obj.nodeStart + i;
    const mi = 1 / s.invMass[g]!;
    m += mi;
    y += mi * arr[g]!;
  }
  return y / m;
}

/** Peaks (local extrema with |x| > floor) of a trace. */
function extrema(tr: number[], floor: number): { i: number; v: number }[] {
  const out: { i: number; v: number }[] = [];
  for (let i = 1; i + 1 < tr.length; i++) {
    if ((tr[i]! - tr[i - 1]!) * (tr[i + 1]! - tr[i]!) < 0 && Math.abs(tr[i]!) > floor) out.push({ i, v: tr[i]! });
  }
  return out;
}

export interface HeaveAxle {
  /** Body-bounce frequency, Hz (first full period). */
  freq: number;
  /** Damping ratio from the decrement over one full period (same-sign peaks: independent of bump / rebound asymmetry). */
  zeta: number;
  trace: number[];
}

/** Sprung mass impulse (all sprung nodes −v0 vertical) at rest, free decay of the front / rear body ends. */
export function runHeave(def: VehicleDef, v0 = 0.25): { front: HeaveAxle; rear: HeaveAxle } {
  const sim = createHandlingSim({ def });
  stepN(sim, 8000);
  const fw = sim.veh.wheels.filter((w) => w.wheel.axle === 'front');
  const rw = sim.veh.wheels.filter((w) => w.wheel.axle === 'rear');
  const zOf = (ws: typeof fw): number => ws.reduce((a, w) => a + sim.cv.rig.nodePos[3 * w.wheel.hubI + 2]!, 0) / ws.length;
  const zf = zOf(fw);
  const zr = zOf(rw);
  const half = 0.35 * Math.abs(zr - zf);
  const fz = sprungNodes(sim, zf - half, zf + half);
  const rz = sprungNodes(sim, zr - half, zr + half);
  const all = sprungNodes(sim);
  const f0 = massY(sim, fz, false);
  const r0 = massY(sim, rz, false);
  const s = sim.eng.state;
  for (const i of all) s.velY[sim.obj.nodeStart + i] = -v0;
  const ft: number[] = [];
  const rt: number[] = [];
  for (let t = 0; t < 6000; t++) {
    sim.eng.step();
    if (t % 10 === 0) {
      ft.push(massY(sim, fz, false) - f0);
      rt.push(massY(sim, rz, false) - r0);
    }
  }
  const axle = (tr: number[]): HeaveAxle => {
    const ex = extrema(tr, 2e-4);
    let freq = NaN;
    let zeta = NaN;
    if (ex.length >= 3) {
      freq = 1 / ((ex[2]!.i - ex[0]!.i) * 10 * DT);
      const d = Math.log(Math.abs(ex[0]!.v / ex[2]!.v));
      zeta = d / Math.sqrt(4 * Math.PI * Math.PI + d * d);
    }
    return { freq, zeta, trace: tr };
  };
  return { front: axle(ft), rear: axle(rt) };
}

export interface BumpResult {
  /** Peak |sprung vertical acceleration| (whole sprung mass) during the crossing, g. */
  peakAccG: number;
  /** RMS sprung vertical acceleration over the crossing + 1.5 s, g. */
  rmsAccG: number;
  /** Body control: peak |sprung heave| from 0.6 s after the rear axle left the bump ÷ peak |heave| over the run. */
  residual: number;
  /** Longest single airborne spell of any wheel, s. */
  maxAirborneS: number;
  samples: [number, number, number][];
}

/** Coasting (neutral) across a full-width cosine bump at `kmh`. */
export function runBump(def: VehicleDef, kmh: number, h: number, len: number): BumpResult {
  const sim = createHandlingSim({ def });
  stepN(sim, 4000);
  const all = sprungNodes(sim);
  const y0 = massY(sim, all, false);
  // bump 4 m ahead of the front axle (the car faces −Z)
  let zFront = Infinity;
  let zRear = -Infinity;
  for (const w of sim.veh.wheels) {
    const z = sim.eng.state.posZ[w.hubI]!;
    zFront = Math.min(zFront, z);
    zRear = Math.max(zRear, z);
  }
  const zEnd = zFront - 4;
  sim.eng.sampler = new BumpSampler(zEnd, h, len);
  const v = kmh / 3.6;
  setMotion(sim, v, 0);
  const wb = zRear - zFront;
  const tRearOff = (4 + wb + len) / v;
  const n = Math.round((tRearOff + 1.5) / DT);
  const samples: [number, number, number][] = [];
  let vyPrev = massY(sim, all, true);
  let acc = 0;
  let peak = 0;
  let sum2 = 0;
  let cnt = 0;
  const air = new Float64Array(sim.veh.wheels.length);
  let maxAir = 0;
  let hPeak = 0;
  let hLate = 0;
  for (let t = 0; t < n; t++) {
    sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0 });
    sim.eng.step();
    const vy = massY(sim, all, true);
    const a = (vy - vyPrev) / DT;
    vyPrev = vy;
    acc += (a - acc) * (DT / (0.005 + DT)); // 5 ms low-pass (seat / sensor bandwidth ≈ 30 Hz)
    const time = t * DT;
    if (time > 3 / v) {
      const ag = Math.abs(acc) / 9.81;
      if (ag > peak) peak = ag;
      sum2 += ag * ag;
      cnt++;
    }
    for (let w = 0; w < air.length; w++) {
      const wr = sim.veh.wheels[w]!;
      air[w] = wr.contact === 0 ? air[w]! + DT : 0;
      if (air[w]! > maxAir) maxAir = air[w]!;
    }
    const hy = Math.abs(massY(sim, all, false) - y0);
    if (hy > hPeak) hPeak = hy;
    if (time > tRearOff + 0.6 && hy > hLate) hLate = hy;
    if (t % 10 === 0) samples.push([time, acc / 9.81, massY(sim, all, false) - y0]);
  }
  return { peakAccG: peak, rmsAccG: Math.sqrt(sum2 / Math.max(1, cnt)), residual: hPeak > 0 ? hLate / hPeak : 0, maxAirborneS: maxAir, samples };
}
