import { describe, expect, it } from 'vitest';

import { TRAFFIC_MAX_AGENTS } from '../protocol/traffic';
import { QUALITY_PRESETS } from '../render/types';
import type { StorageLike } from './quality';
import { chaseScale, DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings, SETTINGS_KEY, trafficDensityFor, unitLabel, unitsPerKmh } from './settings';

describe('settings', () => {
  it('validates field by field', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ units: 'mph', traffic: 'heavy', tractionControl: false, chase: 'far', fov: 70, volume: 0.4 })).toEqual({
      units: 'mph',
      traffic: 'heavy',
      tractionControl: false,
      chase: 'far',
      fov: 70,
      volume: 0.4,
      engineVolume: 1,
      effectsVolume: 1,
      ambienceVolume: 0.8,
      muted: false,
      crashCam: true,
      timeOfDay: DEFAULT_SETTINGS.timeOfDay,
      timeSpeed: 0,
      weather: 'clear',
      physicsQuality: 'auto',
    });
    // R-GFX environment fields
    expect(sanitizeSettings({ timeOfDay: 25.5, timeSpeed: 60, weather: 'rain' })).toMatchObject({ timeOfDay: 1.5, timeSpeed: 60, weather: 'rain' });
    expect(sanitizeSettings({ timeOfDay: 'noon', timeSpeed: 7, weather: 'hail' })).toMatchObject({ timeOfDay: DEFAULT_SETTINGS.timeOfDay, timeSpeed: 0, weather: 'clear' });
    expect(sanitizeSettings({ engineVolume: 0.3, effectsVolume: 2, ambienceVolume: 'x', muted: true })).toMatchObject({ engineVolume: 0.3, effectsVolume: 1, ambienceVolume: 0.8, muted: true });
    expect(sanitizeSettings({ crashCam: false }).crashCam).toBe(false);
    expect(sanitizeSettings({ crashCam: 'no' }).crashCam).toBe(true);
    const bad = sanitizeSettings({ units: 'knots', traffic: 7, tractionControl: 'yes', chase: null, fov: 61, volume: 9 });
    expect(bad).toEqual({ ...DEFAULT_SETTINGS, volume: 1 });
  });

  it('persists, survives corrupt JSON and storage errors', () => {
    const data: Record<string, string> = {};
    const st: StorageLike = { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
    saveSettings({ ...DEFAULT_SETTINGS, units: 'mph' }, st);
    expect(loadSettings(st).units).toBe('mph');
    data[SETTINGS_KEY] = '{oops';
    expect(loadSettings(st)).toEqual(DEFAULT_SETTINGS);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, throwing)).not.toThrow();
  });

  it('scales traffic agents only (the awake budget stays the preset physics cost)', () => {
    for (const q of Object.values(QUALITY_PRESETS)) {
      const t = q.traffic;
      expect(trafficDensityFor(t, 'normal')).toEqual(t);
      expect(trafficDensityFor(t, 'off').agents).toBe(0);
      expect(trafficDensityFor(t, 'light').agents).toBe(Math.round(t.agents / 2));
      const heavy = trafficDensityFor(t, 'heavy');
      expect(heavy.agents).toBeLessThanOrEqual(TRAFFIC_MAX_AGENTS);
      expect(heavy.agents).toBeGreaterThan(t.agents);
      expect(heavy.maxAwake).toBe(t.maxAwake);
      expect(heavy.awakePoolBeams).toBe(t.awakePoolBeams);
    }
  });

  it('units and framing helpers', () => {
    expect(unitsPerKmh('kmh')).toBe(1);
    expect(100 * unitsPerKmh('mph')).toBeCloseTo(62.137, 2);
    expect(unitLabel('mph')).toBe('mph');
    expect(chaseScale('normal')).toBe(1);
    expect(chaseScale('near')).toBeLessThan(1);
    expect(chaseScale('far')).toBeGreaterThan(1);
  });
});
