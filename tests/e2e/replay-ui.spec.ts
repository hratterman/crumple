import { expect, test, type Page } from '@playwright/test';

/**
 * P7 R2: replay UI, replay cameras, crash cam and photo mode, driven like a
 * player. Drive the sedan into the arena's block wall (?crashcam=1: the crash
 * cam is off under automation by default), the crash cam plays the crash as
 * an instant replay and a key skips it; Backspace opens the replay with the
 * crash on the timeline; drag-scrub; switch cameras; photo mode with a grade,
 * click-to-focus and a PNG capture; Esc twice is back on the road.
 * Screenshots of every step land in this test's output directory.
 */
interface UiState {
  open: boolean;
  highlight: boolean;
  crashCam: string;
  highlights: number;
  camera: string;
  shot: string;
  cuts: number;
  photo: boolean;
  dof: boolean;
  photoSettings: { preset: string; focus: number; autofocus: boolean; aspect: string };
  lastPhoto: { width: number; height: number; bytes: number; name: string } | null;
}
interface ReplayState {
  phase: string;
  time: number;
  start: number;
  end: number;
  duration: number;
  speed: number;
  direction: number;
  playing: boolean;
  frames: number;
  markers: number;
}
interface G {
  ready: boolean;
  tick: number;
  hold: boolean;
  debug: {
    client: { despawn(id: number): void; input(id: number, a: Record<string, number>): void };
    camera: unknown;
  };
  position: [number, number, number] | null;
  vehicle: { speed: number; damage: number } | null;
  place(x: number, z: number, yawDeg?: number): void;
  replay: { state: ReplayState; seek(t: number, settle?: boolean): void; controller: { targets(out: { position: number[] }[]): number } };
  replayUi: {
    state: UiState;
    setPhoto(p: Record<string, unknown>): void;
    capture(scale?: 1 | 2): Promise<{ width: number; height: number; bytes: number; name: string }>;
  } | null;
}

const ui = (page: Page): Promise<UiState> => page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.state);
const rs = (page: Page): Promise<ReplayState> => page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.state);
const waitFor = (page: Page, fn: string, timeout = 60_000) =>
  page.waitForFunction(`(() => { const c = window.__crumple; return ${fn}; })()`, null, { timeout, polling: 100 });

test('replay UI: crash cam, timeline markers, scrub, cameras, photo mode + PNG', async ({ page }, info) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const W = 960;
  const H = 540;
  await page.setViewportSize({ width: W, height: H });
  await page.goto('/crumple/?q=low&spawn=arena&traffic=0&crashcam=1');
  await waitFor(page, 'c && c.ready && c.vehicle !== null && c.position !== null && c.replayUi !== null', 180_000);
  // Software GL draws a frame every ~0.5–2 s: wiggle the pointer (the chrome shows on activity) and give
  // CSS transitions time before each screenshot.
  let wiggle = 0;
  const shot = async (name: string): Promise<void> => {
    wiggle = (wiggle + 1) % 2;
    await page.mouse.move(W / 2 + 40 * wiggle, H / 2 - 60);
    await page.waitForTimeout(900);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
  };

  // ---- Full run-up into the crash wall (R1's replay.spec approach): the soft cube leaves the runway and
  // the render loop is HELD while driving, so main records every snapshot even under software GL. The
  // crash cam arms on the impact and plays as soon as frames run again.
  await page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.debug.client.despawn(2);
    c.place(360, 402, 0);
    c.hold = true;
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 1, brake: 0, gearSelect: 1 }));
  for (let i = 0; i < 400; i++) {
    await page.waitForTimeout(50);
    const v = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.vehicle);
    if (v && v.damage > 0.03) break;
  }
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 0 }));
  await page.waitForTimeout(1500);
  expect((await ui(page)).crashCam).toBe('armed');
  await page.evaluate(() => {
    (window as unknown as { __crumple: G }).__crumple.hold = false;
  });

  // ---- Crash cam: auto-enters as a letterboxed instant replay at 1/4×.
  await waitFor(page, 'c.replayUi.state.highlight', 60_000);
  await page.waitForTimeout(1200);
  const hl = await rs(page);
  expect(hl.phase).toBe('replay');
  expect(hl.speed).toBe(0.25);
  expect(hl.markers).toBeGreaterThan(0);
  await expect(page.locator('.rp.rp--cinema.rp--highlight')).toBeVisible();
  await expect(page.locator('.rp-highlight-title')).not.toBeEmpty();
  expect((await ui(page)).camera).toBe('auto');
  await shot('01-crash-cam');

  // Any key skips it: straight back on the road.
  await page.keyboard.press('KeyN');
  await waitFor(page, '!c.replayUi.state.open && c.replay.state.phase === "live"', 30_000);
  expect((await ui(page)).highlights).toBe(1);
  await expect(page.locator('.rp')).toBeHidden();
  await expect(page.locator('.hud')).toBeVisible();
  const t0 = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.tick);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.tick)).toBeGreaterThan(t0);

  // ---- Backspace: the replay, paused at the end, the crash on the timeline.
  expect((await rs(page)).markers).toBeGreaterThan(0);
  await page.keyboard.press('Backspace');
  await waitFor(page, 'c.replayUi.state.open && c.replay.state.phase === "replay"', 30_000);
  await expect(page.getByTestId('replay-ui')).toBeVisible();
  await expect(page.locator('.hud')).toBeHidden();
  await expect(page.getByTestId('replay-marker').first()).toBeAttached();
  await page.waitForTimeout(800);
  await shot('02-replay-open');

  // Drag-scrub the timeline from 25 % to 55 % (preview while dragging, settled on release).
  const box = (await page.getByTestId('replay-timeline').boundingBox())!;
  const y = box.y + box.height - 11;
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, y, { steps: 3 });
  await page.mouse.move(box.x + box.width * 0.55, y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const scrubbed = await rs(page);
  const frac = (scrubbed.time - scrubbed.start) / scrubbed.duration;
  expect(frac).toBeGreaterThan(0.45);
  expect(frac).toBeLessThan(0.65);
  await expect(page.getByTestId('replay-time')).not.toHaveText('0:00.00');
  await shot('03-scrubbed');

  // Speed + reverse from the keyboard.
  expect((await rs(page)).speed).toBe(1); // a manual replay starts at 1× (the crash cam played at 1/4×)
  await page.keyboard.press('BracketLeft');
  await page.keyboard.press('BracketLeft');
  expect((await rs(page)).speed).toBe(0.25);
  await page.keyboard.press('BracketRight');
  expect((await rs(page)).speed).toBe(0.5);
  await page.keyboard.press('KeyR');
  expect((await rs(page)).direction).toBe(-1);
  await page.keyboard.press('KeyR');

  // ---- Cameras: trackside, helicopter, tracking, then the director.
  for (const [key, mode] of [
    ['Digit4', 'trackside'],
    ['Digit6', 'heli'],
    ['Digit3', 'bumper'],
    ['Digit1', 'auto'],
  ] as const) {
    await page.keyboard.press(key);
    await waitFor(page, `c.replayUi.state.camera === '${mode}'`, 10_000);
    await page.waitForTimeout(1200);
    await shot(`04-camera-${mode}`);
  }
  // Play under the director: it cuts.
  await page.keyboard.press('Space');
  await page.waitForTimeout(3000);
  expect((await ui(page)).cuts).toBeGreaterThan(0);

  // ---- Photo mode: grade, letterbox aspect, click-to-focus, capture.
  await page.keyboard.press('KeyP');
  await waitFor(page, 'c.replayUi.state.photo', 15_000);
  await expect(page.getByTestId('photo-mode')).toBeVisible();
  expect((await rs(page)).playing).toBe(false);
  expect((await ui(page)).dof).toBe(true);
  await page.locator('[data-look="golden"]').click();
  await page.locator('[data-aspect="2.39"]').click();
  expect((await ui(page)).photoSettings.preset).toBe('golden');
  // Click-to-focus on the car (its screen position from the camera; the flexbody has no CPU mesh).
  const aim = await page.evaluate(() => {
    interface V3 {
      x: number;
      y: number;
      set(x: number, y: number, z: number): V3;
      distanceTo(o: V3): number;
      project(c: unknown): V3;
      clone(): V3;
    }
    const c = (window as unknown as { __crumple: G }).__crumple;
    const cam = c.debug.camera as unknown as { position: V3 };
    const out: { position: number[] }[] = [];
    if (c.replay.controller.targets(out) < 1) return null;
    const t = out[0]!;
    const p = cam.position.clone().set(t.position[0]!, t.position[1]! + 0.5, t.position[2]!);
    const dist = p.distanceTo(cam.position);
    p.project(cam);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, dist };
  });
  expect(aim).not.toBeNull();
  await page.mouse.click(aim!.x, aim!.y);
  await page.waitForTimeout(300);
  const focused = (await ui(page)).photoSettings;
  expect(focused.autofocus).toBe(false);
  expect(Math.abs(focused.focus - aim!.dist)).toBeLessThan(3);
  await page.waitForTimeout(1200);
  await shot('05-photo-mode');
  const photo = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.capture(1));
  expect(photo.width).toBe(W);
  expect(photo.height).toBe(Math.round(W / 2.39));
  expect(photo.bytes).toBeGreaterThan(20_000);
  await expect(page.getByTestId('photo-result')).toHaveClass(/ph-shot--on/);
  await expect(page.getByTestId('photo-download')).toHaveAttribute('href', /^blob:/);
  await expect(page.getByTestId('photo-download')).toHaveAttribute('download', /^crumple-\d{8}-\d{6}\.png$/);
  await page.waitForTimeout(1500);
  await shot('06-photo-captured');

  // ---- Esc leaves photo mode, Esc again leaves the replay: driving resumes.
  await page.keyboard.press('Escape');
  await waitFor(page, '!c.replayUi.state.photo && c.replayUi.state.open', 10_000);
  await page.keyboard.press('Escape');
  await waitFor(page, '!c.replayUi.state.open && c.replay.state.phase === "live"', 30_000);
  await expect(page.locator('.hud')).toBeVisible();
  const t1 = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.tick);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.tick)).toBeGreaterThan(t1);
  await shot('07-back-live');
  expect(errors).toEqual([]);
});
