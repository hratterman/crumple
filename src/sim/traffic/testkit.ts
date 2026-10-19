/**
 * Test helpers for the traffic sim (tests only; never imported by the
 * worker). One Crumple Valley terrain per test module (generation is the
 * slow part), a WorkerHost with the real groundHeightfield sequence
 * (colliders, vegetation, water, props), the player sedan and traffic.
 */
import { GAME_CAPACITY, type MainToWorker, type WorkerToMain } from '../../protocol/messages';
import type { TrafficBubble } from '../../protocol/traffic';
import { DEFAULT_LAYOUT } from '../../world/layout';
import { generateTerrain, hashTerrain } from '../../world/terrain';
import type { TerrainData } from '../../world/types';
import type { SimEngine } from '../engine';
import { SEDAN } from '../vehicle/defs/sedan';
import { SEDAN_TRAFFIC } from '../vehicle/defs/sedanTraffic';
import { WorkerHost } from '../worker';
import type { TrafficSim } from './traffic';
import { createRoutePose, routePose } from '../../world/routes';

let terrain: TerrainData | null = null;
/** Crumple Valley, generated once per module. */
export function valleyTerrain(): TerrainData {
  terrain ??= generateTerrain(DEFAULT_LAYOUT);
  return terrain;
}

export interface TrafficWorld {
  host: WorkerHost;
  eng: SimEngine;
  out: WorkerToMain[];
  tr: TrafficSim;
}

export interface TrafficWorldOptions {
  agents: number;
  maxAwake: number;
  pool?: number;
  bubble?: TrafficBubble;
  seed?: number;
  /** Player sedan at (x, z, yaw) on the terrain; null = no player (focus missing). */
  player?: readonly [number, number, number] | null;
}

/** Yaw-only quaternion (yaw 0 faces −Z). */
export function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

export function trafficCommand(o: TrafficWorldOptions): Extract<MainToWorker, { type: 'setTraffic' }> {
  return {
    type: 'setTraffic',
    enabled: true,
    seed: o.seed ?? 7,
    variants: [{ catalogId: 'sedanTraffic', vehicle: SEDAN_TRAFFIC, weight: 1, paletteCount: 8 }],
    density: { agents: o.agents, maxAwake: o.maxAwake, awakePoolBeams: o.pool ?? 6500 },
    focusObjectId: 1,
    ...(o.bubble ? { bubble: o.bubble } : {}),
  };
}

/** Builds the full world: init → groundHeightfield → player sedan → setTraffic. Throws if the worker posted an error. */
export function trafficWorld(o: TrafficWorldOptions): TrafficWorld {
  const out: WorkerToMain[] = [];
  // Snapshots are copied and their pooled buffer returned at once (main's role), so the pool never runs dry.
  let hostRef: WorkerHost | null = null;
  const post = (m: WorkerToMain): void => {
    if (m.type === 'snapshot') {
      out.push({ type: 'snapshot', buffer: m.buffer.slice(0) });
      hostRef?.handle({ type: 'returnBuffer', buffer: m.buffer });
    } else out.push(m);
  };
  const host = new WorkerHost(post, { now: () => 0, schedule: () => {} }, { generateTerrain: () => valleyTerrain(), hashTerrain });
  hostRef = host;
  host.handle({ type: 'init', seed: 1, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: GAME_CAPACITY });
  host.handle({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0 });
  const eng = host.engine!;
  if (o.player !== null) {
    const [x, z, yaw] = o.player ?? [0, 0, 0];
    const y = eng.sampler!.heightAt(x, z) + 0.05;
    host.handle({ type: 'spawnVehicle', objectId: 1, vehicle: SEDAN, transform: { pos: [x, y, z], quat: yawQuat(yaw) } });
  }
  host.handle(trafficCommand(o));
  const errors = out.filter((m) => m.type === 'error' || m.type === 'fatal');
  if (errors.length > 0) throw new Error(`trafficWorld: ${JSON.stringify(errors)}`);
  return { host, eng, out, tr: eng.traffic! };
}

/** Steps n ticks, clearing pending events every second (no snapshots written). */
export function run(eng: SimEngine, ticks: number, each?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    eng.step();
    if (each) each(i);
    if ((i & 2047) === 2047) eng.events.clear();
  }
  eng.events.clear();
}

/** FNV-1a over the arena's node positions/velocities (f64 words) and every agent's route state. */
export function stateHash(eng: SimEngine): number {
  let h = 0x811c9dc5;
  const mix = (w: number): void => {
    h = Math.imul(h ^ (w >>> 0), 0x01000193) >>> 0;
  };
  const s = eng.state;
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  const word = (x: number): void => {
    f[0] = x;
    mix(u[0]!);
    mix(u[1]!);
  };
  mix(eng.objects.length);
  for (const o of eng.objects) mix(o.objectId);
  for (let i = 0; i < s.nodeCount; i++) {
    word(s.posX[i]!);
    word(s.posY[i]!);
    word(s.posZ[i]!);
    word(s.velX[i]!);
  }
  const tr = eng.traffic;
  if (tr) {
    for (const a of tr.agents) {
      if (!a.alive) continue;
      mix(a.index);
      mix(a.plan[0]!);
      word(a.s);
      word(a.v);
      mix(a.awake ? 1 : 0);
      mix(a.variant | (a.paint << 8));
    }
  }
  return h >>> 0;
}

/** Puts the player (objectId 1) on `path` at arc s (full repair, at rest, 2 cm above the lane). */
export function placePlayer(eng: SimEngine, path: number, s: number): void {
  const tr = eng.traffic!;
  const pose = routePose(tr.net.paths[path]!, s, createRoutePose());
  eng.reset(1, { pos: [pose.pos[0], pose.pos[1] + 0.02, pose.pos[2]], quat: [pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]] });
}

/** Plan distance between an agent and the player's frame origin. */
export function distToPlayer(eng: SimEngine, a: { pos: readonly number[] }): number {
  const obj = eng.arena.get(1)!;
  const veh = eng.getVehicle(1)!;
  const o = obj.nodeStart + veh.vehicle.frameNodes[0]!;
  return Math.hypot(a.pos[0]! - eng.state.posX[o]!, a.pos[2]! - eng.state.posZ[o]!);
}
