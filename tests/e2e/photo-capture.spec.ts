import { expect, test } from '@playwright/test';

/**
 * P7 R2 photo capture fidelity: a PNG capture must match the on-screen frame in tone and colour
 * (just sharper at a higher scale). Photo mode on the arena (DoF on, grain off so frames are
 * repeatable), the render loop held: one on-screen frame read back from the canvas, then captures
 * at the screen's own pixel ratio (must be identical), at 1× and at 2× the CSS size.
 *
 * Stats per band (top / middle / bottom thirds), on a 192×108 grid built with an exact
 * area-average box filter written here (the canvas drawImage filter blends mip levels by the
 * downscale factor, so two sources of different sizes were filtered differently): mean R, G, B,
 * the luminance standard deviation and the 5–95 % luminance spread.
 *
 * Matched effective resolution: the on-screen frame is drawn at the (software-GL capped) screen
 * ratio (0.5: 480×270), so a 1× / 2× capture samples the scene 2–4× more densely, and thin bright
 * lines / sub-pixel edges keep full contrast when point-sampled but are diluted when
 * area-averaged. A capture of a different size is therefore first point-sampled at the screen's
 * own pixel centres (the screen frame's sampling density), then goes through the same box filter;
 * the screen-ratio capture is compared as-is (strict).
 *
 * The spread's percentiles are each the mean of a ±2.5 % window of the sorted samples: on this
 * frame the 5th percentile sits on a steep step of the histogram (the dark car body: 50 → 70
 * between the 4th and 6th percentile), where a single-sample quantile moved by 5–9 levels between
 * renders of the same frame at different resolutions (CI: 8.96 against a tolerance of 6).
 *
 * Posterization: the stats above are averages and barely move under banding, so each band also
 * counts the distinct 8-bit levels per channel inside its 2–98 % range, on the full-resolution
 * pixels. A capture must use about as many levels as the screen frame (32-level quantization
 * drops occupancy from ~1 to ~0.2).
 */
interface Stats {
  [band: string]: { r: number; g: number; b: number; sd: number; spread: number; levels: number };
}
interface G {
  ready: boolean;
  hold: boolean;
  renderOnce(settle?: number): void;
  vehicle: unknown;
  replay: { state: { frames: number } };
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
  // Backspace opens the replay only once the live buffer holds frames (else "NOTHING TO REPLAY YET"):
  // under software GL on a loaded box main records ~1 frame per rendered frame, so wait for them.
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.replay.state.frames >= 10, null, { timeout: 120_000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.state.open, null, { timeout: 30_000 });
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.state.photo, null, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.replayUi!.setPhoto({ grain: 0, preset: 'film', vignette: 0.4 }));
  await page.waitForTimeout(1500);

  const result = await page.evaluate(async () => {
    interface Img {
      w: number;
      h: number;
      d: Uint8ClampedArray;
    }
    const decode = async (src: string): Promise<Img> => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data };
    };
    /** Point-sample `im` at the pixel centres of a w×h grid (the screen frame's sampling density). */
    const resample = (im: Img, w: number, h: number): Img => {
      if (im.w === w && im.h === h) return im;
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(im.h - 1, Math.floor(((y + 0.5) * im.h) / h));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(im.w - 1, Math.floor(((x + 0.5) * im.w) / w));
          const i = (sy * im.w + sx) * 4;
          const o = (y * w + x) * 4;
          d[o] = im.d[i]!;
          d[o + 1] = im.d[i + 1]!;
          d[o + 2] = im.d[i + 2]!;
          d[o + 3] = 255;
        }
      }
      return { w, h, d };
    };
    /** Exact area-average (fractional box filter) to W×H, RGB floats. */
    const box = (im: Img, W: number, H: number): Float64Array => {
      const out = new Float64Array(W * H * 3);
      const fx = im.w / W;
      const fy = im.h / H;
      for (let oy = 0; oy < H; oy++) {
        const y0 = oy * fy;
        const y1 = y0 + fy;
        for (let ox = 0; ox < W; ox++) {
          const x0 = ox * fx;
          const x1 = x0 + fx;
          let r = 0;
          let g = 0;
          let b = 0;
          let wt = 0;
          for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
            const wy = Math.min(y + 1, y1) - Math.max(y, y0);
            for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
              const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy;
              const i = (y * im.w + x) * 4;
              r += im.d[i]! * w;
              g += im.d[i + 1]! * w;
              b += im.d[i + 2]! * w;
              wt += w;
            }
          }
          const o = (oy * W + ox) * 3;
          out[o] = r / wt;
          out[o + 1] = g / wt;
          out[o + 2] = b / wt;
        }
      }
      return out;
    };
    /** Lowest per-channel fraction of 8-bit levels used inside the band's 2–98 % range (1 = no gaps). */
    const levels = (im: Img, f0: number, f1: number): number => {
      let worst = 1;
      for (let ch = 0; ch < 3; ch++) {
        const hist = new Uint32Array(256);
        let n = 0;
        for (let y = Math.round(im.h * f0); y < Math.round(im.h * f1); y++)
          for (let x = 0; x < im.w; x++, n++) hist[im.d[(y * im.w + x) * 4 + ch]!]!++;
        let lo = 0;
        for (let c = 0; lo < 255 && (c += hist[lo]!) <= n * 0.02; ) lo++;
        let hi = 255;
        for (let c = 0; hi > 0 && (c += hist[hi]!) <= n * 0.02; ) hi--;
        if (hi - lo < 24) continue; // too flat to tell
        let used = 0;
        for (let v = lo; v <= hi; v++) if (hist[v]! > 0) used++;
        worst = Math.min(worst, used / (hi - lo + 1));
      }
      return worst;
    };
    const stats = (full: Img, screen: Img): Stats => {
      const W = 192;
      const H = 108;
      const px = box(resample(full, screen.w, screen.h), W, H);
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
            const i = (y * W + x) * 3;
            r += px[i]!;
            gg += px[i + 1]!;
            b += px[i + 2]!;
            lum.push(0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!);
          }
        const n = lum.length;
        const mean = lum.reduce((a, v) => a + v, 0) / n;
        const sd = Math.sqrt(lum.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n);
        lum.sort((a, v) => a - v);
        // the 5th / 95th percentile, each averaged over a ±2.5 % window of the sorted samples
        const pct = (q: number): number => {
          let sum = 0;
          const i1 = Math.floor(n * (q + 0.025));
          for (let i = Math.floor(n * (q - 0.025)); i < i1; i++) sum += lum[i]!;
          return sum / (i1 - Math.floor(n * (q - 0.025)));
        };
        out[band] = {
          r: r / n,
          g: gg / n,
          b: b / n,
          sd,
          spread: pct(0.95) - pct(0.05),
          levels: levels(full, y0 / H, y1 / H),
        };
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
    const screen = await decode(screenUrl);
    const shots: { scale: number; width: number; height: number; url: string; stats: Stats }[] = [];
    for (const scale of [ratio, 1, 2]) {
      const r = await c.replayUi!.capture(scale);
      const url = await blobUrl();
      shots.push({ scale, width: r.width, height: r.height, url, stats: stats(await decode(url), screen) });
    }
    return { ratio, screen: { url: screenUrl, width: screen.w, height: screen.h, stats: stats(screen, screen) }, shots };
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
  // in the HTML report CI uploads on failure
  await info.attach('screen', { path: info.outputPath('screen.png'), contentType: 'image/png' });
  for (const s of result.shots) await info.attach(`capture-${s.scale}x`, { path: info.outputPath(`capture-${s.scale}x.png`), contentType: 'image/png' });
  const fmt = (st: Stats): string =>
    Object.entries(st)
      .map(([k, v]) => `${k} rgb ${v.r.toFixed(1)}/${v.g.toFixed(1)}/${v.b.toFixed(1)} sd ${v.sd.toFixed(2)} spread ${v.spread.toFixed(2)} levels ${v.levels.toFixed(2)}`)
      .join(' | ');
  console.log(`[e2e] screen ratio ${result.ratio} (${result.screen.width}×${result.screen.height}): ${fmt(result.screen.stats)}`);
  for (const s of result.shots) console.log(`[e2e] capture ${s.scale}× (${s.width}×${s.height}): ${fmt(s.stats)}`);

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
      // no banding: as many distinct levels as the screen frame (which itself must be smooth)
      expect(a.levels, msg).toBeGreaterThan(0.7);
      expect(b.levels, msg).toBeGreaterThan(exact ? a.levels - 0.01 : a.levels * 0.85);
    }
  }
});
