import { expect, test, type Page } from '@playwright/test';

/**
 * P8 audio: the synthesized sound system boots (lazy chunk + AudioWorklet),
 * resumes on the first user gesture, runs its voices while driving, fires
 * crash one-shots on a wall hit, follows the replay (1/4× = pitch 0.25^¾,
 * paused = silent world) and never throws. Headless audio output may be a
 * null sink: the assertions are on the AudioContext / voice state.
 */
interface AudioDebug {
  state: string;
  worklet: boolean;
  sampleRate: number;
  voices: { engine: number; traffic: number; ghosts: number; oneShots: number; oneShotCap: number };
  oneShotsPlayed: number;
  bankReady: boolean;
  updateMs: number;
  updateMsMax: number;
  frames: number;
  errors: string[];
  lastCrash: { gain: number; kind: string } | null;
  engine: { rpm: number; load: number; pitch: number; limiter: boolean; crank: boolean; horn: boolean; profile: string };
  world: { rate: number; pitch: number; lowpass: number; gain: number };
}
interface G {
  ready: boolean;
  vehicle: { speed: number; damage: number } | null;
  position: [number, number, number] | null;
  place(x: number, z: number, yawDeg?: number): void;
  audio: AudioDebug | null;
  replay: { enter(o?: { time?: number }): Promise<boolean>; exit(): Promise<void>; seek(t: number): void; play(): void; pause(): void; setSpeed(s: number): void; markers(): { time: number; severity: number }[]; state: { phase: string; time: number; end: number } };
  debug: { client: { despawn(id: number): void; input(id: number, a: Record<string, number>): void } };
}
const c = (page: Page) => page.evaluate(() => {
  const a = (window as unknown as { __crumple: G }).__crumple.audio;
  return a ? JSON.parse(JSON.stringify({ ...a, voices: a.voices, engine: a.engine, world: a.world, lastCrash: a.lastCrash, errors: a.errors })) as AudioDebug : null;
});

test('audio: boots, resumes on a gesture, voices run, a crash fires one-shots, replay pitch follows, no errors', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/crumple/?q=low&spawn=arena&traffic=0&crashcam=0');
  await page.waitForFunction(() => {
    const g = (window as unknown as { __crumple?: G }).__crumple;
    return !!g && g.ready && g.vehicle !== null && g.audio !== null;
  }, null, { timeout: 150_000 });

  // a user gesture resumes the context (autoplay policy)
  await page.mouse.click(320, 180);
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.state === 'running', null, { timeout: 20_000 });
  let a = (await c(page))!;
  console.log(`[e2e] audio: worklet ${a.worklet}, ${a.sampleRate} Hz, profile ${a.engine.profile}`);
  expect(a.worklet).toBe(true);
  expect(a.engine.profile).toBe('sedan');
  expect(a.voices.oneShotCap).toBeGreaterThan(0);

  // drive at the crash wall (z ≈ 265.6) from the north run-up
  await page.evaluate(() => {
    const g = (window as unknown as { __crumple: G }).__crumple;
    g.debug.client.despawn(2);
    g.place(360, 330, 0);
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 1, brake: 0, handbrake: 0, gearSelect: 1 }));
  let rpmMax = 0;
  for (let i = 0; i < 400; i++) {
    await page.waitForTimeout(100);
    a = (await c(page))!;
    rpmMax = Math.max(rpmMax, a.engine.rpm);
    const v = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.vehicle);
    if (v && v.damage > 0.03) break;
  }
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 0 }));
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.lastCrash !== null, null, { timeout: 30_000 });
  a = (await c(page))!;
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.bankReady, null, { timeout: 30_000 });
  console.log(`[e2e] audio after crash: rpm max ${rpmMax.toFixed(0)}, played ${a.oneShotsPlayed}, last ${JSON.stringify(a.lastCrash)}, bank ${a.bankReady}, update ${a.updateMs.toFixed(3)} ms (max ${a.updateMsMax.toFixed(3)})`);
  expect(rpmMax).toBeGreaterThan(2500);
  expect(a.oneShotsPlayed).toBeGreaterThan(0);
  expect(a.lastCrash!.gain).toBeGreaterThan(0.3);
  expect(a.frames).toBeGreaterThan(10);

  // horn (H): the worker flags it, the audio sounds it
  await page.keyboard.down('KeyH');
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.engine.horn, null, { timeout: 20_000 });
  await page.keyboard.up('KeyH');
  await page.waitForFunction(() => !(window as unknown as { __crumple: G }).__crumple.audio!.engine.horn, null, { timeout: 20_000 });
  // a honk recorded at full rate (render loop held: main records every snapshot, as in replay.spec)
  const hornAt = await page.evaluate(async () => {
    const g = (window as unknown as { __crumple: G & { hold: boolean } }).__crumple;
    g.hold = true;
    await new Promise((r) => setTimeout(r, 400));
    g.debug.client.input(1, { horn: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    g.debug.client.input(1, { horn: 0 });
    await new Promise((r) => setTimeout(r, 600));
    g.hold = false;
    return g.replay.state.end - 1.4;
  });

  // replay: 1/4× → pitch 0.25^0.75, paused → world silent
  const entered = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.enter());
  expect(entered).toBe(true);
  await page.evaluate(() => {
    const r = (window as unknown as { __crumple: G }).__crumple.replay;
    r.seek(r.state.time - 1.5);
    r.setSpeed(0.25);
    r.play();
  });
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.world.rate === 0.25, null, { timeout: 20_000 });
  a = (await c(page))!;
  expect(a.world.pitch).toBeCloseTo(Math.pow(0.25, 0.75), 2);
  expect(a.world.gain).toBe(1);
  expect(a.world.lowpass).toBeLessThan(3000);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.pause());
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.world.gain === 0, null, { timeout: 20_000 });
  // the recorded horn plays back: seek into the honk, play
  await page.evaluate((t) => {
    const r = (window as unknown as { __crumple: G }).__crumple.replay;
    r.seek(t);
  }, hornAt);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.play());
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.audio!.engine.horn, null, { timeout: 20_000 });
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.exit());
  await page.waitForTimeout(1000);
  a = (await c(page))!;
  expect(a.world.rate).toBe(1);
  expect(a.errors).toEqual([]);
  expect(errors.filter((e) => /audio|worklet/i.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});

/**
 * Main-thread cost of the real audio system (worklet voices, HRTF player car,
 * traffic voices, Doppler) without the game's rendering: fake sim deps with
 * live-changing telemetry, one update per animation frame for 15 s.
 */
test('audio bench: main-thread update cost per frame', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto('/crumple/src/audio/types.ts');
  await page.mouse.click(10, 10);
  const r = await page.evaluate(async () => {
    const m = await import('/crumple/src/audio/index.ts' as string);
    const tel = new Float32Array(32);
    const cam = new Float32Array(16); cam[0] = cam[5] = cam[10] = cam[15] = 1;
    const nodes = new Float32Array(3 * 400);
    const agentsSrc = Array.from({ length: 20 }, (_, i) => ({ awake: i < 4, x: -100 + i * 12, z: (i % 3) * 8 - 20 }));
    const settings = { volume: 0.8, engineVolume: 1, effectsVolume: 1, ambienceVolume: 1, muted: false };
    const voices = { awake: 4, ghosts: 4 };
    const ranges = [{ objectId: 1, nodeOffset: 0, nodeCount: 300 }];
    const player = { id: 'coupe', drivetrain: { idleRpm: 750, redlineRpm: 7000, revLimitRpm: 7300, torqueCurve: [[0, 200], [3000, 520]], shiftTimeS: 0.1 }, hubs: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]), wheelRadius: 0.33, length: 4.4 };
    let t = 0;
    const sys = await m.createAudioSystem({
      sim: {
        telemetry: (id: number) => (id === 1 || (id >= 100 && id < 104) ? tel : null),
        readTrafficAgents: (_t: number, out: any[]) => {
          for (let i = 0; i < agentsSrc.length; i++) {
            if (!out[i]) out.push({ agent: 0, objectId: 0, flags: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], speed: 0 });
            const a = agentsSrc[i]!, o = out[i];
            o.agent = i; o.objectId = a.awake ? 100 + i : 0; o.flags = a.awake ? 1 : 0;
            o.pos[0] = a.x + t * 20; o.pos[1] = 0; o.pos[2] = a.z; o.speed = 20;
          }
          return agentsSrc.length;
        },
        renderTime: () => t,
        objectRanges: () => ranges,
      },
      cameraMatrix: () => cam,
      replay: { active: false, playing: false, speed: 1, direction: 1, phase: 'live', on: () => () => {} },
      playerObjectId: 1,
      player: () => player,
      nodes: () => nodes,
      playerForward: (o: Float64Array) => { o[0] = 0; o[1] = 0; o[2] = -1; return true; },
      materialAt: () => 0,
      layoutZones: [],
      heightAt: () => 10,
      propKey: () => null,
      settings: () => settings,
      timeScale: () => 1,
      crashCam: () => false,
      playerDamage: () => null,
      hrtf: () => true,
      trafficVoices: () => voices,
    });
    await sys.debug.resume();
    const times: number[] = [];
    for (let f = 0; f < 900; f++) {
      await new Promise((r) => requestAnimationFrame(r));
      t += 1 / 60;
      // a car accelerating through the gears, sliding a little, the camera following
      const rpm = 1500 + ((f * 23) % 5500);
      tel[0] = 10 + f * 0.03; tel[1] = rpm; tel[2] = 1 + Math.floor(f / 200); tel[3] = 0.8; tel[22] = 400;
      tel[8] = tel[9] = 0.5; tel[10] = tel[11] = 2 + Math.sin(f / 30) * 2; tel[12] = tel[13] = tel[14] = tel[15] = 3500 + Math.sin(f / 7) * 300;
      tel[16] = f * 0.4; tel[17] = 0.5; tel[18] = 0; tel[19] = 24; tel[31] = 15;
      cam[12] = f * 0.4 + 6; cam[13] = 1.6; cam[14] = 1 + Math.sin(f / 50);
      const t0 = performance.now();
      sys.update(1 / 60);
      times.push(performance.now() - t0);
    }
    const s = times.slice(120).sort((a, b) => a - b);
    return { median: s[s.length >> 1]!, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]!, mean: s.reduce((a, b) => a + b, 0) / s.length, state: sys.debug.state, worklet: sys.debug.worklet, voices: sys.debug.voices, errors: sys.debug.errors };
  });
  console.log(`[e2e] audio update: mean ${r.mean.toFixed(3)} ms, median ${r.median.toFixed(2)}, p95 ${r.p95.toFixed(2)}, max ${r.max.toFixed(2)} (timer resolution 0.1 ms); voices ${JSON.stringify(r.voices)}`);
  expect(r.state).toBe('running');
  expect(r.errors).toEqual([]);
  // budget 0.3 ms per frame (lenient bound for loaded CI boxes)
  expect(r.mean).toBeLessThan(0.6);
});
