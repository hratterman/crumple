/**
 * Offline scenario renders (P8 audio): drives the pure DSP voices with
 * scripted inputs at the audio thread's 128-frame block size. Used by the
 * gated WAV test (render.wav.test.ts) and by the DSP unit tests.
 */
import { AmbienceDsp, createAmbienceInput } from './dsp/ambience';
import { createEngineInput, EngineDsp, type EngineInput } from './dsp/engine';
import { ONE_SHOT_KINDS, synthOneShot, type OneShotKind } from './dsp/oneshots';
import { createSurfaceInput, SurfaceDsp, type SurfaceInput } from './dsp/surface';
import { HornDsp } from './dsp/horn';
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

/**
 * A crash as the director layers it (director.ts vehicleFrame) at level g
 * (0.15 light tap, 0.4 medium, 1 heavy): body thud, tap or crunch, the
 * rolling crumple chosen by level, a boom for heavy hits, continuation
 * crunches while the car keeps deforming, snaps / plastic for breaking
 * beams, debris. `rate` = playback rate (slow-mo pitch).
 */
export function renderCrash(sr: number, g: number, seed = 1, rate = 1): Float32Array {
  const out = new Float32Array(Math.ceil((2.6 * sr) / rate));
  let n = 0;
  const v = (k: OneShotKind, variant = -1): Float32Array => synthOneShot(k, sr, variant >= 0 ? variant + 1 : seed * 31 + ++n);
  const at = (t: number): number => t / rate;
  mixAt(out, v('thump'), 0, 0.45 + 0.55 * g, sr, rate);
  if (g < 0.22) mixAt(out, v('tap'), 0, 0.45 + g, sr, rate);
  else {
    mixAt(out, v('crunch'), 0, 0.5 + 0.45 * g, sr, rate);
    if (g >= 0.4) mixAt(out, v('crumple', Math.min(3, Math.floor((g - 0.4) / 0.15))), at(0.02), 0.45 + 0.5 * g, sr, rate);
  }
  if (g >= 0.6) mixAt(out, v('boom'), 0, 0.9 * g, sr, rate);
  // the episode: deformation continues for 0.25 + 1.25·g s, a crunch grain every ≥ 90 ms while it does
  if (g >= 0.3) {
    const len = 0.25 + 1.25 * g;
    for (let t = 0.12; t < len * 0.8; t += 0.09 + 0.08 * ((t * 7.3) % 1)) mixAt(out, v('crunch'), at(t), Math.min(0.9, 0.25 + 0.5 * g * (1 - t / len)), sr, rate);
    const snaps = Math.round(2 + 6 * g);
    for (let k = 0; k < snaps; k++) mixAt(out, v('snap'), at(0.02 + (k / snaps) * len * 0.7), 0.35 + 0.3 * g, sr, rate);
    if (g >= 0.5) mixAt(out, v('plastic'), at(0.05), 0.5 * g, sr, rate);
    if (g >= 0.5) mixAt(out, v('debris'), at(0.25 + len * 0.3), 0.6 * g, sr, rate);
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const k = peak > 0.9 ? 0.9 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * k * 1.15) / Math.tanh(1.15) * 0.95;
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
  // horns: a short tap, then a 1.4 s press (the air horn's two pressure stages show in the hold)
  for (const id of ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater']) {
    const p = ENGINE_PROFILES[id]!;
    const h = new HornDsp(p.horn, sr, 3);
    const n = Math.ceil((2.6 * sr) / BLOCK) * BLOCK;
    const x = new Float32Array(n);
    for (let o = 0; o < n; o += BLOCK) {
      const t = o / sr;
      h.process(x.subarray(o, o + BLOCK), BLOCK, (t > 0.05 && t < 0.3) || (t > 0.75 && t < 2.15), 1);
    }
    out.push({ name: `horn_${id}`, channels: [x] });
  }
  // a traffic sedan passing at 25 m/s, honking: light voice, Doppler pitch 343/(343∓25) through the pass
  {
    const p = ENGINE_PROFILES.sedanTraffic!;
    const [ex, fr] = renderEngine(p, sr, 4, (t, inp) => {
      inp.rpm = 2300;
      inp.throttle = 0.3;
      inp.load = 0.3;
      inp.horn = t > 0.8 && t < 3.2 ? 1 : 0;
      const x = (t - 2) * 25; // along the road, the listener 6 m off it
      const cos = x / Math.sqrt(x * x + 36);
      inp.pitch = 343 / (343 + 25 * cos);
    }, 9, true);
    const mix = engineMix(ex, fr);
    for (let i = 0; i < mix.length; i++) {
      const x = (i / sr - 2) * 25;
      mix[i] = mix[i]! * Math.min(1, 8 / Math.sqrt(x * x + 36));
    }
    out.push({ name: 'horn_traffic_passby_doppler', channels: [mix] });
  }
  // crashes: heavy at 1×, the same at the crash cam's 1/4× (pitch 0.25^0.75), light knock; every one-shot kind
  out.push({ name: 'crash_heavy', channels: [renderCrash(sr, 1, 3)] });
  out.push({ name: 'crash_medium', channels: [renderCrash(sr, 0.4, 5)] });
  out.push({ name: 'crash_light_tap', channels: [renderCrash(sr, 0.15, 7)] });
  out.push({ name: 'crash_heavy_slowmo_quarter', channels: [renderCrash(sr, 1, 3, Math.pow(0.25, 0.75))] });
  {
    const g = new Float32Array(Math.ceil(1.2 * sr));
    mixAt(g, synthOneShot('glass', sr, 2), 0, 0.9, sr);
    out.push({ name: 'glass_break', channels: [g] });
  }
  for (const k of ONE_SHOT_KINDS) {
    const len = synthOneShot(k, sr, 1).length;
    const all = new Float32Array(len * 2 + sr);
    mixAt(all, synthOneShot(k, sr, 1), 0, 1, sr);
    mixAt(all, synthOneShot(k, sr, 2), len / sr + 0.5, 1, sr);
    out.push({ name: `oneshot_${k}`, channels: [all] });
  }
  return out;
}
