/**
 * R-CORE node-vs-triangle contact law (collision/triangles.ts) on static
 * meshes, single nodes, no engine: drop restitution and slide friction per
 * material pair against the textbook targets (contactMaterials.ts), and
 * speculative CCD against a zero-thickness wall at 250 km/h.
 */
import { describe, expect, it } from 'vitest';
import { integrateNodes } from '../integrator';
import { createSimState } from '../state';
import { MaterialId, NODE_FLAG_COLLIDABLE, NODE_FLAG_OBJ_CONTACT, type EventSink, type SimState } from '../types';
import { CONTACT_MU, CONTACT_RESTITUTION, unilateralRestitution, zetaForRestitution } from './contactMaterials';
import { TriangleContacts, type SolverFlags } from './triangles';

const DT = 1 / 2000;
const G = -9.81;
const N_MAT = 15;

const sink: EventSink = { impact() {}, beamBreak() {}, skid() {} };

/** One node object + a static mesh; returns a stepper (rebuild every 8 ticks like the engine). */
function world(meshes: { positions: number[]; indices: number[]; material: number; twoSided?: boolean }[], nodeMat: number, solver: SolverFlags, gravity = G, pushX = 0, mass = 1) {
  const s: SimState = createSimState(4, 4);
  s.nodeCount = 1;
  s.invMass[0] = 1 / mass;
  s.radius[0] = 0.05;
  s.flags[0] = NODE_FLAG_COLLIDABLE | NODE_FLAG_OBJ_CONTACT;
  const tc = new TriangleContacts(4, 2);
  tc.setStaticMeshes(meshes.map((m) => ({ positions: Float64Array.from(m.positions), indices: Int32Array.from(m.indices), material: m.material, twoSided: !!m.twoSided })));
  const box = new Float64Array(6);
  const vmax = new Float64Array(1);
  const valid = Uint8Array.of(1);
  const stat = Uint8Array.of(0);
  const nodeMatArr = Uint8Array.of(nodeMat);
  let tick = 0;
  const step = (): void => {
    if (tick % 8 === 0) {
      box[0] = box[3] = s.posX[0]!;
      box[1] = box[4] = s.posY[0]!;
      box[2] = box[5] = s.posZ[0]!;
      vmax[0] = Math.hypot(s.velX[0]!, s.velY[0]!, s.velZ[0]!);
      tc.setObject(0, 0, 1, 0, 1, nodeMat, nodeMatArr, null);
      tc.rebuild(s, 1, box, vmax, valid, stat, 8, DT, solver);
    }
    s.frcX[0] = s.frcX[0]! + pushX;
    tc.apply(s, DT, sink, 0, gravity, 0, solver.ccd);
    integrateNodes(s, 0, 1, DT, 0, gravity, 0);
    tick++;
  };
  return { s, tc, step };
}

/** A 20 × 20 m horizontal quad at y = 0 (normal +Y). */
const floor = (material: number) => ({ positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10], indices: [0, 2, 1, 0, 3, 2], material });

describe('contact material pairs', () => {
  it('unilateral restitution inverts', () => {
    for (const e of [0.1, 0.25, 0.4, 0.65, 0.8]) expect(unilateralRestitution(zetaForRestitution(e))).toBeCloseTo(e, 4);
  });
  it('table is symmetric and in textbook ranges', () => {
    for (let a = 0; a < N_MAT; a++) for (let b = 0; b < N_MAT; b++) expect(CONTACT_MU[a * N_MAT + b]).toBe(CONTACT_MU[b * N_MAT + a]);
    const mu = (a: number, b: number): number => CONTACT_MU[a * N_MAT + b]!;
    expect(mu(MaterialId.metal, MaterialId.asphalt)).toBeGreaterThanOrEqual(0.4);
    expect(mu(MaterialId.metal, MaterialId.asphalt)).toBeLessThanOrEqual(0.6);
    expect(mu(MaterialId.metal, MaterialId.metal)).toBeGreaterThanOrEqual(0.4);
    expect(mu(MaterialId.rubber, MaterialId.metal)).toBeGreaterThanOrEqual(0.6);
    expect(mu(MaterialId.plastic, MaterialId.metal)).toBeLessThanOrEqual(0.4);
  });
});

describe('node vs static triangle mesh', () => {
  const on: SolverFlags = { triangleContact: true, selfCollision: true, ccd: true };
  const cases: [string, number, number][] = [
    ['metal on concrete', MaterialId.metal, MaterialId.concrete],
    ['metal on metal', MaterialId.metal, MaterialId.metal],
    ['rubber on asphalt', MaterialId.rubber, MaterialId.asphalt],
    ['plastic on metal', MaterialId.plastic, MaterialId.metal],
    ['wood on concrete', MaterialId.wood, MaterialId.concrete],
  ];
  for (const [name, nodeMat, meshMat] of cases) {
    it(`drop: ${name} rebounds at the pair restitution (mean over entry phases)`, () => {
      const es: number[] = [];
      for (let h = 0; h < 12; h++) {
        const w = world([floor(meshMat)], nodeMat, on);
        w.s.posX[0] = 3;
        w.s.posZ[0] = -4;
        w.s.posY[0] = 0.35 + 0.0011 * h; // impact ≈ 2.4 m/s, entry phase sweeps the tick
        let vIn = 0;
        let vOut = 0;
        let touched = false;
        for (let i = 0; i < 4000; i++) {
          const before = w.s.velY[0]!;
          w.step();
          if (!touched && w.tc.stats.active > 0) {
            touched = true;
            vIn = -before;
          }
          if (touched && w.tc.stats.active === 0 && w.s.velY[0]! > 0) {
            vOut = w.s.velY[0]!;
            break;
          }
        }
        expect(vIn).toBeGreaterThan(2);
        es.push(vOut / vIn);
      }
      const e = es.reduce((a, b) => a + b, 0) / es.length;
      const target = CONTACT_RESTITUTION[nodeMat * N_MAT + meshMat]!;
      console.log(`[drop] ${name}: e ${e.toFixed(3)} (range ${Math.min(...es).toFixed(2)}–${Math.max(...es).toFixed(2)}; target ${target})`);
      expect(Math.abs(e - target)).toBeLessThan(0.05);
    });
  }

  for (const [name, nodeMat, meshMat] of cases) {
    it(`slide: ${name} decelerates at μ·g`, () => {
      const w = world([floor(meshMat)], nodeMat, on);
      w.s.posX[0] = 3;
      w.s.posZ[0] = -4;
      w.s.posY[0] = 0.05;
      for (let i = 0; i < 2000; i++) w.step(); // settle
      w.s.velX[0] = 6;
      const x0 = w.s.posX[0]!;
      let t = 0;
      while (w.s.velX[0]! > 0.01 && t < 20000) {
        w.step();
        t++;
      }
      const dist = w.s.posX[0]! - x0;
      const mu = CONTACT_MU[nodeMat * N_MAT + meshMat]!;
      const muMeasured = (6 * 6) / (2 * 9.81 * dist);
      console.log(`[slide] ${name}: ${dist.toFixed(2)} m, μ ${muMeasured.toFixed(3)} (table ${mu})`);
      expect(Math.abs(muMeasured - mu) / mu).toBeLessThan(0.03);
    });
  }

  it('speculative CCD: a node driven at 250 km/h into a zero-thickness wall stops before its plane; penetration bounded at any speed', () => {
    const wall = { positions: [0, -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2], indices: [0, 1, 2, 0, 2, 3], material: MaterialId.concrete, twoSided: true };
    // A 20 kg node with 60 kN behind it (part of a car body decelerating through it).
    const run = (ccd: boolean, kmh: number): number => {
      const w = world([wall], MaterialId.metal, { triangleContact: true, selfCollision: false, ccd }, 0, 60e3, 20);
      w.s.posX[0] = -1;
      w.s.posY[0] = 0.3;
      w.s.posZ[0] = 0.7;
      w.s.velX[0] = kmh / 3.6;
      let maxX = -Infinity;
      for (let i = 0; i < 400; i++) {
        w.step();
        maxX = Math.max(maxX, w.s.posX[0]!);
      }
      return maxX;
    };
    const rows: string[] = [];
    for (const kmh of [50, 150, 250, 400]) {
      const withCcd = run(true, kmh);
      const without = run(false, kmh);
      rows.push(`${kmh} km/h: with CCD ${(100 * (withCcd + 0.05)).toFixed(2)} cm, without ${(100 * (without + 0.05)).toFixed(2)} cm`);
      // Penetration of the contact sphere (radius 5 cm) is held to half the radius: the centre never reaches the face.
      expect(withCcd).toBeLessThanOrEqual(-0.025 + 1e-9);
    }
    console.log(`[ccd] penetration of a 20 kg node pushed by 60 kN into a zero-thickness wall:\n  ${rows.join('\n  ')}`);
  });
});
