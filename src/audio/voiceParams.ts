/**
 * AudioParam names of the worklet voices (shared by the processors and the
 * main-thread voice handles; no WebAudio / worklet globals here).
 */
import type { EngineProfile } from './profiles';

export const ENGINE_PARAMS = ['rpm', 'throttle', 'load', 'gate', 'pitch', 'limiter', 'crank', 'shift', 'damage', 'horn'] as const;
export const SURFACE_PARAMS = [
  'pitch',
  'speed',
  'squealF',
  'squealR',
  'squealPitchF',
  'squealPitchR',
  'squealHz',
  'scrub',
  'roar',
  'roarTone',
  'gravel',
  'dirt',
  'grass',
  'scrape',
  'scrapeSpeed',
  'thumpCount',
  'thumpAmp',
  'wind',
  'windSpeed',
] as const;
export const AMBIENCE_PARAMS = ['birds', 'breeze', 'crickets', 'water', 'pitch'] as const;

export interface EngineProcessorOptions {
  profile: EngineProfile;
  seed: number;
  light: boolean;
}

export type EngineParam = (typeof ENGINE_PARAMS)[number];
export type SurfaceParam = (typeof SURFACE_PARAMS)[number];
export type AmbienceParam = (typeof AMBIENCE_PARAMS)[number];
