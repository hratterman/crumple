/**
 * K&C (kinematics & compliance) BENCH — harness only. Like an industry K&C
 * rig: the sprung body is clamped (every node outside the unsprung groups
 * pinned, shell cluster off) and the wheels stand on a plane whose height is
 * stepped (heave), with the tyre friction removed (the rig's slip plates) so
 * the contact patches move freely. Per corner it measures, in the body frame:
 *   wheel-centre travel z, camber (+ = top outboard), toe (+ = toe-in), the
 *   contact-patch lateral and longitudinal positions, and the vertical load,
 * and reduces them to the standard numbers:
 *   camber gain (deg / cm of bump), bump steer (deg / cm), wheel rate (N/mm),
 *   kinematic roll-centre height h_rc = (t/2)·dy_cp/dz (the contact point rigidly
 *   carried by the upright — a locked wheel — moving
 *   OUTBOARD in bump puts the roll centre above the ground; Milliken RCVD
 *   ch. 17), side-view swing-arm angle at the contact patch, tan θ = dx_cp/dz,
 *   and anti-dive (front) / anti-lift (rear) % = tan θ · L/h · 100 for outboard
 *   brakes (Milliken RCVD ch. 17.4, Gillespie §9).
 * Compliance: a braking torque reaction (wheels.ts applyUprightReaction) is
 * applied at a fixed ride height and the camber / toe / caster change per
 * kN·m is read.
 */
import { SIM_HZ } from '../../engine';
import { createHandlingSim, stepN, type HandlingSim } from '../handling';
import type { VehicleDef, WheelRuntime } from '../types';
import type { VehicleRuntimeEx } from '../runtime';
import { applyUprightReaction } from '../wheels';

const UNSPRUNG = new Set(['knuckle', 'wheelHub', 'wheelRim', 'wheelTire', 'axle']);

export interface CornerKC {
  id: string;
  /** Wheel centre travel (+ bump), m, per heave step. */
  z: number[];
  camberDeg: number[];
  toeDeg: number[];
  /** Contact patch lateral (outboard +) and longitudinal (forward +) position, m. */
  cpY: number[];
  cpX: number[];
  /** Wheel-centre longitudinal position (forward +), m. */
  cX: number[];
  load: number[];
}

export interface KCResult {
  corners: CornerKC[];
  /** Per corner (declaration order): reduced numbers. */
  camberGain: number[];
  bumpSteer: number[];
  wheelRate: number[];
  rollCentre: number[];
  svsaTan: number[];
  /** anti-dive (front wheels) / anti-lift (rear wheels), %, outboard brakes (locked-wheel contact point path). */
  antiPct: number[];
  /** anti-squat (driven rear) / anti-lift in acceleration (driven front), %, inboard drive: wheel-centre path, tan θ·L/h. */
  antiSquatPct: number[];
  /** Compliance: camber / toe change per kN·m of brake torque reaction, deg. */
  brakeCamberPerKNm: number[];
  brakeToePerKNm: number[];
  track: number[];
  wheelbase: number;
  cgHeight: number;
}

interface Frame {
  ox: number;
  oy: number;
  oz: number;
  /** body forward, up, right unit vectors */
  f: [number, number, number];
  u: [number, number, number];
  r: [number, number, number];
}

function bodyFrame(sim: HandlingSim): Frame {
  const s = sim.eng.state;
  const fr = sim.cv.frameNodes;
  const o = sim.obj.nodeStart + fr[0]!;
  const fi = sim.obj.nodeStart + fr[1]!;
  const ti = sim.obj.nodeStart + fr[2]!;
  let fx = s.posX[fi]! - s.posX[o]!;
  let fy = s.posY[fi]! - s.posY[o]!;
  let fz = s.posZ[fi]! - s.posZ[o]!;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let ux = s.posX[ti]! - s.posX[o]!;
  let uy = s.posY[ti]! - s.posY[o]!;
  let uz = s.posZ[ti]! - s.posZ[o]!;
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  return { ox: s.posX[o]!, oy: s.posY[o]!, oz: s.posZ[o]!, f: [fx, fy, fz], u: [ux, uy, uz], r: [fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux] };
}

function toBody(fr: Frame, x: number, y: number, z: number): [number, number, number] {
  const dx = x - fr.ox;
  const dy = y - fr.oy;
  const dz = z - fr.oz;
  return [dx * fr.r[0] + dy * fr.r[1] + dz * fr.r[2], dx * fr.u[0] + dy * fr.u[1] + dz * fr.u[2], dx * fr.f[0] + dy * fr.f[1] + dz * fr.f[2]];
}

/** Upright frame (body coordinates) from hubI, hubO and the upright's first reaction node: origin + 3 unit axes. */
function uprightFrame(sim: HandlingSim, w: WheelRuntime): { o: [number, number, number]; e: [number, number, number][] } {
  const s = sim.eng.state;
  const fr = bodyFrame(sim);
  const I = toBody(fr, s.posX[w.hubI]!, s.posY[w.hubI]!, s.posZ[w.hubI]!);
  const O = toBody(fr, s.posX[w.hubO]!, s.posY[w.hubO]!, s.posZ[w.hubO]!);
  const kn = w.reactNodes && w.reactNodes.length > 0 ? w.reactNodes[0]! : w.attachNodes[0]!;
  const K = toBody(fr, s.posX[kn]!, s.posY[kn]!, s.posZ[kn]!);
  const sub = (a: number[], b: number[]): [number, number, number] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const nrm = (a: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const e1 = nrm(sub(O, I));
  const k = sub(K, I);
  const d = k[0] * e1[0] + k[1] * e1[1] + k[2] * e1[2];
  const e2 = nrm([k[0] - d * e1[0], k[1] - d * e1[1], k[2] - d * e1[2]]);
  const e3: [number, number, number] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  return { o: I, e: [e1, e2, e3] };
}

/** Camber (+ top outboard), toe (+ toe-in, deg), centre and contact patch in the body frame. */
function cornerState(sim: HandlingSim, w: WheelRuntime): { camber: number; toe: number; c: [number, number, number]; cp: [number, number, number] } {
  const s = sim.eng.state;
  const fr = bodyFrame(sim);
  const I = toBody(fr, s.posX[w.hubI]!, s.posY[w.hubI]!, s.posZ[w.hubI]!);
  const O = toBody(fr, s.posX[w.hubO]!, s.posY[w.hubO]!, s.posZ[w.hubO]!);
  const side = O[0] > I[0] ? 1 : -1; // outboard direction (body right +)
  const ax = (O[0] - I[0]) * side;
  const ay = O[1] - I[1];
  const az = O[2] - I[2];
  const l = Math.hypot(ax, ay, az);
  // camber: outboard hub lower → top leans outboard → +
  const camber = (-Math.asin(ay / l) * 180) / Math.PI;
  // toe-in: the wheel's front points inboard, so the outboard end of the axle swings FORWARD (+forward)
  const toe = (Math.atan2(az, ax) * 180) / Math.PI;
  const c: [number, number, number] = [(I[0] + O[0]) / 2, (I[1] + O[1]) / 2, (I[2] + O[2]) / 2];
  // contact patch: the load-weighted tread node position (in contact), else the lowest tread node
  let wx = 0;
  let wy = 0;
  let wz = 0;
  let wsum = 0;
  for (let j = 0; j < w.ringCount; j++) {
    const L = w.treadLoad[j]!;
    if (!(L > 0)) continue;
    const i = w.tireStart + j;
    const p = toBody(fr, s.posX[i]!, s.posY[i]!, s.posZ[i]!);
    wx += p[0] * L;
    wy += p[1] * L;
    wz += p[2] * L;
    wsum += L;
  }
  const cp: [number, number, number] = wsum > 0 ? [wx / wsum, wy / wsum, wz / wsum] : [c[0], c[1] - w.wheel.radius, c[2]];
  return { camber, toe, c, cp };
}

function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

/**
 * Runs the K&C sweep. `travel` = ground offsets (m, + raises the ground =
 * bump) around the settled ride height.
 */
export function runKC(def: VehicleDef, travel: number[] = [-0.04, -0.02, 0, 0.02, 0.04]): KCResult {
  const sim = createHandlingSim({ def: { ...def, shell: false } });
  stepN(sim, Math.round(2 * SIM_HZ));
  const s = sim.eng.state;
  const veh = sim.veh as VehicleRuntimeEx;
  // CG height before clamping (wheels on the ground at ride height)
  let m = 0;
  let cy = 0;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) {
    const im = s.invMass[i]!;
    if (im === 0) continue;
    m += 1 / im;
    cy += s.posY[i]! / im;
  }
  const cgHeight = cy / m;
  // clamp the body
  const groups = sim.cv.rig.nodeGroup;
  const names = sim.cv.rig.groups;
  for (let i = 0; i < sim.cv.rig.nodeCount; i++) {
    const gi0 = groups[i]!;
    const g = gi0 >= 0 ? names[gi0]! : '';
    if (UNSPRUNG.has(g)) continue;
    const gi = sim.obj.nodeStart + i;
    s.invMass[gi] = 0;
    s.velX[gi] = 0;
    s.velY[gi] = 0;
    s.velZ[gi] = 0;
  }
  // slip plates: no tyre friction (the tyre model rewrites μ from its base every tick)
  for (const t of veh.tyres) t.base.fill(0);
  sim.eng.setInput(1, { gearSelect: 0, brake: 0, handbrake: 0 });
  const corners: CornerKC[] = veh.wheels.map((w) => ({ id: w.wheel.id, z: [], camberDeg: [], toeDeg: [], cpY: [], cpX: [], cX: [], load: [] }));
  const settleTicks = Math.round(0.6 * SIM_HZ);
  const avgTicks = Math.round(0.2 * SIM_HZ);
  const ref = veh.wheels.map((w) => cornerState(sim, w));
  // KINEMATIC contact point: the rest contact patch rigidly attached to the upright (a locked, braked wheel;
  // Milliken RCVD ch. 17): free of tread-node sliding on the frictionless plates
  const cpLocal = veh.wheels.map((w, k) => {
    const u = uprightFrame(sim, w);
    const r = ref[k]!.cp;
    const d = [r[0] - u.o[0], r[1] - u.o[1], r[2] - u.o[2]];
    return u.e.map((e) => d[0]! * e[0] + d[1]! * e[1] + d[2]! * e[2]);
  });
  const cpKin = (w: WheelRuntime, k: number): [number, number, number] => {
    const u = uprightFrame(sim, w);
    const l = cpLocal[k]!;
    return [0, 1, 2].map((i) => u.o[i]! + l[0]! * u.e[0]![i]! + l[1]! * u.e[1]![i]! + l[2]! * u.e[2]![i]!) as [number, number, number];
  };
  const cpRef = veh.wheels.map((w, k) => cpKin(w, k));
  for (const h of travel) {
    sim.eng.setGroundPlane(h, 0);
    stepN(sim, settleTicks);
    const acc = veh.wheels.map(() => ({ camber: 0, toe: 0, cz: 0, cpy: 0, cpx: 0, cx: 0, load: 0 }));
    for (let t = 0; t < avgTicks; t++) {
      sim.eng.step();
      veh.wheels.forEach((w, k) => {
        const st = cornerState(sim, w);
        const a = acc[k]!;
        const side = st.c[0] > 0 ? 1 : -1;
        a.camber += st.camber;
        a.toe += st.toe;
        a.cz += st.c[1] - ref[k]!.c[1];
        a.cx += st.c[2] - ref[k]!.c[2];
        const ck = cpKin(w, k);
        a.cpy += (ck[0] - cpRef[k]![0]) * side;
        a.cpx += ck[2] - cpRef[k]![2];
        a.load += w.load;
      });
    }
    acc.forEach((a, k) => {
      const c = corners[k]!;
      c.z.push(a.cz / avgTicks);
      c.camberDeg.push(a.camber / avgTicks);
      c.toeDeg.push(a.toe / avgTicks);
      c.cpY.push(a.cpy / avgTicks);
      c.cpX.push(a.cpx / avgTicks);
      c.cX.push(a.cx / avgTicks);
      c.load.push(a.load / avgTicks);
    });
  }
  // geometry for anti-dive / roll centre
  const hubZ = veh.wheels.map((w) => {
    const st = cornerState(sim, w);
    return st.c;
  });
  const front = veh.wheels.filter((w) => w.wheel.axle === 'front');
  const rear = veh.wheels.filter((w) => w.wheel.axle === 'rear');
  const zOf = (ws: WheelRuntime[]): number => ws.reduce((a, w) => a + hubZ[veh.wheels.indexOf(w)]![2], 0) / ws.length;
  const wheelbase = Math.abs(zOf(front) - zOf(rear));
  const track = veh.wheels.map((w, k) => 2 * Math.abs(hubZ[k]![0]));
  const camberGain: number[] = [];
  const bumpSteer: number[] = [];
  const wheelRate: number[] = [];
  const rollCentre: number[] = [];
  const svsaTan: number[] = [];
  const antiPct: number[] = [];
  const antiSquatPct: number[] = [];
  corners.forEach((c, k) => {
    camberGain.push(slope(c.z, c.camberDeg) / 100);
    bumpSteer.push(slope(c.z, c.toeDeg) / 100);
    wheelRate.push(slope(c.z, c.load) / 1000);
    const dy = slope(c.z, c.cpY);
    rollCentre.push((track[k]! / 2) * dy);
    // side-view: the locked-wheel contact point's forward motion per bump. Braking pushes the contact point
    // rearward, so a front contact point moving FORWARD in bump (side-view IC behind the wheel, above the
    // ground) makes the brake force extend the front suspension = anti-dive; a rear one moving REARWARD
    // (IC ahead and above) = anti-lift (Milliken RCVD ch. 17.4, by virtual work)
    const dx = slope(c.z, c.cpX);
    const isFront = veh.wheels[k]!.wheel.axle === 'front';
    const t = isFront ? dx : -dx;
    svsaTan.push(t);
    antiPct.push((t * wheelbase * 100) / cgHeight);
    // acceleration: a rear wheel centre moving REARWARD in bump (dx < 0) resists squat; a front one moving forward resists lift
    const dc = slope(c.z, c.cX);
    antiSquatPct.push(((isFront ? dc : -dc) * wheelbase * 100) / cgHeight);
  });
  // compliance: brake torque reaction at ride height (ground back at 0), 1 kN·m per wheel
  sim.eng.setGroundPlane(0, 0);
  stepN(sim, settleTicks);
  const before = veh.wheels.map((w) => cornerState(sim, w));
  const tq = 1000;
  for (let t = 0; t < settleTicks; t++) {
    for (const w of veh.wheels) applyUprightReaction(s, w, -tq);
    sim.eng.step();
  }
  const after = veh.wheels.map((w) => cornerState(sim, w));
  return {
    corners,
    camberGain,
    bumpSteer,
    wheelRate,
    rollCentre,
    svsaTan,
    antiPct,
    antiSquatPct,
    brakeCamberPerKNm: after.map((a, k) => a.camber - before[k]!.camber),
    brakeToePerKNm: after.map((a, k) => a.toe - before[k]!.toe),
    track,
    wheelbase,
    cgHeight,
  };
}
