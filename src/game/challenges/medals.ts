/** Medals, score comparison and formatting (pure). */
import { MEDAL_ORDER, type MedalId, type MedalThresholds, type ScoringDef } from './types';

/** True when `a` beats `b` under `better` (strictly). */
export function beats(a: number, b: number, better: ScoringDef['better']): boolean {
  return better === 'lower' ? a < b : a > b;
}

function meets(score: number, threshold: number, better: ScoringDef['better']): boolean {
  return better === 'lower' ? score <= threshold : score >= threshold;
}

/** The best medal `score` earns (NaN / non-finite → 'none'). */
export function medalFor(score: number, m: MedalThresholds, better: ScoringDef['better']): MedalId {
  if (!Number.isFinite(score)) return 'none';
  if (meets(score, m.crumple, better)) return 'crumple';
  if (meets(score, m.gold, better)) return 'gold';
  if (meets(score, m.silver, better)) return 'silver';
  if (meets(score, m.bronze, better)) return 'bronze';
  return 'none';
}

/** Rank of a medal (none 0 … crumple 4). */
export function medalRank(m: MedalId): number {
  return MEDAL_ORDER.indexOf(m);
}

export function betterMedal(a: MedalId, b: MedalId): MedalId {
  return medalRank(a) >= medalRank(b) ? a : b;
}

/** Thresholds must be ordered bronze → crumple in the 'better' direction (catalog test). */
export function thresholdsOrdered(m: MedalThresholds, better: ScoringDef['better']): boolean {
  const seq = [m.bronze, m.silver, m.gold, m.crumple];
  for (let i = 1; i < seq.length; i++) if (!(better === 'lower' ? seq[i]! < seq[i - 1]! : seq[i]! > seq[i - 1]!)) return false;
  return true;
}

/** The next medal above `current` and its threshold (null at crumple; crumple stays hidden until earned unless `revealCrumple`). */
export function nextMedal(current: MedalId, m: MedalThresholds, revealCrumple = false): { medal: MedalId; threshold: number } | null {
  const r = medalRank(current);
  const order: MedalId[] = ['bronze', 'silver', 'gold', 'crumple'];
  for (const k of order) {
    if (medalRank(k) <= r) continue;
    if (k === 'crumple' && !revealCrumple) return null;
    return { medal: k, threshold: m[k as Exclude<MedalId, 'none'>] };
  }
  return null;
}

/** "1:23.45" for times ≥ 60 s, "12.34" below (s). */
export function formatTime(s: number, decimals = 2): string {
  if (!Number.isFinite(s)) return '—';
  const neg = s < 0;
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const rest = a - m * 60;
  const sec = rest.toFixed(decimals);
  const body = m > 0 ? `${m}:${rest < 10 ? '0' : ''}${sec}` : sec;
  return neg ? `-${body}` : body;
}

/** Score as shown: time metric as a clock, others with the unit. */
export function formatScore(score: number, s: Pick<ScoringDef, 'metric' | 'unit' | 'decimals'>): string {
  if (!Number.isFinite(score)) return '—';
  if (s.metric === 'time') return formatTime(score, s.decimals);
  const v = s.decimals > 0 ? score.toFixed(s.decimals) : Math.round(score).toLocaleString('en-US');
  return s.unit ? `${v} ${s.unit}` : v;
}

/** Signed delta vs a previous best, coloured by the caller (+ = worse for 'lower'). */
export function formatDelta(score: number, prev: number, s: Pick<ScoringDef, 'metric' | 'unit' | 'decimals' | 'better'>): string {
  const d = score - prev;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const a = Math.abs(d);
  if (s.metric === 'time') return `${sign}${formatTime(a, s.decimals)}`;
  const v = s.decimals > 0 ? a.toFixed(s.decimals) : Math.round(a).toLocaleString('en-US');
  return `${sign}${v}${s.unit ? ` ${s.unit}` : ''}`;
}
