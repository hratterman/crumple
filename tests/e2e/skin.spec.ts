import { expect, test } from '@playwright/test';

interface Parity {
  maxPos: number;
  maxNrm: number;
  vertices: number;
  nan: number;
}
interface SkinHooks {
  ready: boolean;
  errors: string[];
  setPose(p: string): void;
  parity(panel?: number): Parity;
}

// Flexbody skin harness (dev/skin.html): the exact flex2 GLSL compiles in the
// color (CSM-patched physical), depth and distance programs, and its GPU
// reconstruction read back from a float target matches the CPU mirror
// (binder.ts evalFlexFrame) at rest, under rigid roll, a crumple and an
// exploded node.
test('flexbody skin: shader compiles and GPU reconstruction matches the CPU mirror', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 480, height: 270 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/crumple/dev/skin.html?loop=0&q=low&hud=0');
  await page.waitForFunction(() => (window as unknown as { __skin?: SkinHooks }).__skin?.ready === true, null, {
    timeout: 150_000,
  });

  for (const pose of ['rest', 'roll', 'dent', 'explode']) {
    const r = await page.evaluate((p) => {
      const s = (window as unknown as { __skin: SkinHooks }).__skin;
      s.setPose(p);
      return [s.parity(0), s.parity(1)];
    }, pose);
    for (const p of r) {
      expect(p.vertices, pose).toBeGreaterThan(100);
      expect(p.nan, pose).toBe(0);
      expect(p.maxPos, pose).toBeLessThan(1e-4);
      expect(p.maxNrm, pose).toBeLessThan(1e-4);
    }
  }
  const shaderErrors = await page.evaluate(() => (window as unknown as { __skin: SkinHooks }).__skin.errors);
  expect(shaderErrors).toEqual([]);
  expect(errors.filter((e) => !/GPU stall|RGBELoader/.test(e))).toEqual([]);
});
