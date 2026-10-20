import { DepthTexture, FloatType, PerspectiveCamera, type Vector4, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import {
  createLightUniforms,
  createParticleSpawn,
  createSoftMaterial,
  createSparkMaterial,
  motionY,
  NO_BOUNCE,
  ParticlePool,
  RECORD_FLOATS,
  SceneDepthCopy,
  solveGroundHit,
  type KindMotion,
} from './particles';
import { createPuffTexture, puffDensity } from './textures';

const SPARK: KindMotion = { drag: 0.8, gravity: 9.81, rise: 0, wind: 0 };
const SMOKE: KindMotion = { drag: 1.5, gravity: 0, rise: 0.75, wind: 1 };

describe('analytic particle motion', () => {
  it('solveGroundHit lands on the ground plane (descending)', () => {
    for (const [y0, vy] of [[1, 3], [0.5, -2], [2, 0], [0.05, 8]] as const) {
      const tb = solveGroundHit(y0, vy, 0, SPARK);
      expect(tb).toBeGreaterThan(0);
      expect(tb).toBeLessThan(NO_BOUNCE);
      expect(Math.abs(motionY(y0, vy, tb, SPARK))).toBeLessThan(1e-4);
      // above ground just before
      expect(motionY(y0, vy, tb * 0.98, SPARK)).toBeGreaterThan(0);
    }
  });
  it('rising smoke never bounces; a spawn below ground bounces at once', () => {
    expect(solveGroundHit(1, 0.5, 0, SMOKE)).toBe(NO_BOUNCE);
    expect(solveGroundHit(-0.1, -1, 0, SPARK)).toBe(0);
  });
});

describe('ParticlePool', () => {
  const kinds = [SPARK];
  const make = (cap: number): ParticlePool => new ParticlePool('t', cap, createSparkMaterial(kinds), kinds, 0);

  it('ring buffer: recycles the oldest record, draws at most capacity', () => {
    const pool = make(8);
    const s = createParticleSpawn();
    s.life = 1;
    for (let i = 0; i < 13; i++) {
      s.birth = i * 0.1;
      s.px = i;
      pool.spawn(s);
    }
    expect(pool.drawn).toBe(8);
    expect(pool.mesh.geometry.instanceCount).toBe(0); // until flush
    pool.flush(1.25);
    expect(pool.mesh.geometry.instanceCount).toBe(8);
    // slots hold spawns 5..12; slot 0 was overwritten by spawn 8
    const data = (pool.mesh.geometry.getAttribute('iA') as unknown as { data: { array: Float32Array } }).data.array;
    expect(data[0]).toBe(8);
    expect(data[RECORD_FLOATS * 5]).toBe(5);
    // births 0.5..1.2, life 1 → alive at 1.25 are births > 0.25 → all 8
    expect(pool.live(1.25)).toBe(8);
    expect(pool.live(2.0)).toBe(2); // births 1.1, 1.2
    expect(pool.anyAlive(10)).toBe(false);
  });

  it('flush uploads only the touched slice (two ranges across the wrap)', () => {
    const pool = make(10);
    const s = createParticleSpawn();
    for (let i = 0; i < 8; i++) pool.spawn(s);
    pool.flush(0);
    const buf = (pool.mesh.geometry.getAttribute('iA') as unknown as { data: { updateRanges: { start: number; count: number }[] } }).data;
    expect(buf.updateRanges).toEqual([{ start: 0, count: 8 * RECORD_FLOATS }]);
    buf.updateRanges.length = 0;
    for (let i = 0; i < 4; i++) pool.spawn(s); // slots 8, 9, 0, 1
    pool.flush(0);
    expect(buf.updateRanges).toEqual([
      { start: 8 * RECORD_FLOATS, count: 2 * RECORD_FLOATS },
      { start: 0, count: 2 * RECORD_FLOATS },
    ]);
  });

  it('stores the bounce: post-bounce velocity points up', () => {
    const pool = make(4);
    const s = createParticleSpawn();
    s.py = 1;
    s.vy = 2;
    s.vx = 3;
    s.ground = 0;
    s.bounce = 0.4;
    s.friction = 0.5;
    pool.spawn(s);
    const d = (pool.mesh.geometry.getAttribute('iA') as unknown as { data: { array: Float32Array } }).data.array;
    expect(d[11]).toBeGreaterThan(0); // tb
    expect(d[11]).toBeLessThan(NO_BOUNCE);
    expect(d[9]).toBeGreaterThan(0); // vb.y up
    expect(d[8]).toBeGreaterThan(0); // vb.x keeps direction
    expect(d[8]).toBeLessThan(3);
  });

  it('resize reallocates and clears', () => {
    const pool = make(4);
    pool.spawn(createParticleSpawn());
    pool.resize(16);
    expect(pool.capacity).toBe(16);
    expect(pool.drawn).toBe(0);
  });
});

describe('fx materials + textures', () => {
  it('soft material compiles its uniform set (fog + light + kinds)', () => {
    const m = createSoftMaterial(createPuffTexture(), createLightUniforms(), [SMOKE], [[0.1, 0.4, 0.8, 0]]);
    expect(m.uniforms.fogColor).toBeDefined();
    expect(m.uniforms.uKind).toBeDefined();
    expect(m.depthWrite).toBe(false);
    expect(m.vertexShader).toContain('fxMotion');
  });
  it('soft shading never uses screen-space derivatives (constant per 2×2 quad → blocky smoke)', () => {
    const m = createSoftMaterial(createPuffTexture(), createLightUniforms(), [SMOKE], [[0.1, 0.4, 0.8, 0]]);
    expect(m.fragmentShader).not.toMatch(/\b(dFdx|dFdy|fwidth)\s*\(/);
    expect(m.fragmentShader).toContain('uSceneDepth');
    expect(m.uniforms.uSoftDepth).toBeDefined();
  });
  it('scene depth copy: blits the bound target once per draw, restores it, enables soft depth', () => {
    const m = createSoftMaterial(createPuffTexture(), createLightUniforms(), [SMOKE], [[0.1, 0.4, 0.8, 0]]);
    const copy = new SceneDepthCopy(m);
    const src = new DepthTexture(320, 180, FloatType);
    const rt = { width: 320, height: 180, samples: 0, depthTexture: src };
    const calls: string[] = [];
    let bound: unknown = rt;
    const renderer = {
      getRenderTarget: () => bound,
      initRenderTarget: () => calls.push('init'),
      copyTextureToTexture: (a: unknown, b: DepthTexture) => {
        calls.push(a === src && b.isDepthTexture ? 'copy' : 'bad');
        bound = null;
      },
      setRenderTarget: (t: unknown) => {
        calls.push(t === rt ? 'restore' : 'bad');
        bound = t;
      },
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
    } as unknown as WebGLRenderer;
    const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    copy.prepare(renderer, cam);
    expect(calls).toEqual(['init', 'copy', 'restore']);
    const soft = m.uniforms.uSoftDepth!.value as Vector4;
    expect(soft.x).toBe(1);
    expect(soft.y).toBeCloseTo(0.1);
    expect(soft.z).toBe(2000);
    expect((m.uniforms.uSceneDepth!.value as DepthTexture).isDepthTexture).toBe(true);
    // no depth texture on the target (canvas / other passes): soft depth off, nothing copied
    bound = { width: 320, height: 180, samples: 0, depthTexture: null };
    copy.prepare(renderer, cam);
    expect(soft.x).toBe(0);
    expect(calls.length).toBe(3);
    copy.dispose();
  });
  it('puff density is zero outside the unit disc and positive at the centre', () => {
    const noise = (): number => 0;
    expect(puffDensity(noise, 0.8, 0.8, 0)).toBe(0);
    expect(puffDensity(noise, 0, 0, 0)).toBeGreaterThan(0.3);
  });
});
