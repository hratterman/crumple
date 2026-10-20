/**
 * Offline scenario renders (P8 audio): drives the pure DSP voices with
 * scripted inputs at the audio thread's 128-frame block size. Used by the
 * gated WAV test (render.wav.test.ts) and by the DSP unit tests.
 */
import { AmbienceDsp, createAmbienceInput } from './dsp/ambience';
import { createEngineInput, EngineDsp, type EngineInput } from './dsp/engine';
import { ONE_SHOT_KINDS, synthOneShot, type OneShotKind } from './dsp/oneshots';
import { createSurfaceInput, SurfaceDsp, type SurfaceInput } from './dsp/surface';
import { ENGINE_PROFILES, type EngineProfile } from './profiles';

export const BLOCK = 128;

export interface RenderedScenario {
  name: string;
  channels: Float32Array[];
}

/** Renders an engine for `seconds` with `script(t, inp)` filling the block inputs; returns [exhaust, front]. */
export function renderEngine(profile: EngineProfile, sr: number, seconds: number, script: (t: number, inp: EngineInput) => void, seed = 7, light = false): [Float32Array, Float32Array] {
  const n = Math.ceil((seconds * sr) / BLOCK) * BLOCK;
  const ex = new Float32Array(n);
  const fr = new Float32Array(n);
  const dsp = new EngineDsp(profile, sr, seed, light);
  const inp = createEngineInput();
  inp.rpm = profile.idleRpm;
  for (let o = 0; o < n; o += BLOCK) {
    script((o + BLOCK) / sr, inp);
    dsp.process(ex.subarray(o, o + BLOCK), fr.subarray(o, o + BLOCK), BLOCK, inp);
  }
  return [ex, fr];
}

/** Mono "outside the car, behind it" mix of the two engine outputs. */
export function engineMix(ex: Float32Array, fr: Float32Array, front = 0.7): Float32Array {
  const out = new Float32Array(ex.length);
  for (let i = 0; i < ex.length; i++) out[i] = ex[i]! * 0.9 + fr[i]! * front;
  return out;
}

/** The idle / mid / redline / sweep / start scripts used for every engine. */
export function engineScripts(p: EngineProfile): Record<string, { seconds: number; script: (t: number, inp: EngineInput) => void }> {
  const idle = p.idleRpm;
  const red = p.redlineRpm;
  const lim = p.revLimitRpm;
  return {
    idle: {
      seconds: 3,
      script: (_t, inp) => {
        inp.rpm = idle;
        inp.throttle = 0;
        inp.load = 0.08;
      },
    },
    mid: {
      seconds: 3,
      script: (_t, inp) => {
        inp.rpm = red * 0.5;
        inp.throttle = 0.45;
        inp.load = 0.5;
      },
    },
    redline: {
      seconds: 3,
      script: (_t, inp) => {
        inp.rpm = lim;
        inp.throttle = 1;
        inp.load = 1;
        inp.limiter = 1;
      },
    },
    sweep: {
      seconds: 9,
      script: (t, inp) => {
        inp.limiter = 0;
        if (t < 1) {
          inp.rpm = idle;
          inp.throttle = 0;
          inp.load = 0.08;
        } else if (t < 5.5) {
          const u = (t - 1) / 4.5;
          inp.rpm = idle + (lim - idle) * Math.pow(u, 0.8);
          inp.throttle = 1;
          inp.load = 1;
        } else if (t < 6.2) {
          inp.rpm = lim;
          inp.throttle = 1;
          inp.load = 1;
          inp.limiter = 1;
        } else if (t < 8.2) {
          const u = (t - 6.2) / 2;
          inp.rpm = lim + (idle * 1.2 - lim) * u;
          inp.throttle = 0;
          inp.load = 0;
        } else {
          inp.rpm = idle;
          inp.throttle = 0;
          inp.load = 0.08;
        }
      },
    },
    start: {
      seconds: 3.5,
      script: (t, inp) => {
        if (t < 0.9) {
          inp.crank = 1;
          inp.rpm = p.crankRpm * (0.85 + 0.15 * Math.sin(t * 40));
          inp.throttle = 0;
          inp.load = 0;
        } else {
          inp.crank = 0;
          const u = t - 0.9;
          inp.rpm = idle * (1 + 0.75 * Math.exp(-u / 0.35) * Math.min(1, u / 0.12));
          inp.throttle = 0;
          inp.load = 0.15;
        }
      },
    },
  };
}

/** Renders the surface voice: [tyres, windL, windR]. */
export function renderSurface(sr: number, seconds: number, script: (t: number, inp: SurfaceInput) => void): [Float32Array, Float32Array, Float32Array] {
  const n = Math.ceil((seconds * sr) / BLOCK) * BLOCK;
  const ty = new Float32Array(n);
  const wl = new Float32Array(n);
  const wr = new Float32Array(n);
  const dsp = new SurfaceDsp(sr, 5);
  const inp = createSurfaceInput();
  for (let o = 0; o < n; o += BLOCK) {
    script((o + BLOCK) / sr, inp);
    dsp.process(ty.subarray(o, o + BLOCK), wl.subarray(o, o + BLOCK), wr.subarray(o, o + BLOCK), BLOCK, inp);
  }
  return [ty, wl, wr];
}

/** Mixes `src` × gain into `dst` starting at `at` seconds (one-shot layering for offline crash renders). */
export function mixAt(dst: Float32Array, src: Float32Array, at: number, gain: number, sr: number, rate = 1): void {
  const i0 = Math.floor(at * sr);
  for (let i = 0; ; i++) {
    const p = i * rate;
    const k = Math.floor(p);
    if (k + 1 >= src.length || i0 + i >= dst.length) break;
    const f = p - k;
    dst[i0 + i] = dst[i0 + i]! + (src[k]! * (1 - f) + src[k + 1]! * f) * gain;
  }
}

/** A heavy crash as the game layers it: boom + thump + crunch + snaps + glass + debris (seconds). */
export function renderCrash(sr: number, severity: number, seed = 1, rate = 1): Float32Array {
  const out = new Float32Array(Math.ceil(3 * sr / rate));
  const v = (k: OneShotKind, i: number): Float32Array => synthOneShot(k, sr, seed * 31 + i);
  mixAt(out, v('boom', 0), 0, 0.4 * severity, sr, rate);
  mixAt(out, v('thump', 1), 0, 0.35 * severity, sr, rate);
  mixAt(out, v('crunch', 2), 0.002, 0.7, sr, rate);
  mixAt(out, v('crunch', 3), 0.06, 0.45 * severity, sr, rate);
  mixAt(out, v('snap', 4), 0.03, 0.25, sr, rate);
  mixAt(out, v('snap', 5), 0.11, 0.2, sr, rate);
  mixAt(out, v('glass', 6), 0.04, 0.42 * severity, sr, rate);
  mixAt(out, v('debris', 7), 0.18, 0.35, sr, rate);
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * 1.1) * 0.9;
  return out;
}

export function renderScenarios(sr: number): RenderedScenario[] {
  const out: RenderedScenario[] = [];
  for (const id of ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater']) {
    const p = ENGINE_PROFILES[id]!;
    const scripts = engineScripts(p);
    for (const [name, s] of Object.entries(scripts)) {
      const [ex, fr] = renderEngine(p, sr, s.seconds, s.script);
      out.push({ name: `engine_${id}_${name}`, channels: [engineMix(ex, fr)] });
    }
  }
  // traffic (light voice) pass at mid rpm
  {
    const p = ENGINE_PROFILES.sedanTraffic!;
    const [ex, fr] = renderEngine(p, sr, 3, (_t, inp) => {
      inp.rpm = 2600;
      inp.throttle = 0.35;
      inp.load = 0.4;
    }, 9, true);
    out.push({ name: 'engine_traffic_light_mid', channels: [engineMix(ex, fr)] });
  }
  // tyres: a drift (slip ramps in and out) on asphalt at 25 m/s, then a burnout
  {
    const [ty, wl, wr] = renderSurface(sr, 8, (t, inp) => {
      inp.squealHz = 900;
      if (t < 5) {
        inp.speed = 25;
        const s = t < 1 ? 0 : t < 2.5 ? (t - 1) / 1.5 : t < 4 ? 1 : 1 - (t - 4);
        inp.squealF = Math.max(0, s) * 0.6;
        inp.squealR = Math.max(0, s);
        inp.squealPitchF = 1 + 0.1 * s;
        inp.squealPitchR = 1.05 + 0.12 * s;
        inp.scrub = 0.15 * s;
        inp.roar = 0.55;
        inp.wind = 0.35;
        inp.windSpeed = 25;
      } else {
        inp.speed = 1;
        inp.squealF = 0;
        inp.squealR = 0.8;
        inp.squealPitchR = 0.92;
        inp.scrub = 0.9;
        inp.roar = 0.05;
        inp.wind = 0;
      }
    });
    out.push({ name: 'tyres_drift_burnout', channels: [ty] });
    out.push({ name: 'wind_25ms', channels: [wl, wr] });
  }
  // surfaces at 15 m/s: asphalt roar, gravel, dirt, grass; then a scrape and suspension thumps
  {
    const [ty] = renderSurface(sr, 10, (t, inp) => {
      inp.speed = 15;
      inp.roar = t < 2 ? 0.5 : 0.15;
      inp.roarTone = 0;
      inp.gravel = t >= 2 && t < 4 ? 0.8 : 0;
      inp.dirt = t >= 4 && t < 6 ? 0.8 : 0;
      inp.grass = t >= 6 && t < 8 ? 0.8 : 0;
      inp.scrape = t >= 8 && t < 9.2 ? 0.8 : 0;
      inp.scrapeSpeed = 12;
      if (t >= 9.2) {
        const k = Math.floor((t - 9.2) / 0.25);
        inp.thumpCount = k + 1;
        inp.thumpAmp = k % 2 === 0 ? 0.45 : 0.9;
      }
    });
    out.push({ name: 'surfaces_asphalt_gravel_dirt_grass_scrape_thumps', channels: [ty] });
  }
  // ambience: valley (birds, breeze, crickets) and lakeside
  {
    const n = 12 * sr;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const amb = new AmbienceDsp(sr, 4);
    const inp = createAmbienceInput();
    for (let o = 0; o + BLOCK <= n; o += BLOCK) {
      const t = o / sr;
      inp.birds = 0.8;
      inp.breeze = 0.6;
      inp.crickets = 0.5;
      inp.water = t > 6 ? 0.7 : 0;
      amb.process(l.subarray(o, o + BLOCK), r.subarray(o, o + BLOCK), BLOCK, inp);
    }
    out.push({ name: 'ambience_valley_lake', channels: [l, r] });
  }
  // crashes: heavy at 1×, the same at the crash cam's 1/4× (pitch 0.25^0.75), light knock; every one-shot kind
  out.push({ name: 'crash_heavy', channels: [renderCrash(sr, 1, 3)] });
  out.push({ name: 'crash_heavy_slowmo_quarter', channels: [renderCrash(sr, 1, 3, Math.pow(0.25, 0.75))] });
  for (const k of ONE_SHOT_KINDS) {
    const len = synthOneShot(k, sr, 1).length;
    const all = new Float32Array(len * 2 + sr);
    mixAt(all, synthOneShot(k, sr, 1), 0, 1, sr);
    mixAt(all, synthOneShot(k, sr, 2), len / sr + 0.5, 1, sr);
    out.push({ name: `oneshot_${k}`, channels: [all] });
  }
  return out;
}
