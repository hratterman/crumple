/**
 * AI traffic — driver-model constants and pure helpers (P6, T1; worker).
 * docs/CONTRACTS.md "Driver model". Only + − × ÷ sqrt (sim numerics).
 */

/** IDM (per agent): a = aMax·[1 − (v/v0)⁴ − (s* / gap)²], s* = s0 + v·T + v·Δv/(2·sqrt(aMax·b)). */
export const IDM_A_MAX = 1.6;
/** Comfortable deceleration, m/s². */
export const IDM_B = 2.8;
/** Hard deceleration limit, m/s². */
export const IDM_B_HARD = 7;
export const IDM_T = 1.4;
export const IDM_S0 = 2.5;
/** sqrt(aMax·b) (precomputed for s*). */
export const IDM_SQRT_AB = Math.sqrt(IDM_A_MAX * IDM_B);
/** Per-agent temperament ranges (seeded): desired-speed scale and time headway. */
export const TEMPERAMENT_V0: readonly [number, number] = [0.92, 1.06];
export const TEMPERAMENT_T: readonly [number, number] = [1.2, 1.7];
/** Curve speed: v_c = sqrt(CURVE_LAT_ACC / |κ|). */
export const CURVE_LAT_ACC = 2.6;

/** Pure pursuit lookahead L = clamp(0.9·v + 4, 6, 28) m; steer slew ≤ 2.5 /s. */
export const PP_GAIN = 0.9;
export const PP_MIN = 6;
export const PP_MAX = 28;
export const PP_OFFSET = 4;
export const STEER_SLEW = 2.5;
/** Speed PI: v_cmd = v + a·PI_HORIZON. */
export const PI_HORIZON = 0.5;

/** Route choice weights at a lane end (renormalized over what exists; U-turn only at dead ends). */
export const TURN_WEIGHT_STRAIGHT = 0.6;
export const TURN_WEIGHT_RIGHT = 0.25;
export const TURN_WEIGHT_LEFT = 0.15;

/** Junction yield: a conflicting agent inside the box within this horizon blocks, s. */
export const YIELD_HORIZON_S = 4;
/** After waiting this long, go once the box is physically clear (deadlock breaker), s. */
export const YIELD_DEADLOCK_S = 6;
/** Radius around a junction centre the focus counts as "in the box", m. */
export const JUNCTION_FOCUS_R = 18;

/** Lane change (highway): manoeuvre time, s; gap both ways, s; no change this close to a lane end, m. */
export const LANE_CHANGE_S = 3;
export const LANE_CHANGE_GAP_S = 2;
export const LANE_CHANGE_END_M = 80;
/** Overtake a leader slower than this fraction of v0. */
export const OVERTAKE_FRACTION = 0.8;
/** Min time between lane changes, s. */
export const LANE_CHANGE_COOLDOWN_S = 6;

/** Indicators from this far (m) / this long (s) before a turn connector. */
export const INDICATOR_M = 60;
export const INDICATOR_S = 4;

/** Recovery (awake): up·Y below this = on its side / roof. */
export const WRECK_UP_Y = 0.5;
export const OFF_ROUTE_M = 6;
export const OFF_ROUTE_S = 3;
export const STUCK_SPEED = 0.5;
export const STUCK_S = 8;
/** Out of sight: ≥ SIGHT_FAR_M from the focus, or > SIGHT_NEAR_M and more than SIGHT_COS behind its heading (100°). */
export const SIGHT_FAR_M = 120;
export const SIGHT_NEAR_M = 40;
/** cos(100°). */
export const SIGHT_COS = -0.17364817766693033;
/** Spawn cone half-angle cos(70°). */
export const SPAWN_CONE_COS = 0.3420201433256687;
/** Respawns keep this far (m, along the path) from any agent on the same path. */
export const SPAWN_SPACING_M = 30;
/** Demotion snap limits (else the car is off-route and recycled). */
export const DEMOTE_SNAP_M = 0.5;
/** cos(5°). */
export const DEMOTE_SNAP_COS = 0.9961946980917455;
/** A swap demotes an awake car only when it is this much farther than the candidate, m. */
export const SWAP_MARGIN_M = 20;
/** Damage below which an awake car may be demoted to a ghost (above: recycled out of sight instead). */
export const DEMOTE_MAX_DAMAGE = 0.02;
/** Brake lamp: awake applied brake ≥ this; ghost commanded decel ≥ GHOST_BRAKE_DECEL. */
export const BRAKE_LAMP_MIN = 0.05;
export const GHOST_BRAKE_DECEL = 1;
/** Leader search horizon, m (plus the stopping distance). */
export const LOOKAHEAD_MIN_M = 60;
/** Lane corridor half-width margin, m (± laneW/2 + this). */
export const CORRIDOR_MARGIN = 0.3;
/** A moved prop farther than this from its spawn point is an obstacle candidate, m. */
export const PROP_MOVED_M = 0.5;

/** Rational atan, |x| ≤ 1 (contract): x / (1 + 0.28·x²); clamped outside. */
export function atanR(x: number): number {
  if (x > 1) x = 1;
  else if (x < -1) x = -1;
  return x / (1 + 0.28 * x * x);
}

/** IDM acceleration (free road when gap = Infinity). */
export function idmAccel(v: number, v0: number, T: number, gap: number, vLead: number): number {
  const r = v0 > 0.1 ? v / v0 : v / 0.1;
  const r2 = r * r;
  let a = IDM_A_MAX * (1 - r2 * r2);
  if (gap < 1e9) {
    let ss = IDM_S0 + v * T + (v * (v - vLead)) / (2 * IDM_SQRT_AB);
    if (ss < IDM_S0) ss = IDM_S0;
    const g = gap > 0.1 ? gap : 0.1;
    const q = ss / g;
    a -= IDM_A_MAX * q * q;
  }
  if (a < -IDM_B_HARD) a = -IDM_B_HARD;
  return a;
}

/** smoothstep 0..1. */
export function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
