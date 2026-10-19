/**
 * Quality controller (contract: render/types.ts CreateQualityController).
 * Owns ctx.quality, persists the chosen level and runs adaptive resolution.
 *
 * Adaptive resolution (AdaptiveScaler, pure): EMA of frame time (τ 1 s);
 * fps below targetFps·0.9 for 2 s → scale −0.1; above targetFps·1.15 for
 * 4 s → +0.05; clamp [minScale, 1].
 * Addition to the contract rule: with vsync the frame rate never exceeds the
 * display rate, so a scale lowered on a 60 Hz display could never recover
 * (60 < 60·1.15). When fps holds ≥ targetFps·0.97 for `probeS` (8 s) the
 * scaler probes +0.05; a probe that drops below the low line within 3 s is
 * a failure: it is undone (−0.05, not −0.1) and the probe interval doubles
 * (cap 64 s), so a GPU sitting at the edge settles instead of oscillating.
 * After any change, frames are ignored for 0.5 s and the EMA restarts, so a
 * stale average cannot trigger a second step.
 */
import { QUALITY_LEVELS, QUALITY_PRESETS, DEFAULT_QUALITY } from '../render/types';
import type {
  AdaptiveResolution,
  CreateQualityController,
  QualityController,
  QualityLevel,
  QualityPreset,
} from '../render/types';

export const QUALITY_STORAGE_KEY = 'crumple.quality.v1';

const EMA_TAU_S = 1;
const LOW_FACTOR = 0.9;
const HIGH_FACTOR = 1.15;
const HOLD_FACTOR = 0.97;
const LOW_HOLD_S = 2;
const HIGH_HOLD_S = 4;
const STEP_DOWN = 0.1;
const STEP_UP = 0.05;
const PROBE_S = 8;
const PROBE_MAX_S = 64;
const PROBE_FAIL_WINDOW_S = 3;
/** Frames longer than this (tab switch, GC, shader compile) are not fed to the EMA. */
const HITCH_S = 0.25;
/** After a scale change, frames are ignored this long (resize + pipeline latency), then the EMA restarts. */
const SETTLE_S = 0.5;

/** Pure adaptive-resolution state machine. */
export class AdaptiveScaler {
  scale = 1;
  /** Smoothed frame time, s (NaN until the first sample). */
  emaFrameS = Number.NaN;
  private cfg: AdaptiveResolution;
  private lowS = 0;
  private highS = 0;
  private holdS = 0;
  private probeS = PROBE_S;
  private sinceUpS = Infinity;
  private lastUpWasProbe = false;
  private settleS = 0;

  constructor(cfg: AdaptiveResolution) {
    this.cfg = cfg;
  }

  reset(cfg: AdaptiveResolution = this.cfg): void {
    this.cfg = cfg;
    this.scale = 1;
    this.emaFrameS = Number.NaN;
    this.lowS = this.highS = this.holdS = 0;
    this.probeS = PROBE_S;
    this.sinceUpS = Infinity;
    this.lastUpWasProbe = false;
    this.settleS = 0;
  }

  get fps(): number {
    return Number.isFinite(this.emaFrameS) && this.emaFrameS > 0 ? 1 / this.emaFrameS : 0;
  }

  /** Feed one frame; returns true when `scale` changed. */
  step(dtS: number): boolean {
    const cfg = this.cfg;
    if (!cfg.enabled) {
      if (this.scale !== 1) {
        this.scale = 1;
        return true;
      }
      return false;
    }
    if (!(dtS > 0) || dtS > HITCH_S) return false;
    if (this.settleS > 0) {
      this.settleS -= dtS;
      return false;
    }
    if (Number.isNaN(this.emaFrameS)) this.emaFrameS = dtS;
    else this.emaFrameS += (dtS - this.emaFrameS) * (1 - Math.exp(-dtS / EMA_TAU_S));
    this.sinceUpS += dtS;

    const fps = 1 / this.emaFrameS;
    const target = cfg.targetFps;
    const minScale = Math.min(1, Math.max(0.1, cfg.minScale));

    this.lowS = fps < target * LOW_FACTOR ? this.lowS + dtS : 0;
    this.highS = fps > target * HIGH_FACTOR ? this.highS + dtS : 0;
    this.holdS = fps >= target * HOLD_FACTOR ? this.holdS + dtS : 0;

    if (this.lowS >= LOW_HOLD_S) {
      const failedProbe = this.lastUpWasProbe && this.sinceUpS <= PROBE_FAIL_WINDOW_S + LOW_HOLD_S;
      this.lastUpWasProbe = false;
      if (failedProbe) {
        // undo just the probe step and wait twice as long before the next one
        this.probeS = Math.min(PROBE_MAX_S, this.probeS * 2);
        return this.set(Math.max(minScale, round2(this.scale - STEP_UP)));
      }
      return this.set(Math.max(minScale, round2(this.scale - STEP_DOWN)));
    }
    if (this.highS >= HIGH_HOLD_S) {
      this.lastUpWasProbe = false;
      return this.set(Math.min(1, round2(this.scale + STEP_UP)), true);
    }
    if (this.holdS >= this.probeS && this.scale < 1) {
      this.lastUpWasProbe = true;
      return this.set(Math.min(1, round2(this.scale + STEP_UP)), true);
    }
    return false;
  }

  private set(scale: number, up = false): boolean {
    this.lowS = this.highS = this.holdS = 0;
    if (up) this.sinceUpS = 0;
    if (scale === this.scale) return false;
    this.scale = scale;
    // measure the new scale afresh: a stale EMA would trigger a second step
    this.emaFrameS = Number.NaN;
    this.settleS = SETTLE_S;
    return true;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ------------------------------------------------------------ persistence
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access can throw (sandboxed iframe, blocked cookies)
  }
}

export function isQualityLevel(x: unknown): x is QualityLevel {
  return typeof x === 'string' && (QUALITY_LEVELS as readonly string[]).includes(x);
}

export function loadQualityLevel(storage: StorageLike | null = defaultStorage()): QualityLevel | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(QUALITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { level?: unknown };
    return isQualityLevel(parsed.level) ? parsed.level : null;
  } catch {
    return null;
  }
}

export function saveQualityLevel(level: QualityLevel, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ level }));
  } catch {
    // quota / privacy mode: the level just is not remembered
  }
}

/** True for software WebGL (SwiftShader, llvmpipe, Microsoft Basic Render): the game then defaults to low. */
export function isSoftwareRenderer(rendererString: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(rendererString);
}

/** Texture anisotropy per preset (low: off — every anisotropic tap multiplies the fetch cost). */
export function anisotropyFor(level: QualityLevel, maxAnisotropy: number): number {
  const max = Math.max(1, maxAnisotropy | 0);
  if (level === 'low') return 1;
  if (level === 'medium') return Math.min(4, max);
  return max;
}

/** Pixel ratio for a preset at an adaptive scale (devicePixelRatio capped, then scaled). */
export function pixelRatioFor(preset: QualityPreset, scale: number, devicePixelRatio: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, preset.pixelRatioCap) * scale;
}

// ------------------------------------------------------------ controller
export interface QualityControllerOptions {
  /** Level to start with when storage holds nothing (default ctx.quality.level, else DEFAULT_QUALITY). */
  initial?: QualityLevel;
  /** Override persistence (tests, or null to disable). */
  storage?: StorageLike | null;
  /** Override devicePixelRatio lookup. */
  devicePixelRatio?: () => number;
  /**
   * Upper bound on the final pixel ratio (after preset cap × adaptive
   * scale), e.g. SOFTWARE_GL_PIXEL_RATIO under a software rasterizer.
   */
  maxPixelRatio?: number;
}

/**
 * Pixel-ratio ceiling under software WebGL (SwiftShader / llvmpipe): every
 * pixel is shaded on the CPU, and the frame cost is ∝ pixels (1280×720 →
 * 640×360 internal; the browser upscales the canvas, the HUD stays crisp).
 */
export const SOFTWARE_GL_PIXEL_RATIO = 0.5;

export const createQualityController: CreateQualityController = (ctx, targets) =>
  createQualityControllerWith(ctx, targets);

export function createQualityControllerWith(
  ctx: Parameters<CreateQualityController>[0],
  targets: Parameters<CreateQualityController>[1],
  opts: QualityControllerOptions = {},
): QualityController {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const dpr = opts.devicePixelRatio ?? (() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  const scaler = new AdaptiveScaler(ctx.quality.adaptiveResolution);

  const maxRatio = opts.maxPixelRatio ?? Infinity;
  const applyResolution = (): void => {
    ctx.renderer.setPixelRatio(Math.min(maxRatio, pixelRatioFor(ctx.quality, scaler.scale, dpr())));
    targets.post.setSize(ctx.width, ctx.height);
  };

  const applyPreset = (preset: QualityPreset): void => {
    ctx.quality = preset;
    scaler.reset(preset.adaptiveResolution);
    targets.lighting.setQuality(preset);
    targets.post.setQuality(preset);
    for (const o of targets.others ?? []) o.setQuality(preset);
    applyResolution();
  };

  const start = loadQualityLevel(storage) ?? opts.initial ?? ctx.quality.level ?? DEFAULT_QUALITY;
  applyPreset(QUALITY_PRESETS[start]);

  return {
    get preset() {
      return ctx.quality;
    },
    get scale() {
      return scaler.scale;
    },
    setLevel(level: QualityLevel) {
      if (!isQualityLevel(level)) throw new Error(`unknown quality level ${String(level)}`);
      saveQualityLevel(level, storage);
      applyPreset(QUALITY_PRESETS[level]);
    },
    frame(dtS: number) {
      if (scaler.step(dtS)) applyResolution();
    },
  };
}
