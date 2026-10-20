/**
 * Camera director: owns the active camera rig and cycles between them (C).
 * P2 rigs: chase (default) and orbit. Later phases add hood/free/crash.
 */
import type { PerspectiveCamera } from 'three';
import { ChaseCamera, type ChaseOptions, type ChaseTarget } from './chase';
import { OrbitCamera, type OrbitOptions } from './orbit';

export type CameraMode = 'chase' | 'orbit';
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'orbit'];

export interface CameraDirectorOptions {
  initial?: CameraMode;
  chase?: Partial<ChaseOptions>;
  orbit?: Partial<OrbitOptions>;
}

export class CameraDirector {
  readonly chase: ChaseCamera;
  readonly orbit: OrbitCamera;
  private _mode: CameraMode;
  /** Set on a switch; the next update with a target hands over smoothly (boot snaps instead). */
  private pendingSwitch = false;

  constructor(
    readonly camera: PerspectiveCamera,
    domElement: HTMLElement,
    opts: CameraDirectorOptions = {},
  ) {
    this.chase = new ChaseCamera(camera, opts.chase);
    this.orbit = new OrbitCamera(camera, domElement, opts.orbit);
    this._mode = opts.initial ?? 'chase';
  }

  get mode(): CameraMode {
    return this._mode;
  }

  setMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.pendingSwitch = true;
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this._mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]!);
    return this._mode;
  }

  /** Snap the chase camera behind the subject on the next update (after respawn). */
  snap(): void {
    this.chase.reset();
  }

  /** P7: another rig moved the camera (replay): the next update continues smoothly from where it is. */
  handOver(): void {
    this.pendingSwitch = true;
    if (this.orbit.enabled) this.orbit.deactivate();
  }

  /** `target` null = subject not visible yet (cameras hold still). */
  update(dt: number, target: ChaseTarget | null): void {
    if (this._mode === 'chase') {
      if (this.orbit.enabled) this.orbit.deactivate();
      if (!target) return;
      if (this.pendingSwitch) {
        this.chase.takeOver(target);
        this.pendingSwitch = false;
      }
      this.chase.update(dt, target);
    } else {
      if (this.pendingSwitch || !this.orbit.enabled) {
        this.orbit.activate(target ? target.position : null);
        this.pendingSwitch = false;
      }
      this.orbit.update(dt, target ? target.position : null);
    }
  }

  dispose(): void {
    this.orbit.dispose();
  }
}
