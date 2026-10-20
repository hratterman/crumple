/**
 * AudioDirector (P8): the per-frame main-thread audio logic. Reads the
 * frame's telemetry / poses / aggregated events / replay state and writes
 * voice inputs, panner poses and one-shot triggers. Written against small
 * interfaces (DirectorGraph) so it runs headless in tests with fakes.
 *
 * Budget: ≤ 0.3 ms per frame, zero steady-state allocation (every buffer is
 * preallocated; params are only touched when they move — ParamSlot).
 *
 * TIME. `rate` = the presented time's speed: live = the sim timescale (0
 * paused, 0.25 slow-mo, 1), replay = playing ? speed : 0. The world bus is
 * silent at rate 0 (pause / replay paused); below 1× every voice is pitched
 * by slowMoPitch(rate) (rate^¾) and a cinematic low-pass closes; the crash
 * cam's ¼× gets a deeper pitch floor, a darker filter, more reverb and a
 * whoosh in. In replay the voices follow the PRESENTED frame (SimClient's
 * telemetry is the presented frame's), events arrive as frames are played
 * forward; seeks / reverse never fire one-shots.
 */
import { createAmbienceInput } from './dsp/ambience';
import { createEngineInput } from './dsp/engine';
import type { OneShotKind } from './dsp/oneshots';
import { createSurfaceInput } from './dsp/surface';
import { EventAccumulator } from './events';
import type { AmbienceIO, EngineVoiceIO, SurfaceVoiceIO } from './io';
import type { MixLevels } from './mix';
import { crashGain, dopplerFactor, duckGain, engineLoad, roarGain, scrubGain, slowMoLowpass, slowMoPitch, squealGain, squealPitch, windGain } from './params';
import { VoicePool } from './pool';
import { engineProfileFor, withDrivetrain, type EngineProfile } from './profiles';
import type { AudioDeps, AudioPlayerInfo } from './types';
import { createTrafficAgentFrame, TRAFFIC_FLAG_AWAKE, type TrafficAgentFrame } from '../protocol/traffic';
import type { BeamBreakEvent, ImpactEvent, SkidEvent } from '../protocol/events';

export interface SpatialLike {
  setPosition(x: number, y: number, z: number, now: number): void;
  setOrientation(x: number, y: number, z: number, now: number): void;
  setGain(g: number, now: number): void;
}
export interface MixLike {
  keepAlive(now: number): void;
  setLevels(l: Readonly<MixLevels>, now: number): void;
  setWorld(gain: number, lowpassHz: number, reverb: number, now: number): void;
  duckTo(g: number, now: number, recoverS?: number): void;
  relaxDuck(dt: number): void;
}
export interface ListenerLike {
  update(m: ArrayLike<number>, dt: number, now: number): void;
  readonly pos: Float64Array;
  readonly vel: Float64Array;
}
export interface OneShotsLike {
  play(kind: OneShotKind, x: number, y: number, z: number, gain: number, rate: number, refDistance: number, distance: number, now: number, delay?: number, variant?: number): boolean;
  playUi(kind: OneShotKind, gain: number, rate: number, now: number): boolean;
  stopAll(now: number): void;
  build(budgetMs: number): void;
  readonly ready: boolean;
  readonly active: number;
  readonly capacity: number;
  played: number;
  dropped: number;
}
export interface GhostVoiceLike {
  readonly spatial: SpatialLike;
  set(speed: number, engineHz: number, level: number, pitch: number, now: number): void;
}
export interface AwakeVoiceLike {
  readonly spatial: SpatialLike;
  readonly engine: EngineVoiceIO;
}
export interface DirectorGraph {
  mix: MixLike;
  listener: ListenerLike;
  engine: EngineVoiceIO;
  exhaust: SpatialLike;
  intake: SpatialLike;
  surface: SurfaceVoiceIO;
  tyres: SpatialLike;
  ambience: AmbienceIO;
  awake: readonly AwakeVoiceLike[];
  ghosts: readonly GhostVoiceLike[];
  oneShots: OneShotsLike;
}

const T_SPEED = 0;
const T_RPM = 1;
const T_GEAR = 2;
const T_THROTTLE = 3;
const T_COM = 16;
const T_VEL = 19;
const T_TORQUE = 22;
const T_DAMAGE = 23;
const T_AIRBORNE = 24;
const T_CONTACT = 31;
const SLIP = [8, 9, 10, 11];
const LOAD = [12, 13, 14, 15];

const PROP_BASE = 4096;
const TRAFFIC_BASE = 100;
const TRAFFIC_END = 164;
const STARTER_CRANK_S = 0.85;
const STARTER_CATCH_S = 0.75;
const MAX_AGENTS = 64;
const COOLDOWN_SLOTS = 32;
/** Suspension thump thresholds: per-frame wheel-load jump (N) and tyre impact (N·s). */
export const THUMP_LOAD_JUMP = 7000;
export const THUMP_TYRE_IMPULSE = 20;
/**
 * Crash gate (from recorded drives vs wall hits, see CONTRACTS "P8 audio as
 * built"): clean driving over bumps / off-road peaks at Δdamage 0.001 per
 * snapshot, normal-weighted body impulse 47 N·s, single events 19 N·s; a
 * 10 km/h wall tap already gives Δdamage 0.013 / 92 N·s.
 */
export const CRASH_DAMAGE_STEP = 0.004;
export const CRASH_IMPULSE_GATE = 80;
export const CRASH_EVENT_GATE = 12;

/** Crash level 0..1 of one object's frame (0 = not a crash). */
export function crashLevel(wImpulse: number, maxEvent: number, breaks: number, dDamage: number): number {
  const gate = dDamage >= CRASH_DAMAGE_STEP || (wImpulse >= CRASH_IMPULSE_GATE && maxEvent >= CRASH_EVENT_GATE) || breaks >= 2;
  if (!gate) return 0;
  const a = Math.pow(clamp01(dDamage / 0.05), 0.7);
  const b = Math.pow(clamp01((wImpulse - 60) / 900), 0.6);
  const c = clamp01(breaks / 12);
  return Math.max(0.08, a, b, c);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function propSound(key: string | null): OneShotKind {
  switch (key) {
    case 'barrel':
      return 'drum';
    case 'cone':
      return 'cone';
    case 'tire':
      return 'tire';
    case 'boxCardboard':
      return 'cardboard';
    case 'boxWood':
      return 'wood';
    case 'signPost':
    case 'lightPole':
      return 'pole';
    case 'concreteBlock':
      return 'concrete';
    default:
      return 'tap';
  }
}

export class AudioDirector {
  readonly acc = new EventAccumulator();
  private readonly g: DirectorGraph;
  private readonly deps: AudioDeps;
  private readonly eng = createEngineInput();
  private readonly surf = createSurfaceInput();
  private readonly amb = createAmbienceInput();
  private readonly levels: MixLevels = { master: 0.8, engine: 1, effects: 1, ambience: 1, muted: false };
  private profile: EngineProfile | null = null;
  private profileKey = '';
  private peakTorque = 400;
  private shiftTimeS = 0.25;
  private playerRef: AudioPlayerInfo | null = null;

  // ---- player state
  private simClock = 0;
  private lastGear = 0;
  private shiftUntil = -1;
  private starterT = -1;
  private pendingStart = false;
  private readonly fwd = new Float64Array([0, 0, -1]);
  private readonly hubTmp = new Float64Array(3);
  private readonly prevLoad = new Float64Array(4);
  private lastThump = -10;
  private loadPrimed = false;
  private thumpCount = 0;
  private scrape = 0;
  private scrapeSpeed = 0;
  private gravel = 0;
  private dirt = 0;
  private grass = 0;
  private dopPlayer = 1;
  private wasCrashCam = false;
  private ambT = 0;
  private readonly zoneOut = new Float64Array(4);
  private readonly pos = new Float64Array(3);

  // ---- traffic
  private readonly agents: TrafficAgentFrame[] = [];
  private readonly agentDist = new Float64Array(MAX_AGENTS);
  private readonly picked = new Uint8Array(MAX_AGENTS);
  private readonly awakePool: VoicePool<AwakeVoiceLike>;
  private readonly ghostPool: VoicePool<GhostVoiceLike>;
  private readonly awakeDop: Float64Array;
  private readonly ghostDop: Float64Array;

  // ---- one-shot cooldowns (per object id, decaying level)
  // per-object crash episodes (sim-time clock): see fireEvents
  private readonly cdId = new Int32Array(COOLDOWN_SLOTS).fill(-1);
  private readonly epUntil = new Float64Array(COOLDOWN_SLOTS);
  private readonly epPeak = new Float64Array(COOLDOWN_SLOTS);
  private readonly epCool = new Float64Array(COOLDOWN_SLOTS);
  private readonly epGrain = new Float64Array(COOLDOWN_SLOTS);
  private readonly epSnap = new Float64Array(COOLDOWN_SLOTS);
  private readonly epBreaks = new Float64Array(COOLDOWN_SLOTS);
  private readonly epDebris = new Uint8Array(COOLDOWN_SLOTS);
  private readonly lastDmg = new Float64Array(COOLDOWN_SLOTS);
  private cdNext = 0;
  private scrapeOcc = 0;
  private scrapeOn = false;
  private readonly playerPos = new Float64Array(3);
  private readonly vfArgs = new Float64Array(6);
  /** Crash one-shot triggers since start (episodes started, continuation grains) — tests / debug. */
  crashStarts = 0;
  crashGrains = 0;

  // ---- glass hook (chained into the player's damage FX sink)
  private prevFx: ((fx: { type: string; pos: ArrayLike<number> }) => void) | null = null;
  private readonly glassHook = (fx: { type: string; pos: ArrayLike<number> }): void => {
    this.prevFx?.(fx);
    if (fx.type === 'glassShatter') this.acc.onGlass(true, fx.pos[0]!, fx.pos[1]!, fx.pos[2]!);
    else if (fx.type === 'glassCrack') this.acc.onGlass(false, fx.pos[0]!, fx.pos[1]!, fx.pos[2]!);
  };

  // ---- stats (debug)
  rate = 1;
  pitch = 1;
  lowpass = 20000;
  worldGain = 1;
  frames = 0;
  lastCrash: { gain: number; kind: string; t: number } | null = null;
  private readonly unsubscribe: () => void;

  constructor(graph: DirectorGraph, deps: AudioDeps) {
    this.g = graph;
    this.deps = deps;
    this.acc.playerId = deps.playerObjectId;
    this.awakePool = new VoicePool(graph.awake);
    this.ghostPool = new VoicePool(graph.ghosts);
    this.awakeDop = new Float64Array(graph.awake.length).fill(1);
    this.ghostDop = new Float64Array(graph.ghosts.length).fill(1);
    for (let i = 0; i < MAX_AGENTS; i++) this.agents.push(createTrafficAgentFrame());
    this.unsubscribe = deps.replay.on((e) => {
      // a seek / enter / exit is a discontinuity: drop queued events and ringing one-shots
      if (e.type === 'seek' || e.type === 'enter' || e.type === 'exit') {
        this.acc.clear();
        this.acc.enabled = false;
        this.discontinuity = true;
      }
    });
  }
  private discontinuity = false;

  dispose(): void {
    this.unsubscribe();
  }

  onImpact(e: Readonly<ImpactEvent>): void {
    this.acc.onImpact(e);
  }
  onBeamBreak(e: Readonly<BeamBreakEvent>): void {
    this.acc.onBeamBreak(e);
  }
  onSkid(e: Readonly<SkidEvent>): void {
    this.acc.onSkid(e);
  }

  get engineState(): { rpm: number; load: number; pitch: number; limiter: boolean; crank: boolean; profile: string } {
    const e = this.eng;
    return { rpm: e.rpm, load: e.load, pitch: e.pitch, limiter: e.limiter >= 0.5, crank: e.crank >= 0.5, profile: this.profile ? this.profile.id : '' };
  }

  /** One frame. `now` = AudioContext.currentTime; `running` = the context is running. */
  update(dt: number, now: number, running: boolean): void {
    const deps = this.deps;
    const g = this.g;
    if (!running) {
      this.acc.clear();
      return;
    }
    this.frames++;
    // ---- presented-time rate, pitch, filters
    const rep = deps.replay;
    let rate: number;
    let forward: boolean;
    if (rep.active) {
      rate = rep.playing ? rep.speed : 0;
      forward = rep.playing && rep.direction > 0;
    } else {
      rate = deps.timeScale();
      forward = rate > 0;
    }
    const crashCam = rep.active && deps.crashCam();
    let pitchW = slowMoPitch(rate > 0 ? rate : 1);
    let lp = rate > 0 ? slowMoLowpass(rate) : 20000;
    let rev = rate > 0 && rate < 0.6 ? 0.2 : 0.05;
    if (crashCam) {
      pitchW = Math.min(pitchW, 0.4);
      lp = Math.min(lp, 1500);
      rev = 0.42;
      if (!this.wasCrashCam) g.oneShots.playUi('whoosh', 0.55, 0.85, now);
    }
    this.wasCrashCam = crashCam;
    this.rate = rate;
    this.pitch = pitchW;
    this.lowpass = lp;
    this.worldGain = rate > 0 ? 1 : 0;
    const s = deps.settings();
    const L = this.levels;
    L.master = s.volume;
    L.engine = s.engineVolume;
    L.effects = s.effectsVolume;
    L.ambience = s.ambienceVolume;
    L.muted = s.muted;
    g.mix.keepAlive(now);
    g.mix.setLevels(L, now);
    g.mix.setWorld(this.worldGain, lp, rev, now);
    g.mix.relaxDuck(dt);
    g.listener.update(deps.cameraMatrix(), dt, now);
    if (this.discontinuity) {
      this.discontinuity = false;
      g.oneShots.stopAll(now);
    }
    const simDt = dt * rate;
    this.simClock += simDt;

    this.updatePlayer(dt, simDt, now, pitchW, rate);
    this.updateTraffic(dt, now, pitchW, rate);
    if (forward) this.fireEvents(dt, now, pitchW);
    this.acc.clear();
    this.acc.enabled = forward;

    // ---- ambience (zones every 0.25 s)
    this.ambT -= dt;
    if (this.ambT <= 0) {
      this.ambT = 0.25;
      const lpos = g.listener.pos;
      deps.zones(lpos[0]!, lpos[2]!, this.zoneOut);
      const arena = this.zoneOut[0]!;
      const town = this.zoneOut[1]!;
      const lake = this.zoneOut[2]!;
      const h = this.zoneOut[3]!;
      const alt = clamp01((h - 40) / 120);
      const a = this.amb;
      a.birds = 0.8 * (1 - arena) * (1 - 0.45 * town) * (1 - 0.7 * alt);
      a.breeze = (0.35 + 0.5 * alt) * (1 - 0.45 * arena);
      a.crickets = 0.45 * (1 - arena) * (1 - 0.6 * town) * (1 - alt);
      a.water = 0.85 * lake;
    }
    if (this.ambT === 0.25 || this.amb.pitch !== pitchW) {
      this.amb.pitch = pitchW;
      g.ambience.setInputs(this.amb, now);
    }

    // ---- one-shot bank: build a little each frame until complete
    if (!g.oneShots.ready) g.oneShots.build(1);
  }

  private hookGlass(): void {
    const dmg = this.deps.playerDamage();
    if (!dmg) return;
    if (dmg.onFx !== this.glassHook) {
      // a new damage sink (swap) or the first frame: chain in front of it
      this.prevFx = dmg.onFx;
      dmg.onFx = this.glassHook;
    }
  }

  private setProfile(info: AudioPlayerInfo): void {
    const p = withDrivetrain(engineProfileFor(info.id), info.drivetrain);
    this.profile = p;
    this.g.engine.setProfile(p);
    let peak = 1;
    for (const [, tq] of info.drivetrain.torqueCurve) peak = Math.max(peak, tq);
    this.peakTorque = peak;
    this.shiftTimeS = info.drivetrain.shiftTimeS;
    this.surf.squealHz = p.squealHz;
    this.pendingStart = true;
    this.starterT = -1;
  }

  private updatePlayer(dt: number, simDt: number, now: number, pitchW: number, rate: number): void {
    const deps = this.deps;
    const g = this.g;
    const info = deps.player();
    if (info && (info !== this.playerRef || info.id !== this.profileKey)) {
      this.playerRef = info;
      this.profileKey = info.id;
      this.setProfile(info);
    }
    this.hookGlass();
    const tel = info ? deps.sim.telemetry(deps.playerObjectId) : null;
    const eng = this.eng;
    const surf = this.surf;
    const p = this.profile;
    if (!tel || !p || !info) {
      this.loadPrimed = false;
      eng.gate = 0;
      g.engine.setInputs(eng, now);
      surf.squealF = surf.squealR = surf.scrub = surf.roar = surf.wind = surf.scrape = 0;
      surf.gravel = surf.dirt = surf.grass = 0;
      g.surface.setInputs(surf, now);
      return;
    }
    const speed = tel[T_SPEED] ?? 0;
    const thr = tel[T_THROTTLE] ?? 0;
    let rpm = tel[T_RPM] ?? 0;
    const gear = Math.round(tel[T_GEAR] ?? 0);
    const cx = tel[T_COM]!;
    const cy = tel[T_COM + 1]!;
    const cz = tel[T_COM + 2]!;
    const vx = tel[T_VEL]!;
    const vy = tel[T_VEL + 1]!;
    const vz = tel[T_VEL + 2]!;
    const vmag = Math.sqrt(vx * vx + vy * vy + vz * vz);
    this.playerPos[0] = cx;
    this.playerPos[1] = cy;
    this.playerPos[2] = cz;
    this.acc.vx = vx;
    this.acc.vy = vy;
    this.acc.vz = vz;
    const contactBits = (tel[T_CONTACT] ?? 0) | 0;
    const airborne = (tel[T_AIRBORNE] ?? 0) >= 0.5;

    // ---- starter: on a new car (and the first time the sound comes on with the car parked)
    if (this.pendingStart && rate > 0) {
      this.pendingStart = false;
      if (Math.abs(speed) < 0.5 && thr < 0.1) this.starterT = 0;
    }
    let crank = 0;
    if (this.starterT >= 0) {
      if (Math.abs(speed) > 1.5 || thr > 0.2) this.starterT = -1;
      else {
        const t = this.starterT;
        if (t < STARTER_CRANK_S) {
          crank = 1;
          rpm = p.crankRpm * (0.85 + 0.15 * Math.sin(t * 2 * Math.PI * 5.5));
        } else if (t < STARTER_CRANK_S + STARTER_CATCH_S) {
          const u = t - STARTER_CRANK_S;
          rpm = Math.max(rpm, p.idleRpm * (1 + 0.75 * Math.exp(-u / 0.3) * Math.min(1, u / 0.08)));
        } else this.starterT = -1;
        if (this.starterT >= 0) this.starterT += simDt > 0 ? simDt : 0;
      }
    }
    // ---- gear change dip + limiter
    if (gear !== this.lastGear) {
      if (this.lastGear > 0 && gear > 0) this.shiftUntil = this.simClock + this.shiftTimeS;
      this.lastGear = gear;
    }
    const shifting = this.simClock < this.shiftUntil;
    let load = engineLoad(thr, tel[T_TORQUE] ?? 0, this.peakTorque);
    if (shifting) load *= 0.2;
    eng.rpm = rpm;
    eng.throttle = shifting ? thr * 0.3 : thr;
    eng.load = crank ? 0 : load;
    eng.gate = 1;
    eng.limiter = !crank && thr > 0.5 && rpm >= p.revLimitRpm * 0.985 ? 1 : 0;
    eng.crank = crank;
    eng.shift = shifting ? 1 : 0;
    eng.damage = tel[T_DAMAGE] ?? 0;

    // ---- pose: forward, exhaust / intake / tyre positions, Doppler
    if (!this.deps.playerForward(this.fwd) && vmag > 1) {
      this.fwd[0] = vx / vmag;
      this.fwd[1] = vy / vmag;
      this.fwd[2] = vz / vmag;
    }
    const fx = this.fwd[0]!;
    const fy = this.fwd[1]!;
    const fz = this.fwd[2]!;
    const lpos = g.listener.pos;
    const lvel = g.listener.vel;
    const dop = dopplerFactor(cx, cy, cz, vx * rate, vy * rate, vz * rate, lpos[0]!, lpos[1]!, lpos[2]!, lvel[0]!, lvel[1]!, lvel[2]!);
    this.dopPlayer += (dop - this.dopPlayer) * Math.min(1, dt * 6);
    eng.pitch = pitchW * this.dopPlayer;
    g.engine.setInputs(eng, now);
    const len = info.length;
    g.exhaust.setPosition(cx - fx * len * 0.45, cy - 0.25, cz - fz * len * 0.45, now);
    g.exhaust.setOrientation(-fx, -fy, -fz, now);
    g.exhaust.setGain(1, now);
    g.intake.setPosition(cx + fx * len * 0.3, cy + 0.15, cz + fz * len * 0.3, now);
    g.intake.setGain(1, now);
    g.tyres.setPosition(cx, cy - 0.3, cz, now);
    g.tyres.setGain(1, now);

    // ---- tyres: squeal per axle on hard ground, rumble on soft
    const mat = this.deps.materialAt(cx, cz);
    const hard = mat === 0 || mat === 3 || mat === 5 || mat === 6;
    let sqF = 0;
    let sqR = 0;
    let pF = 1;
    let pR = 1;
    let maxSlip = 0;
    let maxJump = 0;
    for (let c = 0; c < 4; c++) {
      const inContact = (contactBits & (1 << c)) !== 0;
      const slip = tel[SLIP[c]!] ?? 0;
      const ld = tel[LOAD[c]!] ?? 0;
      const jump = this.loadPrimed ? ld - this.prevLoad[c]! : 0;
      if (jump > maxJump) maxJump = jump;
      this.prevLoad[c] = ld;
      if (!inContact) continue;
      if (slip > maxSlip) maxSlip = slip;
      const sg = squealGain(slip, ld);
      if (c < 2) {
        if (sg > sqF) {
          sqF = sg;
          pF = squealPitch(slip, ld);
        }
      } else if (sg > sqR) {
        sqR = sg;
        pR = squealPitch(slip, ld);
      }
    }
    this.loadPrimed = true;
    const anyContact = contactBits !== 0 && !airborne;
    const ground = Math.abs(speed);
    surf.pitch = pitchW * this.dopPlayer;
    surf.speed = ground;
    surf.squealF = hard ? sqF : 0;
    surf.squealR = hard ? sqR : 0;
    surf.squealPitchF = pF;
    surf.squealPitchR = pR;
    surf.scrub = hard && anyContact ? scrubGain(maxSlip) : 0;
    surf.roar = anyContact ? roarGain(ground) * (hard ? 1 : 0.45) : 0;
    surf.roarTone = mat === 5 ? 0.6 : mat === 3 ? 0.4 : 0;
    const k = Math.min(1, dt * 7);
    const soft = anyContact ? clamp01(ground / 14) * 0.85 + clamp01(maxSlip / 8) * 0.5 : 0;
    this.gravel += ((mat === 4 ? soft : 0) - this.gravel) * k;
    this.dirt += ((mat === 2 ? soft : 0) - this.dirt) * k;
    this.grass += ((mat === 1 ? soft : 0) - this.grass) * k;
    surf.gravel = this.gravel;
    surf.dirt = this.dirt;
    surf.grass = this.grass;
    // body scrape: only a SUSTAINED sliding body contact (occupancy with hysteresis) — bumps that
    // ground the underbody for a snapshot or two are not a scrape (recorded drives: ~50 such
    // snapshots per 30 s off-road)
    const scraping = this.acc.scrapeEvents > 0 ? 1 : 0;
    this.scrapeOcc += (scraping - this.scrapeOcc) * Math.min(1, dt / 0.3);
    if (this.scrapeOcc > 0.6) this.scrapeOn = true;
    else if (this.scrapeOcc < 0.3) this.scrapeOn = false;
    const powerRate = this.acc.scrapePower / Math.max(simDt, 1 / 120);
    const sTarget = this.scrapeOn ? clamp01(Math.sqrt(powerRate) / 2500) : 0;
    this.scrape += (sTarget - this.scrape) * Math.min(1, dt / (sTarget > this.scrape ? 0.05 : 0.15));
    if (this.acc.scrapeSpeed > 0) this.scrapeSpeed += (this.acc.scrapeSpeed - this.scrapeSpeed) * Math.min(1, dt * 10);
    surf.scrape = this.scrape;
    surf.scrapeSpeed = this.scrapeSpeed;
    // suspension (the surface voice only): big wheel-load jumps (landings, hard kerb strikes) and
    // hard tyre impacts; ordinary bumps stay silent
    if (rate > 0) {
      const amp = Math.max(clamp01((maxJump - THUMP_LOAD_JUMP) / 12000), clamp01((this.acc.tyreImpact - THUMP_TYRE_IMPULSE) / 120));
      if (amp > 0.08 && this.simClock - this.lastThump > 0.25) {
        this.lastThump = this.simClock;
        surf.thumpAmp = amp;
        surf.thumpCount = ++this.thumpCount;
      }
    }
    // wind: the car's air rush, fading as the camera leaves it (trackside / heli)
    const dx = lpos[0]! - cx;
    const dy = lpos[1]! - cy;
    const dz = lpos[2]! - cz;
    const dcam = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const prox = dcam < 10 ? 1 : dcam > 60 ? 0.12 : 1 - ((dcam - 10) / 50) * 0.88;
    surf.wind = windGain(vmag) * prox;
    surf.windSpeed = vmag;
    g.surface.setInputs(surf, now);

    // player hubs → tyre classification of the next frame's events
    const nodes = this.deps.nodes();
    const ranges = this.deps.sim.objectRanges();
    let off = -1;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i]!.objectId === this.deps.playerObjectId) {
        off = ranges[i]!.nodeOffset;
        break;
      }
    }
    const acc = this.acc;
    acc.hubCount = 0;
    acc.hubRadius = info.wheelRadius;
    if (off >= 0) {
      const h = info.hubs;
      const n = Math.min(8, h.length >> 1);
      for (let w = 0; w < n; w++) {
        const a = 3 * (off + h[2 * w]!);
        const b = 3 * (off + h[2 * w + 1]!);
        if (b + 2 >= nodes.length) break;
        acc.hubs[3 * w] = (nodes[a]! + nodes[b]!) * 0.5;
        acc.hubs[3 * w + 1] = (nodes[a + 1]! + nodes[b + 1]!) * 0.5;
        acc.hubs[3 * w + 2] = (nodes[a + 2]! + nodes[b + 2]!) * 0.5;
        acc.hubCount = w + 1;
      }
    }
  }

  private updateTraffic(dt: number, now: number, pitchW: number, rate: number): void {
    const g = this.g;
    if (g.awake.length === 0 && g.ghosts.length === 0) return;
    const deps = this.deps;
    const caps = deps.trafficVoices();
    const n = Math.min(MAX_AGENTS, deps.sim.readTrafficAgents(deps.sim.renderTime(), this.agents));
    const lpos = g.listener.pos;
    const lvel = g.listener.vel;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i]!;
      const dx = a.pos[0] - lpos[0]!;
      const dy = a.pos[1] - lpos[1]!;
      const dz = a.pos[2] - lpos[2]!;
      this.agentDist[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.picked[i] = 0;
    }
    // nearest awake cars (≤ caps.awake within 140 m) and ghosts (≤ caps.ghosts within 100 m)
    for (let pass = 0; pass < 2; pass++) {
      const awake = pass === 0;
      const cap = Math.min(awake ? caps.awake : caps.ghosts, awake ? g.awake.length : g.ghosts.length);
      const maxD = awake ? 140 : 100;
      for (let c = 0; c < cap; c++) {
        let best = -1;
        for (let i = 0; i < n; i++) {
          if (this.picked[i]) continue;
          const a = this.agents[i]!;
          const isAwake = (a.flags & TRAFFIC_FLAG_AWAKE) !== 0 && a.objectId > 0;
          if (isAwake !== awake || this.agentDist[i]! > maxD) continue;
          if (best < 0 || this.agentDist[i]! < this.agentDist[best]!) best = i;
        }
        if (best < 0) break;
        this.picked[best] = awake ? 1 : 2;
      }
    }
    this.pickedAgent.fill(0);
    for (let i = 0; i < n; i++) if (this.picked[i]) this.pickedAgent[this.agents[i]!.agent & (MAX_AGENTS - 1)] = this.picked[i]!;
    this.awakePool.releaseUnless(this.keepAwake);
    this.ghostPool.releaseUnless(this.keepGhost);
    for (let i = 0; i < n; i++) {
      const kind = this.picked[i]!;
      if (kind === 0) continue;
      const a = this.agents[i]!;
      const pool = kind === 1 ? this.awakePool : this.ghostPool;
      const v = pool.acquire(a.agent & (MAX_AGENTS - 1), 1 / (1 + this.agentDist[i]!));
      if (v < 0) continue;
      // forward from the record quat: R·(0, 0, −1)
      const q = a.quat;
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const qw = q[3];
      const fx = -(2 * (qx * qz + qw * qy));
      const fy = -(2 * (qy * qz - qw * qx));
      const fz = -(1 - 2 * (qx * qx + qy * qy));
      const sp = a.speed * rate;
      const dop = dopplerFactor(a.pos[0], a.pos[1], a.pos[2], fx * sp, fy * sp, fz * sp, lpos[0]!, lpos[1]!, lpos[2]!, lvel[0]!, lvel[1]!, lvel[2]!);
      const dops = kind === 1 ? this.awakeDop : this.ghostDop;
      dops[v] = dops[v]! + (dop - dops[v]!) * Math.min(1, dt * 8);
      const pitch = pitchW * dops[v]!;
      if (kind === 1) {
        const voice = g.awake[v]!;
        const tel = deps.sim.telemetry(a.objectId);
        const ti = this.trafficInput;
        ti.rpm = tel ? (tel[T_RPM] ?? 900) : 900;
        ti.throttle = tel ? (tel[T_THROTTLE] ?? 0) : 0;
        ti.load = tel ? engineLoad(ti.throttle, tel[T_TORQUE] ?? 0, 350) : 0.2;
        ti.gate = 1;
        ti.pitch = pitch;
        ti.damage = tel ? (tel[T_DAMAGE] ?? 0) : 0;
        voice.engine.setInputs(ti, now);
        voice.spatial.setPosition(a.pos[0], a.pos[1] + 0.5, a.pos[2], now);
        voice.spatial.setGain(0.8, now);
      } else {
        const voice = g.ghosts[v]!;
        const spd = Math.abs(a.speed);
        // a plausible cruising rpm from road speed (5-speed-ish), I6 firing
        const rpm = 850 + ((spd * 3.6) % 38) * 45 + Math.min(spd, 30) * 25;
        voice.set(spd, (rpm / 60) * 3, clamp01(0.25 + spd / 30), pitch, now);
        voice.spatial.setPosition(a.pos[0], a.pos[1] + 0.4, a.pos[2], now);
        voice.spatial.setGain(0.7, now);
      }
    }
    // silence released voices
    for (let v = 0; v < g.awake.length; v++) {
      if (this.awakePool.ownerOf(v) >= 0) continue;
      this.trafficOff.pitch = pitchW;
      g.awake[v]!.engine.setInputs(this.trafficOff, now);
      g.awake[v]!.spatial.setGain(0, now);
    }
    for (let v = 0; v < g.ghosts.length; v++) {
      if (this.ghostPool.ownerOf(v) >= 0) continue;
      g.ghosts[v]!.spatial.setGain(0, now);
    }
  }
  private readonly trafficInput = createEngineInput();
  private readonly pickedAgent = new Uint8Array(MAX_AGENTS);
  private readonly keepAwake = (key: number): boolean => this.pickedAgent[key] === 1;
  private readonly keepGhost = (key: number): boolean => this.pickedAgent[key] === 2;
  private pitchW = 1;
  private vr(): number {
    return this.pitchW * (0.94 + 0.12 * Math.random());
  }
  private readonly trafficOff = (() => {
    const e = createEngineInput();
    e.gate = 0;
    return e;
  })();

  private cooldownSlot(id: number): number {
    for (let i = 0; i < COOLDOWN_SLOTS; i++) if (this.cdId[i] === id) return i;
    const i = this.cdNext;
    this.cdNext = (this.cdNext + 1) % COOLDOWN_SLOTS;
    this.cdId[i] = id;
    this.epUntil[i] = -1;
    this.epPeak[i] = 0;
    this.epCool[i] = -1;
    this.epGrain[i] = -1;
    this.epSnap[i] = -1;
    this.epBreaks[i] = 0;
    this.epDebris[i] = 0;
    this.lastDmg[i] = NaN;
    return i;
  }

  /** Δdamage of a vehicle since its last check (telemetry slot 23); 0 without telemetry or after a repair. */
  private damageStep(slot: number, id: number): number {
    const tel = this.deps.sim.telemetry(id);
    if (!tel) return 0;
    const d = tel[T_DAMAGE] ?? 0;
    const prev = this.lastDmg[slot]!;
    this.lastDmg[slot] = d;
    return prev !== prev || d < prev ? 0 : d - prev;
  }

  private playAt(kind: OneShotKind, p: Float64Array, gain: number, ref: number, dist: number, now: number, delay = 0, variant = -1, rate = -1): void {
    this.g.oneShots.play(kind, p[0]!, p[1]!, p[2]!, gain, rate > 0 ? rate : this.vr(), ref, dist, now, delay, variant);
  }

  /**
   * One vehicle's frame: a CRASH needs real deformation (Δdamage), a hard
   * horizontal body hit or beam breaks (crashLevel). A crash opens an
   * EPISODE (0.25 + 1.25·level s of sim time): body thud + crunch, a rolling
   * crumple whose length follows the level, a sub boom and a duck for heavy
   * ones, a damped clang only for metal-on-metal. While the episode lasts,
   * further deformation / breaks add short crunch grains (≥ 90 ms apart): a
   * big crash rolls for 0.5–1.5 s. After it, a 0.35 s cool-down; only a
   * clearly bigger hit (1.6× the peak) restarts it early.
   */
  private vehicleFrame(slot: number, brk: number, mat: number, p: Float64Array): void {
    // doubles travel through a scratch array: a non-inlined call boxes double arguments (allocation per frame)
    const a = this.vfArgs;
    const E = a[0]!;
    const maxJ = a[1]!;
    const dd = a[2]!;
    const dist = a[3]!;
    const now = a[4]!;
    const pitchW = a[5]!;
    const t = this.simClock;
    const g = crashLevel(E, maxJ, brk, dd);
    const active = t < this.epUntil[slot]!;
    const ref = 5 + 10 * Math.max(g, this.epPeak[slot]!);
    if (g > 0 && ((!active && t >= this.epCool[slot]!) || g > this.epPeak[slot]! * 1.6 + 0.1)) {
      this.epPeak[slot] = g;
      this.epUntil[slot] = t + 0.25 + 1.25 * g;
      this.epCool[slot] = this.epUntil[slot]! + 0.35;
      this.epGrain[slot] = t;
      this.epBreaks[slot] = 0;
      this.epDebris[slot] = 0;
      this.crashStarts++;
      this.playAt('thump', p, 0.45 + 0.55 * g, ref, dist, now);
      if (g < 0.22) this.playAt('tap', p, 0.45 + g, ref, dist, now);
      else {
        this.playAt('crunch', p, 0.5 + 0.45 * g, ref, dist, now);
        if (g >= 0.4) this.playAt('crumple', p, 0.45 + 0.5 * g, ref, dist, now, 0.02 / pitchW, Math.min(3, Math.floor((g - 0.4) / 0.15)));
      }
      if (g >= 0.6) {
        this.playAt('boom', p, 0.9 * g, ref * 1.5, dist, now, 0, -1, pitchW);
        if (dist < 60) this.g.mix.duckTo(duckGain(g), now);
      }
      if (mat === 6 && g >= 0.2) this.playAt('clang', p, 0.4 * g, ref, dist, now);
      this.noteCrash(g, g >= 0.6 ? 'heavy' : g >= 0.22 ? 'crunch' : 'tap', now);
    } else if (active && (dd > 0.0015 || brk > 0 || E >= CRASH_IMPULSE_GATE) && t - this.epGrain[slot]! >= 0.09) {
      // the crash keeps crumpling
      this.epGrain[slot] = t;
      this.crashGrains++;
      this.playAt('crunch', p, Math.min(0.9, 0.25 + 0.6 * clamp01(dd / 0.03 + brk / 10 + E / 1500)), ref, dist, now);
    }
    if (brk > 0) {
      this.epBreaks[slot] = this.epBreaks[slot]! + brk;
      if (t - this.epSnap[slot]! >= 0.07) {
        this.epSnap[slot] = t;
        this.playAt('snap', p, Math.min(1, 0.3 + 0.06 * brk), ref, dist, now);
        if (brk >= 3) this.playAt('plastic', p, Math.min(0.9, 0.3 + 0.05 * brk), ref, dist, now);
      }
      if (this.epBreaks[slot]! >= 4 && !this.epDebris[slot]) {
        this.epDebris[slot] = 1;
        this.playAt('debris', p, Math.min(1, 0.4 + 0.03 * this.epBreaks[slot]!), ref, dist, now, 0.25 / pitchW);
      }
    }
  }

  private fireEvents(dt: number, now: number, pitchW: number): void {
    void dt;
    const acc = this.acc;
    const g = this.g;
    const shots = g.oneShots;
    const lpos = g.listener.pos;
    const p = this.pos;
    this.pitchW = pitchW;
    const t = this.simClock;
    let playerSeen = false;
    for (let b = 0; b < acc.count; b++) {
      const id = acc.id[b]!;
      acc.position(b, p);
      const dx = p[0]! - lpos[0]!;
      const dy = p[1]! - lpos[1]!;
      const dz = p[2]! - lpos[2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const brk = acc.breaks[b]!;
      const slot = this.cooldownSlot(id);
      if (id >= PROP_BASE) {
        // props: a real knock (one event ≥ 8 N·s, Σ ≥ 15), at most every 0.25 s unless clearly louder
        const J = acc.impulse[b]!;
        const lvl = Math.pow(clamp01((J - 10) / 300), 0.6);
        if (acc.maxImpulse[b]! >= 8 && J >= 15 && (t >= this.epCool[slot]! || lvl > this.epPeak[slot]! * 1.6)) {
          this.epPeak[slot] = lvl;
          this.epCool[slot] = t + 0.25;
          this.playAt(propSound(this.deps.propKey(id)), p, 0.3 + 0.7 * lvl, 4 + 8 * lvl, dist, now);
        }
        if (brk > 0 && t - this.epSnap[slot]! >= 0.3) {
          this.epSnap[slot] = t;
          const kind = propSound(this.deps.propKey(id));
          this.playAt(kind === 'drum' || kind === 'pole' ? 'snap' : kind, p, 0.6, 6, dist, now);
        }
        continue;
      }
      if (id === this.deps.playerObjectId) playerSeen = true;
      const va = this.vfArgs;
      va[0] = acc.wImpulse[b]!;
      va[1] = acc.maxImpulse[b]!;
      va[2] = this.damageStep(slot, id);
      va[3] = dist;
      va[4] = now;
      va[5] = pitchW;
      this.vehicleFrame(slot, brk, acc.material[b]!, p);
    }
    // the player deforming without an impact bucket this frame (damage lags its contacts by a snapshot)
    if (!playerSeen && this.profile) {
      const slot = this.cooldownSlot(this.deps.playerObjectId);
      const va = this.vfArgs;
      va[2] = this.damageStep(slot, this.deps.playerObjectId);
      if (va[2]! > 0) {
        p[0] = this.playerPos[0]!;
        p[1] = this.playerPos[1]!;
        p[2] = this.playerPos[2]!;
        const dx = p[0]! - lpos[0]!;
        const dy = p[1]! - lpos[1]!;
        const dz = p[2]! - lpos[2]!;
        va[0] = 0;
        va[1] = 0;
        va[3] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        va[4] = now;
        va[5] = pitchW;
        this.vehicleFrame(slot, 0, 0, p);
      }
    }
    for (let k = 0; k < acc.glassCount; k++) {
      const x = acc.glassPos[3 * k]!;
      const y = acc.glassPos[3 * k + 1]!;
      const z = acc.glassPos[3 * k + 2]!;
      const dx = x - lpos[0]!;
      const dy = y - lpos[1]!;
      const dz = z - lpos[2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (acc.glassShatter[k]) shots.play('glass', x, y, z, 0.8, this.vr(), 6, dist, now, 0.01);
      else shots.play('glassCrack', x, y, z, 0.5, this.vr(), 4, dist, now);
    }
  }

  private noteCrash(gain: number, kind: string, now: number): void {
    if (!this.lastCrash || gain >= this.lastCrash.gain || now - this.lastCrash.t > 1) this.lastCrash = { gain, kind, t: now };
  }
}

export const DIRECTOR_TRAFFIC_RANGE = [TRAFFIC_BASE, TRAFFIC_END] as const;
