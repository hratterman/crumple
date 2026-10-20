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
  engine: { rpm: number; load: number; pitch: number; limiter: boolean; crank: boolean; profile: string };
  world: { rate: number; pitch: number; lowpass: number; gain: number };
}
interface G {
  ready: boolean;
  vehicle: { speed: number; damage: number } | null;
  position: [number, number, number] | null;
  place(x: number, z: number, yawDeg?: number): void;
  audio: AudioDebug | null;
  replay: { enter(o?: { time?: number }): Promise<boolean>; exit(): Promise<void>; seek(t: number): void; play(): void; pause(): void; setSpeed(s: number): void; markers(): { time: number; severity: number }[]; state: { phase: string; time: number } };
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
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 1, brake: 0, gearSelect: 1 }));
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
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.exit());
  await page.waitForTimeout(1000);
  a = (await c(page))!;
  expect(a.world.rate).toBe(1);
  expect(a.errors).toEqual([]);
  expect(errors.filter((e) => /audio|worklet/i.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});
