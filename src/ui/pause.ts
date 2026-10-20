/**
 * Pause menu (P6 S1): Escape / P / gamepad Start. The sim is paused
 * (timescale 0) while it is open and the world shows frozen behind a
 * blurred glass overlay. Sections: resume, replay & photo (P7), choose vehicle (showroom), spawn
 * point (the layout's named spawns), settings (quality preset, traffic,
 * units, TC default, camera framing / FOV, P8 sound: mute + master / engine / effects / ambience volumes), controls
 * and restart (full repair at the current spawn point, props re-placed).
 *
 * Navigation: ↑/↓ menu, → / Enter into a section, ← / Esc back out, Esc in
 * the menu resumes; settings rows change with ←/→; gamepad D-pad / stick,
 * A, B. Keys never reach the driving mapper while open (capture phase).
 */
import './pause.css';
import type { GameSettings } from '../app/settings';
import { firstGamepad, keyIntent, moveFocus, PadNav, type NavIntent } from './showroom/nav';

export type PauseSection = 'resume' | 'challenges' | 'replay' | 'vehicle' | 'spawn' | 'settings' | 'controls' | 'restart';
export const PAUSE_SECTIONS: readonly PauseSection[] = ['resume', 'challenges', 'replay', 'vehicle', 'spawn', 'settings', 'controls', 'restart'];

export interface PauseSpawn {
  id: string;
  name: string;
}

export type QualityLevelName = 'low' | 'medium' | 'high' | 'ultra';

export interface PauseMenuOptions {
  spawns: () => readonly PauseSpawn[];
  spawnIndex: () => number;
  vehicle: () => { name: string; className: string; paint: string };
  settings: () => Readonly<GameSettings>;
  quality: () => QualityLevelName;
  onResume: () => void;
  onChooseVehicle: () => void;
  onSpawn: (index: number) => void;
  onRestart: () => void;
  onSettings: (patch: Partial<GameSettings>) => void;
  onQuality: (level: QualityLevelName) => void;
  /** P7 (R2): open the live replay / photo mode (the menu closes first). */
  onReplay?: () => void;
  onPhoto?: () => void;
  /** Seconds held in the replay buffer and crash markers in it. */
  replayInfo?: () => { seconds: number; crashes: number };
  /** P8: stunt challenges — browse (select screen), and restart / quit the running one (name, or null). */
  onChallenges?: () => void;
  challengeActive?: () => string | null;
  onChallengeRestart?: () => void;
  onChallengeQuit?: () => void;
}

const LABELS: Readonly<Record<PauseSection, string>> = {
  resume: 'Resume',
  challenges: 'Stunt challenges',
  replay: 'Replay & photo',
  vehicle: 'Choose vehicle',
  spawn: 'Spawn point',
  settings: 'Settings',
  controls: 'Controls',
  restart: 'Restart',
};
const SUBS: Readonly<Record<PauseSection, string>> = {
  resume: 'Back to the road',
  challenges: 'Jumps · rolls · drifts · medals',
  replay: 'Rewind · slow-mo · photo mode',
  vehicle: 'Showroom · paint',
  spawn: 'Teleport anywhere',
  settings: 'Graphics · traffic · camera · sound',
  controls: 'Keyboard · gamepad',
  restart: 'Repair at the start',
};

/** Spawn-id → zone tag shown on the spawn cards. */
function zoneOf(id: string): string {
  if (/highway/.test(id)) return 'Highway';
  if (/summit|mountain|pass/.test(id)) return 'Mountain';
  if (/dirt|trail/.test(id)) return 'Dirt';
  if (/lake|shore/.test(id)) return 'Lake';
  if (/arena|crash/.test(id)) return 'Arena';
  if (/town|street/.test(id)) return 'Town';
  return 'Valley';
}

/** Settings rows drawn as level meters (P8 audio volumes). */
const METER_ROWS = new Set(['volume', 'engineVolume', 'effectsVolume', 'ambienceVolume']);

interface Row<T extends string | number | boolean> {
  key: string;
  label: string;
  note?: string;
  options: readonly { value: T; label: string }[];
  get: () => T;
  set: (v: T) => void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class PauseMenu {
  readonly root: HTMLDivElement;
  private readonly opts: PauseMenuOptions;
  private readonly menu: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly vehicleName: HTMLDivElement;
  private readonly vehicleSub: HTMLDivElement;
  private readonly items = new Map<PauseSection, HTMLButtonElement>();
  private section: PauseSection = 'resume';
  private _open = false;
  private readonly pad = new PadNav();
  private rows: Row<string | number | boolean>[] = [];
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(parent: HTMLElement, opts: PauseMenuOptions) {
    this.opts = opts;
    const root = h('div', 'pm', parent);
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Pause menu');
    root.dataset.testid = 'pause-menu';
    this.root = root;

    const side = h('div', 'pm-side', root);
    const kicker = h('div', 'pm-kicker', side);
    kicker.innerHTML = '<span class="pm-pulse"></span>Paused';
    this.vehicleName = h('div', 'pm-vehicle', side);
    this.vehicleSub = h('div', 'pm-vehicle-sub', side);
    const menu = h('nav', 'pm-menu', side);
    menu.setAttribute('aria-label', 'Pause menu');
    this.menu = menu;
    for (const s of PAUSE_SECTIONS) {
      const b = h('button', 'pm-item', menu);
      b.dataset.section = s;
      b.dataset.nav = '';
      b.dataset.testid = `pause-${s}`;
      h('span', 'pm-item-label', b, LABELS[s]);
      h('span', 'pm-item-sub', b, SUBS[s]);
      b.addEventListener('click', () => this.activate(s));
      b.addEventListener('focus', () => this.preview(s));
      b.addEventListener('mouseenter', () => {
        if (this.menu.contains(document.activeElement)) b.focus({ preventScroll: true });
      });
      this.items.set(s, b);
    }

    this.panel = h('section', 'pm-panel', root);
    const foot = h('div', 'pm-foot', root);
    foot.innerHTML = [
      ['↑ ↓', 'Navigate'],
      ['Enter', 'Select'],
      ['Esc', 'Back / resume'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');
  }

  get isOpen(): boolean {
    return this._open;
  }

  get currentSection(): PauseSection {
    return this.section;
  }

  open(section: PauseSection = 'resume'): void {
    if (!this._open) {
      this._open = true;
      this.root.hidden = false;
      this.root.classList.remove('pm--in');
      void this.root.offsetWidth;
      this.root.classList.add('pm--in');
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('keyup', this.onKey, true);
      this.pad.reset();
    }
    const v = this.opts.vehicle();
    this.vehicleName.textContent = v.name;
    const spawn = this.opts.spawns()[this.opts.spawnIndex()];
    this.vehicleSub.textContent = `${v.className} · ${v.paint}${spawn ? ` · ${spawn.name}` : ''}`;
    this.preview(section);
    this.items.get(section)?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
  }

  /** Per frame while open: gamepad navigation. */
  frame(dtS: number): void {
    if (!this._open) return;
    for (const i of this.pad.poll(firstGamepad(), dtS)) this.intent(i);
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }

  /** Re-renders the visible section (settings changed elsewhere, e.g. X toggled TC). */
  refresh(): void {
    if (this._open) this.renderPanel();
  }

  // ------------------------------------------------------------ navigation
  private inPanel(): boolean {
    return this.panel.contains(document.activeElement);
  }

  private intent(i: NavIntent): void {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.dataset.row !== undefined ? this.rows.find((r) => r.key === active!.dataset.row) : undefined;
    switch (i) {
      case 'up':
      case 'down':
        if (!moveFocus(this.inPanel() ? this.panel : this.menu, i) && !this.inPanel()) {
          const list = [...this.items.values()];
          const k = list.indexOf(active as HTMLButtonElement);
          list[(k + (i === 'down' ? 1 : -1) + list.length) % list.length]?.focus();
        }
        break;
      case 'left':
        if (row) this.stepRow(row, -1);
        else if (this.inPanel()) {
          if (!moveFocus(this.panel, 'left')) this.items.get(this.section)?.focus();
        }
        break;
      case 'right':
        if (row) this.stepRow(row, 1);
        else if (this.inPanel()) moveFocus(this.panel, 'right');
        else this.enterPanel();
        break;
      case 'accept':
        if (active && this.root.contains(active)) active.click();
        break;
      case 'back':
        if (this.inPanel()) this.items.get(this.section)?.focus();
        else this.opts.onResume();
        break;
      case 'prev':
      case 'next':
        break;
    }
  }

  private key(e: KeyboardEvent): void {
    if (!this._open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Tab' || /^F\d+$/.test(e.code)) return;
    // Nothing reaches the driving mapper while the menu is open.
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    // P toggles the menu like Escape.
    const i = e.code === 'KeyP' ? 'back' : keyIntent(e.code);
    if (!i) return;
    e.preventDefault();
    if (e.repeat && (i === 'accept' || i === 'back')) return;
    if (e.code === 'KeyP') {
      this.opts.onResume();
      return;
    }
    this.intent(i);
  }

  private enterPanel(): void {
    const first = this.panel.querySelector<HTMLElement>('[data-nav]');
    first?.focus();
  }

  private activate(s: PauseSection): void {
    if (s === 'resume') {
      this.opts.onResume();
      return;
    }
    if (s === 'vehicle') {
      this.opts.onChooseVehicle();
      return;
    }
    this.preview(s);
    this.enterPanel();
  }

  private preview(s: PauseSection): void {
    if (this.section === s && this.panel.childElementCount > 0) return;
    this.section = s;
    for (const [k, b] of this.items) b.classList.toggle('pm-item--on', k === s);
    this.renderPanel();
  }

  // ------------------------------------------------------------ sections
  private renderPanel(): void {
    const p = this.panel;
    p.replaceChildren();
    p.dataset.section = this.section;
    this.rows = [];
    p.classList.remove('pm-panel--in');
    void p.offsetWidth;
    p.classList.add('pm-panel--in');
    switch (this.section) {
      case 'resume':
      case 'vehicle':
        this.renderOverview(p);
        break;
      case 'replay':
        this.renderReplay(p);
        break;
      case 'challenges':
        this.renderChallenges(p);
        break;
      case 'spawn':
        this.renderSpawns(p);
        break;
      case 'settings':
        this.renderSettings(p);
        break;
      case 'controls':
        this.renderControls(p);
        break;
      case 'restart':
        this.renderRestart(p);
        break;
    }
  }

  private head(p: HTMLElement, title: string, sub: string): void {
    h('div', 'pm-panel-kicker', p, sub);
    h('h2', 'pm-panel-title', p, title);
  }

  private renderOverview(p: HTMLElement): void {
    const v = this.opts.vehicle();
    const spawn = this.opts.spawns()[this.opts.spawnIndex()];
    this.head(p, this.section === 'vehicle' ? 'Showroom' : 'Session', this.section === 'vehicle' ? 'Choose vehicle' : 'Paused');
    const grid = h('div', 'pm-overview', p);
    const card = (label: string, value: string): void => {
      const c = h('div', 'pm-ov-card', grid);
      h('span', 'pm-ov-label', c, label);
      h('span', 'pm-ov-value', c, value);
    };
    card('Vehicle', v.name);
    card('Paint', v.paint);
    card('Location', spawn ? spawn.name : '—');
    card('Quality', this.opts.quality().toUpperCase());
    h(
      'p',
      'pm-note',
      p,
      this.section === 'vehicle'
        ? 'Step into the studio: pick a car and a paint, then drive it out at the start point you choose.'
        : 'The world is frozen. Press Esc or Start to drive on.',
    );
  }

  private renderChallenges(p: HTMLElement): void {
    const active = this.opts.challengeActive?.() ?? null;
    this.head(p, 'Stunt challenges', active ? `Running · ${active}` : 'Ten events · medals · ghosts');
    const row = h('div', 'pm-replay-actions', p);
    const btn = (label: string, testid: string, ghost: boolean, fn: (() => void) | undefined): void => {
      const b = h('button', ghost ? 'pm-confirm pm-confirm--ghost' : 'pm-confirm', row);
      b.dataset.nav = '';
      b.dataset.testid = testid;
      h('span', '', b, label);
      b.addEventListener('click', () => fn?.());
    };
    if (active) {
      btn('Restart challenge', 'pause-challenge-restart', false, this.opts.onChallengeRestart);
      btn('Quit challenge', 'pause-challenge-quit', true, this.opts.onChallengeQuit);
    }
    btn('Browse challenges', 'pause-challenges-browse', !!active, this.opts.onChallenges);
    h(
      'p',
      'pm-note',
      p,
      'Ski jump, barrel rolls, a demolition derby, the hill climb and more: beat the medal times, chase the hidden Crumple medal and race your best run’s ghost. F restarts a run instantly.',
    );
  }

  private renderReplay(p: HTMLElement): void {
    this.head(p, 'Replay', 'The last moments, again');
    const info = this.opts.replayInfo?.();
    const grid = h('div', 'pm-overview', p);
    const card = (label: string, value: string): void => {
      const c = h('div', 'pm-ov-card', grid);
      h('span', 'pm-ov-label', c, label);
      h('span', 'pm-ov-value', c, value);
    };
    card('Recorded', info ? `${Math.floor(info.seconds)} s` : '—');
    card('Crashes', info ? String(info.crashes) : '—');
    const row = h('div', 'pm-replay-actions', p);
    const watch = h('button', 'pm-confirm', row);
    watch.dataset.nav = '';
    watch.dataset.testid = 'pause-replay-watch';
    h('span', '', watch, 'Watch replay');
    watch.addEventListener('click', () => this.opts.onReplay?.());
    const photo = h('button', 'pm-confirm pm-confirm--ghost', row);
    photo.dataset.nav = '';
    photo.dataset.testid = 'pause-replay-photo';
    h('span', '', photo, 'Photo mode');
    photo.addEventListener('click', () => this.opts.onPhoto?.());
    h('p', 'pm-note', p, 'Scrub the timeline, slow it down to 1/8×, fly a free camera or let the director cut it. Backspace opens it while driving.');
  }

  private renderSpawns(p: HTMLElement): void {
    this.head(p, 'Spawn point', 'Teleport · full repair');
    const grid = h('div', 'pm-spawns', p);
    const cur = this.opts.spawnIndex();
    this.opts.spawns().forEach((s, i) => {
      const b = h('button', 'pm-spawn', grid);
      b.dataset.nav = '';
      b.dataset.spawn = s.id;
      if (i === cur) b.classList.add('pm-spawn--on');
      h('span', 'pm-spawn-num', b, String(i + 1));
      h('span', 'pm-spawn-name', b, s.name);
      h('span', 'pm-spawn-zone', b, i === cur ? 'Current' : zoneOf(s.id));
      b.addEventListener('click', () => this.opts.onSpawn(i));
    });
    h('p', 'pm-note', p, 'Tip: keys 1–8 teleport while driving.');
  }

  private renderSettings(p: HTMLElement): void {
    this.head(p, 'Settings', 'Saved on this device');
    const o = this.opts;
    const set = (patch: Partial<GameSettings>): void => {
      o.onSettings(patch);
      this.renderRowsState();
    };
    const rows: Row<string | number | boolean>[] = [
      {
        key: 'quality',
        label: 'Graphics quality',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'ultra', label: 'Ultra' },
        ],
        get: () => o.quality(),
        set: (v) => {
          o.onQuality(v as QualityLevelName);
          this.renderRowsState();
        },
      },
      {
        key: 'traffic',
        label: 'Traffic density',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'light', label: 'Light' },
          { value: 'normal', label: 'Normal' },
          { value: 'heavy', label: 'Heavy' },
        ],
        get: () => o.settings().traffic,
        set: (v) => set({ traffic: v as GameSettings['traffic'] }),
      },
      {
        key: 'units',
        label: 'Speed units',
        options: [
          { value: 'kmh', label: 'km/h' },
          { value: 'mph', label: 'mph' },
        ],
        get: () => o.settings().units,
        set: (v) => set({ units: v as GameSettings['units'] }),
      },
      {
        key: 'tc',
        label: 'Traction control',
        note: 'Default for every spawn · X toggles while driving',
        options: [
          { value: true, label: 'On' },
          { value: false, label: 'Off' },
        ],
        get: () => o.settings().tractionControl,
        set: (v) => set({ tractionControl: v as boolean }),
      },
      {
        key: 'chase',
        label: 'Chase camera',
        options: [
          { value: 'near', label: 'Near' },
          { value: 'normal', label: 'Normal' },
          { value: 'far', label: 'Far' },
        ],
        get: () => o.settings().chase,
        set: (v) => set({ chase: v as GameSettings['chase'] }),
      },
      {
        key: 'fov',
        label: 'Field of view',
        options: [55, 60, 65, 70, 75].map((f) => ({ value: f, label: `${f}°` })),
        get: () => o.settings().fov,
        set: (v) => set({ fov: v as number }),
      },
      {
        key: 'crashCam',
        label: 'Crash cam',
        note: 'Severe crashes play back as an instant replay',
        options: [
          { value: true, label: 'On' },
          { value: false, label: 'Off' },
        ],
        get: () => o.settings().crashCam,
        set: (v) => set({ crashCam: v as boolean }),
      },
      {
        key: 'muted',
        label: 'Sound',
        note: 'Fully synthesized: engines, tyres, crashes, world',
        options: [
          { value: false, label: 'On' },
          { value: true, label: 'Off' },
        ],
        get: () => o.settings().muted,
        set: (v) => set({ muted: v as boolean }),
      },
      ...(
        [
          ['volume', 'Master volume'],
          ['engineVolume', 'Engine'],
          ['effectsVolume', 'Effects'],
          ['ambienceVolume', 'Ambience'],
        ] as const
      ).map(([key, label]) => ({
        key,
        label,
        options: [0, 0.2, 0.4, 0.6, 0.8, 1].map((x) => ({ value: x, label: `${Math.round(x * 100)}` })),
        get: () => Math.round(o.settings()[key] * 5) / 5,
        set: (v: string | number | boolean) => set({ [key]: v as number }),
      })),
    ];
    this.rows = rows;
    const list = h('div', 'pm-rows', p);
    for (const r of rows) {
      const row = h('div', 'pm-row', list);
      row.tabIndex = 0;
      row.dataset.nav = '';
      row.dataset.row = r.key;
      row.dataset.testid = `setting-${r.key}`;
      const lab = h('div', 'pm-row-label', row);
      h('span', '', lab, r.label);
      if (r.note) h('small', '', lab, r.note);
      const seg = h('div', `pm-seg${METER_ROWS.has(r.key) ? ' pm-seg--meter' : ''}`, row);
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', r.label);
      for (const opt of r.options) {
        const b = h('button', 'pm-seg-opt', seg, opt.label);
        b.tabIndex = -1;
        b.dataset.value = String(opt.value);
        b.setAttribute('role', 'radio');
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          r.set(opt.value);
          row.focus({ preventScroll: true });
        });
      }
      row.addEventListener('click', () => row.focus({ preventScroll: true }));
    }
    this.renderRowsState();
  }

  private stepRow(r: Row<string | number | boolean>, d: number): void {
    const cur = r.get();
    const i = r.options.findIndex((o) => o.value === cur);
    const n = r.options[Math.min(r.options.length - 1, Math.max(0, (i < 0 ? 0 : i) + d))]!;
    if (n.value !== cur) r.set(n.value);
  }

  private renderRowsState(): void {
    for (const r of this.rows) {
      const row = this.panel.querySelector<HTMLElement>(`[data-row="${r.key}"]`);
      if (!row) continue;
      const cur = r.get();
      const meter = METER_ROWS.has(r.key);
      const idx = r.options.findIndex((o) => o.value === cur);
      row.querySelectorAll<HTMLButtonElement>('.pm-seg-opt').forEach((b, i) => {
        const on = meter ? i <= idx : i === idx;
        b.classList.toggle('pm-seg-opt--on', on);
        b.setAttribute('aria-checked', String(i === idx));
      });
      row.dataset.value = String(cur);
    }
  }

  private renderControls(p: HTMLElement): void {
    this.head(p, 'Controls', 'Keyboard · gamepad');
    const t = h('div', 'pm-controls', p);
    const rows: [string, string, string][] = [
      ['Throttle / brake', 'W S · ↑ ↓', 'RT · LT'],
      ['Steer', 'A D · ← →', 'Left stick'],
      ['Handbrake', 'Space', 'A'],
      ['Horn', 'H', 'L3 · R3'],
      ['Shift up / down', 'E Q · Shift Ctrl', 'RB · LB'],
      ['Recover upright', 'R', 'Y'],
      ['Full repair', 'F', 'D-pad ↑'],
      ['Camera', 'C', 'X'],
      ['Beam / node view', 'B', 'Back'],
      ['Slow motion', 'T', 'D-pad ↓'],
      ['Traction control', 'X', 'D-pad ←'],
      ['Spawn points', '1 – 8', '—'],
      ['Replay', 'Backspace', 'D-pad →'],
      ['Replay: play · frame · speed', 'Space · ← → · [ ]', 'A · D-pad · LB RB'],
      ['Replay: reverse · camera · subject', 'R · C · 1–7 · Tab', 'Back · X · Y'],
      ['Replay: crashes · hide UI · exit', ', . · H · Esc', 'B'],
      ['Photo mode (in replay)', 'P · Enter shoots', '—'],
      ['Menu', 'Esc · P', 'Start'],
    ];
    const head = h('div', 'pm-ctl pm-ctl--head', t);
    h('span', '', head, 'Action');
    h('span', '', head, 'Keyboard');
    h('span', '', head, 'Gamepad');
    for (const [a, k, g] of rows) {
      const r = h('div', 'pm-ctl', t);
      h('span', 'pm-ctl-action', r, a);
      const kk = h('span', '', r);
      kk.innerHTML = k
        .split(' · ')
        .map((x) => `<kbd>${x}</kbd>`)
        .join(' ');
      const gg = h('span', '', r);
      gg.innerHTML = g === '—' ? '<em>—</em>' : g.split(' · ').map((x) => `<kbd class="pm-pad">${x}</kbd>`).join(' ');
    }
  }

  private renderRestart(p: HTMLElement): void {
    const spawn = this.opts.spawns()[this.opts.spawnIndex()];
    this.head(p, 'Restart', 'Full repair');
    h('p', 'pm-note pm-note--lead', p, `Your car is repaired and placed back at ${spawn ? spawn.name : 'the start'}. The arena props are rebuilt.`);
    const b = h('button', 'pm-confirm', p);
    b.dataset.nav = '';
    b.dataset.testid = 'pause-restart-confirm';
    h('span', '', b, 'Restart now');
    b.addEventListener('click', () => this.opts.onRestart());
  }
}
