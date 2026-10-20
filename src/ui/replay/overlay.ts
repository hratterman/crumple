/**
 * Replay overlay (P7 R2): REPLAY badge, timeline scrubber with crash-marker
 * ticks, transport (markers, reverse, frame step, play, speed), camera +
 * subject readout, and the crash-cam highlight dressing (letterbox, lower
 * third, skip hint). Pure view: the session feeds `update(state)` once per
 * frame and receives intents through `handlers`. DOM writes happen only
 * when a displayed value changes.
 *
 * Auto-hide: everything but the badge fades after IDLE_S without pointer or
 * key activity (never while the pointer is over the dock, a drag is in
 * progress or the camera menu is open); the cursor hides with it.
 */
import './replay.css';
import { REPLAY_CAMERA_LABELS, REPLAY_CAMERA_MODES, type ReplayCameraMode } from '../../render/cameras/replayRig';
import { formatClock, markerStyle, severityWord, speedLabel, timeAtFraction, timelineFraction } from './format';

export const IDLE_S = 2.6;
export const IDLE_FRAMES = 24;
export const OVERLAY_SPEEDS = [0.125, 0.25, 0.5, 1, 2] as const;

export interface OverlayMarker {
  readonly id: number;
  readonly time: number;
  readonly severity: number;
  readonly kind: 'impact' | 'break';
  readonly breaks: number;
}

export interface OverlayState {
  start: number;
  end: number;
  time: number;
  playing: boolean;
  speed: number;
  direction: 1 | -1;
  markers: readonly OverlayMarker[];
  camera: ReplayCameraMode;
  /** What the director is showing ('impact', 'trackside', …) in auto mode. */
  shot: string;
  subject: string;
  subjects: number;
}

export interface OverlayHandlers {
  togglePlay(): void;
  step(frames: number): void;
  setSpeed(speed: number): void;
  toggleReverse(): void;
  /** Drag preview (cheap seek) and the settled seek on release. */
  scrubStart(): void;
  scrub(time: number): void;
  scrubEnd(time: number): void;
  jumpToMarker(id: number): void;
  marker(dir: 1 | -1): void;
  setCamera(mode: ReplayCameraMode): void;
  cycleSubject(): void;
  photo(): void;
  exit(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export const ICONS: Readonly<Record<string, string>> = {
  play: 'M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z',
  pause: 'M6.5 4h3.5a.5.5 0 0 1 .5.5v15a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5v-15a.5.5 0 0 1 .5-.5zm7.5 0h3.5a.5.5 0 0 1 .5.5v15a.5.5 0 0 1-.5.5H14a.5.5 0 0 1-.5-.5v-15A.5.5 0 0 1 14 4z',
  stepBack: 'M6 5h2v14H6zM19 5.8v12.4a.8.8 0 0 1-1.25.66L9.5 12.66a.8.8 0 0 1 0-1.32l8.25-6.2A.8.8 0 0 1 19 5.8z',
  stepFwd: 'M16 5h2v14h-2zM5 5.8v12.4a.8.8 0 0 0 1.25.66l8.25-6.2a.8.8 0 0 0 0-1.32L6.25 5.14A.8.8 0 0 0 5 5.8z',
  reverse: 'M11 6.2v11.6a.7.7 0 0 1-1.1.57L2.5 12.57a.7.7 0 0 1 0-1.14L9.9 5.63A.7.7 0 0 1 11 6.2zm10 0v11.6a.7.7 0 0 1-1.1.57l-7.4-5.8a.7.7 0 0 1 0-1.14l7.4-5.8a.7.7 0 0 1 1.1.57z',
  prevMarker: 'M4 4h2v16H4zm4.5 8L20 4.5v15z',
  nextMarker: 'M18 4h2v16h-2zm-2.5 8L4 19.5v-15z',
  camera: 'M9 4h6l1.6 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.4zm3 4.2a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6zm0 2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z',
  video: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h10A1.5 1.5 0 0 1 16 6.5v2.3l4.2-2.6a.8.8 0 0 1 1.3.7v10.2a.8.8 0 0 1-1.3.7L16 15.2v2.3a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 17.5z',
  target: 'M12 2a1 1 0 0 1 1 1v1.07A8 8 0 0 1 19.93 11H21a1 1 0 1 1 0 2h-1.07A8 8 0 0 1 13 19.93V21a1 1 0 1 1-2 0v-1.07A8 8 0 0 1 4.07 13H3a1 1 0 1 1 0-2h1.07A8 8 0 0 1 11 4.07V3a1 1 0 0 1 1-1zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm0 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  close: 'M5.3 5.3a1 1 0 0 1 1.4 0L12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 0-1.4z',
  download: 'M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l3.3 3.3V4a1 1 0 0 1 1-1zM4 18a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1z',
  aperture: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.6 2.2L8.2 8h6.6l-2.6-3.9a8 8 0 0 0-1.8.1zM15.9 5.2l-2.3 4h4.9a8 8 0 0 0-2.6-4zM19.4 11h-4.6l3.3 5.7a8 8 0 0 0 1.3-5.7zM16.9 18l-2.3-4-3.3 5.7a8 8 0 0 0 5.6-1.7zM9.3 19.6l2.3-4H6.7a8 8 0 0 0 2.6 4zM4.6 13h4.6L5.9 7.3A8 8 0 0 0 4.6 13zm5.1-4.5L8 11.5l1.7 3h3.6l1.7-3-1.7-3z',
};

export function icon(name: string, parent?: Element): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.appendChild(p);
  parent?.appendChild(svg);
  return svg;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const CAMERA_KEYS: Readonly<Record<ReplayCameraMode, string>> = { auto: '1', follow: '2', bumper: '3', trackside: '4', hood: '5', heli: '6', free: '7' };

export class ReplayOverlay {
  readonly root: HTMLDivElement;
  private readonly handlers: OverlayHandlers;
  private readonly rate: HTMLSpanElement;
  private readonly camName: HTMLDivElement;
  private readonly camKicker: HTMLDivElement;
  private readonly subjectEl: HTMLSpanElement;
  private readonly dock: HTMLDivElement;
  private readonly timeline: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly hoverLine: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly markerLayer: HTMLDivElement;
  private readonly markerEls = new Map<number, HTMLDivElement>();
  private readonly timeNow: HTMLSpanElement;
  private readonly timeTotal: HTMLSpanElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly revBtn: HTMLButtonElement;
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private readonly camPillLabel: HTMLSpanElement;
  private readonly camMenu: HTMLDivElement;
  private readonly camOpts = new Map<ReplayCameraMode, HTMLButtonElement>();
  private readonly subjectPill: HTMLButtonElement;
  private readonly hlTitle: HTMLDivElement;
  private readonly hlSpeed: HTMLElement;
  private readonly hlSpeedLabel: HTMLElement;
  private readonly hlMeter: HTMLElement;
  private readonly toast: HTMLDivElement;
  private toastTimer = 0;
  private state: OverlayState | null = null;
  private last = { playing: false, speed: -1, direction: 0, camera: '', shot: '', subject: '', subjects: -1, timeText: '', totalText: '', frac: -1, markerKey: '' };
  private dragging = false;
  private dragMoved = false;
  private dragX = 0;
  private downMarker: number | null = null;
  private hoverDock = false;
  /** performance.now() of the last activity (real time: a slow frame rate must not stretch the idle delay)… */
  private activeAt = 0;
  /** …and the frames drawn since (a single multi-second frame on a software rasterizer must not hide it either). */
  private framesSince = 0;
  private visible = false;
  private _clean = false;

  constructor(parent: HTMLElement, handlers: OverlayHandlers) {
    this.handlers = handlers;
    const root = h('div', 'rp', parent);
    root.hidden = true;
    root.dataset.testid = 'replay-ui';
    this.root = root;

    h('div', 'rp-bar rp-bar--top', root);
    h('div', 'rp-bar rp-bar--bottom', root);
    h('div', 'rp-scrim rp-scrim--top rp-chrome', root);
    h('div', 'rp-scrim rp-scrim--bottom rp-chrome', root);

    // ---- badge
    const badge = h('div', 'rp-badge', root);
    const mark = h('div', 'rp-badge-mark', badge);
    h('span', 'rp-rec', mark);
    h('span', '', mark, 'REPLAY');
    this.rate = h('span', 'rp-badge-rate', badge);

    // ---- camera + subject (top right)
    const tr = h('div', 'rp-top-right rp-chrome', root);
    this.camKicker = h('div', 'rp-cam-kicker', tr, 'Camera');
    this.camName = h('div', 'rp-cam-name', tr, '');
    const sub = h('div', 'rp-cam-sub', tr);
    icon('target', sub).setAttribute('width', '12');
    this.subjectEl = h('span', '', sub, '');

    // ---- crash-cam lower third + skip hint
    const hl = h('div', 'rp-highlight', root);
    h('div', 'rp-highlight-rule', hl);
    const hlText = h('div', '', hl);
    const kick = h('div', 'rp-highlight-kicker', hlText);
    h('span', 'rp-rec', kick);
    h('span', '', kick, 'INSTANT REPLAY');
    this.hlTitle = h('div', 'rp-highlight-title', hlText, 'Impact');
    const hlSub = h('div', 'rp-highlight-sub', hlText);
    this.hlSpeed = h('b', '', hlSub, '—');
    this.hlSpeedLabel = h('span', 'rp-highlight-label', hlSub, 'Speed');
    const meter = h('span', 'rp-meter', hlSub);
    this.hlMeter = h('i', '', meter);
    const skip = h('div', 'rp-skip', root);
    skip.innerHTML = '<span><kbd>Any key</kbd> Skip</span><span><kbd>Backspace</kbd> Keep watching</span>';

    // ---- dock
    const dock = h('div', 'rp-dock rp-chrome', root);
    this.dock = dock;
    dock.addEventListener('pointerenter', () => (this.hoverDock = true));
    dock.addEventListener('pointerleave', () => (this.hoverDock = false));

    const tl = h('div', 'rp-timeline', dock);
    tl.dataset.testid = 'replay-timeline';
    tl.setAttribute('role', 'slider');
    tl.setAttribute('aria-label', 'Replay timeline');
    this.timeline = tl;
    const track = h('div', 'rp-track', tl);
    this.fill = h('div', 'rp-fill', track);
    this.markerLayer = h('div', 'rp-markers', tl);
    this.hoverLine = h('div', 'rp-hover-line', tl);
    this.head = h('div', 'rp-head', tl);
    this.tip = h('div', 'rp-tip', tl);
    tl.addEventListener('pointerdown', (e) => this.onDown(e));
    tl.addEventListener('pointermove', (e) => this.onMove(e));
    tl.addEventListener('pointerup', (e) => this.onUp(e));
    tl.addEventListener('pointercancel', (e) => this.onUp(e));
    tl.addEventListener('pointerleave', () => {
      if (!this.dragging) this.tip.classList.remove('rp-tip--on');
    });

    const row = h('div', 'rp-controls', dock);
    const time = h('div', 'rp-time', row);
    this.timeNow = h('span', 'rp-time-now', time, '0:00.00');
    this.timeTotal = h('span', 'rp-time-total', time, '/ 0:00.00');
    this.timeNow.dataset.testid = 'replay-time';

    const tp = h('div', 'rp-transport', row);
    const btn = (name: string, title: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = h('button', `rp-btn ${cls}`, tp);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      icon(name, b);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    btn('prevMarker', 'Previous crash  ,', () => handlers.marker(-1), 'rp-btn--marker');
    this.revBtn = btn('reverse', 'Reverse  R', () => handlers.toggleReverse());
    btn('stepBack', 'Frame back  ←', () => handlers.step(-1));
    this.playBtn = btn('play', 'Play / pause  Space', () => handlers.togglePlay(), 'rp-btn--play');
    this.playBtn.dataset.testid = 'replay-play';
    btn('stepFwd', 'Frame forward  →', () => handlers.step(1));
    btn('nextMarker', 'Next crash  .', () => handlers.marker(1), 'rp-btn--marker');
    h('span', 'rp-sep', tp);
    const sp = h('div', 'rp-speed', tp);
    sp.setAttribute('role', 'radiogroup');
    sp.setAttribute('aria-label', 'Playback speed  [ ]');
    for (const s of OVERLAY_SPEEDS) {
      const b = h('button', 'rp-speed-opt', sp, speedLabel(s));
      b.type = 'button';
      b.dataset.speed = String(s);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.setSpeed(s);
      });
      this.speedBtns.set(s, b);
    }

    const right = h('div', 'rp-right', row);
    this.subjectPill = h('button', 'rp-pill', right);
    this.subjectPill.type = 'button';
    this.subjectPill.title = 'Next subject  Tab';
    icon('target', this.subjectPill);
    h('span', 'rp-pill-label', this.subjectPill, 'Subject');
    this.subjectPill.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.cycleSubject();
    });
    const camWrap = h('div', 'rp-camwrap', right);
    const camPill = h('button', 'rp-pill', camWrap);
    camPill.type = 'button';
    camPill.title = 'Camera  C';
    camPill.dataset.testid = 'replay-camera';
    icon('video', camPill);
    this.camPillLabel = h('span', 'rp-pill-label', camPill, 'Director');
    this.camMenu = h('div', 'rp-cams', camWrap);
    for (const m of REPLAY_CAMERA_MODES) {
      const o = h('button', 'rp-cam-opt', this.camMenu);
      o.type = 'button';
      o.dataset.camera = m;
      h('span', '', o, REPLAY_CAMERA_LABELS[m]);
      h('kbd', '', o, CAMERA_KEYS[m]);
      o.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.setCamera(m);
        this.camMenu.classList.remove('rp-cams--open');
      });
      this.camOpts.set(m, o);
    }
    camPill.addEventListener('click', (e) => {
      e.stopPropagation();
      this.camMenu.classList.toggle('rp-cams--open');
    });
    const photo = h('button', 'rp-pill rp-pill--accent', right);
    photo.type = 'button';
    photo.title = 'Photo mode  P';
    photo.dataset.testid = 'replay-photo';
    icon('camera', photo);
    h('span', 'rp-pill-label', photo, 'Photo');
    photo.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.photo();
    });
    const exit = h('button', 'rp-pill', right);
    exit.type = 'button';
    exit.title = 'Back to the road  Esc';
    exit.dataset.testid = 'replay-exit';
    icon('close', exit);
    h('span', 'rp-pill-label', exit, 'Exit');
    exit.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.exit();
    });

    const hints = h('div', 'rp-hints', dock);
    hints.innerHTML = [
      ['Space', 'Play'],
      ['← →', 'Frame'],
      ['[ ]', 'Speed'],
      ['R', 'Reverse'],
      ['C · 1–7', 'Camera'],
      ['Tab', 'Subject'],
      ['Drag', 'Orbit'],
      ['P', 'Photo'],
      ['H', 'Hide UI'],
      ['Esc', 'Exit'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');

    this.toast = h('div', 'rp-toast', root);
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /** Hide every control (H): only the picture. */
  get clean(): boolean {
    return this._clean;
  }
  set clean(v: boolean) {
    this._clean = v;
    this.root.classList.toggle('rp--clean', v);
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    this.activeAt = performance.now();
    this.framesSince = 0;
    this.root.classList.remove('rp--idle');
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.root.classList.remove('rp--cinema', 'rp--highlight', 'rp--idle', 'rp--cursorless');
    this.camMenu.classList.remove('rp-cams--open');
    this.dragging = false;
  }

  /** Letterbox bars (crash cam). */
  setCinema(on: boolean): void {
    this.root.classList.toggle('rp--cinema', on);
  }

  /** Crash-cam dressing: transport hidden, lower third + skip hint shown. */
  setHighlight(on: boolean, title = '', severity = 0): void {
    this.root.classList.toggle('rp--highlight', on);
    if (on) {
      this.hlTitle.textContent = title || severityWord(severity);
      this.hlMeter.style.transform = `scaleX(${Math.min(Math.max(severity, 0.05), 1).toFixed(3)})`;
    }
    this.dock.style.display = on ? 'none' : '';
    (this.root.querySelector('.rp-top-right') as HTMLElement).style.display = on ? 'none' : '';
  }

  /** Subject speed in the lower third (display string): live before the impact, then frozen at impact speed. */
  setHighlightSpeed(text: string, label: string): void {
    if (this.hlSpeed.textContent !== text) this.hlSpeed.textContent = text;
    if (this.hlSpeedLabel.textContent !== label) this.hlSpeedLabel.textContent = label;
  }

  /** Any pointer / key activity: chrome back on. */
  poke(): void {
    this.activeAt = performance.now();
    this.framesSince = 0;
    // Show at once (a slow frame must not delay the chrome coming back).
    if (this.root.classList.contains('rp--idle')) this.root.classList.remove('rp--idle', 'rp--cursorless');
  }

  showToast(text: string, ms = 1600): void {
    this.toast.textContent = text;
    this.toast.classList.add('rp-toast--on');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('rp-toast--on'), ms);
  }

  closeMenus(): boolean {
    const open = this.camMenu.classList.contains('rp-cams--open');
    this.camMenu.classList.remove('rp-cams--open');
    return open;
  }

  update(s: OverlayState, wallDt: number): void {
    this.state = s;
    if (!this.visible) return;
    const L = this.last;
    // ---- auto-hide
    void wallDt;
    const menuOpen = this.camMenu.classList.contains('rp-cams--open');
    this.framesSince++;
    const idle = performance.now() - this.activeAt > IDLE_S * 1000 && this.framesSince > IDLE_FRAMES && !this.hoverDock && !this.dragging && !menuOpen;
    this.root.classList.toggle('rp--idle', idle);
    this.root.classList.toggle('rp--cursorless', idle || this._clean);

    // ---- badge + transport state
    if (s.playing !== L.playing) {
      L.playing = s.playing;
      this.root.classList.toggle('rp--paused', !s.playing);
      this.playBtn.replaceChildren();
      icon(s.playing ? 'pause' : 'play', this.playBtn);
    }
    if (s.speed !== L.speed || s.direction !== L.direction) {
      L.speed = s.speed;
      L.direction = s.direction;
      this.rate.textContent = s.speed === 1 && s.direction === 1 ? '' : `${s.direction < 0 ? '◂ ' : ''}${speedLabel(s.speed)}`;
      for (const [v, b] of this.speedBtns) {
        const on = v === s.speed;
        b.classList.toggle('rp-speed-opt--on', on);
        b.setAttribute('aria-checked', String(on));
      }
      this.revBtn.classList.toggle('rp-btn--on', s.direction < 0);
    }
    if (s.camera !== L.camera || s.shot !== L.shot) {
      L.camera = s.camera;
      L.shot = s.shot;
      const shotLabel = s.shot === 'impact' ? 'Impact' : (REPLAY_CAMERA_LABELS[s.shot as ReplayCameraMode] ?? s.shot);
      this.camKicker.textContent = s.camera === 'auto' ? 'Director' : 'Camera';
      this.camName.textContent = s.camera === 'auto' ? shotLabel : REPLAY_CAMERA_LABELS[s.camera];
      this.camPillLabel.textContent = REPLAY_CAMERA_LABELS[s.camera];
      for (const [m, o] of this.camOpts) o.classList.toggle('rp-cam-opt--on', m === s.camera);
    }
    if (s.subject !== L.subject || s.subjects !== L.subjects) {
      L.subject = s.subject;
      L.subjects = s.subjects;
      this.subjectEl.textContent = s.subjects > 1 ? `${s.subject} · Tab` : s.subject;
      this.subjectPill.style.display = s.subjects > 1 ? '' : 'none';
    }

    // ---- time
    const tNow = formatClock(s.time - s.start);
    if (tNow !== L.timeText) {
      L.timeText = tNow;
      this.timeNow.textContent = tNow;
    }
    const tTot = `/ ${formatClock(s.end - s.start)}`;
    if (tTot !== L.totalText) {
      L.totalText = tTot;
      this.timeTotal.textContent = tTot;
    }
    const frac = timelineFraction(s.time, s.start, s.end);
    if (Math.abs(frac - L.frac) > 1e-5) {
      L.frac = frac;
      this.fill.style.transform = `scaleX(${frac.toFixed(5)})`;
      this.head.style.left = `${(frac * 100).toFixed(3)}%`;
      this.timeline.setAttribute('aria-valuenow', (s.time - s.start).toFixed(2));
    }

    // ---- markers (re-laid only when the set or the buffer span changes)
    const key = `${s.start.toFixed(3)}|${s.end.toFixed(3)}|${s.markers.length}|${s.markers.length ? s.markers[s.markers.length - 1]!.id + ':' + s.markers[s.markers.length - 1]!.severity.toFixed(3) : ''}`;
    if (key !== L.markerKey) {
      L.markerKey = key;
      this.layoutMarkers(s);
    }
  }

  private layoutMarkers(s: OverlayState): void {
    const seen = new Set<number>();
    for (const m of s.markers) {
      seen.add(m.id);
      let el = this.markerEls.get(m.id);
      if (!el) {
        el = h('div', 'rp-marker', this.markerLayer);
        el.dataset.marker = String(m.id);
        el.dataset.testid = 'replay-marker';
        this.markerEls.set(m.id, el);
      }
      const st = markerStyle(m.severity);
      el.style.left = `${(timelineFraction(m.time, s.start, s.end) * 100).toFixed(3)}%`;
      el.style.height = `${st.height}px`;
      el.style.width = `${st.width}px`;
      el.style.background = st.color;
      el.style.boxShadow = st.glow ? `0 0 ${st.glow}px ${st.color}` : 'none';
      el.dataset.severity = m.severity.toFixed(2);
    }
    for (const [id, el] of this.markerEls) {
      if (!seen.has(id)) {
        el.remove();
        this.markerEls.delete(id);
      }
    }
  }

  // ------------------------------------------------------------ timeline drag
  private timeAtX(clientX: number): number {
    const r = this.timeline.getBoundingClientRect();
    const s = this.state;
    if (!s || r.width <= 0) return 0;
    return timeAtFraction((clientX - r.left) / r.width, s.start, s.end);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.state) return;
    e.preventDefault();
    e.stopPropagation();
    this.timeline.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.dragMoved = false;
    this.dragX = e.clientX;
    const t = e.target as HTMLElement;
    this.downMarker = t.dataset.marker !== undefined ? Number(t.dataset.marker) : null;
    this.timeline.classList.add('rp-timeline--drag');
    if (this.downMarker === null) {
      this.handlers.scrubStart();
      this.handlers.scrub(this.timeAtX(e.clientX));
      this.dragMoved = true;
    }
  }

  private onMove(e: PointerEvent): void {
    this.poke();
    const s = this.state;
    if (!s) return;
    const t = this.timeAtX(e.clientX);
    const r = this.timeline.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    this.hoverLine.style.left = `${x}px`;
    // Tooltip: the marker under the pointer, else the time.
    const near = (e.target as HTMLElement).dataset.marker;
    const m = near !== undefined ? s.markers.find((k) => k.id === Number(near)) : undefined;
    this.tip.innerHTML = m
      ? `<b style="color:${markerStyle(m.severity).color}">${severityWord(m.severity)}</b>${formatClock(m.time - s.start)} <small>· ${Math.round(m.severity * 100)} %${m.breaks > 0 ? ` · ${m.breaks} beams` : ''}</small>`
      : formatClock(t - s.start);
    this.tip.style.left = `${Math.min(Math.max(x, 40), r.width - 40)}px`;
    this.tip.classList.add('rp-tip--on');
    if (!this.dragging) return;
    if (!this.dragMoved && Math.abs(e.clientX - this.dragX) > 4) {
      this.dragMoved = true;
      this.downMarker = null;
      this.handlers.scrubStart();
    }
    if (this.dragMoved) this.handlers.scrub(t);
  }

  private onUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.timeline.classList.remove('rp-timeline--drag');
    try {
      this.timeline.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (this.downMarker !== null && !this.dragMoved) {
      this.handlers.jumpToMarker(this.downMarker);
      this.downMarker = null;
      return;
    }
    this.handlers.scrubEnd(this.timeAtX(e.clientX));
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    this.root.remove();
  }
}
