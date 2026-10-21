import { expect, test } from '@playwright/test';

interface AgentRow {
  agent: number;
  objectId: number;
  flags: number;
  pos: number[];
  speed: number;
  soft: boolean;
}
interface TrafficDebug {
  stats: { running: boolean; agents: number; ghosts: number; softBodies: number; awakeRigid: number; ghostDraws: number; pool: number };
  snapshot(): AgentRow[];
}
interface CrumpleTrafficGlobal {
  ready: boolean;
  vehicle: unknown;
  debug: { traffic?: TrafficDebug };
}

const traffic = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const t = (window as unknown as { __crumple: CrumpleTrafficGlobal }).__crumple.debug.traffic!;
    return { stats: { ...t.stats }, agents: t.snapshot() };
  });

test('traffic: AI cars appear and drive along the roads; zero console errors', async ({ page }) => {
  test.setTimeout(420_000); // layout v6: 2560 m world boot on a loaded box
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.stack ?? String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto('/crumple/?q=low');
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple?: CrumpleTrafficGlobal }).__crumple;
      return !!c && c.ready && c.vehicle !== null;
    },
    null,
    { timeout: 150_000 },
  );
  await page.waitForFunction(() => !!(window as unknown as { __crumple: CrumpleTrafficGlobal }).__crumple.debug.traffic?.stats.running, null, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => (window as unknown as { __crumple: CrumpleTrafficGlobal }).__crumple.debug.traffic!.stats.agents > 0, null, {
    timeout: 30_000,
  });

  const a = await traffic(page);
  expect(a.stats.agents).toBeGreaterThanOrEqual(4);
  // Ghost instancing stays within the T2 draw budget.
  expect(a.stats.ghostDraws).toBeLessThanOrEqual(10);
  for (const r of a.agents) expect(r.pos.every(Number.isFinite)).toBe(true);

  await page.waitForTimeout(6000);
  const b = await traffic(page);
  const moved = b.agents.filter((r) => {
    const p = a.agents.find((x) => x.agent === r.agent);
    return p && Math.hypot(r.pos[0]! - p.pos[0]!, r.pos[2]! - p.pos[2]!) > 5;
  });
  // Most of the traffic is cruising (some wait at junctions).
  expect(moved.length).toBeGreaterThanOrEqual(Math.ceil(b.agents.length / 2));
  expect(Math.max(...b.agents.map((r) => Math.abs(r.speed)))).toBeGreaterThan(5);
  expect(errors).toEqual([]);
});
