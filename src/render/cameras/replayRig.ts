/**
 * Replay camera rig (P7 R2): the camera while replaying / in photo mode.
 * Owns every shot, the free cam and the auto director, and turns the chosen
 * one into the frame's CameraPose:
 *
 *   mode 'auto'   the AutoDirector cuts between shots (hard cuts: editing)
 *   mode <shot>   that shot on the selected subject (trackside re-anchors itself)
 *   mode 'free'   the free-fly camera (photo mode uses it too)
 *
 * Manual mode switches blend from the previous picture with a critically
 * damped weight (~0.7 s); director cuts and seeks are instant. Presented
 * time drives the shots: dt = |Δ playhead| per frame, a jump of more than
 * SEEK_JUMP_S (a seek, a scrub) re-frames the current shot instead of
 * flying the camera there.
 */
import { Vector3 } from 'three';
import { AutoDirector, type CutDecision, type DirectorMarker } from './autoDirector';
import { FreeCamera, createFreeCamInput, type FreeCamInput } from './freecam';
import { copyPose, createPose, spring1, subjectPosition, type CameraPose, type CameraSubject, type CameraWorld, type ShotFrame, type Spring1 } from './rig';
import { createShot, FollowShot, HoodShot, ImpactShot, TracksideShot, type HoodMount, type Shot, type ShotKind } from './shots';

export type ReplayCameraMode = 'auto' | 'follow' | 'bumper' | 'trackside' | 'hood' | 'heli' | 'free';
export const REPLAY_CAMERA_MODES: readonly ReplayCameraMode[] = ['auto', 'follow', 'bumper', 'trackside', 'hood', 'heli', 'free'];
export const REPLAY_CAMERA_LABELS: Readonly<Record<ReplayCameraMode, string>> = {
  auto: 'Director',
  follow: 'Orbit',
  bumper: 'Tracking',
  trackside: 'Trackside',
  hood: 'Hood',
  heli: 'Heli',
  free: 'Free',
};

/** A playhead jump larger than this (s) is a seek: shots re-frame instead of chasing. */
export const SEEK_JUMP_S = 0.5;
const BLEND_OMEGA = 7;
/** Markers further than this from the subject are someone else's crash (not cut to). */
const MARKER_REACH_M = 45;

export interface ReplayCameraFrame {
  wallDt: number;
  /** Presented time, s. */
  time: number;
  playing: boolean;
  speed: number;
  direction: 1 | -1;
  /** null / invalid: the camera holds its pose. */
  subject: CameraSubject | null;
  markers: readonly DirectorMarker[];
  world: CameraWorld;
  /** The subject's hood-camera mount (vehicle geometry), when known. */
  hoodMount?: HoodMount | null;
}

export class ReplayCameraRig {
  readonly pose: CameraPose = createPose();
  readonly free = new FreeCamera();
  readonly freeInput: FreeCamInput = createFreeCamInput();
  readonly director: AutoDirector;
  /** Photo mode: replaces the shot's fov / roll (null = the shot's own). */
  fovOverride: number | null = null;
  rollOverride: number | null = null;
  /** Last director decision (debug / e2e). */
  lastCut: CutDecision | null = null;
  private _mode: ReplayCameraMode = 'auto';
  private readonly shots = new Map<ShotKind, Shot>();
  private readonly probes = new Map<ShotKind, Shot>();
  private current: Shot | null = null;
  private lastTime = NaN;
  private needsFrame = true;
  private readonly from = createPose();
  private readonly blend: Spring1 = { x: 1, v: 0 };
  private readonly frame: ShotFrame = { dt: 0, wallDt: 0, time: 0, subject: null as unknown as CameraSubject, world: null as unknown as CameraWorld };
  private readonly nearMarkers: DirectorMarker[] = [];
  private readonly tmp = new Vector3();
  private subjectId = -1;

  constructor(seed = 0x5eed) {
    this.director = new AutoDirector(seed);
  }

  get mode(): ReplayCameraMode {
    return this._mode;
  }

  /** What is on screen: the shot kind ('impact' included) or 'free'. */
  get shotKind(): ShotKind | 'free' {
    return this._mode === 'free' ? 'free' : (this.current?.kind ?? 'follow');
  }

  get follow(): FollowShot {
    return this.shot('follow') as FollowShot;
  }

  /** Switch camera mode; `blend` eases from the current picture (manual switches), else cuts. */
  setMode(mode: ReplayCameraMode, blend = true): void {
    if (mode === this._mode && !this.needsFrame) return;
    if (blend) this.beginBlend();
    if (mode === 'free' && this._mode !== 'free') this.free.setFromPose(this.pose);
    if (mode === 'follow' && this._mode !== 'follow') this.follow.clearUser();
    this._mode = mode;
    this.current = null;
    this.needsFrame = true;
    if (mode === 'auto') this.director.reset();
  }

  /** Cycle the shot modes (C). */
  cycle(dir = 1): ReplayCameraMode {
    const list = REPLAY_CAMERA_MODES;
    const i = list.indexOf(this._mode);
    this.setMode(list[(i + dir + list.length) % list.length]!);
    return this._mode;
  }

  /** Re-frame on the next update (enter replay, target change, settled seek). */
  reframe(blend = false): void {
    if (blend) this.beginBlend();
    this.needsFrame = true;
    this.current = null;
    if (this._mode === 'auto') this.director.reset();
  }

  /** Start from an existing camera (entering replay: the first frame continues the live picture). */
  startFrom(p: Readonly<CameraPose>): void {
    copyPose(this.pose, p);
    copyPose(this.from, p);
    this.free.setFromPose(p);
  }

  update(f: ReplayCameraFrame): CameraPose {
    const jump = Number.isFinite(this.lastTime) ? Math.abs(f.time - this.lastTime) : 0;
    const seeked = jump > SEEK_JUMP_S;
    this.lastTime = f.time;
    const sf = this.frame;
    sf.wallDt = Math.min(Math.max(f.wallDt, 0), 0.1);
    sf.dt = seeked ? 0 : jump;
    sf.time = f.time;
    sf.world = f.world;

    if (this._mode === 'free') {
      this.free.update(sf.wallDt, this.freeInput, f.world);
      copyPose(this.pose, this.free.pose);
      this.finish(sf.wallDt);
      return this.pose;
    }
    const s = f.subject;
    if (!s || !s.valid) return this.pose; // hold still until the subject exists
    sf.subject = s;
    if (s.objectId !== this.subjectId) {
      this.subjectId = s.objectId;
      if (!this.needsFrame) this.reframe(true);
    }
    if (seeked) {
      this.needsFrame = true;
      this.current = null;
      if (this._mode === 'auto') {
        this.director.reset();
        this.director.skipImpactsBefore(f.markers, f.time);
      }
    }

    const mount = f.hoodMount ?? null;
    (this.shot('hood') as HoodShot).mount = mount;
    (this.probe('hood') as HoodShot).mount = mount;
    if (this._mode === 'auto') {
      this.filterMarkers(f, s);
      const probe = (kind: ShotKind, variant: number): boolean => {
        const p = this.probe(kind);
        p.reset(sf, variant);
        return p.healthy;
      };
      const cut = this.director.decide(
        {
          wallDt: sf.wallDt,
          time: f.time,
          playing: f.playing,
          speed: f.speed,
          direction: f.direction,
          subjectSpeed: Math.hypot(s.velocity[0]!, s.velocity[2]!),
          subjectId: s.objectId,
          markers: this.nearMarkers,
        },
        this.needsFrame || !this.current ? null : { kind: this.current.kind, healthy: this.current.healthy, wantsCut: this.wantsCut(this.current) },
        probe,
      );
      if (cut) {
        this.lastCut = cut;
        const shot = this.shot(cut.kind);
        if (shot instanceof ImpactShot) shot.setPoint(cut.marker ? cut.marker.pos : null);
        shot.reset(sf, cut.variant);
        this.current = shot;
        this.needsFrame = false;
      } else this.current?.update(sf);
    } else {
      const shot = this.shot(this._mode);
      if (this.needsFrame || this.current !== shot) {
        shot.reset(sf, shot.kind === 'follow' ? 0 : 1);
        this.current = shot;
        this.needsFrame = false;
      } else {
        shot.update(sf);
        // A manual trackside camera re-anchors once the subject has passed (a cut).
        if (shot instanceof TracksideShot && shot.wantsCut) shot.reset(sf, -1);
      }
    }
    if (this.current) copyPose(this.pose, this.current.pose);
    this.finish(sf.wallDt);
    return this.pose;
  }

  private finish(wallDt: number): void {
    if (this.blend.x < 0.999) {
      spring1(this.blend, 1, BLEND_OMEGA, wallDt);
      const w = Math.min(Math.max(this.blend.x, 0), 1);
      const p = this.pose;
      p.position.lerpVectors(this.from.position, p.position, w);
      p.look.lerpVectors(this.from.look, p.look, w);
      p.fov = this.from.fov + (p.fov - this.from.fov) * w;
      p.roll = this.from.roll + (p.roll - this.from.roll) * w;
      p.focus = this.from.focus + (p.focus - this.from.focus) * w;
    }
    if (this.fovOverride !== null) this.pose.fov = this.fovOverride;
    if (this.rollOverride !== null) this.pose.roll = this.rollOverride;
  }

  private beginBlend(): void {
    copyPose(this.from, this.pose);
    this.blend.x = 0;
    this.blend.v = 0;
  }

  private wantsCut(s: Shot): boolean {
    return s instanceof TracksideShot ? s.wantsCut : false;
  }

  private filterMarkers(f: ReplayCameraFrame, s: CameraSubject): void {
    const out = this.nearMarkers;
    out.length = 0;
    const p = subjectPosition(s, this.tmp);
    for (const m of f.markers) {
      if (m.objectId === s.objectId || Math.hypot(m.pos[0]! - p.x, m.pos[2]! - p.z) < MARKER_REACH_M) out.push(m);
    }
  }

  private shot(kind: ShotKind): Shot {
    let s = this.shots.get(kind);
    if (!s) this.shots.set(kind, (s = createShot(kind)));
    return s;
  }

  private probe(kind: ShotKind): Shot {
    let s = this.probes.get(kind);
    if (!s) this.probes.set(kind, (s = createShot(kind)));
    return s;
  }
}
