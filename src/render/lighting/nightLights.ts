/**
 * Night lighting manager: gathers every artificial light of the world into
 * the clustered light grid each frame and drives the player's shadowed
 * headlights.
 *
 *  - streetlights: the layout's `lightPole` props — the lamp head is the
 *    centroid of the prop's `lamp_*` nodes, read LIVE from the frame's node
 *    positions, so a knocked pole's light swings with it (and a felled one
 *    goes dark with a flicker);
 *  - floodlights: the stunt park's 'floodlight' masts (head frame as drawn by
 *    render/world/stuntpark.ts);
 *  - extra static lights other units register (R-WORLD buildings, town);
 *  - the player's tail / brake / reverse glow (and the beam itself on the
 *    low preset) and every traffic car's head + tail lamps (unshadowed).
 * `gain` (0 by day … 1 at night, raised under heavy overcast) scales all of
 * them and the lamp-lens emissives (env patch `crumpleLightGain`).
 */
import { Group, Vector3 } from 'three';
import type { Object3D } from 'three';

import type { PropInstance } from '../../sim/props/types';
import type { ResolvedCollider } from '../../world/types';
import type { QualityPreset, WorldFrame } from '../types';
import type { CarPose, HeadlightRig, HeadlightState, LampMounts } from './headlights';
import { createHeadlightRig } from './headlights';
import { createLightGrid, makeGridLight, type GridLight, type LightGrid } from './lightGrid';

/** Streetlight: warm-white LED, irradiance ≈ 0.5 under the head at 8 m. */
export const STREETLIGHT_INTENSITY = 34;
export const STREETLIGHT_RANGE_M = 30;
export const STREETLIGHT_COLOR: readonly [number, number, number] = [1.0, 0.82, 0.6];
export const FLOODLIGHT_INTENSITY = 1500;
export const FLOODLIGHT_RANGE_M = 130;
/** Traffic beams (unshadowed): dimmer and shorter than the player's. */
export const TRAFFIC_BEAM_INTENSITY = 120;

export interface StaticLight {
  pos: readonly [number, number, number];
  /** Unit direction for a spot, or null for a point light. */
  dir: readonly [number, number, number] | null;
  color: readonly [number, number, number];
  intensity: number;
  range: number;
  /** Spot cone (rad): outer / inner half angles. */
  outer?: number;
  inner?: number;
}

/**
 * R-WORLD's light records (`WorldContent.lights`, world/content/types.ts),
 * structurally: intensity in candela, sRGB colour, cone half angle.
 */
export interface WorldLightLike {
  kind: string;
  pos: readonly [number, number, number];
  dir: readonly [number, number, number];
  color: number;
  intensity: number;
  range: number;
  angle: number;
  night: boolean;
  propIndex?: number;
  signal?: { plan: number; leg: number; lamp: string };
}
/** Scene units per candela (night lights; see CONTRACTS "R-GFX": moonlight is compressed ~3000× brighter than real, lamps ~50×). */
export const CANDELA_TO_SCENE = 0.018;

export interface TrafficLamp {
  pos: readonly [number, number, number];
  quat: readonly [number, number, number, number];
  headlights: boolean;
  brake: number;
}

export interface NightLights {
  readonly object: Object3D;
  readonly grid: LightGrid;
  readonly headlights: HeadlightRig;
  /** Lamp heads of the layout's light poles (world, rest pose) — e.g. glow sprites. */
  readonly streetlights: readonly { objectId: number; rest: Vector3 }[];
  setPlayerMounts(m: LampMounts | null): void;
  /** The world's light sources (light-pole props + their lamp rig, floodlight masts); call once the layout resolved. */
  setWorld(deps: NightLightWorld): void;
  /** Registers render-only static lights (R-WORLD buildings / extra streetlights); returns a remover. */
  addStaticLights(lights: readonly StaticLight[]): () => void;
  /**
   * R-WORLD's world lights (street / flood / tunnel / window / sign / beacon /
   * signal); `signalLit(light)` says whether a signal head lamp shows now.
   * 'prop' entries are skipped: the light-pole props are tracked live.
   */
  setWorldLights(lights: readonly WorldLightLike[], signalLit?: (l: WorldLightLike) => boolean): void;
  /**
   * Once per frame after the world layer updated: player pose + lamp state,
   * the traffic lamps of this frame, the darkness gain (0 day … 1 night).
   */
  update(frame: WorldFrame, player: { pose: CarPose | null; state: HeadlightState }, traffic: readonly TrafficLamp[], trafficCount: number, gain: number): void;
  setQuality(q: QualityPreset): void;
  readonly stats: { lights: number; streetlights: number; overflow: number };
  dispose(): void;
}

function rotate(q: readonly number[], v: readonly number[], out: Vector3): Vector3 {
  const [qx, qy, qz, qw] = q as [number, number, number, number];
  const [vx, vy, vz] = v as [number, number, number];
  // v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return out.set(vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx));
}

/** Floodlight head (centre, beam axis) of a 'floodlight' mast collider, as stuntpark.ts draws it. */
export function floodlightHead(c: Pick<ResolvedCollider, 'pos' | 'quat' | 'size'>): { pos: Vector3; dir: Vector3 } {
  const top = new Vector3(c.pos[0], c.pos[1] + c.size[1], c.pos[2]);
  const f = rotate(c.quat, [0, -0.375, -0.927], new Vector3());
  return { pos: new Vector3(top.x + f.x * 0.5, top.y + 0.9, top.z + f.z * 0.5), dir: f.normalize() };
}

export interface NightLightWorld {
  props: readonly PropInstance[];
  /** Lamp node indices (object-local) of the light-pole rig and their rest positions (prop frame). */
  lampRig: { nodes: readonly number[]; rest: readonly [number, number, number][] } | null;
  colliders: readonly ResolvedCollider[];
}

/** Created right after the lighting stack (its spot lights must exist before programs compile); `setWorld` later. */
export function createNightLights(q: QualityPreset): NightLights {
  let deps: NightLightWorld = { props: [], lampRig: null, colliders: [] };
  const object = new Group();
  object.name = 'crumple.nightLights';
  const grid = createLightGrid();
  const headlights = createHeadlightRig(q);
  object.add(headlights.object);

  // ---- streetlights from the layout's light poles, floodlights from the masts (setWorld)
  const poles: { objectId: number; rest: Vector3; seed: number }[] = [];
  const statics: StaticLight[] = [];
  const setWorld = (d: NightLightWorld): void => {
  deps = d;
  poles.length = 0;
  statics.length = 0;
  if (deps.lampRig) {
    const r = deps.lampRig.rest;
    const lc = r.reduce((a, p) => [a[0]! + p[0] / r.length, a[1]! + p[1] / r.length, a[2]! + p[2] / r.length], [0, 0, 0] as number[]);
    for (const p of deps.props) {
      if (p.prop !== 'lightPole') continue;
      const w = rotate(p.transform.quat, lc, new Vector3()).add(new Vector3(...p.transform.pos));
      poles.push({ objectId: p.objectId, rest: w, seed: (p.index * 0.618) % 1 });
    }
  }
  for (const c of deps.colliders) {
    if (c.visual !== 'floodlight') continue;
    const h = floodlightHead(c);
    statics.push({ pos: [h.pos.x, h.pos.y, h.pos.z], dir: [h.dir.x, h.dir.y, h.dir.z], color: [1.0, 0.95, 0.86], intensity: FLOODLIGHT_INTENSITY, range: FLOODLIGHT_RANGE_M, outer: 0.72, inner: 0.35 });
  }
  stats.streetlights = poles.length;
  };
  const extra = new Set<readonly StaticLight[]>();
  // R-WORLD lights: night lights scale with the gain; signals / beacons are always on (when lit)
  const worldNight: StaticLight[] = [];
  const worldAlways: { s: StaticLight; src: WorldLightLike }[] = [];
  let signalLit: ((l: WorldLightLike) => boolean) | null = null;
  const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

  const lights: GridLight[] = [];
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  const tmpN = new Vector3();
  const stats = { lights: 0, streetlights: 0, overflow: 0 };
  let flickerT = 0;

  const pushStatic = (s: StaticLight, gain: number, n: number): number => {
    if (n >= lights.length) lights.push(makeGridLight());
    const g = lights[n]!;
    const I = s.intensity * gain;
    g.x = s.pos[0];
    g.y = s.pos[1];
    g.z = s.pos[2];
    g.range = s.range;
    g.r = s.color[0] * I;
    g.g = s.color[1] * I;
    g.b = s.color[2] * I;
    if (s.dir) {
      g.dx = s.dir[0];
      g.dy = s.dir[1];
      g.dz = s.dir[2];
      g.cosOuter = Math.cos(s.outer ?? 1.1);
      g.cosInner = Math.cos(s.inner ?? 0.6);
    } else {
      g.dx = g.dy = g.dz = 0;
      g.cosOuter = -2;
      g.cosInner = -1;
    }
    return n + 1;
  };

  return {
    object,
    grid,
    headlights,
    streetlights: poles,
    stats,
    setPlayerMounts(m) {
      headlights.setMounts(m);
    },
    setWorld,
    addStaticLights(ls) {
      extra.add(ls);
      return () => extra.delete(ls);
    },
    setWorldLights(ls, lit) {
      worldNight.length = 0;
      worldAlways.length = 0;
      signalLit = lit ?? null;
      for (const l of ls) {
        if (l.kind === 'prop') continue;
        const dl = Math.hypot(l.dir[0], l.dir[1], l.dir[2]);
        const s: StaticLight = {
          pos: [l.pos[0], l.pos[1], l.pos[2]],
          dir: dl > 1e-6 && l.angle > 0 && l.angle < 3 ? [l.dir[0] / dl, l.dir[1] / dl, l.dir[2] / dl] : null,
          color: [srgbToLinear(((l.color >> 16) & 255) / 255), srgbToLinear(((l.color >> 8) & 255) / 255), srgbToLinear((l.color & 255) / 255)],
          intensity: l.intensity * CANDELA_TO_SCENE,
          range: Math.max(1, l.range),
          outer: l.angle,
          inner: l.angle * 0.55,
        };
        if (l.night) worldNight.push(s);
        else worldAlways.push({ s, src: l });
      }
    },
    update(frame, player, traffic, trafficCount, gain) {
      flickerT += frame.dtS;
      headlights.update(player.pose, player.state, gain);
      let n = 0;
      if (gain > 0.01) {
        // streetlights: live lamp heads (a knocked pole's light moves; a felled one dies)
        const objs = frame.objects;
        for (const p of poles) {
          let x = p.rest.x;
          let y = p.rest.y;
          let z = p.rest.z;
          let dn = tmpN.set(0, -1, 0);
          let on = 1;
          if (deps.lampRig && frame.interpolated) {
            const o = objs.find((s) => s.objectId === p.objectId);
            if (o && o.nodeCount > Math.max(...deps.lampRig.nodes)) {
              tmp.set(0, 0, 0);
              for (const k of deps.lampRig.nodes) {
                const i = (o.nodeOffset + k) * 3;
                tmp.x += frame.nodes[i]!;
                tmp.y += frame.nodes[i + 1]!;
                tmp.z += frame.nodes[i + 2]!;
              }
              tmp.multiplyScalar(1 / deps.lampRig.nodes.length);
              if (Number.isFinite(tmp.x + tmp.y + tmp.z)) {
                const drop = p.rest.y - tmp.y;
                // the head's facing from its 4 nodes (lamp_0, _1, _3 span the lens)
                const n0 = deps.lampRig.nodes;
                const a = (o.nodeOffset + n0[0]!) * 3;
                const b = (o.nodeOffset + n0[1]!) * 3;
                const c = (o.nodeOffset + n0[3]!) * 3;
                tmp2.set(frame.nodes[b]! - frame.nodes[a]!, frame.nodes[b + 1]! - frame.nodes[a + 1]!, frame.nodes[b + 2]! - frame.nodes[a + 2]!);
                dn = tmpN.set(frame.nodes[c]! - frame.nodes[a]!, frame.nodes[c + 1]! - frame.nodes[a + 1]!, frame.nodes[c + 2]! - frame.nodes[a + 2]!).cross(tmp2).normalize();
                if (dn.y > 0) dn.negate();
                if (!Number.isFinite(dn.x + dn.y + dn.z)) dn.set(0, -1, 0);
                x = tmp.x;
                y = tmp.y;
                z = tmp.z;
                // a tilted pole flickers, a felled one is dead
                if (drop > 2.5 || dn.y > -0.3) on = 0;
                else if (drop > 0.25 || dn.y > -0.93) on = Math.sin(flickerT * 37 + p.seed * 50) > -0.2 ? 1 : 0.15;
              }
            }
          }
          if (on <= 0) continue;
          // per-pole warm-up stagger as dusk falls
          const g = Math.max(0, Math.min(1, (gain - 0.15 - 0.25 * p.seed) * 4)) * on;
          if (g <= 0) continue;
          n = pushStatic(
            { pos: [x, y - 0.12, z], dir: [dn.x, dn.y, dn.z], color: STREETLIGHT_COLOR, intensity: STREETLIGHT_INTENSITY, range: STREETLIGHT_RANGE_M, outer: 1.22, inner: 0.62 },
            g,
            n,
          );
        }
        for (const s of statics) n = pushStatic(s, gain, n);
        for (const s of worldNight) n = pushStatic(s, gain, n);
        for (const ls of extra) for (const s of ls) n = pushStatic(s, gain, n);
        n = headlights.pushGridLights(lights, n);
        // traffic: beams + tail lamps from the rigid pose (offsets of a mid-size car)
        for (let i = 0; i < trafficCount; i++) {
          const t = traffic[i]!;
          const fwd = rotate(t.quat, [0, 0, -1], tmp2);
          if (t.headlights) {
            for (const sx of [-0.68, 0.68]) {
              const p = rotate(t.quat, [sx, 0.66, -2.25], tmp).add(tmpN.set(t.pos[0], t.pos[1], t.pos[2]));
              n = pushStatic(
                { pos: [p.x, p.y, p.z], dir: [fwd.x, fwd.y - 0.06, fwd.z], color: [0.95, 0.96, 1.0], intensity: TRAFFIC_BEAM_INTENSITY, range: 60, outer: 0.42, inner: 0.14 },
                gain,
                n,
              );
            }
          }
          const tail = (t.headlights ? 0.1 : 0) + t.brake * 0.55;
          if (tail > 0.01) {
            const p = rotate(t.quat, [0, 0.75, 2.6], tmp).add(tmpN.set(t.pos[0], t.pos[1], t.pos[2]));
            n = pushStatic({ pos: [p.x, p.y, p.z], dir: null, color: [1, 0.04, 0.03], intensity: tail * 2, range: 4.5 }, gain, n);
          }
        }
      }
      // signals and beacons shine day and night (their lamps are bright enough to matter only after dusk)
      for (const w of worldAlways) if (!signalLit || !w.src.signal || signalLit(w.src)) n = pushStatic(w.s, Math.max(gain, 0.02), n);
      const cam = frame.camera.position;
      grid.build(lights, n, cam.x, cam.z);
      stats.lights = grid.count;
      stats.overflow = grid.stats.overflow;
    },
    setQuality(nq) {
      headlights.setQuality(nq);
    },
    dispose() {
      grid.dispose();
      headlights.dispose();
    },
  };
}
