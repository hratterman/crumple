/**
 * R-CORE contact MATERIAL PAIRS: sliding friction μ and restitution e per
 * (MaterialId, MaterialId), symmetric. Used by node-vs-triangle contacts
 * (collision/triangles.ts: object triangles, self-collision, static meshes).
 * Ground and primitive-collider contacts keep the frozen node × material
 * friction law (their tuning is load-bearing: handling, crash harnesses).
 *
 * Values (dry, sliding; e = normal restitution of the LOCAL contact — the
 * crumpling structure absorbs the rest):
 *   steel on asphalt / concrete  μ 0.5  (0.4–0.6, Kudlich; skid tests of car bodies 0.45–0.55)
 *   steel on steel               μ 0.42 (dry kinetic 0.42–0.57, Marks' Handbook) e 0.3
 *   rubber on steel              μ 0.7  (0.6–0.9)                       e 0.6
 *   rubber on asphalt            μ 0.9                                   e 0.65
 *   plastic (ABS / PP) on steel  μ 0.3  (0.25–0.4)                      e 0.35
 *   wood on steel                μ 0.35 (0.2–0.6), wood on wood 0.4      e 0.4
 * Loose / soft ground scales μ down and kills the bounce (gravel, dirt,
 * sand, grass, mud), cardboard is dead (e 0.1).
 *
 * The penalty law's damping ratio ζ is derived from e for the UNILATERAL
 * linear spring–dashpot (the contact ends when the force reaches zero,
 * before the spring is back at rest; Schwager & Pöschel 2007), integrated
 * with the sim's own discrete scheme and bisected at module load (never
 * while stepping). The drop tests (triangles.test.ts) measure e.
 */
import { MATERIAL_COUNT, MaterialId } from '../types';

export interface ContactPairLaw {
  /** Sliding friction coefficient. */
  mu: number;
  /** Target normal restitution of the local contact. */
  restitution: number;
}

type Cls = 'hard' | 'loose' | 'soft' | 'metal' | 'plastic' | 'rubber' | 'wood' | 'cardboard';

/** Material → contact class. */
const CLASS: Readonly<Record<keyof typeof MaterialId, Cls>> = {
  asphalt: 'hard',
  grass: 'soft',
  dirt: 'loose',
  rock: 'hard',
  gravel: 'loose',
  concrete: 'hard',
  metal: 'metal',
  plastic: 'plastic',
  rubber: 'rubber',
  wood: 'wood',
  cardboard: 'cardboard',
  mud: 'soft',
  sand: 'loose',
  wetGrass: 'soft',
  asphaltWorn: 'hard',
};

/** Symmetric class table [mu, e]; the first class of a pair is the earlier one in CLASSES. */
const CLASSES: readonly Cls[] = ['metal', 'rubber', 'plastic', 'wood', 'cardboard', 'hard', 'loose', 'soft'];
const PAIRS: Readonly<Record<string, readonly [number, number]>> = {
  'metal|metal': [0.42, 0.3],
  'metal|rubber': [0.7, 0.6],
  'metal|plastic': [0.3, 0.35],
  'metal|wood': [0.35, 0.4],
  'metal|cardboard': [0.4, 0.1],
  'metal|hard': [0.5, 0.25],
  'metal|loose': [0.45, 0.1],
  'metal|soft': [0.35, 0.05],
  'rubber|rubber': [1.0, 0.7],
  'rubber|plastic': [0.6, 0.5],
  'rubber|wood': [0.7, 0.5],
  'rubber|cardboard': [0.6, 0.1],
  'rubber|hard': [0.9, 0.65],
  'rubber|loose': [0.6, 0.2],
  'rubber|soft': [0.5, 0.1],
  'plastic|plastic': [0.35, 0.4],
  'plastic|wood': [0.35, 0.35],
  'plastic|cardboard': [0.4, 0.1],
  'plastic|hard': [0.45, 0.35],
  'plastic|loose': [0.4, 0.1],
  'plastic|soft': [0.3, 0.05],
  'wood|wood': [0.4, 0.45],
  'wood|cardboard': [0.45, 0.1],
  'wood|hard': [0.55, 0.4],
  'wood|loose': [0.5, 0.1],
  'wood|soft': [0.4, 0.05],
  'cardboard|cardboard': [0.5, 0.1],
  'cardboard|hard': [0.5, 0.1],
  'cardboard|loose': [0.5, 0.05],
  'cardboard|soft': [0.45, 0.05],
  'hard|hard': [0.7, 0.3],
  'hard|loose': [0.6, 0.1],
  'hard|soft': [0.5, 0.05],
  'loose|loose': [0.6, 0.05],
  'loose|soft': [0.5, 0.05],
  'soft|soft': [0.45, 0.05],
};

function classPair(a: Cls, b: Cls): readonly [number, number] {
  const ia = CLASSES.indexOf(a);
  const ib = CLASSES.indexOf(b);
  const key = ia <= ib ? `${a}|${b}` : `${b}|${a}`;
  const v = PAIRS[key];
  if (!v) throw new Error(`contact pair table: no entry ${key}`);
  return v;
}

/**
 * ω0·dt at which ζ is calibrated: contact stiffness is min(K_MAX, 0.2·m_r/dt²),
 * so light pairs run at ω0·dt = √0.2 ≈ 0.45 and heavier ones (capped k) at
 * 0.25–0.4 (vehicle body nodes vs a panel: m_r ≈ 3–6 kg → ≈ 0.35).
 */
export const RESTITUTION_CALIB_WDT = 0.4;
/** Entry phases averaged (where inside the tick the node crosses the surface). */
const PHASES = 16;

/**
 * Restitution of the unilateral linear spring–dashpot at damping ratio ζ,
 * integrated EXACTLY as the sim does (semi-implicit Euler, force clamped ≥ 0,
 * ω0·dt = `wdt`, dt = m = 1, entry speed 1), AVERAGED over the entry phase:
 * at 2 kHz the damper's first-tick force c·v does not depend on how deep the
 * node already is, so a single impact's e depends on where inside the tick
 * it crossed the surface (± ≈ 0.1); the mean over phases is what a body of
 * many nodes sees. Module-load only (never while stepping).
 */
export function unilateralRestitution(zeta: number, wdt = RESTITUTION_CALIB_WDT): number {
  if (zeta <= 0) return 1;
  let sum = 0;
  for (let ph = 1; ph <= PHASES; ph++) sum += restitutionAtPhase(zeta, wdt, ph / PHASES);
  return sum / PHASES;
}

function restitutionAtPhase(zeta: number, wdt: number, phase: number): number {
  const k = wdt * wdt;
  const c = 2 * zeta * wdt;
  let y = -phase;
  let v = -1;
  for (let i = 0; i < 1000000; i++) {
    let f = 0;
    if (y < 0) {
      f = -k * y - c * v;
      if (f < 0) f = 0;
    }
    v += f;
    y += v;
    if (y >= 0 && v > 0) return v;
  }
  return 0;
}

/**
 * Largest ζ used: the explicit damper must keep c·dt/m = 2ζ·ω0·dt < 1 at the
 * stability-capped ω0·dt ≈ 0.45 (no single-step velocity reversal), and e(ζ)
 * stays monotone below it.
 */
export const ZETA_MAX = 1.05;

const zetaCache = new Map<number, number>();

/** ζ giving restitution e (bisection on unilateralRestitution over [0, ZETA_MAX]; e in (0, 1)). */
export function zetaForRestitution(e: number): number {
  if (!(e > 0)) return ZETA_MAX;
  if (e >= 1) return 0;
  const hit = zetaCache.get(e);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = ZETA_MAX;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (unilateralRestitution(mid) > e) lo = mid;
    else hi = mid;
  }
  const z = 0.5 * (lo + hi);
  zetaCache.set(e, z);
  return z;
}

const N = MATERIAL_COUNT;
/** μ by pair index a·MATERIAL_COUNT + b. */
export const CONTACT_MU = new Float64Array(N * N);
/** Restitution target by pair index. */
export const CONTACT_RESTITUTION = new Float64Array(N * N);
/** Damping ratio ζ of the penalty law by pair index (from the restitution target). */
export const CONTACT_ZETA = new Float64Array(N * N);
{
  const names = Object.keys(MaterialId) as (keyof typeof MaterialId)[];
  for (const a of names) {
    for (const b of names) {
      const [mu, e] = classPair(CLASS[a], CLASS[b]);
      const i = MaterialId[a] * N + MaterialId[b];
      CONTACT_MU[i] = mu;
      CONTACT_RESTITUTION[i] = e;
      CONTACT_ZETA[i] = zetaForRestitution(e);
    }
  }
}

/** The pair law (μ, restitution) for two MaterialIds. */
export function contactPair(a: number, b: number): ContactPairLaw {
  const i = a * N + b;
  return { mu: CONTACT_MU[i]!, restitution: CONTACT_RESTITUTION[i]! };
}
