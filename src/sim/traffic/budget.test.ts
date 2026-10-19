/**
 * Traffic physics budget (P6, T1; docs/CONTRACTS.md "Awake budget"): CPU ms
 * per simulated second on the real scene (Crumple Valley heightfield, 2.4k
 * vegetation colliders, water, 198 layout props asleep, worker host), U1's
 * method (best of 0.25 s windows is NOT taken: total / sim time, plus the
 * worst 0.25 s window). Reports: the player sedan alone, the player + N
 * awake traffic sedans driving around it, one awake traffic sedan alone,
 * and the ghost / route / scheduler overhead for 28 agents. Ceilings are
 * generous (shared, loaded boxes); the numbers go into CONTRACTS.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { TRAFFIC_AI_TICKS } from '../../protocol/traffic';
import { placePlayer, trafficWorld, valleyTerrain } from './testkit';
import type { SimEngine } from '../engine';

beforeAll(() => {
  valleyTerrain();
}, 120_000);

const ARENA: [number, number, number] = [360, 400, 0];
/** Highway kerb / inner lane of the first interval (direction +1). */
const KERB = 1;
const INNER = 0;

interface Cost {
  msPerSimS: number;
  worst: number;
}

function measure(eng: SimEngine, seconds: number): Cost {
  let total = 0;
  let worst = 0;
  for (let w = 0; w < seconds * 4; w++) {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) eng.step();
    const dt = performance.now() - t0;
    eng.events.clear();
    total += dt;
    worst = Math.max(worst, dt * 4);
  }
  return { msPerSimS: total / seconds, worst };
}

const fmt = (c: Cost): string => `${c.msPerSimS.toFixed(0)} ms/sim-s (worst 0.25 s ${c.worst.toFixed(0)})`;

describe('traffic physics budget (real scene)', () => {
  it('player alone vs player + N awake traffic sedans; one traffic sedan alone; ghosts + scheduler for 28 agents', () => {
    const rows: string[] = [];
    // Player driving on the highway at ≈ 80 km/h, no traffic agents near.
    const base = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA });
    placePlayer(base.eng, KERB, 600);
    base.host.handle({ type: 'setTraffic', enabled: false, seed: 1, variants: [], density: { agents: 0, maxAwake: 0, awakePoolBeams: 0 }, focusObjectId: 1 });
    base.host.handle({ type: 'input', objectId: 1, actions: { throttle: 0.35, gearSelect: 1 } });
    for (let i = 0; i < 4000; i++) base.eng.step();
    const alone = measure(base.eng, 4);
    rows.push(`player sedan alone (driving, 2081 beams): ${fmt(alone)}`);

    const withN: Cost[] = [];
    for (const n of [1, 2, 3, 4]) {
      const w = trafficWorld({ agents: n, maxAwake: n, player: ARENA, bubble: { promoteM: 5000, demoteM: 6000 } });
      placePlayer(w.eng, KERB, 600);
      w.host.handle({ type: 'input', objectId: 1, actions: { throttle: 0.35, gearSelect: 1 } });
      for (let k = 0; k < n; k++) w.tr.placeAgent(k, k % 2 === 0 ? KERB : INNER, 640 + 40 * k, 22);
      for (let i = 0; i < 4000; i++) w.eng.step();
      const awake = w.tr.awakeCount;
      const c = measure(w.eng, 4);
      withN.push(c);
      rows.push(`player + ${awake} awake traffic: ${fmt(c)}  (+${((c.msPerSimS - alone.msPerSimS) / Math.max(awake, 1)).toFixed(0)} per car)`);
      expect(awake).toBe(n);
    }

    // One traffic sedan alone (player parked far away, no other agents).
    const solo = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA, bubble: { promoteM: 5000, demoteM: 6000 } });
    solo.tr.placeAgent(0, KERB, 200, 25);
    for (let i = 0; i < 4000; i++) solo.eng.step();
    const parked = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA });
    parked.host.handle({ type: 'setTraffic', enabled: false, seed: 1, variants: [], density: { agents: 0, maxAwake: 0, awakePoolBeams: 0 }, focusObjectId: 1 });
    for (let i = 0; i < 4000; i++) parked.eng.step();
    const parkedCost = measure(parked.eng, 4);
    const soloCost = measure(solo.eng, 4);
    rows.push(`one traffic sedan driving (minus the parked player ${parkedCost.msPerSimS.toFixed(0)}): ${(soloCost.msPerSimS - parkedCost.msPerSimS).toFixed(0)} ms/sim-s`);

    // Ghost + route + scheduler overhead: 28 ghosts (player parked far from every lane), timed per AI tick.
    const g = trafficWorld({ agents: 28, maxAwake: 4, player: ARENA });
    const eng = g.eng;
    for (let i = 0; i < 2000; i++) eng.step();
    let aiMs = 0;
    const ticks = 2000 * 4;
    for (let i = 0; i < ticks / TRAFFIC_AI_TICKS; i++) {
      const t0 = performance.now();
      g.tr.update(eng);
      aiMs += performance.now() - t0;
    }
    rows.push(`28 ghosts + route network + scheduler: ${(aiMs / 4).toFixed(2)} ms/sim-s (awake ${g.tr.awakeCount})`);
    console.log(`[traffic budget]\n  ${rows.join('\n  ')}`);

    // Regression ceilings only (shared CI / agent boxes run at several times real load).
    expect(alone.msPerSimS).toBeLessThan(5000);
    for (const c of withN) expect(c.msPerSimS).toBeLessThan(10000);
    expect(aiMs / 4).toBeLessThan(200);
  }, 600_000);
});
