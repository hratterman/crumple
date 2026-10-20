/**
 * Main-thread voice handles (P8 audio). The director writes block inputs
 * (EngineInput / SurfaceInput / AmbienceInput) to a voice through these
 * interfaces once per frame; implementations map them to AudioParams:
 *   - worklet voices: one k-rate AudioParam per input (setTargetAtTime),
 *   - fallback voices (no AudioWorklet): plain oscillator / noise / filter
 *     graphs approximating the same layers.
 * Every `set` is allocation-free; a ParamSlot skips the call when the value
 * did not move (most params are steady most frames).
 */
import type { AmbienceInput } from './dsp/ambience';
import type { EngineInput } from './dsp/engine';
import type { SurfaceInput } from './dsp/surface';
import { firingHz } from './params';
import type { EngineProfile } from './profiles';
import { AMBIENCE_PARAMS, ENGINE_PARAMS, SURFACE_PARAMS } from './voiceParams';

/** The subset of AudioParam the director uses (fakes in tests). */
export interface ParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

/** A param with change detection and a smoothing time constant. */
export class ParamSlot {
  private last = NaN;
  constructor(
    readonly param: ParamLike,
    private readonly tau = 0.03,
    private readonly eps = 1e-4,
  ) {}
  set(v: number, now: number): void {
    if (!Number.isFinite(v)) return;
    const d = v - this.last;
    if (d < this.eps && d > -this.eps) return;
    this.last = v;
    this.param.setTargetAtTime(v, now, this.tau);
  }
  /** Immediate jump (trigger counters, resets). */
  jump(v: number, now: number): void {
    if (v === this.last) return;
    this.last = v;
    this.param.setValueAtTime(v, now);
  }
  get current(): number {
    return this.last;
  }
}

export interface EngineVoiceIO {
  setInputs(inp: Readonly<EngineInput>, now: number): void;
  setProfile(p: EngineProfile): void;
}
export interface SurfaceVoiceIO {
  setInputs(inp: Readonly<SurfaceInput>, now: number): void;
}
export interface AmbienceIO {
  setInputs(inp: Readonly<AmbienceInput>, now: number): void;
}

// ============================================================ worklet voices
function paramMap(node: AudioWorkletNode, names: readonly string[], taus: Readonly<Record<string, number>>): ParamSlot[] {
  return names.map((n) => {
    const p = node.parameters.get(n);
    if (!p) throw new Error(`worklet param '${n}' missing`);
    return new ParamSlot(p, taus[n] ?? 0.03, n === 'rpm' || n === 'squealHz' ? 0.5 : 1e-3);
  });
}

export class WorkletEngineVoice implements EngineVoiceIO {
  private readonly s: ParamSlot[];
  constructor(readonly node: AudioWorkletNode) {
    this.s = paramMap(node, ENGINE_PARAMS, { rpm: 0.025, throttle: 0.02, load: 0.04, gate: 0.05, pitch: 0.08, limiter: 0.005, crank: 0.005, shift: 0.005, damage: 0.5 });
  }
  setInputs(i: Readonly<EngineInput>, now: number): void {
    const s = this.s;
    s[0]!.set(i.rpm, now);
    s[1]!.set(i.throttle, now);
    s[2]!.set(i.load, now);
    s[3]!.set(i.gate, now);
    s[4]!.set(i.pitch, now);
    s[5]!.jump(i.limiter >= 0.5 ? 1 : 0, now);
    s[6]!.jump(i.crank >= 0.5 ? 1 : 0, now);
    s[7]!.jump(i.shift >= 0.5 ? 1 : 0, now);
    s[8]!.set(i.damage, now);
  }
  setProfile(p: EngineProfile): void {
    this.node.port.postMessage({ type: 'profile', profile: p });
  }
}

export class WorkletSurfaceVoice implements SurfaceVoiceIO {
  private readonly s: ParamSlot[];
  constructor(readonly node: AudioWorkletNode) {
    this.s = paramMap(node, SURFACE_PARAMS, { thumpCount: 0.001, thumpAmp: 0.001, squealF: 0.04, squealR: 0.04, scrape: 0.03 });
  }
  setInputs(i: Readonly<SurfaceInput>, now: number): void {
    const s = this.s;
    s[0]!.set(i.pitch, now);
    s[1]!.set(i.speed, now);
    s[2]!.set(i.squealF, now);
    s[3]!.set(i.squealR, now);
    s[4]!.set(i.squealPitchF, now);
    s[5]!.set(i.squealPitchR, now);
    s[6]!.set(i.squealHz, now);
    s[7]!.set(i.scrub, now);
    s[8]!.set(i.roar, now);
    s[9]!.set(i.roarTone, now);
    s[10]!.set(i.gravel, now);
    s[11]!.set(i.dirt, now);
    s[12]!.set(i.grass, now);
    s[13]!.set(i.scrape, now);
    s[14]!.set(i.scrapeSpeed, now);
    // the amplitude must land before (or with) the counter that fires it
    s[16]!.jump(i.thumpAmp, now);
    s[15]!.jump(i.thumpCount, now);
    s[17]!.set(i.wind, now);
    s[18]!.set(i.windSpeed, now);
  }
}

export class WorkletAmbience implements AmbienceIO {
  private readonly s: ParamSlot[];
  constructor(readonly node: AudioWorkletNode) {
    this.s = paramMap(node, AMBIENCE_PARAMS, { birds: 1, breeze: 1, crickets: 1, water: 0.6, pitch: 0.08 });
  }
  setInputs(i: Readonly<AmbienceInput>, now: number): void {
    this.s[0]!.set(i.birds, now);
    this.s[1]!.set(i.breeze, now);
    this.s[2]!.set(i.crickets, now);
    this.s[3]!.set(i.water, now);
    this.s[4]!.set(i.pitch, now);
  }
}

// ============================================================ fallback voices (no AudioWorklet)
/** A looping white-noise buffer source (shared per context). */
export function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 0x1234567;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return b;
}

function loopNoise(ctx: BaseAudioContext, buf: AudioBuffer): AudioBufferSourceNode {
  const n = ctx.createBufferSource();
  n.buffer = buf;
  n.loop = true;
  n.loopStart = Math.random() * 0.5;
  n.start();
  return n;
}

/**
 * Engine without a worklet: a firing-order-like harmonic stack on an
 * oscillator at the HALF firing frequency (so the half orders exist), a
 * load-opened low-pass, a body resonance and load-gated rasp noise.
 */
export class FallbackEngineVoice implements EngineVoiceIO {
  readonly out: GainNode;
  readonly front: GainNode;
  private readonly osc: OscillatorNode;
  private readonly lp: BiquadFilterNode;
  private readonly rasp: BiquadFilterNode;
  private readonly raspGain: GainNode;
  private readonly gate: GainNode;
  private readonly f: ParamSlot;
  private readonly cut: ParamSlot;
  private readonly rg: ParamSlot;
  private readonly g: ParamSlot;
  private readonly rf: ParamSlot;
  private p: EngineProfile;
  constructor(ctx: BaseAudioContext, profile: EngineProfile, noise: AudioBuffer) {
    this.p = profile;
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(FallbackEngineVoice.wave(ctx, profile));
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.9;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = profile.exhaust.bodyHz;
    body.gain.value = profile.exhaust.bodyDb;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0.35;
    this.front = ctx.createGain();
    this.front.gain.value = 0;
    this.osc.connect(this.lp).connect(body).connect(this.gate).connect(this.out);
    const n = loopNoise(ctx, noise);
    this.rasp = ctx.createBiquadFilter();
    this.rasp.type = 'bandpass';
    this.rasp.Q.value = 0.8;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    n.connect(this.rasp).connect(this.raspGain).connect(this.gate);
    this.osc.start();
    this.f = new ParamSlot(this.osc.frequency, 0.025, 0.05);
    this.cut = new ParamSlot(this.lp.frequency, 0.05, 1);
    this.rg = new ParamSlot(this.raspGain.gain, 0.04);
    this.g = new ParamSlot(this.gate.gain, 0.05);
    this.rf = new ParamSlot(this.rasp.frequency, 0.1, 1);
  }
  static wave(ctx: BaseAudioContext, p: EngineProfile): PeriodicWave {
    // harmonics of the half firing frequency: even = firing orders (strong), odd = half orders (V8 lumps)
    const n = 40;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const lumpy = p.cylinders === 8 ? 0.35 : p.cylinders === 4 ? 0.22 : 0.12;
    for (let k = 1; k < n; k++) im[k] = (k % 2 === 0 ? 1 : lumpy) / Math.pow(k, 0.9);
    return ctx.createPeriodicWave(re, im);
  }
  setInputs(i: Readonly<EngineInput>, now: number): void {
    const p = this.p;
    const pitch = i.pitch;
    this.f.set((firingHz(i.rpm, p.cylinders) / 2) * pitch, now);
    this.cut.set(p.exhaust.lowpassHz * (0.6 + 1.2 * i.load) * pitch, now);
    this.rg.set(p.exhaust.rasp * 0.25 * i.load * i.load, now);
    this.rf.set(p.exhaust.raspHz * pitch, now);
    const amp = (0.3 + 0.7 * i.load) * (0.5 + 0.5 * Math.min(1, i.rpm / p.redlineRpm)) * (i.limiter >= 0.5 ? 0.7 : 1);
    this.g.set(i.gate * amp * (i.crank >= 0.5 ? 0.4 : 1), now);
  }
  setProfile(p: EngineProfile): void {
    this.p = p;
    this.osc.setPeriodicWave(FallbackEngineVoice.wave(this.osc.context, p));
  }
}

/** Tyres + roar + wind without a worklet: band-passed / low-passed noise layers. */
export class FallbackSurfaceVoice implements SurfaceVoiceIO {
  readonly tyres: GainNode;
  readonly wind: GainNode;
  private readonly sq: BiquadFilterNode;
  private readonly sqG: GainNode;
  private readonly roar: BiquadFilterNode;
  private readonly roarG: GainNode;
  private readonly scr: BiquadFilterNode;
  private readonly scrG: GainNode;
  private readonly rum: BiquadFilterNode;
  private readonly rumG: GainNode;
  private readonly wf: BiquadFilterNode;
  private readonly wG: GainNode;
  private readonly slots: ParamSlot[];
  constructor(ctx: BaseAudioContext, noise: AudioBuffer) {
    this.tyres = ctx.createGain();
    this.wind = ctx.createGain();
    const mk = (type: BiquadFilterType, q: number, dst: AudioNode): [BiquadFilterNode, GainNode] => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      loopNoise(ctx, noise).connect(f).connect(g).connect(dst);
      return [f, g];
    };
    [this.sq, this.sqG] = mk('bandpass', 18, this.tyres);
    [this.roar, this.roarG] = mk('lowpass', 0.7, this.tyres);
    [this.scr, this.scrG] = mk('bandpass', 12, this.tyres);
    [this.rum, this.rumG] = mk('lowpass', 0.8, this.tyres);
    [this.wf, this.wG] = mk('lowpass', 0.6, this.wind);
    this.rum.frequency.value = 160;
    this.slots = [this.sq.frequency, this.sqG.gain, this.roar.frequency, this.roarG.gain, this.scr.frequency, this.scrG.gain, this.rumG.gain, this.wf.frequency, this.wG.gain].map(
      (p, k) => new ParamSlot(p, 0.04, k % 2 === 0 ? 1 : 1e-3),
    );
  }
  setInputs(i: Readonly<SurfaceInput>, now: number): void {
    const s = this.slots;
    const sq = Math.max(i.squealF, i.squealR);
    s[0]!.set(i.squealHz * Math.max(i.squealPitchF, i.squealPitchR) * i.pitch, now);
    s[1]!.set(sq * 2.5 + i.scrub * 0.3, now);
    s[2]!.set((260 + 30 * i.speed) * i.pitch, now);
    s[3]!.set(i.roar * 0.5, now);
    s[4]!.set(1500 * (0.85 + 0.35 * Math.min(1, i.scrapeSpeed / 20)) * i.pitch, now);
    s[5]!.set(i.scrape * 1.6, now);
    s[6]!.set((i.gravel + i.dirt + i.grass * 0.5) * 0.6, now);
    s[7]!.set(Math.min(220 + 48 * i.windSpeed, 5200) * i.pitch, now);
    s[8]!.set(i.wind * 0.5, now);
  }
}

/** Ambience without a worklet: just the breeze. */
export class FallbackAmbience implements AmbienceIO {
  readonly out: GainNode;
  private readonly g: ParamSlot;
  constructor(ctx: BaseAudioContext, noise: AudioBuffer) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    loopNoise(ctx, noise).connect(f).connect(this.out);
    this.g = new ParamSlot(this.out.gain, 1);
  }
  setInputs(i: Readonly<AmbienceInput>, now: number): void {
    this.g.set(i.breeze * 0.12, now);
  }
}
