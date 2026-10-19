import { expect, test } from '@playwright/test';

interface RoadsPreview {
  ready: boolean;
  error: string | null;
  views: string[];
  setView(i: number): void;
  prime(): void;
  renderFrames(n: number): number;
  stats(): { roads: { pieces: number; junctions: number; triangles: number } };
}

// Dev-only road preview (dev/roads.html): boots the full terrain + road
// stack, renders the showcase viewpoints and checks for shader/page errors.
// SwiftShader is slow — this is a smoke test, the art review uses the
// screenshots it leaves in test-results/.
test('road preview: ribbons build, shaders compile, viewpoints render', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/crumple/dev/roads.html?still');
  await page.waitForFunction(
    () => {
      const h = (window as unknown as { __roadsPreview?: RoadsPreview }).__roadsPreview;
      return !!h && (h.ready || !!h.error);
    },
    null,
    { timeout: 300_000 },
  );
  const info = await page.evaluate(() => {
    const h = (window as unknown as { __roadsPreview: RoadsPreview }).__roadsPreview;
    return { error: h.error, views: h.views, stats: h.error ? null : h.stats() };
  });
  expect(info.error).toBeNull();
  expect(info.stats!.roads.pieces).toBeGreaterThan(50);
  expect(info.stats!.roads.junctions).toBe(12);
  for (const [i, name] of info.views.slice(0, 5).entries()) {
    await page.evaluate((v) => {
      const h = (window as unknown as { __roadsPreview: RoadsPreview }).__roadsPreview;
      h.setView(v);
      h.prime();
      h.renderFrames(1);
    }, i);
    await page.screenshot({
      path: `test-results/roads-e2e-${name.replace(/\s+/g, '-')}.png`,
      timeout: 240_000,
    });
  }
  expect(errors).toEqual([]);
});
