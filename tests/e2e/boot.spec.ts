import { expect, test } from '@playwright/test';

interface CrumpleGlobal {
  tick: number;
  build: string;
}

// In CI the renderer string is SwiftShader (software rasterizer) — never
// assert on GPU vendor/renderer, only on capabilities and behavior.
test('boot: canvas attaches, WebGL2 works, render loop ticks, zero errors', async ({ page }) => {
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

  // Wait for the app global and the first rendered frame before sampling —
  // SwiftShader's first frame (shader compile) can take a while.
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
  expect(tickAfter - tickBefore).toBeGreaterThanOrEqual(10);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
