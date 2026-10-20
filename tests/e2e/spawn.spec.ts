import { expect, test, type Page } from '@playwright/test';

/**
 * Spawning never damages the car: teleport through the pause menu to every
 * layout spawn point (each one from a different heading) and swap vehicles
 * through the showroom DRIVE button; after each, the car is pristine — no
 * telemetry damage, no plastic-strain shading, no cracked / shattered glass,
 * no hidden panels. The DRIVE part re-spawns the same sedan at another
 * start point (same node count: the respawn must not be interpolated from the
 * old car); SPAWN_FLEET=1 drives every vehicle first (≈ 25 min under
 * SwiftShader). Screenshots of every spawn for review: SPAWN_SHOTS=<dir>.
 */
interface SpawnGlobal {
  ready: boolean;
  mode: string;
  paused: boolean;
  tick: number;
  spawns: string[];
  spawnIndex: number;
  vehicle: { speed: number; damage: number } | null;
  player: { id: string; swaps: number } | null;
  showroom: { open: boolean; busy: boolean; selection: { id: string } | null; studioVehicle: string | null };
  debug: {
    damageSums(): { strain: number; scuff: number; hidden: number } | null;
    playerVisual: { damage: { crack: Float32Array; strain: Float32Array; panelCount: number } } | null;
  };
}

const waitFor = (page: Page, expr: string, timeout = 60_000) =>
  page.waitForFunction(`(() => { const c = window.__crumple; return ${expr}; })()`, null, { timeout, polling: 100 });

interface Health {
  spawn: string;
  vehicle: string;
  damage: number;
  strain: number;
  maxStrain: number;
  scuff: number;
  hidden: number;
  crack: number;
}

const health = (page: Page): Promise<Health> =>
  page.evaluate(() => {
    const c = (window as unknown as { __crumple: SpawnGlobal }).__crumple;
    const s = c.debug.damageSums();
    const pv = c.debug.playerVisual;
    let crack = 0;
    let maxStrain = 0;
    if (pv) {
      for (let i = 0; i < pv.damage.crack.length; i++) crack += pv.damage.crack[i]!;
      for (let i = 0; i < pv.damage.strain.length; i++) maxStrain = Math.max(maxStrain, pv.damage.strain[i]!);
    }
    return {
      spawn: c.spawns[c.spawnIndex]!,
      vehicle: c.player ? c.player.id : '?',
      damage: c.vehicle ? c.vehicle.damage : NaN,
      strain: s ? s.strain : NaN,
      maxStrain,
      scuff: s ? s.scuff : NaN,
      hidden: s ? s.hidden : NaN,
      crack,
    };
  });

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const shots = env.SPAWN_SHOTS;

async function settleAndCheck(page: Page, label: string, rows: Health[]): Promise<void> {
  // ≥ 1.5 s of sim after the spawn (the 0.4 s settle window, the drop onto the suspension, the bounce).
  const t0 = (await page.evaluate(() => (window as unknown as { __crumple: SpawnGlobal }).__crumple.tick)) as number;
  await waitFor(page, `c.tick > ${t0 + 3000}`, 60_000);
  const h = await health(page);
  rows.push(h);
  console.log(
    `${label.padEnd(26)} damage ${(h.damage * 100).toFixed(3)} %  Σstrain ${h.strain.toFixed(3)} (max ${h.maxStrain.toFixed(3)})  Σscuff ${h.scuff.toFixed(3)}  hidden ${h.hidden}  Σcrack ${h.crack.toFixed(3)}`,
  );
  if (shots) await page.screenshot({ path: `${shots}/${label}.png` });
}

test('spawn: teleporting to every spawn point and swapping vehicles leaves the car pristine', async ({ page }) => {
  test.setTimeout(env.SPAWN_FLEET ? 2_400_000 : 900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 800, height: 450 });
  await page.goto('/crumple/?q=low&traffic=0&spawn=arena&vehicle=sedan');
  await waitFor(page, 'c && c.ready === true && c.mode === "drive" && c.vehicle !== null', 180_000);
  const rows: Health[] = [];
  await settleAndCheck(page, 'sedan-boot-arena', rows);

  const spawns = (await page.evaluate(() => (window as unknown as { __crumple: SpawnGlobal }).__crumple.spawns)) as string[];
  expect(spawns.length).toBeGreaterThanOrEqual(8);
  // Pause menu → Spawn point → each card (from the previous spawn: a different heading every time).
  const order = [...spawns.slice(1), spawns[0]!];
  for (const id of order) {
    await page.keyboard.press('Escape');
    await waitFor(page, 'c.mode === "pause"');
    await page.getByTestId('pause-spawn').click();
    await page.locator(`.pm-spawn[data-spawn="${id}"]`).click();
    await waitFor(page, `c.mode === "drive" && !c.paused && c.spawns[c.spawnIndex] === ${JSON.stringify(id)}`);
    await settleAndCheck(page, `sedan-menu-${id}`, rows);
  }

  // Showroom DRIVE at another start point: the sedan again (same body → same node count); with
  // SPAWN_FLEET=1 every other vehicle first, then the sedan twice.
  const vehicles = env.SPAWN_FLEET ? ['coupe', 'pickup', 'boxtruck', 'beater', 'sedan', 'sedan'] : ['sedan'];
  for (let k = 0; k < vehicles.length; k++) {
    const id = vehicles[k]!;
    await page.keyboard.press('Escape');
    await waitFor(page, 'c.mode === "pause"');
    await page.getByTestId('pause-vehicle').click();
    await waitFor(page, 'c.mode === "showroom" && c.showroom.open && !c.showroom.busy && c.showroom.studioVehicle !== null', 180_000);
    const tile = page.locator(`.sr-tile[data-vehicle="${id}"]`);
    if ((await tile.count()) > 0) await tile.click();
    await waitFor(page, `!c.showroom.busy && c.showroom.selection && c.showroom.selection.id === ${JSON.stringify(id)} && c.showroom.studioVehicle === ${JSON.stringify(id)}`, 180_000);
    // A different start point than the current one (cycles 3 ahead).
    for (let n = 0; n < 3; n++) await page.locator('.sr-spawn-arrow').nth(1).click();
    const swaps = ((await page.evaluate(() => (window as unknown as { __crumple: SpawnGlobal }).__crumple.player?.swaps)) as number) ?? 0;
    await page.getByTestId('showroom-drive').click();
    await waitFor(page, `c.mode === "drive" && c.player.swaps === ${swaps + 1} && c.player.id === ${JSON.stringify(id)} && c.vehicle !== null`, 180_000);
    const at = (await page.evaluate(() => {
      const c = (window as unknown as { __crumple: SpawnGlobal }).__crumple;
      return c.spawns[c.spawnIndex]!;
    })) as string;
    await settleAndCheck(page, `${id}-drive-${at}`, rows);
  }

  for (const h of rows) {
    expect(h.damage, `${h.vehicle} @ ${h.spawn}: telemetry damage`).toBe(0);
    expect(h.hidden, `${h.vehicle} @ ${h.spawn}: hidden panels (shattered glass)`).toBe(0);
    expect(h.crack, `${h.vehicle} @ ${h.spawn}: cracked glass`).toBe(0);
    expect(h.maxStrain, `${h.vehicle} @ ${h.spawn}: plastic strain shading`).toBeLessThan(0.05);
  }
  expect(errors).toEqual([]);
});
