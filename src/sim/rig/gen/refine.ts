/**
 * R-RIG: refineVehicle — a standard VehicleDef (the backbone) → a
 * high-density variant (pure generator; see ./types.ts for the pipeline).
 *
 * KEPT from the backbone, bit for bit: every node id and rest position,
 * wheels, drivetrain, brakes, aero, dampers, steering, frame nodes, the
 * suspension beams (shock / hydro / anything touching a non-shell node:
 * subframe, knuckle, engine, axle) — so R-PHYS's hardpoints and rates, the
 * harness probes and the shell zones carry over unchanged.
 * ADDED: sheet-metal skins (./skin.ts) and closed-section members
 * (./member.ts), appended after the backbone's nodes and beams (canonical
 * order: base body nodes / beams keep their indices).
 * MASS: the new parts carry their real mass (gauge × density × area); the
 * DONOR backbone nodes (body-group nodes joined only by body links: never a
 * suspension / engine / axle anchor; weighted per def) give it up with a
 * bounded field s_i = 1 + w_i·(c0 + c1·Δz + c2·Δy + c3·Δx + c4·Δx² + c5·Δy² +
 * c6·Δz²) solved so the TOTAL mass, the CG (x, y, z) and the second moments
 * (pitch / yaw / roll inertia) equal the standard rig's exactly.
 * STABILITY: a SHELL-CLUSTER node whose mass drops by s (or which gains seam /
 * tie beams) has every scalable beam (normal / support / bounded between
 * shell-cluster nodes) scaled by f = (s·K − K_fixed − K_seam)/K_scalable
 * (K = its Σk), and its damping by the same factor, so Σk/m — hence ω·dt —
 * never exceeds the backbone's; deform / break FORCES are kept (the crash
 * load paths keep their yield and tear loads). A donor outside the clusters
 * (a ladder frame) only gives the mass its own Σk / Σd leave spare: its beams
 * are never touched.
 */
import { compileVehicle, vehicleOmegaDtLimit } from '../../vehicle/builder';
import { compileShells, globMatch, type ShellDef, type ShellRelease, type ShellZone } from '../../vehicle/shellDefs';
import type { VehicleDef } from '../../vehicle/types';
import { computeStabilityReport, RIG_DT } from '../builder';
import type { RigBeamDef, RigNodeDef, RigTriangleDef } from '../types';
import { buildMember, MEMBER_TEAR_RATIO, MEMBER_YIELD_STRAIN, mirrorMember, type BoxMemberSpec } from './member';
import { sheetYieldStrain } from './materials';
import { buildSkin, SEAM_TEAR_RATIO, SEAM_YIELD_STRAIN, SKIN_TEAR_RATIO, SKIN_ZETA } from './skin';
import type { CollisionTriangle, RigGenReport, SeamKind, SkinPanelData, SkinSet, SkinSpec } from './types';

/** Node groups of the body shell the generator may re-mass / re-stiffen. */
export const SHELL_BODY_GROUPS: readonly string[] = ['body', 'hood', 'tailgate'];
/** ω·dt target of generated shell nodes (vehicle MINIMASS limit for group 'body' is 0.495). */
export const GEN_OMEGA_DT = 0.47;
/** (Σd/m)·dt target of generated nodes (validator limit 1). */
export const GEN_DAMP_DT = 0.9;
/**
 * Ground / collider contact radius of generated sheet / wall nodes, m. A sheet wraps round a pole like a real
 * door skin; with the body nodes' 5 cm a skin node sliding round the pole's edge sat inside the crash harness's
 * 0.2 m pull-through band (pole r 0.15 + 0.05) and read as "pulled through"; 6 cm keeps a wrapping sheet outside it.
 */
export const SKIN_RADIUS = 0.06;
/**
 * A low sheet node (a fascia's lower lip, a sill cover) keeps SKIN_RADIUS_LOW_CLEAR of ground clearance under its
 * contact sphere at rest, down to a 2 cm sphere: with the full 6 cm sphere the beater's fascia lip (15 cm) touched
 * the road in a 1 g stop's nose dive and was torn out of its shell cluster.
 */
export const SKIN_RADIUS_LOW_CLEAR = 0.12;
const skinRadius = (y: number): number => Math.min(SKIN_RADIUS, Math.max(0.02, y - SKIN_RADIUS_LOW_CLEAR));
/** Bounds of the mass field (fraction of a donor's own mass kept). */
const MASS_FLOOR = 0.55;
const MASS_CEIL = 1.6;
/** Most of a frame node's stability budget its seams / standoffs / ties may take (the rest stays the backbone's). */
const SEAM_FRAME_SHARE = 0.15;
/** Fraction of the per-group ω·dt limit the re-budgeted backbone nodes may use. */
const LIMIT_MARGIN = 0.997;
/** Member ties (welds of a section ring to its station) tear at this strain. */
export const TIE_TEAR_STRAIN = 0.6;

export interface RefineOptions {
  /** Variant name, e.g. 'sedan.high'. */
  name: string;
  skins: SkinSet;
  /** Construction of each sampled panel (null = leave that panel on its frame nodes). */
  skinSpec: (panel: SkinPanelData) => SkinSpec | null;
  /** Closed-section members (mirrored when `mirror`). */
  members?: readonly BoxMemberSpec[];
  /** Backbone nodes (ids / globs) that may give up mass for the new parts; default every eligible shell node. */
  massDonors?: readonly string[];
  /**
   * Relative share of the mass change each eligible donor takes (weighted least-norm: Δm_i = m_i·w_i·(λ·basis_i));
   * 0 = keeps its mass. Default 1. A def protects its tuned crumple zones / safety-cell sides with small weights so
   * the change comes out of the headroom under the stability limit (no tuned beam softens).
   */
  massDonorWeight?: (id: string) => number;
  /**
   * Also keep the second moments (pitch / yaw / roll inertia) of the standard rig, not only mass + CG. Default
   * false: the bisect over the validation suite showed it moves chaotic crash rows (coupe pole hinge pillar,
   * 100 km/h bumper tear) without fixing what it was added for (the box truck J-turn); the inertia drift is in the
   * report (`inertiaDriftPct`).
   */
  matchInertia?: boolean;
  /**
   * Release thresholds for the clusters of parts in a WHOLE-release zone (crumple zones, firewall ring, box
   * bodies; default: the zone's own). A whole zone's per-node trigger is tuned to keep a lumped zone held through a
   * parking bump; a sheet cluster holding that long acts as a rigid stiffener in the crush. The beater sets the
   * per-node crumple tier (SHELL_RELEASE_CRUMPLE: 12 mm or 0.3 m/s): its sheets let go on impact and buckle with
   * the structure (30 km/h crush 38.5 → 40.5 cm; on the sedan the same costs the 10 km/h plastic target, 3 → 7 %).
   * (Leaving such parts out of the clusters entirely was tried: free 0.8 mm sheets ring at 10 Hz while driving.)
   */
  wholeZoneSheetRelease?: Partial<ShellRelease>;
}

export interface RefinedVehicle {
  def: VehicleDef;
  report: RigGenReport;
  collision: CollisionTriangle[];
  /** Sheet node ids per render panel id (the HD visual binds each panel to its own sheet). */
  skinNodes: Record<string, string[]>;
  /** Member wall node ids per member id. */
  memberNodes: Record<string, string[]>;
  /** Seam beams per render panel (node-id pairs: sheet node, frame node). */
  seams: Record<string, [string, string][]>;
}

type PartBeamKind = 'membrane' | 'seam' | 'standoff' | 'tie';
interface PartBeam {
  a: string;
  b: string;
  kind: PartBeamKind;
  w: number;
  /** membrane: yield strain multiplier (beads < 1). */
  soft: number;
}
interface Part {
  kind: 'skin' | 'member';
  name: string;
  prefix: string;
  ids: string[];
  pos: (readonly number[])[];
  mass: number[];
  beams: PartBeam[];
  seam: SeamKind;
  tris: [string, string, string][];
  /** Backbone nodes that donate this part's mass locally (member chain); none = the global solve. */
  donors?: string[];
  /** Membrane yield strain. */
  yieldStrain: number;
}

/**
 * Sheet dent criterion is mesh-objective: a panel sets when the local displacement across one grid cell exceeds
 * the yield extension of a SKIN_REF_PITCH cell, so a finer sheet (ultra) yields at a proportionally higher beam
 * strain. Without this the finer grid's local panel modes (which the membrane model resolves but whose real
 * bending stiffness it lacks) dent the roof and doors in a 10 km/h bump.
 */
export const SKIN_REF_PITCH = 0.15;

const sig3 = (v: number): number => {
  if (v === 0 || !Number.isFinite(v)) return v;
  const p = 10 ** (2 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
};
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export function refineVehicle(base: VehicleDef, opts: RefineOptions): RefinedVehicle {
  const baseCv = compileVehicle(base);
  // start from the masses the standard car actually runs with (its declared masses after MINIMASS)
  const nodes: RigNodeDef[] = base.body.nodes.map((n, i) => ({ ...n, pos: [...n.pos] as [number, number, number], ...(n.mass > 0 ? { mass: Math.max(n.mass, round4(baseCv.rig.nodeMass[i]!)) } : {}) }));
  const beams: RigBeamDef[] = base.body.beams.map((b) => ({ ...b }));
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const posOf = (id: string): readonly number[] => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`refine ${opts.name}: unknown backbone node ${id}`);
    return nodes[i]!.pos;
  };
  // "shell" = a body / hood / tailgate node that a standard shell cluster holds: a body-group node the def leaves
  // out of every cluster (the box truck's ladder frame lattice, an anti-roll-bar anchor) is structure the shell
  // does not govern — its beams are never rescaled, it never donates mass and seams avoid it
  const inCluster = new Set<number>();
  for (const c of compileShells(baseCv.rig, baseCv.bodyNodeCount, base.shell)) for (const n of c.nodes) inCluster.add(n);
  const shellGroup = (id: string): boolean => {
    const i = index.get(id);
    return i !== undefined && inCluster.has(i) && SHELL_BODY_GROUPS.includes(nodes[i]!.group ?? '');
  };

  // ---- parts: skins, then members
  const parts: Part[] = [];
  /** Non-shell frame nodes a panel had to be seamed to (a battery box on the ladder frame): they keep seam room. */
  const frameAttach = new Set<string>();
  for (const panel of opts.skins.panels) {
    const spec = opts.skinSpec(panel);
    if (!spec) continue;
    const listed = spec.attach ? nodes.filter((n) => spec.attach!.some((p) => globMatch(n.id, p))).map((n) => n.id) : panel.attach.filter((id) => index.has(id));
    const inShell = listed.filter(shellGroup);
    if (listed.length === 0) throw new Error(`refine ${opts.name}: panel ${panel.id} has no attach nodes on the backbone`);
    const build = (ids: readonly string[]): ReturnType<typeof buildSkin> => buildSkin(panel, spec, new Map(ids.map((id) => [id, posOf(id)])));
    const seamsOf = (b: ReturnType<typeof buildSkin>): number => b.beams.filter((x) => x.kind === 'seam').length;
    // seams go to shell-cluster nodes; a panel the cluster nodes cannot hold (a battery box on the ladder frame,
    // a box wall whose cluster nodes are out of seam reach) keeps its frame mounts
    const all = build(listed);
    const shellOnly = inShell.length > 0 && inShell.length < listed.length ? build(inShell) : null;
    const s = inShell.length === listed.length || (shellOnly && 2 * seamsOf(shellOnly) >= seamsOf(all)) ? (shellOnly ?? all) : all;
    if (s === all) for (const id of listed) if (!shellGroup(id)) frameAttach.add(id);
    parts.push({
      kind: 'skin',
      name: s.panel,
      prefix: s.prefix,
      ids: s.ids,
      pos: s.pos,
      mass: s.mass,
      beams: s.beams.map((b) => ({ a: b.a, b: b.b, w: b.w, soft: 1, kind: b.kind === 'seam' ? 'seam' : b.kind === 'standoff' ? 'standoff' : 'membrane' })),
      seam: s.seam,
      tris: s.tris,
      yieldStrain: (spec.yieldStrain ?? sheetYieldStrain(s.grade)) * Math.max(1, SKIN_REF_PITCH / opts.skins.pitch),
    });
  }
  for (const m0 of opts.members ?? []) {
    for (const spec of m0.mirror ? [m0, mirrorMember(m0)] : [m0]) {
      const m = buildMember(spec, posOf);
      parts.push({
        kind: 'member',
        name: m.id,
        prefix: `m_${m.id}`,
        ids: m.nodes.map((n) => n.id),
        pos: m.nodes.map((n) => n.pos),
        mass: m.nodes.map((n) => n.mass),
        beams: m.beams.map((b) => ({ a: b.a, b: b.b, w: b.w, soft: b.soft, kind: b.kind === 'tie' ? 'tie' : 'membrane' })),
        seam: 'weld',
        tris: m.tris,
        donors: m.chain,
        yieldStrain: MEMBER_YIELD_STRAIN,
      });
    }
  }

  // ---- mass solve (total + CG x, y, z)
  const M = baseCv.totalMass;
  const cg = [0, 0, 0];
  for (let i = 0; i < baseCv.rig.nodeCount; i++) for (let k = 0; k < 3; k++) cg[k] = cg[k]! + (baseCv.rig.nodeMass[i]! * baseCv.rig.nodePos[3 * i + k]!) / M;
  // Elastic breakable links (deform 0: glass, hood latch / rests, trunk rests) keep their stiffness: their break
  // FORCE was tuned with it (latch pops at 4 kN, glass at 3 % strain), so the node's other beams give way instead.
  const scalable = (b: RigBeamDef): boolean =>
    (b.type === 'normal' || b.type === 'support' || b.type === 'bounded') && b.deform !== 0 && shellGroup(b.a) && shellGroup(b.b);
  const eligible = new Uint8Array(nodes.length);
  nodes.forEach((n, i) => {
    if (SHELL_BODY_GROUPS.includes(n.group ?? '') && n.mass > 0 && (!opts.massDonors || opts.massDonors.some((p) => globMatch(n.id, p)))) eligible[i] = 1;
  });
  // donors never touch the suspension / engine / axle (their anchors keep R-PHYS's compliance) or shock / hydro beams
  const shellLink = (b: RigBeamDef): boolean => (b.type === 'normal' || b.type === 'support' || b.type === 'bounded') && shellGroup(b.a) && shellGroup(b.b);
  const bodyGroup = (id: string): boolean => SHELL_BODY_GROUPS.includes(nodes[index.get(id) ?? -1]?.group ?? '');
  const bodyLink = (b: RigBeamDef): boolean => (b.type === 'normal' || b.type === 'support' || b.type === 'bounded') && bodyGroup(b.a) && bodyGroup(b.b);
  // Σk / Σd per backbone node as the standard car has them
  const Kbase = new Map<string, number>();
  const Dbase = new Map<string, number>();
  for (const b of beams)
    for (const id of [b.a, b.b]) {
      Kbase.set(id, (Kbase.get(id) ?? 0) + (b.k ?? 9e6));
      Dbase.set(id, (Dbase.get(id) ?? 0) + (b.d ?? 0));
    }
  for (const w of base.wheels)
    for (const id of w.attach) {
      Kbase.set(id, (Kbase.get(id) ?? 0) + 2 * (w.attachSpring ?? 0));
      Dbase.set(id, (Dbase.get(id) ?? 0) + 2 * (w.attachDamp ?? 0));
    }
  // a donor outside the shell clusters keeps every beam as tuned: it gives only the mass its own Σk / Σd leave spare
  const floorOf = Float64Array.from(nodes, (n) => {
    if (shellGroup(n.id) || !(n.mass > 0)) return MASS_FLOOR;
    const kMin = ((Kbase.get(n.id) ?? 0) * (frameAttach.has(n.id) ? 1 + SEAM_FRAME_SHARE : 1)) / (n.mass * ((vehicleOmegaDtLimit(n.group) * LIMIT_MARGIN) / RIG_DT) ** 2);
    const dMin = ((Dbase.get(n.id) ?? 0) * RIG_DT) / (0.95 * n.mass);
    return Math.max(MASS_FLOOR, kMin, dMin);
  });
  // donors: body-group nodes joined only by body links (never the suspension / engine / axle anchors)
  for (const b of beams) {
    if (bodyLink(b)) continue;
    for (const id of [b.a, b.b]) {
      const i = index.get(id);
      if (i !== undefined) eligible[i] = 0;
    }
  }
  for (const w of base.wheels) for (const id of w.attach) eligible[index.get(id)!] = 0;
  nodes.forEach((_, i) => {
    if (floorOf[i]! >= 0.999) eligible[i] = 0;
  });
  // moments the field keeps: mass, first moments (CG) and the second moments Σm·x², Σm·y², Σm·z² (with the CG,
  // the diagonal of the inertia tensor: roll / pitch / yaw inertia), so the sheets' mass sits where the
  // standard car had it lumped, to second order
  const momOf = (p: readonly number[]): number[] => [1, p[2]!, p[1]!, p[0]!, p[0]! * p[0]!, p[1]! * p[1]!, p[2]! * p[2]!];
  const NM = 7;
  const target = new Array<number>(NM).fill(0);
  for (let i = 0; i < baseCv.rig.nodeCount; i++) {
    const f = momOf([baseCv.rig.nodePos[3 * i]!, baseCv.rig.nodePos[3 * i + 1]!, baseCv.rig.nodePos[3 * i + 2]!]);
    for (let r = 0; r < NM; r++) target[r] = target[r]! + baseCv.rig.nodeMass[i]! * f[r]!;
  }
  const newMom = new Array<number>(NM).fill(0);
  for (const p of parts)
    p.ids.forEach((_, i) => {
      const f = momOf(p.pos[i]!);
      for (let r = 0; r < NM; r++) newMom[r] = newMom[r]! + p.mass[i]! * f[r]!;
    });
  const wOf = new Float64Array(nodes.length);
  nodes.forEach((n, i) => {
    wOf[i] = eligible[i] ? (opts.massDonorWeight ? opts.massDonorWeight(n.id) : 1) : 0;
    if (!(wOf[i]! > 0)) eligible[i] = 0;
  });
  // members take their wall mass from the backbone chain they are built round (local: the rail's lumped mass
  // already included its walls); the global field then only absorbs the sheets and the CG
  const m0 = Float64Array.from(nodes, (n) => n.mass);
  for (const p of parts) {
    if (!p.donors) continue;
    const pm = p.mass.reduce((a, b) => a + b, 0);
    const chain = p.donors.map((id) => index.get(id)!);
    const cm = chain.reduce((a, i) => a + nodes[i]!.mass, 0);
    for (const i of chain) m0[i] = m0[i]! - (pm * nodes[i]!.mass) / cm;
  }
  const bar = [0, 0, 0];
  let mE = 0;
  nodes.forEach((n, i) => {
    if (!eligible[i]) return;
    mE += m0[i]! * wOf[i]!;
    for (let k = 0; k < 3; k++) bar[k] = bar[k]! + m0[i]! * wOf[i]! * n.pos[k]!;
  });
  const addMass = opts.massDonors !== undefined && opts.massDonors.length === 0;
  if (!(mE > 0) && !addMass) throw new Error(`refine ${opts.name}: no mass donors`);
  for (let k = 0; k < 3; k++) bar[k] = bar[k]! / mE;
  const restMom = [...newMom];
  for (let i = 0; i < baseCv.rig.nodeCount; i++) {
    if (i < nodes.length && eligible[i]) continue;
    const m = i < nodes.length ? m0[i]! : baseCv.rig.nodeMass[i]!;
    const f = momOf([baseCv.rig.nodePos[3 * i]!, baseCv.rig.nodePos[3 * i + 1]!, baseCv.rig.nodePos[3 * i + 2]!]);
    for (let r = 0; r < NM; r++) restMom[r] = restMom[r]! + m * f[r]!;
  }
  // Δm_i = m_i·w_i·Σ c_k·g_k(p_i − p̄) (weighted least-norm; g = 1, dz, dy, dx, dx², dy², dz²) with the NM moment
  // rows fixed; BOUNDED: a donor whose field would leave it below its floor (or above MASS_CEIL) is pinned there and
  // the rest re-solved (active set). If the second moments cannot be met inside the bounds, mass + CG only.
  const solveField = (nm: number): Float64Array | null => {
    const basisOf = (p: readonly number[]): number[] => {
      const dx = p[0]! - bar[0]!;
      const dy = p[1]! - bar[1]!;
      const dz = p[2]! - bar[2]!;
      return [1, dz, dy, dx, dx * dx, dy * dy, dz * dz].slice(0, nm);
    };
    const sOf = Float64Array.from(nodes, (n, i) => m0[i]! / n.mass);
    const pinned = new Uint8Array(nodes.length);
    for (let iter = 0; iter < 60 && !addMass; iter++) {
      const A = Array.from({ length: nm }, () => new Array<number>(nm).fill(0));
      // targets: everything that is not a free donor at its final mass, free donors at m0
      const tot = restMom.slice(0, nm);
      let free = 0;
      nodes.forEach((n, i) => {
        if (!eligible[i]) return;
        const m = pinned[i] ? sOf[i]! * n.mass : m0[i]!;
        const f = momOf(n.pos);
        for (let r = 0; r < nm; r++) tot[r] = tot[r]! + m * f[r]!;
        if (pinned[i]) return;
        free++;
        const g = basisOf(n.pos);
        for (let r = 0; r < nm; r++) for (let k = 0; k < nm; k++) A[r]![k] = A[r]![k]! + m0[i]! * wOf[i]! * f[r]! * g[k]!;
      });
      if (free < 2 * nm) return null;
      const coef = solveN(A, target.slice(0, nm).map((t, r) => t - tot[r]!));
      if (!coef.every(Number.isFinite)) return null;
      let changed = false;
      nodes.forEach((n, i) => {
        if (!eligible[i] || pinned[i]) return;
        const g = basisOf(n.pos);
        let field = 0;
        for (let k = 0; k < nm; k++) field += coef[k]! * g[k]!;
        const sv = (m0[i]! / n.mass) * (1 + wOf[i]! * field);
        sOf[i] = sv;
        if (sv < floorOf[i]! || sv > MASS_CEIL) {
          sOf[i] = sv < floorOf[i]! ? floorOf[i]! : MASS_CEIL;
          pinned[i] = 1;
          changed = true;
        }
      });
      if (!changed) return sOf;
    }
    return addMass ? sOf : null;
  };
  const sOf = (opts.matchInertia ? solveField(NM) : null) ?? solveField(4);
  if (!sOf) throw new Error(`refine ${opts.name}: too much new mass for the donors (bounded mass solve failed)`);
  nodes.forEach((n, i) => {
    if (!(sOf[i]! > 0.3)) throw new Error(`refine ${opts.name}: member chain node ${n.id} would keep only ${(sOf[i]! * 100).toFixed(0)} % of its mass`);
  });

  // ---- generated nodes + part beam stiffness (generated-side budgets)
  const perKg = (GEN_OMEGA_DT / RIG_DT) ** 2;
  const genNodes: RigNodeDef[] = [];
  const genMass = new Map<string, number>();
  const genPos = new Map<string, readonly number[]>();
  for (const p of parts)
    p.ids.forEach((id, i) => {
      const m = round4(p.mass[i]!);
      const q = p.pos[i]!.map(round4) as [number, number, number];
      genMass.set(id, m);
      genPos.set(id, q);
      genNodes.push({ id, pos: q, mass: m, group: 'body', radius: skinRadius(q[1]!) });
    });
  const W = new Map<string, number>();
  for (const p of parts) for (const b of p.beams) for (const id of [b.a, b.b]) if (genMass.has(id)) W.set(id, (W.get(id) ?? 0) + b.w);
  // frame side of seams / standoffs / ties: at most SEAM_FRAME_SHARE of the frame node's stability budget
  const Wf = new Map<string, number>();
  for (const p of parts) for (const b of p.beams) if (b.kind !== 'membrane') for (const id of [b.a, b.b]) if (!genMass.has(id)) Wf.set(id, (Wf.get(id) ?? 0) + b.w);
  const frameBudget = (id: string): number => {
    const i = index.get(id)!;
    return sOf[i]! * nodes[i]!.mass * (vehicleOmegaDtLimit(nodes[i]!.group) * LIMIT_MARGIN / RIG_DT) ** 2;
  };
  // a frame node outside the shell clusters (no scalable beams) only lends its spare headroom to seams
  const frameShare = (id: string): number =>
    shellGroup(id) ? SEAM_FRAME_SHARE * frameBudget(id) : Math.min(SEAM_FRAME_SHARE * frameBudget(id), Math.max(0, frameBudget(id) - (Kbase.get(id) ?? 0)));
  const shareOf = (id: string): number => (genMass.has(id) ? (perKg * genMass.get(id)!) / W.get(id)! : frameShare(id) / Wf.get(id)!);
  const frameK = new Map<string, number>();
  const genBeams: RigBeamDef[] = [];
  const skinNodes: Record<string, string[]> = {};
  const memberNodes: Record<string, string[]> = {};
  const seams: Record<string, [string, string][]> = {};
  const mOf = (id: string): number => genMass.get(id) ?? nodes[index.get(id)!]!.mass * sOf[index.get(id)!]!;
  let seamCount = 0;
  for (const p of parts) {
    if (p.kind === 'skin') {
      skinNodes[p.name] = p.ids;
      seams[p.name] = [];
    } else memberNodes[p.name] = p.ids;
    for (const b of p.beams) {
      const k = sig3(0.995 * b.w * Math.min(shareOf(b.a), shareOf(b.b)));
      const ma = mOf(b.a);
      const mb = mOf(b.b);
      const d = sig3(2 * SKIN_ZETA * Math.sqrt((k * ma * mb) / (ma + mb)));
      const pa = genPos.get(b.a) ?? posOf(b.a);
      const pb = genPos.get(b.b) ?? posOf(b.b);
      const L = Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!);
      if (b.kind === 'membrane') {
        const yieldStrain = p.yieldStrain * b.soft;
        const deform = sig3(Math.max(yieldStrain * k * L, 1));
        genBeams.push({ a: b.a, b: b.b, type: 'normal', k, d, deform, breakF: sig3((p.kind === 'skin' ? SKIN_TEAR_RATIO : MEMBER_TEAR_RATIO) * deform) });
        continue;
      }
      const frame = genMass.has(b.a) ? b.b : b.a;
      frameK.set(frame, (frameK.get(frame) ?? 0) + k);
      if (b.kind === 'tie') {
        genBeams.push({ a: b.a, b: b.b, type: 'normal', k, d, deform: 0, breakF: sig3(TIE_TEAR_STRAIN * k * L) });
      } else {
        const deform = sig3(Math.max(SEAM_YIELD_STRAIN * k * L, 1));
        genBeams.push({ a: b.a, b: b.b, type: 'normal', k, d, deform, breakF: sig3((b.kind === 'seam' ? 1 : 2) * SEAM_TEAR_RATIO[p.seam] * deform) });
      }
      seamCount++;
      if (b.kind === 'seam') seams[p.name]!.push(genMass.has(b.a) ? [b.a, b.b] : [b.b, b.a]);
    }
  }

  // ---- backbone re-mass + re-stiffen
  const K = new Float64Array(nodes.length);
  const Kfixed = new Float64Array(nodes.length);
  const Kscal = new Float64Array(nodes.length);
  for (const b of beams) {
    const k = b.k ?? 9e6;
    const sc = scalable(b);
    for (const id of [b.a, b.b]) {
      const i = index.get(id);
      if (i === undefined) continue;
      K[i] = K[i]! + k;
      if (sc) Kscal[i] = Kscal[i]! + k;
      else Kfixed[i] = Kfixed[i]! + k;
    }
  }
  for (const w of base.wheels)
    for (const id of w.attach) {
      const i = index.get(id)!;
      const k = 2 * (w.attachSpring ?? 0);
      K[i] = K[i]! + k;
      Kfixed[i] = Kfixed[i]! + k;
    }
  // f from the node's stability LIMIT (vehicle MINIMASS by group), not its current Σk: the standard rigs allocate
  // to ω·dt 0.485 (shell) / 0.33 (rest) under limits of 0.495 / 0.35, so a few % of mass (or seam load) come out of
  // that headroom without touching a single tuned beam.
  const fOf = new Float64Array(nodes.length).fill(1);
  nodes.forEach((n, i) => {
    const w = frameK.get(n.id) ?? 0;
    const s = sOf[i]!;
    if ((s === 1 && w === 0) || Kscal[i]! <= 0) return;
    const lim = vehicleOmegaDtLimit(n.group) * LIMIT_MARGIN;
    const budget = s * n.mass * (lim / RIG_DT) ** 2;
    const f = (Math.min(budget, Math.max(K[i]!, s * K[i]!)) - Kfixed[i]! - w) / Kscal[i]!;
    fOf[i] = Math.min(1, f);
    if (!(fOf[i]! > 0.2)) throw new Error(`refine ${opts.name}: node ${n.id} has no stiffness budget left for its seams (f ${f.toFixed(3)})`);
  });
  for (const b of beams) {
    if (!scalable(b)) continue;
    const f = Math.min(fOf[index.get(b.a)!]!, fOf[index.get(b.b)!]!);
    if (f >= 1) continue;
    b.k = sig3((b.k ?? 9e6) * f);
    if (b.d !== undefined) b.d = sig3(b.d * f);
  }
  nodes.forEach((n, i) => {
    if (sOf[i] !== 1) n.mass = round4(n.mass * sOf[i]!);
  });
  // a backbone node that lost mass keeps (Σd/m)·dt ≤ the backbone's 0.95: its scalable beams' damping scales down
  {
    const sumD = new Float64Array(nodes.length);
    for (const b of beams) for (const id of [b.a, b.b]) sumD[index.get(id)!] = sumD[index.get(id)!]! + (b.d ?? 0);
    for (const w of base.wheels) for (const id of w.attach) sumD[index.get(id)!] = sumD[index.get(id)!]! + 2 * (w.attachDamp ?? 0);
    // damping of every shell-to-shell link may scale (elastic links keep their k, not necessarily their d)
    const scalD = new Float64Array(nodes.length);
    for (const b of beams) if (shellLink(b)) for (const id of [b.a, b.b]) scalD[index.get(id)!] = scalD[index.get(id)!]! + (b.d ?? 0);
    const g = new Float64Array(nodes.length).fill(1);
    nodes.forEach((n, i) => {
      const lim = (0.95 * n.mass) / RIG_DT;
      if (sumD[i]! <= lim || scalD[i]! <= 0) return;
      g[i] = Math.max(0, (lim - (sumD[i]! - scalD[i]!)) / scalD[i]!);
    });
    for (const b of beams) {
      if (!shellLink(b) || b.d === undefined) continue;
      const f = Math.min(g[index.get(b.a)!]!, g[index.get(b.b)!]!);
      if (f < 1) b.d = sig3(b.d * f);
    }
  }

  // ---- damping budget: (Σd/m)·dt ≤ GEN_DAMP_DT on generated nodes; a frame node pushed over the backbone's
  // 0.95 by its seams has those seams' d scaled down (never the backbone's own beams)
  {
    const sumD = new Map<string, number>();
    for (const b of [...beams, ...genBeams]) for (const id of [b.a, b.b]) sumD.set(id, (sumD.get(id) ?? 0) + (b.d ?? 0));
    for (const w of base.wheels) for (const id of w.attach) sumD.set(id, (sumD.get(id) ?? 0) + 2 * (w.attachDamp ?? 0));
    const genD = new Map<string, number>();
    for (const b of genBeams) for (const id of [b.a, b.b]) genD.set(id, (genD.get(id) ?? 0) + (b.d ?? 0));
    const scale = (id: string): number => {
      const gm = genMass.get(id);
      const m = gm ?? nodes[index.get(id)!]!.mass;
      const limit = gm !== undefined ? GEN_DAMP_DT : 0.95;
      const total = sumD.get(id)!;
      if ((total * RIG_DT) / m <= limit) return 1;
      const own = genD.get(id)!;
      return Math.max(0, (limit * m) / RIG_DT - (total - own)) / own;
    };
    for (const b of genBeams) {
      const f = Math.min(scale(b.a), scale(b.b));
      if (f < 1) b.d = sig3(b.d! * f);
    }
  }

  const shell = assignShell(base.shell, parts, opts.wholeZoneSheetRelease);
  const def: VehicleDef = {
    ...base,
    name: opts.name,
    // R-CORE collision triangles (CONTRACTS "R-CORE"): the sheets' own outward triangles; declared, so they
    // replace the derived lattice surface (the sheets ARE the outer surface)
    body: { ...base.body, name: `${opts.name}.body`, nodes: [...nodes, ...genNodes], beams: [...beams, ...genBeams], triangles: collisionOf(parts) },
    ...(shell !== undefined ? { shell } : {}),
  };
  const collision: CollisionTriangle[] = def.body.triangles!.map(({ a, b, c }) => ({ a, b, c }));
  const report = reportOf(def, baseCv.totalMass, cg as [number, number, number], parts, genBeams.length, seamCount, collision.length);
  return { def, report, collision, skinNodes, memberNodes, seams };
}

/**
 * The generated parts get their OWN rigid shell clusters (one per backbone cluster their frame nodes vote for),
 * declared before the backbone's so they claim the `k_` / `m_` nodes: the backbone cluster keeps exactly its
 * standard node set, zones and post-impact recapture timing (a light sheet releasing node by node after an
 * impact would otherwise keep resetting the backbone cluster's quiet timer, or re-trip a whole-release crumple
 * zone). Each part's zone copies its frame nodes' zone thresholds (yield / release), never `whole`.
 */
/** Outer-skin collision triangles (RigTriangleDef: CCW seen from outside, one-sided). */
function collisionOf(parts: readonly Part[]): RigTriangleDef[] {
  return parts.filter((p) => p.kind === 'skin').flatMap((p) => p.tris.map(([a, b, c]) => ({ a, b, c })));
}

function assignShell(shell: VehicleDef['shell'], parts: readonly Part[], wholeRelease?: Partial<ShellRelease>): VehicleDef['shell'] {
  if (shell === false || shell === undefined) return shell;
  const base: ShellDef[] = Array.isArray(shell) ? [...(shell as readonly ShellDef[])] : [shell as ShellDef];
  const match = (id: string, pats: readonly string[] | undefined): boolean => pats === undefined || pats.some((p) => globMatch(id, p));
  /** per base cluster: zone key → part globs */
  const per = base.map(() => new Map<number, string[]>());
  for (const s of parts) {
    const own = new Set(s.ids);
    const frame = new Set<string>();
    for (const b of s.beams) if (b.kind !== 'membrane') frame.add(own.has(b.a) ? b.b : b.a);
    const votes = new Map<string, number>();
    for (const id of frame) {
      const c = base.findIndex((d) => match(id, d.ids));
      if (c < 0) continue;
      const z = (base[c]!.zones ?? []).findIndex((zn: ShellZone) => zn.ids.some((p) => globMatch(id, p)));
      const k = `${c}:${z}`;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    let best = '';
    let bestN = -1;
    for (const [k, n] of [...votes.entries()].sort()) if (n > bestN) [best, bestN] = [k, n];
    if (best === '') continue;
    const [c, z] = best.split(':').map(Number) as [number, number];
    const m = per[c]!;
    if (!m.has(z)) m.set(z, []);
    m.get(z)!.push(`${s.prefix}_*`);
  }
  const gen: ShellDef[] = [];
  base.forEach((cl, c) => {
    const m = per[c]!;
    if (m.size === 0) return;
    const zones: ShellZone[] = [];
    for (const [z, ids] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
      const src: ShellZone | null = z >= 0 ? cl.zones![z]! : null;
      const release = src?.whole && wholeRelease ? { ...src.release, ...wholeRelease } : src ? src.release : cl.release;
      zones.push({ ids, ...(release ? { release } : {}), ...(src?.yield ? { yield: true } : {}) });
    }
    gen.push({
      ...(cl.groups ? { groups: cl.groups } : {}),
      ids: [...m.values()].flat(),
      ...(cl.freqHz !== undefined ? { freqHz: cl.freqHz } : {}),
      ...(cl.zeta !== undefined ? { zeta: cl.zeta } : {}),
      ...(cl.recaptureS !== undefined ? { recaptureS: cl.recaptureS } : {}),
      zones,
    });
  });
  return gen.length === 0 ? shell : [...gen, ...base];
}

function reportOf(def: VehicleDef, baseMass: number, baseCg: [number, number, number], parts: readonly Part[], genBeams: number, seamBeams: number, collisionTris: number): RigGenReport {
  const cv = compileVehicle(def);
  const rig = cv.rig;
  const cg: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < rig.nodeCount; i++) for (let k = 0; k < 3; k++) cg[k] = cg[k]! + (rig.nodeMass[i]! * rig.nodePos[3 * i + k]!) / cv.totalMass;
  const st = computeStabilityReport(rig, { limit: 0.5 });
  let worst = 0;
  let worstNode = '';
  let worstD = 0;
  for (let i = 0; i < rig.nodeCount; i++) {
    if (st.omegaDt[i]! > worst) {
      worst = st.omegaDt[i]!;
      worstNode = rig.nodeIds[i]!;
    }
    worstD = Math.max(worstD, st.dampDt[i]!);
  }
  const skinIds = new Set(parts.filter((p) => p.kind === 'skin').flatMap((p) => p.ids));
  const memberIds = new Set(parts.filter((p) => p.kind === 'member').flatMap((p) => p.ids));
  const memberBeams = parts.filter((p) => p.kind === 'member').reduce((a, p) => a + p.beams.filter((b) => b.kind === 'membrane').length, 0);
  const massBy: Record<string, number> = { skins: 0, members: 0, backboneShell: 0, other: 0 };
  const bodyN = def.body.nodes.length;
  for (let i = 0; i < rig.nodeCount; i++) {
    const id = rig.nodeIds[i]!;
    const m = rig.nodeMass[i]!;
    if (skinIds.has(id)) massBy.skins! += m;
    else if (memberIds.has(id)) massBy.members! += m;
    else if (i < bodyN && SHELL_BODY_GROUPS.includes(rig.groups[rig.nodeGroup[i]!] ?? '')) massBy.backboneShell! += m;
    else massBy.other! += m;
  }
  return {
    name: def.name,
    nodes: rig.nodeCount,
    beams: rig.beamCount,
    bodyNodes: cv.bodyNodeCount,
    bodyBeams: cv.bodyBeamCount,
    skinNodes: skinIds.size,
    skinBeams: genBeams - seamBeams - memberBeams,
    memberNodes: memberIds.size,
    memberBeams,
    weldBeams: seamBeams,
    mass: cv.totalMass,
    baseMass,
    cg,
    baseCg,
    massBy,
    worstOmegaDt: worst,
    worstNode,
    worstDampDt: worstD,
    massDriftPct: cv.massDriftPct,
    collisionTris,
  };
}

/** Gaussian elimination with partial pivoting (n×n). */
export function solveN(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}
