/**
 * One-shot playback (P8 audio): the synthesized bank (dsp/oneshots.ts,
 * rendered in a Web Worker — bankWorker.ts — and handed over variant by
 * variant, crash sounds first; inline in small slices only when workers are
 * unavailable) played through a capped pool of spatial slots with
 * priority stealing. Each trigger creates one AudioBufferSourceNode (the
 * WebAudio way: sources are single-use); nothing is allocated while no
 * event fires.
 */
import { ONE_SHOT_KINDS, ONE_SHOT_VARIANTS, synthOneShot, type OneShotKind } from './dsp/oneshots';
import { VoicePool } from './pool';
import { SpatialVoice } from './spatial';

/** Build order: what a first crash needs first. */
const BUILD_ORDER: readonly OneShotKind[] = ['crunch', 'thump', 'hit', 'boom', 'snap', 'glass', 'debris', 'glassCrack', 'concrete', 'clang', 'cone', 'pole', 'wood', 'cardboard', 'tire', 'whoosh'];

interface Slot {
  voice: SpatialVoice;
  src: AudioBufferSourceNode | null;
  until: number;
}

export class OneShotPlayer {
  readonly bank = new Map<OneShotKind, AudioBuffer[]>();
  private readonly ctx: BaseAudioContext;
  private readonly pool: VoicePool<Slot>;
  private readonly ui: AudioNode;
  private buildQueue: [OneShotKind, number][] = [];
  private key = 0;
  played = 0;
  dropped = 0;
  buildMs = 0;

  constructor(ctx: BaseAudioContext, dst: AudioNode, ui: AudioNode, slots: number) {
    this.ctx = ctx;
    this.ui = ui;
    const s: Slot[] = [];
    for (let i = 0; i < slots; i++) s.push({ voice: new SpatialVoice(ctx, dst, { hrtf: false, refDistance: 4, rolloff: 1 }), src: null, until: 0 });
    this.pool = new VoicePool(s);
    for (const k of BUILD_ORDER) for (let v = 0; v < ONE_SHOT_VARIANTS[k]; v++) this.buildQueue.push([k, v]);
    for (const k of ONE_SHOT_KINDS) if (!BUILD_ORDER.includes(k)) for (let v = 0; v < ONE_SHOT_VARIANTS[k]; v++) this.buildQueue.push([k, v]);
  }

  private external = false;
  private externalDone = false;

  get ready(): boolean {
    return this.external ? this.externalDone : this.buildQueue.length === 0;
  }

  /** The bank arrives from a worker (`addVariant` / `bankDone`); inline building stops. */
  useExternalBank(): void {
    this.external = true;
    this.buildQueue = [];
  }

  addVariant(kind: OneShotKind, data: Float32Array): void {
    const b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    b.getChannelData(0).set(data);
    let list = this.bank.get(kind);
    if (!list) this.bank.set(kind, (list = []));
    list.push(b);
  }

  bankDone(): void {
    this.externalDone = true;
  }

  /** Falls back to inline building (the worker failed). */
  useInlineBank(): void {
    if (!this.external || this.externalDone) return;
    this.external = false;
    for (const k of ONE_SHOT_KINDS) {
      const have = this.bank.get(k)?.length ?? 0;
      for (let v = have; v < ONE_SHOT_VARIANTS[k]; v++) this.buildQueue.push([k, v]);
    }
  }

  get active(): number {
    return this.pool.active;
  }

  get capacity(): number {
    return this.pool.capacity;
  }

  /** Builds bank variants for up to `budgetMs` (call from idle time / a frame tail). */
  build(budgetMs: number): void {
    const t0 = performance.now();
    while (this.buildQueue.length > 0 && performance.now() - t0 < budgetMs) {
      const [k, v] = this.buildQueue.shift()!;
      this.addVariant(k, synthOneShot(k, this.ctx.sampleRate, v + 1));
    }
    this.buildMs += performance.now() - t0;
  }

  /** Builds everything now (tests / OfflineAudioContext renders). */
  buildAll(): void {
    while (this.buildQueue.length > 0) this.build(1e9);
  }

  private pick(kind: OneShotKind): AudioBuffer | null {
    const list = this.bank.get(kind);
    if (!list || list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)]!;
  }

  /**
   * Plays `kind` at world (x, y, z) with linear `gain` and playback `rate`
   * (slow-mo pitch × a little variation). `refDistance` scales with the
   * event's size (a big crash carries further). Returns false when the bank
   * variant is not built yet or the pool refused (quieter than every voice).
   */
  play(kind: OneShotKind, x: number, y: number, z: number, gain: number, rate: number, refDistance: number, distance: number, now: number, delay = 0): boolean {
    const buf = this.pick(kind);
    if (!buf || gain <= 1e-4) return false;
    // reclaim finished slots
    for (let i = 0; i < this.pool.capacity; i++) {
      const s = this.pool.voices[i]!;
      if (this.pool.ownerOf(i) >= 0 && s.until <= now) {
        s.src = null;
        this.pool.release(i);
      }
    }
    const prio = (gain * refDistance) / Math.max(refDistance, distance);
    const i = this.pool.acquire(++this.key, prio);
    if (i < 0) {
      this.dropped++;
      return false;
    }
    const slot = this.pool.voices[i]!;
    if (slot.src) {
      try {
        slot.src.stop();
      } catch {
        // already stopped
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(slot.voice.input);
    slot.voice.panner.refDistance = refDistance;
    slot.voice.setPosition(x, y, z, now);
    slot.voice.input.gain.cancelScheduledValues(now);
    slot.voice.input.gain.setValueAtTime(gain, now);
    src.start(now + delay);
    slot.src = src;
    slot.until = now + delay + buf.duration / Math.max(rate, 0.05) + 0.05;
    this.played++;
    return true;
  }

  /** Non-spatial one-shot on the UI bus (transitions). */
  playUi(kind: OneShotKind, gain: number, rate: number, now: number): boolean {
    const buf = this.pick(kind);
    if (!buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ui);
    src.start(now);
    this.played++;
    return true;
  }

  /** Stops everything (seek, enter / exit replay). */
  stopAll(now: number): void {
    for (let i = 0; i < this.pool.capacity; i++) {
      const s = this.pool.voices[i]!;
      if (s.src) {
        s.voice.input.gain.setTargetAtTime(0, now, 0.02);
        try {
          s.src.stop(now + 0.1);
        } catch {
          // already stopped
        }
        s.src = null;
      }
      this.pool.release(i);
    }
  }
}
