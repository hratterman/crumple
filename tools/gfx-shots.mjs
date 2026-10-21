// Reproducible rendering-review screenshots (time of day, weather, night lights, car close-ups).
//
//   node tools/gfx-shots.mjs                          # every scene below at 960×540, quality high
//   W=1920 H=1080 Q=ultra TAG=final node tools/gfx-shots.mjs
//   ONLY=valley-noon,town-rain-night node tools/gfx-shots.mjs
//   ROOT=/path/to/worktree PORT=4291 OUT=/tmp/shots node tools/gfx-shots.mjs
//
// Starts its own vite dev server (ROOT, PORT), loads the game in headless Chromium (SwiftShader
// WebGL2; never `playwright install`), places the player car per scene, pins the camera, sets the
// time of day / weather through `window.__crumple.env` (when the build has it) and writes
// OUT/<TAG>-<scene>.png. Frames are drawn with the loop held (`renderOnce`), several times so
// temporal effects (TAA history, eye adaptation) converge.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.ROOT ?? resolve(HERE, '..'));
const require = createRequire(resolve(HERE, '../package.json'));
const { chromium } = require('@playwright/test');

const PORT = Number(process.env.PORT ?? 4290);
const OUT = resolve(process.env.OUT ?? resolve(HERE, '../test-results/gfx'));
const TAG = process.env.TAG ?? 'shot';
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const Q = process.env.Q ?? 'high';
const FRAMES = Number(process.env.FRAMES ?? 6);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

/** Car placements: world (x, z), yaw deg (0 = −Z, 90 = −X). */
const PLACES = {
  valley: { x: -10, z: 50, yaw: -135 },
  town: { x: 150, z: 300, yaw: 0 },
  arena: { x: 360, z: 330, yaw: 0 },
  summit: { x: 166, z: -356, yaw: 185 },
};
/** Camera relative to the car: [right, up, back] m in the car frame, look-at offset up m. */
const CHASE = { off: [2.2, 1.6, 6.5], look: 0.7 };
const CLOSE = { off: [-3.6, 1.2, -3.2], look: 0.55 };
const SIDE = { off: [4.4, 0.9, 0.2], look: 0.5 };
const WHEEL = { off: [1.9, 0.45, -1.3], look: 0.35, aim: [0.85, 0, -1.3] };
const SKY = { off: [1.5, 1.4, 7], look: 9 };

const SCENES = [
  { name: 'valley-dawn', place: 'valley', cam: CHASE, env: { time: 5.15 } },
  { name: 'valley-noon', place: 'valley', cam: CHASE, env: { time: 12.5 } },
  { name: 'valley-golden', place: 'valley', cam: CHASE, env: { time: 18.45 } },
  { name: 'valley-dusk', place: 'valley', cam: CHASE, env: { time: 19.45 } },
  { name: 'valley-night', place: 'valley', cam: CHASE, env: { time: 23.2, headlights: 'low' } },
  { name: 'valley-night-high', place: 'valley', cam: CHASE, env: { time: 23.2, headlights: 'high' } },
  { name: 'valley-night-beam', place: 'valley', cam: { off: [0, 4.5, 3.5], look: -1.5, aim: [0, 0, -14] }, env: { time: 23.2, headlights: 'low' } },
  { name: 'town-rain-day', place: 'town', cam: CHASE, env: { time: 14, weather: 'rain' } },
  { name: 'town-rain-night', place: 'town', cam: CHASE, env: { time: 22.5, weather: 'rain', headlights: 'low' } },
  { name: 'town-night', place: 'town', cam: CHASE, env: { time: 22.5, headlights: 'low' } },
  { name: 'town-streetlight', place: 'town', abs: { pos: [151, 16, 318], target: [146, 10.5, 298] }, env: { time: 22.5, headlights: 'off' } },
  { name: 'clouds', place: 'valley', cam: SKY, env: { time: 16, weather: 'cloudy' } },
  { name: 'fog', place: 'valley', cam: CHASE, env: { time: 9, weather: 'fog' } },
  { name: 'car-close', place: 'arena', cam: CLOSE, env: { time: 17.2 } },
  { name: 'car-side', place: 'arena', cam: SIDE, env: { time: 11 } },
  { name: 'car-wheel', place: 'arena', cam: WHEEL, env: { time: 15 } },
  { name: 'car-close-wet', place: 'arena', cam: CLOSE, env: { time: 13, weather: 'rain' } },
  { name: 'arena-backlit', place: 'arena', cam: { off: [0, 1.5, -8], look: 1 }, env: { time: 18.4 } },
];

mkdirSync(OUT, { recursive: true });

// frozen config: no HMR / file watching, so edits in the worktree never reload the page mid-run
const vite = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort', '--config', resolve(HERE, 'vite.frozen.config.mjs')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('vite did not start')), 60000);
  const on = (b) => {
    if (String(b).includes(`localhost:${PORT}`)) {
      clearTimeout(t);
      ok();
    }
  };
  vite.stdout.on('data', on);
  vite.stderr.on('data', (b) => process.stderr.write(b));
  vite.on('exit', (c) => fail(new Error(`vite exited ${c}`)));
});

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(300000);
  await page.goto(`http://localhost:${PORT}/crumple/?q=${Q}&swcap=0&traffic=${process.env.TRAFFIC ?? '0'}&audio=0&crashcam=0&spawn=arena${process.env.EXTRA ?? ''}`);
  await page.waitForFunction(() => {
    const c = window.__crumple;
    return c && c.ready && c.vehicle && c.position;
  }, null, { timeout: 300000 });
  const C = 'window.__crumple';
  const ev = (s) => page.evaluate(s);
  await ev(`${C}.debug.client.despawn(2)`); // the arena soft cube
  // review shots: the canvas only (no HUD / toasts)
  await page.addStyleTag({ content: 'body > *:not(canvas) { display: none !important; }' });
  let placed = '';
  for (const sc of SCENES) {
    if (ONLY && !ONLY.has(sc.name)) continue;
    if (placed !== sc.place) {
      const p = PLACES[sc.place];
      await page.setViewportSize({ width: 320, height: 180 });
      await ev(`${C}.hold = false`);
      await ev(`${C}.place(${p.x}, ${p.z}, ${p.yaw})`);
      // the teleport lands a few snapshots later: wait until the pose is there and has settled
      await page.waitForFunction(
        ([x, z]) => {
          const q = window.__crumple.position;
          return q && Math.hypot(q[0] - x, q[2] - z) < 6;
        },
        [p.x, p.z],
        { timeout: 240000, polling: 500 },
      );
      await page.waitForTimeout(4000);
      placed = sc.place;
    }
    await ev(`${C}.hold = true`);
    await page.setViewportSize({ width: W, height: H });
    // every scene states its whole environment (clear, dry, auto headlights unless it says otherwise)
    const env = JSON.stringify({ weather: 'clear', wetness: null, headlights: 'auto', ...(sc.env ?? {}) });
    await ev(`(() => { const e = ${C}.env; if (e) e.set(${env}); })()`);
    // camera in the car frame (yaw only): right = (cos y, 0, -sin y)·…; car forward = (-sin y, 0, -cos y)
    const p = PLACES[sc.place];
    const cam = sc.cam;
    if (sc.abs) await ev(`${C}.pinCamera(${JSON.stringify(sc.abs.pos)}, ${JSON.stringify(sc.abs.target)})`);
    else await ev(`(() => {
      const c = ${C}; const pos = c.position; const y = ${p.yaw} * Math.PI / 180;
      const fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
      const o = ${JSON.stringify(cam.off)}; const a = ${JSON.stringify(cam.aim ?? [0, 0, 0])};
      const cx = pos[0] + rx * o[0] - fx * o[2], cz = pos[2] + rz * o[0] - fz * o[2];
      const tx = pos[0] + rx * a[0] - fx * a[2], tz = pos[2] + rz * a[0] - fz * a[2];
      c.pinCamera([cx, pos[1] + o[1], cz], [tx, pos[1] + ${cam.look}, tz]);
    })()`);
    for (let i = 0; i < FRAMES; i++) await ev(`${C}.renderOnce()`);
    const path = `${OUT}/${TAG}-${sc.name}.png`;
    await page.screenshot({ path });
    const ex = await ev(`(() => { const p = ${C}.debug.post; const a = p && p.debug && p.debug.autoExposure; return a ? ' exposure ×' + Number(a.value).toFixed(2) + ' (target ' + Number(a.target).toFixed(2) + ', log2 lum ' + Number(a.log2Lum).toFixed(2) + ', reads ' + a.reads + ')' : ''; })()`);
    const nl = await ev(`(() => { const n = ${C}.debug.nightLights; return n ? ' lights ' + n.stats.lights + ' (streetlights ' + n.stats.streetlights + ')' : ''; })()`);
    console.log('wrote', path + ex + nl);
  }
  if (errors.length) console.log('page errors:\n' + errors.slice(0, 12).join('\n'));
} finally {
  await browser.close();
  vite.kill();
}
