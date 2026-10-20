/**
 * Pure parameter mappings of the audio system (P8): telemetry / events →
 * synthesis parameters. Unit-tested (params.test.ts); no WebAudio here.
 */

export const SPEED_OF_SOUND = 343;

/** Firing frequency of a four-stroke engine: rpm/60 · cylinders/2 (Hz). */
export function firingHz(rpm: number, cylinders: number): number {
  return (Math.max(0, rpm) / 60) * (cylinders / 2);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** Nominal static wheel load used to normalise squeal (N); heavier cars squeal at the same slip. */
export const SQUEAL_NOMINAL_LOAD = 3500;

/**
 * Tyre squeal level from a wheel's slip speed (telemetry: mean tangential
 * ground velocity of the in-contact tread, m/s) and its load (N): silent
 * below ~1.2 m/s (normal rolling / cornering slip), full by ~5.5 m/s, and it
 * yields to the broadband scrub above ~14 m/s (a smoking burnout roars more
 * than it sings). An unloaded (airborne) wheel is silent.
 */
export function squealGain(slip: number, load: number, nominalLoad = SQUEAL_NOMINAL_LOAD): number {
  if (!(load > 0) || !(slip > 0)) return 0;
  const onset = smoothstep(1.2, 5.5, slip);
  const yieldToScrub = 1 - 0.45 * smoothstep(14, 28, slip);
  const lf = Math.min(1.3, Math.max(0.15, load / nominalLoad));
  return Math.min(1, onset * yieldToScrub * Math.pow(lf, 0.6));
}

/** Broadband scrub (burnout / big slide hiss) from slip speed, 0..1. */
export function scrubGain(slip: number): number {
  return smoothstep(5, 18, slip);
}

/** Squeal pitch factor: rises a little with slip speed and with load (≈ 0.9 … 1.25). */
export function squealPitch(slip: number, load: number, nominalLoad = SQUEAL_NOMINAL_LOAD): number {
  const s = Math.max(0, slip);
  const lf = Math.min(1.6, Math.max(0, load / nominalLoad));
  return 0.92 + 0.16 * (s / (s + 6)) + 0.1 * (lf - 1) * 0.5;
}

/** Impulse below which an impact is inaudible / above which a crash is at full level (N·s). */
export const CRASH_IMPULSE_MIN = 4;
export const CRASH_IMPULSE_FULL = 1800;

/**
 * Crash level 0..1 from the summed impulse of one object's impacts in one
 * frame (N·s): logarithmic between CRASH_IMPULSE_MIN and CRASH_IMPULSE_FULL
 * (loudness is perceived in dB), slightly expanded so knocks stay knocks.
 */
export function crashGain(impulse: number): number {
  if (!(impulse > CRASH_IMPULSE_MIN)) return 0;
  const t = Math.log(impulse / CRASH_IMPULSE_MIN) / Math.log(CRASH_IMPULSE_FULL / CRASH_IMPULSE_MIN);
  const c = t >= 1 ? 1 : t;
  return Math.pow(c, 1.15);
}

/**
 * Doppler factor for a source and listener (positions m, velocities m/s):
 * f'/f = (c − v_l·n)/(c − v_s·n), n = unit vector source → listener.
 * Clamped to [0.5, 2] (supersonic / degenerate cases). Allocation-free.
 */
export function dopplerFactor(
  sx: number,
  sy: number,
  sz: number,
  svx: number,
  svy: number,
  svz: number,
  lx: number,
  ly: number,
  lz: number,
  lvx: number,
  lvy: number,
  lvz: number,
  c = SPEED_OF_SOUND,
): number {
  const dx = lx - sx;
  const dy = ly - sy;
  const dz = lz - sz;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-3) return 1;
  const nx = dx / d;
  const ny = dy / d;
  const nz = dz / d;
  const vs = svx * nx + svy * ny + svz * nz;
  const vl = lvx * nx + lvy * ny + lvz * nz;
  const den = c - vs;
  if (den < c * 0.25) return 2;
  const f = (c - vl) / den;
  return f < 0.5 ? 0.5 : f > 2 ? 2 : f;
}

/**
 * Pitch of the world sound at playback / sim rate `rate` (1 = real time):
 * rate^(3/4) — slow-mo goes down moderately rather than by the full rate
 * (a 1/4× crash would otherwise be a sub-bass rumble) — capped to
 * [0.32, 1.35].
 */
export function slowMoPitch(rate: number): number {
  if (!(rate > 0)) return 1;
  const p = Math.pow(rate, 0.75);
  return p < 0.32 ? 0.32 : p > 1.35 ? 1.35 : p;
}

/** Cinematic low-pass cutoff for slow motion (Hz): open at ≥ 1×, ≈ 2.4 kHz at 1/4×. */
export function slowMoLowpass(rate: number): number {
  if (!(rate > 0) || rate >= 1) return 20000;
  return Math.max(900, 20000 * Math.pow(rate, 1.55));
}

/**
 * Engine load 0..1 for the synthesis from the applied throttle and the net
 * crank torque (telemetry): the torque term carries real load (uphill, in
 * gear) while the throttle term keeps a free rev sounding like a blip.
 */
export function engineLoad(throttle: number, engineTorque: number, peakTorque: number): number {
  const thr = throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
  const tq = peakTorque > 0 ? Math.max(0, engineTorque) / peakTorque : 0;
  const l = 0.45 * thr + 0.55 * Math.min(1, tq);
  return l > 1 ? 1 : l;
}

/** Wind level 0..1 from airspeed (m/s): ∝ v² above a walking pace. */
export function windGain(speed: number): number {
  const v = Math.max(0, speed - 3);
  return Math.min(1, (v * v) / (45 * 45));
}

/** Road roar level 0..1 from ground speed (m/s). */
export function roarGain(speed: number): number {
  const v = Math.max(0, speed);
  return Math.min(1, Math.pow(v / 38, 1.4));
}

/** Duck depth (linear gain on the other buses) for a crash of level g (0..1): up to −10 dB. */
export function duckGain(g: number): number {
  const x = g < 0 ? 0 : g > 1 ? 1 : g;
  return Math.pow(10, (-10 * x * x) / 20);
}
