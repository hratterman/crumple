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
 * order: base body nodes/beams keep their indices).
 * MASS: the new parts carry their real mass (gauge × density × area); the
 * backbone shell nodes give it up with a linear field s_i = s0 + a·(z − z̄)
 * + c·(y − ȳ) solved so the TOTAL mass and the CG (y, z) equal the
 * standard rig's exactly (x stays 0 by symmetry).
 * STABILITY: a node whose mass drops by s (or which gains seam beams) has
 * every scalable beam (normal / support / bounded between shell-group
 * nodes) scaled by f = (s·K − K_fixed − K_seam)/K_scalable (K = its Σk), and
 * its damping by the same factor, so Σk/m — hence ω·dt — never exceeds the
 * backbone's; deform / break FORCES are kept (the crash load paths keep their
 * yield and tear loads).
 */
import { compileVehicle } from '../../vehicle/builder';
import { globMatch, type ShellDef, type ShellZone } from '../../vehicle/shellDefs';
import type { VehicleDef } from '../../vehicle/types';
import { computeStabilityReport, RIG_DT } from '../builder';
import type { RigBeamDef, RigNodeDef } from '../types';
import { buildSkin, SEAM_TEAR_STRAIN, SKIN_TEAR_RATIO, SKIN_YIELD_STRAIN, SKIN_ZETA, type BuiltSkin } from './skin';
import type { CollisionTriangle, RigGenReport, SkinPanelData, SkinSet, SkinSpec } from './types';

/** Node groups of the body shell the generator may re-mass / re-stiffen. */
export const SHELL_BODY_GROUPS: readonly string[] = ['body', 'hood', 'tailgate'];
/** ω·dt target of generated shell nodes (vehicle MINIMASS limit for group 'body' is 0.495). */
export const GEN_OMEGA_DT = 0.47;
/** (Σd/m)·dt target of generated nodes (validator limit 1). */
export const GEN_DAMP_DT = 0.9;
/** Skin node ground-contact radius, m (thin sheet). */
export const SKIN_RADIUS = 0.03;

export interface RefineOptions {
  /** Variant name, e.g. 'sedan.high'. */
  name: string;
  skins: SkinSet;
  /** Construction of each sampled panel (null = leave that panel on its frame nodes). */
  skinSpec: (panel: SkinPanelData) => SkinSpec | null;
}

export interface RefinedVehicle {
  def: VehicleDef;
  report: RigGenReport;
  collision: CollisionTriangle[];
  /** Sheet node ids per render panel id (the HD visual binds each panel to its own sheet). */
  skinNodes: Record<string, string[]>;
  /** Seam beams per render panel (node-id pairs: sheet node, frame node). */
  seams: Record<string, [string, string][]>;
}

const sig3 = (v: number): number => {
  if (v === 0 || !Number.isFinite(v)) return v;
  const p = 10 ** (2 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
};
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export function refineVehicle(base: VehicleDef, opts: RefineOptions): RefinedVehicle {
  const baseCv = compileVehicle(base);
  const nodes: RigNodeDef[] = base.body.nodes.map((n) => ({ ...n, pos: [...n.pos] as [number, number, number] }));
  const beams: RigBeamDef[] = base.body.beams.map((b) => ({ ...b }));
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const posOf = (id: string): readonly number[] => nodes[index.get(id)!]!.pos;
  const shellGroup = (id: string): boolean => {
    const i = index.get(id);
    return i !== undefined && SHELL_BODY_GROUPS.includes(nodes[i]!.group ?? '');
  };

  // ---- skins
  const built: BuiltSkin[] = [];
  for (const panel of opts.skins.panels) {
    const spec = opts.skinSpec(panel);
    if (!spec) continue;
    const attachIds = spec.attach ? nodes.filter((n) => spec.attach!.some((p) => globMatch(n.id, p))).map((n) => n.id) : panel.attach.filter((id) => index.has(id));
    if (attachIds.length === 0) throw new Error(`refine ${opts.name}: panel ${panel.id} has no attach nodes on the backbone`);
    const attachPos = new Map<string, readonly number[]>(attachIds.map((id) => [id, posOf(id)]));
    built.push(buildSkin(panel, spec, attachPos));
  }

  // ---- mass solve (total + CG y, z)
  const M = baseCv.totalMass;
  const cg = [0, 0, 0];
  for (let i = 0; i < baseCv.rig.nodeCount; i++) for (let k = 0; k < 3; k++) cg[k]! += (baseCv.rig.nodeMass[i]! * baseCv.rig.nodePos[3 * i + k]!) / M;
  // eligible: shell-group nodes whose every beam is a scalable body-body beam
  const scalable = (b: RigBeamDef): boolean => (b.type === 'normal' || b.type === 'support' || b.type === 'bounded') && shellGroup(b.a) && shellGroup(b.b);
  const eligible = new Uint8Array(nodes.length);
  nodes.forEach((n, i) => {
    if (SHELL_BODY_GROUPS.includes(n.group ?? '') && n.mass > 0) eligible[i] = 1;
  });
  for (const b of beams) {
    if (scalable(b)) continue;
    for (const id of [b.a, b.b]) {
      const i = index.get(id);
      if (i !== undefined) eligible[i] = 0;
    }
  }
  for (const w of base.wheels) for (const id of w.attach) eligible[index.get(id)!] = 0;
  let newMass = 0;
  const newMoment = [0, 0, 0];
  for (const s of built)
    s.ids.forEach((_, i) => {
      newMass += s.mass[i]!;
      for (let k = 0; k < 3; k++) newMoment[k]! += s.mass[i]! * s.pos[i]![k]!;
    });
  let mE = 0;
  let zBar = 0;
  let yBar = 0;
  let xBar = 0;
  nodes.forEach((n, i) => {
    if (!eligible[i]) return;
    mE += n.mass;
    zBar += n.mass * n.pos[2];
    yBar += n.mass * n.pos[1];
    xBar += n.mass * n.pos[0];
  });
  zBar /= mE;
  yBar /= mE;
  xBar /= mE;
  // rest moments of everything that keeps its mass (non-eligible body nodes + wheels)
  const restMoment = [0, 0, 0];
  let restMass = 0;
  for (let i = 0; i < baseCv.rig.nodeCount; i++) {
    if (i < nodes.length && eligible[i]) continue;
    const m = baseCv.rig.nodeMass[i]!;
    restMass += m;
    for (let k = 0; k < 3; k++) restMoment[k]! += m * baseCv.rig.nodePos[3 * i + k]!;
  }
  const A = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  nodes.forEach((n, i) => {
    if (!eligible[i]) return;
    const basis = [1, n.pos[2] - zBar, n.pos[1] - yBar, n.pos[0] - xBar];
    const wts = [1, n.pos[2], n.pos[1], n.pos[0]];
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) A[r]![k]! += n.mass * wts[r]! * basis[k]!;
  });
  const rhs = [
    M - restMass - newMass,
    M * cg[2]! - restMoment[2]! - newMoment[2]!,
    M * cg[1]! - restMoment[1]! - newMoment[1]!,
    M * cg[0]! - restMoment[0]! - newMoment[0]!,
  ];
  const coef = solveN(A, rhs);
  const sOf = new Float64Array(nodes.length).fill(1);
  nodes.forEach((n, i) => {
    if (!eligible[i]) return;
    const s = coef[0]! + coef[1]! * (n.pos[2] - zBar) + coef[2]! * (n.pos[1] - yBar) + coef[3]! * (n.pos[0] - xBar);
    if (!(s > 0.3 && s < 1.6)) throw new Error(`refine ${opts.name}: mass field ${s.toFixed(3)} at ${n.id} (too much new mass for the backbone)`);
    sOf[i] = s;
  });

  // ---- generated node masses + skin beam stiffness (sheet-side budgets)
  const perKg = (GEN_OMEGA_DT / RIG_DT) ** 2;
  const genNodes: RigNodeDef[] = [];
  const genMass = new Map<string, number>();
  const genPos = new Map<string, readonly number[]>();
  for (const s of built) {
    s.ids.forEach((id, i) => {
      const m = round4(s.mass[i]!);
      const p = s.pos[i]!.map(round4) as [number, number, number];
      genMass.set(id, m);
      genPos.set(id, p);
      genNodes.push({ id, pos: p, mass: m, group: 'body', radius: SKIN_RADIUS });
    });
  }
  const W = new Map<string, number>();
  for (const s of built)
    for (const b of s.beams) {
      for (const id of [b.a, b.b]) if (genMass.has(id)) W.set(id, (W.get(id) ?? 0) + b.w);
    }
  const shareOf = (id: string): number => (genMass.has(id) ? (perKg * genMass.get(id)!) / W.get(id)! : Infinity);
  const seamK = new Map<string, number>();
  const genBeams: RigBeamDef[] = [];
  const skinNodes: Record<string, string[]> = {};
  const seams: Record<string, [string, string][]> = {};
  const mOf = (id: string): number => genMass.get(id) ?? nodes[index.get(id)!]!.mass * sOf[index.get(id)!]!;
  for (const s of built) {
    skinNodes[s.panel] = s.ids;
    seams[s.panel] = [];
    for (const b of s.beams) {
      const k = sig3(0.995 * b.w * Math.min(shareOf(b.a), shareOf(b.b)));
      const ma = mOf(b.a);
      const mb = mOf(b.b);
      const d = sig3(2 * SKIN_ZETA * Math.sqrt((k * ma * mb) / (ma + mb)));
      const pa = genPos.get(b.a) ?? posOf(b.a);
      const pb = genPos.get(b.b) ?? posOf(b.b);
      const L = Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!);
      if (b.kind === 'seam' || b.kind === 'standoff') {
        const frame = genMass.has(b.a) ? b.b : b.a;
        seamK.set(frame, (seamK.get(frame) ?? 0) + k);
        const tear = b.kind === 'seam' ? SEAM_TEAR_STRAIN[s.seam] : 2 * SEAM_TEAR_STRAIN[s.seam];
        genBeams.push({ a: b.a, b: b.b, type: 'normal', k, d, deform: 0, breakF: sig3(tear * k * L) });
        if (b.kind === 'seam') seams[s.panel]!.push(genMass.has(b.a) ? [b.a, b.b] : [b.b, b.a]);
      } else {
        const deform = sig3(Math.max(SKIN_YIELD_STRAIN * k * L, 1));
        genBeams.push({ a: b.a, b: b.b, type: 'normal', k, d, deform, breakF: sig3(SKIN_TEAR_RATIO * deform) });
      }
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
      K[i]! += k;
      if (sc) Kscal[i]! += k;
      else Kfixed[i]! += k;
    }
  }
  // generated wheel attach beams load the attach nodes too (fixed)
  for (const w of base.wheels)
    for (const id of w.attach) {
      const i = index.get(id)!;
      const k = 2 * (w.attachSpring ?? 0);
      K[i]! += k;
      Kfixed[i]! += k;
    }
  const fOf = new Float64Array(nodes.length).fill(1);
  nodes.forEach((n, i) => {
    const w = seamK.get(n.id) ?? 0;
    const s = sOf[i]!;
    if (s === 1 && w === 0) return;
    if (Kscal[i]! <= 0) {
      if (w > 0) fOf[i] = 1; // budget check below reports it
      return;
    }
    const f = (s * K[i]! - Kfixed[i]! - w) / Kscal[i]!;
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

  // ---- damping budget: (Σd/m)·dt ≤ GEN_DAMP_DT on sheet nodes; a frame node pushed over the backbone's 0.95 by
  // its seams has those seams' d scaled down (never the backbone's own beams)
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
      const z = (total * RIG_DT) / m;
      if (z <= limit) return 1;
      const own = genD.get(id)!;
      const keep = total - own;
      return Math.max(0, (limit * m) / RIG_DT - keep) / own;
    };
    for (const b of genBeams) {
      const f = Math.min(scale(b.a), scale(b.b));
      if (f < 1) b.d = sig3(b.d! * f);
    }
  }

  // ---- shell: each sheet joins the zone (and cluster) of the majority of its attach nodes
  const shell = assignShell(base.shell, built);

  const def: VehicleDef = {
    ...base,
    name: opts.name,
    body: { ...base.body, name: `${opts.name}.body`, nodes: [...nodes, ...genNodes], beams: [...beams, ...genBeams] },
    ...(shell !== undefined ? { shell } : {}),
  };
  const collision: CollisionTriangle[] = built.flatMap((s) => s.tris.map(([a, b, c]) => ({ a, b, c })));
  const report = reportOf(def, baseCv.totalMass, cg as [number, number, number], built, genBeams, collision.length);
  return { def, report, collision, skinNodes, seams };
}

/** Adds each sheet's id glob to the cluster + zone most of its attach nodes belong to. */
function assignShell(shell: VehicleDef['shell'], built: readonly BuiltSkin[]): VehicleDef['shell'] {
  if (shell === false || shell === undefined) return shell;
  const list: ShellDef[] = (Array.isArray(shell) ? (shell as readonly ShellDef[]) : [shell as ShellDef]).map((s) => ({
    ...s,
    ...(s.ids ? { ids: [...s.ids] } : {}),
    ...(s.zones ? { zones: s.zones.map((z) => ({ ...z, ids: [...z.ids] })) } : {}),
  }));
  const match = (id: string, pats: readonly string[] | undefined): boolean => pats === undefined || pats.some((p) => globMatch(id, p));
  for (const s of built) {
    const attach = new Set<string>();
    for (const b of s.beams) if (b.kind === 'seam') attach.add(b.a.startsWith(`${s.prefix}_`) ? b.b : b.a);
    // cluster: first whose ids filter takes the attach node (no filter = takes all)
    const votes = new Map<string, number>();
    for (const id of attach) {
      const c = list.findIndex((d) => match(id, d.ids));
      if (c < 0) continue;
      const zones = list[c]!.zones ?? [];
      const z = zones.findIndex((zn: ShellZone) => zn.ids.some((p) => globMatch(id, p)));
      const k = `${c}:${z}`;
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    let best = '';
    let bestN = -1;
    for (const [k, n] of [...votes.entries()].sort()) if (n > bestN) [best, bestN] = [k, n];
    if (best === '') continue;
    const [c, z] = best.split(':').map(Number) as [number, number];
    const glob = `${s.prefix}_*`;
    const cl = list[c]!;
    if (cl.ids) (cl.ids as string[]).push(glob);
    if (z >= 0) (cl.zones![z]!.ids as string[]).push(glob);
  }
  return Array.isArray(shell) ? list : list[0]!;
}

function reportOf(
  def: VehicleDef,
  baseMass: number,
  baseCg: [number, number, number],
  built: readonly BuiltSkin[],
  genBeams: readonly RigBeamDef[],
  collisionTris: number,
): RigGenReport {
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
  const skinNodes = built.reduce((a, s) => a + s.ids.length, 0);
  const seamBeams = genBeams.filter((b) => b.deform === 0).length;
  const massBy: Record<string, number> = { skins: 0, backboneShell: 0, other: 0 };
  const skinIds = new Set(built.flatMap((s) => s.ids));
  const bodyN = def.body.nodes.length;
  for (let i = 0; i < rig.nodeCount; i++) {
    const id = rig.nodeIds[i]!;
    const m = rig.nodeMass[i]!;
    if (skinIds.has(id)) massBy.skins! += m;
    else if (i < bodyN && SHELL_BODY_GROUPS.includes(rig.groups[rig.nodeGroup[i]!] ?? '')) massBy.backboneShell! += m;
    else massBy.other! += m;
  }
  return {
    name: def.name,
    nodes: rig.nodeCount,
    beams: rig.beamCount,
    bodyNodes: cv.bodyNodeCount,
    bodyBeams: cv.bodyBeamCount,
    skinNodes,
    skinBeams: genBeams.length - seamBeams,
    memberNodes: 0,
    memberBeams: 0,
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
