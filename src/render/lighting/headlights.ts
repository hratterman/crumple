/**
 * The player's headlights as real light: shadowed spot lights with a beam
 * cookie (low beam: flat cut-off with the kerb-side kick-up; high beam: a
 * long centred hotspot) lighting the road, terrain, props and traffic.
 *
 * Shadowed spots per preset (HEADLIGHT_SHADOWED): low 0 (the beam goes
 * through the light grid instead, unshadowed), medium / high / ultra 1 (one
 * spot between the lamps; ultra at 2048²). The beam pattern is analytic in
 * the env patch (`crumpleBeam`: a cookie texture would cost every lit
 * program a sampler unit) and mirrors `beamPattern` below. The
 * spot count is fixed per preset (a change of NUM_SPOT_LIGHTS recompiles every
 * program): by day the spots keep intensity 0 and skip their shadow pass.
 */
import { Group, Object3D, SpotLight, Vector3 } from 'three';

import type { QualityLevel, QualityPreset } from '../types';
import { slotBox } from '../vehicle/materials';
import type { VehicleVisualDef } from '../vehicle/types';
import { ENV_UNIFORMS } from './envPatch';
import { makeGridLight, type GridLight } from './lightGrid';

/**
 * Shadowed headlight spots per preset. One spot between the lamps carries both beams; more would
 * cost every lit program another shadow sampler (roads / terrain sit at the 16-unit limit).
 */
export const HEADLIGHT_SHADOWED: Readonly<Record<QualityLevel, number>> = { low: 0, medium: 1, high: 1, ultra: 1 };
export const HEADLIGHT_SHADOW_MAP: Readonly<Record<QualityLevel, number>> = { low: 256, medium: 512, high: 1024, ultra: 2048 };
/** Peak beam intensity (scene units: irradiance × m² at the hotspot), low / high beam, per lamp pair. */
export const LOW_BEAM_INTENSITY = 260;
export const HIGH_BEAM_INTENSITY = 700;
export const LOW_BEAM_RANGE_M = 95;
export const HIGH_BEAM_RANGE_M = 200;
/** Spot half angle (the cookie maps the cone's square). */
export const BEAM_HALF_ANGLE = (36 * Math.PI) / 180;
/** Beam axis pitch below the car's forward, rad. */
export const BEAM_PITCH = (0.7 * Math.PI) / 180;
/** Lamp colour (cool-white LED projector), linear. */
export const BEAM_COLOR: readonly [number, number, number] = [0.94, 0.97, 1.0];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Beam pattern in the spot's square (x right, y up, both −1..1 across the
 * cone). Pure: exported for tests. Low beam = right-hand-traffic cut-off.
 */
export function beamPattern(x: number, y: number, high: boolean): number {
  if (high) {
    const core = Math.exp(-((x * x) / 0.09 + ((y - 0.02) * (y - 0.02)) / 0.035));
    const spread = Math.exp(-((x * x) / 0.55 + (y * y) / 0.25));
    return Math.min(1, core * 0.85 + spread * 0.3);
  }
  // cut-off: flat on the left, a 15° kick-up toward the kerb (right)
  const cut = 0.03 + Math.max(0, Math.min(1, (x - 0.02) / 0.12)) * 0.13;
  const below = smooth(cut + 0.02, cut - 0.025, y);
  // hotspot just under the cut-off (reaches ~30 m), a broad fill, and a dim foreground (no glare pool at the bumper)
  const hot = Math.exp(-(((x - 0.06) * (x - 0.06)) / 0.05 + ((y + 0.025) * (y + 0.025)) / 0.004));
  const wide = Math.exp(-((x * x) / 0.45)) * smooth(-0.7, -0.04, y) * Math.exp(-((y + 0.04) * (y + 0.04)) / 0.06);
  const fore = 0.25 * smooth(-1.0, -0.3, y);
  return Math.min(1, below * (hot * 0.85 + wide * 0.45 + fore + 0.02));
}

export interface LampMounts {
  /** Headlamp centres, vehicle frame relative to the frame origin node (x right, y up, z back), left then right. */
  head: [Vector3, Vector3];
  /** Tail lamp centres. */
  tail: [Vector3, Vector3];
}

/**
 * Lamp centres of a visual def relative to the frame-origin node's rest
 * position (`origin`, rig coordinates): the mirrored |x| boxes of the
 * lightHead / lightTail slots, at their outer (front / rear) faces.
 */
export function lampMountsFor(def: VehicleVisualDef, origin: readonly number[]): LampMounts | null {
  const head = slotBox(def, 'lightHead');
  const tail = slotBox(def, 'lightTail');
  if (!head) return null;
  const hx = 0.5 * (head.min.x + head.max.x);
  const hy = 0.5 * (head.min.y + head.max.y) - origin[1]!;
  const hz = head.min.z - origin[2]!;
  const tx = tail ? 0.5 * (tail.min.x + tail.max.x) : hx;
  const ty = tail ? 0.5 * (tail.min.y + tail.max.y) - origin[1]! : hy;
  const tz = tail ? tail.max.z - origin[2]! : hz + 4;
  const ox = origin[0]!;
  return {
    head: [new Vector3(-hx - ox, hy, hz), new Vector3(hx - ox, hy, hz)],
    tail: [new Vector3(-tx - ox, ty, tz), new Vector3(tx - ox, ty, tz)],
  };
}

export interface CarPose {
  position: Vector3;
  forward: Vector3;
  up: Vector3;
}

export interface HeadlightState {
  on: boolean;
  high: boolean;
  /** 0..1 brake lamps. */
  brake: number;
  reverse: boolean;
}

export interface HeadlightRig {
  readonly object: Object3D;
  /** Spot lights (shadowed ones first). */
  readonly spots: readonly SpotLight[];
  setQuality(q: QualityPreset): void;
  setMounts(m: LampMounts | null): void;
  /** `gain` 0..1 = how dark it is (0: no light cost at all by day). */
  update(pose: CarPose | null, state: HeadlightState, gain: number): void;
  /** Cheap grid lights for this car: the beam on presets without a shadowed spot, tail / brake / reverse glow. Returns the new count. */
  pushGridLights(out: GridLight[], n: number): number;
  dispose(): void;
}

const tmpR = new Vector3();
const tmpB = new Vector3();
const tmpP = new Vector3();

function toWorld(pose: CarPose, local: Vector3, out: Vector3): Vector3 {
  tmpR.crossVectors(pose.forward, pose.up).normalize(); // right
  tmpB.copy(pose.forward).negate(); // back (+z local)
  return out.copy(pose.position).addScaledVector(tmpR, local.x).addScaledVector(pose.up, local.y).addScaledVector(tmpB, local.z);
}

export function createHeadlightRig(q: QualityPreset): HeadlightRig {
  const object = new Group();
  object.name = 'crumple.headlights';
  let spots: SpotLight[] = [];
  let mounts: LampMounts | null = null;
  let level: QualityLevel = q.level;
  let lastPose: CarPose | null = null;
  let lastState: HeadlightState = { on: false, high: false, brake: 0, reverse: false };
  let lastGain = 0;
  const lampW: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  const tailW: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  const dir = new Vector3();

  const build = (lv: QualityLevel): void => {
    for (const s of spots) {
      object.remove(s, s.target);
      s.dispose();
    }
    spots = [];
    const n = HEADLIGHT_SHADOWED[lv];
    for (let i = 0; i < n; i++) {
      const s = new SpotLight(0xffffff, 0, LOW_BEAM_RANGE_M, BEAM_HALF_ANGLE, 0.22, 2);
      s.name = `crumple.headlight${i}`;
      s.castShadow = true;
      s.shadow.mapSize.set(HEADLIGHT_SHADOW_MAP[lv], HEADLIGHT_SHADOW_MAP[lv]);
      s.shadow.camera.near = 0.35;
      // the road is lit at a grazing 1–5°: depth bias alone leaves acne bands down the beam; push the
      // receiver along its normal instead (the road never shadows itself; cars, posts and trees still do)
      s.shadow.bias = -0.0015;
      s.shadow.normalBias = 0.22;
      s.shadow.radius = 2;
      s.shadow.autoUpdate = false;
      // render the map once even by day: a shadowed spot whose map was never rendered leaves the
      // shadow sampler unbound-compatible and EVERY lit draw fails (GL "texture format / sampler mismatch")
      s.shadow.needsUpdate = true;
      object.add(s, s.target);
      spots.push(s);
    }
  };
  build(level);

  return {
    object,
    get spots() {
      return spots;
    },
    setQuality(nq: QualityPreset) {
      if (nq.level === level) return;
      level = nq.level;
      build(level);
    },
    setMounts(m) {
      mounts = m;
    },
    update(pose, state, gain) {
      lastPose = pose;
      lastState = state;
      lastGain = gain;
      const live = !!(pose && mounts && state.on && gain > 0.01);
      if (pose && mounts) {
        toWorld(pose, mounts.head[0], lampW[0]);
        toWorld(pose, mounts.head[1], lampW[1]);
        toWorld(pose, mounts.tail[0], tailW[0]);
        toWorld(pose, mounts.tail[1], tailW[1]);
        // beam axis: forward pitched down a little
        dir.copy(pose.forward).addScaledVector(pose.up, -Math.tan(BEAM_PITCH)).normalize();
      }
      const intensity = (state.high ? HIGH_BEAM_INTENSITY : LOW_BEAM_INTENSITY) * gain;
      const range = state.high ? HIGH_BEAM_RANGE_M : LOW_BEAM_RANGE_M;
      spots.forEach((s, i) => {
        if (!live) {
          s.intensity = 0;
          s.shadow.autoUpdate = false;
          return;
        }
        // one spot = both lamps (centre), two = one per lamp
        if (spots.length === 1) tmpP.copy(lampW[0]).add(lampW[1]).multiplyScalar(0.5);
        else tmpP.copy(lampW[i]!);
        // the light sits just ahead of the lens so the car's own nose never shadows it
        s.position.copy(tmpP).addScaledVector(dir, 0.12);
        s.target.position.copy(s.position).addScaledVector(dir, 10);
        s.target.updateMatrixWorld();
        s.intensity = intensity / spots.length;
        s.distance = range;
        s.shadow.camera.far = range;
        s.color.setRGB(BEAM_COLOR[0], BEAM_COLOR[1], BEAM_COLOR[2]);
        s.shadow.autoUpdate = true;
      });
      if (live) {
        ENV_UNIFORMS.crumpleBeamAxis.value.set(dir.x, dir.y, dir.z, Math.tan(BEAM_HALF_ANGLE));
        ENV_UNIFORMS.crumpleBeamUp.value.set(pose!.up.x, pose!.up.y, pose!.up.z, state.high ? 1 : 0);
      }
    },
    pushGridLights(out, n) {
      const pose = lastPose;
      if (!pose || !mounts || lastGain <= 0.01) return n;
      const st = lastState;
      const g = lastGain;
      const add = (p: Partial<GridLight>): void => {
        if (n >= out.length) out.push(makeGridLight());
        Object.assign(out[n]!, makeGridLight(), p);
        n++;
      };
      if (st.on && spots.length === 0) {
        // low preset: the beam as two unshadowed grid spots (no cookie: a soft cone)
        const I = ((st.high ? HIGH_BEAM_INTENSITY : LOW_BEAM_INTENSITY) * g) / 2;
        const range = st.high ? HIGH_BEAM_RANGE_M : LOW_BEAM_RANGE_M;
        for (const p of lampW) {
          add({
            x: p.x + dir.x * 0.12,
            y: p.y + dir.y * 0.12,
            z: p.z + dir.z * 0.12,
            range,
            r: I * BEAM_COLOR[0] * 0.6,
            g: I * BEAM_COLOR[1] * 0.6,
            b: I * BEAM_COLOR[2] * 0.6,
            dx: dir.x,
            dy: dir.y - 0.05,
            dz: dir.z,
            cosOuter: Math.cos(0.42),
            cosInner: Math.cos(0.12),
          });
        }
      }
      // tail lamps: a dim red wash behind the car, much brighter under braking; white for reverse
      const tail = (st.on ? 0.1 : 0) + st.brake * 0.55;
      if (tail > 0.01) {
        for (const p of tailW) {
          add({ x: p.x - pose.forward.x * 0.3, y: p.y, z: p.z - pose.forward.z * 0.3, range: 4.5, r: tail * 1.0 * g, g: tail * 0.04 * g, b: tail * 0.03 * g });
        }
      }
      if (st.reverse) {
        tmpP.copy(tailW[0]).add(tailW[1]).multiplyScalar(0.5).addScaledVector(pose.forward, -0.5);
        add({ x: tmpP.x, y: tmpP.y, z: tmpP.z, range: 9, r: 1.6 * g, g: 1.6 * g, b: 1.7 * g, dx: -pose.forward.x, dy: -0.3, dz: -pose.forward.z, cosOuter: Math.cos(1.1), cosInner: Math.cos(0.4) });
      }
      return n;
    },
    dispose() {
      for (const s of spots) s.dispose();
    },
  };
}
