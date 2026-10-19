// Reproducible crash-test screenshots (flexbody / damage visual review).
//
//   node tools/crash-shots.mjs                     # 50 + 80 km/h into the arena wall
//   KMH=80 TAG=after node tools/crash-shots.mjs    # one speed, file prefix polish-crush-after-*
//   ROOT=/path/to/worktree PORT=4191 node tools/crash-shots.mjs   # serve another checkout (A/B)
//
// Starts its own vite dev server (ROOT, PORT), loads the game in headless
// Chromium (SwiftShader WebGL2; never `playwright install`), removes the arena
// soft cube from the run-up, and per speed: teleports to the arena spawn
// (full repair), shoots the undamaged car, drives straight at the crash wall
// holding the target speed, cuts the throttle 9 m out and runs the impact in
// 0.05× slow motion (so damage events land on the frames that render them),
// then lets the wreck settle and shoots it from fixed world-space orbit
// offsets around the car. Output: OUT/polish-crush-<TAG>-<kmh>-<view>.png.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.ROOT ?? resolve(HERE, '..'));
const require = createRequire(resolve(HERE, '../package.json'));
const { chromium } = require('@playwright/test');

const PORT = Number(process.env.PORT ?? 4190);
const OUT = resolve(process.env.OUT ?? resolve(HERE, '../test-results'));
const TAG = process.env.TAG ?? 'shot';
const SPEEDS = (process.env.KMH ?? '50,80').split(',').map(Number);
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
const SLOWMO_MS = Number(process.env.SLOWMO_MS ?? 40000);
/** World-space camera offsets from the car (car heads −Z into the wall at z ≈ 265). */
const VIEWS = {
  front34: [-3.4, 1.7, -3.9],
  side: [4.6, 1.4, 0.4],
  top: [-1.4, 4.6, -2.6],
};
const BEFORE_VIEWS = { front34: VIEWS.front34, hood: [-1.6, 1.9, -3.0] };

mkdirSync(OUT, { recursive: true });

const vite = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
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
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(240000);
  await page.goto(`http://localhost:${PORT}/crumple/?q=${process.env.Q ?? 'medium'}&spawn=arena`);
  await page.waitForFunction(() => {
    const c = window.__crumple;
    return c && c.ready && c.vehicle && c.position;
  }, null, { timeout: 240000 });
  const C = 'window.__crumple';
  const ev = (s) => page.evaluate(s);
  await ev(`${C}.debug.client.despawn(2)`); // the arena soft cube sits on the run-up
  await page.keyboard.press('KeyC'); // orbit camera: looks at the car from wherever we put it
  const dmg = `(window.__crumpleDamage || []).find((d) => d.strainBeams.length > 300)`;

  const shoot = async (name, off) => {
    await ev(`${C}.renderOnce()`); // refresh the car pose the camera follows
    await ev(`${C}.settleCamera(6)`);
    await ev(`(() => { const c = ${C}; const p = c.position; c.debug.camera.position.set(p[0] + ${off[0]}, p[1] + ${off[1]}, p[2] + ${off[2]}); })()`);
    await ev(`${C}.renderOnce()`);
    await ev(`${C}.renderOnce()`);
    const path = `${OUT}/polish-crush-${TAG}-${name}.png`;
    await page.screenshot({ path });
    console.log('  wrote', path);
  };
  const damageInfo = () =>
    ev(`(() => { const d = ${dmg}; if (!d) return 'no damage instance'; let ms = 0, mc = 0, ns = 0;
      for (const x of d.strain) { ms = Math.max(ms, x); if (x > 0) ns++; } for (const x of d.scuff) mc = Math.max(mc, x);
      const sk = (window.__crumpleSkins || []).find((s) => s.settle && s.nodeFlags.length > 300);
      const st = sk ? ' settle ' + (sk.settle.calibrated ? 'max ' + (sk.settle.maxOffset * 100).toFixed(1) + ' cm gain ' + sk.settle.strength.toFixed(2) : 'pending') : '';
      return 'strain max ' + ms.toFixed(2) + ' (' + ns + ' nodes) scuff max ' + mc.toFixed(2) + ' broken ' + d.broken.reduce((a, b) => a + b, 0) + st; })()`);

  const arena = await ev(`${C}.spawns.indexOf('arena')`);
  for (const kmh of SPEEDS) {
    const target = kmh / 3.6;
    // Teleport (full repair) and let the car settle with fast small frames, until the skin's
    // settle calibration has run and the repair has cleared the damage state.
    await page.setViewportSize({ width: 320, height: 180 });
    await ev(`${C}.hold = false`);
    await ev(`${C}.spawn(${arena})`);
    await page.waitForTimeout(1500);
    await page
      .waitForFunction(() => {
        const sk = (window.__crumpleSkins || []).find((s) => s.settle && s.nodeFlags.length > 300);
        const d = (window.__crumpleDamage || []).find((x) => x.strainBeams.length > 300);
        return (!sk || (sk.settle.calibrated && sk.settle.strength >= 1)) && (!d || d.strain.every((x) => x === 0));
      }, null, { timeout: 60000, polling: 500 })
      .catch(() => console.log('  (settle/repair wait timed out)'));
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: W, height: H });
    await ev(`${C}.hold = true`);
    console.log(`${kmh} km/h: at rest, ${await damageInfo()}`);
    for (const [name, off] of Object.entries(BEFORE_VIEWS)) await shoot(`${kmh}-before-${name}`, off);

    await ev(`${C}.debug.client.input(1, { throttle: 1, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1 })`);
    await ev(`(() => { const cl = ${C}.debug.client; window.__crash = { done: false, v: 0, z: 0 };
      const id = setInterval(() => { const t = cl.telemetry(1); if (!t) return; const v = t[0], z = t[18];
        window.__crash.v = v; window.__crash.z = z;
        if (z < 274.5) { cl.input(1, { throttle: 0 }); cl.setTimescale(0.05); window.__crash.done = true; clearInterval(id); return; }
        cl.drainEvents({}); cl.input(1, { throttle: v < ${target} - 0.3 ? 1 : v < ${target} ? 0.3 : 0 }); }, 5); })()`);
    await page.waitForFunction(() => window.__crash.done, null, { timeout: 180000 });
    const { v } = await ev('window.__crash');
    console.log(`  impact at ${(v * 3.6).toFixed(1)} km/h`);
    // Slow motion through the impact with a small viewport (frames are slow in SwiftShader).
    await page.setViewportSize({ width: 320, height: 180 });
    await ev(`${C}.hold = false`);
    await page.waitForTimeout(SLOWMO_MS);
    await ev(`${C}.debug.client.setTimescale(1)`);
    await page.waitForTimeout(3000);
    await page.setViewportSize({ width: W, height: H });
    await ev(`${C}.hold = true`);
    console.log(`  after: ${await damageInfo()} telemetry damage ${(await ev(`${C}.vehicle.damage`)).toFixed(3)}`);
    if (process.env.SCUFF) console.log('  scuffed nodes', await ev(`(() => { const d = ${dmg}; const o = []; d.scuff.forEach((x, i) => { if (x > 0.3) o.push(i + ':' + x.toFixed(2)); }); return o.join(' '); })()`));
    for (const [name, off] of Object.entries(VIEWS)) await shoot(`${kmh}-${name}`, off);
  }
  if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
  vite.kill();
}
