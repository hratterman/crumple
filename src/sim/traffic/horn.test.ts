/**
 * P8 traffic horn (additive AI state, TRAFFIC_FLAG_HORN): an agent held up
 * by the stopped player honks after 2.5 s, at most every 8 s, identically
 * on every run; following another car (no focus in the lane) never honks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { placePlayer, run, trafficWorld, valleyTerrain } from './testkit';

beforeAll(() => {
  valleyTerrain();
}, 120_000);

const ARENA: [number, number, number] = [360, 400, 0];
const BIG_BUBBLE = { promoteM: 5000, demoteM: 6000 };
const HWY_KERB = 1;

/** Ticks (2 kHz) at which the agent started honking over `seconds`. */
function honks(blockedByPlayer: boolean, seconds: number): number[] {
  const { eng, tr } = trafficWorld({ agents: 2, maxAwake: 1, bubble: BIG_BUBBLE, player: ARENA });
  if (blockedByPlayer) placePlayer(eng, HWY_KERB, 500);
  else {
    const lead = tr.placeAgent(1, HWY_KERB, 500, 0);
    lead.hold = true;
  }
  run(eng, 400);
  const a = tr.placeAgent(0, HWY_KERB, 250, 25);
  a.lcCooldown = 1e9;
  const starts: number[] = [];
  let was = false;
  for (let t = 0; t < seconds * 100; t++) {
    run(eng, 20);
    const on = a.honkS > 0;
    if (on && !was) starts.push(eng.tick);
    was = on;
  }
  return starts;
}

describe('traffic horn', () => {
  it('honks at the player blocking its lane: after 2.5 s stopped, rate-limited, deterministic', () => {
    const a = honks(true, 40);
    const b = honks(true, 40);
    console.log(`[traffic] honks at ticks ${a.join(', ')}`);
    expect(a.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < a.length; i++) expect(a[i]! - a[i - 1]!).toBeGreaterThanOrEqual(8 * 2000 - 40);
    expect(b).toEqual(a);
  }, 240_000);

  it('never honks queueing behind another car', () => {
    expect(honks(false, 30)).toEqual([]);
  }, 240_000);
});
