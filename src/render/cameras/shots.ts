/**
 * Replay camera shots (P7 R2). Each shot films one subject and writes a
 * CameraPose per frame; `reset` is a cut (the shot re-frames from scratch),
 * `update` advances it. Subject-following motion integrates in presented
 * time (ShotFrame.dt), user input in wall time (see rig.ts TIME).
 *
 *   follow     orbit-follow: behind the travel heading, drag to orbit, wheel to zoom
 *   bumper     low tracking cam: a camera car at the front quarter, 0.4 m off the ground
 *   trackside  a fixed roadside position ahead of the subject, panning with a long lens
 *   hood       rigidly mounted above the bonnet
 *   heli       high, slow orbit, telephoto
 *   impact     static "best angle" on a crash point (director cut on impact markers)
 */
import { Vector3 } from 'three';
import {
  clamp,
  createPose,
  damp,
  framingFov,
  keepAboveGround,
  lineOfSight,
  smoothstep,
  spring1,
  springAngle,
  springTrack,
  springVec,
  subjectHeading,
  subjectPosition,
  subjectRadius,
  subjectUp,
  subjectVelocity,
  wrapAngle,
  type CameraPose,
  type CameraSubject,
  type CameraWorld,
  type ShotFrame,
  type Spring1,
} from './rig';

export type ShotKind = 'follow' | 'bumper' | 'trackside' | 'hood' | 'heli' | 'impact';

/** Where a hood camera sits on a subject: metres from its frame origin along its up / forward axes. */
export interface HoodMount {
  up: number;
  forward: number;
}

export interface Shot {
  readonly kind: ShotKind;
  readonly pose: CameraPose;
  /** Cut to the subject: frame it from scratch. `variant` (any number) picks side / angle deterministically. */
  reset(f: ShotFrame, variant?: number): void;
  update(f: ShotFrame): void;
  /** The shot still sees its subject (line of sight, distance); the director cuts away when false for a while. */
  readonly healthy: boolean;
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _up = new Vector3();

/** Unit horizontal vector for yaw (0 = +Z). */
function yawVec(yaw: number, out: Vector3): Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

/** Heading that survives a stopped / upside-down subject: falls back to `fallback`. */
function headingOr(s: CameraSubject, fallback: number): number {
  const h = subjectHeading(s);
  return h === null ? fallback : h;
}

/** Subject look point: a little above the frame origin (the chassis floor). */
function lookPoint(s: CameraSubject, lift: number, out: Vector3): Vector3 {
  subjectPosition(s, out);
  out.y += lift;
  return out;
}

// ============================================================ follow (orbit)
export class FollowShot implements Shot {
  readonly kind = 'follow';
  readonly pose = createPose();
  healthy = true;
  /** Base framing: distance = r·distanceK + distanceAdd; height via pitch. */
  distanceK = 1.55;
  distanceAdd = 2.2;
  basePitch = 0.2;
  baseFov = 50;
  private readonly pivot = new Vector3();
  private readonly pivotVel = new Vector3();
  private readonly heading: Spring1 = { x: 0, v: 0 };
  /** User orbit offsets (goal) and their smoothed values (wall time). */
  private userYaw = 0;
  private userPitch = 0;
  private userZoom = 1;
  private readonly yawS: Spring1 = { x: 0, v: 0 };
  private readonly pitchS: Spring1 = { x: 0, v: 0 };
  private readonly zoomS: Spring1 = { x: 1, v: 0 };
  private distS = 0;

  /** Orbit by a pointer drag (pixels). */
  orbit(dx: number, dy: number): void {
    this.userYaw = wrapAngle(this.userYaw - dx * 0.006);
    this.userPitch = clamp(this.userPitch + dy * 0.004, -this.basePitch - 0.12, 1.25 - this.basePitch);
  }

  /** Zoom by wheel notches (+ = out). */
  zoom(notches: number): void {
    this.userZoom = clamp(this.userZoom * Math.pow(1.12, notches), 0.45, 4);
  }

  /** Forget the user's orbit (next reset frames from behind). */
  clearUser(): void {
    this.userYaw = this.userPitch = 0;
    this.userZoom = 1;
  }

  reset(f: ShotFrame, variant = 0): void {
    const s = f.subject;
    lookPoint(s, 0.45, this.pivot);
    subjectVelocity(s, this.pivotVel);
    this.heading.x = headingOr(s, 0);
    this.heading.v = 0;
    // Director variants orbit the opening angle (±0.55 rad steps); 0 keeps the user's orbit.
    if (variant !== 0) {
      this.userYaw = wrapAngle(variant * 0.55);
      this.userPitch = 0;
      this.userZoom = 1;
    }
    this.yawS.x = this.userYaw;
    this.pitchS.x = this.userPitch;
    this.zoomS.x = this.userZoom;
    this.yawS.v = this.pitchS.v = this.zoomS.v = 0;
    this.distS = 0;
    this.compose(f, true);
  }

  update(f: ShotFrame): void {
    const s = f.subject;
    lookPoint(s, 0.45, _a);
    subjectVelocity(s, _b);
    springTrack(this.pivot, this.pivotVel, _a, _b, 14, f.dt);
    const h = subjectHeading(s);
    if (h !== null) springAngle(this.heading, h, 3.2, f.dt);
    springAngle(this.yawS, this.userYaw, 16, f.wallDt);
    spring1(this.pitchS, this.userPitch, 16, f.wallDt);
    spring1(this.zoomS, this.userZoom, 14, f.wallDt);
    this.compose(f, false);
  }

  private compose(f: ShotFrame, snap: boolean): void {
    const r = subjectRadius(f.subject);
    const yaw = this.heading.x + Math.PI + this.yawS.x;
    const pitch = this.basePitch + this.pitchS.x;
    let dist = (r * this.distanceK + this.distanceAdd) * this.zoomS.x;
    // Pull in (never push out instantly) when the terrain hides the subject.
    const p = this.pose.position;
    const place = (d: number): Vector3 =>
      p.set(
        this.pivot.x + Math.sin(yaw) * Math.cos(pitch) * d,
        this.pivot.y + Math.sin(pitch) * d,
        this.pivot.z + Math.cos(yaw) * Math.cos(pitch) * d,
      );
    place(dist);
    if (!lineOfSight(f.world, this.pivot, p, 0.25)) {
      let lo = 0.25;
      let hi = 1;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        place(dist * m);
        if (lineOfSight(f.world, this.pivot, p, 0.25)) lo = m;
        else hi = m;
      }
      dist *= lo;
    }
    this.distS = snap || this.distS === 0 || dist < this.distS ? dist : this.distS + (dist - this.distS) * damp(2.5, f.wallDt + f.dt);
    place(this.distS);
    keepAboveGround(f.world, p, 0.35);
    this.pose.look.copy(this.pivot);
    this.pose.fov = this.baseFov;
    this.pose.roll = 0;
    this.pose.focus = p.distanceTo(this.pivot);
    this.healthy = true;
  }
}

// ============================================================ bumper (low tracking)
export class BumperShot implements Shot {
  readonly kind = 'bumper';
  readonly pose = createPose();
  healthy = true;
  private side = 1;
  // (see goalOffset: front quarter while moving, rear quarter at rest)
  private readonly heading: Spring1 = { x: 0, v: 0 };
  private readonly offset = new Vector3();
  private readonly offsetVel = new Vector3();
  private readonly aim = new Vector3();
  private readonly aimVel = new Vector3();
  private losTimer = 0;

  reset(f: ShotFrame, variant = 0): void {
    this.side = variant < 0 ? -1 : 1;
    this.heading.x = headingOr(f.subject, 0);
    this.heading.v = 0;
    this.goalOffset(f, this.offset);
    this.offsetVel.set(0, 0, 0);
    lookPoint(f.subject, 0.35, this.aim);
    subjectVelocity(f.subject, this.aimVel);
    this.losTimer = 0;
    this.compose(f);
  }

  update(f: ShotFrame): void {
    const h = subjectHeading(f.subject);
    if (h !== null) springAngle(this.heading, h, 2.6, f.dt);
    this.goalOffset(f, _c);
    // The camera car drifts on its own spring relative to the subject.
    springVec(this.offset, this.offsetVel, _c, 3.2, f.dt);
    lookPoint(f.subject, 0.35, _a);
    subjectVelocity(f.subject, _b);
    springTrack(this.aim, this.aimVel, _a, _b, 9, f.dt);
    this.compose(f);
  }

  private goalOffset(f: ShotFrame, out: Vector3): Vector3 {
    const r = subjectRadius(f.subject);
    const fwd = yawVec(this.heading.x, _b);
    // right of travel = fwd × up = (−fz, 0, fx)
    const rx = -fwd.z;
    const rz = fwd.x;
    const lateral = this.side * (r * 0.62 + 1.25);
    // Moving: the camera car runs ahead at the front quarter. Stopped (a wreck against a wall): it
    // settles at the rear quarter, never inside whatever the car hit.
    const v = f.subject.velocity;
    const k = smoothstep(2, 8, Math.hypot(v[0]!, v[2]!));
    const ahead = -(r * 0.7) * (1 - k) + (r * 0.95 + 0.6) * k;
    return out.set(fwd.x * ahead + rx * lateral, 0, fwd.z * ahead + rz * lateral);
  }

  private compose(f: ShotFrame): void {
    const p = this.pose.position;
    subjectPosition(f.subject, p).add(this.offset);
    p.y = f.world.groundHeight(p.x, p.z) + 0.42;
    this.pose.look.copy(this.aim);
    const d = p.distanceTo(this.aim);
    this.pose.fov = framingFov(subjectRadius(f.subject), d, 0.92, 38, 72);
    this.pose.roll = 0;
    this.pose.focus = d;
    const los = lineOfSight(f.world, p, this.aim, 0.05);
    this.losTimer = los ? 0 : this.losTimer + f.wallDt;
    this.healthy = this.losTimer < 0.35;
  }
}

// ============================================================ trackside (long lens)
export class TracksideShot implements Shot {
  readonly kind = 'trackside';
  readonly pose = createPose();
  healthy = true;
  /** Subject left the shot (receding past maxDistance): a manual camera re-anchors (a cut). */
  wantsCut = false;
  maxDistance = 75;
  readonly anchor = new Vector3();
  private readonly aim = new Vector3();
  private readonly aimVel = new Vector3();
  private readonly fovS: Spring1 = { x: 20, v: 0 };
  private losTimer = 0;

  reset(f: ShotFrame, variant = 0): void {
    const s = f.subject;
    const r = subjectRadius(s);
    const v = subjectVelocity(s, _b);
    const speed = Math.hypot(v.x, v.z);
    const heading = headingOr(s, 0);
    const fwd = yawVec(heading, _c);
    const first: 1 | -1 = variant < 0 ? -1 : 1;
    lookPoint(s, 0.5, this.aim);
    subjectVelocity(s, this.aimVel);
    let found = false;
    // Ahead of the travel (lead seconds of SIM time, at least a few car lengths) on either side.
    const leads = [1.7, 1.1, 2.4, 0.6];
    for (let li = 0; li < leads.length && !found; li++) {
      const ahead = Math.max(speed * leads[li]!, r * (3.2 - li * 0.6));
      for (const side of [first, first === 1 ? -1 : 1] as const) {
        const px = this.aim.x + fwd.x * ahead;
        const pz = this.aim.z + fwd.z * ahead;
        const w = f.world;
        if (!(w.roadside && w.roadside(px, pz, side, 2.5 + r * 0.6, 30, this.anchor))) {
          // No road: stand off the line of travel.
          this.anchor.set(px - fwd.z * side * (7 + r * 1.4), 0, pz + fwd.x * side * (7 + r * 1.4));
        }
        this.anchor.y = w.groundHeight(this.anchor.x, this.anchor.z) + 1.25 + ((Math.abs(variant) * 7.3) % 1) * 0.9;
        if (lineOfSight(w, this.anchor, this.aim, 0.1)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      // Last resort: high above the line of travel (always sees the subject).
      this.anchor.set(this.aim.x + fwd.x * r * 4, 0, this.aim.z + fwd.z * r * 4);
      this.anchor.y = Math.max(f.world.groundHeight(this.anchor.x, this.anchor.z), this.aim.y) + 6;
    }
    const d = this.anchor.distanceTo(this.aim);
    this.fovS.x = framingFov(r, d, 0.5, 6, 40);
    this.fovS.v = 0;
    this.losTimer = 0;
    this.wantsCut = false;
    this.compose(f);
  }

  update(f: ShotFrame): void {
    lookPoint(f.subject, 0.5, _a);
    subjectVelocity(f.subject, _b);
    // A long lens pans smoothly: a slightly soft aim, still lag-free at constant velocity.
    springTrack(this.aim, this.aimVel, _a, _b, 7.5, f.dt);
    const d = this.anchor.distanceTo(this.aim);
    spring1(this.fovS, framingFov(subjectRadius(f.subject), d, 0.5, 6, 40), 3, f.dt);
    this.compose(f);
    // Receding past maxDistance: done.
    const away = (this.aim.x - this.anchor.x) * _b.x + (this.aim.z - this.anchor.z) * _b.z > 0;
    this.wantsCut = (d > this.maxDistance && away) || d > this.maxDistance * 1.6;
  }

  private compose(f: ShotFrame): void {
    this.pose.position.copy(this.anchor);
    this.pose.look.copy(this.aim);
    this.pose.fov = this.fovS.x;
    this.pose.roll = 0;
    const d = this.anchor.distanceTo(this.aim);
    this.pose.focus = d;
    const los = lineOfSight(f.world, this.anchor, this.aim, 0.05);
    this.losTimer = los ? 0 : this.losTimer + f.wallDt;
    this.healthy = this.losTimer < 0.4 && d < this.maxDistance * 1.2;
  }
}

// ============================================================ hood
export class HoodShot implements Shot {
  readonly kind = 'hood';
  readonly pose = createPose();
  healthy = true;
  /** The subject's real mount point (vehicle geometry), else a radius-scaled guess. */
  mount: HoodMount | null = null;
  private readonly fwd = new Vector3(0, 0, -1);
  private readonly fwdVel = new Vector3();
  private readonly upS = new Vector3(0, 1, 0);
  private readonly upVel = new Vector3();

  reset(f: ShotFrame): void {
    this.fwd.set(f.subject.forward[0]!, f.subject.forward[1]!, f.subject.forward[2]!);
    subjectUp(f.subject, this.upS);
    this.fwdVel.set(0, 0, 0);
    this.upVel.set(0, 0, 0);
    this.compose(f);
  }

  update(f: ShotFrame): void {
    _a.set(f.subject.forward[0]!, f.subject.forward[1]!, f.subject.forward[2]!);
    subjectUp(f.subject, _b);
    // Stiff mount: only the node-level shimmer is filtered, crashes still shake it.
    springVec(this.fwd, this.fwdVel, _a, 28, f.dt);
    springVec(this.upS, this.upVel, _b, 28, f.dt);
    this.compose(f);
  }

  private compose(f: ShotFrame): void {
    const r = subjectRadius(f.subject);
    const k = clamp(r / 2.6, 0.7, 1.8);
    const fwd = _a.copy(this.fwd).normalize();
    const up = _up.copy(this.upS);
    up.addScaledVector(fwd, -up.dot(fwd)).normalize();
    if (!(up.lengthSq() > 0.5)) up.set(0, 1, 0);
    const p = subjectPosition(f.subject, this.pose.position);
    const m = this.mount;
    p.addScaledVector(up, m ? m.up : 0.78 * k).addScaledVector(fwd, m ? m.forward : 0.62 * k);
    this.pose.look.copy(p).addScaledVector(fwd, 20).addScaledVector(up, -1.4);
    // Roll: the car's up vector against the un-rolled camera up.
    const right = _b.copy(fwd).cross(_c.set(0, 1, 0));
    if (right.lengthSq() > 1e-6) {
      right.normalize();
      const camUp = _c.copy(right).cross(fwd);
      this.pose.roll = Math.atan2(up.dot(right), up.dot(camUp));
    } else this.pose.roll = 0;
    this.pose.fov = 64;
    this.pose.focus = 12;
    this.healthy = true;
  }
}

// ============================================================ helicopter
export class HeliShot implements Shot {
  readonly kind = 'heli';
  readonly pose = createPose();
  healthy = true;
  private angle = 0;
  private readonly center = new Vector3();
  private readonly centerVel = new Vector3();
  private readonly fovS: Spring1 = { x: 24, v: 0 };
  private spin = 1;

  reset(f: ShotFrame, variant = 0): void {
    const h = headingOr(f.subject, 0);
    // Start off the rear quarter (variant flips the side and the orbit direction).
    this.spin = variant < 0 ? -1 : 1;
    this.angle = h + Math.PI + this.spin * 0.75;
    this.goal(f, this.center);
    subjectVelocity(f.subject, this.centerVel);
    this.compose(f, true);
  }

  update(f: ShotFrame): void {
    this.angle = wrapAngle(this.angle + this.spin * 0.07 * f.dt);
    this.goal(f, _a);
    subjectVelocity(f.subject, _b);
    springTrack(this.center, this.centerVel, _a, _b, 1.8, f.dt);
    this.compose(f, false);
  }

  private goal(f: ShotFrame, out: Vector3): Vector3 {
    lookPoint(f.subject, 0.3, out);
    subjectVelocity(f.subject, _c);
    return out.addScaledVector(_c, 0.6);
  }

  private compose(f: ShotFrame, snap: boolean): void {
    const r = subjectRadius(f.subject);
    const dist = 26 + r * 3;
    const alt = 20 + r * 2.4;
    const p = this.pose.position.set(this.center.x + Math.sin(this.angle) * dist, this.center.y + alt, this.center.z + Math.cos(this.angle) * dist);
    keepAboveGround(f.world, p, 12);
    this.pose.look.copy(this.center);
    const d = p.distanceTo(this.center);
    const fov = framingFov(r, d, 0.3, 8, 40);
    if (snap) this.fovS.x = fov;
    else spring1(this.fovS, fov, 2, f.dt);
    this.pose.fov = this.fovS.x;
    this.pose.roll = 0;
    this.pose.focus = d;
    this.healthy = lineOfSight(f.world, p, this.center, 0.5);
  }
}

// ============================================================ impact (best angle)
/** Scores candidate static angles around an impact point; writes the best anchor. */
export function bestImpactAnchor(
  world: CameraWorld,
  point: Vector3,
  heading: number,
  radius: number,
  variant: number,
  out: Vector3,
): { score: number; angle: number } {
  const dists = [10 + radius * 0.8, 7 + radius * 0.6, 14 + radius];
  let best = -Infinity;
  let bestAngle = heading;
  // Frame the car at the contact, not the contact point itself (often ON the wall face): a little back
  // along the travel direction.
  const target = _c.set(point.x - Math.sin(heading) * radius * 0.5, point.y + 0.6, point.z - Math.cos(heading) * radius * 0.5);
  const cand = _a;
  for (let k = 0; k < 12; k++) {
    const rel = (k / 12) * Math.PI * 2;
    const angle = heading + rel;
    for (let di = 0; di < dists.length; di++) {
      const d = dists[di]!;
      cand.set(point.x + Math.sin(angle) * d, 0, point.z + Math.cos(angle) * d);
      cand.y = Math.max(world.groundHeight(cand.x, cand.z), point.y - 1) + 1.15 + (di === 2 ? 0.8 : 0);
      if (!lineOfSight(world, cand, target, 0.1)) continue;
      // Side-on shows the crumple; a little ahead sees the face coming in; nearer is more dramatic.
      let score = Math.abs(Math.sin(rel)) * 2 + Math.cos(rel) * 0.9 - di * 0.25;
      // A clear FOREGROUND across the frame, not just a clear centre: rays toward either side of the
      // subject, stopping short of its depth (a wall end filling half the picture loses; the wall the
      // car hit, seen behind it, is background and does not).
      const px = -(target.z - cand.z);
      const pz = target.x - cand.x;
      const pl = Math.hypot(px, pz) || 1;
      const side = radius * 1.3 + 1;
      for (const k2 of [-1, 1]) {
        _b.set(target.x + (px / pl) * side * k2, target.y + 0.4, target.z + (pz / pl) * side * k2);
        _b.lerp(cand, 0.3);
        if (!lineOfSight(world, cand, _b, 0.05)) score -= 2.4;
      }
      _b.set(target.x, target.y + 2.6, target.z);
      if (!lineOfSight(world, cand, _b, 0.05)) score -= 0.8;
      // Foreground clutter: the nearest occluder lies between the camera and the car, inside the view
      // cone (a wall end filling half the picture, a camera looking along a wall face).
      if (world.nearestOccluder) {
        const dn = world.nearestOccluder(cand.x, cand.y, cand.z, _d);
        const dt = cand.distanceTo(target);
        if (dn < dt * 0.85) {
          _d.sub(cand);
          _e.copy(target).sub(cand);
          const cos = _d.dot(_e) / Math.max(1e-6, _d.length() * _e.length());
          if (cos > 0.82 || dn < 1.5) score -= 3;
        }
      }
      // Deterministic variety between equally good angles.
      score += ((Math.sin((k + 1) * 12.9898 + variant * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.35;
      if (score > best) {
        best = score;
        bestAngle = angle;
        out.copy(cand);
      }
    }
  }
  if (best === -Infinity) {
    // Nothing clear: above the point.
    out.set(point.x + Math.sin(heading + Math.PI / 2) * 6, point.y + 9, point.z + Math.cos(heading + Math.PI / 2) * 6);
    return { score: -Infinity, angle: heading };
  }
  return { score: best, angle: bestAngle };
}

export class ImpactShot implements Shot {
  readonly kind = 'impact';
  readonly pose = createPose();
  healthy = true;
  readonly anchor = new Vector3();
  readonly point = new Vector3();
  private readonly aim = new Vector3();
  private readonly aimVel = new Vector3();
  private readonly fovS: Spring1 = { x: 30, v: 0 };
  private hasPoint = false;

  /** The crash point to frame (set before reset; else the subject position). */
  setPoint(p: ArrayLike<number> | null): void {
    if (p) this.point.set(p[0]!, p[1]!, p[2]!);
    this.hasPoint = !!p;
  }

  reset(f: ShotFrame, variant = 0): void {
    const s = f.subject;
    if (!this.hasPoint) subjectPosition(s, this.point);
    const r = subjectRadius(s);
    bestImpactAnchor(f.world, this.point, headingOr(s, 0), r, variant, this.anchor);
    // Aim between the subject now and the crash point: the car drives into frame.
    lookPoint(s, 0.5, this.aim).lerp(_a.copy(this.point).setY(this.point.y + 0.5), 0.5);
    subjectVelocity(s, this.aimVel);
    this.fovS.x = framingFov(r, this.anchor.distanceTo(this.aim), 0.62, 14, 50);
    this.fovS.v = 0;
    this.compose(f);
  }

  update(f: ShotFrame): void {
    lookPoint(f.subject, 0.5, _a);
    subjectVelocity(f.subject, _b);
    springTrack(this.aim, this.aimVel, _a, _b, 6, f.dt);
    spring1(this.fovS, framingFov(subjectRadius(f.subject), this.anchor.distanceTo(this.aim), 0.62, 14, 50), 2.5, f.dt);
    this.compose(f);
  }

  private compose(f: ShotFrame): void {
    this.pose.position.copy(this.anchor);
    this.pose.look.copy(this.aim);
    this.pose.fov = this.fovS.x;
    this.pose.roll = 0;
    this.pose.focus = this.anchor.distanceTo(this.aim);
    this.healthy = this.pose.focus < 60;
    void f;
  }
}

export function createShot(kind: ShotKind): Shot {
  switch (kind) {
    case 'follow':
      return new FollowShot();
    case 'bumper':
      return new BumperShot();
    case 'trackside':
      return new TracksideShot();
    case 'hood':
      return new HoodShot();
    case 'heli':
      return new HeliShot();
    case 'impact':
      return new ImpactShot();
  }
}

export type { CameraSubject, CameraWorld, ShotFrame };
