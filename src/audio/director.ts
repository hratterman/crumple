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
  play(kind: OneShotKind, x: number, y: number, z: number, gain: number, rate: number, refDistance: number, distance: number, now: number, delay?: number): boolean;
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

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function propSound(key: string | null): OneShotKind {
  switch (key) {
    case 'barrel':
      return 'clang';
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
      return 'hit';
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
  private readonly cdId = new Int32Array(COOLDOWN_SLOTS).fill(-1);
  private readonly cdLevel = new Float64Array(COOLDOWN_SLOTS);
  private readonly cdBreak = new Float64Array(COOLDOWN_SLOTS);
  private cdNext = 0;

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
    this.amb.pitch = pitchW;
    g.ambience.setInputs(this.amb, now);

    // ---- one-shot bank: build a little each frame until complete
    if (!g.oneShots.ready) g.oneShots.build(1.5);
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
    // body scrape: fast attack, 0.15 s release
    const sTarget = clamp01(Math.sqrt(this.acc.scrapePower) / 260);
    this.scrape = sTarget > this.scrape ? sTarget : this.scrape * Math.exp(-dt / 0.15);
    if (this.acc.scrapeSpeed > 0) this.scrapeSpeed += (this.acc.scrapeSpeed - this.scrapeSpeed) * Math.min(1, dt * 10);
    surf.scrape = this.scrape;
    surf.scrapeSpeed = this.scrapeSpeed;
    // suspension: wheel-load jumps (landings, kerbs) and hard tyre impacts → thumps / bump-stop knocks
    if (rate > 0) {
      const amp = Math.max(clamp01((maxJump - 2500) / 9000), clamp01((this.acc.tyreImpact - 15) / 140));
      if (amp > 0.06 && this.simClock - this.lastThump > 0.12) {
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
    this.cdLevel[i] = 0;
    this.cdBreak[i] = 0;
    return i;
  }

  private fireEvents(dt: number, now: number, pitchW: number): void {
    const acc = this.acc;
    const g = this.g;
    const shots = g.oneShots;
    const lpos = g.listener.pos;
    const decay = Math.exp(-dt / 0.22);
    for (let i = 0; i < COOLDOWN_SLOTS; i++) {
      this.cdLevel[i] = this.cdLevel[i]! * decay;
      this.cdBreak[i] = this.cdBreak[i]! * Math.exp(-dt / 0.6);
    }
    const p = this.pos;
    this.pitchW = pitchW;
    for (let b = 0; b < acc.count; b++) {
      const id = acc.id[b]!;
      acc.position(b, p);
      const dx = p[0]! - lpos[0]!;
      const dy = p[1]! - lpos[1]!;
      const dz = p[2]! - lpos[2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gain = crashGain(acc.impulse[b]!);
      const brk = acc.breaks[b]!;
      const slot = this.cooldownSlot(id);
      const fresh = gain > this.cdLevel[slot]! * 1.25 + 0.04;
      const ref = 4 + 10 * gain;
      if (id >= PROP_BASE) {
        if (fresh && gain > 0.03) {
          const kind = propSound(this.deps.propKey(id));
          shots.play(kind, p[0]!, p[1]!, p[2]!, 0.3 + 0.7 * gain, this.vr(), ref, dist, now);
          this.cdLevel[slot] = Math.max(this.cdLevel[slot]!, gain);
        }
        if (brk > 0 && this.cdBreak[slot]! < 0.5) {
          const kind = propSound(this.deps.propKey(id));
          shots.play(kind === 'clang' || kind === 'pole' ? 'snap' : kind, p[0]!, p[1]!, p[2]!, 0.6, this.vr() * 0.9, ref, dist, now);
          this.cdBreak[slot] = 1;
        }
        continue;
      }
      // vehicles (player, traffic, other rigs)
      if (fresh && gain > 0.03) {
        const mat = acc.material[b]!;
        const hardGround = mat === 0 || mat === 3 || mat === 5;
        if (gain < 0.3) {
          shots.play('hit', p[0]!, p[1]!, p[2]!, 0.2 + gain * 1.4, this.vr(), ref, dist, now);
          if (hardGround && gain > 0.12) shots.play('concrete', p[0]!, p[1]!, p[2]!, gain, this.vr(), ref, dist, now);
          this.noteCrash(gain, 'hit', now);
        } else {
          shots.play('thump', p[0]!, p[1]!, p[2]!, 0.4 + 0.6 * gain, this.vr(), ref, dist, now);
          shots.play('crunch', p[0]!, p[1]!, p[2]!, 0.45 + 0.55 * gain, this.vr(), ref, dist, now);
          if (hardGround) shots.play('concrete', p[0]!, p[1]!, p[2]!, 0.5 * gain, this.vr(), ref, dist, now);
          if (gain > 0.55) {
            shots.play('boom', p[0]!, p[1]!, p[2]!, gain, pitchW, ref * 1.5, dist, now);
            shots.play('crunch', p[0]!, p[1]!, p[2]!, 0.7 * gain, this.vr(), ref, dist, now, 0.06 / pitchW);
            // the hit takes the air out of everything else for a moment
            if (dist < 60) g.mix.duckTo(duckGain(gain), now);
          }
          this.noteCrash(gain, gain > 0.55 ? 'heavy' : 'crunch', now);
        }
        this.cdLevel[slot] = Math.max(this.cdLevel[slot]!, gain);
      }
      if (brk > 0) {
        const s = Math.min(1, 0.3 + 0.07 * brk);
        if (this.cdBreak[slot]! < s) {
          shots.play('snap', p[0]!, p[1]!, p[2]!, s, this.vr(), ref, dist, now);
          if (brk >= 3 && this.cdBreak[slot]! < 0.3) shots.play('debris', p[0]!, p[1]!, p[2]!, Math.min(1, 0.35 + 0.04 * brk), this.vr(), ref, dist, now, 0.18 / pitchW);
          this.cdBreak[slot] = Math.max(this.cdBreak[slot]!, s);
        }
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
      if (acc.glassShatter[k]) shots.play('glass', x, y, z, 0.85, this.vr(), 6, dist, now, 0.01);
      else shots.play('glassCrack', x, y, z, 0.55, this.vr(), 4, dist, now);
    }
  }

  private noteCrash(gain: number, kind: string, now: number): void {
    if (!this.lastCrash || gain >= this.lastCrash.gain || now - this.lastCrash.t > 1) this.lastCrash = { gain, kind, t: now };
  }
}

export const DIRECTOR_TRAFFIC_RANGE = [TRAFFIC_BASE, TRAFFIC_END] as const;
