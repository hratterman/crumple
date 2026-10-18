/**
 * Spring-damped chase camera.
 *
 * Heading = vehicle forward (projected to the ground plane) blended toward
 * the horizontal velocity direction as speed rises, so drifts and slides keep
 * the camera on the line of travel. The heading is yaw-smoothed (never
 * interpolated through the car on a 180° flip), the camera offset relative to
 * the low-passed chassis point runs through an exact critically damped
 * spring (stable for any dt, no lag at constant velocity), the look point
 * leads with speed and the FOV widens gently with speed. The camera never
 * goes below ground height + groundClearance.
 */
import { PerspectiveCamera, Vector3 } from 'three';

export interface ChaseTarget {
  /** Chassis reference point, world m (e.g. the vehicle frame origin node). */
  position: Vector3;
  /** Unit vehicle forward, world. */
  forward: Vector3;
  /** Unit vehicle up, world. */
  up: Vector3;
  /** Chassis velocity, world m/s. */
  velocity: Vector3;
}

export interface ChaseOptions {
  /** Horizontal distance behind the target at rest, m. */
  distance: number;
  /** Extra distance at fovFullSpeed, m. */
  distanceAtSpeed: number;
  /** Camera height above the target point, m. */
  height: number;
  /** Look-point height above the target point, m. */
  lookHeight: number;
  /** Look-ahead along the heading at lookAheadFullSpeed, m. */
  lookAheadMax: number;
  lookAheadFullSpeed: number;
  baseFov: number;
  /** FOV added at fovFullSpeed, degrees. */
  maxFovBoost: number;
  fovFullSpeed: number;
  /** Critically damped spring angular frequency for the camera offset, rad/s. */
  springOmega: number;
  /** Yaw smoothing rate, 1/s. */
  headingLambda: number;
  /** Chassis-point low-pass rate, 1/s (removes snapshot jitter). */
  targetLambda: number;
  /** Below this horizontal speed (m/s) the heading is pure vehicle forward. */
  velocityHeadingMinSpeed: number;
  /** At or above this speed the heading follows the velocity direction. */
  velocityHeadingFullSpeed: number;
  /** Minimum camera height above the ground, m. */
  groundClearance: number;
  /** Ground height under (x, z). */
  groundHeight: (x: number, z: number) => number;
}

export const DEFAULT_CHASE_OPTIONS: Readonly<ChaseOptions> = {
  distance: 5.6,
  distanceAtSpeed: 1.6,
  height: 1.9,
  lookHeight: 0.8,
  lookAheadMax: 4,
  lookAheadFullSpeed: 35,
  baseFov: 60,
  maxFovBoost: 14,
  fovFullSpeed: 45,
  springOmega: 9,
  headingLambda: 3.5,
  targetLambda: 25,
  velocityHeadingMinSpeed: 2,
  velocityHeadingFullSpeed: 12,
  groundClearance: 0.3,
  groundHeight: () => 0,
};

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/** Exact critically damped spring step toward `goal` (per component, in place). */
function springStep(x: Vector3, v: Vector3, goal: Vector3, omega: number, dt: number): void {
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

/**
 * Reads the vehicle frame (origin, forward, up) from interpolated node
 * positions. `frameNodes` = rig-local [origin, front, top]. Returns false
 * when the nodes are missing or degenerate.
 */
export function vehiclePoseFromNodes(
  positions: Float32Array,
  nodeOffset: number,
  nodeCount: number,
  frameNodes: ArrayLike<number>,
  outPos: Vector3,
  outForward: Vector3,
  outUp: Vector3,
): boolean {
  const o = frameNodes[0] ?? -1;
  const f = frameNodes[1] ?? -1;
  const t = frameNodes[2] ?? -1;
  if (o < 0 || f < 0 || t < 0 || o >= nodeCount || f >= nodeCount || t >= nodeCount) return false;
  const io = (nodeOffset + o) * 3;
  const iF = (nodeOffset + f) * 3;
  const it = (nodeOffset + t) * 3;
  const ox = positions[io]!;
  const oy = positions[io + 1]!;
  const oz = positions[io + 2]!;
  outPos.set(ox, oy, oz);
  outForward.set(positions[iF]! - ox, positions[iF + 1]! - oy, positions[iF + 2]! - oz);
  outUp.set(positions[it]! - ox, positions[it + 1]! - oy, positions[it + 2]! - oz);
  const fl = outForward.length();
  if (!(fl > 1e-4) || !Number.isFinite(ox + oy + oz)) return false;
  outForward.multiplyScalar(1 / fl);
  // Gram-Schmidt: up ⟂ forward.
  outUp.addScaledVector(outForward, -outUp.dot(outForward));
  const ul = outUp.length();
  if (ul > 1e-4) outUp.multiplyScalar(1 / ul);
  else outUp.set(0, 1, 0);
  return true;
}

export class ChaseCamera {
  readonly options: ChaseOptions;
  private yaw = 0;
  private initialized = false;
  private readonly smoothTarget = new Vector3();
  private readonly offset = new Vector3();
  private readonly offsetVel = new Vector3();
  private readonly goal = new Vector3();
  private readonly look = new Vector3();
  private readonly tmp = new Vector3();
  private fov: number;

  constructor(
    readonly camera: PerspectiveCamera,
    options: Partial<ChaseOptions> = {},
  ) {
    this.options = { ...DEFAULT_CHASE_OPTIONS, ...options };
    this.fov = this.options.baseFov;
  }

  /** Next update snaps to the target instead of springing from the current pose. */
  reset(): void {
    this.initialized = false;
  }

  /**
   * Continue from the camera's current pose (e.g. after a camera switch):
   * the spring starts at the existing offset from `target`.
   */
  takeOver(target: ChaseTarget): void {
    this.initFrom(target);
    this.offset.copy(this.camera.position).sub(this.smoothTarget);
    this.offsetVel.set(0, 0, 0);
    this.fov = this.camera.fov;
  }

  update(dt: number, target: ChaseTarget): void {
    const o = this.options;
    const step = Math.min(Math.max(dt, 0), 0.1);
    if (!this.initialized) {
      this.initFrom(target);
      this.desiredOffset(0, this.offset);
      this.offsetVel.set(0, 0, 0);
    }

    // Low-passed chassis point.
    const kt = 1 - Math.exp(-o.targetLambda * step);
    this.smoothTarget.lerp(target.position, kt);

    // Heading: forward blended toward the velocity direction with speed.
    const v = target.velocity;
    const speedH = Math.hypot(v.x, v.z);
    const desiredYaw = this.headingYaw(target, speedH);
    if (desiredYaw !== null) {
      const ky = 1 - Math.exp(-o.headingLambda * step);
      this.yaw = wrapAngle(this.yaw + wrapAngle(desiredYaw - this.yaw) * ky);
    }

    this.desiredOffset(speedH, this.goal);
    springStep(this.offset, this.offsetVel, this.goal, o.springOmega, step);

    const cam = this.camera;
    cam.position.copy(this.smoothTarget).add(this.offset);
    const minY = o.groundHeight(cam.position.x, cam.position.z) + o.groundClearance;
    if (cam.position.y < minY) {
      cam.position.y = minY;
      this.offset.y = minY - this.smoothTarget.y;
      if (this.offsetVel.y < 0) this.offsetVel.y = 0;
    }

    // Look point leads along the heading with speed.
    const lead = o.lookAheadMax * Math.min(speedH / o.lookAheadFullSpeed, 1);
    this.look
      .copy(this.smoothTarget)
      .add(this.tmp.set(Math.sin(this.yaw) * lead, o.lookHeight, Math.cos(this.yaw) * lead));
    cam.lookAt(this.look);

    const fovGoal = o.baseFov + o.maxFovBoost * smoothstep(5, o.fovFullSpeed, speedH);
    this.fov += (fovGoal - this.fov) * (1 - Math.exp(-2 * step));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  private initFrom(target: ChaseTarget): void {
    this.smoothTarget.copy(target.position);
    const y = this.headingYaw(target, 0);
    this.yaw = y ?? 0;
    this.initialized = true;
  }

  /** Heading as a yaw about +Y (0 = +Z), or null when undefined (car pointing straight up/down at rest). */
  private headingYaw(target: ChaseTarget, speedH: number): number | null {
    const o = this.options;
    const f = target.forward;
    let hx = f.x;
    let hz = f.z;
    const fl = Math.hypot(hx, hz);
    if (fl > 0.2) {
      hx /= fl;
      hz /= fl;
    } else {
      hx = hz = 0;
    }
    if (speedH > o.velocityHeadingMinSpeed) {
      let vx = target.velocity.x / speedH;
      let vz = target.velocity.z / speedH;
      // Reversing: follow the line of travel but keep looking over the tail.
      const along = vx * hx + vz * hz;
      if (along < 0) {
        vx = -vx;
        vz = -vz;
      }
      const w =
        smoothstep(o.velocityHeadingMinSpeed, o.velocityHeadingFullSpeed, speedH) *
        (fl > 0.2 ? Math.min(1, Math.abs(along) * 1.5) : 1);
      hx = hx * (1 - w) + vx * w;
      hz = hz * (1 - w) + vz * w;
    }
    if (Math.hypot(hx, hz) < 1e-3) return null;
    return Math.atan2(hx, hz);
  }

  /** Offset from the chassis point to the ideal camera position for the current yaw. */
  private desiredOffset(speedH: number, out: Vector3): Vector3 {
    const o = this.options;
    const d = o.distance + o.distanceAtSpeed * Math.min(speedH / o.fovFullSpeed, 1);
    return out.set(-Math.sin(this.yaw) * d, o.height, -Math.cos(this.yaw) * d);
  }
}
