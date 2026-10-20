import { expect, test } from '@playwright/test';

/**
 * P7 R2 photo capture fidelity: a PNG capture must match the on-screen frame in tone and colour
 * (just sharper at a higher scale). Photo mode on the arena (DoF on, grain off so frames are
 * repeatable), the render loop held: one on-screen frame read back from the canvas, then captures
 * at the screen's own pixel ratio (must be identical), at 1× and at 2× the CSS size. Each image is
 * downsampled to 192×108 and compared per band (top / middle / bottom thirds): mean R, G, B, the
 * luminance standard deviation and the 5–95 % luminance spread.
 */
interface Stats {
  [band: string]: { r: number; g: number; b: number; sd: number; spread: number };
}
interface G {
  ready: boolean;
  hold: boolean;
  renderOnce(settle?: number): void;
  vehicle: unknown;
  replayUi: { state: { open: boolean; photo: boolean }; setPhoto(p: Record<string, unknown>): void; capture(scale?: number): Promise<{ width: number; height: number }> } | null;
  debug: { renderer: { domElement: HTMLCanvasElement; getPixelRatio(): number } };
}

test('photo capture matches the on-screen frame (1× / 2× / screen ratio)', async ({ page }, info) => {
  test.setTimeout(400_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/crumple/?q=low&spawn=arena&traffic=0');
  await page.waitForFunction(() => {
    const c = (window as unknown as { __crumple?: G }).__crumple;
    return !!c && c.ready && c.vehicle !== null && c.replayUi !== null;
  }, null, { timeout: 180_000 });
  await page.waitForTimeout(4000);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.state.open, null, { timeout: 30_000 });
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.state.photo, null, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.setPhoto({ grain: 0, preset: 'film', vignette: 0.4 }));
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async () => {
    const stats = async (src: string): Promise<Stats> => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const W = 192;
      const H = 108;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const g = cv.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const out: Stats = {};
      for (const [band, y0, y1] of [
        ['top', 0, 36],
        ['mid', 36, 72],
        ['bot', 72, 108],
      ] as const) {
        let r = 0;
        let gg = 0;
        let b = 0;
        const lum: number[] = [];
        for (let y = y0; y < y1; y++)
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            r += d[i]!;
            gg += d[i + 1]!;
            b += d[i + 2]!;
            lum.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
          }
        const n = lum.length;
        const mean = lum.reduce((a, v) => a + v, 0) / n;
        const sd = Math.sqrt(lum.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n);
        lum.sort((a, v) => a - v);
        out[band] = { r: r / n, g: gg / n, b: b / n, sd, spread: lum[Math.floor(n * 0.95)]! - lum[Math.floor(n * 0.05)]! };
      }
      return out;
    };
    const blobUrl = async (): Promise<string> => {
      const a = document.querySelector<HTMLAnchorElement>('[data-testid="photo-download"]')!;
      const blob = await (await fetch(a.href)).blob();
      return new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result as string);
        fr.readAsDataURL(blob);
      });
    };
    const c = (window as unknown as { __crumple: G }).__crumple;
    c.hold = true;
    c.renderOnce(0);
    const screenUrl = c.debug.renderer.domElement.toDataURL('image/png');
    const ratio = c.debug.renderer.getPixelRatio();
    const shots: { scale: number; width: number; height: number; url: string; stats: Stats }[] = [];
    for (const scale of [ratio, 1, 2]) {
      const r = await c.replayUi!.capture(scale);
      const url = await blobUrl();
      shots.push({ scale, width: r.width, height: r.height, url, stats: await stats(url) });
    }
    return { ratio, screen: { url: screenUrl, stats: await stats(screenUrl) }, shots };
  });

  // (no @types/node in this project: the node modules are reached untyped)
  const fsMod = 'node:fs';
  const { writeFileSync } = (await import(fsMod)) as { writeFileSync(p: string, d: unknown): void };
  const NodeBuffer = (globalThis as unknown as { Buffer: { from(s: string, enc: string): unknown } }).Buffer;
  const save = async (name: string, url: string): Promise<void> => {
    writeFileSync(info.outputPath(name), NodeBuffer.from(url.split(',')[1]!, 'base64'));
  };
  await save('screen.png', result.screen.url);
  for (const s of result.shots) await save(`capture-${s.scale}x.png`, s.url);

  for (const s of result.shots) {
    expect(s.width).toBe(Math.round(960 * s.scale));
    const exact = s.scale === result.ratio;
    for (const band of ['top', 'mid', 'bot']) {
      const a = result.screen.stats[band]!;
      const b = s.stats[band]!;
      const tol = exact ? 0.5 : 3;
      const msg = `${s.scale}× ${band}: screen ${JSON.stringify(a)} vs capture ${JSON.stringify(b)}`;
      expect(Math.abs(a.r - b.r), msg).toBeLessThan(tol);
      expect(Math.abs(a.g - b.g), msg).toBeLessThan(tol);
      expect(Math.abs(a.b - b.b), msg).toBeLessThan(tol);
      expect(Math.abs(a.sd - b.sd), msg).toBeLessThan(exact ? 0.5 : 2.5);
      expect(Math.abs(a.spread - b.spread), msg).toBeLessThan(exact ? 1 : 6);
    }
  }
});
