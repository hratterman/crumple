/**
 * Orbit camera: OrbitControls around a followed point. The orbit target
 * tracks the subject by translating camera and target together, so the
 * user's chosen angle and distance are preserved while the car drives off.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface OrbitOptions {
  /** Follow rate toward the subject, 1/s. */
  followLambda: number;
  /** Look-point height above the subject point, m. */
  targetHeight: number;
  minDistance: number;
  maxDistance: number;
  fov: number;
}

export const DEFAULT_ORBIT_OPTIONS: Readonly<OrbitOptions> = {
  followLambda: 6,
  targetHeight: 0.6,
  minDistance: 2,
  maxDistance: 80,
  fov: 60,
};

export class OrbitCamera {
  readonly controls: OrbitControls;
  readonly options: OrbitOptions;
  private readonly goal = new Vector3();
  private readonly delta = new Vector3();

  constructor(
    readonly camera: PerspectiveCamera,
    domElement: HTMLElement,
    options: Partial<OrbitOptions> = {},
  ) {
    this.options = { ...DEFAULT_ORBIT_OPTIONS, ...options };
    const c = new OrbitControls(camera, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = Math.PI * 0.495;
    c.minDistance = this.options.minDistance;
    c.maxDistance = this.options.maxDistance;
    c.enabled = false;
    this.controls = c;
  }

  get enabled(): boolean {
    return this.controls.enabled;
  }

  /** Hands control to the user, orbiting `subject` from the camera's current position. */
  activate(subject: Vector3 | null): void {
    const c = this.controls;
    if (subject) c.target.copy(subject).y += this.options.targetHeight;
    if (Math.abs(this.camera.fov - this.options.fov) > 0.01) {
      this.camera.fov = this.options.fov;
      this.camera.updateProjectionMatrix();
    }
    c.enabled = true;
    c.update();
  }

  deactivate(): void {
    this.controls.enabled = false;
  }

  /** Follows `subject` (null = hold still) and applies damping. */
  update(dt: number, subject: Vector3 | null): void {
    const c = this.controls;
    if (subject) {
      this.goal.copy(subject).y += this.options.targetHeight;
      this.delta.copy(this.goal).sub(c.target).multiplyScalar(1 - Math.exp(-this.options.followLambda * dt));
      c.target.add(this.delta);
      this.camera.position.add(this.delta);
    }
    c.update(dt);
  }

  dispose(): void {
    this.controls.dispose();
  }
}
