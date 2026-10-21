/**
 * `window.__crumple.env` — the time-of-day / weather surface for tests,
 * screenshot tools and the console (not a gameplay API: settings and photo
 * mode drive the same EnvironmentController directly).
 */
import type { EnvironmentController, WeatherPreset, WeatherState } from './environment';
import { isWeatherPreset } from './environment';

export interface EnvPatch {
  /** Local solar hours. */
  time?: number;
  timeSpeed?: number;
  weather?: WeatherPreset;
  /** Weather change without easing (default true through this API). */
  instant?: boolean;
  /** Surface wetness override 0..1, or null for rain-driven. */
  wetness?: number | null;
  /** Player headlights: 'off' | 'low' | 'high' | 'auto' (handled by a registered hook). */
  headlights?: string;
}

export interface EnvDebugApi {
  readonly state: { time: number; timeSpeed: number; preset: WeatherPreset; weather: WeatherState };
  set(patch: EnvPatch): void;
}

type ExtraHook = (patch: EnvPatch) => void;
const extraHooks = new Set<ExtraHook>();

/** Lets other systems (player lamps) act on fields of `__crumple.env.set`. */
export function addEnvApiHook(hook: ExtraHook): () => void {
  extraHooks.add(hook);
  return () => extraHooks.delete(hook);
}

export function envDebugApi(env: EnvironmentController): EnvDebugApi {
  return {
    get state() {
      return { time: env.time, timeSpeed: env.timeSpeed, preset: env.preset, weather: { ...env.weather } };
    },
    set(patch: EnvPatch) {
      if (typeof patch.time === 'number') env.setTime(patch.time);
      if (typeof patch.timeSpeed === 'number') env.setTimeSpeed(patch.timeSpeed);
      if (isWeatherPreset(patch.weather)) env.setWeather(patch.weather, patch.instant ?? true);
      if (patch.wetness !== undefined) env.setWetness(patch.wetness);
      for (const h of extraHooks) h(patch);
    },
  };
}
