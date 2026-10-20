import { expect, test, type Page } from '@playwright/test';

/**
 * P8 stunt challenges: start a challenge by URL, let the playtest bot drive
 * it (inputs at snapshot rate, render loop held: SwiftShader draws ~1 fps),
 * and check it runs to a result: countdown → GO, combo popups, the HUD, the
 * results screen with a medal + PB, and that the PB (with its ghost) is
 * stored. Screenshots of the HUD, a popup and the results are attached.
 */
interface ChallengeApi {
  phase: string;
  state: { phase: string; clock: number; countdown: number; scoreText: string } | null;
  result: { completed: boolean; score: number; medal: string; isBest: boolean; scoreText: string } | null;
  resultsOpen: boolean;
  selectOpen: boolean;
  popups: string[];
  ghostFrames: number;
  bot(on: boolean, cfg?: Record<string, unknown>): void;
  start(id: string): Promise<void>;
  quit(): void;
  list(): { id: string; best: number | null; medal: string }[];
}
interface G {
  ready: boolean;
  hold: boolean;
  renderOnce(settle?: number): void;
  challenges: ChallengeApi | null;
  openChallenges(): void;
  mode: string;
}
const api = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __crumple: G }).__crumple.challenges!;
    return { phase: c.phase, state: c.state ? { ...c.state, objectives: undefined } : null, resultsOpen: c.resultsOpen, popups: c.popups, result: c.result };
  });

async function draw(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __crumple: G }).__crumple.renderOnce());
  await page.waitForTimeout(300);
}

async function runChallenge(page: Page, id: string, query: string, bot: Record<string, unknown>, shots: (name: string) => Promise<void>): Promise<{ popups: string[]; result: NonNullable<ChallengeApi['result']> }> {
  await page.goto(`/crumple/?q=low&traffic=0&challenge=${id}&${query}`);
  await page.waitForFunction(() => (window as unknown as { __crumple?: G }).__crumple?.ready === true, null, { timeout: 180_000 });
  await page.waitForFunction(() => {
    const c = (window as unknown as { __crumple: G }).__crumple.challenges;
    return !!c && c.phase !== 'idle';
  }, null, { timeout: 120_000 });
  await page.evaluate((cfg) => {
    const g = (window as unknown as { __crumple: G }).__crumple;
    g.challenges!.bot(true, cfg);
    g.hold = true;
  }, bot);
  let hud = false;
  let pop = false;
  const t0 = Date.now();
  for (;;) {
    const st = await api(page);
    if (!hud && st.state?.phase === 'running' && st.state.clock > 1) {
      hud = true;
      await draw(page);
      await shots(`${id}-hud`);
    }
    if (!pop && st.popups.length > 0) {
      // the popup is DOM over the last drawn frame: shoot at once (it fades in wall time)
      pop = true;
      await shots(`${id}-popup`);
    }
    if (st.resultsOpen) break;
    expect(Date.now() - t0, `${id} finishes`).toBeLessThan(360_000);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(2600); // medal animation
  await draw(page);
  await shots(`${id}-results`);
  const st = await api(page);
  return { popups: st.popups, result: st.result! };
}

test.describe('stunt challenges', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('bowling: countdown, pins popups, strike-or-not results with a medal and a stored PB', async ({ page }, info) => {
    test.setTimeout(600_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.stack ?? String(e)));
    const shots = async (name: string): Promise<void> => {
      await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
    };
    const r = await runChallenge(page, 'bowling', 'spawn=arena', { speedKmh: 95 }, shots);
    expect(r.result.completed).toBe(true);
    expect(r.result.score).toBeGreaterThanOrEqual(5);
    expect(r.popups.some((p) => /PINS|STRIKE/.test(p))).toBe(true);
    await expect(page.getByTestId('challenge-results')).toBeVisible();
    await expect(page.getByTestId('challenge-result-score')).toContainText('pins');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('crumple.challenges.v1') ?? 'null'));
    expect(stored.records.bowling.best).toBe(r.result.score);
    expect(typeof stored.records.bowling.ghost).toBe('string');
    expect(errors).toEqual([]);
  });

  test('long jump: off the ski jump, BIG AIR popup, distance scored', async ({ page }, info) => {
    test.setTimeout(600_000);
    const shots = async (name: string): Promise<void> => {
      await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
    };
    const r = await runChallenge(page, 'long-jump', 'spawn=summit', { maxThrottle: 0.4, speedKmh: 200, latAcc: 50 }, shots);
    expect(r.result.completed).toBe(true);
    expect(r.result.score).toBeGreaterThan(25);
    expect(r.popups.some((p) => /AIR/.test(p))).toBe(true);
  });

  test('barrel roll: the side kicker rolls the coupe; select screen lists the PB', async ({ page }, info) => {
    test.setTimeout(600_000);
    const shots = async (name: string): Promise<void> => {
      await info.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
    };
    const r = await runChallenge(page, 'barrel-roll', 'spawn=arena', { speedKmh: 78, latAcc: 50 }, shots);
    expect(r.result.completed).toBe(true);
    expect(r.result.score).toBeGreaterThanOrEqual(0.5);
    expect(r.popups.some((p) => /ROLL/.test(p))).toBe(true);
    // the select screen shows the medal + PB on the card
    await page.keyboard.press('KeyC');
    await expect(page.getByTestId('challenge-select')).toBeVisible();
    await expect(page.getByTestId('challenge-card-barrel-roll')).toContainText('PB');
    await draw(page);
    await shots('select');
  });
});
