/**
 * Photo mode panel (P7 R2): camera (FOV, roll), focus (DoF on/off,
 * autofocus on the subject or click-to-focus distance, aperture), look
 * (grade presets, exposure, vignette, grain), frame (aspect + thirds grid)
 * and capture (1× / 2× PNG with a download link). Pure view over
 * PhotoSettings; the session applies them to the camera rig and post.
 */
import { GRADE_PRESET_IDS, GRADE_PRESETS, type GradePresetId } from '../../render/cameras/photoFx';
import { F_STOPS, fitAspect, PHOTO_ASPECTS } from './format';
import { h, icon } from './overlay';

export interface PhotoSettings {
  fov: number;
  /** Degrees. */
  roll: number;
  dof: boolean;
  autofocus: boolean;
  /** Focus distance, m (autofocus writes it too). */
  focus: number;
  fStop: number;
  preset: GradePresetId;
  exposure: number;
  vignette: number;
  grain: number;
  aspect: string;
  grid: boolean;
  scale: 1 | 2;
  /** R-GFX: world time of day, local solar hours (the session seeds it from the world on entry). */
  timeOfDay: number;
}

export const DEFAULT_PHOTO_SETTINGS: Readonly<PhotoSettings> = {
  fov: 40,
  roll: 0,
  dof: true,
  autofocus: true,
  focus: 8,
  fStop: 2.8,
  preset: 'natural',
  exposure: 0,
  vignette: 0.25,
  grain: 0.12,
  aspect: 'free',
  grid: false,
  scale: 2,
  timeOfDay: 17.25,
};

export interface PhotoHandlers {
  change(s: Readonly<PhotoSettings>, key: keyof PhotoSettings): void;
  capture(): void;
  close(): void;
}

/** Preview swatch per look (a sky-to-asphalt gradient through the grade's mood). */
const SWATCH: Readonly<Record<GradePresetId, string>> = {
  natural: 'linear-gradient(160deg,#8fb7e0 0%,#e9c79a 48%,#5d5a55 52%,#2f2d2b 100%)',
  vivid: 'linear-gradient(160deg,#5aa8ff 0%,#ffbf6b 48%,#5d5348 52%,#24201c 100%)',
  film: 'linear-gradient(160deg,#9fb6c4 0%,#e8cfa4 48%,#6a6258 52%,#34302d 100%)',
  golden: 'linear-gradient(160deg,#f5b46a 0%,#ffd08a 48%,#6e5640 52%,#2d2117 100%)',
  tealOrange: 'linear-gradient(160deg,#4fa3b3 0%,#ffae6b 48%,#3e4b50 52%,#14262b 100%)',
  steel: 'linear-gradient(160deg,#9bb2c9 0%,#c9d3dc 48%,#4f5862 52%,#22282e 100%)',
  bleach: 'linear-gradient(160deg,#aab4ba 0%,#d6d2c8 48%,#4d4b47 52%,#141414 100%)',
  noir: 'linear-gradient(160deg,#c9c9c9 0%,#e6e6e6 48%,#4c4c4c 52%,#0d0d0d 100%)',
};

interface Slider {
  input: HTMLInputElement;
  out: HTMLOutputElement;
  fmt: (v: number) => string;
  toUi: (v: number) => number;
  fromUi: (u: number) => number;
}

const FOCUS_MIN = 0.5;
const FOCUS_MAX = 250;
const focusToUi = (m: number): number => Math.log(Math.max(m, FOCUS_MIN) / FOCUS_MIN) / Math.log(FOCUS_MAX / FOCUS_MIN);
const uiToFocus = (u: number): number => FOCUS_MIN * Math.pow(FOCUS_MAX / FOCUS_MIN, u);

export class PhotoPanel {
  readonly root: HTMLDivElement;
  readonly settings: PhotoSettings = { ...DEFAULT_PHOTO_SETTINGS };
  private readonly handlers: PhotoHandlers;
  private readonly sliders = new Map<keyof PhotoSettings, Slider>();
  private readonly toggles = new Map<keyof PhotoSettings, HTMLButtonElement>();
  private readonly lookBtns = new Map<GradePresetId, HTMLButtonElement>();
  private readonly aspectBtns = new Map<string, HTMLButtonElement>();
  private readonly scaleBtns = new Map<number, HTMLButtonElement>();
  private readonly masks: HTMLDivElement[] = [];
  private readonly frameEl: HTMLDivElement;
  private readonly reticle: HTMLDivElement;
  private readonly reticleText: HTMLSpanElement;
  private readonly resText: HTMLSpanElement;
  private readonly shootBtn: HTMLButtonElement;
  private readonly shot: HTMLDivElement;
  private readonly shotImg: HTMLImageElement;
  private readonly shotTitle: HTMLElement;
  private readonly shotSub: HTMLElement;
  private readonly shotLink: HTMLAnchorElement;
  private shotTimer = 0;
  private shotUrl: string | null = null;
  private _open = false;
  private _clean = false;

  constructor(parent: HTMLElement, handlers: PhotoHandlers) {
    this.handlers = handlers;
    const root = h('div', 'ph', parent);
    root.hidden = true;
    root.dataset.testid = 'photo-mode';
    this.root = root;

    for (let i = 0; i < 4; i++) this.masks.push(h('div', 'ph-mask', root));
    this.frameEl = h('div', 'ph-frame', root);
    h('div', 'ph-grid', this.frameEl);
    this.reticle = h('div', 'ph-reticle', root);
    this.reticleText = h('span', '', this.reticle);

    const badge = h('div', 'ph-badge', root);
    icon('aperture', badge);
    h('span', '', badge, 'PHOTO MODE');
    const hints = h('div', 'ph-hints', root);
    hints.innerHTML = [
      ['W A S D', 'Move'],
      ['Q E', 'Down / up'],
      ['Shift', 'Fast'],
      ['Drag', 'Look'],
      ['Wheel', 'Zoom'],
      ['Click', 'Focus'],
      ['H', 'Hide UI'],
      ['Enter', 'Capture'],
      ['Esc', 'Back'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');

    const panel = h('div', 'ph-panel', root);
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    const head = h('div', 'ph-head', panel);
    h('div', 'ph-title', head, 'Photo mode');
    const close = h('button', 'ph-close', head);
    close.type = 'button';
    close.title = 'Back to replay  Esc';
    close.dataset.testid = 'photo-close';
    icon('close', close);
    close.addEventListener('click', () => handlers.close());

    const scroll = h('div', 'ph-scroll', panel);
    // ---- camera
    let sec = this.section(scroll, 'Camera');
    this.slider(sec, 'fov', 'Field of view', 8, 100, 1, (v) => `${Math.round(v)}°`);
    this.slider(sec, 'roll', 'Roll', -45, 45, 0.5, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`);
    // ---- focus
    sec = this.section(scroll, 'Focus');
    this.toggle(sec, 'dof', 'Depth of field');
    this.toggle(sec, 'autofocus', 'Autofocus on subject');
    this.slider(sec, 'focus', 'Distance', 0, 1, 0.001, (v) => (v >= 100 ? `${Math.round(v)} m` : `${v.toFixed(1)} m`), focusToUi, uiToFocus);
    this.slider(
      sec,
      'fStop',
      'Aperture',
      0,
      F_STOPS.length - 1,
      1,
      (v) => `ƒ/${v}`,
      (v) => Math.max(0, F_STOPS.indexOf(v)),
      (u) => F_STOPS[Math.round(u)]!,
    );
    h('p', 'ph-note', sec, 'Click anywhere in the picture to focus there.');
    // ---- look
    sec = this.section(scroll, 'Look');
    const looks = h('div', 'ph-looks', sec);
    for (const id of GRADE_PRESET_IDS) {
      const b = h('button', 'ph-look', looks);
      b.type = 'button';
      b.dataset.look = id;
      const sw = h('i', '', b);
      sw.style.background = SWATCH[id];
      h('span', '', b, GRADE_PRESETS[id].label);
      b.addEventListener('click', () => this.set('preset', id));
      this.lookBtns.set(id, b);
    }
    this.slider(sec, 'exposure', 'Exposure', -2, 2, 0.05, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`);
    this.slider(sec, 'vignette', 'Vignette', 0, 1, 0.01, (v) => `${Math.round(v * 100)}`);
    this.slider(sec, 'grain', 'Film grain', 0, 1, 0.01, (v) => `${Math.round(v * 100)}`);
    // ---- light (R-GFX): the sun, sky, shadows and lamps follow the world's time of day
    sec = this.section(scroll, 'Light');
    this.slider(sec, 'timeOfDay', 'Time of day', 0, 23.99, 0.05, (v) => {
      const m = Math.round(v * 60) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    });
    // ---- frame
    sec = this.section(scroll, 'Frame');
    const chips = h('div', 'ph-chips', sec);
    for (const a of PHOTO_ASPECTS) {
      const b = h('button', 'ph-chip', chips, a.label);
      b.type = 'button';
      b.dataset.aspect = a.id;
      b.addEventListener('click', () => this.set('aspect', a.id));
      this.aspectBtns.set(a.id, b);
    }
    this.toggle(sec, 'grid', 'Rule-of-thirds grid');

    // ---- capture
    const foot = h('div', 'ph-foot', panel);
    const res = h('div', 'ph-res', foot);
    this.resText = h('span', '', res, '');
    const sc = h('div', 'ph-chips', res);
    for (const s of [1, 2] as const) {
      const b = h('button', 'ph-chip', sc, `${s}×`);
      b.type = 'button';
      b.title = s === 2 ? 'Supersampled: rendered at twice the resolution' : 'Screen resolution';
      b.addEventListener('click', () => this.set('scale', s));
      this.scaleBtns.set(s, b);
    }
    this.shootBtn = h('button', 'ph-shoot', foot);
    this.shootBtn.type = 'button';
    this.shootBtn.dataset.testid = 'photo-capture';
    icon('camera', this.shootBtn);
    h('span', '', this.shootBtn, 'Take photo');
    this.shootBtn.addEventListener('click', () => handlers.capture());

    // ---- capture result
    this.shot = h('div', 'ph-shot', root);
    this.shot.dataset.testid = 'photo-result';
    this.shotImg = h('img', '', this.shot);
    this.shotImg.alt = 'Captured photo';
    const st = h('div', 'ph-shot-text', this.shot);
    this.shotTitle = h('b', '', st, 'Photo saved');
    this.shotSub = h('small', '', st, '');
    this.shotLink = h('a', 'ph-download', this.shot);
    this.shotLink.dataset.testid = 'photo-download';
    icon('download', this.shotLink);
    h('span', '', this.shotLink, 'Download PNG');

    this.sync();
  }

  get isOpen(): boolean {
    return this._open;
  }

  get clean(): boolean {
    return this._clean;
  }
  set clean(v: boolean) {
    this._clean = v;
    this.root.classList.toggle('ph--clean', v);
  }

  open(): void {
    this._open = true;
    this.root.hidden = false;
    this.clean = false;
    this.sync();
  }

  close(): void {
    this._open = false;
    this.root.hidden = true;
    this.shot.classList.remove('ph-shot--on');
  }

  /** Programmatic change (wheel zoom, autofocus, tests). */
  set<K extends keyof PhotoSettings>(key: K, value: PhotoSettings[K], notify = true): void {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this.sync();
    if (notify) this.handlers.change(this.settings, key);
  }

  /** Masks + thirds grid for the chosen aspect over a w × h viewport (CSS px). */
  layout(w: number, hgt: number): void {
    const a = PHOTO_ASPECTS.find((x) => x.id === this.settings.aspect);
    const r = fitAspect(w, hgt, a ? a.ratio : null);
    const [top, bottom, left, right] = this.masks as [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement];
    Object.assign(top.style, { left: '0px', top: '0px', width: `${w}px`, height: `${r.y}px` });
    Object.assign(bottom.style, { left: '0px', top: `${r.y + r.h}px`, width: `${w}px`, height: `${hgt - r.y - r.h}px` });
    Object.assign(left.style, { left: '0px', top: `${r.y}px`, width: `${r.x}px`, height: `${r.h}px` });
    Object.assign(right.style, { left: `${r.x + r.w}px`, top: `${r.y}px`, width: `${w - r.x - r.w}px`, height: `${r.h}px` });
    Object.assign(this.frameEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  setOutputSize(w: number, hgt: number): void {
    this.resText.textContent = `Output ${w} × ${hgt}`;
  }

  setBusy(busy: boolean): void {
    this.shootBtn.disabled = busy;
    (this.shootBtn.lastChild as HTMLElement).textContent = busy ? 'Developing…' : 'Take photo';
  }

  /** Focus feedback at a screen point (CSS px). */
  focusAt(x: number, y: number, distance: number | null): void {
    const r = this.reticle;
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    this.reticleText.textContent = distance === null ? 'No target' : distance >= 100 ? `${Math.round(distance)} m` : `${distance.toFixed(1)} m`;
    r.classList.remove('ph-reticle--go');
    void r.offsetWidth;
    r.classList.add('ph-reticle--go');
  }

  /** A finished capture: thumbnail + download link (the object URL is revoked on the next one). */
  showShot(url: string, fileName: string, w: number, hgt: number, bytes: number): void {
    if (this.shotUrl) URL.revokeObjectURL(this.shotUrl);
    this.shotUrl = url;
    this.shotImg.src = url;
    this.shotLink.href = url;
    this.shotLink.download = fileName;
    this.shotTitle.textContent = 'Photo developed';
    this.shotSub.textContent = `${w} × ${hgt} · ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    this.shot.classList.add('ph-shot--on');
    window.clearTimeout(this.shotTimer);
    this.shotTimer = window.setTimeout(() => this.shot.classList.remove('ph-shot--on'), 12000);
  }

  get lastShotUrl(): string | null {
    return this.shotUrl;
  }

  dispose(): void {
    if (this.shotUrl) URL.revokeObjectURL(this.shotUrl);
    window.clearTimeout(this.shotTimer);
    this.root.remove();
  }

  // ------------------------------------------------------------ building blocks
  private section(parent: HTMLElement, title: string): HTMLDivElement {
    const s = h('div', 'ph-sec', parent);
    h('div', 'ph-sec-title', s, title);
    return s;
  }

  private slider(
    parent: HTMLElement,
    key: keyof PhotoSettings,
    label: string,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string,
    toUi: (v: number) => number = (v) => v,
    fromUi: (u: number) => number = (u) => u,
  ): void {
    const row = h('div', 'ph-row', parent);
    const id = `ph-${key}`;
    const lab = h('label', '', row, label);
    lab.htmlFor = id;
    const input = h('input', 'ph-range', row);
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.testid = `photo-${key}`;
    const out = h('output', '', row);
    input.addEventListener('input', () => {
      const v = fromUi(Number(input.value));
      if (key === 'focus') this.settings.autofocus = false;
      (this.settings as unknown as Record<string, unknown>)[key] = v;
      this.sync();
      this.handlers.change(this.settings, key);
    });
    // Keys go to the slider, never to the camera.
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.sliders.set(key, { input, out, fmt, toUi, fromUi });
  }

  private toggle(parent: HTMLElement, key: keyof PhotoSettings, label: string): void {
    const b = h('button', 'ph-toggle', parent);
    b.type = 'button';
    b.dataset.testid = `photo-${key}`;
    h('span', '', b, label);
    h('span', 'ph-switch', b);
    b.setAttribute('role', 'switch');
    b.addEventListener('click', () => this.set(key, !this.settings[key] as never));
    this.toggles.set(key, b);
  }

  private sync(): void {
    const s = this.settings;
    for (const [key, sl] of this.sliders) {
      const v = s[key] as number;
      const u = sl.toUi(v);
      if (document.activeElement !== sl.input) sl.input.value = String(u);
      const min = Number(sl.input.min);
      const max = Number(sl.input.max);
      sl.input.style.setProperty('--pct', `${(((u - min) / (max - min)) * 100).toFixed(1)}%`);
      sl.out.textContent = sl.fmt(v);
    }
    for (const [key, b] of this.toggles) {
      const on = !!s[key];
      b.classList.toggle('ph-toggle--on', on);
      b.setAttribute('aria-checked', String(on));
    }
    const dofRows = ['focus', 'fStop'] as const;
    for (const k of dofRows) {
      const row = this.sliders.get(k)?.input.parentElement;
      if (row) row.style.opacity = s.dof ? '1' : '0.4';
    }
    for (const [id, b] of this.lookBtns) b.classList.toggle('ph-look--on', id === s.preset);
    for (const [id, b] of this.aspectBtns) b.classList.toggle('ph-chip--on', id === s.aspect);
    for (const [v, b] of this.scaleBtns) b.classList.toggle('ph-chip--on', v === s.scale);
    this.root.classList.toggle('ph--grid', s.grid);
  }
}
