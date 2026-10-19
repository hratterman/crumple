/**
 * Wheel rig + wheel kernels. Engine-free harness: a SimArena driven by the
 * real kernels in the contract's phase order (pre-step → beams → ground →
 * integrate), so these tests do not depend on engine/runtime files.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { Action, ACTION_COUNT, MaterialId } from '../../protocol/messages';
import { applyBeamForces } from '../beams';
import { applyGroundContacts, groundNormalForce, PlaneSampler } from '../collision/ground';
import { DEFAULT_MATERIALS } from '../collision/materials';
import { integrateNodes } from '../integrator';
import { compileRig, computeStabilityReport } from '../rig/builder';
import type { CompiledRig, RigBeamDef, RigNodeDef } from '../rig/types';
import { SimArena } from '../state';
import type { EventSink, HeightSampler, MaterialTable, SimObject, SimState } from '../types';
import {
  WHEEL_BEAMS_PER_RAY,
  WHEEL_DEFAULTS,
  wheelNodeId,
  type CompiledVehicle,
  type CompiledWheel,
  type VehicleRuntime,
  type WheelDef,
  type WheelRuntime,
} from './types';
import { buildWheelRig, WHEEL_TUNING_205_55R16 } from './wheelrig';
import { applyParkingClamp, applyWheelTorques, estimateWheelOmega, setWheelGround } from './wheels';

const DT = 1 / 2000;
const G = -9.81;
const R = WHEEL_TUNING_205_55R16.radius;
const NULL_SINK: EventSink = { impact() {}, beamBreak() {}, skid() {} };

/** Left wheel: axle outboard = −X (vehicle left), so spinSign = +1. */
function wheelDef(over: Partial<WheelDef> = {}): WheelDef {
  return {
    ...WHEEL_TUNING_205_55R16,
    id: 'W',
    hubInner: [0, 0, 0],
    hubOuter: [-WHEEL_TUNING_205_55R16.width, 0, 0],
    axle: 'front',
    steered: false,
    driven: true,
    braked: true,
    brakeTorqueMax: 2000,
    handbrake: true,
    attach: [],
    ...over,
  };
}

// ---------------------------------------------------------------- harness
interface Sim {
  arena: SimArena;
  s: SimState;
  obj: SimObject;
  rig: CompiledRig;
  wheels: WheelRuntime[];
  veh: VehicleRuntime;
  sampler: HeightSampler | null;
  materials: MaterialTable;
  gy: number;
}

interface SimOpts {
  extraNodes?: RigNodeDef[];
  extraBeams?: RigBeamDef[];
  pos?: [number, number, number];
  quat?: [number, number, number, number];
  sampler?: HeightSampler | null;
  materials?: MaterialTable;
  gravity?: boolean;
  pinHubs?: boolean;
}

function makeSim(defs: WheelDef[], opts: SimOpts = {}): Sim {
  const nodes: RigNodeDef[] = [...(opts.extraNodes ?? [])];
  const beams: RigBeamDef[] = [];
  const ranges: { n0: number; b0: number; bc: number }[] = [];
  for (const d of defs) {
    const r = buildWheelRig(d, (id) => nodes.find((x) => x.id === id));
    if (opts.pinHubs) {
      r.nodes[0]!.mass = 0;
      r.nodes[1]!.mass = 0;
    }
    ranges.push({ n0: nodes.length, b0: beams.length, bc: r.beams.length });
    nodes.push(...r.nodes);
    beams.push(...r.beams);
  }
  beams.push(...(opts.extraBeams ?? []));
  const rig = compileRig({ name: 'wheeltest', nodes, beams });
  const arena = new SimArena(rig.nodeCount, rig.beamCount, 1);
  const obj = arena.insert(1, rig, { pos: opts.pos ?? [0, 0, 0], quat: opts.quat ?? [0, 0, 0, 1] });
  const wheels = defs.map((d, k): WheelRuntime => {
    const n = d.rays;
    const n0 = ranges[k]!.n0;
    const cw: CompiledWheel = {
      id: d.id,
      index: k,
      axle: d.axle,
      spinSign: d.hubOuter[0] - d.hubInner[0] < 0 ? 1 : -1,
      corner: k,
      rays: n,
      radius: d.radius,
      rimRadius: d.rimRadius,
      tireRingRadius: d.radius - (d.tireNodeRadius ?? WHEEL_DEFAULTS.tireNodeRadius),
      nodeStart: n0,
      nodeCount: 2 + 4 * n,
      hubI: n0,
      hubO: n0 + 1,
      rimStart: n0 + 2,
      tireStart: n0 + 2 + 2 * n,
      beamStart: ranges[k]!.b0,
      beamCount: ranges[k]!.bc,
      hubLinkBeams: new Int32Array(0),
      steered: d.steered,
      driven: d.driven,
      braked: d.braked,
      handbrake: d.handbrake,
      brakeTorque: d.braked ? d.brakeTorqueMax : 0,
      handbrakeTorque: d.handbrake ? d.brakeTorqueMax : 0,
      friction: d.friction,
    };
    const b = obj.nodeStart;
    return {
      wheel: cw,
      hubI: b + cw.hubI,
      hubO: b + cw.hubO,
      rimStart: b + cw.rimStart,
      tireStart: b + cw.tireStart,
      ringCount: 2 * n,
      hubLinkBeams: new Int32Array(0),
      omega: 0,
      load: 0,
      slipSpeed: 0,
      slipRatio: 0,
      rollRadius: 0.3,
      contact: 0,
      detached: 0,
      driveTorque: 0,
      brakeTorque: 0,
    };
  });
  const veh: VehicleRuntime = {
    objectId: 1,
    vehicle: { rig } as unknown as CompiledVehicle,
    nodeStart: obj.nodeStart,
    beamStart: obj.beamStart,
    wheels,
    drivetrain: {} as VehicleRuntime['drivetrain'],
    telemetry: new Float32Array(32),
  };
  const sampler = opts.sampler === undefined ? new PlaneSampler(0, MaterialId.asphalt) : opts.sampler;
  const materials = opts.materials ?? DEFAULT_MATERIALS;
  setWheelGround(sampler, materials, DT);
  return { arena, s: arena.state, obj, rig, wheels, veh, sampler, materials, gy: opts.gravity === false ? 0 : G };
}

function step(sim: Sim, pre?: () => void): void {
  const { s, obj } = sim;
  pre?.();
  applyBeamForces(s, obj.beamStart, obj.beamCount, NULL_SINK, false);
  if (sim.sampler) applyGroundContacts(s, obj.nodeStart, obj.nodeCount, sim.sampler, sim.materials, DT, 1, NULL_SINK);
  integrateNodes(s, obj.nodeStart, obj.nodeCount, DT, 0, sim.gy, 0);
}

function hubCentre(sim: Sim, w: WheelRuntime): [number, number, number] {
  const s = sim.s;
  return [(s.posX[w.hubI]! + s.posX[w.hubO]!) / 2, (s.posY[w.hubI]! + s.posY[w.hubO]!) / 2, (s.posZ[w.hubI]! + s.posZ[w.hubO]!) / 2];
}

function allFinite(s: SimState): boolean {
  for (let i = 0; i < s.nodeCount; i++) {
    for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ]) if (!Number.isFinite(a[i]!)) return false;
  }
  return true;
}

/** Unit spin axis s = spinSign·normalize(hubO − hubI). */
function spinAxis(sim: Sim, w: WheelRuntime): [number, number, number] {
  const s = sim.s;
  const d = [s.posX[w.hubO]! - s.posX[w.hubI]!, s.posY[w.hubO]! - s.posY[w.hubI]!, s.posZ[w.hubO]! - s.posZ[w.hubI]!];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!) / w.wheel.spinSign;
  return [d[0]! / l, d[1]! / l, d[2]! / l];
}

/** Axial angular momentum and inertia of a wheel's ring nodes about its hub axis (independent of wheels.ts). */
function wheelSpin(sim: Sim, w: WheelRuntime): { L: number; I: number } {
  const s = sim.s;
  const c = hubCentre(sim, w);
  const [sx, sy, sz] = spinAxis(sim, w);
  const vc = [(s.velX[w.hubI]! + s.velX[w.hubO]!) / 2, (s.velY[w.hubI]! + s.velY[w.hubO]!) / 2, (s.velZ[w.hubI]! + s.velZ[w.hubO]!) / 2];
  let L = 0;
  let I = 0;
  for (let i = w.rimStart; i < w.rimStart + 2 * w.ringCount; i++) {
    const m = 1 / s.invMass[i]!;
    const r = [s.posX[i]! - c[0], s.posY[i]! - c[1], s.posZ[i]! - c[2]];
    const ax = r[0]! * sx + r[1]! * sy + r[2]! * sz;
    const p = [r[0]! - ax * sx, r[1]! - ax * sy, r[2]! - ax * sz];
    const v = [s.velX[i]! - vc[0]!, s.velY[i]! - vc[1]!, s.velZ[i]! - vc[2]!];
    L += m * ((p[1]! * v[2]! - p[2]! * v[1]!) * sx + (p[2]! * v[0]! - p[0]! * v[2]!) * sy + (p[0]! * v[1]! - p[1]! * v[0]!) * sz);
    I += m * (p[0]! * p[0]! + p[1]! * p[1]! + p[2]! * p[2]!);
  }
  return { L, I };
}

/** Adds rigid spin ω (about s) to a wheel's ring nodes: v += ω·(s × ρ). */
function addSpin(sim: Sim, w: WheelRuntime, omega: number): void {
  const s = sim.s;
  const c = hubCentre(sim, w);
  const [sx, sy, sz] = spinAxis(sim, w);
  for (let i = w.rimStart; i < w.rimStart + 2 * w.ringCount; i++) {
    const rx = s.posX[i]! - c[0];
    const ry = s.posY[i]! - c[1];
    const rz = s.posZ[i]! - c[2];
    s.velX[i] = s.velX[i]! + omega * (sy * rz - sz * ry);
    s.velY[i] = s.velY[i]! + omega * (sz * rx - sx * rz);
    s.velZ[i] = s.velZ[i]! + omega * (sx * ry - sy * rx);
  }
}

/** Mean normal force on the tyre nodes with the hubs held kinematically at height R − defl. */
function staticLoadAt(defl: number): number {
  const sim = makeSim([wheelDef()], { pinHubs: true, pos: [0, R, 0] });
  const s = sim.s;
  const w = sim.wheels[0]!;
  const ramp = 600;
  const total = 2000;
  let acc = 0;
  let cnt = 0;
  for (let t = 0; t < total; t++) {
    const y = R - defl * Math.min(1, t / ramp);
    s.posY[w.hubI] = y;
    s.posY[w.hubO] = y;
    step(sim);
    if (t >= total - 400) {
      for (let j = 0; j < w.ringCount; j++) acc += groundNormalForce(s, w.tireStart + j, sim.sampler!, DT);
      cnt++;
    }
  }
  return acc / cnt;
}

// ---------------------------------------------------------------- cart: 2 wheels + rigid frame
/** Plane rising toward +Z with grade g (h = g·z). */
class SlopeSampler implements HeightSampler {
  private readonly ny: number;
  private readonly nz: number;
  constructor(private readonly g: number) {
    const l = Math.sqrt(1 + g * g);
    this.ny = 1 / l;
    this.nz = -g / l;
  }
  heightAt(_x: number, z: number): number {
    return this.g * z;
  }
  normalAt(_x: number, _z: number, out: Float64Array): void {
    out[0] = 0;
    out[1] = this.ny;
    out[2] = this.nz;
  }
  materialAt(): number {
    return MaterialId.asphalt;
  }
}

/**
 * Four wheels (FL FR RL RR; L outboard −X, R outboard +X; axles at z = ∓0.8)
 * on a rigid frame: per axle a braced tetrahedron centred on the axle line
 * (COM on it, every hub braced to 4 non-coplanar nodes), the two tetrahedra
 * cross-braced. ~1400 kg total, ≈ 3.4 kN per wheel. Hubs are heavy enough
 * to carry the stiff frame beams within the ω·dt limits.
 */
function makeCart(grade = 0, opts: { materials?: MaterialTable; wheel?: Partial<WheelDef> } = {}): Sim {
  const W = WHEEL_TUNING_205_55R16.width;
  const T = 0.6;
  const A = 0.8;
  const defs: WheelDef[] = [];
  const extraNodes: RigNodeDef[] = [];
  const extraBeams: RigBeamDef[] = [];
  const fb = (a: string, b: string) => extraBeams.push({ a, b, type: 'normal', k: 1e6, d: 2000, deform: 0, breakF: 0 });
  const fm = 1100 / 8;
  for (const [ax, z] of [['F', -A], ['R', A]] as const) {
    defs.push(wheelDef({ id: `${ax}L`, hubInner: [-T, 0, z], hubOuter: [-T - W, 0, z], hubMass: 40, ...opts.wheel }));
    defs.push(wheelDef({ id: `${ax}R`, hubInner: [T, 0, z], hubOuter: [T + W, 0, z], hubMass: 40, ...opts.wheel }));
    const f = [1, 2, 3, 4].map((i) => `${ax}${i}`);
    extraNodes.push(
      { id: f[0]!, pos: [-0.45, 0.1, z - 0.3], mass: fm, collidable: false },
      { id: f[1]!, pos: [0.45, 0.1, z + 0.3], mass: fm, collidable: false },
      { id: f[2]!, pos: [-0.45, -0.1, z + 0.3], mass: fm, collidable: false },
      { id: f[3]!, pos: [0.45, -0.1, z - 0.3], mass: fm, collidable: false },
    );
    for (const h of [`${ax}L.hubI`, `${ax}L.hubO`, `${ax}R.hubI`, `${ax}R.hubO`]) for (const n of f) fb(n, h);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) fb(f[i]!, f[j]!);
  }
  for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) fb(`F${i}`, `R${j}`);
  const th = Math.atan(grade);
  return makeSim(defs, {
    extraNodes,
    extraBeams,
    // Local +Y onto the slope normal (0, cos θ, −sin θ): rotation about X by −θ.
    quat: [Math.sin(-th / 2), 0, 0, Math.cos(-th / 2)],
    pos: [0, R * Math.cos(th), -R * Math.sin(th)],
    sampler: grade !== 0 ? new SlopeSampler(grade) : new PlaneSampler(0, MaterialId.asphalt),
    materials: opts.materials,
  });
}

function cartCentre(sim: Sim): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const w of sim.wheels) {
    const h = hubCentre(sim, w);
    for (let k = 0; k < 3; k++) c[k]! += h[k]! / sim.wheels.length;
  }
  return c;
}

/** Heading change proxy: (z_left − z_right) of the front axle / track, rad. */
function cartYaw(sim: Sim): number {
  return (hubCentre(sim, sim.wheels[0]!)[2] - hubCentre(sim, sim.wheels[1]!)[2]) / (2 * 0.6 + WHEEL_TUNING_205_55R16.width);
}

/** Vehicle pre-step stand-in (contract order): ω all wheels → torques → parking clamp. */
function preStep(sim: Sim, actions: Float64Array, drive = 0, clamp = true): void {
  for (const w of sim.wheels) estimateWheelOmega(sim.s, w);
  for (const w of sim.wheels) {
    const service = w.wheel.brakeTorque * actions[Action.brake]!;
    const hand = w.wheel.handbrakeTorque * actions[Action.handbrake]!;
    applyWheelTorques(sim.s, w, drive, service > hand ? service : hand);
  }
  if (clamp) applyParkingClamp(sim.s, sim.veh, actions, DT);
}

// ================================================================ tests
describe('buildWheelRig', () => {
  const def = wheelDef({ id: 'FL', attach: ['k1', 'k2'] });
  const body: RigNodeDef[] = [
    { id: 'k1', pos: [0.1, 0.1, 0], mass: 5 },
    { id: 'k2', pos: [0.1, -0.1, 0], mass: 5 },
  ];
  const lookup = (id: string) => body.find((n) => n.id === id);
  const { nodes, beams } = buildWheelRig(def, lookup);
  const n = def.rays;

  it('emits nodes in canonical order with the frozen ids', () => {
    expect(nodes.length).toBe(2 + 4 * n);
    const ids = [wheelNodeId('FL', 'hubI'), wheelNodeId('FL', 'hubO')];
    for (const p of ['rimI', 'rimO', 'tireI', 'tireO'] as const) for (let k = 0; k < n; k++) ids.push(wheelNodeId('FL', p, k));
    expect(nodes.map((x) => x.id)).toEqual(ids);
    expect(nodes[2]!.id).toBe('FL.rimI0');
    expect(nodes[2 + 4 * n - 1]!.id).toBe(`FL.tireO${n - 1}`);
  });

  it('places geometry, masses, groups and contact properties as documented', () => {
    const byId = new Map(nodes.map((x) => [x.id, x]));
    expect(byId.get('FL.hubI')!.pos).toEqual(def.hubInner);
    expect(byId.get('FL.hubO')!.pos).toEqual(def.hubOuter);
    // a = −X, e1 = Y × a = +Z, e2 = a × e1 = +Y; centre (−W/2, 0, 0); inner plane at x = 0.
    const W = def.width;
    const r0 = byId.get('FL.rimI0')!.pos;
    expect(r0[0]).toBeCloseTo(0, 12);
    expect(r0[2]).toBeCloseTo(def.rimRadius, 12);
    const t3 = byId.get('FL.tireO3')!.pos; // θ = 90° → +Y
    expect(t3[0]).toBeCloseTo(-W, 12);
    expect(t3[1]).toBeCloseTo(def.radius - WHEEL_DEFAULTS.tireNodeRadius, 12);
    const t9 = byId.get('FL.tireI9')!.pos; // θ = 270° → bottom; contact surface at −radius
    expect(t9[1] - WHEEL_DEFAULTS.tireNodeRadius).toBeCloseTo(-def.radius, 12);
    const sum = (p: string) => nodes.filter((x) => x.id.includes(p)).reduce((a, x) => a + x.mass, 0);
    expect(sum('.hub')).toBeCloseTo(def.hubMass, 9);
    expect(sum('.rim')).toBeCloseTo(def.rimMass, 9);
    expect(sum('.tire')).toBeCloseTo(def.tireMass, 9);
    for (const x of nodes) {
      if (x.id.includes('.hub')) expect([x.collidable, x.group]).toEqual([false, WHEEL_DEFAULTS.hubGroup]);
      if (x.id.includes('.rim')) expect([x.collidable, x.group, x.friction]).toEqual([true, WHEEL_DEFAULTS.rimGroup, WHEEL_DEFAULTS.rimFriction]);
      if (x.id.includes('.tire')) expect([x.collidable, x.group, x.friction, x.radius]).toEqual([true, WHEEL_DEFAULTS.tireGroup, def.friction, WHEEL_DEFAULTS.tireNodeRadius]);
    }
  });

  it('emits beams in WHEEL BEAM ORDER with the right parameter groups', () => {
    expect(beams.length).toBe(2 * def.attach.length + 1 + WHEEL_BEAMS_PER_RAY * n);
    const pairs = beams.map((b) => `${b.a}-${b.b}`);
    const expected = ['FL.hubI-k1', 'FL.hubO-k1', 'FL.hubI-k2', 'FL.hubO-k2', 'FL.hubI-FL.hubO'];
    const hI = 'FL.hubI';
    const hO = 'FL.hubO';
    const rI = (j: number) => `FL.rimI${j}`;
    const rO = (j: number) => `FL.rimO${j}`;
    const tI = (j: number) => `FL.tireI${j}`;
    const tO = (j: number) => `FL.tireO${j}`;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      expected.push(
        `${hI}-${rI(k)}`, `${hO}-${rO(k)}`, `${hI}-${rO(k)}`, `${hO}-${rI(k)}`,
        `${rI(k)}-${rO(k)}`, `${rI(k)}-${rI(k1)}`, `${rO(k)}-${rO(k1)}`, `${rI(k)}-${rO(k1)}`,
        `${tI(k)}-${tI(k1)}`, `${tO(k)}-${tO(k1)}`, `${tI(k)}-${tO(k)}`, `${tI(k)}-${tO(k1)}`,
        `${rI(k)}-${tI(k)}`, `${rO(k)}-${tO(k)}`, `${rI(k)}-${tI(k1)}`, `${rO(k)}-${tO(k1)}`,
        `${rI(k1)}-${tI(k)}`, `${rO(k1)}-${tO(k)}`, `${hI}-${tO(k)}`, `${hO}-${tI(k)}`,
        `${rO(k)}-${rI(k1)}`, `${tO(k)}-${tI(k1)}`,
      );
    }
    expect(pairs).toEqual(expected);
    for (let k = 0; k < n; k++) {
      const o = 5 + WHEEL_BEAMS_PER_RAY * k;
      const half = (j: number): number => (j === 7 || j === 11 || j >= 20 ? 0.5 : 1);
      for (const j of [0, 1, 2, 3, 4, 5, 6, 7, 20]) expect([beams[o + j]!.k, beams[o + j]!.d, beams[o + j]!.breakF]).toEqual([def.rimSpring * half(j), def.rimDamp * half(j), WHEEL_DEFAULTS.rimBreakF]);
      for (const j of [8, 9, 10, 11, 21]) expect([beams[o + j]!.k, beams[o + j]!.d]).toEqual([def.tireRingSpring * half(j), def.tireRingDamp * half(j)]);
      for (let j = 12; j < 20; j++) expect([beams[o + j]!.k, beams[o + j]!.d]).toEqual([def.sidewallSpring, def.sidewallDamp]);
    }
    expect([beams[0]!.k, beams[0]!.breakF]).toEqual([def.rimSpring, WHEEL_DEFAULTS.attachBreakF]);
    expect(beams.every((b) => b.type === 'normal')).toBe(true);
  });

  it('compiles, and rejects bad rays / geometry / unknown attach ids', () => {
    const rig = compileRig({ name: 'w', nodes: [...body, ...nodes], beams });
    expect([rig.nodeCount, rig.beamCount]).toEqual([2 + 2 + 4 * n, beams.length]);
    expect(() => buildWheelRig(wheelDef({ rays: 11 }), lookup)).toThrow(/rays/);
    expect(() => buildWheelRig(wheelDef({ rays: 16 }), lookup)).toThrow(/rays/);
    expect(() => buildWheelRig(wheelDef({ rimRadius: 0.3 }), lookup)).toThrow(/rimRadius/);
    expect(() => buildWheelRig(wheelDef({ attach: ['nope'] }), lookup)).toThrow(/nope/);
    expect(() => buildWheelRig(wheelDef({ hubOuter: [0, 0, 0] }), lookup)).toThrow(/coincide/);
    for (const rays of [10, 14]) {
      const r = buildWheelRig(wheelDef({ rays }), lookup);
      expect([r.nodes.length, r.beams.length]).toEqual([2 + 4 * rays, 1 + 22 * rays]);
    }
  });

  it('default tuning passes per-node ω·dt ≤ 0.35 and (Σd/m)·dt ≤ 1 at dt = 1/2000 with declared masses', () => {
    // Tuned for 12 rays (10 has heavier nodes and passes too; 14 needs MINIMASS).
    for (const rays of [10, 12]) {
      const r = buildWheelRig(wheelDef({ rays }), lookup);
      const rep = computeStabilityReport({ name: 'w', nodes: r.nodes, beams: r.beams }, { dt: DT, limit: 0.35 });
      expect(rep.violations, JSON.stringify(rep.worst.slice(0, 3))).toBe(0);
      expect(rep.massDriftPct).toBe(0);
      if (rays === 12) {
        // Numbers quoted in wheelrig.ts.
        const max = (p: string, a: Float64Array) => Math.max(...r.nodes.map((x, i) => (x.id.includes(p) ? a[i]! : 0)));
        expect(max('.tire', rep.omegaDt)).toBeCloseTo(0.345, 3);
        expect(max('.rim', rep.omegaDt)).toBeCloseTo(0.347, 3);
        expect(max('.hub', rep.omegaDt)).toBeCloseTo(0.315, 3);
        expect(max('.tire', rep.dampDt)).toBeCloseTo(0.48, 2);
        expect(max('.rim', rep.dampDt)).toBeCloseTo(0.39, 2);
        expect(max('.hub', rep.dampDt)).toBeCloseTo(0.32, 2);
      }
    }
    // Beam damping below 2·sqrt(k·μ_reduced) for every generated beam (attach beams excluded).
    const c = compileRig({ name: 'w', nodes, beams: beams.slice(4) });
    for (let b = 0; b < c.beamCount; b++) {
      const ma = c.nodeMass[c.beamA[b]!]!;
      const mb = c.nodeMass[c.beamB[b]!]!;
      expect(c.beamD[b]!).toBeLessThan(2 * Math.sqrt(c.beamK[b]! * ((ma * mb) / (ma + mb))));
    }
  });
});

describe('groundNormalForce', () => {
  it('matches the ground kernel normal force node by node', () => {
    const sim = makeSim([wheelDef()], { pos: [0, R - 0.01, 0] });
    const s = sim.s;
    const rng = createRng(7);
    for (let i = 0; i < s.nodeCount; i++) {
      s.velX[i] = rng.range(-1, 1);
      s.velY[i] = rng.range(-1, 1);
      s.velZ[i] = rng.range(-1, 1);
    }
    const expected = new Float64Array(s.nodeCount);
    const nrm = new Float64Array(3);
    for (let i = 0; i < s.nodeCount; i++) expected[i] = groundNormalForce(s, i, sim.sampler!, DT, nrm);
    // Plane normal +Y and friction is tangential, so the kernel's Y force is the normal force.
    applyGroundContacts(s, 0, s.nodeCount, sim.sampler!, DEFAULT_MATERIALS, DT, 1, NULL_SINK);
    let touching = 0;
    for (let i = 0; i < s.nodeCount; i++) {
      expect(s.frcY[i]!).toBeCloseTo(expected[i]!, 9);
      if (expected[i]! > 0) touching++;
    }
    expect(touching).toBeGreaterThan(0);
  });
});

describe('static load', () => {
  it('3.5 kN deflects the default tyre 15–30 mm (hub drop incl. ground penalty depth), monotone', () => {
    let prevD = 0;
    let prevF = 0;
    let defl = Infinity;
    for (let d = 0.004; d <= 0.04; d += 0.004) {
      const f = staticLoadAt(d);
      expect(f).toBeGreaterThan(prevF); // no sidewall collapse below 3.5 kN
      if (f >= 3500) {
        defl = prevD + ((3500 - prevF) / (f - prevF)) * (d - prevD);
        break;
      }
      prevD = d;
      prevF = f;
    }
    // Measured ≈ 25 mm, of which ≈ 7 mm is the ground kernel's penalty depth
    // (KC_MAX on the 2 contact nodes); see wheelrig.ts for why 1–2 cm needs far heavier nodes.
    expect(defl).toBeGreaterThan(0.015);
    expect(defl).toBeLessThan(0.03);
  });
});

describe('torque law', () => {
  it('applies zero net force (hub reaction = −Σ tyre forces) on a deformed, spinning wheel', () => {
    const sim = makeSim([wheelDef()], { sampler: null, gravity: false });
    const s = sim.s;
    const w = sim.wheels[0]!;
    const rng = createRng(3);
    for (let i = 0; i < s.nodeCount; i++) {
      s.posX[i] = s.posX[i]! + rng.range(-0.02, 0.02);
      s.posY[i] = s.posY[i]! + rng.range(-0.02, 0.02);
      s.posZ[i] = s.posZ[i]! + rng.range(-0.02, 0.02);
    }
    addSpin(sim, w, 20);
    estimateWheelOmega(s, w);
    for (const [drive, brake] of [[350, 0], [0, 1500], [-200, 800]] as const) {
      s.frcX.fill(0);
      s.frcY.fill(0);
      s.frcZ.fill(0);
      applyWheelTorques(s, w, drive, brake);
      let fx = 0;
      let fy = 0;
      let fz = 0;
      let tyre = 0;
      for (let i = 0; i < s.nodeCount; i++) {
        fx += s.frcX[i]!;
        fy += s.frcY[i]!;
        fz += s.frcZ[i]!;
      }
      for (let i = w.tireStart; i < w.tireStart + w.ringCount; i++) tyre += Math.hypot(s.frcX[i]!, s.frcY[i]!, s.frcZ[i]!);
      expect(tyre).toBeGreaterThan(100);
      expect(Math.hypot(fx, fy, fz)).toBeLessThan(1e-9 * tyre);
      // Non-trivial reaction on a deformed ring, split equally over the two hubs.
      expect(Math.hypot(s.frcX[w.hubI]!, s.frcY[w.hubI]!, s.frcZ[w.hubI]!)).toBeGreaterThan(1e-3);
      expect([s.frcX[w.hubI], s.frcY[w.hubI], s.frcZ[w.hubI]]).toEqual([s.frcX[w.hubO], s.frcY[w.hubO], s.frcZ[w.hubO]]);
    }
  });

  it('spins up a free wheel at dL/dt = τ and dω/dt = τ/I within 5 %', () => {
    const sim = makeSim([wheelDef()], { sampler: null, gravity: false });
    const w = sim.wheels[0]!;
    const tau = 250;
    const steps = 400;
    const I0 = wheelSpin(sim, w).I;
    for (let t = 0; t < steps; t++) {
      step(sim, () => {
        estimateWheelOmega(sim.s, w);
        applyWheelTorques(sim.s, w, tau, 0);
      });
    }
    const T = steps * DT;
    const { L } = wheelSpin(sim, w);
    estimateWheelOmega(sim.s, w);
    expect(Math.abs(L / (tau * T) - 1)).toBeLessThan(0.05);
    expect(Math.abs(w.omega / ((tau * T) / I0) - 1)).toBeLessThan(0.05);
    expect(w.driveTorque).toBe(tau);
    // Hub midpoint stays put (zero net force → momentum exact).
    const c = hubCentre(sim, w);
    expect(Math.hypot(c[0] + WHEEL_TUNING_205_55R16.width / 2, c[1], c[2])).toBeLessThan(1e-4);
  });

  it('positive drive torque rolls a right-side wheel (spinSign −1) forward too', () => {
    const def = wheelDef({ hubInner: [0, 0, 0], hubOuter: [WHEEL_TUNING_205_55R16.width, 0, 0] });
    const sim = makeSim([def], { sampler: null, gravity: false });
    const w = sim.wheels[0]!;
    expect(w.wheel.spinSign).toBe(-1);
    for (let t = 0; t < 200; t++) {
      step(sim, () => {
        estimateWheelOmega(sim.s, w);
        applyWheelTorques(sim.s, w, 200, 0);
      });
    }
    estimateWheelOmega(sim.s, w);
    expect(w.omega).toBeGreaterThan(0);
    // ω > 0 rolls forward (−Z): the bottom of the wheel moves toward +Z relative to the hub.
    const s = sim.s;
    let bottom = w.tireStart;
    for (let i = w.tireStart; i < w.tireStart + w.ringCount; i++) if (s.posY[i]! < s.posY[bottom]!) bottom = i;
    expect(s.velZ[bottom]! - (s.velZ[w.hubI]! + s.velZ[w.hubO]!) / 2).toBeGreaterThan(0);
  });

  it('cuts drive torque on a detached wheel but keeps the brakes', () => {
    const sim = makeSim([wheelDef()], { sampler: null, gravity: false });
    const w = sim.wheels[0]!;
    w.detached = 1;
    addSpin(sim, w, 5);
    estimateWheelOmega(sim.s, w);
    applyWheelTorques(sim.s, w, 500, 1000);
    expect(w.driveTorque).toBe(0);
    expect(w.brakeTorque).toBeCloseTo(-1000, 6);
  });

  it('brakes a spinning wheel to rest without sign chatter', () => {
    const sim = makeSim([wheelDef()], { sampler: null, gravity: false });
    const w = sim.wheels[0]!;
    const omega0 = 40;
    addSpin(sim, w, omega0);
    estimateWheelOmega(sim.s, w);
    expect(w.omega).toBeCloseTo(omega0, 6);
    const brake = 2000;
    const { I } = wheelSpin(sim, w);
    let minOmega = Infinity;
    let tStop = -1;
    for (let t = 0; t < 1000; t++) {
      step(sim, () => {
        estimateWheelOmega(sim.s, w);
        applyWheelTorques(sim.s, w, 0, brake);
      });
      if (tStop < 0 && w.omega < 1) tStop = t * DT;
      if (tStop >= 0) minOmega = Math.min(minOmega, w.omega);
    }
    estimateWheelOmega(sim.s, w);
    // Constant-torque phase lasts I·(ω0 − 1)/T, then the ramp decays exponentially.
    expect(Math.abs(tStop / ((I * (omega0 - 1)) / brake) - 1)).toBeLessThan(0.1);
    expect(Math.abs(w.omega)).toBeLessThan(1e-3);
    expect(minOmega).toBeGreaterThan(-0.05);
    expect(allFinite(sim.s)).toBe(true);
  });
});

describe('bookkeeping', () => {
  it('reports load ≈ weight, contact and ~zero slip / ω for a parked cart', () => {
    const sim = makeCart();
    const actions = new Float64Array(ACTION_COUNT);
    actions[Action.brake] = 1;
    for (let t = 0; t < 6000; t++) step(sim, () => preStep(sim, actions));
    let mass = 0;
    for (let i = 0; i < sim.s.nodeCount; i++) mass += 1 / sim.s.invMass[i]!;
    let load = 0;
    for (let t = 0; t < 1000; t++) {
      step(sim, () => preStep(sim, actions));
      for (const w of sim.wheels) load += w.load / 1000;
    }
    expect(Math.abs(load / (mass * -G) - 1)).toBeLessThan(0.05);
    for (const w of sim.wheels) {
      expect(w.contact).toBe(1);
      expect(w.slipSpeed).toBeLessThan(0.05);
      expect(Math.abs(w.omega)).toBeLessThan(0.05);
    }
  });

  it('marks a wheel detached once every hub link beam is broken (sticky)', () => {
    const sim = makeSim([wheelDef()], { sampler: null, gravity: false });
    const w = sim.wheels[0]!;
    w.hubLinkBeams = new Int32Array([sim.obj.beamStart, sim.obj.beamStart + 1]);
    sim.s.active[sim.obj.beamStart] = 0;
    estimateWheelOmega(sim.s, w);
    expect(w.detached).toBe(0);
    sim.s.active[sim.obj.beamStart + 1] = 0;
    estimateWheelOmega(sim.s, w);
    expect(w.detached).toBe(1);
    sim.s.active.fill(1);
    estimateWheelOmega(sim.s, w);
    expect(w.detached).toBe(1);
  });
});

describe('parking clamp', () => {
  /**
   * Along-slope creep (m per 2 s, + = downhill): least-squares slope of the
   * cart's Z over 6 s after a 1 s settle. The undamped cart (no suspension)
   * keeps a slow ±2 mm rocking; the fit spans several of its periods.
   */
  function creep(grade: number, actions: Float64Array, clamp: boolean, materials?: MaterialTable): number {
    const sim = makeCart(grade, { materials });
    for (let t = 0; t < 2000; t++) step(sim, () => preStep(sim, actions, 0, clamp));
    const n = 12000;
    let st = 0;
    let sz = 0;
    let stt = 0;
    let stz = 0;
    for (let t = 0; t < n; t++) {
      step(sim, () => preStep(sim, actions, 0, clamp));
      const z = cartCentre(sim)[2];
      const tt = t * DT;
      st += tt;
      sz += z;
      stt += tt * tt;
      stz += tt * z;
    }
    expect(allFinite(sim.s)).toBe(true);
    const slope = (n * stz - st * sz) / (n * stt - st * st);
    return -slope * 2 * Math.sqrt(1 + grade * grade);
  }

  it('holds a braked cart on a 10 % grade: creep ≤ 1 mm over 2 s (service brake and handbrake)', () => {
    const brake = new Float64Array(ACTION_COUNT);
    brake[Action.brake] = 1;
    expect(Math.abs(creep(0.1, brake, true))).toBeLessThan(0.001);
    const hand = new Float64Array(ACTION_COUNT);
    hand[Action.handbrake] = 1;
    expect(Math.abs(creep(0.1, hand, true))).toBeLessThan(0.001);
  });

  it('without the clamp the brake ramp alone creeps on the same grade', () => {
    const brake = new Float64Array(ACTION_COUNT);
    brake[Action.brake] = 1;
    expect(creep(0.1, brake, false)).toBeGreaterThan(0.02);
  });

  it('stays capped at μN: on a low-μ surface the clamped cart still slides', () => {
    const brake = new Float64Array(ACTION_COUNT);
    brake[Action.brake] = 1;
    // μ = 2.0 × 0.03 = 0.06 < 10 % grade: no friction law may hold the cart.
    const icy: MaterialTable = { friction: new Float64Array(DEFAULT_MATERIALS.friction.length).fill(0.03) };
    expect(creep(0.1, brake, true, icy)).toBeGreaterThan(0.05);
  });

  it('is inactive without a pedal and releases above PARK_SPEED', () => {
    const sim = makeCart();
    const s = sim.s;
    const actions = new Float64Array(ACTION_COUNT);
    for (let t = 0; t < 2000; t++) step(sim, () => preStep(sim, actions));
    const snapshot = () => Array.from(s.frcX.subarray(0, s.nodeCount)).concat(Array.from(s.frcZ.subarray(0, s.nodeCount)));
    const run = (speed: number, brake: number) => {
      s.frcX.fill(0);
      s.frcY.fill(0);
      s.frcZ.fill(0);
      const vz = s.velZ.slice();
      for (let i = 0; i < s.nodeCount; i++) s.velZ[i] = vz[i]! - speed;
      actions[Action.brake] = brake;
      for (const w of sim.wheels) estimateWheelOmega(s, w);
      applyParkingClamp(s, sim.veh, actions, DT);
      s.velZ.set(vz);
      return snapshot().some((f) => f !== 0);
    };
    expect(run(0.1, 0)).toBe(false);
    expect(run(0.5, 1)).toBe(false);
    expect(run(0.1, 1)).toBe(true);
  });
});

describe('rolling', () => {
  it('a free 4-wheel cart rolls straight on flat ground', () => {
    const sim = makeCart();
    const actions = new Float64Array(ACTION_COUNT);
    for (let t = 0; t < 3000; t++) step(sim, () => preStep(sim, actions));
    const v0 = 10;
    const s = sim.s;
    for (let i = 0; i < s.nodeCount; i++) s.velZ[i] = s.velZ[i]! - v0;
    for (const w of sim.wheels) addSpin(sim, w, v0 / (R - 0.02));
    // 1 s launch transient (tyres re-deform under rolling), then measure 3 s.
    for (let t = 0; t < 2000; t++) step(sim, () => preStep(sim, actions));
    const c0 = cartCentre(sim);
    const yaw0 = cartYaw(sim);
    for (let t = 0; t < 6000; t++) step(sim, () => preStep(sim, actions));
    const c1 = cartCentre(sim);
    const dist = c0[2] - c1[2];
    expect(dist).toBeGreaterThan(0.5 * v0 * 3);
    // X-braced (achiral) wheels: measured ≈ −0.008 rad over ~13 m (one-way
    // diagonals pulled −0.028 rad and crabbed 1.5°).
    expect(Math.abs(cartYaw(sim) - yaw0)).toBeLessThan(0.02);
    const crab = Math.abs((c1[0] - c0[0]) / dist + Math.tan((cartYaw(sim) + yaw0) / 2));
    expect(crab).toBeLessThan(0.02);
    for (const w of sim.wheels) {
      estimateWheelOmega(s, w);
      expect(w.omega).toBeGreaterThan(0);
      // Free rolling reads ≈ 0 against the effective rolling radius (the
      // unloaded radius read +0.09).
      expect(Math.abs(w.slipRatio)).toBeLessThan(0.08);
      expect(w.rollRadius).toBeLessThan(R);
    }
  });

  it('stays finite over 10k steps of drive / brake / handbrake cycling', () => {
    const sim = makeCart();
    const actions = new Float64Array(ACTION_COUNT);
    for (let t = 0; t < 10000; t++) {
      const phase = Math.floor(t / 1250) % 4;
      actions[Action.brake] = phase === 2 ? 1 : 0;
      actions[Action.handbrake] = phase === 3 ? 1 : 0;
      const drive = phase === 0 ? 600 : phase === 1 ? -400 : 0;
      step(sim, () => preStep(sim, actions, drive));
    }
    expect(allFinite(sim.s)).toBe(true);
    expect(cartCentre(sim)[1]).toBeGreaterThan(0.2);
  });
});
