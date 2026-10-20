import { expect, test, type Page } from '@playwright/test';

/**
 * P7 replay core (acceptance: "a 100 km/h wall hit … and the replay scrubs
 * in slow-mo"): drive the sedan from the arena spawn into the crash wall at
 * speed, enter the replay, seek to the impact marker, play at 1/4×, check the
 * crushed car and the FX are there (screenshots), scrub back to before the
 * crash (pristine), exit, and confirm the live run resumes from the
 * identical worker state hash.
 */
interface Marker {
  time: number;
  severity: number;
  objectId: number;
  kind: string;
  pos: [number, number, number];
}
interface ReplayApi {
  state: { phase: string; time: number; start: number; end: number; duration: number; playing: boolean; frames: number; speed: number };
  enter(o?: { time?: number }): Promise<boolean>;
  exit(): Promise<void>;
  seek(t: number, settle?: boolean): void;
  play(): void;
  pause(): void;
  setSpeed(s: number): void;
  step(n: number): void;
  markers(): Marker[];
  stats: { bytes: number; seconds: number; frames: number; recordMs: number; recordMsMax: number; lastSeekMs: number; lastSettleMs: number; decodeMs: number; bytesPerFrame: number };
  stateHash(): Promise<{ tick: number; hash: number }>;
  pauseHash: { tick: number; hash: number } | null;
  resumeHash: { tick: number; hash: number } | null;
  exportFile(): Promise<{ build: string; inputs: { count: number }; commands: unknown[]; vehicles: { paint: string | null }[] }>;
}
interface G {
  ready: boolean;
  tick: number;
  hold: boolean;
  renderOnce(settle?: number): void;
  vehicle: { speed: number; damage: number } | null;
  position: [number, number, number] | null;
  place(x: number, z: number, yawDeg?: number): void;
  pinCamera(pos: [number, number, number] | null, target?: [number, number, number]): void;
  replay: ReplayApi;
  debug: { client: { despawn(id: number): void; input(id: number, a: Record<string, number>): void }; fx: { stats: { particles: number; debris: number; skidSegments: number } } };
}
const g = (page: Page) => page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.vehicle);
const state = (page: Page) => page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.state);
const fxStats = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __crumple: G }).__crumple.debug.fx.stats }));

test('replay: wall hit at speed, seek to the impact, 1/4× slow-mo, scrub back, exit resumes the identical run', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (/\[replay\]/.test(msg.text())) console.log(msg.text());
  });
  await page.setViewportSize({ width: 800, height: 450 });
  await page.goto('/crumple/?q=low&spawn=arena&traffic=0');
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple?: G }).__crumple;
      return !!c && c.ready && c.vehicle !== null && c.position !== null;
    },
    null,
    { timeout: 150_000 },
  );
  // the soft cube sits in the runway: remove it; full run-up north (−Z) at the crash wall (z ≈ 265.6).
  // The render loop is HELD while driving (inputs go straight to the worker): under software GL a
  // frame takes ~0.5 s and main would receive (and record) only one snapshot per frame.
  await page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.debug.client.despawn(2);
    c.place(360, 402, 0);
    c.hold = true;
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 1, brake: 0, gearSelect: 1 }));
  let vMax = 0;
  for (let i = 0; i < 400; i++) {
    await page.waitForTimeout(50);
    const v = await g(page);
    if (v) vMax = Math.max(vMax, v.speed);
    if (v && v.damage > 0.03) break;
  }
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 0 }));
  await page.waitForTimeout(2500);
  const crashed = (await g(page))!;
  console.log(`[e2e] crash: peak ${(vMax * 3.6).toFixed(0)} km/h, damage ${(crashed.damage * 100).toFixed(1)} %`);
  expect(vMax * 3.6).toBeGreaterThan(80);
  expect(crashed.damage).toBeGreaterThan(0.03);

  // ---- enter: the worker pauses (hash reported), playhead at the end
  const entered = await page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.hold = false;
    return c.replay.enter();
  });
  expect(entered).toBe(true);
  let st = await state(page);
  expect(st.phase).toBe('replay');
  expect(st.duration).toBeGreaterThan(5);
  const tickAtEnter = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.pauseHash!.tick);
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.stateHash())).tick).toBe(tickAtEnter);

  // ---- the crash marker
  const markers = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.markers());
  console.log(`[e2e] markers: ${JSON.stringify(markers.map((m) => ({ t: +m.time.toFixed(2), s: +m.severity.toFixed(2), o: m.objectId, k: m.kind })))}`);
  expect(markers.length).toBeGreaterThan(0);
  const hit = markers.reduce((a, b) => (b.severity > a.severity ? b : a));
  expect(hit.objectId).toBe(1);
  expect(hit.severity).toBeGreaterThan(0.5);

  // ---- before the crash: pristine (telemetry damage 0 at that time), FX re-run cleared
  await page.evaluate((t) => (window as unknown as { __crumple: G }).__crumple.replay.seek(t), hit.time - 1.0);
  await page.waitForTimeout(300);
  const before = (await g(page))!;
  expect(before.damage).toBeLessThan(0.002);
  expect(before.speed * 3.6).toBeGreaterThan(70);

  // ---- seek just before the impact, play at 1/4× through it
  await page.evaluate((t) => {
    const r = (window as unknown as { __crumple: G }).__crumple.replay;
    r.seek(t);
    r.setSpeed(0.25);
    r.play();
  }, hit.time - 0.06);
  st = await state(page);
  expect(st.speed).toBe(0.25);
  // ~0.2 s of sim at 1/4× = 0.8 s real (SwiftShader frames are slow: wait on the playhead)
  await page.waitForFunction((t) => (window as unknown as { __crumple: G }).__crumple.replay.state.time >= t, hit.time + 0.14, { timeout: 60_000, polling: 50 });
  // screenshots: no HUD, a fixed camera beside the wall looking at the impact
  await page.addStyleTag({ content: '.hud { display: none !important; }' });
  await page.evaluate((p) => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.replay.pause();
    c.pinCamera([p[0] + 6.5, p[1] + 1.6, p[2] + 4.5], [p[0], p[1] - 0.2, p[2] + 1.6]);
    c.hold = true;
    c.renderOnce();
  }, hit.pos);
  st = await state(page);
  const atHit = (await g(page))!;
  const fxHit = await fxStats(page);
  console.log(`[e2e] at impact +${(st.time - hit.time).toFixed(3)} s: damage ${(atHit.damage * 100).toFixed(1)} %, speed ${(atHit.speed * 3.6).toFixed(0)} km/h, fx ${JSON.stringify(fxHit)}`);
  expect(atHit.damage).toBeGreaterThan(0.005);
  expect(fxHit.particles + fxHit.debris).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('replay-impact-quarter.png') });

  // settled seeks to the same moment reproduce the same FX (deterministic re-run), whatever came before
  const t1 = st.time;
  const seekFx = (from: number) =>
    page.evaluate(
      ([f, t]) => {
        const c = (window as unknown as { __crumple: G }).__crumple;
        c.replay.seek(f!);
        c.replay.seek(t!);
        c.renderOnce();
        return { ...c.debug.fx.stats };
      },
      [from, t1],
    );
  const fxA = await seekFx(t1 - 0.5);
  const fxB = await seekFx(t1 + 2);
  console.log(`[e2e] settled seek fx: ${JSON.stringify(fxA)} / ${JSON.stringify(fxB)}`);
  expect(fxB.particles).toBe(fxA.particles);
  expect(fxB.debris).toBe(fxA.debris);
  expect(fxA.particles + fxA.debris).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('replay-impact-settled.png') });

  // 1.5 s after the hit: the crushed car at rest-ish, smoke / debris still around
  await page.evaluate((t) => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.replay.seek(t);
    c.renderOnce();
  }, hit.time + 1.5);
  await page.screenshot({ path: info.outputPath('replay-after.png') });
  const stats = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.stats);
  console.log(
    `[e2e] replay stats: ${stats.frames} frames / ${stats.seconds.toFixed(1)} s, ${(stats.bytes / 1048576).toFixed(1)} MB (${(stats.bytesPerFrame / 1024).toFixed(1)} KB/frame), ` +
      `record ${stats.recordMs.toFixed(3)} ms (max ${stats.recordMsMax.toFixed(2)}), decode ${stats.decodeMs.toFixed(3)} ms, seek ${stats.lastSeekMs.toFixed(1)} ms (settle ${stats.lastSettleMs.toFixed(1)} ms)`,
  );
  // frame step + reverse do not throw
  await page.evaluate(() => {
    const r = (window as unknown as { __crumple: G }).__crumple.replay;
    r.step(-3);
    r.step(2);
  });

  const file = await page.evaluate(async () => {
    const f = await (window as unknown as { __crumple: G }).__crumple.replay.exportFile();
    return { build: f.build, inputs: f.inputs.count, commands: f.commands.length, paint: f.vehicles[0]?.paint ?? null };
  });
  console.log(`[e2e] replay file: ${JSON.stringify(file)}`);
  expect(file.inputs).toBeGreaterThanOrEqual(2);
  expect(file.paint).not.toBeNull();

  // ---- exit: the worker resumes from the identical state
  await page.evaluate(async () => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.hold = false;
    await c.replay.exit();
  });
  const hashes = await page.evaluate(() => {
    const r = (window as unknown as { __crumple: G }).__crumple.replay;
    return { pause: r.pauseHash, resume: r.resumeHash };
  });
  console.log(`[e2e] hashes: ${JSON.stringify(hashes)}`);
  expect(hashes.resume).toEqual(hashes.pause);
  await page.waitForFunction((t) => (window as unknown as { __crumple: G }).__crumple.tick > t + 1000, tickAtEnter, { timeout: 30_000 });
  expect((await state(page)).phase).toBe('live');
  await page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.hold = true;
    c.renderOnce();
  });
  await page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.pinCamera(null);
    c.renderOnce(1);
  });
  await page.screenshot({ path: info.outputPath('replay-live-after-exit.png') });
  expect(errors.filter((e) => !/GPU stall|RGBELoader/.test(e))).toEqual([]);
});
