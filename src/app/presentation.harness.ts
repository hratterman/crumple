/**
 * Headless presentation-pipeline model (test helper, node only): the REAL
 * WorkerHost (pacing, snapshot ticks, 3-buffer pool) and the REAL SimClient
 * (render clock + interpolation) wired through a discrete-event simulation
 * of two threads on one virtual clock:
 * - worker: wakes chained through setTimeout (clamped to `timerClampMs`,
 *   ± jitter), each sim step costs `stepCpuMs` of worker time, snapshots are
 *   posted at the worker time they are written, messages from main
 *   (returnBuffer) are handled only between wakes;
 * - main: rAF at the display's vsync (`displayHz`), each frame busy for
 *   `frameCpuMs` (+ jitter), worker messages are handled only while main is
 *   idle (they queue behind a frame), and a frame that overruns its vsync
 *   waits for the next one.
 * The subject is a single free-falling node (y = y0 − ½·g·t² in sim time, a
 * constant-acceleration trajectory like a full-throttle launch), so every
 * rendered frame has an exact ideal position to compare against.
 */
import { vi } from 'vitest';
import type { MainToWorker, WorkerToMain } from '../protocol/messages';
import { WorkerHost, type HostScheduler } from '../sim/worker';
import { SimClient } from './simClient';
import { createRng } from '../core/rng';

export interface PresentationOptions {
  displayHz: number;
  durationS: number;
  stepCpuMs?: number;
  frameCpuMs?: number;
  frameJitterMs?: number;
  timerClampMs?: number;
  timerJitterMs?: number;
  /** Delivery latency of a postMessage between threads. */
  msgLatencyMs?: number;
  seed?: number;
  /** Called per frame instead of the default renderTime() (e.g. a latched frame clock). */
  renderTimeFn?: (client: SimClient, nowMs: number, frameDtMs: number) => number;
  /** Inject a worker stall of `stallMs` every `stallEveryMs` (GC, tab throttling). */
  stallEveryMs?: number;
  stallMs?: number;
  /** Inject a long main frame (`hitchMs` of work) every `hitchEveryMs`. */
  hitchEveryMs?: number;
  hitchMs?: number;
  /** Horizontal speed of the probe node, m/s (default 30: a car at 108 km/h). */
  speed?: number;
}

export interface PresentationResult {
  frameT: Float64Array;
  renderT: Float64Array;
  y: Float64Array;
  /** Rendered x (constant velocity `speed`). */
  x: Float64Array;
  latestSimT: Float64Array;
  frames: number;
  snapshotsReceived: number;
  snapshotsSent: number;
  droppedSteps: number;
  g: number;
}

interface Ev {
  t: number;
  seq: number;
  fn: () => void;
}

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: { data: WorkerToMain }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  toWorker: ((msg: MainToWorker) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  readonly early: MainToWorker[] = [];
  postMessage(msg: MainToWorker): void {
    if (this.toWorker) this.toWorker(msg);
    else this.early.push(msg);
  }
  terminate(): void {}
}

export function runPresentation(opts: PresentationOptions): PresentationResult {
  const stepCpuMs = opts.stepCpuMs ?? 0.125;
  const frameCpuMs = opts.frameCpuMs ?? 6;
  const frameJitterMs = opts.frameJitterMs ?? 2;
  const timerClampMs = opts.timerClampMs ?? 4;
  const timerJitterMs = opts.timerJitterMs ?? 0.6;
  const latency = opts.msgLatencyMs ?? 0.15;
  const rng = createRng(opts.seed ?? 7);
  const rand = (): number => rng.float();

  const queue: Ev[] = [];
  let seq = 0;
  const push = (t: number, fn: () => void): void => {
    queue.push({ t, seq: seq++, fn });
  };
  const popNext = (): Ev | null => {
    if (queue.length === 0) return null;
    let bi = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]!;
      const b = queue[bi]!;
      if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) bi = i;
    }
    return queue.splice(bi, 1)[0]!;
  };

  // ---- worker thread
  let workerClock = 0;
  let workerBusyUntil = 0;
  let nextStall = opts.stallEveryMs ?? Infinity;
  let nextHitch = opts.hitchEveryMs ?? Infinity;
  const scheduler: HostScheduler = {
    now: () => workerClock,
    schedule(fn, immediate) {
      let delay = immediate ? 0.02 : timerClampMs + rand() * timerJitterMs;
      if (opts.stallEveryMs && workerClock >= nextStall) {
        delay += opts.stallMs ?? 50;
        nextStall += opts.stallEveryMs;
      }
      const at = workerClock + delay;
      push(at, () => {
        workerClock = Math.max(at, workerBusyUntil);
        fn();
        workerBusyUntil = workerClock;
      });
    },
  };
  // ---- main thread
  let mainClock = 0;
  let mainBusyUntil = 0;
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => mainClock);
  const g0 = globalThis as { Worker?: unknown };
  const savedWorker = g0.Worker;
  g0.Worker = FakeWorker;

  let host: WorkerHost | null = null;
  const toMain = (msg: WorkerToMain, _transfer?: Transferable[]): void => {
    const at = workerClock + latency;
    push(at, () => {
      mainClock = Math.max(at, mainBusyUntil);
      (FakeWorker.last!.onmessage as (ev: { data: WorkerToMain }) => void)({ data: msg });
      mainBusyUntil = mainClock + 0.05;
    });
  };
  host = new WorkerHost(toMain, scheduler);
  // Engine step cost on the worker's clock.
  const client = new SimClient({ seed: 1 });
  const fw = FakeWorker.last!;
  fw.toWorker = (msg) => {
    const at = mainClock + latency;
    push(at, () => {
      workerClock = Math.max(at, workerBusyUntil);
      host!.handle(msg);
      workerBusyUntil = workerClock;
    });
  };
  for (const m of fw.early.splice(0)) fw.toWorker(m);
  // init is posted by the constructor (already queued); spawn a free-falling node.
  const y0 = 2000;
  client.spawn(1, { name: 'probe', nodes: [{ id: 'n', pos: [0, 0, 0], mass: 1 }], beams: [] }, { pos: [0, y0, 0], quat: [0, 0, 0, 1] });

  // Patch engine.step cost once the engine exists.
  let patched = false;
  const patchEngine = (): void => {
    if (patched || !host!.engine) return;
    const eng = host!.engine;
    const step = eng.step.bind(eng);
    const s0 = eng.state;
    const id = eng.arena.get(1)!.nodeStart;
    s0.velX[id] = opts.speed ?? 30;
    eng.step = () => {
      step();
      workerClock += stepCpuMs;
    };
    patched = true;
  };

  const periodMs = 1000 / opts.displayHz;
  const nFramesMax = Math.ceil((opts.durationS * 1000) / periodMs) + 4;
  const frameT = new Float64Array(nFramesMax);
  const renderT = new Float64Array(nFramesMax);
  const ys = new Float64Array(nFramesMax);
  const xs = new Float64Array(nFramesMax);
  const latest = new Float64Array(nFramesMax);
  let frames = 0;
  let lastFrameMs = 0;
  const out = new Float32Array(3);
  const startMs = 200; // let the pipeline fill
  const scheduleRaf = (fromMs: number): void => {
    const k = Math.ceil(fromMs / periodMs - 1e-9);
    const at = k * periodMs;
    push(at, () => {
      mainClock = Math.max(at, mainBusyUntil);
      if (mainClock > at + 1e-6) {
        // busy at vsync: wait for the next one
        scheduleRaf(mainClock + 1e-6);
        return;
      }
      patchEngine();
      const dt = lastFrameMs > 0 ? mainClock - lastFrameMs : periodMs;
      lastFrameMs = mainClock;
      const r = opts.renderTimeFn ? opts.renderTimeFn(client, mainClock, dt) : client.renderTime(mainClock);
      if (mainClock >= startMs && client.nodeTotal > 0 && frames < nFramesMax) {
        client.interpolate(r, out);
        frameT[frames] = mainClock;
        renderT[frames] = r;
        ys[frames] = out[1]!;
        xs[frames] = out[0]!;
        latest[frames] = client.simTime;
        frames++;
      }
      let busy = frameCpuMs + (rand() - 0.5) * 2 * frameJitterMs;
      if (opts.hitchEveryMs && mainClock >= nextHitch) {
        busy += opts.hitchMs ?? 40;
        nextHitch += opts.hitchEveryMs;
      }
      mainBusyUntil = mainClock + Math.max(0.5, busy);
      scheduleRaf(mainClock + periodMs * 0.5);
    });
  };
  scheduleRaf(periodMs);

  const endMs = startMs + opts.durationS * 1000;
  for (;;) {
    const ev = popNext();
    if (!ev || ev.t > endMs) break;
    ev.fn();
  }
  const res: PresentationResult = {
    frameT: frameT.subarray(0, frames),
    renderT: renderT.subarray(0, frames),
    y: ys.subarray(0, frames),
    x: xs.subarray(0, frames),
    latestSimT: latest.subarray(0, frames),
    frames,
    snapshotsReceived: client.stats.snapshotsReceived,
    snapshotsSent: host.snapshotsSent,
    droppedSteps: host.droppedSteps,
    g: 9.81,
  };
  client.dispose();
  nowSpy.mockRestore();
  g0.Worker = savedWorker;
  return res;
}

export interface PresentationStats {
  /** RMS / max of (Δrender − Δframe), ms: per-frame clock-step error. */
  stepErrRmsMs: number;
  stepErrMaxMs: number;
  /** RMS / max deviation of the render clock from a constant-lag ideal (best-fit lag), ms. At v m/s the on-screen position error is v·this. */
  clockErrRmsMs: number;
  clockErrMaxMs: number;
  /** RMS / max deviation of the rendered position from the exact trajectory at the ideal clock, mm (free fall). */
  posErrRmsMm: number;
  posErrMaxMm: number;
  /** Mean render lag behind the newest snapshot, ms. */
  lagMeanMs: number;
  /** Fraction of frames whose render time did not advance. */
  stalls: number;
  /**
   * Rendered-position jitter of the constant-velocity probe: RMS / max of
   * the per-frame velocity deviation from the true speed × the frame period
   * (mm of uneven step per frame, what the eye sees against the camera).
   */
  stepJitterRmsMm: number;
  stepJitterMaxMm: number;
}

export function presentationStats(r: PresentationResult, y0 = 2000): PresentationStats {
  let s2 = 0;
  let smax = 0;
  let stalls = 0;
  const n = r.frames;
  for (let i = 1; i < n; i++) {
    const df = r.frameT[i]! - r.frameT[i - 1]!;
    const dr = (r.renderT[i]! - r.renderT[i - 1]!) * 1000;
    s2 += (dr - df) ** 2;
    smax = Math.max(smax, Math.abs(dr - df));
    if (dr <= 1e-9) stalls++;
  }
  // best-fit constant lag: mean of frameT − renderT
  let lagFit = 0;
  for (let i = 0; i < n; i++) lagFit += r.frameT[i]! - r.renderT[i]! * 1000;
  lagFit /= Math.max(1, n);
  let c2 = 0;
  let cmax = 0;
  let p2 = 0;
  let pmax = 0;
  for (let i = 0; i < n; i++) {
    const tIdeal = (r.frameT[i]! - lagFit) / 1000;
    const e = r.renderT[i]! * 1000 - tIdeal * 1000;
    c2 += e * e;
    cmax = Math.max(cmax, Math.abs(e));
    const yIdeal = y0 - 0.5 * r.g * tIdeal * tIdeal;
    const pe = (r.y[i]! - yIdeal) * 1000;
    p2 += pe * pe;
    pmax = Math.max(pmax, Math.abs(pe));
  }
  let lag = 0;
  for (let i = 0; i < n; i++) lag += (r.latestSimT[i]! - r.renderT[i]!) * 1000;
  let j2 = 0;
  let jmax = 0;
  let nj = 0;
  const v0 = (r.x[r.frames - 1]! - r.x[0]!) / ((r.renderT[r.frames - 1]! - r.renderT[0]!) || 1);
  for (let i = 1; i < n; i++) {
    const df = (r.frameT[i]! - r.frameT[i - 1]!) / 1000;
    const e = (r.x[i]! - r.x[i - 1]! - v0 * df) * 1000;
    j2 += e * e;
    jmax = Math.max(jmax, Math.abs(e));
    nj++;
  }
  return {
    stepJitterRmsMm: Math.sqrt(j2 / Math.max(1, nj)),
    stepJitterMaxMm: jmax,
    stepErrRmsMs: Math.sqrt(s2 / Math.max(1, n - 1)),
    stepErrMaxMs: smax,
    clockErrRmsMs: Math.sqrt(c2 / Math.max(1, n)),
    clockErrMaxMs: cmax,
    posErrRmsMm: Math.sqrt(p2 / Math.max(1, n)),
    posErrMaxMm: pmax,
    lagMeanMs: lag / Math.max(1, n),
    stalls: stalls / Math.max(1, n - 1),
  };
}
