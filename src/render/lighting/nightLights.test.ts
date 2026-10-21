import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

import { QUALITY_PRESETS } from '../types';
import type { WorldFrame } from '../types';
import { SEDAN_VISUAL } from '../vehicle/defs/sedan';
import { beamPattern, createHeadlightRig, HEADLIGHT_SHADOWED, lampMountsFor } from './headlights';
import { CELL_SLOTS, cellRange, createLightGrid, GRID_CELL_M, GRID_LIGHT_ROWS, GRID_N, GRID_TEX_W, makeGridLight } from './lightGrid';
import { createNightLights, floodlightHead } from './nightLights';

describe('light grid', () => {
  it('bins a light into every cell its sphere touches and packs its record', () => {
    const g = createLightGrid();
    const l = makeGridLight({ x: 10, y: 6, z: -4, range: 20, r: 3, g: 2, b: 1 });
    g.build([l], 1, 0, 0);
    expect(g.count).toBe(1);
    const d = g.texture.image.data as Float32Array;
    expect([d[0], d[1], d[2], d[3]]).toEqual([10, 6, -4, 20]);
    expect([d[4], d[5], d[6]]).toEqual([3, 2, 1]);
    expect(d[11]).toBe(-2); // point light: no cone
    const [x0, x1, z0, z1] = cellRange(l, g.origin.x, g.origin.y);
    let listed = 0;
    for (let cz = 0; cz < GRID_N; cz++)
      for (let cx = 0; cx < GRID_N; cx++) {
        const v = d[((GRID_LIGHT_ROWS + cz) * GRID_TEX_W + cx * 2) * 4];
        if (v === 1) {
          listed++;
          expect(cx).toBeGreaterThanOrEqual(x0);
          expect(cx).toBeLessThanOrEqual(x1);
          expect(cz).toBeGreaterThanOrEqual(z0);
          expect(cz).toBeLessThanOrEqual(z1);
        }
      }
    expect(listed).toBeGreaterThanOrEqual(4);
    expect(listed).toBeLessThanOrEqual((x1 - x0 + 1) * (z1 - z0 + 1));
  });
  it('keeps the nearest lights when a cell overflows, drops dark and far ones', () => {
    const g = createLightGrid();
    const ls = [];
    for (let i = 0; i < CELL_SLOTS + 4; i++) ls.push(makeGridLight({ x: 1 + i * 0.5, z: 1, range: 2 }));
    ls.push(makeGridLight({ x: 5000, z: 0, range: 10 }));
    ls.push(makeGridLight({ x: 0, z: 0, r: 0, g: 0, b: 0 }));
    g.build(ls, ls.length, 0, 0);
    expect(g.count).toBe(CELL_SLOTS + 4);
    expect(g.stats.overflow).toBeGreaterThan(0);
  });
  it('snaps its origin to whole cells around the camera', () => {
    const g = createLightGrid();
    g.build([], 0, 123.4, -77.7);
    expect(g.origin.x % GRID_CELL_M).toBeCloseTo(0, 9);
    expect(Math.abs(g.origin.x + (GRID_N * GRID_CELL_M) / 2 - 123.4)).toBeLessThanOrEqual(GRID_CELL_M);
  });
});

describe('headlights', () => {
  it('low beam: a cut-off with the kerb-side kick-up, nothing above it; high beam reaches higher', () => {
    expect(beamPattern(-0.3, 0.2, false)).toBeLessThan(0.01);
    expect(beamPattern(0.3, 0.12, false)).toBeGreaterThan(beamPattern(-0.3, 0.12, false));
    expect(beamPattern(0.08, -0.07, false)).toBeGreaterThan(0.6);
    expect(beamPattern(0, 0.15, true)).toBeGreaterThan(0.3);
  });
  it('finds the sedan lamps ahead of and behind the frame origin, mirrored', () => {
    const m = lampMountsFor(SEDAN_VISUAL, [0, 0.4, 0])!;
    expect(m).not.toBeNull();
    expect(m.head[0].x).toBeCloseTo(-m.head[1].x, 6);
    expect(m.head[0].z).toBeLessThan(-1.5); // front (forward −Z)
    expect(m.tail[0].z).toBeGreaterThan(1.5);
    expect(Math.abs(m.head[1].x)).toBeGreaterThan(0.4);
  });
  it('shadowed spot count follows the preset and the spots are off by day', () => {
    for (const q of Object.values(QUALITY_PRESETS)) {
      const rig = createHeadlightRig(q);
      expect(rig.spots.length).toBe(HEADLIGHT_SHADOWED[q.level]);
      rig.setMounts(lampMountsFor(SEDAN_VISUAL, [0, 0.4, 0]));
      const pose = { position: new Vector3(0, 0.5, 0), forward: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) };
      rig.update(pose, { on: true, high: false, brake: 0, reverse: false }, 0);
      for (const s of rig.spots) {
        expect(s.intensity).toBe(0);
        expect(s.shadow.autoUpdate).toBe(false);
      }
      rig.update(pose, { on: true, high: true, brake: 1, reverse: true }, 1);
      for (const s of rig.spots) {
        expect(s.intensity).toBeGreaterThan(0);
        expect(s.shadow.autoUpdate).toBe(true);
        expect(s.target.position.z).toBeLessThan(s.position.z); // aimed forward
      }
      const grid: ReturnType<typeof makeGridLight>[] = [];
      const n = rig.pushGridLights(grid, 0);
      expect(n).toBeGreaterThanOrEqual(q.level === 'low' ? 5 : 3); // (beam ×2) + tail ×2 + reverse
    }
  });
});

describe('night lights', () => {
  const frame = (): WorldFrame => ({
    dtS: 1 / 60,
    time: 0,
    simTime: 0,
    timeScale: 1,
    camera: new PerspectiveCamera(),
    nodes: new Float32Array(0),
    interpolated: false,
    objects: [],
    tick: 0,
  });
  it('streetlights from light-pole props, floodlights from masts; nothing by day', () => {
    const night = createNightLights(QUALITY_PRESETS.high);
    night.setWorld({
      props: [
        { index: 0, objectId: 4096, id: 'p', prop: 'lightPole', transform: { pos: [10, 0, 10], quat: [0, 0, 0, 1] }, aabb: [0, 0, 0, 0, 0, 0], surface: 'metal', material: 6 },
        { index: 1, objectId: 4097, id: 'c', prop: 'cone', transform: { pos: [12, 0, 10], quat: [0, 0, 0, 1] }, aabb: [0, 0, 0, 0, 0, 0], surface: 'plastic', material: 7 },
      ] as never,
      lampRig: { nodes: [0, 1, 2, 3], rest: [[-0.14, 8, -1], [0.14, 8, -1], [0.14, 8, -1.45], [-0.14, 8, -1.45]] },
      colliders: [{ id: 'f', kind: 'cylinder', pos: [40, 9, 0], quat: [0, 0, 0, 1], size: [0.35, 9, 0], material: 6, visual: 'floodlight' }] as never,
    });
    expect(night.streetlights.length).toBe(1);
    expect(night.streetlights[0]!.rest.y).toBeCloseTo(8, 6);
    const off = { on: false, high: false, brake: 0, reverse: false };
    night.update(frame(), { pose: null, state: off }, [], 0, 0);
    expect(night.stats.lights).toBe(0);
    night.update(frame(), { pose: null, state: off }, [], 0, 1);
    expect(night.stats.lights).toBe(2);
    const h = floodlightHead({ pos: [40, 9, 0], quat: [0, 0, 0, 1], size: [0.35, 9, 0] });
    expect(h.pos.y).toBeGreaterThan(18);
    expect(h.dir.y).toBeLessThan(0);
  });
});
