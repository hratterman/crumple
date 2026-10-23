/**
 * Player settings (P6 S1, pause menu): speed units, traffic density,
 * traction-control default, chase-camera framing, field of view, the
 * audio placeholder and (P7) the crash cam. Pure (no DOM, no three): storage is injected, every
 * read is validated field by field (an unknown or corrupt value falls back
 * to its default) and storage errors are ignored, like the quality level
 * (`crumple.quality.v1`, owned by app/quality.ts).
 */
import { PHYSICS_QUALITY_SETTINGS, type PhysicsQualitySetting } from './physicsQuality';
import type { TrafficDensity } from '../protocol/traffic';
import { TRAFFIC_MAX_AGENTS } from '../protocol/traffic';
import { DEFAULT_TIME_OF_DAY, WEATHER_PRESETS, type WeatherPreset } from '../render/lighting/environment';
import type { StorageLike } from './quality';

export const SETTINGS_KEY = 'crumple.settings.v1';

export type SpeedUnits = 'kmh' | 'mph';
export type TrafficSetting = 'off' | 'light' | 'normal' | 'heavy';
export type ChaseFraming = 'near' | 'normal' | 'far';

export interface GameSettings {
  units: SpeedUnits;
  traffic: TrafficSetting;
  /** Traction control engaged on every spawn / swap (X still toggles it while driving). */
  tractionControl: boolean;
  /** R-PHYS: anti-lock brakes / stability control engaged on every spawn / swap (vehicles that have them). */
  abs: boolean;
  esc: boolean;
  chase: ChaseFraming;
  /** Chase camera base field of view, degrees. */
  fov: number;
  /** P8 audio: master volume 0..1. */
  volume: number;
  /** P8 audio: bus volumes 0..1 and mute. */
  engineVolume: number;
  effectsVolume: number;
  ambienceVolume: number;
  muted: boolean;
  /** P7: a severe crash plays back as an instant replay (crash cam) before driving on. */
  crashCam: boolean;
  /** R-GFX: time of day at load, local solar hours [0, 24). */
  timeOfDay: number;
  /** R-GFX: time progression, game seconds per real second (0 = frozen). */
  timeSpeed: number;
  /** R-GFX: weather preset. */
  weather: WeatherPreset;
  /** R-CORE: physics quality (rig tier + solver); 'auto' = from the worker's boot kernel bench. */
  physicsQuality: PhysicsQualitySetting;
}

export const SPEED_UNITS: readonly SpeedUnits[] = ['kmh', 'mph'];
export const TRAFFIC_SETTINGS: readonly TrafficSetting[] = ['off', 'light', 'normal', 'heavy'];
export const CHASE_FRAMINGS: readonly ChaseFraming[] = ['near', 'normal', 'far'];
export const FOV_CHOICES: readonly number[] = [55, 60, 65, 70, 75];
/** R-GFX time progression choices (game s per real s): frozen, real time, 1 game min/s, 2, 10. */
export const TIME_SPEED_CHOICES: readonly number[] = [0, 1, 60, 120, 600];

export const DEFAULT_SETTINGS: Readonly<GameSettings> = {
  units: 'kmh',
  traffic: 'normal',
  tractionControl: true,
  abs: true,
  esc: true,
  chase: 'normal',
  fov: 60,
  volume: 0.8,
  engineVolume: 1,
  effectsVolume: 1,
  ambienceVolume: 0.8,
  muted: false,
  crashCam: true,
  timeOfDay: DEFAULT_TIME_OF_DAY,
  timeSpeed: 0,
  weather: 'clear',
  physicsQuality: 'auto',
};

export const KMH_PER_MPH = 1.609344;

/** Display factor from km/h. */
export function unitsPerKmh(u: SpeedUnits): number {
  return u === 'mph' ? 1 / KMH_PER_MPH : 1;
}

export function unitLabel(u: SpeedUnits): string {
  return u === 'mph' ? 'mph' : 'km/h';
}

/** Multiplier on the catalog's chase distance / height. */
export function chaseScale(f: ChaseFraming): number {
  return f === 'near' ? 0.82 : f === 'far' ? 1.25 : 1;
}

/** Agent-count factor of a traffic setting over the quality preset's density. */
export function trafficFactor(s: TrafficSetting): number {
  return s === 'off' ? 0 : s === 'light' ? 0.5 : s === 'heavy' ? 1.5 : 1;
}

/**
 * The preset's traffic density scaled by the setting: agents × factor
 * (rounded, ≤ TRAFFIC_MAX_AGENTS; 'off' = 0 agents = no traffic); the awake
 * budget (maxAwake, awakePoolBeams) is a physics cost and stays the preset's.
 */
export function trafficDensityFor(preset: Readonly<TrafficDensity>, s: TrafficSetting): TrafficDensity {
  const agents = Math.min(TRAFFIC_MAX_AGENTS, Math.max(0, Math.round(preset.agents * trafficFactor(s))));
  return { agents, maxAwake: preset.maxAwake, awakePoolBeams: preset.awakePoolBeams };
}

function pick<T>(allowed: readonly T[], v: unknown, fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Field-wise validation of anything (parsed JSON) into settings. */
export function sanitizeSettings(raw: unknown): GameSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const unit = (v: unknown, f: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : f);
  const vol = unit(o.volume, d.volume);
  return {
    units: pick(SPEED_UNITS, o.units, d.units),
    traffic: pick(TRAFFIC_SETTINGS, o.traffic, d.traffic),
    tractionControl: typeof o.tractionControl === 'boolean' ? o.tractionControl : d.tractionControl,
    abs: typeof o.abs === 'boolean' ? o.abs : d.abs,
    // ESC brakes through the ABS modulator: no ESC without ABS
    esc: (typeof o.esc === 'boolean' ? o.esc : d.esc) && o.abs !== false,
    chase: pick(CHASE_FRAMINGS, o.chase, d.chase),
    fov: pick(FOV_CHOICES, o.fov, d.fov),
    volume: vol,
    engineVolume: unit(o.engineVolume, d.engineVolume),
    effectsVolume: unit(o.effectsVolume, d.effectsVolume),
    ambienceVolume: unit(o.ambienceVolume, d.ambienceVolume),
    muted: typeof o.muted === 'boolean' ? o.muted : d.muted,
    crashCam: typeof o.crashCam === 'boolean' ? o.crashCam : d.crashCam,
    timeOfDay: typeof o.timeOfDay === 'number' && Number.isFinite(o.timeOfDay) ? ((o.timeOfDay % 24) + 24) % 24 : d.timeOfDay,
    timeSpeed: pick(TIME_SPEED_CHOICES, o.timeSpeed, d.timeSpeed),
    weather: pick(WEATHER_PRESETS, o.weather, d.weather),
    physicsQuality: pick(PHYSICS_QUALITY_SETTINGS, o.physicsQuality, d.physicsQuality),
  };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(storage: StorageLike | null = defaultStorage()): GameSettings {
  try {
    const s = storage?.getItem(SETTINGS_KEY);
    return sanitizeSettings(s ? JSON.parse(s) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Readonly<GameSettings>, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(s)));
  } catch {
    // private mode / quota: the setting lasts this session only
  }
}
