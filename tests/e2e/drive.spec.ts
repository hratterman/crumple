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
  vehicle: VehicleSample | null;
  camera: string;
  beamView: boolean;
}

function sample(page: import('@playwright/test').Page): Promise<{ vehicle: VehicleSample | null; idleRpm: number }> {
  return page.evaluate(() => {
    const g = (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple;
    return { vehicle: g.vehicle, idleRpm: g.idleRpm };
  });
}

test('drive: holding W accelerates the sedan; zero errors', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/crumple/');
  await expect(page.locator('canvas')).toBeAttached();

  // Wait for the vehicle's telemetry to appear, then let it settle on its wheels.
  await page.waitForFunction(() => {
    const g = (window as unknown as { __crumple?: CrumpleDriveGlobal }).__crumple;
    return !!g && g.tick > 0 && g.vehicle !== null;
  });
  await page.waitForTimeout(1500);

  const before = await sample(page);
  expect(before.vehicle).not.toBeNull();
  expect(Math.abs(before.vehicle!.speed)).toBeLessThan(1.5);

  const cam = await page.evaluate(() => (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple.camera);
  expect(cam).toBe('chase');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  const during = await sample(page);
  await page.keyboard.up('KeyW');

  expect(during.vehicle).not.toBeNull();
  expect(during.vehicle!.speed).toBeGreaterThan(3);
  expect(during.vehicle!.rpm).toBeGreaterThan(during.idleRpm);

  // B toggles the beam view off.
  await page.keyboard.press('KeyB');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __crumple: CrumpleDriveGlobal }).__crumple.beamView))
    .toBe(false);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
