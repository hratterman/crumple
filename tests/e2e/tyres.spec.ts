import { expect, test, type Page } from '@playwright/test';

/**
 * R-TYRE: the per-wheel telemetry section reaches main (TPMS, temperatures,
 * tread), and the logged tyre service works end to end: a cut deflates the
 * front-left tyre (FLAT + TPMS flags), a repair re-inflates it.
 */
interface Wheel {
  wheel: number;
  flags: number;
  pressureKpa: number;
  tSurface: number;
  treadMm: number;
  load: number;
}
interface CrumpleTyreGlobal {
  ready: boolean;
  vehicle: unknown;
  tyres: Wheel[];
  setTyre(op: { wheel?: number; puncture?: 'slow' | 'fast' | 'debead'; repair?: boolean }): void;
}
const FLAG_CONTACT = 1 << 0;
const FLAG_FLAT = 1 << 2;
const FLAG_TPMS = 1 << 4;

const tyres = (page: Page): Promise<Wheel[]> => page.evaluate(() => (window as unknown as { __crumple: CrumpleTyreGlobal }).__crumple.tyres);

test('tyres: wheel telemetry, a cut deflates the tyre (FLAT + TPMS), repair re-inflates it', async ({ page }) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setViewportSize({ width: 320, height: 180 });
  await page.goto('/crumple/?q=low&spawn=arena');
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple?: CrumpleTyreGlobal }).__crumple;
      return !!c && c.ready && c.vehicle !== null && c.tyres.length === 4;
    },
    null,
    { timeout: 240_000 }, // layout v6: the 2560 m world takes minutes to generate on a loaded box
  );
  await page.waitForTimeout(1500);
  const t0 = await tyres(page);
  expect(t0.map((w) => w.wheel)).toEqual([0, 1, 2, 3]);
  for (const w of t0) {
    expect(w.flags & FLAG_CONTACT).not.toBe(0);
    expect(w.flags & (FLAG_FLAT | FLAG_TPMS)).toBe(0);
    expect(w.pressureKpa).toBeGreaterThan(200);
    expect(w.pressureKpa).toBeLessThan(270);
    expect(w.treadMm).toBeGreaterThan(5);
    expect(w.load).toBeGreaterThan(1000);
  }

  await page.evaluate(() => (window as unknown as { __crumple: CrumpleTyreGlobal }).__crumple.setTyre({ wheel: 0, puncture: 'fast' }));
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __crumple: CrumpleTyreGlobal }).__crumple.tyres[0];
      return !!w && (w.flags & (1 << 2)) !== 0 && (w.flags & (1 << 4)) !== 0;
    },
    null,
    { timeout: 20_000, polling: 100 },
  );
  const flat = await tyres(page);
  expect(flat[0]!.pressureKpa).toBeLessThan(25);
  expect(flat[1]!.flags & FLAG_FLAT).toBe(0);

  await page.evaluate(() => (window as unknown as { __crumple: CrumpleTyreGlobal }).__crumple.setTyre({ wheel: 0, repair: true }));
  await page.waitForFunction(
    () => {
      const w = (window as unknown as { __crumple: CrumpleTyreGlobal }).__crumple.tyres[0];
      return !!w && w.pressureKpa > 200 && (w.flags & (1 << 2)) === 0;
    },
    null,
    { timeout: 20_000, polling: 100 },
  );
  expect(errors).toEqual([]);
});
