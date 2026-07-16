/**
 * Seeded deterministic PRNG: mulberry32 core, splitmix32-style seeding.
 *
 * Determinism guarantee: every operation is 32-bit integer arithmetic
 * (`Math.imul`, xor, shift) plus one exact dyadic division by 2^32 — all
 * IEEE-754-exact — so a given seed produces the identical sequence in every
 * JS engine, in workers, on the main thread, and in tests. `fork(streamId)`
 * derives the child purely from (original seed, streamId), NOT from the
 * parent's current state, so child streams are stable no matter how many
 * values the parent has already drawn or in what order forks are created.
 */

export interface Rng {
  /** The 32-bit seed this stream was created from. */
  readonly seed: number;
  /** Uniform float in [0, 1). */
  float(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty array. Throws on empty input. */
  pick<T>(items: ArrayLike<T>): T;
  /** Independent deterministic child stream keyed by (seed, streamId). */
  fork(streamId: number): Rng;
}

// splitmix32 finalizer: full-avalanche 32-bit mix. Used to condition raw
// seeds (so seeds 0,1,2… give uncorrelated streams) and to derive fork seeds.
function mix32(x: number): number {
  let t = (x + 0x9e3779b9) | 0;
  t ^= t >>> 16;
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

export function createRng(seed: number): Rng {
  const seed32 = seed >>> 0;
  // Two mix rounds ≈ splitmix32 warmup: decorrelates adjacent raw seeds.
  let state = mix32(mix32(seed32)) | 0;

  const float = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + float() * (max - min);

  const int = (min: number, max: number): number =>
    min + Math.floor(float() * (max - min + 1));

  const pick = <T>(items: ArrayLike<T>): T => {
    if (items.length === 0) throw new RangeError('rng.pick: empty array');
    return items[int(0, items.length - 1)] as T;
  };

  const fork = (streamId: number): Rng =>
    // Child seed depends only on (seed32, streamId): stable regardless of
    // how much the parent stream has been consumed.
    createRng(mix32(seed32 ^ mix32(streamId >>> 0)));

  return { seed: seed32, float, range, int, pick, fork };
}
