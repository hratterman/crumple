/**
 * Crash-sound regression on RECORDED event streams (P8 review: "the crash
 * noises are constant while driving"). Fixtures (src/audio/fixtures/*.json.gz)
 * are real per-snapshot streams captured in the browser (every impact / skid
 * / beam break of the snapshot + the player's telemetry and wheel-hub
 * positions): two clean ~15–30 s drives (dirt trail with bumps and off-road
 * excursions; the highway leaving the road onto gravel / grass) and wall hits
 * at 10 and 60 km/h. They are replayed through the real AudioDirector at
 * 60 and 20 fps with the hubs lagging a snapshot (render interpolation):
 *   - the clean drives must produce ZERO crash / glass / debris one-shots and
 *     no body-scrape voice; suspension thumps only on the biggest hits;
 *   - the wall hits must still crash (a tap at 10 km/h, a rolling crumple
 *     with a boom at 60).
 * Fixture format: {radius, slots, frames: [t, tel(slots), hubs xyz×4,
 * events: [0 obj mat x y z J ny] | [2 obj mat x y z slip load] | [1 obj beam x y z]]}
 * (tyre-contact skids subsampled 1:4 to keep the files small).
 */
import { describe, expect, it } from 'vitest';

import { AudioDirector, type DirectorGraph, type OneShotsLike } from './director';
import type { OneShotKind } from './dsp/oneshots';
import type { SurfaceInput } from './dsp/surface';
import type { AudioDeps } from './types';
import type { ImpactEvent, SkidEvent, BeamBreakEvent } from '../protocol/events';

type Ev = number[];
type Frame = [number, number[], number[], Ev[]];
interface Fixture {
  radius: number;
  slots: number[];
  frames: Frame[];
}

async function load(name: string): Promise<Fixture> {
  const fsm = 'node:fs';
  const zm = 'node:zlib';
  const fs = (await import(/* @vite-ignore */ fsm)) as { readFileSync(p: URL): Uint8Array };
  const zlib = (await import(/* @vite-ignore */ zm)) as { gunzipSync(b: Uint8Array): { toString(): string } };
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}.json.gz`, import.meta.url))).toString()) as Fixture;
}

const CRASH_KINDS = new Set<OneShotKind>(['thump', 'tap', 'crunch', 'crumple', 'boom', 'clang', 'snap', 'plastic', 'debris', 'glass', 'glassCrack']);

interface Result {
  shots: Map<string, number>;
  crash: number;
  starts: number;
  grains: number;
  thumps: number;
  scrapeMax: number;
}

function replay(fx: Fixture, fps: number): Result {
  const tel = new Float32Array(32);
  const nodes = new Float32Array(3 * 8);
  const ranges = [{ objectId: 1, nodeOffset: 0, nodeCount: 8 }];
  const cam = new Float32Array(16);
  cam[0] = cam[5] = cam[10] = cam[15] = 1;
  const shots = new Map<string, number>();
  const settings = { volume: 1, engineVolume: 1, effectsVolume: 1, ambienceVolume: 1, muted: false };
  const deps: AudioDeps = {
    sim: { telemetry: (id) => (id === 1 ? tel : null), readTrafficAgents: () => 0, renderTime: () => 0, objectRanges: () => ranges },
    cameraMatrix: () => cam,
    replay: { active: false, playing: false, speed: 1, direction: 1, phase: 'live', on: () => () => {} },
    playerObjectId: 1,
    player: () => PLAYER,
    nodes: () => nodes,
    playerForward: () => false,
    materialAt: () => 0,
    zones: (_x, _z, out) => out.fill(0),
    propKey: () => null,
    settings: () => settings,
    timeScale: () => 1,
    crashCam: () => false,
    playerDamage: () => null,
    hrtf: () => false,
    trafficVoices: () => ({ awake: 0, ghosts: 0 }),
  };
  const oneShots: OneShotsLike = {
    ready: true,
    active: 0,
    capacity: 20,
    played: 0,
    dropped: 0,
    play(kind) {
      shots.set(kind, (shots.get(kind) ?? 0) + 1);
      return true;
    },
    playUi: () => true,
    stopAll() {},
    build() {},
  };
  let thumps = 0;
  let lastThumpCount = 0;
  let scrapeMax = 0;
  const nop = { setPosition() {}, setOrientation() {}, setGain() {} };
  const graph: DirectorGraph = {
    mix: { keepAlive() {}, setLevels() {}, setWorld() {}, duckTo() {}, relaxDuck() {} },
    listener: { pos: new Float64Array([0, 0, 0]), vel: new Float64Array(3), update() {} },
    engine: { setInputs() {}, setProfile() {} },
    exhaust: nop,
    intake: nop,
    tyres: nop,
    surface: {
      setInputs(i: Readonly<SurfaceInput>) {
        if (i.thumpCount !== lastThumpCount) {
          lastThumpCount = i.thumpCount;
          thumps++;
        }
        scrapeMax = Math.max(scrapeMax, i.scrape);
      },
    },
    ambience: { setInputs() {} },
    awake: [],
    ghosts: [],
    oneShots,
  };
  const dir = new AudioDirector(graph, deps);
  const imp: ImpactEvent = { objectId: 0, materialId: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, impulse: 0 };
  const sk: SkidEvent = { objectId: 0, materialId: 0, px: 0, py: 0, pz: 0, slip: 0, load: 0 };
  const bb: BeamBreakEvent = { objectId: 0, beamIndex: 0, px: 0, py: 0, pz: 0 };
  const frames = fx.frames;
  const dt = 1 / fps;
  let k = 0;
  let prevHubs: number[] = frames[0]![2];
  for (let t = frames[0]![0] + dt; k < frames.length; t += dt) {
    let latest: Frame | null = null;
    while (k < frames.length && frames[k]![0] <= t) {
      const f = frames[k]!;
      for (const e of f[3]) {
        if (e[0] === 0) {
          imp.objectId = e[1]!;
          imp.materialId = e[2]!;
          imp.px = e[3]!;
          imp.py = e[4]!;
          imp.pz = e[5]!;
          imp.impulse = e[6]!;
          imp.ny = e[7]!;
          dir.onImpact(imp);
        } else if (e[0] === 2) {
          sk.objectId = e[1]!;
          sk.materialId = e[2]!;
          sk.px = e[3]!;
          sk.py = e[4]!;
          sk.pz = e[5]!;
          sk.slip = e[6]!;
          sk.load = e[7]!;
          dir.onSkid(sk);
        } else {
          bb.objectId = e[1]!;
          bb.beamIndex = e[2]!;
          bb.px = e[3]!;
          bb.py = e[4]!;
          bb.pz = e[5]!;
          dir.onBeamBreak(bb);
        }
      }
      if (latest) prevHubs = latest[2];
      latest = f;
      k++;
    }
    if (latest) {
      fx.slots.forEach((s, i) => (tel[s] = latest![1][i]!));
      // the rendered pose lags: hubs of the snapshot before the latest one
      for (let w = 0; w < 4; w++) for (let a = 0; a < 3; a++) nodes[3 * (2 * w) + a] = nodes[3 * (2 * w + 1) + a] = prevHubs[3 * w + a]!;
    }
    dir.update(dt, t, true);
  }
  let crash = 0;
  for (const [kind, n] of shots) if (CRASH_KINDS.has(kind as OneShotKind)) crash += n;
  return { shots, crash, starts: dir.crashStarts, grains: dir.crashGrains, thumps, scrapeMax };
}

const PLAYER = {
  id: 'sedan',
  drivetrain: { idleRpm: 800, redlineRpm: 6800, revLimitRpm: 7000, torqueCurve: [[0, 300], [3500, 350]] as [number, number][], shiftTimeS: 0.25 },
  hubs: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
  wheelRadius: 0.33,
  length: 4.7,
};

const fmt = (r: Result): string => `crash shots ${r.crash} (${[...r.shots].map(([k, n]) => `${k}×${n}`).join(' ')}), episodes ${r.starts}, grains ${r.grains}, thumps ${r.thumps}, scrape max ${r.scrapeMax.toFixed(2)}`;

describe('crash sounds on recorded event streams', () => {
  for (const name of ['drive-dirt-trail', 'drive-highway']) {
    for (const fps of [60, 20]) {
      it(`${name} @ ${fps} fps: a clean drive fires no crash, glass or debris sound and no body scrape`, async () => {
        const fx = await load(name);
        PLAYER.wheelRadius = fx.radius;
        const r = replay(fx, fps);
        console.log(`[audio] ${name} @ ${fps} fps: ${fmt(r)}`);
        expect(r.crash).toBe(0);
        expect(r.starts).toBe(0);
        expect(r.scrapeMax).toBeLessThan(0.05);
        expect(r.thumps).toBeLessThanOrEqual(4);
      });
    }
  }

  it('a 10 km/h wall tap still knocks; a 60 km/h hit rolls a crumple with a boom', async () => {
    for (const [name, heavy] of [
      ['wall-10kmh', false],
      ['wall-60kmh', true],
    ] as const) {
      const fx = await load(name);
      PLAYER.wheelRadius = fx.radius;
      for (const fps of [60, 20]) {
        const r = replay(fx, fps);
        console.log(`[audio] ${name} @ ${fps} fps: ${fmt(r)}`);
        expect(r.starts).toBeGreaterThanOrEqual(1);
        expect(r.starts).toBeLessThanOrEqual(3);
        expect(r.shots.get('thump') ?? 0).toBeGreaterThanOrEqual(1);
        if (heavy) {
          expect(r.shots.get('crumple') ?? 0).toBeGreaterThanOrEqual(1);
          expect(r.shots.get('boom') ?? 0).toBeGreaterThanOrEqual(1);
          expect(r.shots.get('snap') ?? 0).toBeGreaterThanOrEqual(1);
        } else {
          expect(r.shots.get('boom') ?? 0).toBe(0);
        }
        expect(r.shots.get('glass') ?? 0).toBe(0);
      }
    }
  });
});
