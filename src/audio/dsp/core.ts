/**
 * DSP building blocks for the synthesized audio (P8). PURE: no DOM, no
 * WebAudio, no allocation after construction. The same code runs inside the
 * AudioWorklet processors, in the plain-node fallback (offline buffers) and in
 * node tests / WAV renders, so what the spectrograms show is what plays.
 *
 * Conventions: every filter takes its coefficients from `set*` calls (once per
 * render block, never per sample) and processes one sample with `tick(x)`.
 */

const TAU = Math.PI * 2;

/** xorshift32 noise source; deterministic per seed. */
export class Noise {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** Uniform in [0, 1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s * 2.3283064365386963e-10;
  }
  /** Uniform in [-1, 1). */
  white(): number {
    return this.next() * 2 - 1;
  }
  /** Approximately N(0, 1) (sum of 4 uniforms, scaled). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
}

/** One-pole low-pass `y += a·(x − y)`. */
export class OnePole {
  y = 0;
  a = 1;
  /** Cutoff in Hz (−3 dB, matched-z). */
  setHz(hz: number, sr: number): void {
    this.a = 1 - Math.exp((-TAU * Math.max(hz, 0.01)) / sr);
  }
  /** Time constant in seconds. */
  setTau(tau: number, sr: number): void {
    this.a = 1 - Math.exp(-1 / (Math.max(tau, 1e-6) * sr));
  }
  tick(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
  reset(): void {
    this.y = 0;
  }
}

/** DC blocker (one-zero one-pole high-pass). */
export class DcBlock {
  private x1 = 0;
  private y1 = 0;
  private r = 0.995;
  setHz(hz: number, sr: number): void {
    this.r = Math.exp((-TAU * hz) / sr);
  }
  tick(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/**
 * Topology-preserving state-variable filter (Zavalishin): stable under
 * per-block coefficient modulation; low / band / high outputs from one tick.
 * `bp` is the constant-skirt band-pass (peak gain = 1/(2·damping)·…); `bpn`
 * is normalised to 0 dB at the centre.
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 1.4;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  set(hz: number, q: number, sr: number): void {
    const f = Math.min(Math.max(hz, 5), sr * 0.49);
    this.g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / Math.max(q, 0.05);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  tick(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }
  /** Band-pass normalised to unity gain at the centre frequency. */
  get bpn(): number {
    return this.bp * this.k;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
    this.lp = this.bp = this.hp = 0;
  }
}

/** RBJ biquad (direct form I) for fixed EQ (peaking / shelves). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  peaking(hz: number, q: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * Math.min(hz, sr * 0.49)) / sr;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0;
    this.b1 = (-2 * c) / a0;
    this.b2 = (1 - al * A) / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al / A) / a0;
  }
  highShelf(hz: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * Math.min(hz, sr * 0.49)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / Math.SQRT2;
    const s = 2 * Math.sqrt(A) * al;
    const a0 = A + 1 - (A - 1) * c + s;
    this.b0 = (A * (A + 1 + (A - 1) * c + s)) / a0;
    this.b1 = (-2 * A * (A - 1 + (A + 1) * c)) / a0;
    this.b2 = (A * (A + 1 + (A - 1) * c - s)) / a0;
    this.a1 = (2 * (A - 1 - (A + 1) * c)) / a0;
    this.a2 = (A + 1 - (A - 1) * c - s) / a0;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Fractional delay line (linear interpolation), fixed capacity. */
export class Delay {
  private readonly buf: Float32Array;
  private w = 0;
  constructor(capacity: number) {
    this.buf = new Float32Array(Math.max(4, capacity | 0));
  }
  get capacity(): number {
    return this.buf.length;
  }
  write(x: number): void {
    this.buf[this.w] = x;
    this.w = this.w + 1 === this.buf.length ? 0 : this.w + 1;
  }
  /** Sample written `d` samples ago (1 ≤ d ≤ capacity − 2). */
  read(d: number): number {
    const n = this.buf.length;
    const dd = d < 1 ? 1 : d > n - 2 ? n - 2 : d;
    const i = Math.floor(dd);
    const f = dd - i;
    let r0 = this.w - i;
    if (r0 < 0) r0 += n;
    let r1 = r0 - 1;
    if (r1 < 0) r1 += n;
    return this.buf[r0]! * (1 - f) + this.buf[r1]! * f;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

/** sin(2π·p) for p in [0, 1) (parabolic approximation with one refinement; error < 0.1 %). */
export function sin01(p: number): number {
  const u = p < 0.5 ? p : p - 1; // [-0.5, 0.5)
  const y = 8 * u - 16 * u * (u < 0 ? -u : u);
  return 0.225 * (y * (y < 0 ? -y : y) - y) + y;
}

/** Soft saturation: linear below ~0.6, smooth to ±1 (rational tanh). */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Linear interpolation helper. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
