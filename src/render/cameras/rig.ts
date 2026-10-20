/**
 * Shared camera-rig vocabulary (P7 R2): the subject a rig films, the world it
 * must not clip into, the pose it outputs, and the smoothing math.
 *
 * TIME. Every subject-following rig integrates in PRESENTED time (the replay
 * playhead delta, |Δt| so reverse play is smooth too) and user-driven motion
 * (orbit drags, the free cam) in wall time. A rig therefore holds perfectly
 * still on a paused frame and moves at 1/8× exactly like a slowed-down
 * recording of its 1× motion: no lag build-up, no jitter.
 */
import { Vector3 } from 'three';

/**
 * Camera subject (structurally a `ReplayTarget` from app/replay: world m,
 * unit forward/up, velocity m/s, bounding radius m).
 */
export interface CameraSubject {
  readonly objectId: number;
  readonly valid: boolean;
  readonly position: ArrayLike<number>;
  readonly forward: ArrayLike<number>;
  readonly up: ArrayLike<number>;
  readonly velocity: ArrayLike<number>;
  readonly radius: number;
}

/** What a rig may ask about the world (all optional beyond the ground). */
export interface CameraWorld {
  groundHeight(x: number, z: number): number;
  /** Static geometry between a and b (colliders); terrain is tested separately. */
  occluded?(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** The nearest static occluder point to (x, y, z) into `out`; returns its distance, m (Infinity when none). */
  nearestOccluder?(x: number, y: number, z: number, out: Vector3): number;
  /**
   * A roadside point near (x, z): the nearest road edge + `offset` m beyond
   * its shoulder on side `side` (+1 right of travel, −1 left), written to out
   * [x, y, z] (y = ground). False when no road is within `maxDist`.
   */
  roadside?(x: number, z: number, side: 1 | -1, offset: number, maxDist: number, out: Vector3): boolean;
}

/** One frame of camera output. `look` is a world point; `focus` the distance to keep sharp (DoF), m. */
export interface CameraPose {
  position: Vector3;
  look: Vector3;
  /** Vertical FOV, degrees. */
  fov: number;
  /** Roll about the view axis, rad (+ = clockwise on screen). */
  roll: number;
  focus: number;
}

export function createPose(): CameraPose {
  return { position: new Vector3(), look: new Vector3(0, 0, -1), fov: 55, roll: 0, focus: 10 };
}

export function copyPose(out: CameraPose, p: Readonly<CameraPose>): CameraPose {
  out.position.copy(p.position);
  out.look.copy(p.look);
  out.fov = p.fov;
  out.roll = p.roll;
  out.focus = p.focus;
  return out;
}

/** Per-frame inputs of a rig. */
export interface ShotFrame {
  /** |Δ presented time| this frame, s (0 while paused). */
  dt: number;
  /** Wall-clock delta, s. */
  wallDt: number;
  /** Presented (sim) time, s. */
  time: number;
  subject: CameraSubject;
  world: CameraWorld;
}

// ============================================================ math
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/** Exponential approach factor for rate λ over dt (frame-rate independent). */
export function damp(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * dt);
}

/** Scalar critically damped spring: state {x, v} toward goal at ω (exact for any dt). */
export interface Spring1 {
  x: number;
  v: number;
}
export function spring1(s: Spring1, goal: number, omega: number, dt: number): number {
  if (!(dt > 0)) return s.x;
  const e = Math.exp(-omega * dt);
  const c = s.x - goal;
  const t = (s.v + omega * c) * dt;
  s.v = (s.v - omega * t) * e;
  s.x = goal + (c + t) * e;
  return s.x;
}

/** Vector critically damped spring (in place on x / v). */
export function springVec(x: Vector3, v: Vector3, goal: Vector3, omega: number, dt: number): void {
  if (!(dt > 0)) return;
  const e = Math.exp(-omega * dt);
  const cx = x.x - goal.x;
  const cy = x.y - goal.y;
  const cz = x.z - goal.z;
  const tx = (v.x + omega * cx) * dt;
  const ty = (v.y + omega * cy) * dt;
  const tz = (v.z + omega * cz) * dt;
  v.set((v.x - omega * tx) * e, (v.y - omega * ty) * e, (v.z - omega * tz) * e);
  x.set(goal.x + (cx + tx) * e, goal.y + (cy + ty) * e, goal.z + (cz + tz) * e);
}

/** Angle spring (wraps the error so it never spins the long way). */
export function springAngle(s: Spring1, goal: number, omega: number, dt: number): number {
  const g = s.x + wrapAngle(goal - s.x);
  spring1(s, g, omega, dt);
  s.x = wrapAngle(s.x);
  return s.x;
}

/** Copies a subject's array fields into vectors. */
export function subjectPosition(s: CameraSubject, out: Vector3): Vector3 {
  return out.set(s.position[0]!, s.position[1]!, s.position[2]!);
}
export function subjectForward(s: CameraSubject, out: Vector3): Vector3 {
  return out.set(s.forward[0]!, s.forward[1]!, s.forward[2]!);
}
export function subjectUp(s: CameraSubject, out: Vector3): Vector3 {
  return out.set(s.up[0]!, s.up[1]!, s.up[2]!);
}
export function subjectVelocity(s: CameraSubject, out: Vector3): Vector3 {
  return out.set(s.velocity[0]!, s.velocity[1]!, s.velocity[2]!);
}

/** A sane radius (the frame-origin bounding sphere of a car is 2–4 m). */
export function subjectRadius(s: CameraSubject): number {
  return Number.isFinite(s.radius) && s.radius > 0.3 ? Math.min(s.radius, 12) : 2.4;
}

/**
 * Travel heading (yaw about +Y, 0 = +Z, like the chase cam): the horizontal
 * velocity once moving, else the body forward; null when neither is defined.
 */
export function subjectHeading(s: CameraSubject, minSpeed = 2): number | null {
  const vx = s.velocity[0]!;
  const vz = s.velocity[2]!;
  const sp = Math.hypot(vx, vz);
  if (sp > minSpeed) return Math.atan2(vx, vz);
  const fx = s.forward[0]!;
  const fz = s.forward[2]!;
  if (Math.hypot(fx, fz) > 0.2) return Math.atan2(fx, fz);
  return sp > 0.05 ? Math.atan2(vx, vz) : null;
}

/** Vertical FOV (deg) that frames a sphere of radius r at distance d filling `fill` of the frame height. */
export function framingFov(r: number, d: number, fill: number, lo: number, hi: number): number {
  const half = Math.atan2(r / Math.max(fill, 0.05), Math.max(d, 0.1));
  return clamp((2 * half * 180) / Math.PI, lo, hi);
}

// ============================================================ line of sight
const LOS_STEP_M = 1.5;
const LOS_MAX_SAMPLES = 96;

/**
 * True when the segment a→b clears the terrain by `clearance` m at every
 * sample (≤ 96 samples, ~1.5 m apart, the end points excluded) and no
 * `world.occluded` geometry sits between them.
 */
export function lineOfSight(world: CameraWorld, a: Vector3, b: Vector3, clearance = 0.15): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-3) {
    const n = Math.min(LOS_MAX_SAMPLES, Math.max(2, Math.ceil(len / LOS_STEP_M)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (a.y + dy * t < world.groundHeight(x, z) + clearance) return false;
    }
  }
  return !world.occluded || !world.occluded(a.x, a.y, a.z, b.x, b.y, b.z);
}

/** Lifts `p` to at least `clearance` above the ground (in place); returns true when it moved. */
export function keepAboveGround(world: CameraWorld, p: Vector3, clearance: number): boolean {
  const g = world.groundHeight(p.x, p.z) + clearance;
  if (p.y < g) {
    p.y = g;
    return true;
  }
  return false;
}

/** Writes a pose into a camera: position, look-at, roll about the view axis, fov. */
export function applyPose(
  camera: { position: Vector3; up: Vector3; fov: number; lookAt(v: Vector3): void; rotateZ(a: number): unknown; updateProjectionMatrix(): void; updateMatrixWorld(force?: boolean): void },
  p: Readonly<CameraPose>,
): void {
  camera.position.copy(p.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(p.look);
  if (p.roll !== 0) camera.rotateZ(-p.roll);
  if (Math.abs(camera.fov - p.fov) > 1e-3) {
    camera.fov = p.fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

/**
 * Critically damped tracking of a goal moving at `goalVel`: the spring acts
 * on the error in the goal's moving frame, so there is no steady-state lag at
 * constant velocity (a plain spring trails a 30 m/s car by 2v/ω metres) and
 * only accelerations (impacts, turns) are smoothed.
 */
export function springTrack(x: Vector3, v: Vector3, goal: Vector3, goalVel: Vector3, omega: number, dt: number): void {
  if (!(dt > 0)) return;
  const e = Math.exp(-omega * dt);
  // Error against where the goal was at the START of the step (it moves goalVel·dt meanwhile).
  const cx = x.x - (goal.x - goalVel.x * dt);
  const cy = x.y - (goal.y - goalVel.y * dt);
  const cz = x.z - (goal.z - goalVel.z * dt);
  const evx = v.x - goalVel.x;
  const evy = v.y - goalVel.y;
  const evz = v.z - goalVel.z;
  const tx = (evx + omega * cx) * dt;
  const ty = (evy + omega * cy) * dt;
  const tz = (evz + omega * cz) * dt;
  v.set(goalVel.x + (evx - omega * tx) * e, goalVel.y + (evy - omega * ty) * e, goalVel.z + (evz - omega * tz) * e);
  x.set(goal.x + (cx + tx) * e, goal.y + (cy + ty) * e, goal.z + (cz + tz) * e);
}
