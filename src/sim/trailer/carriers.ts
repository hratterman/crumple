/**
 * Carrier registry (R-PHYS2) — PURE DATA: which vehicles carry cargo and
 * where (VehicleDef.name → surfaces as quads of body node ids, tie-down
 * anchors). Quads are [a, b, c, d] around their edge; the worker splits each
 * into (a, b, c) + (a, c, d) and orients both toward `center` (a rig-local
 * point inside the cargo space), so authoring order does not matter. A quad
 * naming a node the rig lacks is skipped (defs may rename closures: keep
 * this list in step, CONTRACTS "R-CRASH ↔ R-PHYS2").
 *
 * `door` quads can be disabled through `setCargoDoor` (a door the rig does
 * not model as a hinged closure: the box truck's / box trailer's rear doors);
 * a physical closure (the pickup tailgate, the utility trailer's ramp gate)
 * needs no flag: its quad follows the gate's nodes when it swings open.
 */
export interface CarrierQuad {
  nodes: readonly [string, string, string, string];
  door?: boolean;
}

export interface CarrierDef {
  quads: readonly CarrierQuad[];
  /** Rig-local point inside the cargo space (orients the quads). */
  center: readonly [number, number, number];
  /** Surface offset above the quad's node centres, m. */
  lift: number;
  /** Deck μ (plywood / steel bed / bedliner …) — combined with the cargo node μ as √(μ_a·μ_b). */
  friction: number;
  /** Strap tie-down nodes (body ids): straps pick the nearest pair across the load. */
  anchors: readonly string[];
}

function strip(stations: readonly string[], cols: readonly string[], fmt: (st: string, col: string) => string, door = false): CarrierQuad[] {
  const q: CarrierQuad[] = [];
  for (let i = 0; i + 1 < stations.length; i++) {
    for (let j = 0; j + 1 < cols.length; j++) {
      q.push({
        nodes: [fmt(stations[i]!, cols[j]!), fmt(stations[i]!, cols[j + 1]!), fmt(stations[i + 1]!, cols[j + 1]!), fmt(stations[i + 1]!, cols[j]!)],
        door,
      });
    }
  }
  return q;
}

const PICKUP_BED: CarrierDef = (() => {
  const st = ['b0', 'b1', 'b2', 'b3'];
  const floor = strip(st, ['bo_L', 'fl_L', 'fc', 'fl_R', 'bo_R'], (s, c) => `${s}_${c}`);
  const left = strip(st, ['bo_L', 'rl_L'], (s, c) => `${s}_${c}`);
  const right = strip(st, ['bo_R', 'rl_R'], (s, c) => `${s}_${c}`);
  return {
    quads: [
      ...floor,
      ...left,
      ...right,
      { nodes: ['b0_bo_L', 'b0_bo_R', 'b0_rl_R', 'b0_rl_L'] },
      { nodes: ['tg_0Li', 'tg_0Ri', 'tg_1Ri', 'tg_1Li'] },
    ],
    center: [0, 1.15, 2.0],
    lift: 0.03,
    friction: 0.55,
    anchors: ['b0_rl_L', 'b0_rl_R', 'b3_rl_L', 'b3_rl_R', 'b1_bo_L', 'b1_bo_R', 'b2_bo_L', 'b2_bo_R'],
  };
})();

const DECK = ['0', '1', '2', '3', '4'];

const TRAILER_UTILITY: CarrierDef = {
  quads: [
    ...strip(DECK, ['hi_L', 'c', 'hi_R'], (s, c) => (c === 'c' ? `dk${s}` : `r${s}_${c}`)),
    ...strip(DECK, ['hi_L', 'top_L'], (s, c) => (c === 'hi_L' ? `r${s}_hi_L` : `sd${s}_L`)),
    ...strip(DECK, ['hi_R', 'top_R'], (s, c) => (c === 'hi_R' ? `r${s}_hi_R` : `sd${s}_R`)),
    { nodes: ['r0_hi_L', 'r0_hi_R', 'sd0_R', 'sd0_L'] },
    { nodes: ['r4_hi_L', 'r4_hi_R', 'gt_R', 'gt_L'] },
  ],
  center: [0, 0.8, 0],
  lift: 0.02,
  friction: 0.6,
  anchors: ['r0_hi_L', 'r0_hi_R', 'r4_hi_L', 'r4_hi_R', 'r2_hi_L', 'r2_hi_R'],
};

const TRAILER_BOX: CarrierDef = {
  quads: [
    ...strip(DECK, ['hi_L', 'c', 'hi_R'], (s, c) => (c === 'c' ? `dk${s}` : `r${s}_${c}`)),
    ...strip(DECK, ['hi', 'm', 'top'], (s, c) => (c === 'hi' ? `r${s}_hi_L` : c === 'm' ? `sm${s}_L` : `sd${s}_L`)),
    ...strip(DECK, ['hi', 'm', 'top'], (s, c) => (c === 'hi' ? `r${s}_hi_R` : c === 'm' ? `sm${s}_R` : `sd${s}_R`)),
    { nodes: ['r0_hi_L', 'r0_hi_R', 'sm0_R', 'sm0_L'] },
    { nodes: ['sm0_L', 'sm0_R', 'sd0_R', 'sd0_L'] },
    { nodes: ['r4_hi_L', 'r4_hi_R', 'sm4_R', 'sm4_L'], door: true },
    { nodes: ['sm4_L', 'sm4_R', 'sd4_R', 'sd4_L'], door: true },
  ],
  center: [0, 1.3, 0],
  lift: 0.02,
  friction: 0.6,
  anchors: ['r0_hi_L', 'r0_hi_R', 'r4_hi_L', 'r4_hi_R', 'r2_hi_L', 'r2_hi_R', 'sm0_L', 'sm0_R', 'sm4_L', 'sm4_R'],
};

const BOXTRUCK_BOX: CarrierDef = (() => {
  const st = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
  return {
    quads: [
      ...strip(st, ['fl_L', 'fi_L', 'fc', 'fi_R', 'fl_R'], (s, c) => `${s}_${c}`),
      ...strip(st, ['fl_L', 'wl_L', 'wm_L', 'rl_L'], (s, c) => `${s}_${c}`),
      ...strip(st, ['fl_R', 'wl_R', 'wm_R', 'rl_R'], (s, c) => `${s}_${c}`),
      { nodes: ['b0_fl_L', 'b0_fl_R', 'b0_wl_R', 'b0_wl_L'] },
      { nodes: ['b0_wl_L', 'b0_wl_R', 'b0_wm_R', 'b0_wm_L'] },
      { nodes: ['b0_wm_L', 'b0_wm_R', 'b0_rl_R', 'b0_rl_L'] },
      { nodes: ['b7_fl_L', 'b7_fl_R', 'b7_wl_R', 'b7_wl_L'], door: true },
      { nodes: ['b7_wl_L', 'b7_wl_R', 'b7_wm_R', 'b7_wm_L'], door: true },
      { nodes: ['b7_wm_L', 'b7_wm_R', 'b7_rl_R', 'b7_rl_L'], door: true },
    ],
    center: [0, 2.2, 1.5],
    lift: 0.04,
    friction: 0.6,
    anchors: ['b0_fl_L', 'b0_fl_R', 'b7_fl_L', 'b7_fl_R', 'b2_fl_L', 'b2_fl_R', 'b4_fl_L', 'b4_fl_R', 'b0_wl_L', 'b0_wl_R', 'b7_wl_L', 'b7_wl_R'],
  };
})();

export const CARRIERS: Readonly<Record<string, CarrierDef>> = {
  pickup: PICKUP_BED,
  boxtruck: BOXTRUCK_BOX,
  trailerUtility: TRAILER_UTILITY,
  trailerBox: TRAILER_BOX,
};

/**
 * Cargo strap (2" polyester ratchet strap): working load ≈ 15 kN, breaking
 * strength ≈ 45 kN; webbing stretch ≈ 6 % at the working load, i.e. a
 * 2 m strap ≈ 125 kN/m; tensioned to ≈ 1.5 kN by the ratchet.
 */
export const STRAP = {
  /** Stiffness × length (N): k = STRAP.kL / length. */
  kL: 2.5e5,
  /** Damping ratio-ish, N·s/m. */
  c: 600,
  breakF: 4.5e4,
  /** Ratchet pretension, N. */
  pretension: 1500,
} as const;
