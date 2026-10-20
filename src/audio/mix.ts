/**
 * The mix graph (P8 audio):
 *
 *   engine bus ──┐                                   (duck: crashes)
 *   tyres/wind ──┼─ duck ─┐
 *   ambience ────┘        ├─ world ─ slow-mo low-pass ─ alive (dead-man) ─ master ─ compressor ─ limiter ─ out
 *   one-shots ────────────┘   └─ reverb send (convolver, synthesized IR) ─┘
 *   ui ───────────────────────────────────────────────────────────── master
 *
 * Bus gains follow the settings (master / engine / effects / ambience /
 * mute). `alive` is a dead-man's switch: every update re-arms it, so when
 * the frame loop stops calling (pause menu, showroom, a held loop, hidden
 * tab) the world fades out by itself within ~0.3 s.
 */
import { ParamSlot } from './io';

export interface MixLevels {
  master: number;
  engine: number;
  effects: number;
  ambience: number;
  muted: boolean;
}

/** Stereo decaying-noise impulse response (outdoor-ish slap + tail), damped as it decays. */
export function reverbImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const b = ctx.createBuffer(2, n, sr);
  let s = 0x2468ace;
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const w = ((s >>> 0) / 4294967296) * 2 - 1;
      const t = i / sr;
      // high frequencies die first
      const a = Math.min(0.92, 0.25 + t * 1.4);
      lp += (1 - a) * (w - lp);
      const early = t > 0.012 && t < 0.09 && i % 997 < 6 ? 0.6 : 0;
      d[i] = (lp + early * w) * Math.pow(1 - t / seconds, decay) * Math.exp(-t * 1.6);
    }
  }
  return b;
}

export class MixGraph {
  readonly ctx: AudioContext;
  readonly engine: GainNode;
  readonly tyres: GainNode;
  readonly ambience: GainNode;
  readonly oneShots: GainNode;
  readonly ui: GainNode;
  readonly duck: GainNode;
  readonly world: GainNode;
  readonly lowpass: BiquadFilterNode;
  readonly alive: GainNode;
  readonly master: GainNode;
  readonly reverbSend: GainNode;
  readonly compressor: DynamicsCompressorNode;
  private readonly sEngine: ParamSlot;
  private readonly sTyres: ParamSlot;
  private readonly sAmb: ParamSlot;
  private readonly sShots: ParamSlot;
  private readonly sMaster: ParamSlot;
  private readonly sLp: ParamSlot;
  private readonly sRev: ParamSlot;
  private readonly sWorld: ParamSlot;
  private duckLevel = 1;
  private armedAt = -1;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const g = (v = 1): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.engine = g();
    this.tyres = g();
    this.ambience = g();
    this.oneShots = g();
    this.ui = g(0.6);
    this.duck = g();
    this.world = g();
    this.alive = g(0);
    this.master = g(0.8);
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;
    this.lowpass.Q.value = 0.6;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    this.engine.connect(this.duck);
    this.tyres.connect(this.duck);
    this.ambience.connect(this.duck);
    this.duck.connect(this.world);
    this.oneShots.connect(this.world);
    this.world.connect(this.lowpass);
    // reverb: engine + one-shots feed a convolver; returns before the low-pass
    this.reverbSend = g(0.05);
    const conv = ctx.createConvolver();
    conv.buffer = reverbImpulse(ctx, 2.4, 1.6);
    this.oneShots.connect(this.reverbSend);
    this.engine.connect(this.reverbSend);
    this.reverbSend.connect(conv).connect(this.lowpass);
    this.lowpass.connect(this.alive).connect(this.master);
    this.ui.connect(this.master);
    this.master.connect(this.compressor).connect(limiter).connect(ctx.destination);

    this.sEngine = new ParamSlot(this.engine.gain, 0.05);
    this.sTyres = new ParamSlot(this.tyres.gain, 0.05);
    this.sAmb = new ParamSlot(this.ambience.gain, 0.2);
    this.sShots = new ParamSlot(this.oneShots.gain, 0.05);
    this.sMaster = new ParamSlot(this.master.gain, 0.05);
    this.sLp = new ParamSlot(this.lowpass.frequency, 0.12, 5);
    this.sRev = new ParamSlot(this.reverbSend.gain, 0.25);
    this.sWorld = new ParamSlot(this.world.gain, 0.05);
  }

  /** Re-arms the dead-man's switch (call every frame the world is live). */
  keepAlive(now: number): void {
    // re-armed at most every 0.1 s: the fade only starts 0.28 s after the last arm
    if (now - this.armedAt < 0.1 && now >= this.armedAt) return;
    this.armedAt = now;
    const a = this.alive.gain;
    a.cancelScheduledValues(now);
    a.setTargetAtTime(1, now, 0.03);
    a.setTargetAtTime(0, now + 0.28, 0.05);
  }

  setLevels(l: Readonly<MixLevels>, now: number): void {
    this.sMaster.set(l.muted ? 0 : l.master, now);
    this.sEngine.set(l.engine * 0.9, now);
    this.sTyres.set(l.effects * 0.8, now);
    this.sShots.set(l.effects, now);
    this.sAmb.set(l.ambience * 0.55, now);
  }

  /** World gain (0 = paused / replay paused), slow-mo low-pass and reverb send. */
  setWorld(gain: number, lowpassHz: number, reverb: number, now: number): void {
    this.sWorld.set(gain, now);
    this.sLp.set(lowpassHz, now);
    this.sRev.set(reverb, now);
  }

  /** Ducks engine + continuous effects + ambience to `g` (linear) and recovers over `recoverS`. */
  duckTo(g: number, now: number, recoverS = 0.7): void {
    if (g >= this.duckLevel && this.duckLevel < 0.999) return;
    const d = this.duck.gain;
    d.cancelScheduledValues(now);
    d.setTargetAtTime(g, now, 0.008);
    d.setTargetAtTime(1, now + 0.12, recoverS / 3);
    this.duckLevel = g;
  }

  /** Called every frame: the duck level estimate relaxes toward 1 (gates re-ducking). */
  relaxDuck(dt: number): void {
    this.duckLevel += (1 - this.duckLevel) * Math.min(1, dt * 4);
  }
}
