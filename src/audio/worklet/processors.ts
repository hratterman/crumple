/**
 * AudioWorklet processors (P8 audio). Loaded with
 * `audioWorklet.addModule(new URL(processorsUrl, import.meta.url))`, where
 * `processorsUrl` comes from `./processors.ts?worker&url` (Vite bundles it as
 * its own self-contained module; a bare `new URL('./x.ts')` would ship the TS
 * source untranspiled). Heavy DSP stays off the main thread: main only sets
 * k-rate AudioParams once per frame.
 *
 *   crumple-engine    2 outputs (mono): exhaust, intake + mechanical
 *   crumple-surface   2 outputs: tyres/road/scrape/thumps (mono), wind (stereo)
 *   crumple-ambience  1 output (stereo): birds, breeze, crickets, water
 *
 * Every process() is allocation-free (DSP state preallocated; the input
 * records are reused).
 */
import { AmbienceDsp, createAmbienceInput } from '../dsp/ambience';
import { createEngineInput, EngineDsp } from '../dsp/engine';
import { createSurfaceInput, SurfaceDsp } from '../dsp/surface';
import type { EngineProfile } from '../profiles';
import { AMBIENCE_PARAMS, SURFACE_PARAMS } from '../voiceParams';

// ---- AudioWorkletGlobalScope (not in TS's DOM lib)
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
type Params = Record<string, Float32Array>;
interface ProcOptions<T> {
  processorOptions?: T;
}

function k(name: string, defaultValue: number, minValue = -1e9, maxValue = 1e9) {
  return { name, defaultValue, minValue, maxValue, automationRate: 'k-rate' };
}
function last(p: Params, name: string, fallback: number): number {
  const a = p[name];
  return a && a.length > 0 ? a[a.length - 1]! : fallback;
}

import type { EngineProcessorOptions } from '../voiceParams';

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [k('rpm', 800, 0, 20000), k('throttle', 0, 0, 1), k('load', 0, 0, 1), k('gate', 0, 0, 1), k('pitch', 1, 0.05, 8), k('limiter', 0, 0, 1), k('crank', 0, 0, 1), k('shift', 0, 0, 1), k('damage', 0, 0, 1)];
  }
  private readonly dsp: EngineDsp;
  private readonly inp = createEngineInput();
  private silentBlocks = 0;
  constructor(options: ProcOptions<EngineProcessorOptions>) {
    super(options);
    const o = options.processorOptions!;
    this.dsp = new EngineDsp(o.profile, sampleRate, o.seed, o.light);
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; profile?: EngineProfile };
      if (d.type === 'profile' && d.profile) this.dsp.setProfile(d.profile);
    };
  }
  process(_in: Float32Array[][], outputs: Float32Array[][], p: Params): boolean {
    const ex = outputs[0]?.[0];
    if (!ex) return true;
    const fr = outputs[1]?.[0] ?? ex;
    const inp = this.inp;
    inp.gate = last(p, 'gate', 0);
    // a gated-off voice that has faded out costs nothing
    if (inp.gate <= 0) {
      if (++this.silentBlocks > 64) {
        ex.fill(0);
        if (fr !== ex) fr.fill(0);
        return true;
      }
    } else this.silentBlocks = 0;
    inp.rpm = last(p, 'rpm', 800);
    inp.throttle = last(p, 'throttle', 0);
    inp.load = last(p, 'load', 0);
    inp.pitch = last(p, 'pitch', 1);
    inp.limiter = last(p, 'limiter', 0);
    inp.crank = last(p, 'crank', 0);
    inp.shift = last(p, 'shift', 0);
    inp.damage = last(p, 'damage', 0);
    this.dsp.process(ex, fr, ex.length, inp);
    return true;
  }
}

class SurfaceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return SURFACE_PARAMS.map((n) => k(n, n === 'pitch' || n === 'squealPitchF' || n === 'squealPitchR' ? 1 : n === 'squealHz' ? 900 : 0));
  }
  private readonly dsp = new SurfaceDsp(sampleRate, 5);
  private readonly inp = createSurfaceInput();
  process(_in: Float32Array[][], outputs: Float32Array[][], p: Params): boolean {
    const ty = outputs[0]?.[0];
    const wl = outputs[1]?.[0];
    const wr = outputs[1]?.[1] ?? wl;
    if (!ty || !wl || !wr) return true;
    const inp = this.inp;
    inp.pitch = last(p, 'pitch', 1);
    inp.speed = last(p, 'speed', 0);
    inp.squealF = last(p, 'squealF', 0);
    inp.squealR = last(p, 'squealR', 0);
    inp.squealPitchF = last(p, 'squealPitchF', 1);
    inp.squealPitchR = last(p, 'squealPitchR', 1);
    inp.squealHz = last(p, 'squealHz', 900);
    inp.scrub = last(p, 'scrub', 0);
    inp.roar = last(p, 'roar', 0);
    inp.roarTone = last(p, 'roarTone', 0);
    inp.gravel = last(p, 'gravel', 0);
    inp.dirt = last(p, 'dirt', 0);
    inp.grass = last(p, 'grass', 0);
    inp.scrape = last(p, 'scrape', 0);
    inp.scrapeSpeed = last(p, 'scrapeSpeed', 0);
    inp.thumpCount = last(p, 'thumpCount', 0);
    inp.thumpAmp = last(p, 'thumpAmp', 0);
    inp.wind = last(p, 'wind', 0);
    inp.windSpeed = last(p, 'windSpeed', 0);
    this.dsp.process(ty, wl, wr, ty.length, inp);
    return true;
  }
}

class AmbienceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return AMBIENCE_PARAMS.map((n) => k(n, n === 'pitch' ? 1 : 0));
  }
  private readonly dsp = new AmbienceDsp(sampleRate, 11);
  private readonly inp = createAmbienceInput();
  process(_in: Float32Array[][], outputs: Float32Array[][], p: Params): boolean {
    const l = outputs[0]?.[0];
    const r = outputs[0]?.[1] ?? l;
    if (!l || !r) return true;
    const inp = this.inp;
    inp.birds = last(p, 'birds', 0);
    inp.breeze = last(p, 'breeze', 0);
    inp.crickets = last(p, 'crickets', 0);
    inp.water = last(p, 'water', 0);
    inp.pitch = last(p, 'pitch', 1);
    this.dsp.process(l, r, l.length, inp);
    return true;
  }
}

registerProcessor('crumple-engine', EngineProcessor);
registerProcessor('crumple-surface', SurfaceProcessor);
registerProcessor('crumple-ambience', AmbienceProcessor);
