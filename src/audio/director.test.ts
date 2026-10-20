import { describe, expect, it } from 'vitest';

import { AudioDirector, type DirectorGraph, type GhostVoiceLike, type OneShotsLike, type SpatialLike } from './director';
import type { AmbienceInput } from './dsp/ambience';
import type { EngineInput } from './dsp/engine';
import type { OneShotKind } from './dsp/oneshots';
import type { SurfaceInput } from './dsp/surface';
import type { MixLevels } from './mix';
import { slowMoPitch } from './params';
import type { AudioDeps, AudioPlayerInfo } from './types';
import { createTrafficAgentFrame, TRAFFIC_FLAG_AWAKE, type TrafficAgentFrame } from '../protocol/traffic';
import type { ImpactEvent } from '../protocol/events';

class FakeSpatial implements SpatialLike {
  x = 0;
  y = 0;
  z = 0;
  gain = 0;
  setPosition(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  setOrientation(): void {}
  setGain(g: number): void {
    this.gain = g;
  }
}
class FakeEngine {
  last: EngineInput | null = null;
  rpm = 0;
  gate = 0;
  load = 0;
  pitch = 1;
  limiter = 0;
  crank = 0;
  shift = 0;
  profile = '';
  setInputs(i: Readonly<EngineInput>): void {
    this.rpm = i.rpm;
    this.gate = i.gate;
    this.load = i.load;
    this.pitch = i.pitch;
    this.limiter = i.limiter;
    this.crank = i.crank;
    this.shift = i.shift;
  }
  setProfile(p: { id: string }): void {
    this.profile = p.id;
  }
}
class FakeShots implements OneShotsLike {
  readonly calls: OneShotKind[] = [];
  ready = true;
  active = 0;
  capacity = 16;
  played = 0;
  dropped = 0;
  record = true;
  play(kind: OneShotKind): boolean {
    if (this.record) this.calls.push(kind);
    this.played++;
    return true;
  }
  playUi(kind: OneShotKind): boolean {
    if (this.record) this.calls.push(kind);
    return true;
  }
  stopAll(): void {}
  build(): void {}
}
class FakeGhost implements GhostVoiceLike {
  readonly spatial = new FakeSpatial();
  pitch = 0;
  level = 0;
  set(_speed: number, _hz: number, level: number, pitch: number): void {
    this.level = level;
    this.pitch = pitch;
  }
}

const SETTINGS = { volume: 0.8, engineVolume: 1, effectsVolume: 1, ambienceVolume: 1, muted: false };
const VOICES = { awake: 2, ghosts: 2 };

function setup() {
  const tel = new Float32Array(32);
  const agents: { agent: number; objectId: number; awake: boolean; pos: [number, number, number]; speed: number; yawFwd: [number, number] }[] = [];
  const replay = { active: false, playing: false, speed: 1 as 0.125 | 0.25 | 0.5 | 1 | 2, direction: 1 as 1 | -1, phase: 'live' as const, on: () => () => {} };
  const state = { timeScale: 1, mat: 0 };
  const cam = new Float32Array(16);
  cam[0] = cam[5] = cam[10] = cam[15] = 1;
  // camera 6 m behind (+z) the car at the origin, looking −z
  cam[14] = 6;
  cam[13] = 1.5;
  const player: AudioPlayerInfo = {
    id: 'coupe',
    drivetrain: { idleRpm: 750, redlineRpm: 7000, revLimitRpm: 7300, torqueCurve: [[0, 200], [3000, 520]], shiftTimeS: 0.1 },
    hubs: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
    wheelRadius: 0.33,
    length: 4.4,
  };
  // 8 hub nodes: wheels at (±0.8, 0.33, ±1.3)
  const nodes = new Float32Array(3 * 8);
  const hubXZ = [
    [-0.8, -1.3],
    [0.8, -1.3],
    [-0.8, 1.3],
    [0.8, 1.3],
  ];
  hubXZ.forEach(([x, z], w) => {
    for (let k = 0; k < 2; k++) {
      nodes[3 * (2 * w + k)] = x! + (k ? 0.1 : -0.1);
      nodes[3 * (2 * w + k) + 1] = 0.33;
      nodes[3 * (2 * w + k) + 2] = z!;
    }
  });
  const ranges = [{ objectId: 1, nodeOffset: 0, nodeCount: 8 }];
  const deps: AudioDeps = {
    sim: {
      telemetry: (id) => (id === 1 || id === 100 ? tel : null),
      readTrafficAgents: (_t: number, out: TrafficAgentFrame[]) => {
        while (out.length < agents.length) out.push(createTrafficAgentFrame());
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i]!;
          const o = out[i]!;
          o.agent = a.agent;
          o.objectId = a.objectId;
          o.flags = a.awake ? TRAFFIC_FLAG_AWAKE : 0;
          o.pos[0] = a.pos[0];
          o.pos[1] = a.pos[1];
          o.pos[2] = a.pos[2];
          // yaw-only quat facing (fx, fz)
          const yaw = Math.atan2(-a.yawFwd[0], -a.yawFwd[1]);
          o.quat[0] = 0;
          o.quat[1] = Math.sin(yaw / 2);
          o.quat[2] = 0;
          o.quat[3] = Math.cos(yaw / 2);
          o.speed = a.speed;
        }
        return agents.length;
      },
      renderTime: () => 0,
      objectRanges: () => ranges,
    },
    cameraMatrix: () => cam,
    replay,
    playerObjectId: 1,
    player: () => player,
    nodes: () => nodes,
    playerForward: (out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = -1;
      return true;
    },
    materialAt: () => state.mat,
    zones: (_x, _z, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 10;
    },
    propKey: (id) => (id === 4100 ? 'barrel' : null),
    settings: () => SETTINGS,
    timeScale: () => state.timeScale,
    crashCam: () => false,
    playerDamage: () => null,
    hrtf: () => true,
    trafficVoices: () => VOICES,
  };
  const mix = {
    world: 1,
    lp: 20000,
    ducks: 0,
    master: 0,
    keepAlive(): void {},
    setLevels(l: Readonly<MixLevels>): void {
      this.master = l.master;
    },
    setWorld(g: number, lp: number): void {
      this.world = g;
      this.lp = lp;
    },
    duckTo(): void {
      this.ducks++;
    },
    relaxDuck(): void {},
  };
  const listenerPos = new Float64Array(3);
  const listenerVel = new Float64Array(3);
  const surface = { last: null as SurfaceInput | null, squealR: 0, thumps: 0, scrape: 0, wind: 0, setInputs(i: Readonly<SurfaceInput>) {
    this.squealR = i.squealR;
    this.thumps = i.thumpCount;
    this.scrape = i.scrape;
    this.wind = i.wind;
  } };
  const ambience = { birds: 0, setInputs(i: Readonly<AmbienceInput>) {
    this.birds = i.birds;
  } };
  const shots = new FakeShots();
  const awake = [0, 1].map(() => ({ spatial: new FakeSpatial(), engine: new FakeEngine() }));
  const ghosts = [new FakeGhost(), new FakeGhost()];
  const graph: DirectorGraph = {
    mix,
    listener: {
      pos: listenerPos,
      vel: listenerVel,
      update(m: ArrayLike<number>) {
        listenerPos[0] = m[12]!;
        listenerPos[1] = m[13]!;
        listenerPos[2] = m[14]!;
      },
    },
    engine: new FakeEngine(),
    exhaust: new FakeSpatial(),
    intake: new FakeSpatial(),
    surface,
    tyres: new FakeSpatial(),
    ambience,
    awake,
    ghosts,
    oneShots: shots,
  };
  const dir = new AudioDirector(graph, deps);
  return { dir, tel, agents, replay, state, graph, mix, shots, surface, ambience, awake, ghosts, engine: graph.engine as FakeEngine };
}

function impact(objectId: number, x: number, y: number, z: number, impulse: number): ImpactEvent {
  return { objectId, materialId: 5, px: x, py: y, pz: z, nx: 0, ny: 0, nz: 1, impulse };
}

describe('AudioDirector', () => {
  it('drives the player engine from telemetry: profile, starter, idle, limiter, shift dip', () => {
    const s = setup();
    s.tel[1] = 750;
    s.tel[2] = 1;
    s.tel[31] = 15;
    s.dir.update(1 / 60, 0, true);
    expect(s.engine.profile).toBe('coupe');
    // a parked car with the sound coming on: the starter cranks first
    expect(s.engine.crank).toBe(1);
    for (let i = 0; i < 120; i++) s.dir.update(1 / 60, i / 60, true);
    expect(s.engine.crank).toBe(0);
    expect(s.engine.gate).toBe(1);
    expect(s.engine.rpm).toBeCloseTo(750, 0);
    // full throttle on the limiter
    s.tel[1] = 7300;
    s.tel[3] = 1;
    s.tel[22] = 400;
    s.dir.update(1 / 60, 3, true);
    expect(s.engine.limiter).toBe(1);
    expect(s.engine.load).toBeGreaterThan(0.8);
    // upshift: load dips for the shift time
    s.tel[1] = 5000;
    s.tel[2] = 2;
    s.dir.update(1 / 60, 3.1, true);
    expect(s.engine.shift).toBe(1);
    expect(s.engine.load).toBeLessThan(0.3);
    for (let i = 0; i < 12; i++) s.dir.update(1 / 60, 3.2 + i / 60, true);
    expect(s.engine.shift).toBe(0);
  });

  it('slow-mo pitches every voice by rate^3/4 and closes the low-pass; pause silences the world', () => {
    const s = setup();
    s.tel[1] = 3000;
    s.state.timeScale = 0.25;
    s.dir.update(1 / 60, 0, true);
    expect(s.engine.pitch).toBeCloseTo(slowMoPitch(0.25), 3);
    expect(s.mix.lp).toBeLessThan(3000);
    expect(s.mix.world).toBe(1);
    s.state.timeScale = 0;
    s.dir.update(1 / 60, 0.1, true);
    expect(s.mix.world).toBe(0);
    // replay: follows the playhead, paused = silent
    s.state.timeScale = 0;
    s.replay.active = true;
    s.replay.playing = true;
    s.replay.speed = 0.5;
    s.dir.update(1 / 60, 0.2, true);
    expect(s.mix.world).toBe(1);
    expect(s.engine.pitch).toBeCloseTo(slowMoPitch(0.5), 3);
    s.replay.playing = false;
    s.dir.update(1 / 60, 0.3, true);
    expect(s.mix.world).toBe(0);
  });

  it('a heavy body hit layers boom + thump + crunch and ducks; tyre contacts and paused frames fire nothing', () => {
    const s = setup();
    s.tel[1] = 2000;
    s.dir.update(1 / 60, 0, true);
    // tyre contacts (at a hub) are not crashes
    for (let i = 0; i < 50; i++) s.dir.onImpact(impact(1, -0.8, 0.1, -1.3, 40));
    s.dir.update(1 / 60, 0.02, true);
    expect(s.shots.calls.filter((k) => k !== 'whoosh')).toEqual([]);
    // the front of the car into a wall
    for (let i = 0; i < 60; i++) s.dir.onImpact(impact(1, 0, 0.5, -2.2, 40));
    s.dir.update(1 / 60, 0.04, true);
    expect(s.shots.calls).toContain('boom');
    expect(s.shots.calls).toContain('crunch');
    expect(s.shots.calls).toContain('thump');
    expect(s.mix.ducks).toBe(1);
    // a barrel clangs
    s.shots.calls.length = 0;
    s.dir.onImpact(impact(4100, 3, 0.5, -3, 120));
    s.dir.update(1 / 60, 0.06, true);
    expect(s.shots.calls).toEqual(['clang']);
    // paused: events are dropped
    s.shots.calls.length = 0;
    s.state.timeScale = 0;
    s.dir.update(1 / 60, 0.08, true);
    s.dir.onImpact(impact(1, 0, 0.5, -2.2, 3000));
    s.dir.update(1 / 60, 0.1, true);
    expect(s.shots.calls).toEqual([]);
  });

  it('squeal from slip on asphalt, none on grass; landing thump; body scrape from non-tyre skids', () => {
    const s = setup();
    s.tel[0] = 20;
    s.tel[31] = 15;
    s.tel[10] = 6;
    s.tel[11] = 6;
    s.tel[14] = 4000;
    s.tel[15] = 4000;
    s.dir.update(1 / 60, 0, true);
    expect(s.surface.squealR).toBeGreaterThan(0.8);
    s.state.mat = 1;
    s.dir.update(1 / 60, 0.02, true);
    expect(s.surface.squealR).toBe(0);
    // landing: wheel loads jump
    for (let i = 0; i < 20; i++) s.dir.update(1 / 60, 0.03 + i / 600, true);
    const before = s.surface.thumps;
    s.tel[12] = s.tel[13] = 14000;
    s.dir.update(1 / 60, 0.04, true);
    expect(s.surface.thumps).toBe(before + 1);
    s.dir.onSkid({ objectId: 1, materialId: 5, px: 0, py: 0.3, pz: -2.2, slip: 8, load: 9000 });
    s.dir.update(1 / 60, 0.06, true);
    expect(s.surface.scrape).toBeGreaterThan(0.5);
    expect(s.surface.wind).toBeGreaterThanOrEqual(0);
  });

  it('traffic: nearest awake cars get engine voices, nearest ghosts pass-by voices, Doppler raises an approaching car', () => {
    const s = setup();
    s.agents.push({ agent: 0, objectId: 100, awake: true, pos: [0, 0, -30], speed: 15, yawFwd: [0, -1] });
    s.agents.push({ agent: 1, objectId: 0, awake: false, pos: [-60, 0, 6], speed: 30, yawFwd: [1, 0] }); // approaching the camera
    s.agents.push({ agent: 2, objectId: 0, awake: false, pos: [500, 0, 6], speed: 30, yawFwd: [1, 0] }); // too far
    for (let i = 0; i < 30; i++) s.dir.update(1 / 60, i / 60, true);
    expect(s.awake[0]!.engine.gate).toBe(1);
    expect(s.awake[0]!.spatial.z).toBeCloseTo(-30, 3);
    expect(s.awake[1]!.engine.gate).toBe(0);
    const g = s.ghosts.find((v) => v.spatial.x === -60)!;
    expect(g).toBeDefined();
    expect(g.pitch).toBeGreaterThan(1.05);
    expect(s.ghosts.filter((v) => v.spatial.x === 500)).toHaveLength(0);
  });

  it('runs with zero steady-state allocation', async () => {
    const s = setup();
    s.shots.record = false;
    s.agents.push({ agent: 0, objectId: 100, awake: true, pos: [0, 0, -30], speed: 15, yawFwd: [0, -1] });
    s.agents.push({ agent: 1, objectId: 0, awake: false, pos: [-60, 0, 6], speed: 30, yawFwd: [1, 0] });
    s.tel[0] = 20;
    s.tel[1] = 4000;
    s.tel[3] = 0.6;
    s.tel[31] = 15;
    s.tel[10] = 3;
    s.tel[14] = 3500;
    const ev = impact(1, 0, 0.5, -2.2, 3);
    for (let i = 0; i < 3000; i++) {
      s.dir.onImpact(ev);
      s.dir.update(1 / 60, i / 60, true);
    }
    const perfHooks = 'node:perf_hooks';
    type Obs = { observe(o: { entryTypes: string[] }): void; disconnect(): void };
    const { PerformanceObserver } = (await import(/* @vite-ignore */ perfHooks)) as {
      PerformanceObserver: new (cb: (list: { getEntries(): unknown[] }) => void) => Obs;
    };
    const v8m = 'node:v8';
    const vmm = 'node:vm';
    const v8 = (await import(/* @vite-ignore */ v8m)) as { setFlagsFromString(f: string): void };
    const vm = (await import(/* @vite-ignore */ vmm)) as { runInNewContext(code: string): unknown };
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    gc();
    let scavenges = 0;
    const obs = new PerformanceObserver((list) => {
      scavenges += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    await new Promise((r) => setTimeout(r, 20));
    scavenges = 0;
    const t0 = performance.now();
    const N = 30000;
    for (let i = 0; i < N; i++) {
      s.tel[1] = 3000 + (i % 100) * 10;
      s.dir.onImpact(ev);
      s.dir.update(1 / 60, 50 + i / 60, true);
    }
    const ms = (performance.now() - t0) / N;
    await new Promise((r) => setTimeout(r, 20));
    obs.disconnect();
    console.log(`[audio] director update: ${(ms * 1000).toFixed(1)} µs/frame (fakes), ${scavenges} GC events over ${N} frames`);
    expect(scavenges).toBe(0);
  }, 60_000);
});
