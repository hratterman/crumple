/** Pure formatting / styling helpers of the replay UI (unit-tested). */

/** `m:ss.cc` (hundredths); negative values get a leading minus. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const neg = seconds < 0;
  const cs = Math.round(Math.abs(seconds) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${neg ? '−' : ''}${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const FRACTIONS: Readonly<Record<string, string>> = { '0.125': '⅛', '0.25': '¼', '0.5': '½', '1': '1', '2': '2' };

/** Playback speed label: ⅛× ¼× ½× 1× 2×. */
export function speedLabel(speed: number): string {
  return `${FRACTIONS[String(speed)] ?? String(+speed.toFixed(3))}×`;
}

/**
 * Marker tick style by severity 0..1: amber → orange → red, taller and
 * thicker the harder the hit (minor bumps stay subtle, wrecks dominate).
 */
export function markerStyle(severity: number): { color: string; height: number; width: number; glow: number } {
  const s = Math.min(Math.max(severity, 0), 1);
  // hue 44° (amber) → 4° (red); lightness dips a little toward red.
  const hue = 44 - 40 * s;
  const light = 62 - 8 * s;
  return {
    color: `hsl(${hue.toFixed(0)} 100% ${light.toFixed(0)}%)`,
    height: Math.round(8 + 18 * s),
    width: s > 0.66 ? 4 : s > 0.33 ? 3 : 2,
    glow: s > 0.5 ? Math.round(4 + 10 * (s - 0.5)) : 0,
  };
}

/** Severity in words (marker tooltips, the crash-cam lower third). */
export function severityWord(severity: number): string {
  if (severity >= 0.8) return 'Wrecked';
  if (severity >= 0.55) return 'Heavy impact';
  if (severity >= 0.3) return 'Impact';
  return 'Contact';
}

/** Fraction of the timeline for `t` in [start, end] (0 when the buffer is empty). */
export function timelineFraction(t: number, start: number, end: number): number {
  const d = end - start;
  if (!(d > 1e-6)) return 1;
  return Math.min(Math.max((t - start) / d, 0), 1);
}

/** Inverse of timelineFraction. */
export function timeAtFraction(f: number, start: number, end: number): number {
  return start + Math.min(Math.max(f, 0), 1) * Math.max(end - start, 0);
}

/** Aspect presets of photo mode (null = the screen's own). */
export const PHOTO_ASPECTS: readonly { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Screen', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '2.39', label: '2.39:1', ratio: 2.39 },
  { id: '1.85', label: '1.85:1', ratio: 1.85 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 0.8 },
];

/** Largest centred rect of `ratio` inside w × h (letterbox / pillarbox), integer pixels. */
export function fitAspect(w: number, h: number, ratio: number | null): { x: number; y: number; w: number; h: number } {
  if (!ratio || !(w > 0) || !(h > 0)) return { x: 0, y: 0, w, h };
  if (w / h > ratio) {
    const cw = Math.round(h * ratio);
    return { x: Math.floor((w - cw) / 2), y: 0, w: cw, h };
  }
  const ch = Math.round(w / ratio);
  return { x: 0, y: Math.floor((h - ch) / 2), w, h: ch };
}

/** f-number → DoF bokeh scale (wide open blurs most). */
export function apertureToBokeh(fStop: number): number {
  const f = Math.min(Math.max(fStop, 1.2), 22);
  return 4 * Math.pow(2.8 / f, 0.75);
}

/** f-number → the distance (m) over which the blur ramps in from the focus plane, at `focus` m (wider stopped down). */
export function apertureToRange(fStop: number, focus: number): number {
  const f = Math.min(Math.max(fStop, 1.2), 22);
  return Math.max(0.4, focus * 0.09 * f);
}

export const F_STOPS: readonly number[] = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/** File name for a capture: crumple-YYYYMMDD-HHMMSS.png (local time). */
export function photoFileName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `crumple-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}
