#!/usr/bin/env node
/**
 * Perf probe: loads the game in headless Chromium (SwiftShader, the CI GPU)
 * with ?perf=1, waits for the loop, samples window.__crumple.perf and prints
 * fps, main-thread ms per subsystem, draw calls / triangles per pass and the
 * loading-screen stages as JSON.
 *
 *   node tools/perf-probe.mjs [--url http://localhost:4173/crumple/] [--q low]
 *        [--size 1280x720] [--seconds 6] [--extra "&body=0"] [--drive]
 *
 * Serve the app first (`npx vite preview --port 4173` after a build, or
 * `npm run dev`). --drive holds W during sampling.
 */
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const url = opt('url', 'http://localhost:4173/crumple/');
const q = opt('q', 'low');
const [w, h] = opt('size', '1280x720').split('x').map(Number);
const seconds = Number(opt('seconds', '6'));
const extra = opt('extra', '');
const perfMode = opt('perf', '1');
const drive = args.includes('--drive');
const gpu = args.includes('--gpu');

const browser = await chromium.launch({
  args: gpu ? [] : ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const t0 = Date.now();
await page.goto(`${url}?q=${q}&perf=${perfMode}${extra}`);
await page.waitForFunction(() => window.__crumple?.ready === true, null, { timeout: 300_000 });
const readyS = (Date.now() - t0) / 1000;
await page.waitForTimeout(2000);
if (drive) await page.keyboard.down('KeyW');
// Count frames over the window from the page clock.
const frames0 = await page.evaluate(() => {
  window.__probeFrames = 0;
  const tick = () => {
    window.__probeFrames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return performance.now();
});
await page.waitForTimeout(seconds * 1000);
const out = await page.evaluate((start) => {
  const c = window.__crumple;
  return { frames: window.__probeFrames, ms: performance.now() - start, perf: c.perf, loadMs: c.stats.loadMs, body: c.body };
}, frames0);
if (drive) await page.keyboard.up('KeyW');
await browser.close();
const fps = (out.frames / out.ms) * 1000;
console.log(
  JSON.stringify(
    {
      q,
      size: `${w}x${h}`,
      measuredFps: Math.round(fps * 100) / 100,
      readyS,
      loadMs: Math.round(out.loadMs),
      ...out.perf,
      errors,
    },
    null,
    1,
  ),
);
