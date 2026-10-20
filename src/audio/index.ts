/**
 * The synthesized audio system (P8) — a lazily loaded chunk (main.ts:
 * `import('./audio')`). No sample assets: every sound is synthesized
 * (src/audio/dsp). This module builds the AudioContext + graph:
 *
 *   player car   engine worklet (2 outputs) → exhaust panner (HRTF, rear-facing cone) + intake panner
 *                surface worklet → tyres panner (squeal / road / scrape / thumps) + wind (stereo)
 *   traffic      ≤ 4 light engine worklets (awake cars) + ≤ 4 pooled pass-by voices (ghosts), panned, manual Doppler
 *   world        ambience worklet (stereo bed), one-shot pool (crashes, glass, debris, props)
 *   mix          buses + slow-mo low-pass + reverb + compressor / limiter (mix.ts)
 *
 * Without AudioWorklet (old browsers, insecure contexts) the same director
 * drives plain-node fallback voices (io.ts). Autoplay: the context starts
 * suspended; the first pointer / key / touch resumes it, and an unobtrusive
 * "click to enable sound" pill shows if it is still suspended after boot.
 */
import './hint.css';
import processorsUrl from './worklet/processors.ts?worker&url';
import { AudioDirector, type AwakeVoiceLike, type DirectorGraph, type GhostVoiceLike } from './director';
import { FallbackAmbience, FallbackEngineVoice, FallbackSurfaceVoice, noiseBuffer, ParamSlot, WorkletAmbience, WorkletEngineVoice, WorkletSurfaceVoice, type EngineVoiceIO } from './io';
import { MixGraph } from './mix';
import type { OneShotKind } from './dsp/oneshots';
import { OneShotPlayer } from './oneShotPlayer';
import { SEDAN_ENGINE, SEDAN_TRAFFIC_ENGINE } from './profiles';
import { ListenerRig, SpatialVoice } from './spatial';
import type { AudioDebug, AudioDeps, AudioSystem } from './types';
import { ambientZones, type AudioZone } from './zones';
import type { EngineProcessorOptions } from './voiceParams';
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';

export type { AudioSystem } from './types';

export interface AudioSystemOptions extends Omit<AudioDeps, 'zones'> {
  /** Layout zones (arena / town / lake) and the terrain height for the ambient bed. */
  layoutZones: readonly AudioZone[];
  heightAt(x: number, z: number): number;
  /** Where the enable-sound pill goes (default document.body). */
  hintParent?: HTMLElement;
}

const ONE_SHOT_SLOTS = 20;
const AWAKE_VOICES = 4;
const GHOST_VOICES = 4;

/** Pass-by voice for a ghost (kinematic) traffic car: engine hum + tyre roar, plain nodes. */
class GhostVoice implements GhostVoiceLike {
  readonly spatial: SpatialVoice;
  private readonly osc: OscillatorNode;
  private readonly f: ParamSlot;
  private readonly lpf: ParamSlot;
  private readonly bpf: ParamSlot;
  private readonly eg: ParamSlot;
  private readonly rg: ParamSlot;
  constructor(ctx: BaseAudioContext, dst: AudioNode, noise: AudioBuffer) {
    this.spatial = new SpatialVoice(ctx, dst, { hrtf: false, refDistance: 6, rolloff: 1.1 });
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    const eg = ctx.createGain();
    eg.gain.value = 0;
    this.osc.connect(lp).connect(eg).connect(this.spatial.input);
    this.osc.start();
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    n.loopStart = Math.random();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.7;
    const rg = ctx.createGain();
    rg.gain.value = 0;
    n.connect(bp).connect(rg).connect(this.spatial.input);
    n.start();
    this.f = new ParamSlot(this.osc.frequency, 0.05, 0.2);
    this.lpf = new ParamSlot(lp.frequency, 0.1, 2);
    this.bpf = new ParamSlot(bp.frequency, 0.1, 2);
    this.eg = new ParamSlot(eg.gain, 0.1);
    this.rg = new ParamSlot(rg.gain, 0.1);
  }
  set(speed: number, engineHz: number, level: number, pitch: number, now: number): void {
    this.f.set(engineHz * pitch, now);
    this.lpf.set(520 * pitch, now);
    this.bpf.set((320 + 22 * speed) * pitch, now);
    this.eg.set(0.07 * level, now);
    this.rg.set(0.32 * Math.min(1, speed / 28), now);
  }
}

function engineNode(ctx: AudioContext, light: boolean, seed: number): AudioWorkletNode {
  const opts: EngineProcessorOptions = { profile: light ? SEDAN_TRAFFIC_ENGINE : SEDAN_ENGINE, seed, light };
  return new AudioWorkletNode(ctx, 'crumple-engine', {
    numberOfInputs: 0,
    numberOfOutputs: light ? 1 : 2,
    outputChannelCount: light ? [1] : [1, 1],
    processorOptions: opts,
  });
}

/** A system that does nothing (no WebAudio at all). */
function silentSystem(reason: string): AudioSystem {
  const debug: AudioDebug = {
    state: 'unavailable',
    worklet: false,
    sampleRate: 0,
    voices: { engine: 0, traffic: 0, ghosts: 0, oneShots: 0, oneShotCap: 0 },
    oneShotsPlayed: 0,
    oneShotsDropped: 0,
    bankReady: false,
    updateMs: 0,
    updateMsMax: 0,
    frames: 0,
    errors: [reason],
    lastCrash: null,
    engine: { rpm: 0, load: 0, pitch: 1, limiter: false, crank: false, horn: false, profile: '' },
    world: { rate: 0, pitch: 1, lowpass: 20000, gain: 0 },
    resume: () => Promise.resolve('unavailable'),
  };
  return { update() {}, onImpact() {}, onBeamBreak() {}, onSkid() {}, debug, dispose() {} };
}

export async function createAudioSystem(o: AudioSystemOptions): Promise<AudioSystem> {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return silentSystem('no AudioContext');
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch (e) {
    return silentSystem(`AudioContext failed: ${String(e)}`);
  }
  const errors: string[] = [];
  const mix = new MixGraph(ctx);
  const noise = noiseBuffer(ctx, 2);
  const hrtf = o.hrtf();

  // ---- worklet (off-main-thread DSP), else plain nodes
  let worklet = false;
  if (ctx.audioWorklet) {
    try {
      await ctx.audioWorklet.addModule(new URL(processorsUrl, import.meta.url));
      worklet = true;
    } catch (e) {
      errors.push(`worklet: ${String(e)}`);
    }
  }

  const exhaust = new SpatialVoice(ctx, mix.engine, { hrtf, refDistance: 4, cone: [130, 300, 0.45] });
  const intake = new SpatialVoice(ctx, mix.engine, { hrtf, refDistance: 3 });
  const tyres = new SpatialVoice(ctx, mix.tyres, { hrtf, refDistance: 4 });
  const windGain = ctx.createGain();
  windGain.gain.value = 0.9;
  windGain.connect(mix.tyres);
  let engine: EngineVoiceIO;
  let surface: DirectorGraph['surface'];
  let ambience: DirectorGraph['ambience'];
  const awake: AwakeVoiceLike[] = [];
  if (worklet) {
    const en = engineNode(ctx, false, 1);
    en.connect(exhaust.input, 0);
    en.connect(intake.input, 1);
    engine = new WorkletEngineVoice(en);
    const sn = new AudioWorkletNode(ctx, 'crumple-surface', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 2] });
    sn.connect(tyres.input, 0);
    sn.connect(windGain, 1);
    surface = new WorkletSurfaceVoice(sn);
    const an = new AudioWorkletNode(ctx, 'crumple-ambience', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    an.connect(mix.ambience);
    ambience = new WorkletAmbience(an);
    for (let i = 0; i < AWAKE_VOICES; i++) {
      const sp = new SpatialVoice(ctx, mix.engine, { hrtf: false, refDistance: 6, rolloff: 1.1 });
      const n = engineNode(ctx, true, 100 + i);
      n.connect(sp.input);
      awake.push({ spatial: sp, engine: new WorkletEngineVoice(n) });
    }
  } else {
    const fe = new FallbackEngineVoice(ctx, SEDAN_ENGINE, noise);
    fe.out.connect(exhaust.input);
    engine = fe;
    const fs = new FallbackSurfaceVoice(ctx, noise);
    fs.tyres.connect(tyres.input);
    fs.wind.connect(windGain);
    surface = fs;
    const fa = new FallbackAmbience(ctx, noise);
    fa.out.connect(mix.ambience);
    ambience = fa;
    for (let i = 0; i < AWAKE_VOICES; i++) {
      const sp = new SpatialVoice(ctx, mix.engine, { hrtf: false, refDistance: 6, rolloff: 1.1 });
      const v = new FallbackEngineVoice(ctx, SEDAN_TRAFFIC_ENGINE, noise);
      v.out.connect(sp.input);
      awake.push({ spatial: sp, engine: v });
    }
  }
  const ghosts: GhostVoiceLike[] = [];
  for (let i = 0; i < GHOST_VOICES; i++) ghosts.push(new GhostVoice(ctx, mix.engine, noise));
  const oneShots = new OneShotPlayer(ctx, mix.oneShots, mix.ui, ONE_SHOT_SLOTS);
  // the bank renders in a worker (≈ 0.5 s of CPU kept off the frame loop); inline slices if that fails
  let bankWorker: Worker | null = null;
  try {
    bankWorker = new Worker(new URL('./bankWorker.ts', import.meta.url), { type: 'module' });
    oneShots.useExternalBank();
    bankWorker.onmessage = (e: MessageEvent) => {
      const d = e.data as { done?: boolean; kind?: OneShotKind; data?: Float32Array };
      if (d.done) {
        oneShots.bankDone();
        bankWorker?.terminate();
        bankWorker = null;
      } else if (d.kind && d.data) oneShots.addVariant(d.kind, d.data);
    };
    bankWorker.onerror = (e) => {
      errors.push(`bank worker: ${e.message}`);
      oneShots.useInlineBank();
      bankWorker?.terminate();
      bankWorker = null;
    };
    bankWorker.postMessage({ sampleRate: ctx.sampleRate });
  } catch (e) {
    errors.push(`bank worker: ${String(e)}`);
    oneShots.useInlineBank();
  }
  const listener = new ListenerRig(ctx);

  const zones = o.layoutZones;
  const deps: AudioDeps = { ...o, zones: (x, z, out) => ambientZones(zones, o.heightAt, x, z, out) };
  const director = new AudioDirector({ mix, listener, engine, exhaust, intake, surface, tyres, ambience, awake, ghosts, oneShots }, deps);

  // ---- autoplay: resume on the first gesture; a pill if still suspended
  const resume = (): Promise<string> =>
    ctx.state === 'running'
      ? Promise.resolve(ctx.state)
      : ctx.resume().then(
          () => ctx.state,
          (e: unknown) => {
            errors.push(`resume: ${String(e)}`);
            return ctx.state;
          },
        );
  const gestures = ['pointerdown', 'keydown', 'touchstart'] as const;
  const onGesture = (): void => {
    if (o.settings().muted) return;
    void resume().then((s) => {
      if (s === 'running') for (const g of gestures) window.removeEventListener(g, onGesture, true);
    });
  };
  for (const g of gestures) window.addEventListener(g, onGesture, { capture: true, passive: true });
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'audio-hint';
  hint.hidden = true;
  hint.setAttribute('aria-label', 'Enable sound');
  hint.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l5 6M21 9l-5 6"/></svg><span>Click to enable sound</span>';
  hint.addEventListener('click', (e) => {
    e.stopPropagation();
    void resume();
  });
  (o.hintParent ?? document.body).appendChild(hint);
  const bootT = performance.now();

  let updateMs = 0;
  let updateMsMax = 0;
  let muteSuspended = false;
  const system: AudioSystem = {
    update(dt: number): void {
      const t0 = performance.now();
      try {
        const muted = o.settings().muted;
        // muted: suspend the whole context (no audio-thread cost); unmuting resumes it
        if (muted && ctx.state === 'running') {
          muteSuspended = true;
          void ctx.suspend();
        } else if (!muted && muteSuspended) {
          muteSuspended = false;
          void resume();
        }
        const running = ctx.state === 'running';
        director.update(dt, ctx.currentTime, running);
        const showHint = !running && !muted && t0 - bootT > 2500;
        if (hint.hidden === showHint) hint.hidden = !showHint;
      } catch (e) {
        if (errors.length < 20) errors.push(String(e instanceof Error ? (e.stack ?? e.message) : e));
      }
      const ms = performance.now() - t0;
      updateMs += (ms - updateMs) * 0.05;
      if (director.frames > 120 && ms > updateMsMax) updateMsMax = ms;
    },
    onImpact(e: Readonly<ImpactEvent>): void {
      director.onImpact(e);
    },
    onBeamBreak(e: Readonly<BeamBreakEvent>): void {
      director.onBeamBreak(e);
    },
    onSkid(e: Readonly<SkidEvent>): void {
      director.onSkid(e);
    },
    debug: {
      get state() {
        return ctx.state;
      },
      worklet,
      sampleRate: ctx.sampleRate,
      get voices() {
        let tr = 0;
        for (const a of awake) tr += (a.spatial as SpatialVoice).input.gain.value > 0.01 ? 1 : 0;
        let gh = 0;
        for (const g of ghosts) gh += (g.spatial as SpatialVoice).input.gain.value > 0.01 ? 1 : 0;
        return { engine: 1, traffic: tr, ghosts: gh, oneShots: oneShots.active, oneShotCap: oneShots.capacity };
      },
      get oneShotsPlayed() {
        return oneShots.played;
      },
      get oneShotsDropped() {
        return oneShots.dropped;
      },
      get bankReady() {
        return oneShots.ready;
      },
      get updateMs() {
        return updateMs;
      },
      get updateMsMax() {
        return updateMsMax;
      },
      get frames() {
        return director.frames;
      },
      errors,
      get lastCrash() {
        return director.lastCrash;
      },
      get engine() {
        return director.engineState;
      },
      get world() {
        return { rate: director.rate, pitch: director.pitch, lowpass: director.lowpass, gain: director.worldGain };
      },
      resume,
    },
    dispose(): void {
      for (const g of gestures) window.removeEventListener(g, onGesture, true);
      hint.remove();
      bankWorker?.terminate();
      director.dispose();
      void ctx.close();
    },
  };
  return system;
}
