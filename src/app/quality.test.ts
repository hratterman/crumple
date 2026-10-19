import { describe, expect, it, vi } from 'vitest';

import { QUALITY_PRESETS } from '../render/types';
import type { LightingStack, PostStack, QualityPreset, RenderContext } from '../render/types';
import {
  AdaptiveScaler,
  createQualityControllerWith,
  loadQualityLevel,
  pixelRatioFor,
  QUALITY_STORAGE_KEY,
  saveQualityLevel,
} from './quality';
import type { StorageLike } from './quality';

const cfg = { enabled: true, targetFps: 60, minScale: 0.6 };

/** Feed `seconds` of frames at a constant fps; returns the scale history at each change. */
function feed(s: AdaptiveScaler, fps: number, seconds: number): number[] {
  const changes: number[] = [];
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) if (s.step(dt)) changes.push(s.scale);
  return changes;
}

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('AdaptiveScaler', () => {
  it('holds scale 1 at target', () => {
    const s = new AdaptiveScaler(cfg);
    expect(feed(s, 60, 30)).toEqual([]);
    expect(s.scale).toBe(1);
  });

  it('drops 0.1 after ~2 s below 0.9·target (plus EMA settle), repeatedly, clamped at minScale', () => {
    const s = new AdaptiveScaler(cfg);
    const first = feed(s, 40, 2.5);
    expect(first).toEqual([0.9]);
    feed(s, 40, 20);
    expect(s.scale).toBe(0.6);
  });

  it('does not react to a short dip (hysteresis)', () => {
    const s = new AdaptiveScaler(cfg);
    feed(s, 60, 5);
    feed(s, 45, 1.2);
    feed(s, 60, 5);
    expect(s.scale).toBe(1);
  });

  it('ignores hitches (tab switch, compile stalls)', () => {
    const s = new AdaptiveScaler(cfg);
    for (let i = 0; i < 50; i++) s.step(0.5);
    expect(s.scale).toBe(1);
    expect(Number.isNaN(s.emaFrameS)).toBe(true);
  });

  it('steps up 0.05 after 4 s above 1.15·target', () => {
    const s = new AdaptiveScaler(cfg);
    feed(s, 30, 2.2);
    expect(s.scale).toBe(0.9);
    // EMA needs ~1.8 s to cross 69 fps, then 4 s above it
    const ups = feed(s, 90, 7);
    expect(ups).toEqual([0.95]);
  });

  it('recovers under vsync (fps pinned at target) via probing', () => {
    const s = new AdaptiveScaler(cfg);
    feed(s, 30, 2.4);
    expect(s.scale).toBe(0.9);
    // display-capped at exactly the target: never > 1.15·target
    feed(s, 60, 25);
    expect(s.scale).toBe(1);
  });

  it('backs off probing when probes fail (no 2-scale oscillation every few seconds)', () => {
    const s = new AdaptiveScaler(cfg);
    // GPU that manages 60 fps at 0.9 but only 50 fps at 0.95+
    let changes = 0;
    let lowest = 1;
    const dt = 1 / 60;
    for (let t = 0; t < 120; t += dt) {
      const fps = s.scale <= 0.9 ? 60 : 50;
      if (s.step(1 / fps)) changes++;
      lowest = Math.min(lowest, s.scale);
    }
    expect(lowest).toBe(0.9);
    // first drop to 0.9, then probe/undo cycles at 8, 16, 32, 64 s intervals → few changes, never below 0.9
    expect(changes).toBeLessThanOrEqual(9);
    expect(s.scale === 0.9 || s.scale === 0.95).toBe(true);
  });

  it('disabled → scale forced to 1', () => {
    const s = new AdaptiveScaler({ ...cfg, enabled: false });
    feed(s, 10, 10);
    expect(s.scale).toBe(1);
  });
});

describe('quality persistence', () => {
  it('round-trips the level and ignores junk', () => {
    const st = memStorage();
    expect(loadQualityLevel(st)).toBeNull();
    saveQualityLevel('ultra', st);
    expect(loadQualityLevel(st)).toBe('ultra');
    st.data[QUALITY_STORAGE_KEY] = '{"level":"potato"}';
    expect(loadQualityLevel(st)).toBeNull();
    st.data[QUALITY_STORAGE_KEY] = 'not json';
    expect(loadQualityLevel(st)).toBeNull();
  });

  it('swallows throwing storage', () => {
    const bad: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadQualityLevel(bad)).toBeNull();
    expect(() => saveQualityLevel('low', bad)).not.toThrow();
  });
});

describe('pixelRatioFor', () => {
  it('caps devicePixelRatio then scales', () => {
    expect(pixelRatioFor(QUALITY_PRESETS.high, 1, 3)).toBe(1.5);
    expect(pixelRatioFor(QUALITY_PRESETS.high, 0.8, 1)).toBeCloseTo(0.8);
    expect(pixelRatioFor(QUALITY_PRESETS.ultra, 1, 2)).toBe(2);
  });
});

describe('createQualityController', () => {
  function harness(storage: StorageLike | null) {
    const setPixelRatio = vi.fn();
    const ctx = {
      renderer: { setPixelRatio },
      quality: QUALITY_PRESETS.high,
      width: 1920,
      height: 1080,
    } as unknown as RenderContext;
    const seen: string[] = [];
    const rec = (who: string) => (q: QualityPreset) => seen.push(`${who}:${q.level}`);
    const post = { setQuality: vi.fn(rec('post')), setSize: vi.fn() } as unknown as PostStack;
    const lighting = { setQuality: vi.fn(rec('lighting')) } as unknown as LightingStack;
    const other = { setQuality: vi.fn(rec('terrain')) };
    const qc = createQualityControllerWith(ctx, { lighting, post, others: [other] }, { storage, devicePixelRatio: () => 2 });
    return { qc, ctx, seen, setPixelRatio, post };
  }

  it('starts from the persisted level and pushes it to every stack', () => {
    const st = memStorage({ [QUALITY_STORAGE_KEY]: '{"level":"medium"}' });
    const { qc, ctx, seen, setPixelRatio } = harness(st);
    expect(qc.preset.level).toBe('medium');
    expect(ctx.quality).toBe(QUALITY_PRESETS.medium);
    expect(seen).toEqual(['lighting:medium', 'post:medium', 'terrain:medium']);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1.25);
  });

  it('setLevel persists, resets scale and re-applies resolution', () => {
    const st = memStorage();
    const { qc, setPixelRatio, post } = harness(st);
    for (let i = 0; i < 200; i++) qc.frame(1 / 30);
    expect(qc.scale).toBeLessThan(1);
    qc.setLevel('low');
    expect(qc.scale).toBe(1);
    expect(loadQualityLevel(st)).toBe('low');
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(post.setSize).toHaveBeenLastCalledWith(1920, 1080);
  });

  it('adaptive scale changes call setPixelRatio + post.setSize', () => {
    const { qc, setPixelRatio, post } = harness(null);
    const before = (post.setSize as ReturnType<typeof vi.fn>).mock.calls.length;
    for (let i = 0; i < 100; i++) qc.frame(1 / 30);
    expect(qc.scale).toBe(0.9);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1.5 * 0.9);
    expect((post.setSize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
  });
});

describe('software GL / anisotropy helpers (perf pass)', () => {
  it('detects software rasterizers', async () => {
    const { isSoftwareRenderer } = await import('./quality');
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(isSoftwareRenderer('Apple M2')).toBe(false);
  });

  it('anisotropy per preset', async () => {
    const { anisotropyFor } = await import('./quality');
    expect(anisotropyFor('low', 16)).toBe(1);
    expect(anisotropyFor('medium', 16)).toBe(4);
    expect(anisotropyFor('high', 16)).toBe(16);
    expect(anisotropyFor('high', 0)).toBe(1);
  });

  it('maxPixelRatio caps the final ratio', () => {
    const ratios: number[] = [];
    const ctx = {
      renderer: { setPixelRatio: (r: number) => ratios.push(r) },
      quality: QUALITY_PRESETS.high,
      width: 100,
      height: 100,
    } as unknown as RenderContext;
    const post = { setSize: () => {}, setQuality: () => {} } as unknown as PostStack;
    const lighting = { setQuality: () => {} } as unknown as LightingStack;
    createQualityControllerWith(ctx, { lighting, post }, { storage: null, devicePixelRatio: () => 2, maxPixelRatio: 0.5 });
    expect(ratios.at(-1)).toBe(0.5);
  });
});
