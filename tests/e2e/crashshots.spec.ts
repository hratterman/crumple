import { expect, test, type Page } from '@playwright/test';

/**
 * R-CRASH crash screenshot sequences (opt-in: CRASH_SHOTS=<dir>). Drives a vehicle from the arena run-up
 * into the crash wall at CRASH_SPEED km/h (default 50; throttle until the speed is reached, then neutral),
 * enters the replay and saves a fixed side-view sequence around the impact marker (CRASH_TIMES, seconds
 * relative to the marker) plus a three-quarter view of the wreck. CRASH_VEHICLE picks the car
 * (`?vehicle=`), CRASH_TAG prefixes the files. Not a regression test: it is how the crash work is
 * inspected (before / after sequences). Uses only the public __crumple debug API.
 */
interface Marker {
  time: number;
  severity: number;
  objectId: number;
  pos: [number, number, number];
}
interface G {
  ready: boolean;
  hold: boolean;
  renderOnce(settle?: number): void;
  vehicle: { speed: number; damage: number } | null;
  position: [number, number, number] | null;
  place(x: number, z: number, yawDeg?: number): void;
  pinCamera(pos: [number, number, number] | null, target?: [number, number, number]): void;
  replay: {
    state: { time: number };
    enter(o?: { time?: number }): Promise<boolean>;
    seek(t: number, settle?: boolean): void;
    pause(): void;
    markers(): Marker[];
  };
  debug: { client: { despawn(id: number): void; input(id: number, a: Record<string, number>): void } };
}
const W = (page: Page) => page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.vehicle);

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DIR = ENV.CRASH_SHOTS;
const SPEED = Number(ENV.CRASH_SPEED ?? 50);
const VEHICLE = ENV.CRASH_VEHICLE ?? 'sedan';
const TAG = ENV.CRASH_TAG ?? `${VEHICLE}-${SPEED}`;
const TIMES = (ENV.CRASH_TIMES ?? '-0.05,0.02,0.05,0.08,0.12,0.18,0.3,0.6,1.5').split(',').map(Number);
/** Crash wall (DEFAULT_LAYOUT `crashWall`): centre x 360, face z 265 + 0.6, the run-up north of it. */
const WALL_X = 360;
const WALL_FACE_Z = 265.6;

test.skip(!DIR, 'set CRASH_SHOTS=<dir> to record crash screenshot sequences');

test(`crash shots: ${TAG}`, async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(`/crumple/?q=medium&spawn=arena&traffic=0&vehicle=${VEHICLE}&crashcam=0`);
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple?: G }).__crumple;
      return !!c && c.ready && c.vehicle !== null && c.position !== null;
    },
    null,
    { timeout: 200_000 },
  );
  // run-up: long enough to reach the speed, then coast in neutral into the wall
  const runUp = Math.max(60, (SPEED / 3.6) ** 2 / 2 / 2.2 + 40);
  await page.evaluate(
    ([x, z]) => {
      const c = (window as unknown as { __crumple: G }).__crumple;
      c.debug.client.despawn(2);
      c.place(x!, z!, 0);
      c.hold = true;
    },
    [WALL_X, WALL_FACE_Z + runUp],
  );
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 1, brake: 0, handbrake: 0, gearSelect: 1 }));
  let vMax = 0;
  let coasting = false;
  for (let i = 0; i < 1200; i++) {
    await page.waitForTimeout(25);
    const v = await W(page);
    if (!v) continue;
    vMax = Math.max(vMax, v.speed);
    if (!coasting && v.speed * 3.6 >= SPEED) {
      coasting = true;
      await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 0, gearSelect: 0 }));
    }
    if (v.damage > 0.01) break;
  }
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.debug.client.input(1, { throttle: 0, gearSelect: 0 }));
  await page.waitForTimeout(3000);
  console.log(`[shots] ${TAG}: peak ${(vMax * 3.6).toFixed(1)} km/h, damage ${(((await W(page))?.damage ?? 0) * 100).toFixed(1)} %`);

  expect(await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.enter())).toBe(true);
  const markers = await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replay.markers());
  const own = markers.filter((m) => m.objectId === 1);
  expect(own.length).toBeGreaterThan(0);
  // first contact = the earliest marker of the hit (the most severe one may be the engine reaching the wall)
  const top = own.reduce((a, b) => (b.severity > a.severity ? b : a));
  const hit = own.filter((m) => m.time > top.time - 0.4).reduce((a, b) => (b.time < a.time ? b : a));
  await page.addStyleTag({ content: '.hud, .rp { display: none !important; }' });
  await page.evaluate(() => (window as unknown as { __crumple: { replayUi?: { setClean?(on: boolean): void } } }).__crumple.replayUi?.setClean?.(true));
  // the arena floor is not at y = 0: heights from the impact point (≈ bumper height above the floor)
  const gy = hit.pos[1] - 0.5;
  const z0 = WALL_FACE_Z + 2.4;
  const side: [number, number, number] = [WALL_X + 7.5, gy + 1.5, z0];
  const quarter: [number, number, number] = [WALL_X + 5.2, gy + 2.3, WALL_FACE_Z + 6.2];
  for (const [k, dt] of TIMES.entries()) {
    await page.evaluate(
      ([t, cam, tgt]) => {
        const c = (window as unknown as { __crumple: G }).__crumple;
        c.replay.seek(t as number, true);
        c.replay.pause();
        c.pinCamera(cam as [number, number, number], tgt as [number, number, number]);
        c.renderOnce(0.2);
      },
      [hit.time + dt, side, [WALL_X, gy + 0.65, z0]] as const,
    );
    await page.screenshot({ path: `${DIR}/${TAG}-${String(k).padStart(2, '0')}-t${dt >= 0 ? '+' : ''}${dt.toFixed(2)}.png` });
  }
  await page.evaluate(
    ([t, cam, tgt]) => {
      const c = (window as unknown as { __crumple: G }).__crumple;
      c.replay.seek(t as number, true);
      c.pinCamera(cam as [number, number, number], tgt as [number, number, number]);
      c.renderOnce(0.2);
    },
    [hit.time + 2, quarter, [WALL_X, gy + 0.6, WALL_FACE_Z + 2.0]] as const,
  );
  await page.screenshot({ path: `${DIR}/${TAG}-wreck.png` });
});
