/**
 * R-CORE physics quality (docs/CONTRACTS.md "R-CORE"): the setting, its
 * 'auto' resolution from the worker's boot kernel bench, and what a quality
 * means (rig tier via R-RIG's loadVehicleVariant, solver preset). Pure.
 *
 * AUTO: the worker times its installed kernel's beam pass on a synthetic
 * car-like lattice at boot (ReadyMsg.kernelBench, M beam-updates/s on one
 * core). A rig tier costs roughly (beams × 2000 Hz) / rate for the beam pass,
 * ≈ 40 % of a car's step on the WASM kernels; the thresholds keep the player
 * car's physics well under a quarter of a core with the rest of the scene
 * (traffic, props) on top:
 *   ultra (≈ 8.7 k beams, HD sedan)  ≥ ULTRA_MIN_RATE
 *   high  (≈ 5.9 k beams)            ≥ HIGH_MIN_RATE
 *   standard otherwise (JS kernel fallbacks land here).
 */
import { PHYSICS_QUALITIES, SOLVER_PRESETS, type PhysicsKernelKind, type PhysicsQuality, type SolverOptions } from '../protocol/messages';

export type PhysicsQualitySetting = 'auto' | PhysicsQuality;
export const PHYSICS_QUALITY_SETTINGS: readonly PhysicsQualitySetting[] = ['auto', ...PHYSICS_QUALITIES];

/** M beam-updates/s of the boot bench needed for each tier (measured: SIMD ≈ 110–200 on desktop cores, JS ≈ 40–60). */
export const ULTRA_MIN_RATE = 140;
export const HIGH_MIN_RATE = 80;

export function autoPhysicsQuality(kernel: PhysicsKernelKind, bench: number): PhysicsQuality {
  if (!(bench > 0)) return kernel === 'js' ? 'standard' : 'high';
  if (bench >= ULTRA_MIN_RATE) return 'ultra';
  if (bench >= HIGH_MIN_RATE) return 'high';
  return 'standard';
}

/**
 * The effective quality: an explicit setting wins; ?physics= overrides both (tests / tools). Under
 * automation (`webdriver`: e2e specs) 'auto' is 'standard', so every spec keeps the standard rigs unless
 * it asks for a tier (as the crash cam is off there).
 */
export function resolvePhysicsQuality(setting: PhysicsQualitySetting, ready: { kernel: PhysicsKernelKind; kernelBench: number }, search = '', webdriver = false): PhysicsQuality {
  const forced = new URLSearchParams(search).get('physics');
  if (forced && (PHYSICS_QUALITIES as readonly string[]).includes(forced)) return forced as PhysicsQuality;
  if (setting !== 'auto') return setting;
  return webdriver ? 'standard' : autoPhysicsQuality(ready.kernel, ready.kernelBench);
}

export function solverFor(q: PhysicsQuality): SolverOptions {
  return { ...SOLVER_PRESETS[q] };
}

export function physicsQualityLabel(s: PhysicsQualitySetting): string {
  return s === 'auto' ? 'Auto' : s === 'standard' ? 'Standard' : s === 'high' ? 'High' : 'Ultra';
}
