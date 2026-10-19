import { expect, test } from '@playwright/test';

interface TerrainStats {
  chunks: number;
  visibleChunks: number;
  triangles: number;
  pending: number;
  lodCounts: number[];
}
interface TerrainPreviewHooks {
  ready: boolean;
  error: string | null;
  terrainSource: string;
  views: string[];
  setView(i: number): void;
  setQuality(level: string): void;
  prime(): void;
  renderFrames(n: number): number;
  stats(): TerrainStats;
  streamTest(frames: number, speed: number): { maxBuildMs: number; builds: number };
}

// Terrain preview (dev/terrain.html): DEFAULT_LAYOUT terrain through the chunked
// LOD renderer + splat shader on the real lighting/post stack. Behaviour-only
// assertions (SwiftShader): it compiles, draws, streams within budget and
// honours the LOD bias of the quality presets.
test('terrain preview: chunked LOD terrain renders, streams and follows presets', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 480, height: 270 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/crumple/dev/terrain.html?still&q=low&view=0');
  await page.waitForFunction(
    () => {
      const p = (window as unknown as { __terrainPreview?: TerrainPreviewHooks }).__terrainPreview;
      return !!p && (p.ready || !!p.error);
    },
    null,
    { timeout: 240_000 },
  );
  const get = <T>(fn: (p: TerrainPreviewHooks) => T): Promise<T> =>
    page.evaluate(
      (src) => {
        const p = (window as unknown as { __terrainPreview: TerrainPreviewHooks }).__terrainPreview;
        return new Function('p', `return (${src})(p)`)(p) as T;
      },
      fn.toString(),
    );

  expect(await get((p) => p.error)).toBeNull();
  expect(await get((p) => p.views.length)).toBeGreaterThanOrEqual(4);

  const low = await get((p) => {
    p.setView(0);
    p.prime();
    p.renderFrames(1);
    return p.stats();
  });
  expect(low.chunks).toBe(22 * 22);
  expect(low.visibleChunks).toBeGreaterThan(0);
  expect(low.triangles).toBeGreaterThan(10_000);
  expect(low.triangles).toBeLessThan(1_500_000);
  expect(low.pending).toBe(0);

  // Higher LOD bias → more chunks at fine LODs from the same viewpoint.
  const ultra = await get((p) => {
    p.setQuality('ultra');
    p.prime();
    p.renderFrames(1);
    return p.stats();
  });
  const fine = (s: TerrainStats) => s.lodCounts[0]! + s.lodCounts[1]!;
  expect(fine(ultra)).toBeGreaterThan(fine(low));
  expect(ultra.triangles).toBeLessThan(1_500_000);

  // Streaming along the highway builds chunk LODs incrementally.
  const stream = await get((p) => p.streamTest(240, 60));
  expect(stream.builds).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
