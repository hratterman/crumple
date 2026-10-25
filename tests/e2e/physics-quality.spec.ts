import { expect, test } from '@playwright/test';

interface PhysicsDebug {
  quality: string;
  setting: string;
  kernel: string | null;
  kernelBench: number;
  playerQuality: string | null;
  playerBeams: number;
  playerNodes: number;
  swaps: number;
  set(q: string): void;
}
interface CrumpleGlobal {
  ready: boolean;
  vehicle: { speed: number } | null;
  physics: PhysicsDebug;
}

const phys = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __crumple: CrumpleGlobal }).__crumple.physics;
    return { quality: p.quality, kernel: p.kernel, bench: p.kernelBench, playerQuality: p.playerQuality, beams: p.playerBeams, swaps: p.swaps };
  });

test('physics quality: the WASM SIMD kernel runs, ?physics=high spawns a validated HD rig (coupe) and drives, the setting respawns it at standard', async ({ page }) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 480, height: 270 });
  // R-RIG: a car whose HD tier is VALIDATED (variants.ts HD_STATUS); the HD sedan is experimental since aa93f53
  await page.goto('/crumple/?q=low&traffic=0&vehicle=coupe&physics=high');
  await page.waitForFunction(() => {
    const c = (window as unknown as { __crumple?: CrumpleGlobal }).__crumple;
    return !!c && c.ready && c.vehicle !== null;
  }, null, { timeout: 300_000 });
  await page.waitForTimeout(1000);
  const a = await phys(page);
  console.log(`[e2e] physics: ${JSON.stringify(a)}`);
  expect(a.kernel).toBe('simd');
  expect(a.bench).toBeGreaterThan(0);
  expect(a.quality).toBe('high');
  expect(a.playerQuality).toBe('high');
  expect(a.beams).toBeGreaterThan(3500);
  // Drive it: hold W (releases the spawn hold, like drive.spec).
  // (The 6 k-beam rig runs below real time on a loaded SwiftShader box: wait for the speed, not a clock.)
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.vehicle!.speed > 2, null, { timeout: 90_000 });
  const v = await page.evaluate(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.vehicle!.speed);
  await page.keyboard.up('KeyW');
  console.log(`[e2e] HD high coupe speed on W: ${v.toFixed(1)} m/s`);
  expect(v).toBeGreaterThan(2);
  // Settings → standard: respawned in place with the standard rig.
  await page.evaluate(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.physics.set('standard'));
  await page.waitForFunction(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.physics.playerQuality === 'standard', null, { timeout: 60_000 });
  const b = await phys(page);
  expect(b.beams).toBeLessThan(3500);
  expect(b.swaps).toBe(a.swaps + 1);
  expect(errors).toEqual([]);
});
