/**
 * Challenge runtime (types.ts contract): a pure state machine advanced by
 * one ChallengeSample per live snapshot. No DOM, no three, no sim: the app
 * layer (src/app/challenges.ts) builds the samples, applies the set-up and
 * reads `state` / `drainEvents()` for the HUD; unit tests drive it with
 * synthetic samples.
 *
 * Flow: start(sample) → countdown (3 × COUNTDOWN_STEP_S of SIM time) → GO
 * (goTick / goSimTime = the first sample at or past the last step) →
 * running (evaluators per sample) → all goals met / a terminal event →
 * settling (clock frozen for 'time' scoring; the car settles for crush /
 * upright checks) → finished; any fail condition → failed at once.
 */
import { AirTracker, DriftScorer, fullTurns, GateTracker, resolveGate, RotationTracker, turnsOf, type JumpResult } from './eval/trackers';
import { inZone, toLocal, yawDiff, dirYaw } from './eval/geometry';
import { GhostRecorder } from './ghost';
import { formatScore, formatTime, medalFor } from './medals';
import {
  COUNTDOWN_STEP_S,
  DEFAULT_SETTLE_S,
  PARK_BASE,
  STUNT_AIR_POINTS,
  STUNT_HEIGHT_POINTS,
  STUNT_ROTATION_POINTS,
  type ChallengeDef,
  type ChallengeEvent,
  type ChallengeResult,
  type ChallengeRunState,
  type ChallengeSample,
  type GhostTrack,
  type ObjectiveDef,
  type ObjectiveStatus,
  type PopupKind,
  type ResultStat,
} from './types';

export interface RuntimeDeps {
  /** Terrain height (gate bases with y null). */
  groundAt(x: number, z: number): number;
  /** Vehicle id / palette driven this run (results, ghost). */
  vehicle: string;
  palette: string | null;
}

/** km/h ↔ m/s. */
const KMH = 3.6;
/** Pins: the run ends this long after the pin count last changed (once any pin is down). */
const PINS_SETTLE_S = 3;
/** Impact detection: a body impulse at least this large (N·s) is "the hit". */
const IMPACT_MIN_IMPULSE = 150;
/** Derby: moved less than this (m) within immobileS = out. */
const DERBY_MOVE_M = 1;
/** Smash popups aggregate destruction over this window (s). */
const SMASH_WINDOW_S = 0.6;

interface DerbyCar {
  id: number;
  out: boolean;
  damage: number;
  anchor: [number, number, number];
  anchorT: number;
  reason: string;
}

export class ChallengeRun {
  readonly def: ChallengeDef;
  readonly state: ChallengeRunState;
  result: ChallengeResult | null = null;
  /** The ghost of this run (recorded while running). */
  readonly ghost: GhostRecorder;
  goTick = -1;
  goSimTime = 0;

  private readonly deps: RuntimeDeps;
  private readonly events: ChallengeEvent[] = [];
  private cdStart = 0;
  private cdShown = 0;
  private settleUntil = -1;
  private frozenClock = -1;
  private prevT = 0;
  private readonly prevPos: [number, number, number] = [0, 0, 0];
  private hasPrev = false;
  private endTick = -1;
  private endSimTime = 0;

  // evaluators
  private readonly rotation = new RotationTracker();
  private readonly air: AirTracker;
  private readonly drift = new DriftScorer();
  private readonly gates: GateTracker | null;
  private bestJump: JumpResult | null = null;
  private endingJump: JumpResult | null = null;
  private rollsTotal = 0;
  private flipsTotal = 0;
  private stuntPoints = 0;
  private destruction = 0;
  private smashAcc = 0;
  private smashT = 0;
  private pins = 0;
  private pinsChangedT = -1;
  private pinsTotal = 0;
  private topSpeedKmh = 0;
  private distance = 0;
  private uprightBadT = -1;
  private outsideT = -1;
  private stopHoldT = -1;
  private parkHoldT = -1;
  private parkOffsetCm = 0;
  private parkYawErr = 0;
  private parked = false;
  private impactKmh = -1;
  private crushCm = 0;
  private derby: DerbyCar[] = [];
  private derbyKOs = 0;
  private derbyOutReason: string | null = null;
  private playerAnchor: [number, number, number] = [0, 0, 0];
  private playerAnchorT = 0;
  private lastSpeedKmh = 0;
  private reachedTop = false;
  private stopped = false;
  private lastUpY = 1;
  private goals: boolean[] = [];

  constructor(def: ChallengeDef, deps: RuntimeDeps) {
    this.def = def;
    this.deps = deps;
    const jump = def.objectives.find((o): o is Extract<ObjectiveDef, { type: 'jump' }> => o.type === 'jump');
    this.air = new AirTracker(jump?.minAirtimeS ?? 0.25);
    const g = def.objectives.find((o): o is Extract<ObjectiveDef, { type: 'gates' }> => o.type === 'gates');
    this.gates = g ? new GateTracker(g.gates.map((x) => resolveGate(x, deps.groundAt))) : null;
    this.pinsTotal = (def.props ?? []).filter((p) => def.objectives.some((o) => o.type === 'pins' && o.group === p.group)).length;
    this.ghost = new GhostRecorder(deps.vehicle, deps.palette);
    this.state = {
      phase: 'idle',
      clock: 0,
      countdown: 0,
      score: 0,
      scoreText: formatScore(0, def.scoring),
      objectives: [],
      nextGate: this.gates ? 0 : -1,
      combo: null,
      failReason: null,
    };
    this.refreshObjectives();
  }

  /** Events since the last drain (HUD / app). */
  drainEvents(): ChallengeEvent[] {
    if (this.events.length === 0) return EMPTY;
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  /** Start the countdown at this sample's sim time (call after the set-up snapshot arrived). */
  startCountdown(simTime: number): void {
    this.cdStart = simTime;
    this.cdShown = 0;
    this.setPhase('countdown');
  }

  /** Abort (quit / restart): no result. */
  abort(): void {
    this.setPhase('idle');
  }

  get running(): boolean {
    return this.state.phase === 'running';
  }

  get over(): boolean {
    return this.state.phase === 'finished' || this.state.phase === 'failed';
  }

  /** Recorded ghost (finished runs). */
  ghostTrack(): GhostTrack {
    return this.ghost.track();
  }

  // ------------------------------------------------------------ per sample
  onSample(s: Readonly<ChallengeSample>): void {
    if (!s.valid) return;
    const st = this.state;
    if (st.phase === 'countdown') {
      const k = Math.floor((s.simTime - this.cdStart) / COUNTDOWN_STEP_S);
      const n = 3 - k;
      if (n >= 1) {
        if (n !== this.cdShown) {
          this.cdShown = n;
          st.countdown = n;
          this.events.push({ type: 'countdown', n });
        }
        return;
      }
      this.go(s);
      return;
    }
    if (st.phase !== 'running') return;
    const t = s.simTime;
    const dt = this.hasPrev ? Math.max(0, t - this.prevT) : 0;
    const clock = t - this.goSimTime;
    st.clock = this.frozenClock >= 0 ? this.frozenClock : clock;
    this.recordGhost(s, clock);

    if (this.settleUntil < 0) this.evaluate(s, dt, clock);
    else this.settleSample(s);

    this.prevT = t;
    this.prevPos[0] = s.pos[0];
    this.prevPos[1] = s.pos[1];
    this.prevPos[2] = s.pos[2];
    this.hasPrev = true;
    this.lastUpY = s.up[1];

    if (st.phase !== 'running') return;
    if (this.settleUntil >= 0 && t >= this.settleUntil) this.finish(s);
    this.updateScore();
  }

  private go(s: Readonly<ChallengeSample>): void {
    const st = this.state;
    this.goTick = s.tick;
    this.goSimTime = s.simTime;
    st.countdown = 0;
    st.clock = 0;
    this.events.push({ type: 'countdown', n: 0 });
    this.setPhase('running');
    this.prevT = s.simTime;
    this.prevPos[0] = s.pos[0];
    this.prevPos[1] = s.pos[1];
    this.prevPos[2] = s.pos[2];
    this.hasPrev = true;
    this.playerAnchor = [s.pos[0], s.pos[1], s.pos[2]];
    this.playerAnchorT = s.simTime;
    this.derby = s.opponents.map((o) => ({ id: o.id, out: false, damage: 0, anchor: [o.pos[0], o.pos[1], o.pos[2]], anchorT: s.simTime, reason: '' }));
    this.rotation.update(s.forward, s.up, true, 0);
    this.recordGhost(s, 0);
  }

  private evaluate(s: Readonly<ChallengeSample>, dt: number, clock: number): void {
    const def = this.def;
    const t = s.simTime;
    const speedKmh = Math.hypot(s.vel[0], s.vel[1], s.vel[2]) * KMH;
    const onWheels = !s.bodyImpact && popcount(s.wheelContact) >= 3;
    let terminal = false;
    let settleS = 0;

    // ---- stunts: rotations, air, drift (always metered; scored by the metric)
    const seg = this.rotation.update(s.forward, s.up, onWheels, dt);
    if (seg) this.onRotation(seg.roll, seg.pitch);
    const jump = this.air.update(t, s.pos, s.airborne);
    if (jump) this.onJump(jump);
    const driftOn = def.objectives.some((o) => o.type === 'drift') || def.scoring.metric === 'stunt';
    if (driftOn) {
      const ev = this.drift.update(dt, s.vel, s.forward, s.wheelContact !== 0, s.bodyImpulse);
      if (ev) {
        if (ev.kind === 'bank') {
          if (ev.points >= 25) this.popup('drift', `DRIFT ×${ev.multiplier}`, `+${Math.round(ev.points).toLocaleString('en-US')}`, ev.points);
          if (def.scoring.metric === 'stunt') this.stuntPoints += ev.points;
        } else if (ev.points >= 25) this.popup('warn', ev.kind === 'spin' ? 'SPUN OUT' : 'DRIFT BROKEN', `−${Math.round(ev.points).toLocaleString('en-US')}`);
      }
    }
    // HUD combo meter
    if (this.drift.active) this.state.combo = { kind: 'drift', multiplier: this.drift.multiplier, points: this.drift.chainPoints * this.drift.multiplier };
    else if (this.air.inAir && this.air.airtime(t) > 0.35) this.state.combo = { kind: 'air', multiplier: 1, points: this.air.airtime(t) };
    else this.state.combo = null;

    // ---- distance / top speed
    if (this.hasPrev) this.distance += Math.hypot(s.pos[0] - this.prevPos[0], s.pos[1] - this.prevPos[1], s.pos[2] - this.prevPos[2]);
    // ---- destruction
    const hits = s.propHits + s.vehicleHits;
    if (hits > 0) {
      const scope = def.objectives.find((o): o is Extract<ObjectiveDef, { type: 'destruction' }> => o.type === 'destruction')?.scope ?? 'all';
      const pts = scope === 'props' ? s.propHits : scope === 'vehicles' ? s.vehicleHits : hits;
      this.destruction += pts;
      this.smashAcc += pts;
      if (this.smashT < 0 || this.smashT === 0) this.smashT = t;
    }
    if (this.smashAcc > 0 && t - this.smashT >= SMASH_WINDOW_S) {
      if (this.smashAcc >= 10 && def.objectives.some((o) => o.type === 'destruction')) this.popup('smash', 'SMASH', `+${Math.round(this.smashAcc)}`, this.smashAcc);
      this.smashAcc = 0;
      this.smashT = 0;
    }

    const sts = this.state;
    def.objectives.forEach((o, i) => {
      if (sts.phase !== 'running') return;
      switch (o.type) {
        case 'gates': {
          const g = this.gates!;
          if (this.hasPrev) {
            const c = g.update(this.prevT, this.prevPos, t, s.pos);
            if (c) {
              const split = c.time - this.goSimTime;
              this.events.push({ type: 'gate', index: c.index, count: g.gates.length, split, delta: null });
              this.state.nextGate = g.done ? -1 : g.next;
              if (g.done) {
                this.goals[i] = true;
                if (def.scoring.metric === 'time') this.frozenClock = split;
              }
            }
          }
          break;
        }
        case 'timeLimit':
          if (clock >= o.seconds) {
            if (o.onExpire === 'fail') this.fail('Out of time', s);
            else {
              this.goals[i] = true;
              terminal = true;
              this.frozenClock = o.seconds;
            }
          }
          break;
        case 'distance':
          if (this.distance >= o.meters) this.goals[i] = true;
          break;
        case 'jump':
          if (o.ends && this.endingJump) {
            this.goals[i] = true;
            settleS = Math.max(settleS, o.settleS ?? 2.5);
          }
          break;
        case 'topSpeed': {
          const inside = !o.zone || inZone(o.zone, s.pos[0], s.pos[2]);
          if (inside && speedKmh > this.topSpeedKmh) this.topSpeedKmh = speedKmh;
          if (inside && speedKmh >= o.kmh && !this.reachedTop) {
            this.reachedTop = true;
            this.goals[i] = true;
            this.popup('info', `${Math.round(speedKmh)} KM/H`, 'Target speed');
          }
          break;
        }
        case 'pins': {
          const n = s.pinsDown[o.group] ?? 0;
          if (n !== this.pins) {
            if (n > this.pins) {
              const total = this.pinsTotal;
              if (n >= total && total > 0) this.popup('smash', 'STRIKE!', `${n} / ${total}`, n);
              else this.popup('smash', `PINS ${n}`, `of ${total}`, n);
            }
            this.pins = n;
            this.pinsChangedT = t;
          }
          if (this.pins > 0 && (this.pins >= this.pinsTotal ? t - this.pinsChangedT >= 1.2 : t - this.pinsChangedT >= PINS_SETTLE_S)) {
            this.goals[i] = true;
            terminal = true;
          }
          break;
        }
        case 'damageCap':
          if (s.damage > o.max) this.fail('Too much damage', s);
          break;
        case 'upright':
          if (s.up[1] < 0.5) {
            if (this.uprightBadT < 0) this.uprightBadT = t;
            if (t - this.uprightBadT >= (o.graceS ?? 1.5)) this.fail('Rolled over', s);
          } else this.uprightBadT = -1;
          break;
        case 'bounds':
          if (!inZone(o.zone, s.pos[0], s.pos[2])) {
            if (this.outsideT < 0) this.outsideT = t;
            if (t - this.outsideT >= (o.graceS ?? 2)) this.fail('Left the course', s);
          } else this.outsideT = -1;
          break;
        case 'stopInZone': {
          const ok = inZone(o.zone, s.pos[0], s.pos[2]) && speedKmh < (o.maxKmh ?? 2);
          if (ok) {
            if (this.stopHoldT < 0) this.stopHoldT = t;
            if (t - this.stopHoldT >= (o.holdS ?? 1) && !this.stopped) {
              this.stopped = true;
              this.goals[i] = true;
              if (def.scoring.metric === 'time') this.frozenClock = this.stopHoldT - this.goSimTime;
            }
          } else this.stopHoldT = -1;
          break;
        }
        case 'park': {
          const m = this.parkMeasure(o, s);
          const ok = m.inside && m.yawErr <= (o.maxYawDeg ?? 12) && speedKmh < 1;
          if (ok) {
            if (this.parkHoldT < 0) this.parkHoldT = t;
            if (t - this.parkHoldT >= (o.holdS ?? 1.5) && !this.parked) {
              this.parked = true;
              this.goals[i] = true;
              this.parkOffsetCm = m.offsetCm;
              this.parkYawErr = m.yawErr;
              this.frozenClock = this.parkHoldT - this.goSimTime;
              this.popup('info', 'PARKED', `${Math.round(m.offsetCm)} cm · ${m.yawErr.toFixed(1)}°`);
            }
          } else this.parkHoldT = -1;
          break;
        }
        case 'impact': {
          if (this.impactKmh < 0 && s.bodyImpact && s.bodyImpulse >= IMPACT_MIN_IMPULSE) {
            this.impactKmh = this.lastSpeedKmh;
            if (this.impactKmh < o.minKmh) {
              this.popup('warn', `${Math.round(this.impactKmh)} KM/H`, `Need ${o.minKmh}`);
              this.fail(`Too slow: ${Math.round(this.impactKmh)} km/h`, s);
            } else {
              this.popup('smash', 'IMPACT', `${Math.round(this.impactKmh)} km/h`);
              this.goals[i] = true;
              settleS = Math.max(settleS, o.settleS ?? 2);
              terminal = true;
            }
          }
          break;
        }
        case 'derby':
          this.evalDerby(o, s, i);
          break;
        default:
          break;
      }
    });
    this.lastSpeedKmh = speedKmh;
    if (sts.phase !== 'running') return;
    this.crushCm = Math.max(this.crushCm, s.crushCm);

    // ---- completion
    let allGoals = true;
    let anyGoal = false;
    def.objectives.forEach((o, i) => {
      if (!isGoal(o)) return;
      anyGoal = true;
      if (!this.goals[i]) allGoals = false;
    });
    if ((anyGoal && allGoals) || terminal) {
      for (const o of def.objectives) {
        if (o.type === 'landUpright') settleS = Math.max(settleS, DEFAULT_SETTLE_S);
        if (o.type === 'gates' || o.type === 'park' || o.type === 'stopInZone') settleS = Math.max(settleS, 0.5);
      }
      if (this.frozenClock < 0) this.frozenClock = clock;
      this.settleUntil = t + settleS;
    }
    this.refreshObjectives();
  }

  /** While settling: keep metering crush / landing, nothing can fail except a landUpright check at the end. */
  private settleSample(s: Readonly<ChallengeSample>): void {
    const seg = this.rotation.update(s.forward, s.up, !s.bodyImpact && popcount(s.wheelContact) >= 3, Math.max(0, s.simTime - this.prevT));
    if (seg) this.onRotation(seg.roll, seg.pitch);
    const jump = this.air.update(s.simTime, s.pos, s.airborne);
    if (jump) this.onJump(jump);
    this.crushCm = s.crushCm;
  }

  private onJump(j: JumpResult): void {
    const def = this.def;
    const jo = def.objectives.find((o): o is Extract<ObjectiveDef, { type: 'jump' }> => o.type === 'jump');
    const counts = !jo || !jo.takeoff || inZone(jo.takeoff, j.takeoff[0], j.takeoff[2]);
    if (counts && jo) {
      if (!this.bestJump || j.distance > this.bestJump.distance) this.bestJump = j;
      if (jo.ends && !this.endingJump) this.endingJump = j;
    }
    if (def.scoring.metric === 'stunt') this.stuntPoints += STUNT_AIR_POINTS * j.airtime + STUNT_HEIGHT_POINTS * j.height;
    if (j.airtime >= 0.5) {
      const big = j.airtime >= 1.5;
      this.popup('air', `${big ? 'BIG AIR' : 'AIR'} ${j.airtime.toFixed(1)} s`, `${j.distance.toFixed(1)} m`, j.airtime);
    }
  }

  private onRotation(roll: number, pitch: number): void {
    const rolls = fullTurns(roll);
    const flips = fullTurns(pitch);
    this.rollsTotal += turnsOf(roll);
    this.flipsTotal += turnsOf(roll) + turnsOf(pitch);
    if (this.def.scoring.metric === 'stunt') this.stuntPoints += STUNT_ROTATION_POINTS * (rolls + flips);
    if (rolls >= 1) this.popup('flip', rolls === 1 ? 'BARREL ROLL' : `ROLL ×${rolls}`, `${Math.round((Math.abs(roll) * 180) / Math.PI)}°`, rolls);
    if (flips >= 1) {
      const name = pitch > 0 ? 'BACKFLIP' : 'FRONTFLIP';
      this.popup('flip', flips === 1 ? name : `${name} ×${flips}`, `${Math.round((Math.abs(pitch) * 180) / Math.PI)}°`, flips);
    }
    if (rolls === 0 && flips === 0 && turnsOf(roll) >= 0.5 && this.def.scoring.metric === 'rolls') this.popup('flip', `${turnsOf(roll)} ROLL`, 'Keep it turning');
  }

  private parkMeasure(o: Extract<ObjectiveDef, { type: 'park' }>, s: Readonly<ChallengeSample>): { inside: boolean; offsetCm: number; yawErr: number } {
    const b = o.bay;
    let inside = true;
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < 4; k++) {
      const x = s.hubs[2 * k]!;
      const z = s.hubs[2 * k + 1]!;
      cx += x / 4;
      cz += z / 4;
      const [lx, lz] = toLocal(b.center, b.yawDeg, x, z);
      if (Math.abs(lx) > b.halfWidth || Math.abs(lz) > b.halfLength) inside = false;
    }
    const carYaw = dirYaw(s.forward[0], s.forward[2]);
    let yawErr = yawDiff(carYaw, b.yawDeg);
    if (!o.oriented) yawErr = Math.min(yawErr, 180 - yawErr);
    const offsetCm = Math.hypot(cx - b.center[0], cz - b.center[1]) * 100;
    return { inside, offsetCm, yawErr };
  }

  private evalDerby(o: Extract<ObjectiveDef, { type: 'derby' }>, s: Readonly<ChallengeSample>, i: number): void {
    const t = s.simTime;
    // player
    if (Math.hypot(s.pos[0] - this.playerAnchor[0], s.pos[2] - this.playerAnchor[2]) >= DERBY_MOVE_M) {
      this.playerAnchor = [s.pos[0], s.pos[1], s.pos[2]];
      this.playerAnchorT = t;
    }
    // the player being knocked out ENDS the derby (scored as it stands): surviving is the score, not a pass mark
    const wrecked = s.damage >= (o.playerWreckDamage ?? o.wreckDamage);
    if (wrecked || t - this.playerAnchorT >= (o.playerImmobileS ?? o.immobileS)) {
      this.popup('warn', wrecked ? 'WRECKED' : 'STALLED OUT', `${this.derbyKOs} knock-out${this.derbyKOs === 1 ? '' : 's'}`);
      this.derbyOutReason = wrecked ? 'Wrecked' : 'Stalled out';
      this.goals[i] = true;
      return;
    }
    let alive = 0;
    for (const car of this.derby) {
      if (car.out) continue;
      const op = s.opponents.find((x) => x.id === car.id);
      let reason = '';
      if (!op || !op.present) reason = 'gone';
      else {
        if (Math.hypot(op.pos[0] - car.anchor[0], op.pos[2] - car.anchor[2]) >= DERBY_MOVE_M) {
          car.anchor = [op.pos[0], op.pos[1], op.pos[2]];
          car.anchorT = t;
        }
        car.damage = op.damage;
        if (op.damage >= o.wreckDamage) reason = 'wrecked';
        else if (op.upY < 0.3 && t - car.anchorT >= 2) reason = 'flipped';
        else if (t - car.anchorT >= o.immobileS) reason = 'stalled';
      }
      if (reason) {
        car.out = true;
        car.reason = reason;
        this.derbyKOs++;
        this.popup('smash', 'KNOCKOUT', `${this.derbyKOs} / ${this.derby.length}`, this.derbyKOs);
      } else alive++;
    }
    if (this.derby.length > 0 && alive === 0) {
      this.goals[i] = true;
      this.popup('info', 'LAST ONE MOVING', formatTime(s.simTime - this.goSimTime, 1));
    }
  }

  private fail(reason: string, s: Readonly<ChallengeSample>): void {
    const st = this.state;
    if (st.phase !== 'running') return;
    st.failReason = reason;
    this.endTick = s.tick;
    this.endSimTime = s.simTime;
    this.drift.bank();
    this.rotation.flush();
    this.updateScore();
    this.result = this.buildResult(false, reason);
    this.setPhase('failed');
    this.events.push({ type: 'finish', result: this.result });
  }

  private finish(s: Readonly<ChallengeSample>): void {
    const st = this.state;
    this.endTick = s.tick;
    this.endSimTime = s.simTime;
    const ev = this.drift.bank();
    if (ev && this.def.scoring.metric === 'stunt') this.stuntPoints += ev.points;
    const seg = this.rotation.flush();
    if (seg) this.onRotation(seg.roll, seg.pitch);
    this.crushCm = s.crushCm;
    this.updateScore();
    const lu = this.def.objectives.find((o): o is Extract<ObjectiveDef, { type: 'landUpright' }> => o.type === 'landUpright');
    let upright = true;
    if (lu) {
      upright = s.up[1] >= 0.5;
      if (!upright && lu.mode === 'require') {
        st.failReason = 'Not on its wheels';
        this.result = this.buildResult(false, st.failReason);
        this.setPhase('failed');
        this.events.push({ type: 'finish', result: this.result });
        return;
      }
      if (!upright) st.score *= lu.factor ?? 0.5;
      st.scoreText = formatScore(st.score, this.def.scoring);
    }
    this.uprightAtEnd = upright;
    this.result = this.buildResult(true, null);
    this.setPhase('finished');
    this.events.push({ type: 'finish', result: this.result });
  }

  private uprightAtEnd = true;

  private metricValue(): number {
    switch (this.def.scoring.metric) {
      case 'time':
        return this.frozenClock >= 0 ? this.frozenClock : this.state.clock;
      case 'jumpDistance':
        return (this.endingJump ?? this.bestJump)?.distance ?? 0;
      case 'airtime':
        return this.air.airtimeTotal;
      case 'rolls':
        return this.rollsTotal + (this.rotation.segment ? turnsOf(this.rotation.segment.roll) : 0);
      case 'flips':
        return this.flipsTotal;
      case 'crush':
        return this.crushCm;
      case 'pins':
        return this.pins;
      case 'drift':
        return this.drift.total;
      case 'destruction':
        return this.destruction;
      case 'stunt':
        return this.stuntPoints;
      case 'derby': {
        const d = this.def.objectives.find((x): x is Extract<ObjectiveDef, { type: 'derby' }> => x.type === 'derby');
        let dealt = 0;
        for (const c of this.derby) if (!c.out && d) dealt += Math.min(1, c.damage / d.wreckDamage) * 500;
        return this.derbyKOs * 1000 + Math.round(dealt) + Math.floor(this.state.clock) * 10;
      }
      case 'park':
        return this.parked ? Math.max(0, PARK_BASE - 4 * this.parkOffsetCm - 15 * this.parkYawErr - 10 * (this.frozenClock >= 0 ? this.frozenClock : this.state.clock)) : 0;
      case 'topSpeed':
        return this.topSpeedKmh;
    }
  }

  private updateScore(): void {
    const st = this.state;
    st.score = this.metricValue();
    st.scoreText = formatScore(st.score, this.def.scoring);
  }

  private buildResult(completed: boolean, failReason: string | null): ChallengeResult {
    const def = this.def;
    const st = this.state;
    const score = completed ? st.score : NaN;
    const stats: ResultStat[] = [];
    const time = this.frozenClock >= 0 ? this.frozenClock : st.clock;
    stats.push({ label: 'Time', value: `${formatTime(time)} s` });
    const has = (t: ObjectiveDef['type']): boolean => def.objectives.some((o) => o.type === t);
    if (this.gates) stats.push({ label: 'Gates', value: `${this.gates.next} / ${this.gates.gates.length}` });
    if (has('jump') || def.scoring.metric === 'stunt' || def.scoring.metric === 'airtime') {
      const j = this.endingJump ?? this.bestJump;
      if (j) {
        stats.push({ label: 'Jump', value: `${j.distance.toFixed(1)} m` });
        stats.push({ label: 'Airtime', value: `${j.airtime.toFixed(2)} s` });
        stats.push({ label: 'Height', value: `${j.height.toFixed(1)} m` });
      } else stats.push({ label: 'Airtime', value: `${this.air.airtimeTotal.toFixed(2)} s` });
    }
    if (def.scoring.metric === 'rolls' || def.scoring.metric === 'flips' || def.scoring.metric === 'stunt') {
      stats.push({ label: 'Rolls', value: String(this.rollsTotal) });
    }
    if (has('drift')) stats.push({ label: 'Best drift', value: `${Math.round(this.drift.bestChain).toLocaleString('en-US')} pts` });
    if (has('destruction')) stats.push({ label: 'Destruction', value: `${Math.round(this.destruction).toLocaleString('en-US')} pts` });
    if (has('pins')) stats.push({ label: 'Pins', value: `${this.pins} / ${this.pinsTotal}` });
    if (has('impact')) {
      stats.push({ label: 'Impact', value: this.impactKmh >= 0 ? `${Math.round(this.impactKmh)} km/h` : '—' });
      stats.push({ label: 'Crush', value: `${Math.round(this.crushCm)} cm` });
    }
    if (has('park') && this.parked) {
      stats.push({ label: 'Offset', value: `${Math.round(this.parkOffsetCm)} cm` });
      stats.push({ label: 'Angle', value: `${this.parkYawErr.toFixed(1)}°` });
    }
    if (has('derby')) {
      stats.push({ label: 'Knock-outs', value: `${this.derbyKOs} / ${this.derby.length}` });
      stats.push({ label: 'Survived', value: `${formatTime(time, 1)} s` });
      stats.push({ label: 'Ending', value: this.derbyOutReason ?? (this.derbyKOs === this.derby.length ? 'Last one moving' : 'Time up') });
    }
    if (has('topSpeed') || def.scoring.metric === 'topSpeed') stats.push({ label: 'Top speed', value: `${Math.round(this.topSpeedKmh)} km/h` });
    if (has('landUpright')) stats.push({ label: 'Landing', value: this.uprightAtEnd ? 'On its wheels' : 'Crash landing ×0.5' });
    return {
      id: def.id,
      completed,
      failReason,
      score,
      scoreText: completed ? st.scoreText : '—',
      medal: completed ? medalFor(score, def.medals, def.scoring.better) : 'none',
      time,
      stats,
      previousBest: null,
      isBest: false,
      vehicle: this.deps.vehicle,
      goTick: this.goTick,
      endTick: this.endTick,
      goSimTime: this.goSimTime,
      endSimTime: this.endSimTime,
    };
  }

  private recordGhost(s: Readonly<ChallengeSample>, clock: number): void {
    // frame quaternion from the basis [right, up, back] (rotation matrix columns)
    const f = s.forward;
    const u = s.up;
    const bx = -f[0];
    const by = -f[1];
    const bz = -f[2];
    const rx = u[1] * bz - u[2] * by;
    const ry = u[2] * bx - u[0] * bz;
    const rz = u[0] * by - u[1] * bx;
    // m = [[rx, ux, bx], [ry, uy, by], [rz, uz, bz]]
    const m00 = rx;
    const m11 = u[1];
    const m22 = bz;
    const tr = m00 + m11 + m22;
    let qx: number, qy: number, qz: number, qw: number;
    if (tr > 0) {
      const S = Math.sqrt(tr + 1) * 2;
      qw = 0.25 * S;
      qx = (u[2] - by) / S;
      qy = (bx - rz) / S;
      qz = (ry - u[0]) / S;
    } else if (m00 > m11 && m00 > m22) {
      const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
      qw = (u[2] - by) / S;
      qx = 0.25 * S;
      qy = (u[0] + ry) / S;
      qz = (bx + rz) / S;
    } else if (m11 > m22) {
      const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
      qw = (bx - rz) / S;
      qx = (u[0] + ry) / S;
      qy = 0.25 * S;
      qz = (by + u[2]) / S;
    } else {
      const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
      qw = (ry - u[0]) / S;
      qx = (bx + rz) / S;
      qy = (by + u[2]) / S;
      qz = 0.25 * S;
    }
    this.ghost.offer(clock, s.origin[0], s.origin[1], s.origin[2], qx, qy, qz, qw);
  }

  private popup(kind: PopupKind, text: string, sub?: string, points?: number): void {
    const e: ChallengeEvent = { type: 'popup', kind, text };
    if (sub !== undefined) e.sub = sub;
    if (points !== undefined) e.points = points;
    this.events.push(e);
  }

  private setPhase(p: ChallengeRunState['phase']): void {
    if (this.state.phase === p) return;
    this.state.phase = p;
    this.events.push({ type: 'phase', phase: p });
  }

  private refreshObjectives(): void {
    const def = this.def;
    const out: ObjectiveStatus[] = [];
    def.objectives.forEach((o, i) => {
      const text = this.objectiveText(o);
      if (!text) return;
      out.push({ index: i, type: o.type, text, done: !!this.goals[i], failed: false });
    });
    this.state.objectives = out;
  }

  private objectiveText(o: ObjectiveDef): string | null {
    switch (o.type) {
      case 'gates':
        return this.gates!.done ? 'Course complete' : `Gate ${this.gates!.next + 1} / ${this.gates!.gates.length}`;
      case 'timeLimit':
        return o.onExpire === 'fail' ? `Beat ${formatTime(o.seconds, 0)} s` : `${formatTime(o.seconds, 0)} s on the clock`;
      case 'distance':
        return `Travel ${Math.round(o.meters)} m`;
      case 'jump':
        return o.ends ? 'Jump as far as you can' : 'Catch air';
      case 'flips':
        return o.axis === 'roll' ? 'Roll it' : o.axis === 'pitch' ? 'Flip it' : 'Rotate it';
      case 'landUpright':
        return o.mode === 'require' ? 'Land on your wheels' : 'Land it clean (×0.5 if not)';
      case 'topSpeed':
        return `Reach ${o.kmh} km/h`;
      case 'drift':
        return 'Drift for points';
      case 'destruction':
        return 'Smash everything';
      case 'pins':
        return `Pins ${this.pins} / ${this.pinsTotal}`;
      case 'damageCap':
        return `Keep damage under ${Math.round(o.max * 100)} %`;
      case 'upright':
        return 'Stay on your wheels';
      case 'bounds':
        return null;
      case 'stopInZone':
        return 'Stop in the box';
      case 'park':
        return 'Park in the bay';
      case 'impact':
        return `Hit it at ${o.minKmh}+ km/h`;
      case 'derby':
        return `Last one moving · ${this.derby.length - this.derbyKOs} left`;
    }
  }
}

const EMPTY: ChallengeEvent[] = [];

function popcount(x: number): number {
  let n = x | 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

/** Objectives that must be met for a run to finish. */
export function isGoal(o: ObjectiveDef): boolean {
  switch (o.type) {
    case 'gates':
    case 'distance':
    case 'topSpeed':
    case 'stopInZone':
    case 'park':
    case 'impact':
    case 'derby':
      return true;
    case 'jump':
      return !!o.ends;
    case 'pins':
      return true;
    default:
      return false;
  }
}
