/**
 * Free-fly camera (P7 R2: replay free cam + photo mode). Pure state; the UI
 * feeds it held movement axes and pointer deltas.
 *
 *   move      W/S forward/back along the view, A/D strafe, E/Q (or Space/C) up/down
 *   look      pointer drag (yaw / pitch, smoothed)
 *   speed     Shift ×4, Alt ×0.25; the wheel scales the base speed
 *
 * Motion runs in WALL time (it is the viewer's own camera): the velocity
 * eases toward the held direction with a critically damped spring (smooth
 * acceleration AND braking), and the position never goes below the terrain
 * + `clearance` (the downward velocity is cancelled on contact, so it glides
 * along slopes instead of bouncing).
 */
import { Vector3 } from 'three';
import { clamp, createPose, keepAboveGround, springAngle, spring1, springVec, wrapAngle, type CameraPose, type CameraWorld, type Spring1 } from './rig';

export interface FreeCamInput {
  /** −1..1 each: +forward, +right, +up. */
  forward: number;
  right: number;
  up: number;
  fast: boolean;
  slow: boolean;
}

export function createFreeCamInput(): FreeCamInput {
  return { forward: 0, right: 0, up: 0, fast: false, slow: false };
}

export const FREE_CAM_SPEED = 9;
const FAST = 4;
const SLOW = 0.25;
const ACCEL_OMEGA = 5.5;
const LOOK_OMEGA = 22;
const PITCH_LIMIT = 1.52;

export class FreeCamera {
  readonly pose: CameraPose = createPose();
  readonly velocity = new Vector3();
  /** Base speed multiplier (wheel). */
  speedScale = 1;
  clearance = 0.3;
  private readonly yaw: Spring1 = { x: 0, v: 0 };
  private readonly pitch: Spring1 = { x: 0, v: 0 };
  private yawGoal = 0;
  private pitchGoal = 0;
  private readonly goalVel = new Vector3();
  private readonly accel = new Vector3();
  private readonly dir = new Vector3();

  /** Start from an existing camera pose (no jump when switching to the free cam). */
  setFromPose(p: Readonly<CameraPose>): void {
    this.pose.position.copy(p.position);
    this.pose.fov = p.fov;
    this.pose.roll = p.roll;
    this.pose.focus = p.focus;
    const d = this.dir.copy(p.look).sub(p.position);
    if (d.lengthSq() < 1e-8) d.set(0, 0, -1);
    d.normalize();
    this.yawGoal = this.yaw.x = Math.atan2(d.x, d.z);
    this.pitchGoal = this.pitch.x = Math.asin(clamp(d.y, -1, 1));
    this.yaw.v = this.pitch.v = 0;
    this.velocity.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    this.writeLook();
  }

  /** Pointer drag, pixels (drag right = look right). */
  look(dx: number, dy: number, fovDeg = this.pose.fov): void {
    // Narrow lenses turn slower (constant on-screen speed).
    const k = 0.0042 * (fovDeg / 60);
    this.yawGoal = this.yawGoal - dx * k;
    this.pitchGoal = clamp(this.pitchGoal - dy * k, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Wheel: scale the base speed by notches. */
  scaleSpeed(notches: number): void {
    this.speedScale = clamp(this.speedScale * Math.pow(1.25, -notches), 0.1, 12);
  }

  /** Aim at a world point (instantly). */
  lookAt(p: Vector3): void {
    const d = this.dir.copy(p).sub(this.pose.position);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    this.yawGoal = this.yaw.x = Math.atan2(d.x, d.z);
    this.pitchGoal = this.pitch.x = Math.asin(clamp(d.y, -1, 1));
    this.writeLook();
  }

  get yawAngle(): number {
    return this.yaw.x;
  }
  get pitchAngle(): number {
    return this.pitch.x;
  }

  update(wallDt: number, input: Readonly<FreeCamInput>, world: CameraWorld | null): void {
    const dt = clamp(wallDt, 0, 0.1);
    // Unwrapped yaw goal, wrapped state: springAngle takes the short way round.
    springAngle(this.yaw, wrapAngle(this.yawGoal), LOOK_OMEGA, dt);
    spring1(this.pitch, this.pitchGoal, LOOK_OMEGA, dt);
    const cy = Math.cos(this.yaw.x);
    const sy = Math.sin(this.yaw.x);
    const cp = Math.cos(this.pitch.x);
    const sp = Math.sin(this.pitch.x);
    // forward (with pitch), right (horizontal), world up.
    const speed = FREE_CAM_SPEED * this.speedScale * (input.fast ? FAST : 1) * (input.slow ? SLOW : 1);
    const f = clamp(input.forward, -1, 1);
    const r = clamp(input.right, -1, 1);
    const u = clamp(input.up, -1, 1);
    this.goalVel.set(sy * cp * f - cy * r, sp * f + u, cy * cp * f + sy * r);
    const len = this.goalVel.length();
    if (len > 1) this.goalVel.multiplyScalar(1 / len);
    this.goalVel.multiplyScalar(speed);
    springVec(this.velocity, this.accel, this.goalVel, ACCEL_OMEGA, dt);
    this.pose.position.addScaledVector(this.velocity, dt);
    if (world && keepAboveGround(world, this.pose.position, this.clearance) && this.velocity.y < 0) {
      this.velocity.y = 0;
      if (this.accel.y < 0) this.accel.y = 0;
    }
    this.writeLook();
  }

  private writeLook(): void {
    const cp = Math.cos(this.pitch.x);
    this.pose.look.set(
      this.pose.position.x + Math.sin(this.yaw.x) * cp * 10,
      this.pose.position.y + Math.sin(this.pitch.x) * 10,
      this.pose.position.z + Math.cos(this.yaw.x) * cp * 10,
    );
  }
}
