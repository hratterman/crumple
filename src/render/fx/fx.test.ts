import { DirectionalLight, PerspectiveCamera, Scene, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { createBeamBreakEvent, createImpactEvent, createSkidEvent } from '../../protocol/events';
import { MaterialId } from '../../protocol/messages';
import { VehicleTelemetry } from '../../protocol/telemetry';
import { compileVehicle } from '../../sim/vehicle/builder';
import { SEDAN } from '../../sim/vehicle/defs/sedan';
import type { TerrainData, TerrainSampler, WaterBody } from '../../world/types';
import { QUALITY_PRESETS, type LightingStack, type PatchMaterial, type RenderContext, type SimObjectSlice, type WorldFrame } from '../types';
import { createFxSystem } from './index';
import { SkidLayer } from './skidmarks';
import { SurfaceLift } from './surface';
import { RIBBON_LIFT_M } from '../types';
import { FX_DRAW_BUDGET, FX_SKID_FADE_S } from './types';

const compiled = compileVehicle(SEDAN);
const rest = compiled.rig.nodePos;
let minY = Infinity;
for (let i = 0; i < compiled.rig.nodeCount; i++) minY = Math.min(minY, rest[i * 3 + 1]! - (compiled.rig.nodeRadius[i] ?? 0));
const GROUND = minY;

function flatSampler(material: number = MaterialId.asphalt): TerrainSampler {
  return {
    heightAt: () => GROUND,
    normalAt: (_x, _z, out) => {
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    },
    materialAt: () => material,
    splatAt: () => {},
    contains: () => true,
  };
}
const terrain = { originX: -500, originZ: -500, spacing: 1, cols: 1001, rows: 1001, roads: [] } as unknown as TerrainData;

function setup(material: number = MaterialId.asphalt, water: WaterBody[] = []) {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const ctx = {
    renderer: { getDrawingBufferSize: (v: Vector2) => v.set(1280, 720) },
    scene: new Scene(),
    camera,
    quality: QUALITY_PRESETS.high,
    width: 1280,
    height: 720,
    sampler: null,
  } as unknown as RenderContext;
  const lighting = { sun: new DirectionalLight(0xffffff, 6), sunDirection: new Vector3(0.4, 0.3, -0.8).normalize(), csm: null } as unknown as LightingStack;
  const patchMaterial: PatchMaterial = (m) => ({ color: m, depth: null, distance: null });
  const tel = new Float32Array(32);
  const fx = createFxSystem(ctx, { lighting, patchMaterial, sampler: flatSampler(material), terrain, water, telemetry: (id) => (id === 1 ? tel : null) });
  fx.addVehicle(1, compiled);
  const nodes = new Float32Array(rest.length);
  const objects: SimObjectSlice[] = [{ objectId: 1, flags: 0, nodeOffset: 0, nodeCount: compiled.rig.nodeCount, beamOffset: 0, beamCount: compiled.rig.beamCount }];
  const frame: WorldFrame = { dtS: 1 / 60, time: 0, simTime: 0, timeScale: 1, camera, nodes, interpolated: true, objects, tick: 0 };
  /** Places the rest pose translated by (dx, dy, dz). */
  const pose = (dx: number, dy: number, dz: number): void => {
    for (let i = 0; i < rest.length; i += 3) {
      nodes[i] = rest[i]! + dx;
      nodes[i + 1] = rest[i + 1]! + dy;
      nodes[i + 2] = rest[i + 2]! + dz;
    }
  };
  const step = (t: number): void => {
    frame.simTime = t;
    frame.time = t;
    frame.tick = Math.round(t * 2000);
    fx.update(frame);
  };
  return { fx, tel, frame, pose, step, nodes };
}

describe('createFxSystem', () => {
  it('a sliding rear axle lays skidmarks and smoke; everything stays finite and within budget', () => {
    const { fx, tel, pose, step } = setup();
    tel[VehicleTelemetry.wheelContact] = 15;
    tel[VehicleTelemetry.velZ] = -8;
    for (let c = 0; c < 4; c++) tel[12 + c] = 3500;
    tel[10] = 12; // RL slip
    tel[11] = 12; // RR slip
    tel[28] = 40;
    tel[29] = 40;
    for (let k = 0; k <= 90; k++) {
      pose(0, 0, (-8 * k) / 60);
      step(k / 60);
    }
    expect(fx.stats.skidSegments).toBeGreaterThan(10);
    expect(fx.stats.particles).toBeGreaterThan(50);
    expect(fx.stats.particles).toBeLessThanOrEqual(QUALITY_PRESETS.high.particleBudget);
    expect(fx.stats.drawCalls).toBeLessThanOrEqual(FX_DRAW_BUDGET);
    for (const o of fx.object.children) {
      const g = (o as unknown as { geometry: { attributes: Record<string, { array?: Float32Array; data?: { array: Float32Array } }> } }).geometry;
      let bad = 0;
      for (const a of Object.values(g.attributes)) {
        const arr = a.array ?? a.data?.array;
        if (arr) for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) bad++;
      }
      expect(bad).toBe(0);
    }
    // marks fade out after FX_SKID_FADE_S
    pose(0, 0, -12);
    tel[10] = tel[11] = 0;
    step(1.5 + FX_SKID_FADE_S + 1);
    expect(fx.stats.skidSegments).toBe(0);
  });

  it('dirt: ruts + spray + rooster tail instead of rubber smoke', () => {
    const { fx, tel, pose, step } = setup(MaterialId.dirt);
    tel[VehicleTelemetry.wheelContact] = 15;
    tel[VehicleTelemetry.velZ] = -12;
    for (let c = 0; c < 4; c++) tel[12 + c] = 3500;
    tel[10] = tel[11] = 4;
    for (let k = 0; k <= 60; k++) {
      pose(0, 0, (-12 * k) / 60);
      step(k / 60);
    }
    expect(fx.stats.skidSegments).toBeGreaterThan(5);
    expect(fx.stats.particles).toBeGreaterThan(30);
  });

  it('events: metal impact on concrete sparks; tyre skid events stay on the telemetry path', () => {
    const { fx, pose, step } = setup();
    pose(0, 0, 0);
    step(0);
    step(1 / 60);
    // a tyre-node skid event right under the rear-left hub: no scrape mark, no sparks
    const w = compiled.wheels.find((x) => x.corner === 2)!;
    const hx = (rest[w.hubI * 3]! + rest[w.hubO * 3]!) / 2;
    const hz = (rest[w.hubI * 3 + 2]! + rest[w.hubO * 3 + 2]!) / 2;
    const sk = createSkidEvent();
    Object.assign(sk, { objectId: 1, materialId: MaterialId.asphalt, px: hx, py: GROUND + 0.02, pz: hz, slip: 10, load: 3000 });
    fx.onSkid(sk);
    step(2 / 60);
    expect(fx.stats.particles).toBe(0);
    expect(fx.stats.skidSegments).toBe(0);
    // a body impact against concrete → spark burst
    const im = createImpactEvent();
    Object.assign(im, { objectId: 1, materialId: MaterialId.concrete, px: 0, py: GROUND + 0.5, pz: -2.5, nx: 0, ny: 0, nz: 1, impulse: 30 });
    fx.onImpact(im);
    step(3 / 60);
    expect(fx.stats.particles).toBeGreaterThan(10);
    // beam break → debris chunks
    const br = createBeamBreakEvent();
    Object.assign(br, { objectId: 1, beamIndex: 3, px: 0, py: GROUND + 0.6, pz: -2 });
    for (let i = 0; i < 5; i++) fx.onBeamBreak(br);
    step(4 / 60);
    expect(fx.stats.debris).toBe(5);
    fx.clear();
    expect(fx.stats.debris).toBe(0);
    expect(fx.stats.particles).toBe(0);
  });

  it('water: a fast-sinking object splashes', () => {
    const level = GROUND + 1;
    const body = { id: 'lake', name: 'Lake', level, minX: -50, maxX: 50, minZ: -50, maxZ: 50, maxDepth: 5, samples: 100, optics: {} } as unknown as WaterBody;
    const { fx, pose, step } = setup(MaterialId.asphalt, [body]);
    pose(0, 3, 0);
    step(0);
    pose(0, 2.6, 0);
    step(1 / 60);
    pose(0, 0.2, 0);
    step(2 / 60);
    expect(fx.stats.particles).toBeGreaterThan(5);
  });

  it('setQuality resizes the pools to the preset budgets', () => {
    const { fx } = setup();
    fx.setQuality(QUALITY_PRESETS.low);
    fx.setQuality(QUALITY_PRESETS.ultra);
    expect(fx.stats.particles).toBe(0);
    fx.dispose();
  });
});

describe('SkidLayer', () => {
  it('recycles the oldest segment and fades by age', () => {
    const s = new SkidLayer(4);
    for (let i = 0; i < 6; i++) s.add(0, 0, i, 1, 0, i, 0, 0, i + 1, 1, 0, i + 1, i, i + 1, 1, 1, i, 0.3, 0.3, 0.3, 0);
    expect(s.drawn).toBe(4);
    s.flush(6, new Vector3(0, 1, 0));
    expect(s.mesh.geometry.drawRange.count).toBe(24);
    expect(s.live(6)).toBe(4);
    expect(s.live(2 + FX_SKID_FADE_S + 0.5)).toBe(3);
  });
});

describe('SurfaceLift', () => {
  it('ribbon core = RIBBON_LIFT_M, off-road = 0, eased across the fringe', () => {
    // straight east-west ribbon road at z = 0, x ∈ [−100, 100]
    const n = 101;
    const st = new Float64Array(n * 7);
    for (let i = 0; i < n; i++) {
      st[i * 7] = -100 + i * 2;
      st[i * 7 + 3] = 1;
    }
    const road = { id: 'r', kind: 'country', closed: false, width: 7, lanes: 2, shoulder: 1, material: 0, markings: 'center', surface: 'ribbon', length: 200, stationCount: n, stations: st };
    const lift = new SurfaceLift({ originX: -200, originZ: -200, spacing: 1, cols: 401, rows: 401, roads: [road as never] });
    expect(lift.roadCount).toBe(1);
    expect(lift.liftAt(0, 0)).toBeCloseTo(RIBBON_LIFT_M);
    expect(lift.liftAt(10, 3)).toBeCloseTo(RIBBON_LIFT_M);
    expect(lift.liftAt(0, 30)).toBe(0);
    const edge = lift.liftAt(0, 4.4);
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(edge).toBeLessThanOrEqual(RIBBON_LIFT_M);
  });
});
