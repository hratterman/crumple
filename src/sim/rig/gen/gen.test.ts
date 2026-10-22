/**
 * R-RIG generator unit tests: the skin sampler on a synthetic crowned panel,
 * the sheet builder, materials, and refineVehicle's invariants on the real
 * sedan (ids / hardpoints / suspension kept, mass + CG exact, stability by
 * construction, deterministic).
 */
import { describe, expect, it } from 'vitest';
import { computeStabilityReport } from '../builder';
import { compileVehicle } from '../../vehicle/builder';
import { SEDAN } from '../../vehicle/defs/sedan';
import { sedanSkinSpec } from '../../vehicle/defs/hd/sedan';
import { SKINS } from '../../vehicle/defs/hd/skins/sedan.high';
import { grade, sheetMass, tubeCrushForce } from './materials';
import { refineVehicle } from './refine';
import { envelopeOf, sampleSkin, type SampleMesh } from './sample';
import { buildSkin } from './skin';

/** A crowned 1.2 × 0.8 m panel at y ≈ 1 (outer face up) plus its inner shell 2 mm below (inward normals). */
function crownedPanel(): SampleMesh {
  const nu = 24;
  const nv = 16;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const shell of [0, 1]) {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const x = -0.6 + (1.2 * i) / nu;
        const z = -0.4 + (0.8 * j) / nv;
        const y = 1 - 0.08 * (x * x + z * z) - shell * 0.002;
        pos.push(x, y, z);
        const n = [0.16 * x, 1, 0.16 * z];
        const l = Math.hypot(n[0]!, n[1]!, n[2]!);
        const s = shell ? -1 : 1;
        nrm.push((s * n[0]!) / l, (s * n[1]!) / l, (s * n[2]!) / l);
        uv.push(x + 0.6, z + 0.4);
      }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 2;
        const d = a + nu + 1;
        // CCW seen from outside: outer face (+y) a, d, c / a, c, b; inner face reversed
        if (shell === 0) idx.push(a, d, c, a, c, b);
        else idx.push(a, c, d, a, b, c);
      }
  }
  return { position: pos, normal: nrm, uv, index: idx };
}

describe('rig gen: skin sampler', () => {
  const mesh = crownedPanel();
  const env = envelopeOf([-1, 0, -2, 1, 1.05, 2]);
  const s = sampleSkin(mesh, { id: 'test', kind: 'hood', material: 'paint', attach: [] }, { pitch: 0.1, envelope: env })!;

  it('samples only the outer sheet at the pitch (grid 13 × 9), with boundary and quads', () => {
    expect(s).not.toBeNull();
    const n = s.pos.length / 3;
    expect(n).toBe(13 * 9);
    for (let i = 0; i < n; i++) expect(s.nrm[3 * i + 1]!).toBeGreaterThan(0.9);
    expect(s.quads.length / 4).toBe(12 * 8);
    expect(s.edge.length).toBe(2 * 13 + 2 * 7);
    expect(s.area).toBeCloseTo(0.96 * 1.0, 1);
  });

  it('triangles are CCW seen from outside', () => {
    for (let t = 0; t < s.tris.length; t += 3) {
      const p = (k: number): number[] => [s.pos[3 * k]!, s.pos[3 * k + 1]!, s.pos[3 * k + 2]!];
      const [a, b, c] = [p(s.tris[t]!), p(s.tris[t + 1]!), p(s.tris[t + 2]!)];
      const ny = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
      expect(ny).toBeGreaterThan(0);
    }
  });

  it('builds membrane, both quad diagonals, grid-line bending beams and seams', () => {
    const frame = new Map<string, number[]>([
      ['f0', [-0.7, 0.9, -0.5]],
      ['f1', [0.7, 0.9, -0.5]],
      ['f2', [0.7, 0.9, 0.5]],
      ['f3', [-0.7, 0.9, 0.5]],
      ['f4', [0, 0.95, -0.5]],
      ['f5', [0, 0.95, 0.5]],
    ]);
    const b = buildSkin(s, { panel: 'test', grade: 'BH220', gauge: 0.0007, seam: 'weld', standoff: 0.3 }, frame);
    const count = (k: string): number => b.beams.filter((x) => x.kind === k).length;
    expect(count('edge')).toBe(12 * 9 + 13 * 8);
    expect(count('diagonal')).toBe(2 * 12 * 8);
    expect(count('bending')).toBe(11 * 9 + 13 * 7);
    expect(count('seam')).toBeGreaterThan(s.edge.length);
    expect(b.mass.reduce((x, y) => x + y, 0)).toBeCloseTo(s.area * sheetMass('BH220', 0.0007), 6);
    // every seam joins a sheet node to a frame node
    for (const x of b.beams.filter((q) => q.kind === 'seam')) expect(frame.has(x.b) || frame.has(x.a)).toBe(true);
  });
});

describe('rig gen: materials', () => {
  it('real grades and an Abramowicz–Jones crush force in the crash-can range', () => {
    expect(grade('BORON').yield).toBeGreaterThan(1e9);
    expect(sheetMass('BH220', 0.0007)).toBeCloseTo(5.5, 1);
    // 70 × 110 mm HSLA can, 1.8 mm: ≈ 50–80 kN mean crush force (real crash cans 50–100 kN)
    const f = tubeCrushForce('HSLA340', 0.0018, 0.07, 0.11);
    expect(f).toBeGreaterThan(40e3);
    expect(f).toBeLessThan(100e3);
  });
});

describe('rig gen: refineVehicle on the sedan', () => {
  const r = refineVehicle(SEDAN, { name: 'sedan.test', skins: SKINS, skinSpec: sedanSkinSpec });
  const base = compileVehicle(SEDAN);
  const cv = compileVehicle(r.def);

  it('keeps every backbone node id, rest position, wheel, frame and the suspension beams', () => {
    SEDAN.body.nodes.forEach((n, i) => {
      expect(r.def.body.nodes[i]!.id).toBe(n.id);
      expect(r.def.body.nodes[i]!.pos).toEqual(n.pos);
    });
    expect(r.def.wheels).toEqual(SEDAN.wheels);
    expect(r.def.frame).toEqual(SEDAN.frame);
    expect(r.def.drivetrain).toEqual(SEDAN.drivetrain);
    SEDAN.body.beams.forEach((b, i) => {
      const nb = r.def.body.beams[i]!;
      expect([nb.a, nb.b, nb.type]).toEqual([b.a, b.b, b.type]);
      if (b.type === 'shock' || b.type === 'hydro') expect(nb).toEqual(b);
      expect(nb.deform).toBe(b.deform);
      expect(nb.breakF).toBe(b.breakF);
    });
  });

  it('total mass and CG equal the standard car (≤ 0.01 kg, ≤ 0.5 mm)', () => {
    expect(Math.abs(cv.totalMass - base.totalMass)).toBeLessThan(0.01);
    for (let k = 0; k < 3; k++) expect(Math.abs(r.report.cg[k]! - r.report.baseCg[k]!)).toBeLessThan(5e-4);
    expect(r.report.massBy.skins).toBeGreaterThan(40);
  });

  it('is stable by construction: no MINIMASS drift, every node ω·dt ≤ 0.5 and (Σd/m)·dt ≤ 1', () => {
    expect(cv.massDriftPct).toBeLessThan(1e-6);
    const st = computeStabilityReport(cv.rig, { limit: 0.5 });
    expect(st.ok).toBe(true);
    expect(r.report.worstOmegaDt).toBeLessThan(0.495 + 1e-9);
  });

  it('is deterministic', () => {
    const again = refineVehicle(SEDAN, { name: 'sedan.test', skins: SKINS, skinSpec: sedanSkinSpec });
    expect(JSON.stringify(again.def)).toBe(JSON.stringify(r.def));
  });
});
