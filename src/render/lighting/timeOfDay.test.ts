import { describe, expect, it } from 'vitest';
import { Color, PerspectiveCamera, Scene, ShaderChunk, Vector3 } from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

import { elevationDeg, hourForSunElevation, moonDirectionAt, moonIllumination, starRotation, sunDirectionAt } from './astro';
import { bodyIlluminance, luminance, SUN_ILLUMINANCE_TOA, transmittance } from './atmosphere';
import { createEnvironment, ease, WEATHER_TARGETS } from './environment';
import { lightsBeginWithKeyVis } from './envPatch';
import { keyLightFor, MOON_ILLUMINANCE_TOA } from '../lighting';

describe('astro', () => {
  it('puts the sun on the meridian at noon, in the south, at 90° − φ + δ', () => {
    const d = sunDirectionAt(12);
    expect(elevationDeg(d)).toBeCloseTo(90 - 42 + 18, 4);
    expect(d[0]).toBeCloseTo(0, 6); // no east/west component
    expect(d[2]).toBeGreaterThan(0); // south = +Z
  });
  it('rises in the east and sets in the west, symmetric about noon', () => {
    const am = sunDirectionAt(8);
    const pm = sunDirectionAt(16);
    expect(am[0]).toBeGreaterThan(0); // east = +X
    expect(pm[0]).toBeLessThan(0);
    expect(am[1]).toBeCloseTo(pm[1], 9);
    expect(elevationDeg(sunDirectionAt(0))).toBeLessThan(-20);
  });
  it('finds the hour for an elevation (sunrise / sunset branches)', () => {
    const set = hourForSunElevation(0, false)!;
    const rise = hourForSunElevation(0, true)!;
    expect(set).toBeGreaterThan(18.5);
    expect(set).toBeLessThan(19.5);
    expect(rise).toBeCloseTo(24 - set, 6);
    expect(elevationDeg(sunDirectionAt(set))).toBeCloseTo(0, 3);
    expect(hourForSunElevation(80, false)).toBeNull();
  });
  it('has a waxing gibbous moon up in the late evening', () => {
    expect(moonIllumination()).toBeGreaterThan(0.6);
    expect(moonIllumination()).toBeLessThan(0.95);
    expect(elevationDeg(moonDirectionAt(23))).toBeGreaterThan(15);
  });
  it('star rotation is orthonormal and keeps the pole fixed', () => {
    const a = starRotation(3);
    const b = starRotation(21);
    const col = (m: number[], i: number) => new Vector3(m[i * 3], m[i * 3 + 1], m[i * 3 + 2]);
    for (const m of [a, b]) {
      for (let i = 0; i < 3; i++) expect(col(m, i).length()).toBeCloseTo(1, 9);
      expect(col(m, 0).dot(col(m, 1))).toBeCloseTo(0, 9);
      expect(col(m, 0).dot(col(m, 2))).toBeCloseTo(0, 9);
    }
    expect(col(a, 2).distanceTo(col(b, 2))).toBeCloseTo(0, 9);
    expect(elevationDeg(col(a, 2).toArray())).toBeCloseTo(42, 6); // pole altitude = latitude
  });
});

describe('atmosphere', () => {
  it('reddens and dims the sun toward the horizon', () => {
    const z = transmittance(200, 1);
    const h = transmittance(200, Math.sin((3 * Math.PI) / 180));
    expect(z[0]).toBeGreaterThan(0.8);
    expect(z[2]).toBeLessThan(z[0]);
    expect(h[2] / h[0]).toBeLessThan(z[2] / z[0]);
    expect(luminance(h)).toBeLessThan(0.5 * luminance(z));
    expect(transmittance(200, -0.2)).toEqual([0, 0, 0]);
  });
  it('the noon sun lands near the tuned key light (≈ 6)', () => {
    const e = bodyIlluminance(sunDirectionAt(12), SUN_ILLUMINANCE_TOA);
    expect(Math.max(...e)).toBeGreaterThan(5.5);
    expect(Math.max(...e)).toBeLessThan(7.2);
  });
  it('fades the key light smoothly through the horizon (no pop)', () => {
    let prev = Infinity;
    for (let deg = 2; deg >= -1; deg -= 0.1) {
      const d = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
      const l = luminance(bodyIlluminance(d, SUN_ILLUMINANCE_TOA));
      expect(l).toBeLessThanOrEqual(prev + 1e-9);
      prev = l;
    }
    expect(prev).toBe(0);
  });
});

describe('key light', () => {
  const mk = () => ({ dir: new Vector3(), color: new Color(), intensity: 0, isMoon: false });
  it('is the sun by day and the (dim, cool) moon at night', () => {
    const sun = new Vector3(...sunDirectionAt(12));
    const moon = new Vector3(...moonDirectionAt(12));
    const day = keyLightFor(sun, moon, 0.8, 0.1, mk());
    expect(day.isMoon).toBe(false);
    expect(day.intensity).toBeGreaterThan(5);
    const nsun = new Vector3(...sunDirectionAt(23));
    const nmoon = new Vector3(...moonDirectionAt(23));
    const night = keyLightFor(nsun, nmoon, 0.8, 0.1, mk());
    expect(night.isMoon).toBe(true);
    expect(night.intensity).toBeGreaterThan(0);
    expect(night.intensity).toBeLessThan(MOON_ILLUMINANCE_TOA);
    expect(night.color.b).toBeGreaterThan(night.color.r);
  });
  it('overcast cuts the direct light', () => {
    const sun = new Vector3(...sunDirectionAt(14));
    const moon = new Vector3(...moonDirectionAt(14));
    const clear = keyLightFor(sun, moon, 0.8, 0.1, mk()).intensity;
    const grey = keyLightFor(sun, moon, 0.8, 1, mk()).intensity;
    expect(grey).toBeLessThan(0.3 * clear);
  });
});

describe('environment controller', () => {
  it('advances time at timeSpeed and wraps at 24 h', () => {
    const e = createEnvironment({ time: 23.9, timeSpeed: 3600 });
    e.advance(0.2);
    expect(e.time).toBeCloseTo(0.1, 6);
    e.setTimeSpeed(0);
    e.advance(0.2);
    expect(e.time).toBeCloseTo(0.1, 6);
  });
  it('eases weather toward a preset; rain waits for the clouds; wetness lags and dries', () => {
    const e = createEnvironment({ preset: 'clear' });
    e.setWeather('rain');
    e.advance(0.25);
    expect(e.weather.cloudCover).toBeLessThan(WEATHER_TARGETS.rain.cloudCover);
    expect(e.weather.rain).toBe(0);
    for (let i = 0; i < 4 * 60 * 4; i++) e.advance(0.25);
    expect(e.weather.cloudCover).toBeCloseTo(WEATHER_TARGETS.rain.cloudCover, 2);
    expect(e.weather.rain).toBeCloseTo(WEATHER_TARGETS.rain.rain, 2);
    expect(e.weather.wetness).toBeGreaterThan(0.75);
    e.setWeather('clear');
    for (let i = 0; i < 60 * 4; i++) e.advance(0.25);
    expect(e.weather.wetness).toBeGreaterThan(0.4); // still drying after a minute
    for (let i = 0; i < 20 * 60 * 4; i++) e.advance(0.25);
    expect(e.weather.wetness).toBeLessThan(0.02);
  });
  it('instant presets, wetness override and change listeners', () => {
    const e = createEnvironment();
    let n = 0;
    e.onChange(() => n++);
    e.setWeather('storm', true);
    expect(e.weather.rain).toBe(1);
    expect(e.weather.wetness).toBe(1);
    e.setWetness(0.3);
    e.advance(1);
    expect(e.weather.wetness).toBe(0.3);
    e.setTime(-1);
    expect(e.time).toBe(23);
    expect(n).toBe(3);
  });
  it('ease is exponential and exact at the target', () => {
    expect(ease(0, 1, 1, 1)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(ease(0.4, 0.4, 5, 2)).toBe(0.4);
  });
});

describe('env patch', () => {
  it('folds every CSM directional shadow factor into crumpleKeyVis', () => {
    // CSM installs its lights_fragment_begin chunk globally when constructed
    new CSM({ camera: new PerspectiveCamera(), parent: new Scene(), cascades: 3, maxFar: 100, lightDirection: new Vector3(0, -1, 0) });
    const out = lightsBeginWithKeyVis(ShaderChunk.lights_fragment_begin);
    expect(out).toContain('float crumpleKeyVis = crumpleCloudSh;');
    const n = (out.match(/crumpleKeyVis = min\( crumpleKeyVis, crumpleSh \* crumpleCloudSh \)/g) ?? []).length;
    // cloud shadow on every directional light the chunk evaluates
    expect((out.match(/directLight\.color \*= crumpleCloudSh;/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(n).toBeGreaterThanOrEqual(3); // CSM fade, CSM no-fade and plain directional paths
    expect(out).not.toMatch(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap/);
    // spot / point shadows untouched
    expect(out).toContain('getShadow( spotShadowMap[ i ]');
  });
});
