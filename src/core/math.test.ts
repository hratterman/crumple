import { describe, expect, it } from 'vitest';
import {
  clamp,
  degToRad,
  expDamp,
  invLerp,
  lerp,
  PI,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatRotateVec3,
  quatSlerp,
  radToDeg,
  remap,
  smoothstep,
  vec3Add,
  vec3AddScaled,
  vec3Copy,
  vec3Cross,
  vec3Dist,
  vec3Dot,
  vec3Length,
  vec3Lerp,
  vec3Normalize,
  vec3Scale,
  vec3Set,
  vec3Sub,
  wrapAngle,
  type Quat,
  type Vec3,
} from './math';

describe('scalars', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('lerp / invLerp / remap round-trip', () => {
    expect(lerp(2, 10, 0.5)).toBe(6);
    expect(invLerp(2, 10, 6)).toBe(0.5);
    expect(remap(6, 2, 10, 100, 200)).toBe(150);
    // unclamped by design
    expect(lerp(0, 10, 1.5)).toBe(15);
    expect(invLerp(0, 10, -5)).toBe(-0.5);
  });

  it('smoothstep clamps and eases', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    // monotone within the edge interval
    expect(smoothstep(0, 1, 0.25)).toBeLessThan(smoothstep(0, 1, 0.75));
  });

  it('degToRad / radToDeg', () => {
    expect(degToRad(180)).toBeCloseTo(PI, 12);
    expect(radToDeg(PI / 2)).toBeCloseTo(90, 12);
  });
});

describe('expDamp', () => {
  it('converges to the target', () => {
    let x = 0;
    for (let i = 0; i < 400; i++) x = expDamp(x, 10, 5, 1 / 60);
    expect(x).toBeCloseTo(10, 9);
  });

  it('is frame-rate independent: n small steps == one big step', () => {
    const lambda = 3;
    let small = 2;
    for (let i = 0; i < 10; i++) small = expDamp(small, 7, lambda, 0.01);
    const big = expDamp(2, 7, lambda, 0.1);
    expect(small).toBeCloseTo(big, 10);
  });

  it('never overshoots', () => {
    let x = 0;
    for (let i = 0; i < 50; i++) {
      x = expDamp(x, 1, 20, 0.1);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('dt = 0 is the identity', () => {
    expect(expDamp(3, 9, 5, 0)).toBe(3);
  });
});

describe('wrapAngle', () => {
  it('stays in [-PI, PI) for a sweep of inputs', () => {
    for (let a = -50; a <= 50; a += 0.37) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-PI);
      expect(w).toBeLessThan(PI);
      // wrapped angle is equivalent mod 2PI
      expect(Math.abs(Math.sin(w) - Math.sin(a))).toBeLessThan(1e-9);
      expect(Math.abs(Math.cos(w) - Math.cos(a))).toBeLessThan(1e-9);
    }
  });

  it('handles boundary values', () => {
    expect(wrapAngle(PI)).toBeCloseTo(-PI, 12);
    expect(wrapAngle(-PI)).toBeCloseTo(-PI, 12);
    expect(wrapAngle(3 * PI)).toBeCloseTo(-PI, 12);
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(2 * PI)).toBeCloseTo(0, 12);
  });
});

describe('vec3', () => {
  it('set/copy/add/sub/scale/addScaled', () => {
    const out: Vec3 = [0, 0, 0];
    expect(vec3Set(out, 1, 2, 3)).toEqual([1, 2, 3]);
    expect(vec3Copy([0, 0, 0], [4, 5, 6])).toEqual([4, 5, 6]);
    expect(vec3Add(out, [1, 2, 3], [10, 20, 30])).toEqual([11, 22, 33]);
    expect(vec3Sub(out, [1, 2, 3], [10, 20, 30])).toEqual([-9, -18, -27]);
    expect(vec3Scale(out, [1, 2, 3], 2)).toEqual([2, 4, 6]);
    expect(vec3AddScaled(out, [1, 1, 1], [1, 2, 3], 10)).toEqual([11, 21, 31]);
  });

  it('dot / cross / length / dist', () => {
    expect(vec3Dot([1, 2, 3], [4, 5, 6])).toBe(32);
    const c: Vec3 = [0, 0, 0];
    vec3Cross(c, [1, 0, 0], [0, 1, 0]);
    expect(c).toEqual([0, 0, 1]);
    expect(vec3Length([3, 4, 0])).toBe(5);
    expect(vec3Dist([1, 0, 0], [4, 4, 0])).toBe(5);
  });

  it('normalize gives unit length and zero-guards', () => {
    const out: Vec3 = [0, 0, 0];
    vec3Normalize(out, [10, 0, 0]);
    expect(out).toEqual([1, 0, 0]);
    vec3Normalize(out, [1, 2, 2]);
    expect(vec3Length(out)).toBeCloseTo(1, 12);
    vec3Normalize(out, [0, 0, 0]);
    expect(out).toEqual([0, 0, 0]);
  });

  it('lerp', () => {
    const out: Vec3 = [0, 0, 0];
    vec3Lerp(out, [0, 0, 0], [10, 20, 30], 0.5);
    expect(out).toEqual([5, 10, 15]);
  });

  it('operations are aliasing-safe (out === input)', () => {
    const a: Vec3 = [1, 0, 0];
    vec3Cross(a, a, [0, 1, 0]);
    expect(a).toEqual([0, 0, 1]);
    const b: Vec3 = [2, 3, 4];
    vec3Add(b, b, b);
    expect(b).toEqual([4, 6, 8]);
  });

  it('works on Float32Array views', () => {
    const buf = new Float32Array(6);
    const out = buf.subarray(0, 3);
    vec3Add(out, [1, 2, 3], [4, 5, 6]);
    expect(Array.from(out)).toEqual([5, 7, 9]);
  });
});

describe('quaternion', () => {
  it('identity rotation leaves vectors unchanged', () => {
    const q: Quat = [9, 9, 9, 9];
    quatIdentity(q);
    const v: Vec3 = [0, 0, 0];
    quatRotateVec3(v, q, [1, 2, 3]);
    expect(v).toEqual([1, 2, 3]);
  });

  it('fromAxisAngle: 90 deg about +Z takes +X to +Y', () => {
    const q: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(q, [0, 0, 1], PI / 2);
    const v: Vec3 = [0, 0, 0];
    quatRotateVec3(v, q, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
    expect(v[2]).toBeCloseTo(0, 12);
  });

  it('fromAxisAngle normalizes the axis and zero-guards', () => {
    const qa: Quat = [0, 0, 0, 1];
    const qb: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(qa, [0, 0, 10], 1);
    quatFromAxisAngle(qb, [0, 0, 1], 1);
    for (let i = 0; i < 4; i++) expect(qa[i as 0 | 1 | 2 | 3]).toBeCloseTo(qb[i as 0 | 1 | 2 | 3], 12);
    const qz: Quat = [1, 2, 3, 4];
    quatFromAxisAngle(qz, [0, 0, 0], 1);
    expect(qz).toEqual([0, 0, 0, 1]);
  });

  it('multiply composes rotations (two 45 deg = one 90 deg)', () => {
    const q45: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(q45, [0, 1, 0], PI / 4);
    const q90: Quat = [0, 0, 0, 1];
    quatMultiply(q90, q45, q45);
    const expected: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(expected, [0, 1, 0], PI / 2);
    for (let i = 0; i < 4; i++) {
      expect(q90[i as 0 | 1 | 2 | 3]).toBeCloseTo(expected[i as 0 | 1 | 2 | 3], 12);
    }
  });

  it('multiply applies b first, then a', () => {
    const rotZ: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(rotZ, [0, 0, 1], PI / 2);
    const rotX: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(rotX, [1, 0, 0], PI / 2);
    const combined: Quat = [0, 0, 0, 1];
    quatMultiply(combined, rotX, rotZ); // z-rotation happens first
    const v: Vec3 = [0, 0, 0];
    quatRotateVec3(v, combined, [1, 0, 0]);
    // +X --(z90)--> +Y --(x90)--> +Z
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(1, 12);
  });

  it('normalize', () => {
    const q: Quat = [0, 0, 0, 4];
    quatNormalize(q, q);
    expect(q).toEqual([0, 0, 0, 1]);
  });

  it('rotateVec3 is aliasing-safe (out === v)', () => {
    const q: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(q, [0, 0, 1], PI / 2);
    const v: Vec3 = [1, 0, 0];
    quatRotateVec3(v, q, v);
    expect(v[1]).toBeCloseTo(1, 12);
  });

  it('slerp hits endpoints and halves the angle at t=0.5', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(b, [0, 0, 1], PI / 2);
    const out: Quat = [0, 0, 0, 1];

    quatSlerp(out, a, b, 0);
    for (let i = 0; i < 4; i++) expect(out[i as 0 | 1 | 2 | 3]).toBeCloseTo(a[i as 0 | 1 | 2 | 3], 12);

    quatSlerp(out, a, b, 1);
    for (let i = 0; i < 4; i++) expect(out[i as 0 | 1 | 2 | 3]).toBeCloseTo(b[i as 0 | 1 | 2 | 3], 12);

    quatSlerp(out, a, b, 0.5);
    const mid: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(mid, [0, 0, 1], PI / 4);
    for (let i = 0; i < 4; i++) expect(out[i as 0 | 1 | 2 | 3]).toBeCloseTo(mid[i as 0 | 1 | 2 | 3], 12);
  });

  it('slerp takes the shortest path (negated quaternion)', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(b, [0, 0, 1], PI / 2);
    const negB: Quat = [-b[0], -b[1], -b[2], -b[3]];
    const out: Quat = [0, 0, 0, 1];
    quatSlerp(out, a, negB, 0.5);
    // Same rotation as slerping toward b.
    const v: Vec3 = [0, 0, 0];
    quatRotateVec3(v, out, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(v[1]).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('slerp of nearly-parallel quaternions stays unit-length (nlerp branch)', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0, 0, 0, 1];
    quatFromAxisAngle(b, [0, 0, 1], 1e-4);
    const out: Quat = [0, 0, 0, 1];
    quatSlerp(out, a, b, 0.5);
    const len = Math.sqrt(out[0] ** 2 + out[1] ** 2 + out[2] ** 2 + out[3] ** 2);
    expect(len).toBeCloseTo(1, 12);
  });
});
