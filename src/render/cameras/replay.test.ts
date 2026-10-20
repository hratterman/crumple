import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AutoDirector, MIN_SHOT_S, type DirectorFrame, type DirectorMarker } from './autoDirector';
import { createFreeCamInput, FreeCamera } from './freecam';
import { ReplayCameraRig, type ReplayCameraFrame } from './replayRig';
import { createPose, lineOfSight, springTrack, type CameraSubject, type CameraWorld } from './rig';
import { bestImpactAnchor, BumperShot, FollowShot, HeliShot, HoodShot, TracksideShot, type ShotFrame } from './shots';

const flat: CameraWorld = { groundHeight: () => 0 };
/** A 12 m ridge along x = 10 (|x − 10| < 3). */
const ridge: CameraWorld = { groundHeight: (x) => (Math.abs(x - 10) < 3 ? 12 : 0) };

interface MutableSubject extends CameraSubject {
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  velocity: [number, number, number];
}

/** A car driving −Z at `speed` m/s from the origin; time t s. */
function subjectAt(t: number, speed = 20, out?: MutableSubject): MutableSubject {
  const s: MutableSubject = out ?? { objectId: 1, valid: true, position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], velocity: [0, 0, 0], radius: 2.5 };
  s.position[0] = 0;
  s.position[1] = 0.5;
  s.position[2] = -speed * t;
  s.velocity[2] = -speed;
  return s;
}

function frame(t: number, dt: number, wallDt: number, world = flat, subject = subjectAt(t)): ShotFrame {
  return { dt, wallDt, time: t, subject, world };
}

describe('rig math', () => {
  it('springTrack follows a constant-velocity goal with no steady-state lag', () => {
    const x = new Vector3(0, 0, 0);
    const v = new Vector3(0, 0, -20);
    const goal = new Vector3();
    const gv = new Vector3(0, 0, -20);
    for (let i = 1; i <= 240; i++) {
      goal.set(0, 0, (-20 * i) / 60);
      springTrack(x, v, goal, gv, 9, 1 / 60);
    }
    expect(x.distanceTo(goal)).toBeLessThan(1e-6);
  });

  it('lineOfSight sees over flat ground and is blocked by a ridge', () => {
    const a = new Vector3(0, 1.5, 0);
    const b = new Vector3(20, 1.5, 0);
    expect(lineOfSight(flat, a, b)).toBe(true);
    expect(lineOfSight(ridge, a, b)).toBe(false);
    expect(lineOfSight(ridge, a, new Vector3(0, 1.5, 30))).toBe(true);
    const walls: CameraWorld = { groundHeight: () => 0, occluded: () => true };
    expect(lineOfSight(walls, a, b)).toBe(false);
  });
});

describe('shots', () => {
  it('follow frames the subject from behind its travel and stays there at speed', () => {
    const shot = new FollowShot();
    shot.reset(frame(0, 0, 0));
    for (let i = 1; i <= 120; i++) shot.update(frame(i / 60, 1 / 60, 1 / 60));
    const s = subjectAt(2);
    const p = shot.pose.position;
    // Driving −Z: the camera trails at +Z, above the car, looking at it.
    expect(p.z - s.position[2]).toBeGreaterThan(4);
    expect(Math.abs(p.x)).toBeLessThan(0.05);
    expect(p.y).toBeGreaterThan(1);
    expect(shot.pose.look.distanceTo(new Vector3(0, 0.95, s.position[2]))).toBeLessThan(0.05);
  });

  it('follow holds perfectly still on a paused frame (presented dt 0) but answers a drag', () => {
    const shot = new FollowShot();
    shot.reset(frame(1, 0, 0));
    for (let i = 0; i < 30; i++) shot.update(frame(1, 0, 1 / 60));
    const before = shot.pose.position.clone();
    for (let i = 0; i < 30; i++) shot.update(frame(1, 0, 1 / 60));
    expect(shot.pose.position.distanceTo(before)).toBe(0);
    shot.orbit(200, 0);
    for (let i = 0; i < 60; i++) shot.update(frame(1, 0, 1 / 60));
    expect(shot.pose.position.distanceTo(before)).toBeGreaterThan(1);
  });

  it('1/8× playback traces the same camera path as 1× (presented time drives it, no jitter)', () => {
    const fast = new BumperShot();
    const slow = new BumperShot();
    // A weaving subject so the springs have work to do.
    const weave = (t: number): MutableSubject => {
      const s = subjectAt(t);
      s.position[0] = 3 * Math.sin(t * 2);
      s.velocity[0] = 6 * Math.cos(t * 2);
      return s;
    };
    fast.reset({ dt: 0, wallDt: 0, time: 0, subject: weave(0), world: flat });
    slow.reset({ dt: 0, wallDt: 0, time: 0, subject: weave(0), world: flat });
    const pathFast: Vector3[] = [];
    for (let i = 1; i <= 60; i++) {
      fast.update({ dt: 1 / 60, wallDt: 1 / 60, time: i / 60, subject: weave(i / 60), world: flat });
      pathFast.push(fast.pose.position.clone());
    }
    const steps: number[] = [];
    let prev = slow.pose.position.clone();
    for (let i = 1; i <= 480; i++) {
      slow.update({ dt: 1 / 480, wallDt: 1 / 60, time: i / 480, subject: weave(i / 480), world: flat });
      steps.push(slow.pose.position.distanceTo(prev));
      prev = slow.pose.position.clone();
      if (i % 8 === 0) expect(slow.pose.position.distanceTo(pathFast[i / 8 - 1]!)).toBeLessThan(0.02);
    }
    // Smooth: no frame-to-frame step is more than twice its neighbours' average (no jitter).
    for (let i = 2; i < steps.length - 2; i++) {
      const avg = (steps[i - 1]! + steps[i + 1]!) / 2;
      expect(steps[i]!).toBeLessThan(avg * 2 + 1e-4);
    }
  });

  it('bumper is a low camera off the front quarter', () => {
    const shot = new BumperShot();
    shot.reset(frame(0, 0, 0), 1);
    expect(shot.pose.position.y).toBeCloseTo(0.42, 5);
    expect(shot.pose.position.z).toBeLessThan(-1); // ahead (travel is −Z)
    expect(Math.abs(shot.pose.position.x)).toBeGreaterThan(1.5);
    expect(shot.healthy).toBe(true);
  });

  it('trackside stands off the line of travel ahead, long lens, and asks to cut once the car is gone', () => {
    const shot = new TracksideShot();
    shot.reset(frame(0, 0, 0), 1);
    const a = shot.anchor;
    expect(a.z).toBeLessThan(-10);
    expect(Math.abs(a.x)).toBeGreaterThan(6);
    expect(shot.pose.fov).toBeLessThan(40);
    let t = 0;
    while (!shot.wantsCut && t < 20) {
      t += 1 / 30;
      shot.update(frame(t, 1 / 30, 1 / 30));
    }
    expect(shot.wantsCut).toBe(true);
    expect(t).toBeGreaterThan(2);
  });

  it('trackside avoids a side hidden by the terrain', () => {
    // Driving −Z along x = 0; the ridge at x = 10 hides anything at x > 13.
    const shot = new TracksideShot();
    shot.reset(frame(0, 0, 0, ridge), 1);
    expect(shot.healthy).toBe(true);
    expect(lineOfSight(ridge, shot.anchor, new Vector3(0, 1, 0))).toBe(true);
    expect(shot.anchor.x).toBeLessThan(7);
  });

  it('trackside prefers the roadside hook when there is a road', () => {
    const world: CameraWorld = {
      groundHeight: () => 0,
      roadside: (x, z, side, offset, _max, out) => {
        out.set(side * (5 + offset), 0, z);
        return true;
      },
    };
    const shot = new TracksideShot();
    shot.reset(frame(0, 0, 0, world), 1);
    expect(Math.abs(shot.anchor.x)).toBeGreaterThan(5);
  });

  it('hood is mounted above the bonnet looking ahead and rolls with the car', () => {
    const shot = new HoodShot();
    const s = subjectAt(0);
    shot.reset(frame(0, 0, 0, flat, s));
    expect(shot.pose.position.y).toBeGreaterThan(1);
    expect(shot.pose.look.z).toBeLessThan(shot.pose.position.z - 10);
    expect(shot.pose.roll).toBeCloseTo(0, 6);
    // Car rolled 20° about its forward axis.
    const a = (20 * Math.PI) / 180;
    s.up[0] = Math.sin(a);
    s.up[1] = Math.cos(a);
    shot.reset(frame(0, 0, 0, flat, s));
    expect(Math.abs(shot.pose.roll)).toBeCloseTo(a, 3);
  });

  it('heli is high and far with a telephoto lens', () => {
    const shot = new HeliShot();
    shot.reset(frame(0, 0, 0), 1);
    expect(shot.pose.position.y).toBeGreaterThan(20);
    expect(shot.pose.fov).toBeLessThan(40);
    expect(shot.healthy).toBe(true);
  });

  it('bestImpactAnchor picks a clear, side-on angle and never one behind the ridge', () => {
    const out = new Vector3();
    const r = bestImpactAnchor(flat, new Vector3(0, 0.5, 0), Math.PI, 2.5, 1, out);
    expect(r.score).toBeGreaterThan(0);
    // heading −Z: side-on = mostly ±X
    expect(Math.abs(out.x)).toBeGreaterThan(Math.abs(out.z) * 0.5);
    const out2 = new Vector3();
    bestImpactAnchor(ridge, new Vector3(0, 0.5, 0), Math.PI, 2.5, 1, out2);
    expect(lineOfSight(ridge, out2, new Vector3(0, 1.1, 0))).toBe(true);
  });
});

describe('free camera', () => {
  it('accelerates smoothly, glides to a stop and never goes under the terrain', () => {
    const cam = new FreeCamera();
    const p = createPose();
    p.position.set(0, 2, 0);
    p.look.set(0, 2, -10);
    cam.setFromPose(p);
    const input = createFreeCamInput();
    input.forward = 1;
    let prevV = 0;
    for (let i = 0; i < 30; i++) {
      cam.update(1 / 60, input, flat);
      const v = cam.velocity.length();
      expect(v).toBeGreaterThanOrEqual(prevV - 1e-9); // monotone acceleration
      prevV = v;
    }
    expect(cam.pose.position.z).toBeLessThan(-1);
    expect(prevV).toBeLessThan(9.01);
    input.forward = 0;
    for (let i = 0; i < 120; i++) cam.update(1 / 60, input, flat);
    expect(cam.velocity.length()).toBeLessThan(0.05);
    // Dive into the ground.
    input.up = -1;
    input.fast = true;
    for (let i = 0; i < 120; i++) cam.update(1 / 60, input, flat);
    expect(cam.pose.position.y).toBeGreaterThanOrEqual(0.3 - 1e-9);
  });

  it('looks with the pointer (drag right turns right)', () => {
    const cam = new FreeCamera();
    const p = createPose();
    p.position.set(0, 2, 0);
    p.look.set(0, 2, -10);
    cam.setFromPose(p);
    cam.look(100, 0);
    for (let i = 0; i < 60; i++) cam.update(1 / 60, createFreeCamInput(), flat);
    // Looking −Z, screen-right is +X.
    expect(cam.pose.look.x).toBeGreaterThan(0.5);
  });
});

// ============================================================ director
function dFrame(time: number, over: Partial<DirectorFrame> = {}): DirectorFrame {
  return { wallDt: 1 / 60, time, playing: true, speed: 1, direction: 1, subjectSpeed: 15, subjectId: 1, markers: [], ...over };
}
const marker = (id: number, time: number, severity = 0.8): DirectorMarker => ({ id, time, severity, objectId: 1, pos: [0, 0.5, 0] });

describe('auto director', () => {
  it('opens with a non-hood establishing shot and never cuts within 1.5 s', () => {
    const d = new AutoDirector(7);
    const cutsAt: number[] = [];
    let kind = '';
    let healthy = true;
    for (let i = 0; i < 60 * 40; i++) {
      // Every shot loses its subject immediately after a cut: the director cuts as fast as it may.
      const c = d.decide(dFrame(i / 60), i === 0 ? null : { kind: kind as never, healthy, wantsCut: false }, () => true);
      if (c) {
        if (i === 0) expect(c.kind).not.toBe('hood');
        cutsAt.push(i / 60);
        kind = c.kind;
        healthy = false;
      }
    }
    expect(cutsAt.length).toBeGreaterThan(10);
    for (let i = 1; i < cutsAt.length; i++) expect(cutsAt[i]! - cutsAt[i - 1]!).toBeGreaterThanOrEqual(MIN_SHOT_S - 1e-9);
  });

  it('never repeats a kind back to back and paces healthy shots at 2.4–6.5 s', () => {
    const d = new AutoDirector(3);
    let kind = '';
    let last = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const c = d.decide(dFrame(i / 60), i === 0 ? null : { kind: kind as never, healthy: true, wantsCut: false }, () => true);
      if (!c) continue;
      expect(c.kind).not.toBe(kind);
      if (i > 0) {
        const len = i / 60 - last;
        expect(len).toBeGreaterThanOrEqual(2.4 - 0.02);
        expect(len).toBeLessThanOrEqual(6.5 + 0.02);
      }
      kind = c.kind;
      last = i / 60;
    }
  });

  it('cuts to the impact angle just before the impact, even at 1/4×', () => {
    for (const speed of [1, 0.25]) {
      const d = new AutoDirector(11);
      const m = marker(5, 10);
      let kind = '';
      let impactCutAt = -1;
      // Wall time w, presented time = 6 + w·speed.
      for (let i = 0; i < 60 * 30; i++) {
        const t = 6 + (i / 60) * speed;
        const c = d.decide(dFrame(t, { speed, markers: [m] }), i === 0 ? null : { kind: kind as never, healthy: true, wantsCut: false }, () => true);
        if (c) {
          kind = c.kind;
          if (c.kind === 'impact') {
            impactCutAt = t;
            expect(c.marker?.id).toBe(5);
            break;
          }
        }
      }
      expect(impactCutAt).toBeGreaterThan(0);
      // ~0.7 s of viewing time ahead of the impact.
      expect((10 - impactCutAt) / speed).toBeGreaterThan(0.45);
      expect((10 - impactCutAt) / speed).toBeLessThan(0.75);
    }
  });

  it('holds the shot before an impact instead of leaving a sub-1.5 s shot', () => {
    const d = new AutoDirector(2);
    const m = marker(1, 3.2);
    let kind = '';
    const cuts: { t: number; kind: string }[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      const t = i / 60;
      const c = d.decide(dFrame(t, { markers: [m] }), i === 0 ? null : { kind: kind as never, healthy: true, wantsCut: true }, () => true);
      if (c) {
        cuts.push({ t, kind: c.kind });
        kind = c.kind;
      }
    }
    const impact = cuts.find((c) => c.kind === 'impact');
    expect(impact).toBeDefined();
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]!.t - cuts[i - 1]!.t).toBeGreaterThanOrEqual(MIN_SHOT_S - 1e-9);
  });

  it('does not cut to impacts while reversing or paused', () => {
    const d = new AutoDirector(2);
    const m = marker(1, 2);
    let kind = '';
    for (let i = 0; i < 60 * 4; i++) {
      const t = 4 - i / 60;
      const c = d.decide(dFrame(t, { markers: [m], direction: -1 }), i === 0 ? null : { kind: kind as never, healthy: true, wantsCut: false }, () => true);
      if (c) {
        expect(c.kind).not.toBe('impact');
        kind = c.kind;
      }
    }
  });

  it('skips candidates whose opening frame cannot see the subject', () => {
    const d = new AutoDirector(9);
    for (let k = 0; k < 20; k++) {
      d.reset(k);
      const c = d.decide(dFrame(0), null, (kind) => kind === 'heli');
      expect(c!.kind).toBe('heli');
    }
  });
});

describe('replay camera rig', () => {
  function rigFrame(t: number, over: Partial<ReplayCameraFrame> = {}): ReplayCameraFrame {
    return { wallDt: 1 / 60, time: t, playing: true, speed: 1, direction: 1, subject: subjectAt(t), markers: [], world: flat, ...over };
  }

  it('auto mode cuts on its own and to the impact', () => {
    const rig = new ReplayCameraRig(1);
    rig.setMode('auto', false);
    const m: DirectorMarker = { id: 3, time: 6, severity: 0.9, objectId: 1, pos: [0, 0.5, -120] };
    const kinds = new Set<string>();
    for (let i = 0; i < 60 * 12; i++) {
      rig.update(rigFrame(i / 60, { markers: [m] }));
      kinds.add(rig.shotKind);
    }
    expect(kinds.has('impact')).toBe(true);
    expect(kinds.size).toBeGreaterThan(2);
  });

  it('a seek re-frames instead of flying; a manual switch blends', () => {
    const rig = new ReplayCameraRig(1);
    rig.setMode('follow', false);
    for (let i = 0; i < 30; i++) rig.update(rigFrame(i / 60));
    rig.update(rigFrame(20));
    // Re-framed at the new subject position at once.
    expect(Math.abs(rig.pose.look.z - -400)).toBeLessThan(1);
    const before = rig.pose.position.clone();
    rig.setMode('heli');
    rig.update(rigFrame(20, { playing: false }));
    // Blending: the first blended frame is still near the old picture.
    expect(rig.pose.position.distanceTo(before)).toBeLessThan(5);
    for (let i = 0; i < 120; i++) rig.update(rigFrame(20, { playing: false }));
    expect(rig.pose.position.y).toBeGreaterThan(20);
  });

  it('free mode starts from the current picture (no jump)', () => {
    const rig = new ReplayCameraRig(1);
    rig.setMode('follow', false);
    for (let i = 0; i < 10; i++) rig.update(rigFrame(i / 60));
    const p = rig.pose.position.clone();
    rig.setMode('free', false);
    rig.update(rigFrame(10 / 60, { playing: false }));
    expect(rig.pose.position.distanceTo(p)).toBeLessThan(1e-6);
  });
});

describe('occluder', () => {
  it('segment vs AABB', async () => {
    const { createAabbOccluder, segmentHitsAabb } = await import('./occluder');
    const wall = [-5, 0, -0.5, 5, 2, 0.5] as const;
    expect(segmentHitsAabb(0, 1, -5, 0, 1, 5, wall)).toBe(true);
    expect(segmentHitsAabb(0, 3, -5, 0, 3, 5, wall)).toBe(false);
    expect(segmentHitsAabb(6, 1, -5, 6, 1, 5, wall)).toBe(false);
    expect(segmentHitsAabb(0, 1, -5, 0, 1, -1, wall)).toBe(false);
    const occ = createAabbOccluder([wall]);
    const world: CameraWorld = { groundHeight: () => 0, occluded: occ };
    expect(lineOfSight(world, new Vector3(0, 1, -5), new Vector3(0, 1, 5))).toBe(false);
    expect(lineOfSight(world, new Vector3(0, 1, -5), new Vector3(8, 1, -2))).toBe(true);
    // An end point inside a box (a crashed car in a moved prop's spawn box) ignores that box.
    expect(occ(0, 1, -5, 0, 1, 0)).toBe(false);
  });
});

describe('impact angle vs walls', () => {
  it('stays on the car side of the wall it hit, without the wall in the foreground', async () => {
    const { createAabbNearest, createAabbOccluder } = await import('./occluder');
    // Driving −Z into a 20 m wall at z ∈ [−1.6, −0.4] (face at −0.4); impact point on the face.
    const wall = [-10, 0, -1.6, 10, 2, -0.4] as const;
    const world: CameraWorld = { groundHeight: () => 0, occluded: createAabbOccluder([wall]), nearestOccluder: createAabbNearest([wall]) };
    for (let v = 0; v < 6; v++) {
      const out = new Vector3();
      const r = bestImpactAnchor(world, new Vector3(0, 0.5, -0.4), Math.PI, 2.5, v, out);
      expect(r.score).toBeGreaterThan(-Infinity);
      expect(out.z).toBeGreaterThan(-0.4);
      // The car (just back from the wall) in clear view.
      expect(lineOfSight(world, out, new Vector3(0, 1.1, 0.85))).toBe(true);
      // Not looking along the wall face from beside its end.
      const n = new Vector3();
      world.nearestOccluder!(out.x, out.y, out.z, n);
      const toWall = n.sub(out).normalize();
      const toCar = new Vector3(0, 1.1, 0.85).sub(out).normalize();
      expect(toWall.dot(toCar)).toBeLessThan(0.82);
    }
  });
});
