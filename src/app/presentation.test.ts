/**
 * Presentation smoothness (renderClock.ts): the real WorkerHost pacing and
 * the real SimClient render clock + interpolation, wired through the
 * discrete-event thread model of presentation.harness.ts, with a probe node
 * moving at 30 m/s. The per-frame step of the rendered position must match
 * the true motion: before the smooth clock it was uneven by 46–149 mm RMS
 * (max 0.1–0.44 m) per frame at 60 / 120 / 144 Hz.
 */
import { describe, expect, it } from 'vitest';
import { presentationStats, runPresentation } from './presentation.harness';

describe('render clock smoothness (30 m/s probe)', () => {
  for (const hz of [60, 120, 144]) {
    for (const stepCpuMs of [0.125, 0.3]) {
      it(`${hz} Hz display, worker ${stepCpuMs} ms CPU per step: per-frame position steps even within millimetres`, () => {
        const r = runPresentation({ displayHz: hz, durationS: 4, stepCpuMs, frameCpuMs: hz === 60 ? 8 : 5 });
        const s = presentationStats(r);
        expect(r.frames).toBeGreaterThan(hz * 3.5);
        expect(s.stalls).toBe(0);
        expect(s.stepJitterRmsMm).toBeLessThan(1.5);
        expect(s.stepJitterMaxMm).toBeLessThan(5);
        // render time trails the newest snapshot by about one interval + jitter, never far
        expect(s.lagMeanMs).toBeLessThan(20);
      });
    }
  }

  it('a long main-thread frame costs one uneven step, then the clock is smooth again', () => {
    const r = runPresentation({ displayHz: 120, durationS: 4, stepCpuMs: 0.2, frameCpuMs: 5, hitchEveryMs: 1500, hitchMs: 45 });
    const s = presentationStats(r);
    expect(s.stepJitterRmsMm).toBeLessThan(25);
  });
});
