/**
 * Frame profiler (?perf=1, or the ` key's overlay): main-thread CPU per
 * subsystem plus GPU work per pass (draw calls / triangles of the scene,
 * each CSM cascade, AO and the effect passes).
 *
 *  - CPU: `begin()` at the top of a frame, `lap(name)` after each
 *    subsystem (time since the previous lap), `add(name, ms)` for nested
 *    timings (vehicle internals). Stats are the mean over the last
 *    RING_FRAMES frames (avg) and a 1 s window max per section. Zero
 *    allocation once every section has been seen.
 *  - GPU: `PassCounter` sets renderer.info.autoReset = false while attached
 *    and wraps `renderer.setRenderTarget` and each composer pass's `render`:
 *    every draw between two target switches is charged to the current key,
 *    `<pass>` or `shadow:csm<i>` (the cascade's shadow map). Shadow maps are
 *    re-rendered by EVERY renderer.render of a lit scene (three's
 *    shadowMap.autoUpdate), so extra scene renders show up as extra
 *    cascade passes here.
 */
import type { Camera, Object3D, WebGLRenderer, WebGLRenderTarget } from 'three';

/** Frames in the rolling mean (a few seconds at 60 fps; no slow EMA warm-up after boot hitches). */
const RING_FRAMES = 120;

class Ring {
  private readonly buf = new Float64Array(RING_FRAMES);
  private sum = 0;
  private n = 0;
  private i = 0;
  push(x: number): void {
    this.sum += x - this.buf[this.i]!;
    this.buf[this.i] = x;
    this.i = (this.i + 1) % RING_FRAMES;
    if (this.n < RING_FRAMES) this.n++;
  }
  get mean(): number {
    return this.n > 0 ? this.sum / this.n : 0;
  }
}
const WINDOW_MS = 1000;

export interface SectionStat {
  readonly name: string;
  /** ms in the latest frame (0 if the section did not run). */
  last: number;
  /** Mean ms per frame over the last RING_FRAMES frames. */
  avg: number;
  ring: Ring;
  /** Max ms over the last completed 1 s window. */
  max: number;
  /** Running max of the current window. */
  winMax: number;
  /** Accumulator of the frame in progress. */
  acc: number;
}

function section(name: string): SectionStat {
  return { name, last: 0, avg: 0, max: 0, winMax: 0, acc: 0, ring: new Ring() };
}

export interface FrameProfilerSnapshot {
  fps: number;
  frameMs: number;
  frameMaxMs: number;
  cpuMs: number;
  cpuMaxMs: number;
  sections: Record<string, { avg: number; max: number }>;
}

/** Main-thread section timer. Disabled → every call is a cheap early-out. */
export class FrameProfiler {
  enabled: boolean;
  readonly sections = new Map<string, SectionStat>();
  /** Section names in first-seen order (display order). */
  readonly order: string[] = [];
  /** Mean interval between begin() calls, ms (last RING_FRAMES frames). */
  frameMs = 0;
  frameMaxMs = 0;
  /** Mean of the summed laps (scripted main-thread time) per frame, ms. */
  cpuMs = 0;
  cpuMaxMs = 0;
  private t = 0;
  private frameStart = Number.NaN;
  private winStart = 0;
  private winFrameMax = 0;
  private winCpuMax = 0;
  private cpuAcc = 0;
  private readonly frameRing = new Ring();
  private readonly cpuRing = new Ring();
  private readonly now: () => number;

  constructor(enabled = false, now: () => number = () => performance.now()) {
    this.enabled = enabled;
    this.now = now;
  }

  private stat(name: string): SectionStat {
    let s = this.sections.get(name);
    if (!s) {
      s = section(name);
      this.sections.set(name, s);
      this.order.push(name);
    }
    return s;
  }

  /** Top of a frame: closes the previous one. */
  begin(): void {
    if (!this.enabled) return;
    const n = this.now();
    if (!Number.isNaN(this.frameStart)) this.close(n);
    this.frameStart = n;
    this.t = n;
  }

  /** Charges the time since the previous lap/begin to `name`. */
  lap(name: string): void {
    if (!this.enabled) return;
    const n = this.now();
    const ms = n - this.t;
    this.t = n;
    this.stat(name).acc += ms;
    this.cpuAcc += ms;
  }

  /** Adds `ms` to `name` without moving the lap clock (nested detail of a lapped section). */
  add(name: string, ms: number): void {
    if (!this.enabled) return;
    this.stat(name).acc += ms;
  }

  /** Wraps `obj[key]` (a method) so each call is charged to `name` via add(). Returns an undo. */
  wrap<T extends object, K extends keyof T>(obj: T, key: K, name: string): () => void {
    const orig = obj[key] as unknown as (...a: unknown[]) => unknown;
    const self = this;
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      if (!self.enabled) return orig.apply(this, args);
      const t0 = self.now();
      try {
        return orig.apply(this, args);
      } finally {
        self.add(name, self.now() - t0);
      }
    };
    (obj as Record<K, unknown>)[key] = wrapped;
    return () => {
      if ((obj as Record<K, unknown>)[key] === wrapped) (obj as Record<K, unknown>)[key] = orig;
    };
  }

  private close(n: number): void {
    const frame = n - this.frameStart;
    this.frameRing.push(frame);
    this.cpuRing.push(this.cpuAcc);
    this.frameMs = this.frameRing.mean;
    this.cpuMs = this.cpuRing.mean;
    if (frame > this.winFrameMax) this.winFrameMax = frame;
    if (this.cpuAcc > this.winCpuMax) this.winCpuMax = this.cpuAcc;
    this.cpuAcc = 0;
    const rollWindow = n - this.winStart >= WINDOW_MS;
    for (const s of this.sections.values()) {
      s.last = s.acc;
      s.ring.push(s.acc);
      s.avg = s.ring.mean;
      if (s.acc > s.winMax) s.winMax = s.acc;
      s.acc = 0;
      if (rollWindow) {
        s.max = s.winMax;
        s.winMax = 0;
      }
    }
    if (rollWindow) {
      this.frameMaxMs = this.winFrameMax;
      this.cpuMaxMs = this.winCpuMax;
      this.winFrameMax = this.winCpuMax = 0;
      this.winStart = n;
    }
  }

  snapshot(): FrameProfilerSnapshot {
    const sections: Record<string, { avg: number; max: number }> = {};
    for (const name of this.order) {
      const s = this.sections.get(name)!;
      sections[name] = { avg: round3(s.avg), max: round3(s.max) };
    }
    return {
      fps: this.frameMs > 0 ? round3(1000 / this.frameMs) : 0,
      frameMs: round3(this.frameMs),
      frameMaxMs: round3(this.frameMaxMs),
      cpuMs: round3(this.cpuMs),
      cpuMaxMs: round3(this.cpuMaxMs),
      sections,
    };
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ============================================================ GPU pass accounting
export interface PassStat {
  calls: number;
  triangles: number;
  /** Wall ms of the pass, only with a sync function (?perf=gpu: gl.finish() at every switch), else 0. */
  ms: number;
}

/** Minimal views of the renderer / composer the counter touches (tests pass fakes). */
export interface CountedRenderer {
  info: { autoReset: boolean; reset(): void; render: { calls: number; triangles: number } };
  setRenderTarget(target: WebGLRenderTarget | null, activeCubeFace?: number, activeMipmapLevel?: number): void;
  render(scene: Object3D, camera: Camera): void;
}
export interface CountedPass {
  name?: string;
  render(...args: never[]): void;
}

/**
 * Per-pass draw-call / triangle counter. Keys: the composer pass name
 * ('RenderPass', 'N8AOPostPass', 'EffectPass', …) or `shadow:<label>` while
 * a labelled render target (a cascade's shadow map) is bound.
 */
export class PassCounter {
  /** Totals of the last completed frame per key. */
  readonly last = new Map<string, PassStat>();
  /** renderer.render calls in the last completed frame. */
  lastRenders = 0;
  lastCalls = 0;
  lastTriangles = 0;
  private readonly cur = new Map<string, PassStat>();
  private readonly labels = new WeakMap<object, string>();
  private readonly wrapped = new WeakSet<object>();
  private key = 'other';
  private passKey = 'other';
  private calls0 = 0;
  private tris0 = 0;
  private renders = 0;
  private readonly undo: (() => void)[] = [];
  private prevAutoReset = true;
  private t0 = 0;

  /**
   * `sync` (e.g. () => gl.finish()) makes every pass boundary wait for the
   * GPU so `ms` is that pass's GPU time. A probe: it serializes CPU and GPU.
   */
  constructor(
    private readonly renderer: CountedRenderer,
    public sync: (() => void) | null = null,
  ) {}

  get attached(): boolean {
    return this.undo.length > 0;
  }

  attach(): void {
    if (this.attached) return;
    const r = this.renderer;
    this.prevAutoReset = r.info.autoReset;
    r.info.autoReset = false;
    const origSet = r.setRenderTarget;
    const self = this;
    r.setRenderTarget = function (this: unknown, target, face, mip) {
      self.flush();
      self.key = (target && self.labels.get(target)) ?? self.passKey;
      return origSet.call(this, target, face, mip);
    };
    const origRender = r.render;
    r.render = function (this: unknown, scene, camera) {
      self.renders++;
      return origRender.call(this, scene, camera);
    };
    this.undo.push(() => {
      r.setRenderTarget = origSet;
      r.render = origRender;
      r.info.autoReset = this.prevAutoReset;
    });
    this.calls0 = r.info.render.calls;
    this.tris0 = r.info.render.triangles;
  }

  detach(): void {
    while (this.undo.length) this.undo.pop()!();
  }

  /** Charges draws on `target` to `shadow:<label>` (re-label every frame: shadow maps are created lazily). */
  label(target: object | null | undefined, label: string): void {
    if (target) this.labels.set(target, `shadow:${label}`);
  }

  /** Wraps composer passes not seen before so their draws are charged to their name. */
  watchPasses(passes: readonly CountedPass[]): void {
    for (const p of passes) {
      if (this.wrapped.has(p)) continue;
      this.wrapped.add(p);
      const name = p.name || 'pass';
      const orig = p.render;
      const self = this;
      (p as { render: (...a: unknown[]) => void }).render = function (this: unknown, ...args: unknown[]) {
        if (!self.attached) return (orig as (...a: unknown[]) => void).apply(this, args);
        self.flush();
        const outer = self.passKey;
        self.passKey = self.key = name;
        try {
          (orig as (...a: unknown[]) => void).apply(this, args);
        } finally {
          self.flush();
          self.passKey = self.key = outer;
        }
      };
    }
  }

  /** Charges draws since the last flush to the current key. */
  private flush(): void {
    const info = this.renderer.info.render;
    const dc = info.calls - this.calls0;
    const dt = info.triangles - this.tris0;
    this.calls0 = info.calls;
    this.tris0 = info.triangles;
    let ms = 0;
    if (this.sync) {
      this.sync();
      const n = performance.now();
      ms = n - this.t0;
      this.t0 = n;
    }
    if (dc === 0 && dt === 0 && ms < 0.05) return;
    let s = this.cur.get(this.key);
    if (!s) {
      s = { calls: 0, triangles: 0, ms: 0 };
      this.cur.set(this.key, s);
    }
    s.calls += dc;
    s.triangles += dt;
    s.ms += ms;
  }

  /** Call before the frame's first draw when `sync` is set (starts the GPU clock). */
  beginFrame(): void {
    if (!this.attached || !this.sync) return;
    this.sync();
    this.t0 = performance.now();
  }

  /** Call once per frame after the frame's last draw: publishes `last` and resets. */
  endFrame(): void {
    if (!this.attached) return;
    this.flush();
    this.last.clear();
    let calls = 0;
    let tris = 0;
    for (const [k, v] of this.cur) {
      if (v.calls === 0 && v.triangles === 0 && v.ms === 0) continue;
      this.last.set(k, { calls: v.calls, triangles: v.triangles, ms: Math.round(v.ms * 100) / 100 });
      calls += v.calls;
      tris += v.triangles;
      v.calls = v.triangles = v.ms = 0;
    }
    this.lastCalls = calls;
    this.lastTriangles = tris;
    this.lastRenders = this.renders;
    this.renders = 0;
    this.renderer.info.reset();
    this.calls0 = this.renderer.info.render.calls;
    this.tris0 = this.renderer.info.render.triangles;
    this.key = this.passKey = 'other';
  }

  snapshot(): { calls: number; triangles: number; renders: number; passes: Record<string, PassStat> } {
    const passes: Record<string, PassStat> = {};
    for (const [k, v] of [...this.last].sort((a, b) => (a[0] < b[0] ? -1 : 1))) passes[k] = { ...v };
    return { calls: this.lastCalls, triangles: this.lastTriangles, renders: this.lastRenders, passes };
  }
}

/** ?perf=1 (or perf=true, or perf=gpu) turns profiling on from the first frame. */
export function perfRequested(search: string): boolean {
  const v = new URLSearchParams(search).get('perf');
  return v === '1' || v === 'true' || v === 'gpu';
}

/** ?perf=gpu: also time each pass with gl.finish() at its boundaries (serializes CPU/GPU; a probe). */
export function perfGpuSync(search: string): boolean {
  return new URLSearchParams(search).get('perf') === 'gpu';
}

/**
 * A GPU sync for PassCounter: Chrome's gl.finish() does not block, so this
 * reads one pixel of a private 1×1 RGBA8 framebuffer (a readPixels is a
 * round trip that executes every queued command first). Restores the
 * caller's framebuffer binding, so three's state cache stays valid.
 */
export function gpuSyncFn(gl: WebGL2RenderingContext): () => void {
  const fb = gl.createFramebuffer();
  const tex = gl.createTexture();
  const px = new Uint8Array(4);
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  return () => {
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
  };
}
