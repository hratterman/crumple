/**
 * Player settings (P6 S1, pause menu): speed units, traffic density,
 * traction-control default, chase-camera framing, field of view, the
 * audio placeholder and (P7) the crash cam. Pure (no DOM, no three): storage is injected, every
 * read is validated field by field (an unknown or corrupt value falls back
 * to its default) and storage errors are ignored, like the quality level
 * (`crumple.quality.v1`, owned by app/quality.ts).
 */
import type { TrafficDensity } from '../protocol/traffic';
import { TRAFFIC_MAX_AGENTS } from '../protocol/traffic';
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
  chase: ChaseFraming;
  /** Chase camera base field of view, degrees. */
  fov: number;
  /** 0..1, reserved for the P8 synthesized audio. */
  volume: number;
  /** P7: a severe crash plays back as an instant replay (crash cam) before driving on. */
  crashCam: boolean;
}

export const SPEED_UNITS: readonly SpeedUnits[] = ['kmh', 'mph'];
export const TRAFFIC_SETTINGS: readonly TrafficSetting[] = ['off', 'light', 'normal', 'heavy'];
export const CHASE_FRAMINGS: readonly ChaseFraming[] = ['near', 'normal', 'far'];
export const FOV_CHOICES: readonly number[] = [55, 60, 65, 70, 75];

export const DEFAULT_SETTINGS: Readonly<GameSettings> = {
  units: 'kmh',
  traffic: 'normal',
  tractionControl: true,
  chase: 'normal',
  fov: 60,
  volume: 0.8,
  crashCam: true,
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
  const vol = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : d.volume;
  return {
    units: pick(SPEED_UNITS, o.units, d.units),
    traffic: pick(TRAFFIC_SETTINGS, o.traffic, d.traffic),
    tractionControl: typeof o.tractionControl === 'boolean' ? o.tractionControl : d.tractionControl,
    chase: pick(CHASE_FRAMINGS, o.chase, d.chase),
    fov: pick(FOV_CHOICES, o.fov, d.fov),
    volume: vol,
    crashCam: typeof o.crashCam === 'boolean' ? o.crashCam : d.crashCam,
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
