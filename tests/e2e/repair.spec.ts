import { expect, test, type Page } from '@playwright/test';

/**
 * F (full repair): drive the sedan into the arena's precast block wall, then
 * press F — the car's damage returns to 0 and every layout prop is back at
 * its spawn pose (resetProps). Driven through the real keyboard path.
 */
interface CrumpleRepairGlobal {
  ready: boolean;
  vehicle: { speed: number; damage: number } | null;
  position: [number, number, number] | null;
  place(x: number, z: number, yawDeg?: number): void;
  debug: {
    client: {
      nodeTotal: number;
      renderTime(): number;
      interpolate(t: number, out: Float32Array): number;
      objectRanges(): readonly { objectId: number; nodeOffset: number; nodeCount: number }[];
      despawn(id: number): void;
    };
  };
}

/** Node-0 position of every layout prop (objectId 4096 + index). */
const propPoses = (page: Page): Promise<Record<string, [number, number, number]>> =>
  page.evaluate(() => {
    const c = (window as unknown as { __crumple: CrumpleRepairGlobal }).__crumple;
    const cl = c.debug.client;
    const buf = new Float32Array(cl.nodeTotal * 3);
    cl.interpolate(cl.renderTime(), buf);
    const out: Record<string, [number, number, number]> = {};
    for (const r of cl.objectRanges()) {
      if (r.objectId < 4096 || r.objectId >= 4096 + 256) continue;
      const i = r.nodeOffset * 3;
      out[r.objectId] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
    }
    return out;
  });

function maxMove(a: Record<string, number[]>, b: Record<string, number[]>): { moved: number; max: number } {
  let moved = 0;
  let max = 0;
  for (const k of Object.keys(a)) {
    const p = a[k]!;
    const q = b[k];
    if (!q) return { moved: Infinity, max: Infinity };
    const d = Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    if (d > 0.05) moved++;
    max = Math.max(max, d);
  }
  return { moved, max };
}

const vehicle = (page: Page) => page.evaluate(() => (window as unknown as { __crumple: CrumpleRepairGlobal }).__crumple.vehicle);

test('repair: F after a crash restores the car (damage 0) and every prop to its spawn pose', async ({ page }) => {
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
      const c = (window as unknown as { __crumple?: CrumpleRepairGlobal }).__crumple;
      return !!c && c.ready && c.vehicle !== null && c.position !== null;
    },
    null,
    { timeout: 240_000 }, // layout v6: the 2560 m world takes minutes to generate on a loaded box
  );
  const spawnPoses = await propPoses(page);
  expect(Object.keys(spawnPoses).length).toBeGreaterThan(150);

  // 20 m run-up straight (−Z) at the 2-high precast block wall (z ≈ 372); the soft cube is not in the lane.
  await page.evaluate(() => (window as unknown as { __crumple: CrumpleRepairGlobal }).__crumple.place(386, 394, 0));
  await page.waitForTimeout(1500);
  expect((await vehicle(page))!.damage).toBe(0);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple: CrumpleRepairGlobal }).__crumple;
      return !!c.position && c.position[2] < 374.5;
    },
    null,
    { timeout: 30_000, polling: 50 },
  );
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500);
  const crashed = await vehicle(page);
  const hit = maxMove(spawnPoses, await propPoses(page));
  console.log(`crash: damage ${(crashed!.damage * 100).toFixed(1)} %, ${hit.moved} props moved (max ${hit.max.toFixed(2)} m)`);
  expect(crashed!.damage).toBeGreaterThan(0.002);
  expect(hit.moved).toBeGreaterThan(0);

  await page.keyboard.press('KeyF');
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { __crumple: CrumpleRepairGlobal }).__crumple;
      return !!c.vehicle && c.vehicle.damage === 0;
    },
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(500);
  const after = maxMove(spawnPoses, await propPoses(page));
  expect(after.moved).toBe(0);
  expect(after.max).toBeLessThan(0.01);
  expect((await vehicle(page))!.damage).toBe(0);
  expect(errors).toEqual([]);
});
