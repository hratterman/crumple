/**
 * Scalar, vec3 and quaternion helpers shared by sim, render and game code.
 * Pure TypeScript, no allocations in the out-param APIs: callers own the
 * output storage. Vectors are [x,y,z] and quaternions [x,y,z,w]; anything
 * numerically indexable works (tuples, number[], Float32Array/Float64Array
 * and their subarray views), which is what Vec3Like/QuatLike encode.
 * Component reads are cast internally because noUncheckedIndexedAccess
 * cannot see the length invariant.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** Numerically indexable storage with at least 3 components. */
export interface Vec3Like {
  [index: number]: number;
}

/** Numerically indexable storage with at least 4 components, [x,y,z,w]. */
export interface QuatLike {
  [index: number]: number;
}

export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Scalars

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of lerp: where v sits between a and b (unclamped). */
export function invLerp(a: number, b: number, v: number): number {
  return (v - a) / (b - a);
}

/** Remap v from [inMin, inMax] to [outMin, outMax] (unclamped). */
export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, invLerp(inMin, inMax, v));
}

/** GLSL-style smoothstep: 0 at edge0, 1 at edge1, clamped hermite between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate-independent exponential smoothing toward target.
 * lambda [1/s] is the decay rate: after time 1/lambda the remaining error is
 * 1/e. n steps of dt equal one step of n·dt exactly, so behavior does not
 * depend on frame rate.
 */
export function expDamp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + PI) / TWO_PI);
}

export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

// ---------------------------------------------------------------------------
// Vec3 (out-param style; returns out; aliasing out with inputs is safe)

export function vec3Set<T extends Vec3Like>(out: T, x: number, y: number, z: number): T {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vec3Copy<T extends Vec3Like>(out: T, a: Vec3Like): T {
  out[0] = a[0] as number;
  out[1] = a[1] as number;
  out[2] = a[2] as number;
  return out;
}

export function vec3Add<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like): T {
  out[0] = (a[0] as number) + (b[0] as number);
  out[1] = (a[1] as number) + (b[1] as number);
  out[2] = (a[2] as number) + (b[2] as number);
  return out;
}

export function vec3Sub<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like): T {
  out[0] = (a[0] as number) - (b[0] as number);
  out[1] = (a[1] as number) - (b[1] as number);
  out[2] = (a[2] as number) - (b[2] as number);
  return out;
}

export function vec3Scale<T extends Vec3Like>(out: T, a: Vec3Like, s: number): T {
  out[0] = (a[0] as number) * s;
  out[1] = (a[1] as number) * s;
  out[2] = (a[2] as number) * s;
  return out;
}

/** out = a + b * s */
export function vec3AddScaled<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like, s: number): T {
  out[0] = (a[0] as number) + (b[0] as number) * s;
  out[1] = (a[1] as number) + (b[1] as number) * s;
  out[2] = (a[2] as number) + (b[2] as number) * s;
  return out;
}

export function vec3Dot(a: Vec3Like, b: Vec3Like): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

export function vec3Cross<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like): T {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function vec3LengthSq(a: Vec3Like): number {
  const x = a[0] as number;
  const y = a[1] as number;
  const z = a[2] as number;
  return x * x + y * y + z * z;
}

export function vec3Length(a: Vec3Like): number {
  return Math.sqrt(vec3LengthSq(a));
}

export function vec3DistSq(a: Vec3Like, b: Vec3Like): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  const dz = (a[2] as number) - (b[2] as number);
  return dx * dx + dy * dy + dz * dz;
}

export function vec3Dist(a: Vec3Like, b: Vec3Like): number {
  return Math.sqrt(vec3DistSq(a, b));
}

/** Normalize a into out; a zero-length input yields [0,0,0]. */
export function vec3Normalize<T extends Vec3Like>(out: T, a: Vec3Like): T {
  const lenSq = vec3LengthSq(a);
  if (lenSq === 0) return vec3Set(out, 0, 0, 0);
  const inv = 1 / Math.sqrt(lenSq);
  return vec3Scale(out, a, inv);
}

export function vec3Lerp<T extends Vec3Like>(out: T, a: Vec3Like, b: Vec3Like, t: number): T {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  out[0] = ax + ((b[0] as number) - ax) * t;
  out[1] = ay + ((b[1] as number) - ay) * t;
  out[2] = az + ((b[2] as number) - az) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Quaternion [x,y,z,w] (out-param style; aliasing-safe)

export function quatIdentity<T extends QuatLike>(out: T): T {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  return out;
}

/** Axis is normalized internally; a zero axis yields identity. */
export function quatFromAxisAngle<T extends QuatLike>(out: T, axis: Vec3Like, angle: number): T {
  const x = axis[0] as number;
  const y = axis[1] as number;
  const z = axis[2] as number;
  const lenSq = x * x + y * y + z * z;
  if (lenSq === 0) return quatIdentity(out);
  const inv = 1 / Math.sqrt(lenSq);
  const half = angle * 0.5;
  const s = Math.sin(half) * inv;
  out[0] = x * s;
  out[1] = y * s;
  out[2] = z * s;
  out[3] = Math.cos(half);
  return out;
}

/** Hamilton product out = a ⊗ b (apply b's rotation, then a's). */
export function quatMultiply<T extends QuatLike>(out: T, a: QuatLike, b: QuatLike): T {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatNormalize<T extends QuatLike>(out: T, q: QuatLike): T {
  const x = q[0] as number;
  const y = q[1] as number;
  const z = q[2] as number;
  const w = q[3] as number;
  const lenSq = x * x + y * y + z * z + w * w;
  if (lenSq === 0) return quatIdentity(out);
  const inv = 1 / Math.sqrt(lenSq);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  out[3] = w * inv;
  return out;
}

/** Rotate vector v by unit quaternion q: out = v + qw·t + q×t, t = 2·(q×v). */
export function quatRotateVec3<T extends Vec3Like>(out: T, q: QuatLike, v: Vec3Like): T {
  const qx = q[0] as number;
  const qy = q[1] as number;
  const qz = q[2] as number;
  const qw = q[3] as number;
  const vx = v[0] as number;
  const vy = v[1] as number;
  const vz = v[2] as number;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  return out;
}

/**
 * Spherical lerp along the shortest arc; falls back to normalized lerp when
 * the quaternions are nearly parallel (sin(omega) → 0).
 */
export function quatSlerp<T extends QuatLike>(out: T, a: QuatLike, b: QuatLike, t: number): T {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  let bx = b[0] as number;
  let by = b[1] as number;
  let bz = b[2] as number;
  let bw = b[3] as number;
  let cosOmega = ax * bx + ay * by + az * bz + aw * bw;
  if (cosOmega < 0) {
    cosOmega = -cosOmega;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cosOmega > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const omega = Math.acos(clamp(cosOmega, -1, 1));
    const invSin = 1 / Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) * invSin;
    s1 = Math.sin(t * omega) * invSin;
  }
  const x = s0 * ax + s1 * bx;
  const y = s0 * ay + s1 * by;
  const z = s0 * az + s1 * bz;
  const w = s0 * aw + s1 * bw;
  // Renormalize: exact no-op for the slerp branch, required for nlerp.
  const inv = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  out[3] = w * inv;
  return out;
}
