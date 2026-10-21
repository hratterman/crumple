/**
 * Time of day + weather state (pure, no three): what the player / photo mode
 * set, eased toward its targets each frame. The lighting stack reads it to
 * place the sun and moon, colour the key light, the sky and the haze; the FX
 * layer reads rain; the physics side reads `wetness` (CONTRACTS "Weather API").
 *
 * Time is local solar hours [0, 24); `timeSpeed` is game seconds per real
 * second (0 = frozen, 60 = one game minute per second). Weather presets set
 * targets; the live values ease toward them (cloud cover / fog over ~20 s,
 * rain over ~6 s) so a change reads as weather moving in, not a cut, unless
 * `instant`. Wetness follows rain: surfaces wet within ~40 s of steady rain
 * and dry over ~4 min.
 */

import { sunDirectionAt } from './astro';

export type WeatherPreset = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog';
export const WEATHER_PRESETS: readonly WeatherPreset[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'];

export interface WeatherTargets {
  /** 0..1 sky covered by cloud. */
  cloudCover: number;
  /** 0..1 rain intensity (1 ≈ 25 mm/h downpour). */
  rain: number;
  /** 0..1 ground fog / mist (raises the height-fog density). */
  fog: number;
}

export const WEATHER_TARGETS: Readonly<Record<WeatherPreset, WeatherTargets>> = {
  clear: { cloudCover: 0.18, rain: 0, fog: 0 },
  cloudy: { cloudCover: 0.55, rain: 0, fog: 0.08 },
  overcast: { cloudCover: 0.93, rain: 0, fog: 0.15 },
  rain: { cloudCover: 0.96, rain: 0.6, fog: 0.2 },
  storm: { cloudCover: 1, rain: 1, fog: 0.32 },
  fog: { cloudCover: 0.7, rain: 0, fog: 1 },
};

/** Live weather (what renderers and the physics coupling read). */
export interface WeatherState extends WeatherTargets {
  /** 0..1 surface water film (lags rain: wets in ~40 s, dries in ~4 min). */
  wetness: number;
}

/** Default boot time: late-afternoon golden light (sun ≈ 22° up in the west-south-west). */
export const DEFAULT_TIME_OF_DAY = 17.25;

export function isWeatherPreset(x: unknown): x is WeatherPreset {
  return typeof x === 'string' && (WEATHER_PRESETS as readonly string[]).includes(x);
}

export interface EnvironmentController {
  /** Local solar hours [0, 24). */
  readonly time: number;
  /** Game seconds per real second (0 = frozen). */
  readonly timeSpeed: number;
  readonly preset: WeatherPreset;
  /** Live (eased) weather. */
  readonly weather: Readonly<WeatherState>;
  /** Bumped whenever anything visible changed (time, weather). */
  readonly version: number;
  /**
   * 0 by day … 1 at night (sun from +4° down to −3.4°): artificial light gain
   * (streetlights, lamp lenses, the night-light grid).
   */
  readonly darkness: number;
  /** Seconds the world advanced (live play only: frozen while paused / replaying): cloud drift. */
  readonly clock: number;
  /** Should vehicles run their headlights (dusk, night, rain, fog)? */
  readonly headlightsWanted: boolean;
  setTime(hours: number): void;
  setTimeSpeed(gameSecondsPerSecond: number): void;
  setWeather(preset: WeatherPreset, instant?: boolean): void;
  /** Explicit wetness override (tests, photo mode); null returns to the rain-driven film. */
  setWetness(w: number | null): void;
  /** Advance time and ease weather by `dtS` real seconds (0 while paused). */
  advance(dtS: number): void;
  onChange(cb: (env: EnvironmentController) => void): () => void;
}

const wrap24 = (h: number): number => ((h % 24) + 24) % 24;
const sunTmp: [number, number, number] = [0, 0, 0];
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Exponential ease of `x` toward `t` with time constant `tau` s. */
export function ease(x: number, t: number, dt: number, tau: number): number {
  if (tau <= 0) return t;
  return t + (x - t) * Math.exp(-dt / tau);
}

export function createEnvironment(init: { time?: number; timeSpeed?: number; preset?: WeatherPreset } = {}): EnvironmentController {
  let time = wrap24(init.time ?? DEFAULT_TIME_OF_DAY);
  let clock = 0;
  let timeSpeed = Math.max(0, init.timeSpeed ?? 0);
  let preset: WeatherPreset = init.preset ?? 'clear';
  const t0 = WEATHER_TARGETS[preset];
  const weather: WeatherState = { ...t0, wetness: t0.rain > 0 ? clamp01(0.4 + t0.rain) : 0 };
  let wetOverride: number | null = null;
  let version = 0;
  const listeners = new Set<(e: EnvironmentController) => void>();
  const changed = (): void => {
    version++;
    for (const cb of listeners) cb(ctrl);
  };

  const ctrl: EnvironmentController = {
    get time() {
      return time;
    },
    get timeSpeed() {
      return timeSpeed;
    },
    get preset() {
      return preset;
    },
    weather,
    get version() {
      return version;
    },
    get clock() {
      return clock;
    },
    get darkness() {
      const y = sunDirectionAt(time, sunTmp)[1];
      const t = clamp01((0.07 - y) / 0.13);
      return t * t * (3 - 2 * t);
    },
    get headlightsWanted() {
      return ctrl.darkness > 0.2 || weather.rain > 0.25 || weather.fog > 0.45;
    },
    setTime(h: number) {
      if (!Number.isFinite(h)) return;
      time = wrap24(h);
      changed();
    },
    setTimeSpeed(x: number) {
      timeSpeed = Number.isFinite(x) ? Math.max(0, x) : 0;
      changed();
    },
    setWeather(p: WeatherPreset, instant = false) {
      preset = p;
      if (instant) {
        const t = WEATHER_TARGETS[p];
        weather.cloudCover = t.cloudCover;
        weather.rain = t.rain;
        weather.fog = t.fog;
        weather.wetness = t.rain > 0 ? clamp01(0.4 + t.rain) : 0;
      }
      changed();
    },
    setWetness(w: number | null) {
      wetOverride = w === null ? null : clamp01(w);
      if (wetOverride !== null) weather.wetness = wetOverride;
      changed();
    },
    advance(dtS: number) {
      if (!(dtS > 0)) return;
      const dt = Math.min(dtS, 0.25);
      clock += dt;
      let any = false;
      if (timeSpeed > 0) {
        time = wrap24(time + (dt * timeSpeed) / 3600);
        any = true;
      }
      const t = WEATHER_TARGETS[preset];
      const before = weather.cloudCover + weather.rain + weather.fog + weather.wetness;
      weather.cloudCover = ease(weather.cloudCover, t.cloudCover, dt, 20);
      weather.fog = ease(weather.fog, t.fog, dt, 20);
      // rain arrives once the clouds are in
      const rainTarget = weather.cloudCover > 0.75 ? t.rain : 0;
      weather.rain = ease(weather.rain, rainTarget, dt, 6);
      if (wetOverride !== null) weather.wetness = wetOverride;
      else if (weather.rain > 0.02) weather.wetness = ease(weather.wetness, clamp01(0.55 + 0.45 * weather.rain), dt, 40);
      else weather.wetness = ease(weather.wetness, 0, dt, 240);
      const after = weather.cloudCover + weather.rain + weather.fog + weather.wetness;
      if (Math.abs(after - before) > 1e-5) any = true;
      if (any) version++;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return ctrl;
}
