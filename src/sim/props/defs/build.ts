/**
 * Prop rig authoring helper (P5, U1). PURE DATA MODULE (main may import it
 * through the prop defs): no engine/state/worker imports, no three, no DOM.
 * Runs once at module load (not a hot loop: Math.* and allocation are fine).
 *
 * A prop rig is authored as nodes with REAL masses plus beams with RELATIVE
 * stiffness weights. The absolute stiffness is then SOLVED from the masses
 * (like testrigs' softCube): node i can carry Σk ≤ (ω/dt)²·m_i, i.e.
 * K_i = (ω/dt)²·m_i / Σw_i per unit weight, and beam b gets
 * k_b = w_b·min(K_a, K_b); every node is at or under the prop's ω·dt target
 * and the declared masses are never raised (no MINIMASS drift: the catalog
 * test asserts the authored totals). Damping per beam is a ζ fraction of the
 * beam's critical damping, scaled down globally if any node would exceed
 * its (Σd/m)·dt target. Yield / break thresholds are given as STRAINS of
 * the solved beam (force = k·L·strain) or as absolute forces (anchors).
 *
 * NODE CONVENTION: every prop node has ground radius = object-contact
 * radius = `r` (prop-specific) and sits `r` INSIDE the nominal outer
 * surface, so the nominal surface is the contact surface for the ground,
 * static colliders and other objects alike; the base node centres sit at
 * y = r (the nominal base on y = 0) and stack pitches are exact.
 */
import type { RigBeamDef, RigDef, RigNodeDef } from '../../rig/types';

const DT = 1 / 2000;

export interface PropNodeSpec {
  id: string;
  pos: [number, number, number];
  /** kg; ≤ 0 = pinned anchor (collidable false, no object contact). */
  mass: number;
  /** Ground + object contact radius override (default the rig's r). */
  r?: number;
  friction?: number;
  group?: string;
  /** false = no node-vs-node contact (a face handled as triangles: the guardrail's rail). */
  objContact?: boolean;
}

export interface PropBeamSpec {
  a: string;
  b: string;
  /** Relative stiffness weight (k = w·K). Default 1. */
  w?: number;
  /** Damping ratio override for this beam (default the rig's zeta). */
  zeta?: number;
  /** Yield strain (deform = k·L·yieldStrain); omitted/0 with no `deform` = never yields. */
  yieldStrain?: number;
  /** Break strain (breakF = k·L·breakStrain); omitted/0 with no `breakF` = unbreakable. */
  breakStrain?: number;
  /** Absolute yield force, N (wins over yieldStrain). */
  deform?: number;
  /** Absolute break force, N (wins over breakStrain). */
  breakF?: number;
  type?: RigBeamDef['type'];
}

export interface PropRigOptions {
  name: string;
  /** Default ground/object contact radius, m. */
  r: number;
  /** Default node μ. */
  friction: number;
  /** Worst-node ω·dt the stiffness is solved for. */
  omegaDt: number;
  /** Beam damping ratio (fraction of 2·sqrt(k·m_r)). */
  zeta: number;
  /** Worst-node (Σd/m)·dt cap. Default 0.6. */
  dampDt?: number;
}

/** Solved rig + the stiffness scale (diagnostics / tests). */
export interface PropRigResult {
  rig: RigDef;
  /** Smallest per-node stiffness capacity, N/m per unit weight (diagnostics). */
  kUnit: number;
}

export function buildPropRig(nodes: PropNodeSpec[], beams: PropBeamSpec[], o: PropRigOptions): PropRigResult {
  const index = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (index.has(n.id)) throw new Error(`prop ${o.name}: duplicate node ${n.id}`);
    index.set(n.id, i);
  });
  const ia = beams.map((b) => {
    const i = index.get(b.a);
    if (i === undefined) throw new Error(`prop ${o.name}: unknown node ${b.a}`);
    return i;
  });
  const ib = beams.map((b) => {
    const i = index.get(b.b);
    if (i === undefined) throw new Error(`prop ${o.name}: unknown node ${b.b}`);
    return i;
  });
  const len = beams.map((_, k) => {
    const pa = nodes[ia[k]!]!.pos;
    const pb = nodes[ib[k]!]!.pos;
    return Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  });
  // Per-node stiffness capacity K_i = (ω·dt/dt)²·m_i / Σw_i; each beam takes
  // k = w·min(K_a, K_b), so Σk_i ≤ (ω/dt)²·m_i holds at EVERY node (pinned
  // endpoints do not constrain) while heavy regions stay stiff.
  const sumW = new Float64Array(nodes.length);
  beams.forEach((b, k) => {
    const w = b.w ?? 1;
    sumW[ia[k]!]! += w;
    sumW[ib[k]!]! += w;
  });
  const wt = (o.omegaDt / DT) ** 2;
  const cap = nodes.map((n, i) => (n.mass > 0 && sumW[i]! > 0 ? (wt * n.mass) / sumW[i]! : Infinity));
  const kOf = beams.map((b, k) => (b.w ?? 1) * Math.min(cap[ia[k]!]!, cap[ib[k]!]!));
  let kUnit = Infinity;
  for (const c of cap) kUnit = Math.min(kUnit, c);
  if (!Number.isFinite(kUnit) || kOf.some((k) => !Number.isFinite(k))) throw new Error(`prop ${o.name}: a beam joins two pinned nodes`);

  // Damping: ζ of each beam's critical value, then one global scale for the (Σd/m)·dt cap.
  const d = beams.map((b, k) => {
    const ma = nodes[ia[k]!]!.mass;
    const mb = nodes[ib[k]!]!.mass;
    const mr = ma > 0 && mb > 0 ? (ma * mb) / (ma + mb) : Math.max(ma, mb);
    return (b.zeta ?? o.zeta) * 2 * Math.sqrt(kOf[k]! * mr);
  });
  const sumD = new Float64Array(nodes.length);
  beams.forEach((_, k) => {
    sumD[ia[k]!]! += d[k]!;
    sumD[ib[k]!]! += d[k]!;
  });
  const dCap = o.dampDt ?? 0.6;
  let dScale = 1;
  nodes.forEach((n, i) => {
    if (n.mass > 0 && sumD[i]! > 0) dScale = Math.min(dScale, (dCap * n.mass) / (sumD[i]! * DT));
  });

  const rigNodes: RigNodeDef[] = nodes.map((n) => {
    const pinned = n.mass <= 0;
    const r = n.r ?? o.r;
    const node: RigNodeDef = {
      id: n.id,
      pos: n.pos,
      mass: pinned ? 0 : n.mass,
      friction: n.friction ?? o.friction,
      radius: r,
      objRadius: r,
    };
    if (n.group !== undefined) node.group = n.group;
    if (n.objContact === false) node.objContact = false;
    if (pinned) {
      node.collidable = false;
      node.objContact = false;
    }
    return node;
  });
  const rigBeams: RigBeamDef[] = beams.map((b, k) => {
    const kb = kOf[k]!;
    const L = len[k]!;
    const deform = b.deform ?? (b.yieldStrain ? kb * L * b.yieldStrain : 0);
    const breakF = b.breakF ?? (b.breakStrain ? kb * L * b.breakStrain : 0);
    return {
      a: b.a,
      b: b.b,
      type: b.type ?? 'normal',
      k: kb,
      d: d[k]! * dScale,
      deform: deform > 0 ? deform : 0,
      breakF: breakF > 0 ? breakF : 0,
    };
  });
  return { rig: { name: o.name, nodes: rigNodes, beams: rigBeams }, kUnit };
}

/** Points on a horizontal ring: k-th at angle phase + 2πk/n, (x, z) = radius·(sin, −cos) (k = 0 faces −Z = front). */
export function ringPoint(radius: number, y: number, k: number, n: number, phase = 0): [number, number, number] {
  const a = phase + (2 * Math.PI * k) / n;
  return [round(radius * Math.sin(a)), y, round(-radius * Math.cos(a))];
}

/** Rounds authored coordinates to 1e-9 m so rest poses are platform-stable data. */
export function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
