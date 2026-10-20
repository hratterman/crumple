import { describe, expect, it } from 'vitest';

import { engineScripts, renderCrash, renderEngine, renderSurface } from '../render';
import { ENGINE_PROFILES } from '../profiles';
import { firingHz } from '../params';
import { signalStats } from '../wav';
import { ONE_SHOT_KINDS, synthOneShot } from './oneshots';

const SR = 48000;

/** Magnitude of the DFT of x at frequency f (Goertzel), normalised by length. */
function tone(x: Float32Array, f: number): number {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}

describe('engine DSP', () => {
  for (const id of ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater']) {
    it(`${id}: finite, no clipping or DC, harmonic structure follows rpm, louder at redline than idle`, () => {
      const p = ENGINE_PROFILES[id]!;
      const sc = engineScripts(p);
      const [idleEx] = renderEngine(p, SR, 1.5, sc.idle!.script);
      const [midEx] = renderEngine(p, SR, 1.5, sc.mid!.script);
      const [redEx] = renderEngine(p, SR, 1.5, sc.redline!.script);
      for (const x of [idleEx, midEx, redEx]) {
        const s = signalStats(x);
        expect(Number.isFinite(s.rms)).toBe(true);
        expect(s.peak).toBeLessThan(0.98);
        expect(Math.abs(s.dc)).toBeLessThan(0.005);
      }
      expect(signalStats(redEx).rms).toBeGreaterThan(signalStats(idleEx).rms * 1.8);
      // at mid rpm the firing frequency stands out against the frequencies between orders
      const f0 = firingHz(p.redlineRpm * 0.5, p.cylinders);
      const x = midEx.subarray(SR * 0.3);
      const on = tone(x, f0) + tone(x, 2 * f0);
      const off = tone(x, f0 * 1.27) + tone(x, f0 * 2.27);
      expect(on).toBeGreaterThan(off * 3);
    });
  }

  it('the pitch parameter scales the firing frequency (Doppler / slow-mo)', () => {
    const p = ENGINE_PROFILES.sedan!;
    const rpm = 3000;
    const [a] = renderEngine(p, SR, 1.2, (_t, i) => {
      i.rpm = rpm;
      i.throttle = 0.4;
      i.load = 0.4;
      i.pitch = 0.5;
    });
    const f0 = firingHz(rpm, 6);
    const x = a.subarray(SR * 0.3);
    expect(tone(x, f0 * 0.5)).toBeGreaterThan(tone(x, f0) * 1.5);
  });

  it('a gated voice is silent', () => {
    const [ex, fr] = renderEngine(ENGINE_PROFILES.coupe!, SR, 0.5, (_t, i) => {
      i.gate = 0;
      i.rpm = 3000;
    });
    expect(signalStats(ex.subarray(SR * 0.2)).peak).toBeLessThan(1e-6);
    expect(signalStats(fr.subarray(SR * 0.2)).peak).toBeLessThan(1e-6);
  });
});

describe('surface + one-shots', () => {
  it('squeal energy appears only with slip; wind grows with speed', () => {
    const [still] = renderSurface(SR, 0.5, (_t, i) => {
      i.speed = 20;
      i.roar = 0;
    });
    const [sq] = renderSurface(SR, 0.5, (_t, i) => {
      i.speed = 20;
      i.squealR = 1;
      i.squealHz = 900;
    });
    expect(tone(still, 900)).toBeLessThan(1e-4);
    expect(signalStats(sq).rms).toBeGreaterThan(0.02);
    const [, wSlow] = renderSurface(SR, 0.5, (_t, i) => {
      i.wind = 0.1;
      i.windSpeed = 10;
    });
    const [, wFast] = renderSurface(SR, 0.5, (_t, i) => {
      i.wind = 0.8;
      i.windSpeed = 40;
    });
    expect(signalStats(wFast).rms).toBeGreaterThan(signalStats(wSlow).rms * 3);
  });

  it('every one-shot kind renders finite, normalised, DC-free audio', () => {
    for (const k of ONE_SHOT_KINDS) {
      const x = synthOneShot(k, SR, 1);
      const s = signalStats(x);
      expect(s.peak).toBeGreaterThan(0.3);
      expect(s.peak).toBeLessThan(1);
      expect(Math.abs(s.dc)).toBeLessThan(0.01);
      expect(x[x.length - 1]).toBeCloseTo(0, 3);
    }
    const crash = renderCrash(SR, 1);
    expect(signalStats(crash).peak).toBeLessThan(1);
  });
});
