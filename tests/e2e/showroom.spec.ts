import { expect, test, type Page } from '@playwright/test';

/**
 * P6 S1: pause menu + showroom + vehicle swap (docs/CONTRACTS.md "Showroom +
 * vehicle select"). One boot (SwiftShader boots are the expensive part):
 * Escape pauses (the sim tick stops), the showroom opens from the menu, a
 * paint is picked, DRIVE swaps the player car (despawn + spawn) with that
 * paint and it drives; a reload keeps the choice.
 */
interface CrumpleGlobal {
  ready: boolean;
  tick: number;
  mode: string;
  paused: boolean;
  vehicle: { speed: number } | null;
  player: { id: string; palette: string; paletteHex: number; paintHex: number | null; swaps: number } | null;
  showroom: { open: boolean; busy: boolean; selection: { id: string; palette: string } | null; studioVehicle: string | null };
  hudSpec: { speedoMax?: number; redlineRpm: number } | null;
}

/** A serializable snapshot of the hooks (the global itself holds functions and renderer handles). */
const g = (page: Page): Promise<CrumpleGlobal> =>
  page.evaluate(() => {
    const c = (window as unknown as { __crumple: CrumpleGlobal }).__crumple;
    return { ready: c.ready, tick: c.tick, mode: c.mode, paused: c.paused, vehicle: c.vehicle, player: c.player, showroom: c.showroom, hudSpec: c.hudSpec };
  });
const waitFor = (page: Page, fn: string, timeout = 120_000) => page.waitForFunction(`(() => { const c = window.__crumple; return ${fn}; })()`, null, { timeout });

test('showroom: Escape pauses, pick a paint, DRIVE swaps the car with it, reload keeps the choice', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/crumple/?q=low&traffic=0');
  await waitFor(page, 'c && c.ready === true && c.mode === "drive" && c.vehicle !== null', 180_000);

  // Per-vehicle HUD gauges: speedo ≥ top speed + 20 %.
  const spec = (await g(page)).hudSpec;
  expect(spec?.speedoMax ?? 0).toBeGreaterThanOrEqual(214 * 1.2);

  // ---- Escape pauses: menu up, the sim tick stops.
  await page.keyboard.press('Escape');
  await waitFor(page, 'c.mode === "pause" && c.paused');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.waitForTimeout(400); // commands in flight
  const t0 = (await g(page)).tick;
  await page.waitForTimeout(1200);
  const t1 = (await g(page)).tick;
  expect(t1 - t0).toBeLessThanOrEqual(2);

  // Escape again resumes: ticks advance.
  await page.keyboard.press('Escape');
  await waitFor(page, 'c.mode === "drive" && !c.paused');
  const t2 = (await g(page)).tick;
  await page.waitForTimeout(1000);
  expect((await g(page)).tick - t2).toBeGreaterThan(300);

  // ---- Showroom from the pause menu.
  await page.keyboard.press('Escape');
  await waitFor(page, 'c.mode === "pause"');
  await page.getByTestId('pause-vehicle').click();
  await waitFor(page, 'c.mode === "showroom" && c.showroom.open && !c.showroom.busy && c.showroom.studioVehicle !== null', 180_000);
  await expect(page.getByTestId('showroom')).toBeVisible();
  // The world is paused while the showroom is open.
  const s0 = (await g(page)).tick;
  await page.waitForTimeout(800);
  expect((await g(page)).tick - s0).toBeLessThanOrEqual(2);

  // Another available vehicle when one exists (fleet units flip them on), else the sedan.
  const other = page.locator('.sr-tile:not(.sr-tile--locked):not(.sr-tile--active)').first();
  if ((await other.count()) > 0) {
    await other.click();
    await waitFor(page, '!c.showroom.busy && c.showroom.studioVehicle === c.showroom.selection.id', 180_000);
  }
  const target = (await g(page)).showroom.selection!;
  // Pick a paint that is not the current one (the second swatch).
  const swatch = page.locator('.sr-swatch').nth(1);
  const paletteId = (await swatch.getAttribute('data-palette'))!;
  await swatch.click();
  await waitFor(page, `c.showroom.selection.palette === ${JSON.stringify(paletteId)}`);
  await expect(swatch).toHaveAttribute('aria-checked', 'true');

  // ---- DRIVE: despawn + spawn with that paint.
  await page.getByTestId('showroom-drive').click();
  await waitFor(page, 'c.mode === "drive" && c.player.swaps === 1 && c.vehicle !== null', 180_000);
  const p = (await g(page)).player!;
  expect(p.id).toBe(target.id);
  expect(p.palette).toBe(paletteId);
  // The paint drawn on the body is the palette's colour.
  expect(p.paintHex).toBe(p.paletteHex);
  await expect(page.getByTestId('showroom')).toBeHidden();

  // It drives: > 5 m/s after ~3 s of throttle (settled first). The worker falls behind real time
  // on a loaded software-GL runner and input reaches it once per (slow) frame, so the speed is
  // polled for up to 12 s of wall time.
  await page.waitForTimeout(1000);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await waitFor(page, 'c.vehicle && c.vehicle.speed > 5', 9000);
  await page.keyboard.up('KeyW');

  // ---- Reload keeps the choice (localStorage).
  await page.reload();
  await waitFor(page, 'c && c.ready === true && c.player !== null', 180_000);
  const q = (await g(page)).player!;
  expect(q.id).toBe(target.id);
  expect(q.palette).toBe(paletteId);
  expect(q.paintHex).toBe(q.paletteHex);

  expect(errors).toEqual([]);
});
