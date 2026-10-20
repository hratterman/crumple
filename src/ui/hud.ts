/**
 * Minimal driving HUD (hand-rolled DOM + SVG): speedometer (km/h),
 * tachometer with redline arc, gear letter, damage %, status badges and a
 * controls hint that fades out after HINT_MS. Reads telemetry slots by name
 * (`VehicleTelemetry`). DOM writes only happen when a displayed value changes.
 */
import './hud.css';
import { VehicleTelemetry } from '../protocol/telemetry';

export interface HudVehicleSpec {
  idleRpm: number;
  redlineRpm: number;
  revLimitRpm: number;
  /** P6: speedometer full scale in DISPLAY units (catalog top speed + 20 %, app/player.ts speedoMax); default 240. */
  speedoMax?: number;
  /** P6: display units (default km/h). */
  units?: 'kmh' | 'mph';
}

export interface HudStatus {
  paused: boolean;
  slowMo: boolean;
  camera: string;
  transmission: 'auto' | 'manual';
  beamView: boolean;
  /** P4 debug view ('body' | 'body+beams' | 'beams' | 'nodes'); shown instead of BEAMS/NODES when set. */
  view?: string;
  /** Traction control engaged (badge TC / TC OFF); omitted = no badge. */
  tractionControl?: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const HINT_MS = 8000;
const SPEEDO_MAX_DEFAULT = 240;
const MS_TO_KMH = 3.6;
const KMH_PER_MPH = 1.609344;

/** Major tick step for a dial of `max` (≤ 8 labelled ticks). */
function majorStep(max: number): number {
  for (const s of [10, 20, 40, 50, 60, 80, 100]) if (max / s <= 8) return s;
  return 100;
}

// Dial geometry: 270° sweep, starting at the lower left (SVG angles, clockwise from +x).
const SWEEP_START_DEG = 135;
const SWEEP_DEG = 270;
const R = 62;
const CX = 80;
const CY = 80;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}

function div(cls: string, parent?: Element, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  parent?.appendChild(d);
  return d;
}

function polar(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
}

/** Arc path from fraction f0 to f1 of the sweep. */
function arcPath(f0: number, f1: number, r: number = R): string {
  const a0 = SWEEP_START_DEG + SWEEP_DEG * f0;
  const a1 = SWEEP_START_DEG + SWEEP_DEG * f1;
  const [x0, y0] = polar(a0, r);
  const [x1, y1] = polar(a1, r);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

interface Dial {
  svg: SVGSVGElement;
  fill: SVGPathElement;
  needle: SVGGElement;
  ticks: SVGGElement;
  extra: SVGGElement;
  lastFrac: number;
}

function createDial(parent: Element, label: string): Dial {
  const svg = el('svg', { viewBox: '0 0 160 160', class: 'hud-dial', role: 'img', 'aria-label': label }, parent);
  el('circle', { cx: CX, cy: CY, r: 76, class: 'hud-dial-face' }, svg);
  el('path', { d: arcPath(0, 1), class: 'hud-dial-track', pathLength: 100 }, svg);
  const extra = el('g', {}, svg);
  const fill = el('path', { d: arcPath(0, 1), class: 'hud-dial-fill', pathLength: 100, 'stroke-dasharray': '0 100' }, svg);
  const ticks = el('g', { class: 'hud-dial-ticks' }, svg);
  const needle = el('g', { class: 'hud-dial-needle' }, svg);
  el('line', { x1: CX, y1: CY, x2: CX + R - 6, y2: CY }, needle);
  el('circle', { cx: CX, cy: CY, r: 5 }, needle);
  return { svg, fill, needle, ticks, extra, lastFrac: -1 };
}

function setTicks(d: Dial, max: number, minorStep: number, majorStep: number, labelScale: number): void {
  d.ticks.replaceChildren();
  for (let v = 0; v <= max + 1e-6; v += minorStep) {
    const major = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
    const a = SWEEP_START_DEG + (SWEEP_DEG * v) / max;
    const [x0, y0] = polar(a, R - (major ? 10 : 6));
    const [x1, y1] = polar(a, R - 2);
    el('line', { x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2), class: major ? 'major' : 'minor' }, d.ticks);
    if (major) {
      const [tx, ty] = polar(a, R - 20);
      const t = el('text', { x: tx.toFixed(2), y: ty.toFixed(2), class: 'hud-dial-label' }, d.ticks);
      t.textContent = String(Math.round(v * labelScale));
    }
  }
}

function setDial(d: Dial, frac: number): void {
  const f = Math.round(Math.min(Math.max(frac, 0), 1) * 400) / 400;
  if (f === d.lastFrac) return;
  d.lastFrac = f;
  d.fill.setAttribute('stroke-dasharray', `${(f * 100).toFixed(2)} 100`);
  // A zero-length dash still draws a round cap; hide the fill at rest.
  d.fill.style.visibility = f > 0 ? '' : 'hidden';
  d.needle.setAttribute('transform', `rotate(${(SWEEP_START_DEG + SWEEP_DEG * f).toFixed(2)} ${CX} ${CY})`);
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly speedo: Dial;
  private readonly tacho: Dial;
  private readonly speedText: HTMLDivElement;
  private readonly speedUnit: HTMLDivElement;
  private speedoMax = SPEEDO_MAX_DEFAULT;
  /** Display units per m/s. */
  private speedScale = MS_TO_KMH;
  private readonly gearText: HTMLDivElement;
  private readonly gearMode: HTMLDivElement;
  private readonly rpmText: HTMLDivElement;
  private readonly damageFill: HTMLDivElement;
  private readonly damageText: HTMLDivElement;
  private readonly badges: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly hintTimer: number;
  private readonly toast: HTMLDivElement;
  private readonly toastTitle: HTMLDivElement;
  private readonly toastSub: HTMLDivElement;
  private toastTimer = 0;
  private spec: HudVehicleSpec;
  private tachMax = 8000;
  private rpmSmooth = 0;
  private last = { speed: '', gear: '', mode: '', rpm: '', damage: '', badges: '', redline: false };
  /** Numeric twins of `last` (no string formatting / Intl call on frames where nothing changed). */
  private lastNum = { kmh: -1, rpm: -1 };

  constructor(parent: HTMLElement, spec: HudVehicleSpec) {
    this.spec = spec;
    const root = div('hud', parent);
    root.setAttribute('aria-hidden', 'true');
    this.root = root;

    this.badges = div('hud-badges', root);

    this.toast = div('hud-toast hud-toast--hidden', root);
    this.toastSub = div('hud-toast-sub', this.toast);
    this.toastTitle = div('hud-toast-title', this.toast);

    const cluster = div('hud-cluster', root);
    const tachWrap = div('hud-gauge hud-gauge--tach', cluster);
    this.tacho = createDial(tachWrap, 'Tachometer');
    const tachCenter = div('hud-gauge-center', tachWrap);
    this.gearText = div('hud-gear', tachCenter, 'N');
    this.gearMode = div('hud-gear-mode', tachCenter, 'AUTO');
    this.rpmText = div('hud-unit', tachCenter, '0 rpm');

    const speedWrap = div('hud-gauge hud-gauge--speed', cluster);
    this.speedo = createDial(speedWrap, 'Speedometer');
    const speedCenter = div('hud-gauge-center', speedWrap);
    this.speedText = div('hud-speed', speedCenter, '0');
    this.speedUnit = div('hud-unit', speedCenter, 'km/h');

    const damage = div('hud-damage', cluster);
    div('hud-damage-label', damage, 'DAMAGE');
    const bar = div('hud-damage-bar', damage);
    this.damageFill = div('hud-damage-fill', bar);
    this.damageText = div('hud-damage-value', damage, '0%');

    this.hint = div('hud-hint', root);
    this.hint.innerHTML = [
      ['W/S', 'throttle / brake'],
      ['A/D', 'steer'],
      ['Space', 'handbrake'],
      ['H', 'horn'],
      ['R', 'recover'],
      ['F', 'repair'],
      ['C', 'camera'],
      ['B', 'beams'],
      ['Esc', 'menu'],
      ['T', 'slow-mo'],
      ['Bksp', 'replay'],
      ['X', 'traction ctrl'],
      ['1–8', 'spawn points'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('hud-hint--hidden'), HINT_MS);

    this.applySpec();
  }

  setSpec(spec: HudVehicleSpec): void {
    this.spec = spec;
    this.applySpec();
  }

  get vehicleSpec(): Readonly<HudVehicleSpec> {
    return this.spec;
  }

  /** P6: hidden while a full-screen menu (showroom) owns the screen. */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** `telemetry`: the object's TELEMETRY_SLOTS block, or null when the vehicle is absent. */
  update(telemetry: ArrayLike<number> | null, status: HudStatus, dt: number): void {
    const T = VehicleTelemetry;
    const speed = telemetry ? Math.abs(telemetry[T.speed] ?? 0) : 0;
    const rpm = telemetry ? Math.max(0, telemetry[T.engineRpm] ?? 0) : 0;
    const gear = telemetry ? Math.round(telemetry[T.gear] ?? 0) : 0;
    const damage = telemetry ? Math.min(Math.max(telemetry[T.damage] ?? 0, 0), 1) : 0;

    const kmh = speed * this.speedScale;
    setDial(this.speedo, kmh / this.speedoMax);
    const kmhR = Math.round(kmh);
    if (kmhR !== this.lastNum.kmh) {
      this.lastNum.kmh = kmhR;
      this.text('speed', this.speedText, String(kmhR));
    }

    // Light smoothing hides 120 Hz telemetry quantization on the needle.
    this.rpmSmooth += (rpm - this.rpmSmooth) * (1 - Math.exp(-25 * Math.max(dt, 0)));
    setDial(this.tacho, this.rpmSmooth / this.tachMax);
    const rpmR = Math.round(rpm / 50) * 50;
    if (rpmR !== this.lastNum.rpm) {
      this.lastNum.rpm = rpmR;
      this.text('rpm', this.rpmText, `${rpmR.toLocaleString('en-US')} rpm`);
    }
    const red = rpm >= this.spec.redlineRpm;
    if (red !== this.last.redline) {
      this.last.redline = red;
      this.tacho.svg.classList.toggle('hud-dial--redline', red);
    }

    this.text('gear', this.gearText, gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear));
    this.text('mode', this.gearMode, status.transmission === 'auto' ? 'AUTO' : 'MANUAL');

    const pct = Math.round(damage * 100);
    if (this.text('damage', this.damageText, `${pct}%`)) {
      this.damageFill.style.transform = `scaleX(${damage.toFixed(3)})`;
      this.damageFill.classList.toggle('hud-damage-fill--high', damage > 0.35);
    }

    // Cheap change key first: the badge list is only rebuilt (and formatted) when a field changed.
    const tc = status.tractionControl === undefined ? '' : status.tractionControl ? 'TC' : 'TC OFF';
    const key = `${status.paused ? 1 : 0}${status.slowMo ? 1 : 0}${status.beamView ? 1 : 0}|${status.camera}|${status.view ?? ''}|${tc}`;
    if (key !== this.last.badges) {
      this.last.badges = key;
      const parts: string[] = [];
      if (status.paused) parts.push('PAUSED');
      else if (status.slowMo) parts.push('SLOW-MO 0.25×');
      parts.push(`CAM ${status.camera.toUpperCase()}`);
      parts.push(status.view ? status.view.toUpperCase() : status.beamView ? 'BEAMS' : 'NODES');
      if (tc) parts.push(tc);
      this.badges.replaceChildren(
        ...parts.map((p, i) =>
          div(`hud-badge${(i === 0 && (status.paused || status.slowMo)) || p === 'TC OFF' ? ' hud-badge--alert' : ''}`, undefined, p),
        ),
      );
    }
  }

  /** Location card at the top centre (e.g. after a teleport); fades after `ms`. */
  showToast(title: string, subtitle = '', ms = 2600): void {
    this.toastTitle.textContent = title;
    this.toastSub.textContent = subtitle;
    this.toast.classList.remove('hud-toast--hidden');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hud-toast--hidden'), ms);
  }

  /** Shows the controls hint again for HINT_MS. */
  showHint(): void {
    this.hint.classList.remove('hud-hint--hidden');
    window.setTimeout(() => this.hint.classList.add('hud-hint--hidden'), HINT_MS);
  }

  dispose(): void {
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.toastTimer);
    this.root.remove();
  }

  private text(key: 'speed' | 'gear' | 'mode' | 'rpm' | 'damage', node: HTMLElement, value: string): boolean {
    if (this.last[key] === value) return false;
    this.last[key] = value;
    node.textContent = value;
    return true;
  }

  private applySpec(): void {
    const s = this.spec;
    this.tachMax = Math.max(1000, Math.ceil((Math.max(s.revLimitRpm, s.redlineRpm) + 500) / 1000) * 1000);
    setTicks(this.tacho, this.tachMax / 1000, 0.5, 1, 1);
    this.tacho.extra.replaceChildren();
    const r0 = Math.min(s.redlineRpm / this.tachMax, 1);
    el('path', { d: arcPath(r0, 1, R + 7), class: 'hud-dial-redline' }, this.tacho.extra);
    this.tacho.lastFrac = -1;
    // P6: per-vehicle speedometer scale and units.
    const mph = s.units === 'mph';
    this.speedScale = mph ? MS_TO_KMH / KMH_PER_MPH : MS_TO_KMH;
    this.speedoMax = Math.max(20, s.speedoMax ?? SPEEDO_MAX_DEFAULT);
    const major = majorStep(this.speedoMax);
    setTicks(this.speedo, this.speedoMax, major >= 40 ? major / 4 : major / 2, major, 1);
    this.speedo.lastFrac = -1;
    this.lastNum.kmh = -1;
    this.speedUnit.textContent = mph ? 'mph' : 'km/h';
  }
}
