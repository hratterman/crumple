import { describe, expect, it } from 'vitest';
import { SOLVER_PRESETS } from '../protocol/messages';
import { autoPhysicsQuality, HIGH_MIN_RATE, resolvePhysicsQuality, solverFor, ULTRA_MIN_RATE } from './physicsQuality';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

describe('physics quality (R-CORE scaffold)', () => {
  it('auto picks the tier from the boot kernel bench', () => {
    expect(autoPhysicsQuality('simd', ULTRA_MIN_RATE + 1)).toBe('ultra');
    expect(autoPhysicsQuality('simd', HIGH_MIN_RATE + 1)).toBe('high');
    expect(autoPhysicsQuality('wasm', HIGH_MIN_RATE - 1)).toBe('standard');
    expect(autoPhysicsQuality('js', 45)).toBe('standard');
    // No bench (an old worker): JS → standard, WASM → high.
    expect(autoPhysicsQuality('js', 0)).toBe('standard');
    expect(autoPhysicsQuality('simd', 0)).toBe('high');
  });
  it('an explicit setting wins; ?physics= overrides both', () => {
    const fast = { kernel: 'simd' as const, kernelBench: 500 };
    expect(resolvePhysicsQuality('auto', fast)).toBe('ultra');
    expect(resolvePhysicsQuality('standard', fast)).toBe('standard');
    expect(resolvePhysicsQuality('auto', fast, '?physics=high')).toBe('high');
    expect(resolvePhysicsQuality('ultra', fast, '?physics=bogus')).toBe('ultra');
    // Automation keeps the standard rigs unless a spec asks.
    expect(resolvePhysicsQuality('auto', fast, '', true)).toBe('standard');
    expect(resolvePhysicsQuality('auto', fast, '?physics=ultra', true)).toBe('ultra');
  });
  it('solver presets: spheres at standard, triangles at high, + self-collision at ultra; CCD everywhere', () => {
    expect(solverFor('standard')).toEqual({ triangleContact: false, selfCollision: false, ccd: true });
    expect(solverFor('high')).toEqual({ triangleContact: true, selfCollision: false, ccd: true });
    expect(solverFor('ultra')).toEqual(SOLVER_PRESETS.ultra);
    expect(solverFor('ultra')).not.toBe(SOLVER_PRESETS.ultra);
  });
  it('the setting persists and sanitizes', () => {
    expect(DEFAULT_SETTINGS.physicsQuality).toBe('auto');
    expect(sanitizeSettings({ physicsQuality: 'ultra' }).physicsQuality).toBe('ultra');
    expect(sanitizeSettings({ physicsQuality: 'max' }).physicsQuality).toBe('auto');
  });
});
