/**
 * Planar reflection for a horizontal water plane y = level (contract:
 * ./types.ts PLANAR REFLECTION). The camera is mirrored about the plane
 * (three's Reflector construction: a proper rotation looking at the
 * mirrored target, so winding stays CCW), the projection gets an OBLIQUE
 * near plane on the water surface (Lengyel) so nothing below the water
 * leaks into the reflection, and only layer 0 is rendered (particles,
 * grass and the water itself live on LAYER_NO_REFLECTION) into a reduced
 * resolution HalfFloat target. Shadow maps are NOT re-rendered for the pass
 * (shadowMap.autoUpdate off), and the sky dome (which lighting.update
 * centres on the main camera) is re-centred on the mirrored camera for the
 * pass so it still encloses it.
 */
import {
  Box3,
  Frustum,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  RGBAFormat,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Object3D, Scene, WebGLRenderer } from 'three';

import { WATER_REFLECTION_LAYER } from './proxy';

export class PlanarReflection {
  readonly camera = new PerspectiveCamera();
  readonly target: WebGLRenderTarget;
  /** World → reflection texture uv (xy/w), valid after render(). */
  readonly textureMatrix = new Matrix4();
  /** Draw calls of the last pass. */
  draws = 0;
  private readonly size = new Vector2();
  private readonly tmp = new Vector3();
  private readonly camPos = new Vector3();
  private readonly lookAt = new Vector3();
  private readonly rot = new Matrix4();
  private readonly plane = new Plane();
  private readonly clip = new Vector4();
  private readonly q = new Vector4();
  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly skyPos = new Vector3();

  constructor() {
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      samples: 0,
    });
    this.target.texture.name = 'crumple.water.reflection';
    this.camera.layers.set(0);
    this.camera.layers.enable(WATER_REFLECTION_LAYER);
  }

  /** True when `box` (a body's AABB at its level) intersects the main camera's frustum. */
  visible(camera: PerspectiveCamera, box: Box3): boolean {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    return this.frustum.intersectsBox(box);
  }

  /**
   * Mirror `camera` about y = level into `this.camera` (+ oblique near plane)
   * and update `textureMatrix`. False when the camera is at or below the plane.
   */
  place(camera: PerspectiveCamera, level: number): boolean {
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (this.camPos.y <= level + 0.02) return false;
    const rc = this.camera;
    // mirrored eye
    rc.position.set(this.camPos.x, 2 * level - this.camPos.y, this.camPos.z);
    // mirrored look target
    this.rot.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rot).add(this.camPos);
    this.lookAt.y = 2 * level - this.lookAt.y;
    rc.up.set(0, 1, 0).applyMatrix4(this.rot);
    rc.up.y = -rc.up.y;
    rc.lookAt(this.lookAt);
    rc.near = camera.near;
    rc.far = camera.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix);

    // texture matrix BEFORE the oblique change (the x/y rows are unaffected anyway)
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    // oblique near plane = the water plane in reflection-camera view space (Lengyel)
    this.plane.setFromNormalAndCoplanarPoint(this.tmp.set(0, 1, 0), this.lookAt.set(0, level, 0));
    this.plane.applyMatrix4(rc.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const e = rc.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + e[8]!) / e[0]!, (Math.sign(this.clip.y) + e[9]!) / e[5]!, -1, (1 + e[10]!) / e[14]!);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    e[2] = this.clip.x;
    e[6] = this.clip.y;
    e[10] = this.clip.z + 1;
    e[14] = this.clip.w;
    rc.projectionMatrixInverse.copy(rc.projectionMatrix).invert();
    return true;
  }

  /**
   * Render the mirrored scene. Returns false (nothing rendered) when the
   * camera is at or below the plane. `hide` = objects replaced by the
   * reflection-only proxy for the pass (terrain chunks, road ribbons).
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    level: number,
    scale: number,
    sky: Object3D | null,
    hide: readonly Object3D[],
  ): boolean {
    if (!this.place(camera, level)) return false;
    const rc = this.camera;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(16, Math.round(this.size.x * scale));
    const h = Math.max(16, Math.round(this.size.y * scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    // render state
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate;
    const prevNeeds = renderer.shadowMap.needsUpdate;
    const prevXr = renderer.xr.enabled;
    const info = renderer.info;
    const callsBefore = info.render.calls;
    if (sky) {
      this.skyPos.copy(sky.position);
      sky.position.copy(rc.position);
      sky.updateMatrixWorld();
    }
    let hidden = 0;
    for (let i = 0; i < hide.length; i++) {
      if (hide[i]!.visible) {
        hide[i]!.visible = false;
        hidden |= 1 << i;
      }
    }
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, rc);
    this.draws = info.autoReset ? info.render.calls : info.render.calls - callsBefore;
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevAuto;
    renderer.shadowMap.needsUpdate = prevNeeds;
    for (let i = 0; i < hide.length; i++) if (hidden & (1 << i)) hide[i]!.visible = true;
    if (sky) {
      sky.position.copy(this.skyPos);
      sky.updateMatrixWorld();
    }
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}
