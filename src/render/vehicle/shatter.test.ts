/**
 * A4 shatter FX: bounded shard pools (recycling, expiry, ground bounce /
 * settle), the DamageFx sink, and the crack GLSL contract.
 */
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { createRng } from '../../core/rng';
import { createDamageFx, createShardGeometry, DEBRIS_PERSIST_S, GLASS_CRACK_GLSL, ShardPool } from './shatter';
import { MeshStandardMaterial } from 'three';
import type { BindingSet, VehicleVisualDef } from './types';

const pool = (capacity: number, groundAt: ((x: number, z: number) => number) | null = null): ShardPool =>
  new ShardPool({ capacity, geometry: createShardGeometry(), material: new MeshStandardMaterial(), groundAt });

describe('ShardPool', () => {
  it('stays bounded: spawning past capacity recycles the oldest pieces', () => {
    const p = pool(64);
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) p.spawn(0, 1, 0, 1, 2, 0, 0.02, 5, rng);
    expect(p.live).toBe(64);
    expect(p.mesh.count).toBeLessThanOrEqual(64);
    p.update(1 / 60);
    expect(p.live).toBe(64);
    expect(p.mesh.count).toBeLessThanOrEqual(64);
  });

  it('pieces fall, bounce on the ground, settle flat and expire', () => {
    const p = pool(8, () => 2);
    const rng = createRng(2);
    p.spawn(0, 5, 0, 3, 0, 0, 0.02, 4, rng);
    const m = new Matrix4();
    const pos = new Vector3();
    let minY = Infinity;
    for (let t = 0; t < 3; t += 1 / 60) {
      p.update(1 / 60);
      p.mesh.getMatrixAt(0, m);
      pos.setFromMatrixPosition(m);
      minY = Math.min(minY, pos.y);
    }
    expect(minY).toBeGreaterThanOrEqual(2);
    expect(pos.y).toBeLessThan(2.01); // resting on the ground
    expect(pos.x).toBeGreaterThan(0.3); // carried its velocity
    for (let t = 0; t < 2; t += 1 / 60) p.update(1 / 60);
    expect(p.live).toBe(0);
    expect(p.mesh.count).toBe(0);
  });

  it('clear() empties the pool', () => {
    const p = pool(16);
    const rng = createRng(3);
    for (let i = 0; i < 10; i++) p.spawn(0, 1, 0, 0, 0, 0, 0.02, 5, rng);
    p.clear();
    expect(p.live).toBe(0);
  });
});

describe('createDamageFx', () => {
  const binding = {
    panels: [{ restRadius: 0.5 }, { restRadius: 0.6 }],
  } as unknown as BindingSet;
  const def = { paint: { color: 0xaa2222 } } as unknown as VehicleVisualDef;

  it('turns DamageFx into bounded shard / debris bursts and owns damage.onFx', () => {
    const damage = { onFx: null } as unknown as Parameters<typeof createDamageFx>[0]['damage'];
    const fx = createDamageFx({ binding, def, damage, glassCapacity: 300, debrisCapacity: 50 });
    expect(damage!.onFx).toBe(fx.sink);
    fx.sink({ type: 'glassShatter', panelIndex: 0, pos: [0, 1, 0], normal: [0, 0, 1], laminated: false });
    expect(fx.glass.live).toBeGreaterThanOrEqual(80);
    for (let i = 0; i < 10; i++) {
      fx.sink({ type: 'glassShatter', panelIndex: 1, pos: [0, 1, 0], normal: [1, 0, 0], laminated: false });
    }
    expect(fx.glass.live).toBe(300);
    fx.sink({ type: 'panelDetach', panelIndex: 1, mode: 'hide', pos: [0, 1, 0] });
    for (let i = 0; i < 100; i++) fx.sink({ type: 'beamBreak', beamIndex: i, pos: [0, 1, 0] });
    expect(fx.debris.live).toBe(50);
    fx.update(1 / 60);
    fx.clear();
    expect(fx.glass.live + fx.debris.live).toBe(0);
    fx.dispose();
    expect(damage!.onFx).toBeNull();
  });

  it('R-CRASH: glass crumbs and debris stay where they landed (persistent debris), resting pieces cost no matrix writes', () => {
    const damage = { onFx: null } as unknown as Parameters<typeof createDamageFx>[0]['damage'];
    const fx = createDamageFx({ binding, def, damage, glassCapacity: 300, debrisCapacity: 50 });
    fx.sink({ type: 'glassShatter', panelIndex: 0, pos: [0, 1, 0], normal: [0, 0, 1], laminated: false });
    fx.sink({ type: 'panelDetach', panelIndex: 1, mode: 'hide', pos: [0, 1, 0] });
    const n = fx.glass.live;
    for (let t = 0; t < 60; t += 1 / 30) fx.update(1 / 30);
    // a minute later every crumb is still on the road (the old pool faded them out after ≈ 9 s)
    expect(fx.glass.live).toBe(n);
    expect(fx.debris.live).toBeGreaterThan(0);
    expect(DEBRIS_PERSIST_S).toBeGreaterThanOrEqual(300);
    const before = new Float32Array(fx.glass.mesh.instanceMatrix.array);
    fx.update(1 / 30);
    expect(Array.from(fx.glass.mesh.instanceMatrix.array)).toEqual(Array.from(before));
    fx.dispose();
  });
});

describe('crack GLSL', () => {
  it('declares the per-pane uniforms and the dmgCrack entry point', () => {
    for (const u of ['uCrackA', 'uCrackB', 'uCrackU', 'uCrackV', 'uCrackSeed']) expect(GLASS_CRACK_GLSL).toContain(u);
    expect(GLASS_CRACK_GLSL).toContain('float dmgCrack(vec3 p, float px)');
  });
});
