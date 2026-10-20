import { describe, expect, it } from 'vitest';

import { AirTracker, DriftScorer, fullTurns, GateTracker, resolveGate, RotationTracker, turnsOf } from './eval/trackers';
import { inZone, toLocal, yawDir } from './eval/geometry';
import { decodeGhost, decodeInputs, encodeGhost, encodeInputs, GhostRecorder, sampleGhost } from './ghost';
import { beats, formatScore, formatTime, medalFor, nextMedal, thresholdsOrdered } from './medals';
import { ChallengeRun } from './runtime';
import { loadStore, recordRun, saveStore, type StorageLike } from './storage';
import {
  CHALLENGE_STORAGE_KEY,
  DRIFT_CHAIN_GAP_S,
  DRIFT_POINTS_SCALE,
  type ChallengeDef,
  type ChallengeSample,
} from './types';

const DT = 1 / 120;

function sample(over: Partial<ChallengeSample> = {}): ChallengeSample {
  return {
    valid: true,
    tick: 0,
    simTime: 0,
    origin: [0, 0, 0],
    pos: [0, 0.5, 0],
    vel: [0, 0, 0],
    forward: [0, 0, -1],
    up: [0, 1, 0],
    speed: 0,
    airborne: false,
    wheelContact: 15,
    bodyImpact: false,
    bodyImpulse: 0,
    damage: 0,
    slip: 0,
    groundY: 0,
    crushCm: 0,
    hubs: [-0.8, -1.3, 0.8, -1.3, -0.8, 1.3, 0.8, 1.3],
    propHits: 0,
    vehicleHits: 0,
    pinsDown: {},
    opponents: [],
    ...over,
  };
}

/** Basis rotated by `angle` about the forward axis (roll; + = right side down) and pitch about right. */
function basis(roll: number, pitch = 0): { forward: [number, number, number]; up: [number, number, number] } {
  // start forward (0,0,-1), up (0,1,0), right (1,0,0); pitch about right then roll about forward
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const f: [number, number, number] = [0, sp, -cp];
  const u0: [number, number, number] = [0, cp, sp];
  const r: [number, number, number] = [1, 0, 0];
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // roll + = right side down: up tilts toward +right
  const u: [number, number, number] = [u0[0] * cr + r[0] * sr, u0[1] * cr + r[1] * sr, u0[2] * cr + r[2] * sr];
  return { forward: f, up: u };
}

describe('RotationTracker (flip counting)', () => {
  it('counts one full barrel roll in the air and closes the segment on the wheels', () => {
    const r = new RotationTracker();
    let seg = null;
    r.update([0, 0, -1], [0, 1, 0], true, DT);
    const steps = 120; // 1 s for 360°
    for (let i = 1; i <= steps; i++) {
      const b = basis((2 * Math.PI * i) / steps);
      seg = r.update(b.forward, b.up, false, DT) ?? seg;
    }
    expect(seg).toBeNull();
    for (let i = 0; i < 60; i++) seg = r.update([0, 0, -1], [0, 1, 0], true, DT) ?? seg;
    expect(seg).not.toBeNull();
    expect(seg!.roll).toBeCloseTo(2 * Math.PI, 2);
    expect(Math.abs(seg!.pitch)).toBeLessThan(1e-6);
    expect(fullTurns(seg!.roll)).toBe(1);
  });

  it('separates two rolls from a backflip and keeps signs', () => {
    const r = new RotationTracker();
    r.update([0, 0, -1], [0, 1, 0], true, DT);
    for (let i = 1; i <= 240; i++) {
      const b = basis(-(4 * Math.PI * i) / 240);
      r.update(b.forward, b.up, false, DT);
    }
    const seg = r.flush()!;
    expect(seg.roll).toBeCloseTo(-4 * Math.PI, 2);
    expect(fullTurns(seg.roll)).toBe(2);

    const p = new RotationTracker();
    p.update([0, 0, -1], [0, 1, 0], true, DT);
    for (let i = 1; i <= 150; i++) {
      const b = basis(0, (2 * Math.PI * i) / 150);
      p.update(b.forward, b.up, false, DT);
    }
    const s2 = p.flush()!;
    expect(s2.pitch).toBeCloseTo(2 * Math.PI, 2);
    expect(Math.abs(s2.roll)).toBeLessThan(1e-6);
  });

  it('counts quarter steps with a 30° tolerance; nothing while settled on wheels', () => {
    expect(turnsOf((330 * Math.PI) / 180)).toBe(1);
    expect(turnsOf((170 * Math.PI) / 180)).toBe(0.5);
    expect(turnsOf((50 * Math.PI) / 180)).toBe(0);
    expect(fullTurns((320 * Math.PI) / 180)).toBe(0);
    const r = new RotationTracker();
    for (let i = 0; i < 100; i++) {
      const b = basis(0.05 * Math.sin(i / 5)); // body roll on the wheels
      expect(r.update(b.forward, b.up, true, DT)).toBeNull();
    }
    expect(r.segment).toBeNull();
  });
});

describe('AirTracker (airtime / jump distance / height)', () => {
  it('measures a ballistic jump', () => {
    const a = new AirTracker(0.25);
    const v0 = [15, 5, 0];
    let jump = null;
    a.update(0, [0, 1, 0], false);
    let t = 0;
    for (let i = 1; ; i++) {
      t = i * DT;
      const y = 1 + v0[1]! * t - 4.905 * t * t;
      const air = y > 1;
      jump = a.update(t, [v0[0]! * t, Math.max(1, y), 0], air) ?? jump;
      if (!air && i > 2) break;
    }
    expect(jump).not.toBeNull();
    const T = (2 * v0[1]!) / 9.81;
    expect(jump!.airtime).toBeCloseTo(T, 1);
    expect(jump!.distance).toBeCloseTo(v0[0]! * T, 0);
    expect(jump!.height).toBeCloseTo((v0[1]! * v0[1]!) / (2 * 9.81), 1);
    expect(a.airtimeTotal).toBeCloseTo(jump!.airtime, 6);
  });

  it('ignores hops shorter than the minimum airtime', () => {
    const a = new AirTracker(0.25);
    a.update(0, [0, 0, 0], true);
    expect(a.update(0.1, [1, 0, 0], false)).toBeNull();
    expect(a.jumps).toBe(0);
  });
});

describe('DriftScorer', () => {
  const vel = (deg: number, speed: number): [number, number, number] => {
    const a = (deg * Math.PI) / 180; // velocity rotated from forward (0,0,-1)
    return [Math.sin(a) * speed, 0, -Math.cos(a) * speed];
  };

  it('scores angle × speed × duration with a combo multiplier, banked after the chain gap', () => {
    const d = new DriftScorer();
    let ev = null;
    const T = 3.2;
    for (let t = 0; t < T; t += DT) ev = d.update(DT, vel(30, 15), [0, 0, -1], true, 0) ?? ev;
    expect(ev).toBeNull();
    expect(d.multiplier).toBe(3); // 1 + floor(3.2 / 1.5)
    const raw = 30 * 15 * T * DRIFT_POINTS_SCALE;
    expect(d.chainPoints).toBeCloseTo(raw, -1);
    for (let t = 0; t < DRIFT_CHAIN_GAP_S + 0.05; t += DT) ev = d.update(DT, vel(0, 15), [0, 0, -1], true, 0) ?? ev;
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('bank');
    expect(ev!.multiplier).toBe(3);
    expect(d.banked).toBeCloseTo(raw * 3, -1);
  });

  it('is broken by contact and by a spin, and needs speed + angle', () => {
    const d = new DriftScorer();
    for (let t = 0; t < 1; t += DT) d.update(DT, vel(25, 12), [0, 0, -1], true, 0);
    const ev = d.update(DT, vel(25, 12), [0, 0, -1], true, 500);
    expect(ev!.kind).toBe('broken');
    expect(d.banked).toBe(0);
    for (let t = 0; t < 1; t += DT) d.update(DT, vel(25, 12), [0, 0, -1], true, 0);
    expect(d.update(DT, vel(150, 12), [0, 0, -1], true, 0)!.kind).toBe('spin');
    // too slow / too shallow / airborne: nothing
    for (let t = 0; t < 1; t += DT) {
      d.update(DT, vel(30, 5), [0, 0, -1], true, 0);
      d.update(DT, vel(6, 20), [0, 0, -1], true, 0);
      d.update(DT, vel(30, 20), [0, 0, -1], false, 0);
    }
    expect(d.total).toBe(0);
  });
});

describe('GateTracker (ordering + interpolated crossing)', () => {
  const ground = (): number => 0;
  const gates = [
    resolveGate({ pos: [0, null, -10], yawDeg: 0, width: 8 }, ground),
    resolveGate({ pos: [0, null, -30], yawDeg: 0, width: 8 }, ground),
    resolveGate({ pos: [-20, null, -40], yawDeg: 90, width: 8 }, ground),
  ];

  it('passes gates in order only, with the crossing time between snapshots', () => {
    const g = new GateTracker(gates);
    // crossing gate 2's plane first does nothing
    expect(g.update(0, [0, 1, -25], 0.1, [0, 1, -35])).toBeNull();
    const c = g.update(1, [0, 1, -9], 1.1, [0, 1, -11]);
    expect(c).toEqual({ index: 0, time: 1.05 });
    // outside the gate width: not counted
    expect(g.update(2, [7, 1, -29], 2.1, [7, 1, -31])).toBeNull();
    expect(g.update(2.2, [1, 1, -29.5], 2.3, [1, 1, -30.5])!.index).toBe(1);
    // backwards across gate 3 (travelling +X) does not count, forwards (−X) does
    expect(g.update(3, [-21, 1, -40], 3.1, [-19, 1, -40])).toBeNull();
    expect(g.update(4, [-19, 1, -40], 4.1, [-21, 1, -40])!.index).toBe(2);
    expect(g.done).toBe(true);
  });

  it('zones and local frames follow the yaw convention (0 = −Z, 90 = −X)', () => {
    expect(yawDir(0)[0]).toBeCloseTo(0);
    expect(yawDir(0)[1]).toBeCloseTo(-1);
    expect(yawDir(90)[0]).toBeCloseTo(-1);
    expect(inZone({ kind: 'rect', center: [10, 10], halfX: 2, halfZ: 5, yawDeg: 90 }, 14, 10)).toBe(true);
    expect(inZone({ kind: 'rect', center: [10, 10], halfX: 2, halfZ: 5, yawDeg: 90 }, 10, 14)).toBe(false);
    expect(inZone({ kind: 'circle', center: [0, 0], radius: 3 }, 2, 2)).toBe(true);
    const [lx, lz] = toLocal([0, 0], 0, 3, -4);
    expect(lx).toBeCloseTo(3);
    expect(lz).toBeCloseTo(-4);
  });
});

describe('medals', () => {
  it('awards by threshold in both directions and keeps crumple hidden', () => {
    const time = { bronze: 60, silver: 50, gold: 45, crumple: 42 };
    expect(medalFor(61, time, 'lower')).toBe('none');
    expect(medalFor(60, time, 'lower')).toBe('bronze');
    expect(medalFor(49.9, time, 'lower')).toBe('silver');
    expect(medalFor(44, time, 'lower')).toBe('gold');
    expect(medalFor(41, time, 'lower')).toBe('crumple');
    expect(medalFor(NaN, time, 'lower')).toBe('none');
    const pts = { bronze: 100, silver: 200, gold: 300, crumple: 400 };
    expect(medalFor(250, pts, 'higher')).toBe('silver');
    expect(medalFor(400, pts, 'higher')).toBe('crumple');
    expect(thresholdsOrdered(time, 'lower')).toBe(true);
    expect(thresholdsOrdered(pts, 'higher')).toBe(true);
    expect(thresholdsOrdered(pts, 'lower')).toBe(false);
    expect(nextMedal('silver', pts)).toEqual({ medal: 'gold', threshold: 300 });
    expect(nextMedal('gold', pts)).toBeNull();
    expect(nextMedal('gold', pts, true)).toEqual({ medal: 'crumple', threshold: 400 });
    expect(beats(40, 41, 'lower')).toBe(true);
    expect(beats(40, 41, 'higher')).toBe(false);
  });

  it('formats times and scores', () => {
    expect(formatTime(83.456)).toBe('1:23.46');
    expect(formatTime(9.5, 1)).toBe('9.5');
    expect(formatScore(83.456, { metric: 'time', unit: 's', decimals: 2 })).toBe('1:23.46');
    expect(formatScore(12345.6, { metric: 'drift', unit: 'pts', decimals: 0 })).toBe('12,346 pts');
    expect(formatScore(41.25, { metric: 'jumpDistance', unit: 'm', decimals: 1 })).toBe('41.3 m');
  });
});

describe('PB storage (crumple.challenges.v1)', () => {
  function memory(): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('records PBs, attempts and the best medal; survives malformed data and storage errors', () => {
    const s = memory();
    const store = loadStore(s);
    expect(store.records).toEqual({});
    const base = { id: 'hill', better: 'lower' as const, vehicle: 'sedan', build: 'x', at: '2026-01-01' };
    expect(recordRun(store, { ...base, score: 90, medal: 'bronze', completed: true, ghost: 'AAAA' })).toEqual({ previousBest: null, isBest: true });
    expect(recordRun(store, { ...base, score: 95, medal: 'none', completed: true })).toEqual({ previousBest: 90, isBest: false });
    expect(recordRun(store, { ...base, score: NaN, medal: 'none', completed: false })).toEqual({ previousBest: 90, isBest: false });
    expect(recordRun(store, { ...base, score: 80, medal: 'silver', completed: true })).toEqual({ previousBest: 90, isBest: true });
    expect(store.records.hill!.attempts).toBe(4);
    expect(store.records.hill!.bestMedal).toBe('silver');
    expect(store.records.hill!.ghost).toBeUndefined(); // the new PB carries its own (none here)
    expect(saveStore(store, s)).toBe(true);
    const back = loadStore(s);
    expect(back.records.hill!.best).toBe(80);

    s.data.set(CHALLENGE_STORAGE_KEY, '{not json');
    expect(loadStore(s).records).toEqual({});
    s.data.set(CHALLENGE_STORAGE_KEY, JSON.stringify({ version: 1, records: { a: { best: 'x' }, b: { best: 3, medal: 'gold' } } }));
    expect(Object.keys(loadStore(s).records)).toEqual(['b']);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadStore(throwing).records).toEqual({});
    expect(saveStore(store, throwing)).toBe(false);
    expect(loadStore(null).records).toEqual({});
  });

  it('drops other challenges’ ghosts when the quota is hit', () => {
    let calls = 0;
    const s: StorageLike = {
      getItem: () => null,
      setItem: (_k, v) => {
        calls++;
        if (v.includes('BIGGHOST')) throw new Error('quota');
      },
    };
    const store = { version: 1 as const, records: { a: { best: 1, medal: 'gold' as const, bestMedal: 'gold' as const, at: '', vehicle: '', build: '', attempts: 1, ghost: 'BIGGHOST' }, b: { best: 2, medal: 'none' as const, bestMedal: 'none' as const, at: '', vehicle: '', build: '', attempts: 1, ghost: 'g' } } };
    expect(saveStore(store, s, 'b')).toBe(true);
    expect(calls).toBe(2);
    expect(store.records.a.ghost).toBeUndefined();
    expect((store.records.b as { ghost?: string }).ghost).toBe('g');
  });
});

describe('ghost tracks', () => {
  it('records at 30 Hz, round-trips through base64 and samples smoothly', () => {
    const rec = new GhostRecorder('sedan', 'red');
    for (let i = 0; i <= 240; i++) {
      const t = i / 120;
      const a = t * 0.5;
      rec.offer(t, t * 10, 1, -t * 5, 0, Math.sin(a / 2), 0, Math.cos(a / 2));
    }
    expect(rec.count).toBe(61);
    const g = decodeGhost(encodeGhost(rec.track()))!;
    expect(g.vehicle).toBe('sedan');
    expect(g.palette).toBe('red');
    expect(g.count).toBe(61);
    const p = [0, 0, 0];
    const q = [0, 0, 0, 1];
    expect(sampleGhost(g, 1.0, p, q)).toBe(true);
    expect(p[0]).toBeCloseTo(10, 0);
    expect(p[2]).toBeCloseTo(-5, 0);
    expect(q[1]).toBeCloseTo(Math.sin(0.25), 2);
    expect(decodeGhost('garbage')).toBeNull();
    const nullPal = decodeGhost(encodeGhost({ ...rec.track(), palette: null }))!;
    expect(nullPal.palette).toBeNull();
  });

  it('slices the PB input log relative to GO', () => {
    const log = {
      count: 4,
      tick: new Uint32Array([10, 120, 130, 900]),
      objectId: new Uint32Array([1, 1, 100, 1]),
      action: new Uint8Array([0, 2, 0, 1]),
      value: new Float64Array([1, -0.5, 1, 0.25]),
    };
    const s = encodeInputs(log, 1, 100, 1000)!;
    expect(decodeInputs(s)).toEqual([
      { tick: 20, action: 2, value: -0.5 },
      { tick: 800, action: 1, value: 0.25 },
    ]);
  });
});

describe('ChallengeRun', () => {
  const ground = { groundAt: () => 0, vehicle: 'sedan', palette: null };
  const base = {
    blurb: '',
    brief: '',
    where: '',
    icon: 'climb' as const,
    vehicle: { kind: 'choice' as const },
    spawn: { pos: [0, null, 0] as const, yawDeg: 0 },
  };

  function drive(run: ChallengeRun, from: number, to: number, f: (t: number, s: ChallengeSample) => void): number {
    let t = from;
    for (; t < to && !run.over; t += DT) {
      const s = sample({ tick: Math.round(t * 2000), simTime: t });
      f(t, s);
      run.onSample(s);
    }
    return t;
  }

  it('counts down, times a gate course from GO and awards the medal', () => {
    const def: ChallengeDef = {
      ...base,
      id: 'sprint',
      name: 'Sprint',
      objectives: [
        { type: 'gates', gates: [{ pos: [0, null, -50], yawDeg: 0 }, { pos: [0, null, -100], yawDeg: 0 }] },
        { type: 'timeLimit', seconds: 30, onExpire: 'fail' },
      ],
      scoring: { metric: 'time', better: 'lower', unit: 's', decimals: 2 },
      medals: { bronze: 20, silver: 12, gold: 10.5, crumple: 9 },
    };
    const run = new ChallengeRun(def, ground);
    run.startCountdown(0);
    const digits: number[] = [];
    let go = 0;
    drive(run, 0, 3, (t, s) => {
      s.pos = [0, 0.5, 0];
      for (const e of run.drainEvents()) if (e.type === 'countdown') digits.push(e.n);
      if (run.running && go === 0) go = t;
    });
    expect(digits.slice(0, 3)).toEqual([3, 2, 1]);
    expect(run.state.phase).toBe('running');
    const t0 = run.goSimTime;
    drive(run, t0 + DT, t0 + 20, (t, s) => {
      s.pos = [0, 0.5, -(t - t0) * 10];
      s.vel = [0, 0, -10];
    });
    expect(run.state.phase).toBe('finished');
    const r = run.result!;
    expect(r.completed).toBe(true);
    expect(r.score).toBeCloseTo(10, 2);
    expect(r.medal).toBe('gold');
    const ev = run.drainEvents().filter((e) => e.type === 'gate');
    expect(ev.length).toBe(2);
  });

  it('fails on the time limit and on rolling over', () => {
    const def: ChallengeDef = {
      ...base,
      id: 'slow',
      name: 'Slow',
      objectives: [
        { type: 'gates', gates: [{ pos: [0, null, -500], yawDeg: 0 }] },
        { type: 'timeLimit', seconds: 2, onExpire: 'fail' },
        { type: 'upright', graceS: 0.5 },
      ],
      scoring: { metric: 'time', better: 'lower', unit: 's', decimals: 2 },
      medals: { bronze: 20, silver: 12, gold: 10, crumple: 9 },
    };
    const a = new ChallengeRun(def, ground);
    a.startCountdown(0);
    drive(a, 0, 10, () => {});
    expect(a.state.phase).toBe('failed');
    expect(a.result!.failReason).toBe('Out of time');
    expect(a.result!.medal).toBe('none');

    const b = new ChallengeRun(def, ground);
    b.startCountdown(0);
    drive(b, 0, 10, (t, s) => {
      if (t > 2.6) s.up = [1, 0, 0];
    });
    expect(b.result!.failReason).toBe('Rolled over');
  });

  it('long jump: the takeoff-zone jump ends the run; a crash landing halves the distance', () => {
    const def: ChallengeDef = {
      ...base,
      id: 'lj',
      name: 'LJ',
      objectives: [
        { type: 'jump', takeoff: { kind: 'circle', center: [0, -20], radius: 5 }, ends: true, settleS: 1 },
        { type: 'landUpright', mode: 'bonus', factor: 0.5 },
      ],
      scoring: { metric: 'jumpDistance', better: 'higher', unit: 'm', decimals: 1 },
      medals: { bronze: 10, silver: 20, gold: 30, crumple: 40 },
    };
    const run = (flipped: boolean): ChallengeRun => {
      const r = new ChallengeRun(def, ground);
      r.startCountdown(0);
      drive(r, 0, 2.5, () => {});
      drive(r, 2.5, 12, (t, s) => {
        const u = t - 2.5;
        const z = -u * 20;
        s.pos = [0, 1, z];
        s.vel = [0, 0, -20];
        const air = z < -20 && z > -45;
        s.airborne = air;
        s.wheelContact = air ? 0 : 15;
        if (flipped && z <= -45) {
          s.up = [0, -1, 0];
          s.wheelContact = 0;
        }
      });
      return r;
    };
    const clean = run(false);
    expect(clean.result!.completed).toBe(true);
    expect(clean.result!.score).toBeCloseTo(25, 0);
    expect(clean.result!.medal).toBe('silver');
    const crash = run(true);
    expect(crash.result!.score).toBeCloseTo(12.5, 0);
  });
});
