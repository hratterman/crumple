import { describe, expect, it } from 'vitest';
import { captureRatio, MAX_PIXELS } from './capture';
import { CrashCam, CRASH_CAM_COOLDOWN_S, CRASH_CAM_DELAY_S } from './crashCam';
import { apertureToBokeh, apertureToRange, fitAspect, formatClock, markerStyle, photoFileName, severityWord, speedLabel, timeAtFraction, timelineFraction } from './format';

describe('replay UI formatting', () => {
  it('clock, speeds, severity words', () => {
    expect(formatClock(0)).toBe('0:00.00');
    expect(formatClock(75.256)).toBe('1:15.26');
    expect(formatClock(-3.5)).toBe('−0:03.50');
    expect(formatClock(NaN)).toBe('0:00.00');
    expect([0.125, 0.25, 0.5, 1, 2].map(speedLabel)).toEqual(['⅛×', '¼×', '½×', '1×', '2×']);
    expect(severityWord(0.9)).toBe('Wrecked');
    expect(severityWord(0.15)).toBe('Contact');
  });

  it('marker ticks grow and redden with severity', () => {
    const lo = markerStyle(0.12);
    const hi = markerStyle(1);
    expect(hi.height).toBeGreaterThan(lo.height);
    expect(hi.width).toBeGreaterThan(lo.width);
    expect(lo.color).toMatch(/^hsl\(39 /);
    expect(hi.color).toMatch(/^hsl\(4 /);
    expect(hi.glow).toBeGreaterThan(0);
    expect(lo.glow).toBe(0);
  });

  it('timeline fraction round-trips and clamps', () => {
    expect(timelineFraction(15, 10, 20)).toBeCloseTo(0.5);
    expect(timelineFraction(5, 10, 20)).toBe(0);
    expect(timelineFraction(25, 10, 20)).toBe(1);
    expect(timeAtFraction(timelineFraction(13.3, 10, 20), 10, 20)).toBeCloseTo(13.3);
    expect(timelineFraction(3, 3, 3)).toBe(1);
  });

  it('aspect crop is centred and exact', () => {
    expect(fitAspect(1920, 1080, null)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    const cine = fitAspect(1920, 1080, 2.39);
    expect(cine.w).toBe(1920);
    expect(cine.h).toBe(Math.round(1920 / 2.39));
    expect(cine.y * 2 + cine.h).toBeLessThanOrEqual(1080);
    const square = fitAspect(1920, 1080, 1);
    expect(square).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
  });

  it('aperture opens the blur and narrows the sharp band', () => {
    expect(apertureToBokeh(1.4)).toBeGreaterThan(apertureToBokeh(8));
    expect(apertureToRange(1.4, 10)).toBeLessThan(apertureToRange(8, 10));
    expect(apertureToRange(22, 0.1)).toBeGreaterThanOrEqual(0.4);
  });

  it('photo file names sort by time', () => {
    expect(photoFileName(new Date(2026, 9, 20, 7, 5, 9))).toBe('crumple-20261020-070509.png');
  });

  it('capture ratio honours the pixel and dimension caps', () => {
    expect(captureRatio(1280, 720, 2, 8192)).toBe(2);
    const r = captureRatio(2560, 1440, 2, 8192);
    expect(2560 * 1440 * r * r).toBeLessThanOrEqual(MAX_PIXELS + 1);
    expect(captureRatio(1280, 720, 2, 2048) * 1280).toBeLessThanOrEqual(2048 + 1e-6);
  });
});

describe('crash cam', () => {
  const m = (id: number, time: number, severity: number) => ({ id, time, severity });

  it('arms on a severe player crash and fires after the delay', () => {
    const c = new CrashCam();
    c.onMarker(m(1, 10, 0.2), 0, true);
    expect(c.phase).toBe('idle');
    c.onMarker(m(2, 11, 0.7), 0, false);
    expect(c.phase).toBe('idle');
    c.onMarker(m(3, 12, 0.7), 100, true);
    expect(c.phase).toBe('armed');
    expect(c.due(100 + CRASH_CAM_DELAY_S - 0.01)).toBe(false);
    expect(c.due(100 + CRASH_CAM_DELAY_S)).toBe(true);
    expect(c.markerId).toBe(3);
  });

  it('a harder hit while armed takes over; the delay does not restart', () => {
    const c = new CrashCam();
    c.onMarker(m(1, 10, 0.5), 0, true);
    c.onMarker(m(2, 10.4, 0.9), 0.5, true);
    expect(c.markerId).toBe(2);
    expect(c.due(CRASH_CAM_DELAY_S)).toBe(true);
  });

  it('never replays the same moment twice and cools down', () => {
    const c = new CrashCam();
    c.onMarker(m(1, 10, 0.8), 0, true);
    c.started();
    c.onMarker(m(2, 10.5, 0.9), 1, true); // while playing: ignored
    expect(c.phase).toBe('playing');
    c.finished(5, 11.6);
    expect(c.count).toBe(1);
    c.onMarker(m(1, 10, 0.8), 6, true); // already shown
    expect(c.phase).toBe('idle');
    c.onMarker(m(3, 20, 0.8), 6, true); // new, but cooling down
    expect(c.phase).toBe('idle');
    c.onMarker(m(3, 20, 0.8), 5 + CRASH_CAM_COOLDOWN_S, true);
    expect(c.phase).toBe('armed');
    c.cancel();
    expect(c.phase).toBe('idle');
  });

  it('disabled: nothing arms', () => {
    const c = new CrashCam();
    c.enabled = false;
    c.onMarker(m(1, 10, 1), 0, true);
    expect(c.phase).toBe('idle');
  });
});
