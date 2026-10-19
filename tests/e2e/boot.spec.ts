import { expect, test } from '@playwright/test';

interface CrumpleGlobal {
  /** Sim tick of the latest snapshot (dt = 1/2000 s). */
  tick: number;
  build: string;
  nodes: number;
  snapshotHz: number;
  ready: boolean;
  spawns: string[];
  stats: { loadMs: number; terrainMatched: boolean };
}

// In CI the renderer string is SwiftShader (software rasterizer) — never
// assert on GPU vendor/renderer, only on capabilities and behavior. Small
// viewport + low preset keep the software-rendered island load well under a minute.
test('boot: loading screen → island, sim ticks on the heightfield, zero errors', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.stack ?? String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto('/crumple/?q=low');

  await expect(page.locator('canvas')).toBeAttached();
  // The loading screen is in the HTML itself: visible before any script runs.
  await expect(page.locator('#loading .loading-title')).toHaveText('CRUMPLE');
  await expect(page.locator('#loading .loading-step')).toHaveCount(4);

  const webgl2Backed = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return typeof c.getContext === 'function' && !!c.getContext('webgl2');
  });
  expect(webgl2Backed).toBe(true);

  // Island loaded: game loop running, render + physics terrain identical.
  await page.waitForFunction(() => (window as unknown as { __crumple?: CrumpleGlobal }).__crumple?.ready === true, null, {
    timeout: 50_000,
  });
  const g = await page.evaluate(() => {
    const c = (window as unknown as { __crumple: CrumpleGlobal }).__crumple;
    return { spawns: c.spawns, matched: c.stats.terrainMatched, loadMs: c.stats.loadMs };
  });
  expect(g.matched).toBe(true);
  expect(g.spawns.length).toBe(8);
  console.log(`island load ${(g.loadMs / 1000).toFixed(1)} s (SwiftShader)`);
  await expect(page.locator('#loading')).toHaveClass(/loading--fade/);

  const tickBefore = await page.evaluate(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.tick);
  await page.waitForTimeout(1000);
  const tickAfter = await page.evaluate(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.tick);

  expect(tickBefore).toBeGreaterThan(0);
  // 2000 ticks/s at timescale 1; allow a slow headless worker.
  expect(tickAfter - tickBefore).toBeGreaterThanOrEqual(500);

  const nodes = await page.evaluate(() => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.nodes);
  expect(nodes).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
