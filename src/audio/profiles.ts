import type { HornProfile } from './dsp/horn';

/**
 * Per-vehicle engine sound profiles (P8 audio; pure data, owned by src/audio).
 *
 * The catalog's `stats.engine` line sets the layout (cylinders, firing order,
 * exhaust banks); idle / redline / limiter come from the vehicle's
 * DrivetrainDef at runtime (`withDrivetrain`), so a retuned car still bounces
 * off its own limiter. Firing orders are real ones: the V8s are cross-plane
 * (1-8-7-2-6-5-4-3, odd cylinders on the left bank: each bank sees the uneven
 * L R L L R L R R pattern that makes the burble), the I6s 1-5-3-6-2-4 with a
 * split 3+3 manifold, the I4 1-3-4-2 into one 4-2-1 header.
 */

export interface ExhaustProfile {
  /** Pipe length per bank (m): the waveguide round trip is 2·L / 343 m/s. */
  pipeM: readonly [number, number];
  /** End reflection (negative = open pipe end), |r| < 0.9. */
  reflect: number;
  /** Loop low-pass (pipe losses), Hz. */
  loopHz: number;
  /** Muffler low-pass at zero load, Hz (opens up to +60 % at full load). */
  lowpassHz: number;
  /** Body / drone resonance (peaking EQ) Hz and gain dB: low-end weight. */
  bodyHz: number;
  bodyDb: number;
  /** Blowdown rasp (turbulent noise riding the pulses) at full load. */
  rasp: number;
  /** Rasp band centre, Hz. */
  raspHz: number;
  gain: number;
}

export interface IntakeProfile {
  /** Helmholtz resonance of the airbox, Hz (rises ~25 % with rpm). */
  helmHz: number;
  q: number;
  /** Pulse (pressure) part vs induction roar (noise) part. */
  pulse: number;
  roar: number;
  roarHz: number;
  gain: number;
}

export interface MechProfile {
  /** Valve-train tick level. */
  tick: number;
  /** Diesel combustion knock ("clatter") level and its block resonances, Hz. */
  clatter: number;
  clatterHz: readonly [number, number, number];
  /** Gear / timing-chain whine level and its order (teeth per crank rev). */
  whine: number;
  whineOrder: number;
  /** Loose heat-shield rattle level and its rpm window. */
  rattle: number;
  rattleRpm: readonly [number, number];
}

export interface TurboProfile {
  /** Boost builds from lo to hi rpm (× throttle). */
  spoolRpm: readonly [number, number];
  /** Whistle frequency at zero / full boost, Hz. */
  whistleHz: readonly [number, number];
  gain: number;
  /** Spool-up time constant, s. */
  lag: number;
  /** Lift-off dump: blow-off valve hiss or wastegate / compressor-surge flutter. */
  dump: 'bov' | 'flutter';
  dumpGain: number;
}

export interface EngineProfile {
  id: string;
  label: string;
  cylinders: number;
  /** Exhaust bank of each FIRING SLOT (firing order position), 0 or 1. */
  banks: readonly number[];
  /** Pulse strength per firing slot (runner / header differences: the half-order lumps). */
  cylGain: readonly number[];
  /** Static timing offset per firing slot, crank degrees. */
  cylTiming: readonly number[];
  idleRpm: number;
  redlineRpm: number;
  revLimitRpm: number;
  /** Blowdown decay width in crank degrees (pulse width scales with 1/rpm). */
  pulseDeg: number;
  /** Pulse attack time constant at zero / full load, ms (sharper = brighter under load). */
  attackMs: readonly [number, number];
  /** Cycle-to-cycle combustion variability (σ of the pulse amplitude), doubled at idle. */
  cycleVar: number;
  /** Random timing jitter per firing, crank degrees. */
  jitterDeg: number;
  /** Misfire probability per firing (idle; halves under load). */
  misfire: number;
  /** Idle speed wander, rpm (slow lope). */
  idleLope: number;
  diesel: boolean;
  exhaust: ExhaustProfile;
  intake: IntakeProfile;
  mech: MechProfile;
  turbo: TurboProfile | null;
  /** Overrun pops / crackle on lift-off and on the limiter, 0..1. */
  pops: number;
  /** Bank 1 level relative to bank 0. */
  bankBalance: number;
  /** Tyre squeal base pitch for this car's tyres, Hz. */
  squealHz: number;
  /** Starter crank speed, rpm. */
  crankRpm: number;
  /** P8: the horn (dsp/horn.ts). */
  horn: HornProfile;
}

const V8_BANKS = [0, 1, 0, 1, 1, 0, 1, 0];
const I6_BANKS = [0, 1, 0, 1, 0, 1];
const I4_BANKS = [0, 0, 0, 0];

/** Coupe: 4.0 L twin-turbo cross-plane V8, short loud pipes, crackle on the overrun. */
export const COUPE_ENGINE: EngineProfile = {
  id: 'coupe',
  label: '4.0 L twin-turbo V8',
  cylinders: 8,
  banks: V8_BANKS,
  cylGain: [1.0, 0.84, 1.12, 0.9, 1.06, 0.8, 1.16, 0.94],
  cylTiming: [0, 1.5, -1, 2, -1.5, 0.5, -2, 1],
  idleRpm: 750,
  redlineRpm: 7000,
  revLimitRpm: 7300,
  pulseDeg: 70,
  attackMs: [0.165, 0.06],
  cycleVar: 0.11,
  jitterDeg: 1.8,
  misfire: 0,
  idleLope: 25,
  diesel: false,
  exhaust: { pipeM: [1.55, 1.85], reflect: -0.5, loopHz: 3200, lowpassHz: 1250, bodyHz: 95, bodyDb: 6, rasp: 1.12, raspHz: 1900, gain: 0.5 },
  intake: { helmHz: 340, q: 2.6, pulse: 0.55, roar: 0.32, roarHz: 2300, gain: 0.22 },
  mech: { tick: 0.025, clatter: 0, clatterHz: [1800, 3100, 4700], whine: 0.006, whineOrder: 36, rattle: 0, rattleRpm: [0, 0] },
  turbo: { spoolRpm: [1900, 3600], whistleHz: [2600, 6400], gain: 0.022, lag: 0.45, dump: 'bov', dumpGain: 0.32 },
  pops: 0.9,
  bankBalance: 0.82,
  squealHz: 980,
  crankRpm: 230,
  horn: { kind: 'disc', freqs: [435, 528], level: 0.5, formantHz: 2600 },
};

/** Pickup: 5.0 L cross-plane V8, long pipes, deep and lazy. */
export const PICKUP_ENGINE: EngineProfile = {
  id: 'pickup',
  label: '5.0 L V8',
  cylinders: 8,
  banks: V8_BANKS,
  cylGain: [1.0, 0.78, 1.16, 0.88, 1.1, 0.76, 1.2, 0.92],
  cylTiming: [0, 2.5, -1.5, 3, -2, 1, -3, 1.5],
  idleRpm: 700,
  redlineRpm: 6000,
  revLimitRpm: 6200,
  pulseDeg: 85,
  attackMs: [0.248, 0.096],
  cycleVar: 0.14,
  jitterDeg: 2.4,
  misfire: 0,
  idleLope: 35,
  diesel: false,
  exhaust: { pipeM: [2.6, 3.05], reflect: -0.55, loopHz: 2200, lowpassHz: 800, bodyHz: 72, bodyDb: 7.5, rasp: 0.72, raspHz: 1400, gain: 0.55 },
  intake: { helmHz: 260, q: 2.2, pulse: 0.6, roar: 0.22, roarHz: 1700, gain: 0.2 },
  mech: { tick: 0.03, clatter: 0, clatterHz: [1600, 2900, 4400], whine: 0.004, whineOrder: 30, rattle: 0, rattleRpm: [0, 0] },
  turbo: null,
  pops: 0.1,
  bankBalance: 0.78,
  squealHz: 820,
  crankRpm: 200,
  horn: { kind: 'disc', freqs: [330, 412], level: 0.55, formantHz: 1900 },
};

/** Box truck: 6.7 L turbo-diesel I6 — combustion clatter, turbo whistle, wastegate flutter. */
export const BOXTRUCK_ENGINE: EngineProfile = {
  id: 'boxtruck',
  label: '6.7 L turbo-diesel I6',
  cylinders: 6,
  banks: I6_BANKS,
  cylGain: [1.0, 0.95, 1.04, 0.97, 1.02, 0.94],
  cylTiming: [0, 1, -1, 1.5, -0.5, 0.5],
  idleRpm: 650,
  redlineRpm: 2500,
  revLimitRpm: 2700,
  pulseDeg: 95,
  attackMs: [0.121, 0.072],
  cycleVar: 0.09,
  jitterDeg: 1.8,
  misfire: 0,
  idleLope: 8,
  diesel: true,
  exhaust: { pipeM: [3.4, 3.6], reflect: -0.45, loopHz: 1800, lowpassHz: 650, bodyHz: 62, bodyDb: 6, rasp: 0.96, raspHz: 1100, gain: 0.55 },
  intake: { helmHz: 210, q: 2.0, pulse: 0.4, roar: 0.35, roarHz: 1300, gain: 0.22 },
  mech: { tick: 0.02, clatter: 0.5, clatterHz: [1750, 2950, 4350], whine: 0.012, whineOrder: 22, rattle: 0, rattleRpm: [0, 0] },
  turbo: { spoolRpm: [900, 1800], whistleHz: [1700, 4800], gain: 0.045, lag: 0.8, dump: 'flutter', dumpGain: 0.3 },
  pops: 0,
  bankBalance: 0.96,
  squealHz: 640,
  crankRpm: 170,
  horn: { kind: 'air', freqs: [165, 208, 247], level: 0.65, formantHz: 700 },
};

/** Sedan: 3.0 L inline-6 (the catalog's engine): smooth, silky, a bit of induction howl. */
export const SEDAN_ENGINE: EngineProfile = {
  id: 'sedan',
  label: '3.0 L inline-6',
  cylinders: 6,
  banks: I6_BANKS,
  cylGain: [1.0, 0.97, 1.03, 0.98, 1.02, 0.96],
  cylTiming: [0, 0.5, -0.5, 0.8, -0.3, 0.2],
  idleRpm: 800,
  redlineRpm: 6800,
  revLimitRpm: 7000,
  pulseDeg: 62,
  attackMs: [0.176, 0.084],
  cycleVar: 0.09,
  jitterDeg: 1.5,
  misfire: 0,
  idleLope: 10,
  diesel: false,
  exhaust: { pipeM: [2.1, 2.25], reflect: -0.45, loopHz: 2600, lowpassHz: 1000, bodyHz: 105, bodyDb: 4, rasp: 0.64, raspHz: 2000, gain: 0.42 },
  intake: { helmHz: 380, q: 3.2, pulse: 0.7, roar: 0.28, roarHz: 2600, gain: 0.28 },
  mech: { tick: 0.02, clatter: 0, clatterHz: [1800, 3100, 4700], whine: 0.004, whineOrder: 34, rattle: 0, rattleRpm: [0, 0] },
  turbo: null,
  pops: 0.12,
  bankBalance: 0.97,
  squealHz: 900,
  crankRpm: 220,
  horn: { kind: 'disc', freqs: [410, 497], level: 0.5, formantHz: 2400 },
};

/** Beater: 1.6 L inline-4, tired — rough idle, the odd misfire, a rattling heat shield, a leaky exhaust. */
export const BEATER_ENGINE: EngineProfile = {
  id: 'beater',
  label: '1.6 L inline-4',
  cylinders: 4,
  banks: I4_BANKS,
  cylGain: [1.0, 0.82, 1.08, 0.9],
  cylTiming: [0, 3, -2, 4],
  idleRpm: 850,
  redlineRpm: 6200,
  revLimitRpm: 6500,
  pulseDeg: 58,
  attackMs: [0.193, 0.096],
  cycleVar: 0.2,
  jitterDeg: 4,
  misfire: 0.035,
  idleLope: 55,
  diesel: false,
  exhaust: { pipeM: [1.9, 1.9], reflect: -0.5, loopHz: 3800, lowpassHz: 1500, bodyHz: 125, bodyDb: 3, rasp: 1.36, raspHz: 2400, gain: 0.5 },
  intake: { helmHz: 420, q: 2.4, pulse: 0.5, roar: 0.3, roarHz: 2800, gain: 0.22 },
  mech: { tick: 0.06, clatter: 0, clatterHz: [1900, 3300, 5000], whine: 0.008, whineOrder: 28, rattle: 0.35, rattleRpm: [1500, 2900] },
  turbo: null,
  pops: 0.35,
  bankBalance: 1,
  squealHz: 1050,
  crankRpm: 180,
  horn: { kind: 'sick', freqs: [372], level: 0.3, formantHz: 2100 },
};

/** Traffic sedan: the sedan's I6, lighter voice. */
export const SEDAN_TRAFFIC_ENGINE: EngineProfile = { ...SEDAN_ENGINE, id: 'sedanTraffic' };

export const ENGINE_PROFILES: Readonly<Record<string, EngineProfile>> = {
  sedan: SEDAN_ENGINE,
  coupe: COUPE_ENGINE,
  pickup: PICKUP_ENGINE,
  boxtruck: BOXTRUCK_ENGINE,
  beater: BEATER_ENGINE,
  sedanTraffic: SEDAN_TRAFFIC_ENGINE,
};

export function engineProfileFor(id: string): EngineProfile {
  return ENGINE_PROFILES[id] ?? SEDAN_ENGINE;
}

/** The profile with idle / redline / limiter from the vehicle's DrivetrainDef. */
export function withDrivetrain(p: EngineProfile, d: { idleRpm: number; redlineRpm: number; revLimitRpm: number } | null | undefined): EngineProfile {
  if (!d) return p;
  return { ...p, idleRpm: d.idleRpm, redlineRpm: d.redlineRpm, revLimitRpm: d.revLimitRpm };
}
