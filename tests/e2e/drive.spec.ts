import { expect, test } from '@playwright/test';

interface VehicleSample {
  speed: number;
  rpm: number;
  gear: number;
  damage: number;
}
interface CrumpleDriveGlobal {
  tick: number;
  idleRpm: number;
  ready: boolean;
  vehicle: VehicleSample | null;
  position: [number, number, number] | null;
  camera: string;
  beamView: boolean;
  viewMode: string;
  nodesVisible: boolean;
  bodyVisible: boolean;
  spawns: string[];
  spawnIndex: number;
}

const g = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple;
    return { vehicle: c.vehicle, idleRpm: c.idleRpm, position: c.position, spawnIndex: c.spawnIndex, spawns: c.spawns };
  });

test('drive: hold W on the spawn road accelerates the sedan; spawn keys teleport; zero errors', async ({ page }) => {
  // P4: the skinned sedan adds ~a dozen programs; SwiftShader compiles them on the CPU.
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto('/crumple/?q=low');
  await expect(page.locator('canvas')).toBeAttached();

  // Island loaded and the sedan settled on its wheels on the highway.
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple?: CrumpleDriveGlobal }).__crumple;
      return !!c && c.ready && c.vehicle !== null && c.position !== null;
    },
    null,
    { timeout: 110_000 },
  );
  await page.waitForTimeout(1000);

  const before = await g(page);
  expect(before.vehicle).not.toBeNull();
  expect(Math.abs(before.vehicle!.speed)).toBeLessThan(1.5);
  // On the island, resting on the road surface (spawn = the highway, ~11 m up).
  expect(before.spawns[before.spawnIndex]).toBe('highway');
  expect(before.position![1]).toBeGreaterThan(5);

  const cam = await page.evaluate(() => (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple.camera);
  expect(cam).toBe('chase');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  const during = await g(page);
  await page.keyboard.up('KeyW');

  expect(during.vehicle).not.toBeNull();
  expect(during.vehicle!.speed).toBeGreaterThan(3);
  expect(during.vehicle!.rpm).toBeGreaterThan(during.idleRpm);

  // B cycles the debug view body → body+beams → beams → nodes → body; the car is always visible.
  const view = () =>
    page.evaluate(() => {
      const c = (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple;
      return { mode: c.viewMode, beams: c.beamView, body: c.bodyVisible, nodes: c.nodesVisible };
    });
  expect(await view()).toEqual({ mode: 'body', beams: false, body: true, nodes: false });
  await page.keyboard.press('KeyB');
  await expect.poll(view).toEqual({ mode: 'body+beams', beams: true, body: true, nodes: true });
  await page.keyboard.press('KeyB');
  await expect.poll(view).toEqual({ mode: 'beams', beams: true, body: false, nodes: true });
  await page.keyboard.press('KeyB');
  await expect.poll(view).toEqual({ mode: 'nodes', beams: false, body: false, nodes: true });
  await page.keyboard.press('KeyB');
  await expect.poll(view).toEqual({ mode: 'body', beams: false, body: true, nodes: false });

  // X toggles traction control (default on); the HUD badge follows.
  const tc = () =>
    page.evaluate(() => ({
      on: (window as unknown as { __crumple: { tractionControl: boolean } }).__crumple.tractionControl,
      badges: [...document.querySelectorAll('.hud-badge')].map((b) => b.textContent),
    }));
  expect((await tc()).on).toBe(true);
  await expect.poll(async () => (await tc()).badges.includes('TC')).toBe(true);
  await page.keyboard.press('KeyX');
  await expect.poll(async () => { const t = await tc(); return !t.on && t.badges.includes('TC OFF'); }).toBe(true);
  await page.keyboard.press('KeyX');
  await expect.poll(async () => (await tc()).on).toBe(true);

  // 5 → the summit lookout spawn (150 m up the mountain).
  await page.keyboard.press('Digit5');
  await expect
    .poll(async () => {
      const s = await g(page);
      return s.spawns[s.spawnIndex] === 'summit' && !!s.position && s.position[1] > 140;
    }, { timeout: 30_000 })
    .toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
