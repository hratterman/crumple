/**
 * Rigid shell cluster DEFINITIONS (pure data module, main-importable like the
 * vehicle builder): ShellDef / ShellZone / release tiers, the layout helper
 * the vehicle defs use, and compileShells (CompiledVehicle.shell). The
 * worker-only kernel (applyShell) and its runtime live in shell.ts, which
 * documents the model.
 */
import type { CompiledRig } from '../rig/types';

/** Node groups that form the rigid shell by default. */
export const SHELL_GROUPS: readonly string[] = ['body', 'hood', 'tailgate', 'subframe'];
/** Default shell spring frequency, Hz (per node to its goal). */
export const SHELL_FREQ_HZ = 60;
export const SHELL_ZETA = 0.7;
/** Deviation (m) where release starts / completes. */
export const SHELL_RELEASE_LO = 0.012;
export const SHELL_RELEASE_HI = 0.03;
/** Speed relative to the cluster's rigid motion (m/s) where release starts / completes: impacts release at once. */
export const SHELL_RELEASE_V_LO = 0.3;
export const SHELL_RELEASE_V_HI = 0.8;
export const RECAPTURE_S = 1.0;
/**
 * A yielding node held in a ground / collider contact past this deviation (m) is released: the bond
 * must never drag a node through a wall or a pole (it is stronger than the contact penalty).
 */
export const CONTACT_RELEASE = 0.01;
export const RECAPTURE_SPEED = 0.08;
/**
 * Post-impact set (crash ringing): once no node has newly released for RECAPTURE_IMPACT_S and the released
 * nodes' RMS speed relative to the rigid motion is below RECAPTURE_IMPACT_SPEED (torn-off debris may still fly), the shell is recaptured at
 * once in its current (crushed) shape. WHY: after the impact the released crumple zone and cell were a loose
 * beam mechanism that kept swinging (50 km/h sedan frontal: ±2 cm at ~4 Hz for 0.5 s; 100 km/h: ±5 cm at
 * ~3 Hz for 2 s) until the 1 s calm recapture could start. Folded sheet metal is a jammed, frictional stack:
 * it stays where the impact left it. The held shape still yields (yield tiers flow, a new impact releases).
 */
export const RECAPTURE_IMPACT_S = 0.15;
export const RECAPTURE_IMPACT_SPEED = 0.5;
/** …and at the latest this long after the last new release (a hard crash leaves few held nodes to judge the rigid motion by). */
export const RECAPTURE_IMPACT_MAX_S = 0.3;

/** Release thresholds of one tier: deviation (m) and speed relative to the rigid motion (m/s), start → complete. */
export interface ShellRelease {
  lo: number;
  hi: number;
  vLo: number;
  vHi: number;
}
/** Tier 0 default (nodes no zone claims): a dent or any impact lets go. */
export const SHELL_RELEASE_CRUMPLE: Readonly<ShellRelease> = { lo: SHELL_RELEASE_LO, hi: SHELL_RELEASE_HI, vLo: SHELL_RELEASE_V_LO, vHi: SHELL_RELEASE_V_HI };
/**
 * Front / rear crumple zones (released WHOLE): a parking bump (≲ 10 km/h)
 * stays held (elastic, as the 10 km/h frontal target asks), a real impact
 * (≳ 15 km/h, or a 5 cm dent) hands the whole zone to the beams.
 */
export const SHELL_RELEASE_ZONE: Readonly<ShellRelease> = { lo: 0.004, hi: 0.05, vLo: 4, vHi: 5 };
/** A box body (released whole): only a real hit on the box itself (2 cm / 4 m/s) hands it back to its beams. */
export const SHELL_RELEASE_DENT: Readonly<ShellRelease> = { lo: 0.02, hi: 0.025, vLo: 4, vHi: 5 };
/** A cell released whole (ShellLayout cellWhole): only a hard hit on the cab itself. */
export const SHELL_RELEASE_CELL_WHOLE: Readonly<ShellRelease> = { lo: 0.02, hi: 0.03, vLo: 2, vHi: 3 };
/** A body-on-frame vehicle's frame rails: yield from 5 mm, a hard hit releases them. */
export const SHELL_RELEASE_FRAME: Readonly<ShellRelease> = { lo: 0.005, hi: 0.01, vLo: 2, vHi: 3 };
/** Firewall ring: gives way to the engine stack in very hard frontals (windscreen frame strains, glass breaks). */
export const SHELL_RELEASE_FIREWALL: Readonly<ShellRelease> = { lo: 0.04, hi: 0.06, vLo: 3, vHi: 4 };
/**
 * Safety cell (tier 1): holds through the crush loads a frontal sends into
 * it; only a local intrusion (pole, deep offset, the engine reaching the
 * firewall) moves its nodes far enough / fast enough to let go.
 */
export const SHELL_RELEASE_CELL: Readonly<ShellRelease> = { lo: 0.03, hi: 0.15, vLo: 5, vHi: 9 };


/** VehicleDef.shell (optional, additive): one cluster, an array of clusters, or false (none). */
export interface ShellDef {
  groups?: readonly string[];
  /** Only nodes matching these ids (exact or prefix*) — e.g. one of a body-on-frame vehicle's bodies. Default all. */
  ids?: readonly string[];
  freqHz?: number;
  zeta?: number;
  /** Tier 0: every node no zone claims (crumple zones). Default SHELL_RELEASE_CRUMPLE. */
  release?: Partial<ShellRelease>;
  /** Calm time before a released shell is recaptured, s (default RECAPTURE_S). */
  recaptureS?: number;
  /** Tier 0 lets go as a whole once any of its nodes starts to (default false). */
  whole?: boolean;
  /**
   * Stiffer zones, first match wins: node ids (exact or prefix*) and their
   * release thresholds (default SHELL_RELEASE_CELL), e.g. the firewall ring
   * and the safety cell.
   */
  zones?: readonly ShellZone[];
  /** Node ids (exact or prefix*) left out of the cluster (e.g. anti-roll bar arms in the body group). */
  exclude?: readonly string[];
}

export interface ShellZone {
  ids: readonly string[];
  release?: Partial<ShellRelease>;
  whole?: boolean;
  /**
   * YIELD instead of release: past `release.lo` the node's rest position
   * flows with it (perfectly plastic at the bond force k·m·lo, no
   * springback); `hi` unused; an impact at the node (speed past vLo →
   * vHi) still releases it. The safety cell keeps its shape
   * under crash loads and dents (permanently) only where a load exceeds that.
   */
  yield?: boolean;
  /**
   * R-CRASH LATCHED zone (a door / trunk lid held in the body cluster while latched): beam endpoint pairs
   * (node ids) of its latch. Once any of them is broken the zone releases whole and its nodes stay out of
   * the cluster (no recapture) until a repair: the closure then swings on its own hinge beams.
   */
  latch?: readonly (readonly [string, string])[];
}

/**
 * The usual layout: front + rear crumple zones released whole, the safety
 * cell, the firewall ring, optional extra zones (first match wins, in that
 * order: the cell may claim the firewall ring's pillar / sill nodes).
 */
export function shellLayout(o: {
  front: readonly string[];
  rear: readonly string[];
  firewall?: readonly string[];
  cell: readonly string[];
  extra?: readonly ShellZone[];
  exclude?: readonly string[];
  freqHz?: number;
  zeta?: number;
  ids?: readonly string[];
  /**
   * The cell lets go WHOLE on a hard impact (SHELL_RELEASE_CELL_WHOLE) instead of yielding: for a cab
   * whose crash behaviour (glass, pillars, pole intrusion) was tuned on the beam lattice.
   */
  cellWhole?: boolean;
  /** Override of the cell tier's thresholds (merged over SHELL_RELEASE_CELL / _CELL_WHOLE). */
  cellRelease?: Partial<ShellRelease>;
  /** Override of the crumple zones' thresholds (merged over SHELL_RELEASE_ZONE). */
  zoneRelease?: Partial<ShellRelease>;
}): ShellDef {
  const zr = { ...SHELL_RELEASE_ZONE, ...o.zoneRelease };
  const zones: ShellZone[] = [
    { ids: o.front, release: zr, whole: true, yield: true },
    { ids: o.rear, release: zr, whole: true, yield: true },
  ];
  zones.push(
    o.cellWhole
      ? { ids: o.cell, release: { ...SHELL_RELEASE_CELL_WHOLE, ...o.cellRelease }, whole: true }
      : { ids: o.cell, release: { ...SHELL_RELEASE_CELL, ...o.cellRelease }, yield: true },
  );
  if (o.firewall) zones.push({ ids: o.firewall, release: SHELL_RELEASE_FIREWALL, whole: true });
  zones.push(...(o.extra ?? []));
  return {
    zones,
    ...(o.exclude ? { exclude: o.exclude } : {}),
    ...(o.ids ? { ids: o.ids } : {}),
    ...(o.freqHz !== undefined ? { freqHz: o.freqHz } : {}),
    ...(o.zeta !== undefined ? { zeta: o.zeta } : {}),
  };
}

export interface CompiledShell {
  /** RIG-LOCAL node indices, ascending. */
  nodes: Int32Array;
  /** Rest positions (rig rest pose) xyz per cluster node. */
  rest: Float64Array;
  /** Per cluster node: CSR into `beams` (rig-local beam indices incident to the node). */
  beamStart: Int32Array;
  beams: Int32Array;
  k: number;
  cd: number;
  recaptureS: number;
  /** Per cluster node: 0 crumple tier, z + 1 = ShellDef.zones[z]. */
  tier: Uint8Array;
  /**
   * Per tier: 1 = WHOLE release — the first node to start releasing trips
   * the tier and every node of it lets go (crumple zones: the crush then
   * runs on the beams alone, exactly as tuned, instead of ahead of a held
   * region that would add stiffness and damping in front of the crush front).
   */
  whole: Uint8Array;
  /** Per tier: 1 = yield tier (ShellZone.yield). */
  yields: Uint8Array;
  /** Per tier: [lo, hi, vLo, vHi]. */
  release: Float64Array;
  /** R-CRASH: per tier, CSR into `latchBeams` (rig-local beam indices of the zone's latch; ShellZone.latch). */
  latchStart: Int32Array;
  latchBeams: Int32Array;
}

/** Compiles VehicleDef.shell: clusters in order, a node claimed by an earlier cluster is skipped by later ones. */
export function compileShells(rig: CompiledRig, bodyNodeCount: number, def: ShellDef | readonly ShellDef[] | false | undefined): CompiledShell[] {
  if (def === false) return [];
  const defs: readonly (ShellDef | undefined)[] = def === undefined ? [undefined] : Array.isArray(def) ? (def as readonly ShellDef[]) : [def as ShellDef];
  const taken = new Uint8Array(rig.nodeCount);
  const out: CompiledShell[] = [];
  for (const d of defs) {
    const c = compileShell(rig, bodyNodeCount, d, taken);
    if (c) out.push(c);
  }
  return out;
}

/** Node-id pattern: exact, or `*` wildcards anywhere (`s5_*`, `f*_L`). */
export function globMatch(id: string, pat: string): boolean {
  const i = pat.indexOf('*');
  if (i < 0) return id === pat;
  if (!id.startsWith(pat.slice(0, i))) return false;
  const rest = pat.slice(i + 1);
  if (rest === '') return true;
  for (let k = i; k <= id.length; k++) if (globMatch(id.slice(k), rest)) return true;
  return false;
}

function compileShell(rig: CompiledRig, bodyNodeCount: number, def: ShellDef | undefined, taken: Uint8Array): CompiledShell | null {
  const groups = new Set(def?.groups ?? SHELL_GROUPS);
  const match = (id: string, pats: readonly string[]): boolean => pats.some((p) => globMatch(id, p));
  const exclude = def?.exclude ?? [];
  const nodes: number[] = [];
  for (let i = 0; i < bodyNodeCount; i++) {
    const g = rig.nodeGroup[i]!;
    if (g < 0 || !groups.has(rig.groups[g]!)) continue;
    if (match(rig.nodeIds[i]!, exclude)) continue;
    if (def?.ids && !match(rig.nodeIds[i]!, def.ids)) continue;
    if (taken[i]) continue;
    if (!(rig.nodeInvMass[i]! > 0)) continue;
    nodes.push(i);
  }
  if (nodes.length < 4) return null;
  for (const n of nodes) taken[n] = 1;
  const local = new Int32Array(rig.nodeCount).fill(-1);
  nodes.forEach((n, k) => (local[n] = k));
  const inc: number[][] = nodes.map(() => []);
  for (let b = 0; b < rig.beamCount; b++) {
    const a = local[rig.beamA[b]!]!;
    const c = local[rig.beamB[b]!]!;
    if (a >= 0) inc[a]!.push(b);
    if (c >= 0) inc[c]!.push(b);
  }
  const beamStart = new Int32Array(nodes.length + 1);
  const beams: number[] = [];
  inc.forEach((l, k) => {
    beamStart[k] = beams.length;
    beams.push(...l);
  });
  beamStart[nodes.length] = beams.length;
  const rest = new Float64Array(nodes.length * 3);
  nodes.forEach((n, k) => {
    rest[3 * k] = rig.nodePos[3 * n]!;
    rest[3 * k + 1] = rig.nodePos[3 * n + 1]!;
    rest[3 * k + 2] = rig.nodePos[3 * n + 2]!;
  });
  const w = 2 * Math.PI * (def?.freqHz ?? SHELL_FREQ_HZ);
  const zones = def?.zones ?? [];
  const tier = Uint8Array.from(
    nodes.map((n) => {
      const z = zones.findIndex((zn) => match(rig.nodeIds[n]!, zn.ids));
      return z + 1;
    }),
  );
  const tiers = [{ ...SHELL_RELEASE_CRUMPLE, ...def?.release }, ...zones.map((z) => ({ ...SHELL_RELEASE_CELL, ...z.release }))];
  // latch beams per tier (tier 0 has none)
  const beamOf = new Map<string, number>();
  for (let b = 0; b < rig.beamCount; b++) {
    const a = rig.nodeIds[rig.beamA[b]!]!;
    const c = rig.nodeIds[rig.beamB[b]!]!;
    beamOf.set(`${a}|${c}`, b);
    beamOf.set(`${c}|${a}`, b);
  }
  const latchStart = [0, 0];
  const latchBeams: number[] = [];
  for (const z of zones) {
    for (const [a, c] of z.latch ?? []) {
      const b = beamOf.get(`${a}|${c}`);
      if (b === undefined) throw new Error(`shell: latch beam ${a}–${c} not in the rig`);
      latchBeams.push(b);
    }
    latchStart.push(latchBeams.length);
  }
  return {
    nodes: Int32Array.from(nodes),
    rest,
    beamStart,
    beams: Int32Array.from(beams),
    k: w * w,
    cd: 2 * (def?.zeta ?? SHELL_ZETA) * w,
    recaptureS: def?.recaptureS ?? RECAPTURE_S,
    tier,
    release: Float64Array.from(tiers.flatMap((r) => [r.lo, r.hi, r.vLo, r.vHi])),
    whole: Uint8Array.from([def?.whole ? 1 : 0, ...zones.map((z) => (z.whole ? 1 : 0))]),
    yields: Uint8Array.from([0, ...zones.map((z) => (z.yield ? 1 : 0))]),
    latchStart: Int32Array.from(latchStart),
    latchBeams: Int32Array.from(latchBeams),
  };
}

