/**
 * Showroom / vehicle select (P6 S1; docs/CONTRACTS.md "Showroom + vehicle
 * select"). Hand-rolled DOM over the studio render (src/render/showroom):
 * vehicle name + spec card (VehicleStatsCard), carousel of the player
 * vehicles (unbuilt ones show "in the workshop" and cannot be picked),
 * palette swatches (instant recolour), start-point chip and DRIVE.
 *
 * The 3D side is behind `ShowroomStage` (main wires it to the studio), so
 * this module never touches three. Keyboard: ←/→ (or Q/E) vehicle, ↑/↓
 * paint, Enter drive, Esc back; drag orbits, wheel zooms; gamepad: D-pad /
 * stick, LB/RB vehicle, A drive, B back. While open, keys never reach the
 * driving input mapper (capture-phase listener).
 */
import './showroom.css';
import type { PaintDef } from '../../render/vehicle/types';
import type { VehicleCatalogEntry, VehicleChoice, VehicleId } from '../../game/catalogTypes';
import { firstGamepad, keyIntent, PadNav, type NavIntent } from './nav';

export interface ShowroomStage {
  /** Puts vehicle `id` with `paint` on the turntable (resolves once it is drawn). */
  show(id: VehicleId, paint: PaintDef): Promise<void>;
  paint(paint: PaintDef): void;
  orbit(dxPx: number, dyPx: number): void;
  zoom(deltaY: number): void;
  intro(): void;
  /** Car framing shift in CSS px (positive = right / up) and the fraction of the width the car may fill. */
  setFraming(x: number, y: number, fill: number): void;
  frame(dtS: number): void;
  resize(width: number, height: number): void;
}

export interface ShowroomSpawn {
  id: string;
  name: string;
}

export interface ShowroomOptions {
  /** Player vehicles in showroom order (catalog entries; unavailable ones are shown as in the workshop). */
  entries: readonly VehicleCatalogEntry[];
  spawns: () => readonly ShowroomSpawn[];
  /** Display units for the top speed. */
  units: () => 'kmh' | 'mph';
  /** Creates (first open) or returns the studio stage. */
  stage: () => Promise<ShowroomStage>;
  /** DRIVE: swap the player car; resolves when the car is in the world. */
  onDrive: (choice: VehicleChoice, spawnIndex: number) => Promise<void>;
  /** Back without driving (Esc / B / ✕). */
  onBack: () => void;
}

const KMH_PER_MPH = 1.609344;
const KW_TO_HP = 1.34102;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** sRGB hex → CSS colour with a lightness tweak (−1..1). */
function shade(hex: number, k: number): string {
  let r = (hex >> 16) & 255;
  let g = (hex >> 8) & 255;
  let b = hex & 255;
  if (k >= 0) {
    r += (255 - r) * k;
    g += (255 - g) * k;
    b += (255 - b) * k;
  } else {
    r *= 1 + k;
    g *= 1 + k;
    b *= 1 + k;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

export function finishName(p: PaintDef): string {
  if ((p.pearl ?? 0) > 0.12) return 'Pearl';
  if (p.metallic >= 0.3 || p.flake) return 'Metallic';
  return 'Solid';
}

/** A black curtain that lifts off the world after DRIVE (the cut from studio to road). */
function curtain(): void {
  const c = document.createElement('div');
  c.className = 'sr-curtain';
  document.body.appendChild(c);
  window.setTimeout(() => c.remove(), 1200);
}

export class Showroom {
  readonly root: HTMLDivElement;
  private readonly opts: ShowroomOptions;
  private readonly el: {
    stage: HTMLDivElement;
    index: HTMLDivElement;
    name: HTMLHeadingElement;
    cls: HTMLDivElement;
    blurb: HTMLParagraphElement;
    specs: HTMLDivElement;
    ratings: HTMLDivElement;
    workshop: HTMLDivElement;
    swatches: HTMLDivElement;
    paint: HTMLElement;
    paintName: HTMLDivElement;
    paintFinish: HTMLDivElement;
    carousel: HTMLDivElement;
    tiles: HTMLButtonElement[];
    drive: HTMLButtonElement;
    driveSub: HTMLSpanElement;
    spawnName: HTMLSpanElement;
    busy: HTMLDivElement;
    busyText: HTMLDivElement;
    card: HTMLElement;
  };
  private stage: ShowroomStage | null = null;
  private _open = false;
  private index = 0;
  private palette = new Map<VehicleId, string>();
  private spawnIndex = 0;
  private driving = false;
  private shown: VehicleId | null = null;
  private readonly pad = new PadNav();
  private drag: { id: number; x: number; y: number } | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);
  private readonly onResize = (): void => this.layout();

  constructor(parent: HTMLElement, opts: ShowroomOptions) {
    this.opts = opts;
    const root = h('div', 'sr', parent);
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Showroom');
    root.dataset.testid = 'showroom';
    this.root = root;

    const stage = h('div', 'sr-stage', root);
    stage.setAttribute('aria-hidden', 'true');

    const top = h('header', 'sr-top', root);
    const brand = h('div', 'sr-brand', top);
    h('span', 'sr-brand-mark', brand, 'CRUMPLE');
    h('span', 'sr-brand-sep', brand);
    h('span', 'sr-brand-page', brand, 'Showroom');
    const topRight = h('div', 'sr-top-right', top);
    const spawnChip = h('div', 'sr-spawn', topRight);
    h('span', 'sr-spawn-label', spawnChip, 'Start at');
    const spawnPrev = h('button', 'sr-spawn-arrow', spawnChip, '‹');
    spawnPrev.setAttribute('aria-label', 'Previous start point');
    spawnPrev.dataset.nav = '';
    const spawnName = h('span', 'sr-spawn-name', spawnChip, '');
    const spawnNext = h('button', 'sr-spawn-arrow', spawnChip, '›');
    spawnNext.setAttribute('aria-label', 'Next start point');
    spawnNext.dataset.nav = '';
    spawnPrev.addEventListener('click', () => this.cycleSpawn(-1));
    spawnNext.addEventListener('click', () => this.cycleSpawn(1));
    const close = h('button', 'sr-close', topRight);
    close.innerHTML = '<kbd>Esc</kbd><span>Back</span>';
    close.setAttribute('aria-label', 'Back');
    close.dataset.nav = '';
    close.addEventListener('click', () => this.back());

    // Left: identity + spec card.
    const card = h('section', 'sr-card', root);
    const index = h('div', 'sr-index', card);
    const name = h('h2', 'sr-name', card);
    const cls = h('div', 'sr-class', card);
    const blurb = h('p', 'sr-blurb', card);
    const workshop = h('div', 'sr-workshop', card);
    workshop.innerHTML = '<span class="sr-workshop-icon"></span><div><b>In the workshop</b><span>Still being built. Specs are targets.</span></div>';
    const specs = h('div', 'sr-specs', card);
    const ratings = h('div', 'sr-ratings', card);

    // Right: paint.
    const paint = h('section', 'sr-paint', root);
    h('div', 'sr-section-label', paint, 'Paint');
    const swatches = h('div', 'sr-swatches', paint);
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', 'Paint');
    const paintName = h('div', 'sr-paint-name', paint);
    const paintFinish = h('div', 'sr-paint-finish', paint);

    // Bottom: carousel + drive.
    const bottom = h('footer', 'sr-bottom', root);
    const prev = h('button', 'sr-arrow', bottom, '‹');
    prev.setAttribute('aria-label', 'Previous vehicle');
    prev.addEventListener('click', () => this.step(-1));
    const carousel = h('div', 'sr-carousel', bottom);
    const next = h('button', 'sr-arrow', bottom, '›');
    next.setAttribute('aria-label', 'Next vehicle');
    next.addEventListener('click', () => this.step(1));
    const tiles = opts.entries.map((e, i) => {
      const t = h('button', 'sr-tile', carousel);
      t.dataset.vehicle = e.id;
      t.dataset.nav = '';
      t.setAttribute('aria-label', `${e.stats.name}${e.available ? '' : ' (in the workshop)'}`);
      const head = h('span', 'sr-tile-head', t);
      h('span', 'sr-tile-num', head, String(i + 1).padStart(2, '0'));
      if (!e.available) h('span', 'sr-tile-lock', head, 'In the workshop');
      h('span', 'sr-tile-name', t, e.stats.name);
      h('span', 'sr-tile-class', t, e.stats.class);
      if (!e.available) t.classList.add('sr-tile--locked');
      t.addEventListener('click', () => {
        if (e.available) this.select(i);
        else this.nope(t);
      });
      return t;
    });
    const drive = h('button', 'sr-drive', bottom);
    drive.dataset.testid = 'showroom-drive';
    drive.dataset.nav = '';
    h('span', 'sr-drive-label', drive, 'Drive');
    const driveSub = h('span', 'sr-drive-sub', drive, '');
    drive.addEventListener('click', () => void this.drive());

    const hints = h('div', 'sr-hints', root);
    hints.innerHTML = [
      ['← →', 'Vehicle'],
      ['↑ ↓', 'Paint'],
      ['Drag', 'Orbit'],
      ['Wheel', 'Zoom'],
      ['Enter', 'Drive'],
      ['Esc', 'Back'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');

    const busy = h('div', 'sr-busy', root);
    h('div', 'sr-busy-spinner', busy);
    const busyText = h('div', 'sr-busy-text', busy, 'Preparing studio');

    this.el = { stage, index, name, cls, blurb, specs, ratings, workshop, swatches, paint, paintName, paintFinish, carousel, tiles, drive, driveSub, spawnName, busy, busyText, card };

    // Orbit / zoom on the stage area.
    stage.addEventListener('pointerdown', (e) => {
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('sr-stage--drag');
    });
    stage.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.stage?.orbit(e.clientX - d.x, e.clientY - d.y);
      d.x = e.clientX;
      d.y = e.clientY;
    });
    const endDrag = (e: PointerEvent): void => {
      if (this.drag?.id !== e.pointerId) return;
      this.drag = null;
      stage.classList.remove('sr-stage--drag');
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stage?.zoom(e.deltaY);
      },
      { passive: false },
    );
  }

  get isOpen(): boolean {
    return this._open;
  }

  /** The vehicle + palette on the turntable. */
  get selection(): VehicleChoice {
    const e = this.entry;
    return { id: e.id, palette: this.paletteId(e) };
  }

  get spawn(): number {
    return this.spawnIndex;
  }

  get busy(): boolean {
    return !this.el.busy.hidden;
  }

  private get entry(): VehicleCatalogEntry {
    return this.opts.entries[this.index]!;
  }

  private paletteId(e: VehicleCatalogEntry): string {
    return this.palette.get(e.id) ?? e.palettes[0]!.id;
  }

  async open(choice: VehicleChoice, spawnIndex: number): Promise<void> {
    if (this._open) return;
    this._open = true;
    this.driving = false;
    const i = this.opts.entries.findIndex((e) => e.id === choice.id);
    this.index = i >= 0 ? i : 0;
    this.palette.set(choice.id, choice.palette);
    this.spawnIndex = spawnIndex;
    this.root.hidden = false;
    this.root.classList.remove('sr--in');
    void this.root.offsetWidth;
    this.root.classList.add('sr--in');
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.pad.reset();
    this.render();
    this.setBusy('Preparing studio');
    try {
      this.stage = await this.opts.stage();
    } catch (e) {
      console.error('[showroom] studio failed', e);
      this.setBusy('Studio unavailable');
      return;
    }
    if (!this._open) return;
    this.layout();
    this.stage.intro();
    await this.showCurrent();
    this.el.tiles[this.index]?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    this.root.classList.remove('sr--in');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    this.drag = null;
    this.shown = null;
  }

  /** Per frame while open (studio render + gamepad). */
  frame(dtS: number): void {
    if (!this._open) return;
    for (const i of this.pad.poll(firstGamepad(), dtS)) this.intent(i);
    this.stage?.frame(dtS);
  }

  /** Selects vehicle `i` of the carousel (locked entries are not selectable). */
  select(i: number): void {
    const e = this.opts.entries[i];
    if (!e || !e.available || i === this.index || this.driving) return;
    this.index = i;
    this.render();
    void this.showCurrent();
  }

  /** Picks palette `id` of the current vehicle (instant recolour). */
  pickPaint(id: string): void {
    const e = this.entry;
    const p = e.palettes.find((x) => x.id === id);
    if (!p || this.driving) return;
    this.palette.set(e.id, p.id);
    this.stage?.paint(p.paint);
    this.renderPaint();
  }

  async drive(): Promise<void> {
    const e = this.entry;
    if (!e.available || this.driving || this.busy) return;
    this.driving = true;
    this.el.drive.classList.add('sr-drive--busy');
    this.setBusy(`Rolling ${e.stats.name} out`);
    try {
      await this.opts.onDrive(this.selection, this.spawnIndex);
      curtain();
    } catch (err) {
      console.error('[showroom] drive failed', err);
      this.setBusy(null);
    } finally {
      this.driving = false;
      this.el.drive.classList.remove('sr-drive--busy');
    }
  }

  back(): void {
    if (this.driving) return;
    this.opts.onBack();
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }

  // ------------------------------------------------------------ internals
  private step(d: number): void {
    const n = this.opts.entries.length;
    for (let k = 1; k <= n; k++) {
      const i = (((this.index + d * k) % n) + n) % n;
      if (this.opts.entries[i]!.available) {
        this.select(i);
        this.el.tiles[i]?.focus({ preventScroll: true });
        return;
      }
    }
  }

  /** Locked tile: a short shake (still in the workshop). */
  private nope(t: HTMLElement): void {
    t.classList.remove('sr-tile--nope');
    void t.offsetWidth;
    t.classList.add('sr-tile--nope');
  }

  private stepPaint(d: number): void {
    const e = this.entry;
    const cur = e.palettes.findIndex((p) => p.id === this.paletteId(e));
    const next = e.palettes[(cur + d + e.palettes.length) % e.palettes.length]!;
    this.pickPaint(next.id);
  }

  private cycleSpawn(d: number): void {
    const n = this.opts.spawns().length;
    if (n === 0) return;
    this.spawnIndex = (this.spawnIndex + d + n) % n;
    this.renderSpawn();
  }

  private intent(i: NavIntent): void {
    switch (i) {
      case 'left':
      case 'prev':
        this.step(-1);
        break;
      case 'right':
      case 'next':
        this.step(1);
        break;
      case 'up':
        this.stepPaint(-1);
        break;
      case 'down':
        this.stepPaint(1);
        break;
      case 'accept':
        void this.drive();
        break;
      case 'back':
        this.back();
        break;
    }
  }

  private key(e: KeyboardEvent): void {
    if (!this._open || e.ctrlKey || e.metaKey || e.altKey) return;
    // Every key stays in the showroom (the car must not steer behind it); browser keys pass.
    if (e.code === 'Tab' || /^F\d+$/.test(e.code)) return;
    e.stopImmediatePropagation();
    const i = keyIntent(e.code);
    if (e.type !== 'keydown' || !i) return;
    e.preventDefault();
    // Enter / Space on a focused control clicks it (spawn arrows, ✕); the carousel and drive act directly.
    const active = document.activeElement as HTMLElement | null;
    if (i === 'accept' && active && this.root.contains(active) && active.classList.contains('sr-spawn-arrow')) {
      active.click();
      return;
    }
    if (i === 'accept' && active && active.classList.contains('sr-close')) {
      this.back();
      return;
    }
    if (e.repeat && (i === 'accept' || i === 'back')) return;
    this.intent(i);
  }

  private setBusy(text: string | null): void {
    this.el.busy.hidden = text === null;
    if (text !== null) this.el.busyText.textContent = text;
  }

  private async showCurrent(): Promise<void> {
    const e = this.entry;
    const stage = this.stage;
    if (!stage || !e.available) return;
    const pal = e.palettes.find((p) => p.id === this.paletteId(e)) ?? e.palettes[0]!;
    if (this.shown !== e.id) this.setBusy(this.shown === null ? 'Preparing studio' : `Bringing out ${e.stats.name}`);
    this.root.classList.add('sr--swap');
    try {
      await stage.show(e.id, pal.paint);
      if (!this._open || this.entry !== e) return;
      this.shown = e.id;
      this.setBusy(null);
    } catch (err) {
      console.error(`[showroom] ${e.id} failed to load`, err);
      this.setBusy(`${e.stats.name} failed to load`);
    } finally {
      this.root.classList.remove('sr--swap');
    }
  }

  /** Keeps the car clear of the side panels (framing offset in CSS px). */
  private layout(): void {
    if (!this.stage) return;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    this.stage.resize(w, hgt);
    const wide = w >= 900;
    if (wide) {
      // The car sits in the free band between the spec card and the paint panel.
      const left = this.el.card.getBoundingClientRect().right + 16;
      const right = this.el.paint.getBoundingClientRect().left - 16;
      const free = Math.max(w * 0.3, right - left);
      this.stage.setFraming((left + right) / 2 - w / 2, hgt * 0.04, Math.min(0.62, free / w));
    } else {
      this.stage.setFraming(0, hgt * 0.1, 0.78);
    }
  }

  private render(): void {
    const e = this.entry;
    const s = e.stats;
    const n = this.opts.entries.length;
    this.el.index.innerHTML = `<b>${String(this.index + 1).padStart(2, '0')}</b><span>/ ${String(n).padStart(2, '0')}</span>`;
    this.el.name.textContent = s.name;
    this.el.cls.textContent = `${s.class} · ${s.engine}`;
    this.el.blurb.textContent = s.blurb;
    this.el.workshop.hidden = e.available;
    const mph = this.opts.units() === 'mph';
    const top = mph ? Math.round(s.topSpeedKmh / KMH_PER_MPH) : Math.round(s.topSpeedKmh);
    const spec = (label: string, value: string, unit: string, wide = false): string =>
      `<div class="sr-spec${wide ? ' sr-spec--wide' : ''}"><span class="sr-spec-label">${label}</span><span class="sr-spec-value">${value}<small>${unit}</small></span></div>`;
    this.el.specs.innerHTML = [
      spec('Power', String(Math.round(s.powerKw)), `kW<span class="sr-hp"> · ${Math.round(s.powerKw * KW_TO_HP)} hp</span>`),
      spec('Torque', String(Math.round(s.torqueNm)), 'N·m'),
      spec('Weight', s.massKg.toLocaleString('en-US'), 'kg'),
      spec('Drive', s.drivetrain, ''),
      spec('Top speed', String(top), mph ? 'mph' : 'km/h'),
      spec(mph ? '0–62 mph' : '0–100 km/h', s.zeroTo100S === null ? '—' : s.zeroTo100S.toFixed(1), s.zeroTo100S === null ? '' : 's'),
      spec('Gearbox', s.gearbox, '', true),
    ].join('');
    const bar = (label: string, v: number): string =>
      `<div class="sr-rating"><span>${label}</span><i>${[1, 2, 3, 4, 5].map((k) => `<b class="${k <= v ? 'on' : ''}"></b>`).join('')}</i></div>`;
    this.el.ratings.innerHTML = bar('Speed', s.ratings.speed) + bar('Handling', s.ratings.handling) + bar('Toughness', s.ratings.toughness);
    this.el.tiles.forEach((t, i) => {
      t.classList.toggle('sr-tile--active', i === this.index);
      t.setAttribute('aria-pressed', String(i === this.index));
    });
    this.el.drive.disabled = !e.available;
    this.renderPaint();
    this.renderSpawn();
    // Re-trigger the identity reveal.
    this.el.card.classList.remove('sr-card--reveal');
    void this.el.card.offsetWidth;
    this.el.card.classList.add('sr-card--reveal');
  }

  private renderPaint(): void {
    const e = this.entry;
    const cur = this.paletteId(e);
    const sw = this.el.swatches;
    sw.replaceChildren(
      ...e.palettes.map((p) => {
        const b = h('button', 'sr-swatch');
        b.dataset.palette = p.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(p.id === cur));
        b.setAttribute('aria-label', p.name);
        b.title = p.name;
        const c = p.paint.color;
        const metal = p.paint.metallic >= 0.3 || !!p.paint.flake;
        b.style.setProperty(
          '--sw',
          metal
            ? `radial-gradient(circle at 32% 28%, ${shade(c, 0.75)} 0%, ${shade(c, 0.18)} 22%, ${shade(c, 0)} 48%, ${shade(c, -0.55)} 100%)`
            : `radial-gradient(circle at 32% 28%, ${shade(c, 0.5)} 0%, ${shade(c, 0.05)} 30%, ${shade(c, -0.25)} 100%)`,
        );
        if (p.id === cur) b.classList.add('sr-swatch--on');
        b.disabled = !e.available;
        b.addEventListener('click', () => this.pickPaint(p.id));
        return b;
      }),
    );
    const p = e.palettes.find((x) => x.id === cur) ?? e.palettes[0]!;
    this.el.paintName.textContent = p.name;
    this.el.paintFinish.textContent = finishName(p.paint);
  }

  private renderSpawn(): void {
    const spawns = this.opts.spawns();
    const s = spawns[this.spawnIndex];
    this.el.spawnName.textContent = s ? s.name : '—';
    this.el.driveSub.textContent = this.entry.available ? (s ? s.name : '') : 'In the workshop';
  }
}
