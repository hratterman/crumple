import { expect, test } from '@playwright/test';

interface CrumpleGlobal {
  /** Sim tick of the latest snapshot (dt = 1/2000 s). */
  tick: number;
  build: string;
  nodes: number;
  snapshotHz: number;
}

// In CI the renderer string is SwiftShader (software rasterizer) — never
// assert on GPU vendor/renderer, only on capabilities and behavior.
test('boot: canvas attaches, WebGL2 works, sim ticks, zero errors', async ({ page }) => {
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

  await page.goto('/crumple/');

  await expect(page.locator('canvas')).toBeAttached();

  const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
  expect(hasCanvas).toBe(true);

  const webgl2Backed = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return typeof c.getContext === 'function' && !!c.getContext('webgl2');
  });
  expect(webgl2Backed).toBe(true);

  // Wait for the app global and the first sim snapshot before sampling.
  await page.waitForFunction(() => {
    const g = (window as unknown as { __crumple?: { tick: number } }).__crumple;
    return !!g && g.tick > 0;
  });

  const tickBefore = await page.evaluate(
    () => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.tick,
  );
  await page.waitForTimeout(1000);
  const tickAfter = await page.evaluate(
    () => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.tick,
  );

  expect(tickBefore).toBeGreaterThan(0);
  // 2000 ticks/s at timescale 1; allow a slow headless worker.
  expect(tickAfter - tickBefore).toBeGreaterThanOrEqual(500);

  const nodes = await page.evaluate(
    () => (window as unknown as { __crumple: CrumpleGlobal }).__crumple.nodes,
  );
  expect(nodes).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
