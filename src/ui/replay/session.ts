/**
 * Replay session (P7 R2): everything the player sees and does around the
 * live replay buffer. Consumes only the ReplayController API.
 *
 *   - Replay UI (overlay.ts) whenever `replay.active`, however it was entered
 *     (Backspace, the pause menu, the crash cam, the debug API); the HUD hides.
 *   - The replay camera rig (render/cameras/replayRig.ts) owns the camera
 *     while active: director / orbit / tracking / trackside / hood / heli / free.
 *   - Live crash cam (crashCam.ts): a severe impact on the player plays back
 *     from 2 s before at 1/4× from the director's angles, letterboxed, and
 *     returns to live; any input skips, Backspace keeps watching.
 *   - Photo mode (photo.ts + render/cameras/photoFx.ts + post DoF): free cam,
 *     lens / focus / look / frame controls, PNG capture at up to 2×.
 *
 * Keys (while replaying; captured before the driving mapper, keyups pass):
 *   Space play/pause · ← → frame step (Shift ×10) · [ ] speed · R reverse ·
 *   C / 1–7 camera · Tab subject · , . previous / next crash · Home / End ·
 *   P photo · H hide UI · Esc / Backspace exit (photo first).
 *   Free cam / photo: W A S D move, Q E down / up, Shift fast, drag look,
 *   wheel speed (photo: zoom), Enter capture, G grid, F autofocus.
 */
import { Vector2, Vector3, type Object3D, type PerspectiveCamera, type WebGLRenderer } from 'three';
import { REPLAY_SPEEDS, createReplayTarget, type ReplayController, type ReplayEvent, type ReplayMarker, type ReplayTarget } from '../../app/replay/types';
import type { DirectorMarker } from '../../render/cameras/autoDirector';
import { pickDistance } from '../../render/cameras/pick';
import { PhotoFx } from '../../render/cameras/photoFx';
import { ReplayCameraRig, REPLAY_CAMERA_MODES, type ReplayCameraFrame, type ReplayCameraMode } from '../../render/cameras/replayRig';
import type { HoodMount } from '../../render/cameras/shots';
import { applyPose, subjectRadius, type CameraPose, type CameraWorld } from '../../render/cameras/rig';
import type { PostStack } from '../../render/types';
import { capturePhoto } from './capture';
import { CrashCam, CRASH_CAM_POSTROLL_S, CRASH_CAM_PREROLL_S, CRASH_CAM_SPEED } from './crashCam';
import { apertureToBokeh, apertureToRange, photoFileName, PHOTO_ASPECTS, severityWord } from './format';
import { ReplayOverlay, type OverlayState } from './overlay';
import { PhotoPanel, type PhotoSettings } from './photo';

export interface ReplaySessionDeps {
  replay: ReplayController;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  post: PostStack;
  world: CameraWorld;
  /** Static meshes for click-to-focus (colliders). */
  pickMeshes?: () => readonly Object3D[];
  /** Draw one full world frame now (photo capture). */
  renderFrame(): void;
  /** May a crash-cam highlight start now (driving; no menu, no hold)? */
  canHighlight(): boolean;
  crashCamEnabled(): boolean;
  /** The replay UI took over (true) / handed back (false): HUD, held input. */
  onActiveChange(active: boolean): void;
  /** Back on the road: the chase cam frames the car again (smooth: fly back from the replay camera; else snap). */
  onExitToLive(smooth: boolean): void;
  /** Short message when there is nothing to replay. */
  toast(title: string, sub: string): void;
  /** Hood-camera mount of a subject (metres from its frame origin along up / forward), null = guess from its size. */
  hoodMount?(objectId: number): HoodMount | null;
  /** Display name of a subject (player vehicle name, traffic). */
  subjectName?(t: Readonly<ReplayTarget>): string;
  units?(): 'kmh' | 'mph';
  parent?: HTMLElement;
  /** R-GFX: the world's time of day (photo mode's light slider), absent without a lighting environment. */
  environment?: { time(): number; setTime(hours: number): void };
}

/** e2e / console view of the session (`window.__crumple.replayUi`). */
export interface ReplaySessionDebug {
  readonly state: {
    open: boolean;
    highlight: boolean;
    crashCam: string;
    highlights: number;
    camera: ReplayCameraMode;
    shot: string;
    cuts: number;
    lastCut: string | null;
    subject: number;
    photo: boolean;
    idle: boolean;
    clean: boolean;
    photoSettings: PhotoSettings;
    lastPhoto: { width: number; height: number; bytes: number; name: string } | null;
    dof: boolean;
  };
  enter(): Promise<boolean>;
  exit(): Promise<void>;
  setCamera(mode: ReplayCameraMode): void;
  cycleSubject(): void;
  enterPhoto(): Promise<boolean>;
  exitPhoto(): void;
  setPhoto(patch: Partial<PhotoSettings>): void;
  /** `scale` × the CSS size (photo panel: 1 or 2; tests may pass the screen pixel ratio). */
  capture(scale?: number): Promise<{ width: number; height: number; bytes: number; name: string }>;
  /** Focus at a CSS pixel (photo mode); resolves the picked distance. */
  focusAt(x: number, y: number): number | null;
  /** Start the crash cam on the most severe marker now (no delay, ignores the setting). */
  triggerCrashCam(): Promise<boolean>;
  setClean(clean: boolean): void;
}

const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
const PASS_CODES = new Set(['Backquote', 'F5', 'F11', 'F12']);
const CURTAIN_MS = 230;
/** Most severe markers whose first contact is scanned on entering a replay. */
const CONTACT_SCAN_MAX = 6;
const DRAG_PX = 4;

function wait(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export class ReplaySession {
  readonly rig = new ReplayCameraRig();
  readonly overlay: ReplayOverlay;
  readonly photo: PhotoPanel;
  readonly crashCam = new CrashCam();
  private readonly d: ReplaySessionDeps;
  private readonly replay: ReplayController;
  private readonly photoFx: PhotoFx;
  private readonly curtain: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly target: ReplayTarget = createReplayTarget();
  private readonly targetList: ReplayTarget[] = [];
  private subjectId: number;
  private subjectLabel = 'Player';
  private subjectCount = 1;
  private subjectRefresh = 0;
  private uiOpen = false;
  private photoOn = false;
  private photoPrevMode: ReplayCameraMode = 'follow';
  /** The user's camera choice for manual replays (the crash cam always directs). */
  private preferredMode: ReplayCameraMode = 'follow';
  /** time = the first contact (see scanContacts), peak = the marker's peak frame. */
  private highlight: { markerId: number; time: number; peak: number; severity: number; startedWall: number; impactSpeed: number } | null = null;
  /** First contact + approach speed per marker id (scanContacts); the director cuts to these times. */
  private readonly contacts = new Map<number, { time: number; speed: number }>();
  private readonly directorMarkers: DirectorMarker[] = [];
  private readonly directorMarkerPool = new Map<number, { id: number; time: number; severity: number; objectId: number; pos: readonly [number, number, number] }>();
  private readonly scanTarget: ReplayTarget = createReplayTarget();
  private transitioning = false;
  private readonly held = new Set<string>();
  private drag: { id: number; x: number; y: number; moved: boolean; button: number } | null = null;
  private scrubWasPlaying = false;
  private busy = false;
  private lastPhoto: { width: number; height: number; bytes: number; name: string } | null = null;
  private readonly overlayState: OverlayState;
  private readonly padPrev: boolean[] = [];
  private wallClock = 0;
  private readonly unsub: () => void;
  private readonly tmpPose: CameraPose;
  private readonly tmpV = new Vector3();
  private readonly tmpD = new Vector3();
  private readonly bufSize = new Vector2();
  private readonly camFrame: ReplayCameraFrame;
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.keyUp(e);
  private readonly onPointerDown = (e: PointerEvent): void => this.pointerDown(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.pointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.pointerUp(e);
  private readonly onWheel = (e: WheelEvent): void => this.wheel(e);
  private readonly onContext = (e: Event): void => {
    if (this.uiOpen) e.preventDefault();
  };
  private readonly onBlur = (): void => this.held.clear();
  private readonly onResize = (): void => {
    this.layoutPhoto();
    this.applyDof();
  };

  constructor(deps: ReplaySessionDeps) {
    this.d = deps;
    this.replay = deps.replay;
    this.subjectId = deps.replay.playerObjectId;
    const parent = deps.parent ?? document.body;
    this.overlay = new ReplayOverlay(parent, {
      togglePlay: () => this.togglePlay(),
      step: (n) => this.replay.step(n),
      setSpeed: (s) => this.replay.setSpeed(s),
      toggleReverse: () => this.replay.setDirection(this.replay.direction > 0 ? -1 : 1),
      scrubStart: () => {
        this.scrubWasPlaying = this.replay.playing;
        this.replay.pause();
      },
      scrub: (t) => this.replay.seek(t, { settle: false }),
      scrubEnd: (t) => {
        this.replay.seek(t, { settle: true });
        if (this.scrubWasPlaying) this.replay.play();
      },
      jumpToMarker: (id) => this.jumpToMarker(id),
      marker: (dir) => this.stepMarker(dir),
      setCamera: (m) => this.setCamera(m),
      cycleSubject: () => this.cycleSubject(1),
      photo: () => void this.enterPhoto(),
      exit: () => void this.exitReplay(),
    });
    this.photo = new PhotoPanel(parent, {
      change: (_s, key) => this.applyPhoto(key),
      capture: () => void this.capture(),
      close: () => this.exitPhoto(),
    });
    this.photoFx = new PhotoFx(deps.renderer, deps.post.composer, deps.camera);
    this.curtain = document.createElement('div');
    this.curtain.className = 'rp-curtain';
    parent.appendChild(this.curtain);
    this.flash = document.createElement('div');
    this.flash.className = 'rp-flash';
    parent.appendChild(this.flash);
    this.tmpPose = { position: new Vector3(), look: new Vector3(), fov: 55, roll: 0, focus: 10 };
    this.camFrame = { wallDt: 0, time: 0, playing: false, speed: 1, direction: 1, subject: null, markers: [], world: deps.world, hoodMount: null };
    this.overlayState = { start: 0, end: 0, time: 0, playing: false, speed: 1, direction: 1, markers: [], camera: 'follow', shot: 'follow', subject: 'Player', subjects: 1 };
    this.unsub = this.replay.on((e) => this.onReplayEvent(e));
    window.addEventListener('blur', this.onBlur);
    // The boot spawn settles onto the ground: not a crash.
    this.quietCrashCam(3);
  }

  /** The replay UI is up (the controller presents recorded frames). */
  get active(): boolean {
    return this.uiOpen;
  }

  /** Use updateCamera() instead of the driving camera this frame. */
  get ownsCamera(): boolean {
    return this.uiOpen && this.replay.active;
  }

  get photoMode(): boolean {
    return this.photoOn;
  }

  // ============================================================ entering / leaving
  /** Backspace: open the replay, or leave it. */
  toggleReplay(): void {
    if (this.uiOpen) void this.exitReplay();
    else void this.enterReplay();
  }

  async enterReplay(): Promise<boolean> {
    if (this.uiOpen) return true;
    if (this.replay.phase !== 'live' || this.transitioning) return false;
    this.crashCam.cancel();
    this.captureLivePose();
    // A manual replay always starts at 1× forward (the crash cam leaves 1/4× behind).
    const ok = await this.replay.enter({ speed: 1, direction: 1 });
    if (!ok) {
      this.d.toast('NOTHING TO REPLAY YET', 'REPLAY');
      return false;
    }
    this.openUi(this.preferredMode);
    this.crashCam.markShown(this.replay.end);
    return true;
  }

  async exitReplay(): Promise<void> {
    if (this.transitioning) return;
    if (this.photoOn) this.exitPhoto();
    if (!this.replay.active && !this.uiOpen) return;
    if (this.highlight) return this.finishHighlight();
    await this.replay.exit();
    this.closeUi();
  }

  /** Photo mode from replay or from the pause menu (enters the replay first). */
  async enterPhoto(): Promise<boolean> {
    if (this.photoOn) return true;
    if (!this.uiOpen) {
      if (!(await this.enterReplay())) return false;
    }
    if (this.highlight) this.keepWatching();
    this.replay.pause();
    this.photoOn = true;
    this.photoPrevMode = this.rig.mode;
    const s = this.photo.settings;
    s.fov = Math.round(Math.min(Math.max(this.d.camera.fov, 8), 100));
    s.roll = 0;
    if (this.d.environment) s.timeOfDay = this.d.environment.time();
    this.rig.setMode('free', false);
    this.overlay.root.hidden = true;
    this.photo.open();
    this.photoFx.attach();
    this.applyPhoto('preset');
    this.layoutPhoto();
    this.held.clear();
    return true;
  }

  exitPhoto(): void {
    if (!this.photoOn) return;
    this.photoOn = false;
    this.photoFx.detach();
    this.d.post.setDepthOfField?.(null);
    this.rig.fovOverride = null;
    this.rig.rollOverride = null;
    this.rig.setMode(this.photoPrevMode === 'free' ? 'free' : this.photoPrevMode, true);
    this.photo.close();
    if (this.uiOpen) this.overlay.root.hidden = false;
    this.overlay.poke();
  }

  private openUi(mode: ReplayCameraMode): void {
    if (this.uiOpen) return;
    this.uiOpen = true;
    this.subjectId = this.replay.playerObjectId;
    this.rig.startFrom(this.tmpPose);
    this.rig.setMode(mode, true);
    this.rig.reframe(true);
    this.overlay.show();
    this.overlay.clean = false;
    this.held.clear();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('resize', this.onResize);
    const c = this.d.renderer.domElement;
    c.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', this.onContext);
    this.padPrev.length = 0;
    this.refreshSubjects();
    this.scanContacts();
    this.d.onActiveChange(true);
  }

  private closeUi(smooth = true): void {
    if (!this.uiOpen) return;
    if (this.photoOn) this.exitPhoto();
    this.uiOpen = false;
    this.highlight = null;
    this.overlay.setHighlight(false);
    this.overlay.setCinema(false);
    this.overlay.hide();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('resize', this.onResize);
    const c = this.d.renderer.domElement;
    c.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContext);
    this.held.clear();
    this.drag = null;
    this.d.onActiveChange(false);
    this.d.onExitToLive(smooth);
  }

  private captureLivePose(): void {
    const cam = this.d.camera;
    this.tmpPose.position.copy(cam.position);
    cam.getWorldDirection(this.tmpD);
    this.tmpPose.look.copy(cam.position).addScaledVector(this.tmpD, 10);
    this.tmpPose.fov = cam.fov;
    this.tmpPose.roll = 0;
  }

  private onReplayEvent(e: ReplayEvent): void {
    switch (e.type) {
      case 'marker':
        if (!this.replay.active && this.replay.phase === 'live') this.considerMarker(e.marker);
        break;
      case 'end':
        if (this.highlight) void this.finishHighlight();
        break;
      case 'seek':
        break;
      default:
        break;
    }
  }

  // ============================================================ crash cam
  /**
   * A teleport / reset / respawn: the drop onto the ground and the settle are not crashes. Markers
   * up to `seconds` of sim time from now never trigger the crash cam (an armed one is dropped).
   */
  quietCrashCam(seconds = 2.5): void {
    this.crashCam.cancel();
    this.crashCam.markShown(this.replay.end + seconds);
  }

  private considerMarker(m: ReplayMarker): void {
    const enabled = this.d.crashCamEnabled();
    this.crashCam.enabled = enabled;
    if (!enabled) return;
    let near = m.objectId === this.replay.playerObjectId;
    if (!near && this.replay.target(this.replay.playerObjectId, this.target)) {
      const p = this.target.position;
      near = Math.hypot(m.pos[0] - p[0], m.pos[2] - p[2]) < 25;
    }
    this.crashCam.onMarker(m, this.wallClock, near);
  }

  private async startHighlight(markerId: number, force = false): Promise<boolean> {
    const m = this.replay.markers().find((k) => k.id === markerId);
    if (!m || this.transitioning || this.replay.phase !== 'live' || (!force && !this.d.canHighlight())) {
      this.crashCam.cancel();
      return false;
    }
    const time = m.time;
    const severity = m.severity;
    this.transitioning = true;
    this.crashCam.started();
    this.captureLivePose();
    this.setCurtain(true);
    await wait(CURTAIN_MS);
    let ok = false;
    try {
      // Enter paused well before the peak: the first contact is found first (behind the curtain).
      ok = await this.replay.enter({ time: Math.max(this.replay.start, time - CRASH_CAM_PREROLL_S - 1.5), play: false, speed: CRASH_CAM_SPEED, direction: 1 });
    } catch (err) {
      console.warn('[replay] crash cam enter failed', err);
    }
    if (!ok) {
      this.crashCam.finished(this.wallClock, time);
      this.setCurtain(false);
      this.transitioning = false;
      return false;
    }
    this.scanContacts();
    const contact = this.contacts.get(markerId) ?? { time, speed: -1 };
    this.highlight = { markerId, time: contact.time, peak: time, severity, startedWall: this.wallClock, impactSpeed: contact.speed };
    this.replay.seek(Math.max(this.replay.start, contact.time - CRASH_CAM_PREROLL_S));
    this.replay.setSpeed(CRASH_CAM_SPEED);
    this.replay.play();
    this.openUi('auto');
    this.rig.setMode('auto', false);
    this.rig.director.reset(markerId * 7919);
    this.overlay.setCinema(true);
    this.overlay.setHighlight(true, severityWord(severity), severity);
    await nextFrame();
    await nextFrame();
    this.setCurtain(false);
    this.transitioning = false;
    return true;
  }

  private async finishHighlight(): Promise<void> {
    const hl = this.highlight;
    if (!hl || this.transitioning) return;
    this.transitioning = true;
    this.setCurtain(true);
    await wait(CURTAIN_MS);
    const covered = Math.max(this.replay.time, hl.time);
    try {
      if (this.replay.active) await this.replay.exit();
    } finally {
      this.highlight = null;
      this.crashCam.finished(this.wallClock, covered);
      this.closeUi(false);
      await nextFrame();
      this.setCurtain(false);
      this.transitioning = false;
    }
  }

  /** Backspace during a highlight: stay in the replay with the full UI. */
  private keepWatching(): void {
    const hl = this.highlight;
    if (!hl) return;
    this.highlight = null;
    this.crashCam.finished(this.wallClock, Math.max(this.replay.end, hl.time));
    this.overlay.setHighlight(false);
    this.overlay.setCinema(false);
    this.overlay.poke();
  }

  /**
   * A marker carries its burst's PEAK frame, which can sit well into the crush (up to ~0.8 s after the
   * first contact at speed). Each severe marker's first contact is found once, on entering the replay,
   * by scanning its subject's speed over the 1.5 s before the peak with cheap unsettled seeks (≈ 2
   * decodes each): the first frame that sheds more than 6 % of its speed (a brake never does) or drops below 80 % of the approach. The playhead is
   * restored with a settled seek. The director cuts to, and the crash cam plays around, the contact.
   */
  private scanContacts(): void {
    const r = this.replay;
    if (!r.active) return;
    // Markers evicted from the buffer are gone for good (ids are monotonic).
    const oldest = r.markers().length > 0 ? r.markers()[0]!.id : Infinity;
    for (const id of this.contacts.keys()) if (id < oldest) this.contacts.delete(id);
    for (const id of this.directorMarkerPool.keys()) if (id < oldest) this.directorMarkerPool.delete(id);
    const todo = r
      .markers()
      .filter((m) => !this.contacts.has(m.id) && m.severity >= 0.2)
      .sort((a, b) => b.severity - a.severity)
      .slice(0, CONTACT_SCAN_MAX);
    if (todo.length === 0) return;
    const t0 = r.time;
    const playing = r.playing;
    if (playing) r.pause();
    const step = Math.max(r.frameDuration, 1 / 120);
    const tg = this.scanTarget;
    for (const m of todo) {
      let best: { time: number; speed: number } | null = null;
      for (const id of m.objectId === r.playerObjectId ? [m.objectId] : [m.objectId, r.playerObjectId]) {
        let vmax = 0;
        let prev = -1;
        let prevV = 0;
        let found = -1;
        for (let t = Math.max(r.start, m.time - 1.5); t <= m.time + 1e-6; t += step) {
          r.seek(t, { settle: false });
          if (!r.target(id, tg)) continue;
          const v = Math.hypot(tg.velocity[0], tg.velocity[1], tg.velocity[2]);
          // A crash sheds speed far faster than any brake (> 6 % per frame), or 20 % of the approach.
          if (prev >= 0 && prevV > 3 && (prevV - v > Math.max(0.06 * prevV, 1) || v < vmax * 0.8)) {
            found = prev;
            break;
          }
          vmax = Math.max(vmax, v);
          prev = t;
          prevV = v;
        }
        if (found >= 0 && (!best || vmax > best.speed)) best = { time: found, speed: vmax };
      }
      this.contacts.set(m.id, best ?? { time: m.time, speed: -1 });
    }
    for (const m of r.markers()) if (!this.contacts.has(m.id)) this.contacts.set(m.id, { time: m.time, speed: -1 });
    r.seek(t0, { settle: true });
    if (playing) r.play();
  }

  /** The markers with their contact times (what the director cuts on). */
  private markersForDirector(): readonly DirectorMarker[] {
    const out = this.directorMarkers;
    out.length = 0;
    for (const m of this.replay.markers()) {
      let d = this.directorMarkerPool.get(m.id);
      if (!d) this.directorMarkerPool.set(m.id, (d = { id: m.id, time: m.time, severity: m.severity, objectId: m.objectId, pos: m.pos }));
      d.time = this.contacts.get(m.id)?.time ?? m.time;
      d.severity = m.severity;
      out.push(d);
    }
    return out;
  }

  private setCurtain(on: boolean): void {
    this.curtain.classList.toggle('rp-curtain--on', on);
  }

  // ============================================================ per frame
  /** Replaces the driving camera while `ownsCamera`. */
  updateCamera(wallDt: number): void {
    const r = this.replay;
    let subject: ReplayTarget | null = null;
    if (r.target(this.subjectId, this.target)) subject = this.target;
    else if (this.subjectId !== r.playerObjectId) {
      this.subjectId = r.playerObjectId;
      if (r.target(this.subjectId, this.target)) subject = this.target;
    }
    this.updateFreeInput();
    const cf = this.camFrame;
    cf.wallDt = wallDt;
    cf.time = r.time;
    cf.playing = r.playing;
    cf.speed = r.speed;
    cf.direction = r.direction;
    cf.subject = subject;
    cf.markers = this.markersForDirector();
    cf.hoodMount = subject && this.d.hoodMount ? this.d.hoodMount(subject.objectId) : null;
    const pose = this.rig.update(cf);
    applyPose(this.d.camera, pose);
    if (this.photoOn && this.photo.settings.autofocus && subject) {
      // Focus a little in front of the subject's centre (its near side is what reads as sharp); the
      // circle of confusion measures the radial distance from the camera.
      const d = this.tmpV.set(subject.position[0], subject.position[1] + 0.4, subject.position[2]).distanceTo(this.d.camera.position);
      const focus = Math.max(0.3, d - subjectRadius(subject) * 0.35);
      if (Math.abs(focus - this.photo.settings.focus) > 0.02) {
        this.photo.set('focus', Math.round(focus * 100) / 100, false);
        this.applyDof();
      }
    }
  }

  /** After the frame is drawn: UI, crash cam, gamepad. */
  frame(wallDt: number): void {
    // Real time (the loop clamps its dt at 0.1 s: a slow machine would stretch the crash-cam delay).
    this.wallClock = performance.now() / 1000;
    const r = this.replay;
    // Follow the controller: a replay entered / left elsewhere (debug API) still gets the UI.
    if (r.active && !this.uiOpen && !this.transitioning) {
      this.captureLivePose();
      this.openUi(this.preferredMode);
    } else if (!r.active && r.phase === 'live' && this.uiOpen && !this.transitioning) {
      this.closeUi();
    }
    if (!this.uiOpen) {
      if (this.crashCam.due(this.wallClock)) {
        if (this.d.crashCamEnabled() && this.d.canHighlight()) void this.startHighlight(this.crashCam.markerId);
        else if (!this.d.crashCamEnabled()) this.crashCam.cancel();
      }
      return;
    }
    if (this.highlight && !this.transitioning) {
      const hl = this.highlight;
      const until = Math.max(hl.time + CRASH_CAM_POSTROLL_S, hl.peak + 0.6);
      if (r.time >= until || (!r.playing && r.time >= r.end - 1e-3)) void this.finishHighlight();
      if (this.target.valid) {
        // Live speed on the approach; from the first contact on, the speed it hit at.
        const v = Math.hypot(this.target.velocity[0], this.target.velocity[1], this.target.velocity[2]);
        const impact = r.time > hl.time && hl.impactSpeed > 0;
        this.overlay.setHighlightSpeed(this.speedText(impact ? hl.impactSpeed : v), impact ? 'Impact speed' : 'Speed');
      }
    }
    this.pollPad();
    this.subjectRefresh -= wallDt;
    if (this.subjectRefresh <= 0) this.refreshSubjects();
    const s = this.overlayState;
    s.start = r.start;
    s.end = r.end;
    s.time = r.time;
    s.playing = r.playing;
    s.speed = r.speed;
    s.direction = r.direction;
    s.markers = r.markers();
    s.camera = this.rig.mode;
    s.shot = this.rig.shotKind;
    s.subject = this.subjectLabel;
    s.subjects = this.subjectCount;
    this.overlay.update(s, wallDt);
    if (this.photoOn) {
      this.photoFx.frame();
      if (this.photoFx.attached) this.photoFx.apply(this.photoLook());
    }
  }

  private speedText(ms: number): string {
    const v = ms * 3.6;
    return this.d.units?.() === 'mph' ? `${Math.round(v / 1.609344)} mph` : `${Math.round(v)} km/h`;
  }

  private refreshSubjects(): void {
    this.subjectRefresh = 1;
    const n = this.replay.targets(this.targetList);
    this.subjectCount = Math.max(1, n);
    const t = this.targetList.slice(0, n).find((k) => k.objectId === this.subjectId);
    this.subjectLabel = t ? this.nameOf(t) : this.subjectId === this.replay.playerObjectId ? 'Player' : `#${this.subjectId}`;
  }

  private nameOf(t: Readonly<ReplayTarget>): string {
    if (this.d.subjectName) return this.d.subjectName(t);
    return t.kind === 'player' ? 'Player' : t.kind === 'traffic' ? `Traffic ${t.objectId}` : `Object ${t.objectId}`;
  }

  // ============================================================ actions
  private togglePlay(): void {
    const r = this.replay;
    if (!r.playing) {
      const eps = r.frameDuration * 0.5;
      if (r.direction > 0 && r.time >= r.end - eps) r.seek(r.start);
      else if (r.direction < 0 && r.time <= r.start + eps) r.seek(r.end);
      r.play();
    } else r.pause();
  }

  private setCamera(m: ReplayCameraMode): void {
    if (this.photoOn) return;
    if (this.highlight) this.keepWatching();
    this.rig.setMode(m, true);
    this.preferredMode = m;
    this.overlay.showToast(m === 'auto' ? 'Director' : `${m === 'follow' ? 'Orbit' : m} camera`);
  }

  private cycleSubject(dir: 1 | -1): void {
    const n = this.replay.targets(this.targetList);
    if (n <= 1) {
      this.overlay.showToast('Only one subject');
      return;
    }
    const i = this.targetList.slice(0, n).findIndex((t) => t.objectId === this.subjectId);
    const next = this.targetList[(i + dir + n) % n]!;
    this.subjectId = next.objectId;
    this.subjectLabel = this.nameOf(next);
    this.subjectCount = n;
    this.rig.reframe(true);
    this.overlay.showToast(this.subjectLabel);
  }

  private jumpToMarker(id: number): void {
    const m = this.replay.markers().find((k) => k.id === id);
    if (!m) return;
    this.replay.seek(Math.max(this.replay.start, m.time - 1.2));
    if (this.replay.direction < 0) this.replay.setDirection(1);
    this.replay.play();
  }

  private stepMarker(dir: 1 | -1): void {
    const ms = this.replay.markers();
    const t = this.replay.time;
    let pick: ReplayMarker | null = null;
    if (dir > 0) {
      for (const m of ms)
        if (m.time - 1.2 > t + 0.05) {
          pick = m;
          break;
        }
    } else {
      for (let i = ms.length - 1; i >= 0; i--)
        if (ms[i]!.time - 1.2 < t - 0.3) {
          pick = ms[i]!;
          break;
        }
    }
    if (!pick) {
      this.overlay.showToast(dir > 0 ? 'No later crash' : 'No earlier crash');
      return;
    }
    this.jumpToMarker(pick.id);
  }

  // ============================================================ photo
  private photoLook() {
    const s = this.photo.settings;
    return { preset: s.preset, exposure: s.exposure, vignette: s.vignette, grain: s.grain };
  }

  private applyPhoto(key: keyof PhotoSettings): void {
    if (!this.photoOn) return;
    const s = this.photo.settings;
    this.rig.fovOverride = s.fov;
    this.rig.rollOverride = (s.roll * Math.PI) / 180;
    this.photoFx.apply(this.photoLook());
    this.applyDof();
    if (key === 'aspect' || key === 'scale') this.layoutPhoto();
    if (key === 'timeOfDay') this.d.environment?.setTime(s.timeOfDay);
  }

  private applyDof(): void {
    const s = this.photo.settings;
    // Autofocus keeps the whole subject inside the sharp band (a car is ~5 m deep); manual focus is the lens.
    const range = Math.max(apertureToRange(s.fStop, s.focus), s.autofocus && this.target.valid ? subjectRadius(this.target) * 1.6 : 0);
    // The bokeh kernel is in buffer pixels: scale it with the buffer so the look is resolution independent
    // (a 0.5× software-GL buffer, the 2× capture and a 4K screen all show the same blur).
    const k = this.d.renderer.getDrawingBufferSize(this.bufSize).y / 1080;
    this.d.post.setDepthOfField?.(this.photoOn && s.dof ? { focusDistance: s.focus, focalLength: range, bokehScale: apertureToBokeh(s.fStop) * k } : null);
  }

  private layoutPhoto(): void {
    if (!this.photoOn) return;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    this.photo.layout(w, hgt);
    const s = this.photo.settings;
    const a = PHOTO_ASPECTS.find((x) => x.id === s.aspect)?.ratio ?? null;
    let ow = w * s.scale;
    let oh = hgt * s.scale;
    if (a) {
      if (ow / oh > a) ow = oh * a;
      else oh = ow / a;
    }
    this.photo.setOutputSize(Math.round(ow), Math.round(oh));
  }

  async capture(scale?: number): Promise<{ width: number; height: number; bytes: number; name: string }> {
    if (!this.photoOn) throw new Error('capture outside photo mode');
    if (this.busy) throw new Error('capture in progress');
    this.busy = true;
    this.photo.setBusy(true);
    try {
      await nextFrame();
      const s = this.photo.settings;
      const aspect = PHOTO_ASPECTS.find((x) => x.id === s.aspect)?.ratio ?? null;
      const res = await capturePhoto(
        {
          renderer: this.d.renderer,
          post: this.d.post,
          width: () => window.innerWidth,
          height: () => window.innerHeight,
          renderFrame: () => this.d.renderFrame(),
          resized: () => this.applyDof(),
        },
        scale ?? s.scale,
        aspect,
      );
      const name = photoFileName(new Date());
      this.photo.showShot(URL.createObjectURL(res.blob), name, res.width, res.height, res.blob.size);
      this.flash.classList.remove('rp-flash--go');
      void this.flash.offsetWidth;
      this.flash.classList.add('rp-flash--go');
      this.lastPhoto = { width: res.width, height: res.height, bytes: res.blob.size, name };
      return this.lastPhoto;
    } finally {
      this.busy = false;
      this.photo.setBusy(false);
    }
  }

  /** Click-to-focus: distance to the surface under a CSS pixel (photo mode). */
  focusAt(x: number, y: number): number | null {
    if (!this.photoOn) return null;
    const cam = this.d.camera;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const o = this.tmpV.copy(cam.position);
    const dir = this.tmpD.set((x / w) * 2 - 1, -(y / hgt) * 2 + 1, 0.5).unproject(cam).sub(cam.position).normalize();
    const n = this.replay.targets(this.targetList);
    const dist = pickDistance(o, dir, this.targetList.slice(0, n), (px, pz) => this.d.world.groundHeight(px, pz), this.d.pickMeshes?.() ?? []);
    let depth: number | null = null;
    if (dist !== null) {
      depth = Math.max(0.3, dist);
      this.photo.settings.autofocus = false;
      this.photo.set('focus', Math.round(depth * 100) / 100, false);
      if (!this.photo.settings.dof) this.photo.set('dof', true, false);
      this.applyDof();
    }
    this.photo.focusAt(x, y, depth);
    return depth;
  }

  // ============================================================ input
  private updateFreeInput(): void {
    const k = this.held;
    const f = this.rig.freeInput;
    f.forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    f.right = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    f.up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    f.fast = k.has('ShiftLeft') || k.has('ShiftRight');
    f.slow = false;
  }

  private keyDown(e: KeyboardEvent): void {
    if (!this.uiOpen) return;
    if (PASS_CODES.has(e.code) || /^F\d+$/.test(e.code)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.overlay.poke();
    if (this.transitioning) return;
    if (this.highlight) {
      if (e.repeat || this.wallClock - this.highlight.startedWall < 0.25) return;
      if (e.code === 'Backspace') this.keepWatching();
      else void this.finishHighlight();
      return;
    }
    const free = this.rig.mode === 'free';
    if (MOVE_CODES.has(e.code) && (free || this.photoOn)) {
      this.held.add(e.code);
      return;
    }
    if (this.photoOn) {
      this.photoKey(e);
      return;
    }
    const r = this.replay;
    const shift = e.shiftKey;
    switch (e.code) {
      case 'Space':
        if (!e.repeat) this.togglePlay();
        break;
      case 'ArrowLeft':
        r.step(shift ? -10 : -1);
        break;
      case 'ArrowRight':
        r.step(shift ? 10 : 1);
        break;
      case 'BracketLeft':
      case 'BracketRight': {
        const i = REPLAY_SPEEDS.indexOf(r.speed);
        const j = Math.min(REPLAY_SPEEDS.length - 1, Math.max(0, i + (e.code === 'BracketRight' ? 1 : -1)));
        r.setSpeed(REPLAY_SPEEDS[j]!);
        break;
      }
      case 'KeyR':
        if (!e.repeat) r.setDirection(r.direction > 0 ? -1 : 1);
        break;
      case 'KeyC':
        if (!e.repeat) {
          this.rig.cycle(shift ? -1 : 1);
          this.preferredMode = this.rig.mode;
        }
        break;
      case 'KeyF':
        if (!e.repeat) this.setCamera(free ? 'follow' : 'free');
        break;
      case 'Tab':
        this.cycleSubject(shift ? -1 : 1);
        break;
      case 'Comma':
        this.stepMarker(-1);
        break;
      case 'Period':
        this.stepMarker(1);
        break;
      case 'Home':
        r.seek(r.start);
        break;
      case 'End':
        r.seek(r.end);
        break;
      case 'KeyP':
        if (!e.repeat) void this.enterPhoto();
        break;
      case 'KeyH':
        if (!e.repeat) this.overlay.clean = !this.overlay.clean;
        break;
      case 'Escape':
      case 'Backspace':
        if (!e.repeat && !this.overlay.closeMenus()) void this.exitReplay();
        break;
      default: {
        const m = /^(?:Digit|Numpad)([1-7])$/.exec(e.code);
        if (m && !e.repeat) this.setCamera(REPLAY_CAMERA_MODES[Number(m[1]) - 1]!);
      }
    }
  }

  private photoKey(e: KeyboardEvent): void {
    if (e.repeat && e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
    const s = this.photo.settings;
    switch (e.code) {
      case 'Escape':
      case 'KeyP':
      case 'Backspace':
        this.exitPhoto();
        break;
      case 'Enter':
      case 'NumpadEnter':
        void this.capture().catch(() => {});
        break;
      case 'KeyH':
        this.photo.clean = !this.photo.clean;
        break;
      case 'KeyG':
        this.photo.set('grid', !s.grid);
        break;
      case 'KeyF':
        this.photo.set('autofocus', !s.autofocus);
        break;
      case 'Space':
        this.togglePlay();
        break;
      case 'ArrowLeft':
        this.replay.step(e.shiftKey ? -10 : -1);
        break;
      case 'ArrowRight':
        this.replay.step(e.shiftKey ? 10 : 1);
        break;
      case 'BracketLeft':
        this.photo.set('fov', Math.max(8, s.fov - 2));
        break;
      case 'BracketRight':
        this.photo.set('fov', Math.min(100, s.fov + 2));
        break;
    }
  }

  private keyUp(e: KeyboardEvent): void {
    // Releases always reach the driving mapper too (nothing can stick).
    this.held.delete(e.code);
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.uiOpen) return;
    this.overlay.poke();
    if (this.highlight) {
      if (this.wallClock - this.highlight.startedWall > 0.25) void this.finishHighlight();
      return;
    }
    if (this.overlay.closeMenus()) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, button: e.button };
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.uiOpen) return;
    this.overlay.poke();
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const mode = this.rig.mode;
    if (mode === 'free') this.rig.free.look(dx, dy, this.d.camera.fov);
    else {
      if (mode !== 'follow') {
        // Grabbing the picture takes the camera: orbit from here.
        this.rig.setMode('follow', true);
        this.preferredMode = 'follow';
        this.rig.follow.clearUser();
      }
      this.rig.follow.orbit(dx, dy);
    }
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (!d.moved && this.photoOn && d.button === 0) this.focusAt(e.clientX, e.clientY);
  }

  private wheel(e: WheelEvent): void {
    if (!this.uiOpen) return;
    e.preventDefault();
    this.overlay.poke();
    const notches = Math.max(-3, Math.min(3, e.deltaY / 100));
    if (this.photoOn) {
      const s = this.photo.settings;
      this.photo.set('fov', Math.round(Math.min(100, Math.max(8, s.fov * Math.pow(1.08, notches)))));
    } else if (this.rig.mode === 'free') this.rig.free.scaleSpeed(notches);
    else if (this.rig.mode === 'follow') this.rig.follow.zoom(notches);
  }

  private pollPad(): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    let pad: Gamepad | null = null;
    try {
      for (const p of navigator.getGamepads()) if (p && p.connected) pad = pad ?? p;
    } catch {
      return;
    }
    if (!pad) return;
    const edge = (i: number): boolean => {
      const on = !!pad!.buttons[i]?.pressed;
      const was = this.padPrev[i] ?? on;
      this.padPrev[i] = on;
      return on && !was;
    };
    const any = pad.buttons.some((b, i) => b.pressed && !(this.padPrev[i] ?? true));
    if (this.highlight) {
      if (any) void this.finishHighlight();
      for (let i = 0; i < pad.buttons.length; i++) this.padPrev[i] = !!pad.buttons[i]!.pressed;
      return;
    }
    if (edge(0)) this.togglePlay();
    if (edge(1) || edge(9)) void (this.photoOn ? Promise.resolve(this.exitPhoto()) : this.exitReplay());
    if (edge(2)) this.rig.cycle(1);
    if (edge(3)) this.cycleSubject(1);
    if (edge(4)) this.replay.setSpeed(REPLAY_SPEEDS[Math.max(0, REPLAY_SPEEDS.indexOf(this.replay.speed) - 1)]!);
    if (edge(5)) this.replay.setSpeed(REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, REPLAY_SPEEDS.indexOf(this.replay.speed) + 1)]!);
    if (edge(14)) this.replay.step(-1);
    if (edge(15)) this.replay.step(1);
    if (edge(8)) this.replay.setDirection(this.replay.direction > 0 ? -1 : 1);
  }

  // ============================================================ debug
  get debug(): ReplaySessionDebug {
    const self = this;
    return {
      get state() {
        return {
          open: self.uiOpen,
          highlight: !!self.highlight,
          crashCam: self.crashCam.phase,
          highlights: self.crashCam.count,
          camera: self.rig.mode,
          shot: self.rig.shotKind,
          cuts: self.rig.director.cutCount,
          lastCut: self.rig.lastCut ? `${self.rig.lastCut.kind}:${self.rig.lastCut.reason}` : null,
          subject: self.subjectId,
          photo: self.photoOn,
          idle: self.overlay.root.classList.contains('rp--idle'),
          clean: self.overlay.clean,
          photoSettings: { ...self.photo.settings },
          lastPhoto: self.lastPhoto,
          dof: self.photoOn && self.photo.settings.dof,
        };
      },
      enter: () => this.enterReplay(),
      exit: () => this.exitReplay(),
      setCamera: (m) => this.setCamera(m),
      cycleSubject: () => this.cycleSubject(1),
      enterPhoto: () => this.enterPhoto(),
      exitPhoto: () => this.exitPhoto(),
      setPhoto: (patch) => {
        for (const k of Object.keys(patch) as (keyof PhotoSettings)[]) this.photo.set(k, patch[k] as never);
      },
      capture: (scale) => this.capture(scale),
      focusAt: (x, y) => this.focusAt(x, y),
      triggerCrashCam: async () => {
        const ms = this.replay.markers();
        if (ms.length === 0) return false;
        let best = ms[0]!;
        for (const m of ms) if (m.severity > best.severity) best = m;
        return this.startHighlight(best.id, true);
      },
      setClean: (c) => {
        this.overlay.clean = c;
        this.photo.clean = c;
      },
    };
  }

  dispose(): void {
    this.closeUi();
    this.unsub();
    window.removeEventListener('blur', this.onBlur);
    this.overlay.dispose();
    this.photo.dispose();
    this.curtain.remove();
    this.flash.remove();
  }
}

export function createReplaySession(deps: ReplaySessionDeps): ReplaySession {
  return new ReplaySession(deps);
}
