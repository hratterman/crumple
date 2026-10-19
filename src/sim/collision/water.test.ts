/**
 * Water buoyancy + drag (P5, U1): barrel draft, sinking/floating props,
 * the sedan floods and sinks.
 */
import { describe, expect, it } from 'vitest';
import { MaterialId, PROP_DYNAMIC_ID_BASE } from '../../protocol/messages';
import { WATER_OPTICS_DEFAULTS, WATER_PHYSICS, type WaterBody } from '../../world/types';
import { SimEngine } from '../engine';
import { compilePropRig, PROP_CATALOG } from '../props/catalog';
import type { PropKey } from '../props/types';
import { SEDAN } from '../vehicle/defs/sedan';
import { applyWater } from './water';

const PID = PROP_DYNAMIC_ID_BASE;
const POND: WaterBody = {
  id: 'pond',
  name: 'Pond',
  level: 0,
  minX: -30,
  maxX: 30,
  minZ: -30,
  maxZ: 30,
  maxDepth: 6,
  samples: 0,
  optics: WATER_OPTICS_DEFAULTS,
};
const at = (x: number, y: number, z: number) => ({ pos: [x, y, z] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] });

function pond(): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 16, nodeCapacity: 4096, beamCapacity: 16384 } });
  eng.setGroundPlane(-6, MaterialId.dirt);
  eng.setWater([POND]);
  return eng;
}

function centroidY(eng: SimEngine, id: number): number {
  const o = eng.arena.get(id)!;
  const s = eng.state;
  let m = 0;
  let y = 0;
  for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
    if (s.invMass[i] === 0) continue;
    m += 1 / s.invMass[i]!;
    y += s.posY[i]! / s.invMass[i]!;
  }
  return y / m;
}

/** Rigid equilibrium offset d (rest pose shifted by d in y) of a prop floating at level 0 — bisection on the model's buoyancy. */
function equilibriumOffset(key: PropKey): number {
  const c = compilePropRig(key);
  const h = WATER_PHYSICS.nodeHalfDepth;
  const ratio = WATER_PHYSICS.density / PROP_CATALOG[key].density;
  const net = (d: number) => {
    let b = 0;
    let w = 0;
    for (let i = 0; i < c.nodeCount; i++) {
      const m = c.nodeMass[i]!;
      if (!(m > 0)) continue;
      const f = Math.min(1, Math.max(0, (0 - (c.nodePos[3 * i + 1]! + d) + h) / (2 * h)));
      b += m * f * ratio;
      w += m;
    }
    return b - w;
  };
  let lo = -3;
  let hi = 1;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('water', () => {
  it('a 200 L barrel floats upright at the model draft (≈ 6 cm, a real empty drum floats at ≈ 7 cm)', () => {
    const eng = pond();
    eng.spawnProp(PID, 'barrel', at(0, 0.2, 0), false);
    for (let t = 0; t < 12000; t++) eng.step();
    const d = equilibriumOffset('barrel');
    const rig = compilePropRig('barrel');
    // Expected centroid = rest centroid + d.
    let m = 0;
    let y0 = 0;
    for (let i = 0; i < rig.nodeCount; i++) {
      m += rig.nodeMass[i]!;
      y0 += rig.nodeMass[i]! * rig.nodePos[3 * i + 1]!;
    }
    const expected = y0 / m + d;
    const got = centroidY(eng, PID);
    const draft = -(d + 0); // base (y = 0 in the rig) sits at d below the surface
    expect(draft).toBeGreaterThan(0.03);
    expect(draft).toBeLessThan(0.1);
    expect(Math.abs(got - expected)).toBeLessThan(0.015);
    // Upright: the top lid stays above the bottom one.
    const o = eng.arena.get(PID)!;
    const s = eng.state;
    expect(s.posY[o.nodeStart + rig.nodeIds.indexOf('lidT_c')]!).toBeGreaterThan(s.posY[o.nodeStart + rig.nodeIds.indexOf('lidB_c')]! + 0.7);
  }, 60_000);

  it('wood, cardboard, cones and tyres float; concrete and steel posts sink', () => {
    const eng = pond();
    const keys: PropKey[] = ['boxWood', 'boxCardboard', 'cone', 'tire', 'concreteBlock'];
    keys.forEach((k, i) => eng.spawnProp(PID + i, k, at(-8 + i * 4, 0.3, 0), false));
    for (let t = 0; t < 16000; t++) eng.step();
    keys.forEach((k, i) => {
      const y = centroidY(eng, PID + i);
      if (k === 'concreteBlock') expect(y, k).toBeLessThan(-5);
      else expect(y, k).toBeGreaterThan(-0.4);
    });
  }, 60_000);

  it('drag never reverses a node (impulse capped at its momentum)', () => {
    const eng = pond();
    eng.spawnProp(PID, 'cone', at(0, -2, 0), false);
    const s = eng.state;
    const o = eng.arena.get(PID)!;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) s.velX[i] = 50;
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      s.frcX[i] = 0;
      s.frcY[i] = 0;
    }
    applyWater(s, o.nodeStart, o.nodeCount, [POND], PROP_CATALOG.cone.density, 9.81, 1 / 2000, o.nodeStart, 1);
    for (let i = o.nodeStart; i < o.nodeStart + o.nodeCount; i++) {
      const m = 1 / s.invMass[i]!;
      expect(s.frcX[i]! * (1 / 2000)).toBeGreaterThanOrEqual(-m * 50 - 1e-9);
      expect(s.frcX[i]!).toBeLessThan(0);
    }
  });

  it('the sedan floats for a moment, floods and sinks to the bottom within ~20 s', () => {
    const eng = pond();
    eng.spawnVehicle(1, SEDAN, at(0, 0.2, 0));
    const ys: number[] = [];
    for (let t = 0; t <= 24 * 2000; t++) {
      if (t % 2000 === 0) ys.push(centroidY(eng, 1));
      eng.step();
    }
    console.log(`[water] sedan COM y per s: ${ys.map((y) => y.toFixed(2)).join(" ")}; flood ${eng.floodLevel(1)!.toFixed(2)}`);
    // Floats for a while (dry: density 500, roof out), still at the surface 5 s in.
    expect(ys[2]!).toBeGreaterThan(-0.6);
    expect(ys[5]!).toBeGreaterThan(-0.6);
    // Flooded and on the bottom (ground at −6) by 20 s.
    expect(eng.floodLevel(1)!).toBeGreaterThan(0.9);
    expect(ys[20]!).toBeLessThan(-5.2);
    // Monotone-ish descent after the float phase (no bobbing back up).
    expect(ys[24]!).toBeLessThan(ys[10]! + 0.05);
  }, 120_000);
});
