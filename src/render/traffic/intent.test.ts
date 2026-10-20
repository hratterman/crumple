import { describe, expect, it } from 'vitest';

import {
  TRAFFIC_FLAG_BRAKE,
  TRAFFIC_FLAG_HAZARD,
  TRAFFIC_FLAG_HEADLIGHTS,
  TRAFFIC_FLAG_INDICATOR_L,
  TRAFFIC_FLAG_INDICATOR_R,
} from '../../protocol/traffic';
import { createLightState } from '../vehicle/materials';
import { TRAFFIC_BLINK_OFF_S, TRAFFIC_BLINK_ON_S } from '../vehicle/types';
import { TrafficGovernor, TRAFFIC_GOVERNOR } from './governor';
import { blinkOn, trafficLights } from './intent';

describe('traffic intent lamps', () => {
  it('blinks with the contract duty cycle and a per-agent phase', () => {
    const period = TRAFFIC_BLINK_ON_S + TRAFFIC_BLINK_OFF_S;
    for (const agent of [0, 3, 11]) {
      let on = 0;
      const N = 1000;
      for (let k = 0; k < N; k++) if (blinkOn((k / N) * period * 10, agent)) on++;
      expect(on / N).toBeCloseTo(TRAFFIC_BLINK_ON_S / period, 1);
    }
    const phases = [0, 1, 2, 3].map((a) => [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => blinkOn(t, a)).join());
    expect(new Set(phases).size).toBeGreaterThan(1);
  });

  it('maps flags: headlights, brake, indicator side, hazards both', () => {
    const s = createLightState();
    const t = (agent: number): number => {
      for (let k = 0; k < 100; k++) if (blinkOn(k * 0.01, agent)) return k * 0.01;
      return 0;
    };
    trafficLights(TRAFFIC_FLAG_HEADLIGHTS | TRAFFIC_FLAG_BRAKE, 0.2, 0, t(0), s);
    expect(s.head).toBe(true);
    expect(s.brake).toBeGreaterThan(0.5);
    expect(s.indicatorL || s.indicatorR).toBe(false);
    trafficLights(TRAFFIC_FLAG_INDICATOR_L, 0, 2, t(2), s);
    expect([s.head, s.brake, s.indicatorL, s.indicatorR]).toEqual([false, 0, true, false]);
    trafficLights(TRAFFIC_FLAG_INDICATOR_R, 0, 2, t(2), s);
    expect([s.indicatorL, s.indicatorR]).toEqual([false, true]);
    trafficLights(TRAFFIC_FLAG_HAZARD, 0, 5, t(5), s);
    expect([s.indicatorL, s.indicatorR]).toEqual([true, true]);
  });
});

describe('traffic governor', () => {
  it('drops one awake car after 2 s above 0.8, never below 1, recovers after 10 s below 0.55', () => {
    const g = new TrafficGovernor(3);
    let changes = 0;
    for (let t = 0; t < 1.9; t += 0.1) if (g.update(0.1, 0.9)) changes++;
    expect(changes).toBe(0);
    for (let t = 0; t < 0.25; t += 0.1) if (g.update(0.1, 0.9)) changes++;
    expect(g.maxAwake).toBe(2);
    for (let t = 0; t < 30; t += 0.1) g.update(0.1, 0.95);
    expect(g.maxAwake).toBe(1);
    for (let t = 0; t < 9.5; t += 0.1) g.update(0.1, 0.3);
    expect(g.maxAwake).toBe(1);
    for (let t = 0; t < 1; t += 0.1) g.update(0.1, 0.3);
    expect(g.maxAwake).toBe(2);
    for (let t = 0; t < 60; t += 0.1) g.update(0.1, 0.3);
    expect(g.maxAwake).toBe(3);
  });

  it('a mid-band load or a stale sample resets the timers', () => {
    const g = new TrafficGovernor(2);
    for (let t = 0; t < 1.5; t += 0.1) g.update(0.1, 0.9);
    g.update(0.1, 0.7);
    for (let t = 0; t < 1.5; t += 0.1) g.update(0.1, 0.9);
    expect(g.maxAwake).toBe(2);
    g.update(0.1, 0.6);
    for (let t = 0; t < 1.5; t += 0.1) g.update(0.1, 0.9);
    g.update(TRAFFIC_GOVERNOR.staleS + 1, 0.9);
    g.update(0.1, 0.9);
    expect(g.maxAwake).toBe(2);
    g.setPreset(4);
    expect(g.maxAwake).toBe(4);
  });
});
