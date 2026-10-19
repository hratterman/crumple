import { expect, test } from '@playwright/test';

interface LightingHooks {
  ready: boolean;
  texturesReady: boolean;
  level: string;
  setQuality(level: string): void;
  setView(v: string): void;
  sample(): { mean: number; std: number };
  setHotPixels(kind: 'nan' | 'inf' | 'huge' | null): void;
  setSanitize(on: boolean): void;
  info(): { cascades: number; sunDirection: number[]; proceduralSky: boolean; level: string };
}

// Graphics-stack spike (dev/lighting.html): HDRI + PMREM + CSM + N8AO + SMAA/bloom/ACES
// compose without errors, and quality presets rebuild at runtime. SwiftShader is slow:
// small viewport, generous timeout, behaviour-only assertions.
test('lighting preview: full stack renders and switches presets', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 480, height: 270 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/crumple/dev/lighting.html?hud=0&adaptive=0&q=low&view=hero');
  await page.waitForFunction(
    () => {
      const l = (window as unknown as { __lighting?: LightingHooks }).__lighting;
      return !!l && l.ready && l.texturesReady;
    },
    null,
    { timeout: 180_000 },
  );

  const low = await page.evaluate(() => {
    const l = (window as unknown as { __lighting: LightingHooks }).__lighting;
    return { info: l.info(), px: l.sample() };
  });
  expect(low.info.level).toBe('low');
  expect(low.info.cascades).toBe(2);
  // key light sits above the golden-hour floor
  expect(Math.asin(low.info.sunDirection[1]!) * (180 / Math.PI)).toBeGreaterThanOrEqual(15.9);
  // a lit, non-flat image (not black, not blown out)
  expect(low.px.mean).toBeGreaterThan(30);
  expect(low.px.mean).toBeLessThan(225);
  expect(low.px.std).toBeGreaterThan(10);

  const high = await page.evaluate(() => {
    const l = (window as unknown as { __lighting: LightingHooks }).__lighting;
    l.setQuality('high');
    return { info: l.info(), px: l.sample() };
  });
  expect(high.info.cascades).toBe(4);
  expect(high.px.std).toBeGreaterThan(10);

  // NaN / black-frame guard: non-finite and overflowing pixels in view must not blank the
  // frame through bloom (the sanitize pass runs before the EffectPass whenever bloom is on).
  for (const kind of ['nan', 'inf', 'huge'] as const) {
    const px = await page.evaluate((k) => {
      const l = (window as unknown as { __lighting: LightingHooks }).__lighting;
      l.setHotPixels(k);
      l.sample();
      return l.sample();
    }, kind);
    expect(px.mean, `${kind} pixels blanked the frame`).toBeGreaterThan(0.5 * high.px.mean);
    expect(px.std).toBeGreaterThan(10);
  }
  // Control: the same NaN quad without the guard blanks the whole frame (bloom spreads it).
  const unguarded = await page.evaluate(() => {
    const l = (window as unknown as { __lighting: LightingHooks }).__lighting;
    l.setSanitize(false);
    l.setHotPixels('nan');
    l.sample();
    const px = l.sample();
    l.setSanitize(true);
    l.setHotPixels(null);
    return px;
  });
  expect(unguarded.mean).toBeLessThan(5);

  expect(errors.filter((e) => !/GPU stall|RGBELoader/.test(e))).toEqual([]);
});
