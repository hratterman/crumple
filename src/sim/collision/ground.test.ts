import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import {
  MaterialId,
  NODE_FLAG_COLLIDABLE,
  NODE_FLAG_IN_CONTACT,
  type EventSink,
  type HeightSampler,
  type SimState,
} from '../types';
import { applyGroundContacts, PlaneSampler, tanhR } from './ground';
import { createMaterialTable, DEFAULT_MATERIALS } from './materials';

const DT = 1 / 2000;
const G = -9.81;

// ---------------------------------------------------------------- fixtures
// Inline minimal arena/integrator so these tests don't depend on engine files.
function makeState(nodes: number, beams = 0): SimState {
  const f64 = (n: number) => new Float64Array(n);
  const s: SimState = {
    nodeCapacity: nodes,
    beamCapacity: beams,
    nodeCount: nodes,
    beamCount: beams,
    posX: f64(nodes),
    posY: f64(nodes),
    posZ: f64(nodes),
    velX: f64(nodes),
    velY: f64(nodes),
    velZ: f64(nodes),
    frcX: f64(nodes),
    frcY: f64(nodes),
    frcZ: f64(nodes),
    invMass: f64(nodes).fill(1),
    radius: f64(nodes).fill(0.05),
    friction: f64(nodes).fill(1),
    contactK: f64(nodes),
    treadAxX: f64(nodes),
    treadAxY: f64(nodes),
    treadAxZ: f64(nodes),
    treadF: f64(nodes),
    flags: new Uint8Array(nodes).fill(NODE_FLAG_COLLIDABLE),
    aIdx: new Int32Array(beams),
    bIdx: new Int32Array(beams),
    k: f64(beams),
    d: f64(beams),
    restLen: f64(beams),
    restLen0: f64(beams),
    k0: f64(beams),
    deform: f64(beams).fill(Infinity),
    breakF: f64(beams).fill(Infinity),
    boundsLow: f64(beams),
    boundsHigh: f64(beams),
    preload: f64(beams),
    type: new Uint8Array(beams),
    active: new Uint8Array(beams).fill(1),
    strainOut: new Float32Array(beams),
  };
  return s;
}

/** Plain spring-damper along each beam (test-only stand-in for applyBeamForces). */
function springs(s: SimState): void {
  for (let b = 0; b < s.beamCount; b++) {
    const a = s.aIdx[b]!;
    const c = s.bIdx[b]!;
    const dx = s.posX[c]! - s.posX[a]!;
    const dy = s.posY[c]! - s.posY[a]!;
    const dz = s.posZ[c]! - s.posZ[a]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const rv =
      (s.velX[c]! - s.velX[a]!) * ux + (s.velY[c]! - s.velY[a]!) * uy + (s.velZ[c]! - s.velZ[a]!) * uz;
    const f = s.k[b]! * (len - s.restLen[b]!) + s.d[b]! * rv;
    s.frcX[a] = s.frcX[a]! + f * ux;
    s.frcY[a] = s.frcY[a]! + f * uy;
    s.frcZ[a] = s.frcZ[a]! + f * uz;
    s.frcX[c] = s.frcX[c]! - f * ux;
    s.frcY[c] = s.frcY[c]! - f * uy;
    s.frcZ[c] = s.frcZ[c]! - f * uz;
  }
}

function integrate(s: SimState): void {
  for (let i = 0; i < s.nodeCount; i++) {
    const im = s.invMass[i]!;
    if (im === 0) {
      s.velX[i] = s.velY[i] = s.velZ[i] = 0;
    } else {
      s.velX[i] = s.velX[i]! + s.frcX[i]! * im * DT;
      s.velY[i] = s.velY[i]! + (s.frcY[i]! * im + G) * DT;
      s.velZ[i] = s.velZ[i]! + s.frcZ[i]! * im * DT;
      s.posX[i] = s.posX[i]! + s.velX[i]! * DT;
      s.posY[i] = s.posY[i]! + s.velY[i]! * DT;
      s.posZ[i] = s.posZ[i]! + s.velZ[i]! * DT;
    }
    s.frcX[i] = s.frcY[i] = s.frcZ[i] = 0;
  }
}

interface Recorded extends EventSink {
  impacts: { mat: number; py: number; ny: number; impulse: number }[];
  skids: { node: number; slip: number; load: number; mat: number }[];
}
function recorder(): Recorded {
  const r: Recorded = {
    impacts: [],
    skids: [],
    impact(_o, mat, _px, py, _pz, _nx, ny, _nz, impulse) {
      r.impacts.push({ mat, py, ny, impulse });
    },
    beamBreak() {},
    skid(_o, mat, _px, _py, _pz, slip, load) {
      r.skids.push({ node: -1, slip, load, mat });
    },
  };
  return r;
}

function step(s: SimState, sampler: HeightSampler, ev: EventSink, materials = DEFAULT_MATERIALS): void {
  springs(s);
  applyGroundContacts(s, 0, s.nodeCount, sampler, materials, DT, 7, ev);
  integrate(s);
}

function kinetic(s: SimState): number {
  let e = 0;
  for (let i = 0; i < s.nodeCount; i++) {
    const im = s.invMass[i]!;
    if (im === 0) continue;
    const v2 = s.velX[i]! ** 2 + s.velY[i]! ** 2 + s.velZ[i]! ** 2;
    e += (0.5 * v2) / im;
  }
  return e;
}

/** Tilted plane through the origin: y = sx·x (normal unit, constant). */
class SlopeSampler implements HeightSampler {
  private readonly n: [number, number, number];
  constructor(
    private readonly sx: number,
    private readonly mat: number,
  ) {
    const l = Math.sqrt(sx * sx + 1);
    this.n = [-sx / l, 1 / l, 0];
  }
  heightAt(x: number): number {
    return this.sx * x;
  }
  normalAt(_x: number, _z: number, out: Float64Array): void {
    out[0] = this.n[0];
    out[1] = this.n[1];
    out[2] = this.n[2];
  }
  materialAt(): number {
    return this.mat;
  }
}

// ---------------------------------------------------------------- tests
describe('materials', () => {
  it('default table matches the plan values per frozen MaterialId', () => {
    const f = DEFAULT_MATERIALS.friction;
    expect(f.length).toBe(7);
    expect(f[MaterialId.asphalt]).toBe(1.0);
    expect(f[MaterialId.grass]).toBe(0.6);
    expect(f[MaterialId.dirt]).toBe(0.7);
    expect(f[MaterialId.rock]).toBe(0.9);
    expect(f[MaterialId.gravel]).toBe(0.65);
    expect(f[MaterialId.concrete]).toBe(1.0);
    expect(f[MaterialId.metal]).toBe(0.4);
    expect(createMaterialTable({ grass: 0.1 }).friction[MaterialId.grass]).toBe(0.1);
  });
});

describe('tanhR', () => {
  it('approximates tanh within 2.5%, saturates at 1, is odd and monotone', () => {
    let maxErr = 0;
    let prev = -Infinity;
    for (let x = -6; x <= 6; x += 0.001) {
      const y = tanhR(x);
      maxErr = Math.max(maxErr, Math.abs(y - Math.tanh(x)));
      expect(y).toBeGreaterThanOrEqual(prev - 1e-15);
      prev = y;
      expect(tanhR(-x)).toBe(-y);
    }
    expect(maxErr).toBeLessThan(0.025);
    expect(tanhR(3)).toBe(1);
    expect(tanhR(100)).toBe(1);
  });
});

describe('PlaneSampler', () => {
  it('reports height, up normal and material', () => {
    const p = new PlaneSampler(1.5, MaterialId.dirt);
    const n = new Float64Array(3);
    p.normalAt(3, 4, n);
    expect([p.heightAt(1, 2), ...n, p.materialAt(0, 0)]).toEqual([1.5, 0, 1, 0, MaterialId.dirt]);
  });
});

describe('applyGroundContacts', () => {
  it('a resting stack of nodes settles without jitter', () => {
    const s = makeState(3, 2);
    for (let i = 0; i < 3; i++) {
      s.posY[i] = 0.1 + 0.05 + i * 0.5;
      s.invMass[i] = 1 / 10;
    }
    for (let b = 0; b < 2; b++) {
      s.aIdx[b] = b;
      s.bIdx[b] = b + 1;
      s.k[b] = 1e6;
      s.d[b] = 2000;
      s.restLen[b] = 0.5;
    }
    const ground = new PlaneSampler(0, MaterialId.asphalt);
    const ev = recorder();
    for (let t = 0; t < 2000 * 4; t++) step(s, ground, ev);
    const ref = [s.posY[0]!, s.posY[1]!, s.posY[2]!];
    let maxDev = 0;
    let maxKe = 0;
    for (let t = 0; t < 2000; t++) {
      step(s, ground, ev);
      for (let i = 0; i < 3; i++) maxDev = Math.max(maxDev, Math.abs(s.posY[i]! - ref[i]!));
      maxKe = Math.max(maxKe, kinetic(s));
    }
    expect(maxDev).toBeLessThan(1e-6);
    expect(maxKe).toBeLessThan(1e-9);
    // Bottom node rests slightly penetrated: depth = total weight / kc.
    expect(s.posY[0]!).toBeCloseTo(0.05 - (30 * 9.81) / 2.5e5, 5);
    expect(s.flags[0]! & NODE_FLAG_IN_CONTACT).toBeTruthy();
    expect(s.flags[2]! & NODE_FLAG_IN_CONTACT).toBe(0);
  });

  it.each([
    [1.0, MaterialId.asphalt],
    [2.0, MaterialId.grass],
    [0.5, MaterialId.metal],
  ])('a sliding puck (node μ %d, material %d) decelerates at μg within 10%%', (nodeMu, mat) => {
    const s = makeState(1);
    s.posY[0] = 0.05;
    s.friction[0] = nodeMu;
    const ground = new PlaneSampler(0, mat);
    const ev = recorder();
    for (let t = 0; t < 1000; t++) step(s, ground, ev);
    s.velX[0] = 10;
    let t0 = -1;
    let t1 = -1;
    for (let t = 0; t < 20000 && t1 < 0; t++) {
      step(s, ground, ev);
      const v = s.velX[0]!;
      if (t0 < 0 && v <= 9) t0 = t;
      if (t1 < 0 && v <= 3) t1 = t;
    }
    expect(t1).toBeGreaterThan(t0);
    const decel = 6 / ((t1 - t0) * DT);
    const mu = nodeMu * DEFAULT_MATERIALS.friction[mat]!;
    expect(Math.abs(decel / (mu * 9.81) - 1)).toBeLessThan(0.1);
  });

  it.each([0.2, 1, 5, 50])('a %d kg node dropped at 30 m/s does not tunnel', (mass) => {
    const s = makeState(1);
    s.invMass[0] = 1 / mass;
    s.posY[0] = 0.5;
    s.velY[0] = -30;
    const ground = new PlaneSampler(0, MaterialId.rock);
    const ev = recorder();
    let minY = Infinity;
    for (let t = 0; t < 2000 * 5; t++) {
      step(s, ground, ev);
      minY = Math.min(minY, s.posY[0]!);
    }
    // Penalty contact may penetrate (≈ v·sqrt(m/kc) less damping) but must
    // stop the node and push it back out to its resting depth.
    expect(minY).toBeGreaterThan(-0.5);
    expect(Math.abs(s.velY[0]!)).toBeLessThan(1e-3);
    const kc = Math.min(2.5e5, (0.2 * mass) / (DT * DT));
    expect(s.posY[0]!).toBeCloseTo(0.05 - (mass * 9.81) / kc, 4);
    expect(ev.impacts.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(ev.impacts[0]!.impulse / (mass * 30) - 1)).toBeLessThan(0.01);
  });

  it('a touchdown emits exactly one impact per contact episode', () => {
    const s = makeState(1);
    s.invMass[0] = 1 / 2;
    s.posY[0] = 1;
    const ground = new PlaneSampler(0, MaterialId.concrete);
    const ev = recorder();
    // Fall until the first lift-off (or the end): one sustained contact → one event.
    let touched = false;
    for (let t = 0; t < 2000 * 3; t++) {
      step(s, ground, ev);
      const inContact = (s.flags[0]! & NODE_FLAG_IN_CONTACT) !== 0;
      if (inContact) touched = true;
      else if (touched) break;
    }
    expect(touched).toBe(true);
    expect(ev.impacts.length).toBe(1);
    const hit = ev.impacts[0]!;
    expect(hit.mat).toBe(MaterialId.concrete);
    expect(hit.ny).toBe(1);
    expect(hit.py).toBeCloseTo(0, 2);
    // v = sqrt(2 g h) with h = 0.95 m → impulse ≈ m·v.
    expect(hit.impulse).toBeCloseTo(2 * Math.sqrt(2 * 9.81 * 0.95), 1);
    expect(ev.skids.length).toBe(0);
  });

  it('a gentle landing emits exactly one impact in total (sub-threshold bounces are silent)', () => {
    const s = makeState(1);
    s.invMass[0] = 1 / 0.5;
    s.posY[0] = 0.55; // 0.5 m fall → 3.1 m/s, 1.6 N·s; rebound ≈ 0.4 N·s < threshold
    const ground = new PlaneSampler(0, MaterialId.asphalt);
    const ev = recorder();
    for (let t = 0; t < 2000 * 3; t++) step(s, ground, ev);
    expect(ev.impacts.length).toBe(1);
    expect(s.flags[0]! & NODE_FLAG_IN_CONTACT).toBeTruthy();
  });

  it('a resting node never re-emits impacts', () => {
    const s = makeState(1);
    s.posY[0] = 0.05 - 9.81 / 2.5e5;
    const ev = recorder();
    for (let t = 0; t < 4000; t++) step(s, new PlaneSampler(0, 0), ev);
    expect(ev.impacts.length).toBe(0);
  });

  it('skids appear during a slide, rate-limited per node', () => {
    const s = makeState(2);
    s.posY[0] = s.posY[1] = 0.05;
    s.posX[1] = 5;
    s.friction[0] = s.friction[1] = 0.3;
    const ground = new PlaneSampler(0, MaterialId.gravel);
    const ev = recorder();
    for (let t = 0; t < 1000; t++) step(s, ground, ev);
    expect(ev.skids.length).toBe(0);
    s.velX[0] = 8;
    s.velZ[1] = -8;
    const ticks = 400;
    for (let t = 0; t < ticks; t++) step(s, ground, ev);
    // 2 nodes, at most one skid per node per 20 ticks.
    expect(ev.skids.length).toBeGreaterThanOrEqual(2 * (ticks / 20 - 1));
    expect(ev.skids.length).toBeLessThanOrEqual(2 * (ticks / 20 + 1));
    for (const k of ev.skids) {
      expect(k.slip).toBeGreaterThan(0.5);
      expect(k.load).toBeGreaterThan(1);
      expect(k.mat).toBe(MaterialId.gravel);
    }
  });

  it('pinned and non-collidable nodes are skipped', () => {
    const s = makeState(2);
    s.posY[0] = s.posY[1] = -1;
    s.invMass[0] = 0;
    s.flags[1] = 0;
    const ev = recorder();
    applyGroundContacts(s, 0, 2, new PlaneSampler(0, 0), DEFAULT_MATERIALS, DT, 1, ev);
    expect([s.frcY[0], s.frcY[1], s.flags[0]! & NODE_FLAG_IN_CONTACT, s.flags[1]]).toEqual([0, 0, 0, 0]);
    expect(ev.impacts.length).toBe(0);
  });

  it('slides down a slope along the projected normal', () => {
    const s = makeState(1);
    const ground = new SlopeSampler(0.5, MaterialId.metal); // ~26.6°, tan > μ = 0.4·0.5
    s.friction[0] = 0.5;
    s.posY[0] = 0.06 * Math.sqrt(1.25);
    const ev = recorder();
    for (let t = 0; t < 2000; t++) step(s, ground, ev);
    expect(s.velX[0]!).toBeLessThan(-1);
    // Stays on the surface: centre ≈ radius above the plane along the normal.
    const dist = (s.posY[0]! - 0.5 * s.posX[0]!) / Math.sqrt(1.25);
    expect(dist).toBeGreaterThan(0.04);
    expect(dist).toBeLessThan(0.06);
  });

  it('10k random steps stay finite', () => {
    const rng = createRng(1234);
    const n = 64;
    const s = makeState(n);
    for (let i = 0; i < n; i++) {
      s.posX[i] = rng.range(-20, 20);
      s.posY[i] = rng.range(-0.5, 3);
      s.posZ[i] = rng.range(-20, 20);
      s.velX[i] = rng.range(-40, 40);
      s.velY[i] = rng.range(-40, 40);
      s.velZ[i] = rng.range(-40, 40);
      s.invMass[i] = rng.float() < 0.1 ? 0 : 1 / rng.range(0.01, 500);
      s.radius[i] = rng.range(0, 0.5);
      s.friction[i] = rng.range(0, 3);
      s.flags[i] = rng.float() < 0.9 ? NODE_FLAG_COLLIDABLE : 0;
    }
    const samplers: HeightSampler[] = [
      new PlaneSampler(0, MaterialId.asphalt),
      new SlopeSampler(0.3, MaterialId.dirt),
      new SlopeSampler(-1.2, MaterialId.gravel),
    ];
    const ev = recorder();
    for (let t = 0; t < 10000; t++) {
      const sampler = samplers[(t / 1000) % 3 | 0]!;
      if (t % 500 === 0) {
        const i = rng.int(0, n - 1);
        s.velY[i] = rng.range(-60, 60);
        s.velX[i] = rng.range(-60, 60);
      }
      step(s, sampler, ev);
    }
    for (let i = 0; i < n; i++) {
      for (const a of [s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ]) {
        expect(Number.isFinite(a[i]!)).toBe(true);
      }
    }
    for (const k of ev.skids) expect(Number.isFinite(k.slip + k.load)).toBe(true);
    for (const k of ev.impacts) expect(Number.isFinite(k.impulse)).toBe(true);
  });

  it('is deterministic', () => {
    const run = () => {
      const s = makeState(4);
      for (let i = 0; i < 4; i++) {
        s.posY[i] = 0.3 + i * 0.1;
        s.velX[i] = 3 * i;
        s.velY[i] = -5;
      }
      const ev = recorder();
      for (let t = 0; t < 3000; t++) step(s, new SlopeSampler(0.2, 0), ev);
      return [...s.posX, ...s.posY, ev.impacts.length, ev.skids.length];
    };
    expect(run()).toEqual(run());
  });
});
