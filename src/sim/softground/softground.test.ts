/**
 * Soft ground (R-PHYS2): the sparse rut grid (allocation, LRU recycling,
 * bilinear depth + C0 gradient), Bekker sinkage per soil, multi-pass
 * deepening, the rutted contact surface; a car on a dirt road (ruts of a
 * few mm deepening with passes) and coasting on mud / sand (compaction
 * rolling resistance, deep ruts).
 */
import { describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { PlaneSampler } from '../collision/ground';
import { SimEngine } from '../engine';
import { SEDAN } from '../vehicle/defs/sedan';
import { setMotion } from '../vehicle/handling';
import { SOFT_CELL_M, SOFT_MAX_TILES, SOFT_TILE, SoftGround, SoftGroundSampler } from './softground';

describe('soft ground grid', () => {
  it('starts empty: the wrapped sampler is the base sampler exactly', () => {
    const sg = new SoftGround();
    const base = new PlaneSampler(1.5, MaterialId.mud);
    const w = new SoftGroundSampler(base, sg);
    const n = new Float64Array(3);
    expect(w.heightAt(3.3, -7.1)).toBe(1.5);
    w.normalAt(3.3, -7.1, n);
    expect([...n]).toEqual([0, 1, 0]);
    expect(w.materialAt(0, 0)).toBe(MaterialId.mud);
  });

  it('a pressed point deepens toward the soil sinkage, rate-limited, and never rises', () => {
    const sg = new SoftGround();
    let d = 0;
    for (let t = 0; t < 200; t++) d += sg.press(1.0, 2.0, MaterialId.sand, 900, 0, t, 1 / 2000);
    const z = sg.depthAt(1.0, 2.0);
    // Bekker (dry sand, n 1.1, k_c 0.99, k_φ 1528) at 900 N / 0.015 m² = 60 kPa: (60 / 1533)^(1/1.1) · 0.95 ≈ 4.8 cm.
    expect(z).toBeGreaterThan(0.035);
    expect(z).toBeLessThan(0.06);
    expect(d).toBeGreaterThan(0);
    // Rate limit: 1.5 m/s → ≤ 0.75 mm per tick.
    const sg2 = new SoftGround();
    sg2.press(1.0, 2.0, MaterialId.sand, 900, 0, 0, 1 / 2000);
    expect(sg2.depthAt(1.0, 2.0)).toBeLessThanOrEqual(0.00076);
    // Unloaded: stays.
    sg.press(1.0, 2.0, MaterialId.sand, 10, 0, 300, 1 / 2000);
    expect(sg.depthAt(1.0, 2.0)).toBe(z);
    // Asphalt keeps no rut.
    sg.press(5, 5, MaterialId.asphalt, 900, 0, 0, 1 / 2000);
    expect(sg.depthAt(5, 5)).toBe(0);
  });

  it('multi-pass: each new pass (after the pass gap) deepens the rut as N^α', () => {
    const sg = new SoftGround();
    const depths: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      for (let t = 0; t < 200; t++) sg.press(0.4, 0.4, MaterialId.mud, 900, 0, pass * 2000 + t, 1 / 2000);
      depths.push(sg.depthAt(0.4, 0.4));
    }
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeGreaterThan(depths[i - 1]!);
    // α = 0.3: 4 passes ≈ 1.5× the first.
    expect(depths[3]! / depths[0]!).toBeGreaterThan(1.3);
    expect(depths[3]! / depths[0]!).toBeLessThan(1.7);
    expect(sg.compaction(0.4, 0.4)).toBe(4);
  });

  it('slip digs deeper (a spinning wheel sinks itself)', () => {
    const a = new SoftGround();
    const b = new SoftGround();
    for (let t = 0; t < 400; t++) {
      a.press(0, 0, MaterialId.mud, 900, 0, t, 1 / 2000);
      b.press(0, 0, MaterialId.mud, 900, 8, t, 1 / 2000);
    }
    expect(b.depthAt(0, 0)).toBeGreaterThan(2 * a.depthAt(0, 0));
  });

  it('gradient points into the rut wall; the tilted normal pushes a node back toward the rut centre', () => {
    const sg = new SoftGround();
    // A rut along z at x = 0.
    for (let z = -2; z <= 2; z += 0.1) for (let t = 0; t < 200; t++) sg.press(0, z, MaterialId.mud, 900, 0, t, 1 / 2000);
    const g = new Float64Array(2);
    sg.gradAt(0.15, 0, g);
    // Depth falls off to the right of the centre: ∂d/∂x < 0 on the right wall.
    expect(g[0]!).toBeLessThan(0);
    const w = new SoftGroundSampler(new PlaneSampler(0, MaterialId.mud), sg);
    const n = new Float64Array(3);
    w.normalAt(0.15, 0, n);
    expect(n[0]!).toBeLessThan(0); // the wall faces back toward x = 0
    expect(w.heightAt(0, 0)).toBeLessThan(-0.03);
    expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 12);
  });

  it('tiles are allocated on touch and the least recently touched one is recycled at the cap', () => {
    const sg = new SoftGround();
    const span = SOFT_TILE * SOFT_CELL_M;
    for (let k = 0; k < SOFT_MAX_TILES + 3; k++) sg.press(k * span + 0.5, 0.5, MaterialId.dirt, 900, 0, k, 1 / 2000);
    expect(sg.tileCount).toBe(SOFT_MAX_TILES);
    // The first tiles (oldest) were recycled: their ruts are gone, the newest exist.
    expect(sg.depthAt(0.5, 0.5)).toBe(0);
    expect(sg.depthAt((SOFT_MAX_TILES + 2) * span + 0.5, 0.5)).toBeGreaterThan(0);
    expect(sg.depthAt(10 * span + 0.5, 0.5)).toBeGreaterThan(0);
  });
});

describe('ruts under a car', () => {
  function drive(eng: SimEngine, s: number): void {
    eng.reset(1, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] });
    for (let t = 0; t < 1000; t++) eng.step();
    eng.setInput(1, { gearSelect: 1, throttle: 0.5, brake: 0, handbrake: 0, steer: 0 });
    for (let t = 0; t < s * 2000; t++) eng.step();
  }

  it('dirt road: a few mm per pass, deepening pass by pass', () => {
    const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 16384 } });
    eng.setGroundPlane(0, MaterialId.dirt);
    eng.enableSoftGround();
    eng.spawnVehicle(1, SEDAN, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] });
    const sg = eng.softGround;
    const rut: number[] = [];
    for (let p = 0; p < 3; p++) {
      drive(eng, 3);
      // Deepest point across the rear-left track 4 m out.
      let m = 0;
      for (let x = -1.1; x < 0; x += 0.02) m = Math.max(m, sg.depthAt(x, -4));
      rut.push(m);
    }
    console.log(`[soft] dirt passes: rut ${rut.map((r) => (r * 100).toFixed(2)).join(' / ')} cm`);
    // Compacted dirt road (k_φ 6000): ≈ 2–6 mm per car pass.
    expect(rut[0]!).toBeGreaterThan(0.002);
    expect(rut[0]!).toBeLessThan(0.02);
    expect(rut[2]!).toBeGreaterThan(rut[0]!);
  }, 180_000);

  it('mud and sand: rolling resistance from compaction (coast-down 10 → 5 m/s) and 3–8 cm ruts', () => {
    const coast = (mat: number, soft: boolean): { t: number; rut: number } => {
      const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false, capacity: { maxObjects: 2, nodeCapacity: 4096, beamCapacity: 16384 } });
      eng.setGroundPlane(0, mat);
      if (soft) eng.enableSoftGround();
      eng.spawnVehicle(1, SEDAN, { pos: [0, 0.02, 0], quat: [0, 0, 0, 1] });
      for (let t = 0; t < 1000; t++) eng.step();
      const veh = eng.getVehicle(1)!;
      eng.setInput(1, { brake: 0, handbrake: 0, gearSelect: 0, throttle: 0 });
      setMotion({ eng, obj: eng.arena.get(1)!, veh, cv: veh.vehicle, objectId: 1 }, 10, 0);
      const o = veh.nodeStart + veh.vehicle.frameNodes[0]!;
      let t5 = Infinity;
      for (let t = 0; t < 10 * 2000; t++) {
        eng.step();
        if (t > 400 && -eng.state.velZ[o]! < 5) {
          t5 = t / 2000;
          break;
        }
      }
      const hub = veh.wheels[2]!.hubI;
      return { t: t5, rut: eng.softGround.depthAt(eng.state.posX[hub]!, eng.state.posZ[hub]! + 3) };
    };
    for (const [name, mat] of [
      ['mud', MaterialId.mud],
      ['sand', MaterialId.sand],
    ] as const) {
      const soft = coast(mat, true);
      const rigid = coast(mat, false);
      const g = 5 / soft.t / 9.81;
      console.log(`[soft] ${name} coast-down 10 → 5 m/s: ${soft.t.toFixed(2)} s (≈ ${g.toFixed(3)} g), rigid ground > 10 s; rut ${(soft.rut * 100).toFixed(1)} cm`);
      // Wong: passenger-car tyres on soft soil roll at C_rr ≈ 0.05–0.3 (vs 0.01–0.02 on a firm road).
      expect(g).toBeGreaterThan(0.05);
      expect(g).toBeLessThan(0.3);
      expect(rigid.t).toBe(Infinity);
      expect(soft.rut).toBeGreaterThan(0.03);
      expect(soft.rut).toBeLessThan(0.08);
    }
  }, 240_000);
});
