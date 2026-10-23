/**
 * Cross-object JOINTS (R-PHYS2) — WORKER ONLY. Couplings between nodes of
 * two different objects (a beam can only join nodes of one rig):
 *
 *  - BALL  (trailer ball hitch, bolted splices): a zero-length 3-D spring-
 *          damper between node A and node B with a dead band `play` (the
 *          coupler's free play: it clunks) — free rotation, translation held.
 *  - ROPE  (safety chains, cargo straps, cable anchors): tension only, slack
 *          up to `rest` (m), then a spring-damper along the line; `rest`
 *          below the current distance = pretension (a ratcheted strap).
 *  - LINK  (pin-and-loop barrier connections, bolted splices, a guardrail's
 *          rail rows): a distance spring-damper (both ways) at `rest` with a
 *          ± `play` dead band; optional plastic flow above `yieldF`.
 * Both ends may be on ONE object (an implicit member inside a prop: a steel
 * rail's axial stiffness is far beyond a 2 kHz explicit beam's budget).
 *
 * LAW: implicit (backward Euler) on the joint's own spring-damper, with the
 * predicted velocities v* = v + F·dt/m that already include every force of
 * the tick so far (beams, node contacts), so any stiffness is stable and the
 * joint never adds to a node's explicit ω·dt budget:
 *   u* = relative velocity (B − A) along the constrained direction(s),
 *   u' = (u* − dt·(k/m_r)·e) / (1 + dt·c/m_r + dt²·k/m_r),   J = m_r·(u' − u*),
 *   F_B = J/dt, F_A = −J/dt   (equal and opposite: momentum exact),
 * m_r = m_A·m_B/(m_A + m_B); a pinned node or a SLEEPING object is infinite
 * mass (m_r = the free side's mass, only the free side is pushed) and a joint
 * force above JOINT_WAKE_FORCE requests that object's wake (applied by the
 * engine at the next tick boundary: deterministic).
 * BREAK: |F| > breakF (sticky); an impact event (metal) marks it for FX/audio.
 *
 * PHASE: after the node-vs-node pass, before phase 3 (water → ground →
 * colliders → shell → integrate): the implicit ground friction and the rigid
 * shell clusters see the joint force. Joints run in creation order.
 *
 * NUMERICS: + − × ÷ sqrt only, zero allocation in apply().
 */
import { MaterialId } from '../../protocol/messages';
import { SIM_OBJECT_FLAG_SLEEPING, type EventSink, type SimObject, type SimState } from '../types';

export const JointKind = { ball: 0, rope: 1, link: 2 } as const;
export type JointKind = (typeof JointKind)[keyof typeof JointKind];

/** A joint force above this wakes a sleeping object on either side, N. */
export const JOINT_WAKE_FORCE = 150;

export interface JointSpec {
  kind: JointKind;
  /** Free-form tag (trailer id, strap id) for queries / removal. */
  tag: string;
  objA: SimObject;
  /** Object-local node index. */
  nodeA: number;
  objB: SimObject;
  nodeB: number;
  /** Stiffness N/m and damping N·s/m. */
  k: number;
  c: number;
  /** ROPE: slack length (m). BALL: unused (0). */
  rest: number;
  /** BALL: free play radius, m (0 = none). */
  play: number;
  /** Break force, N (Infinity = never). */
  breakF: number;
  /** The joint cannot break before this tick (a coupling made at spawn settles first). Default 0. */
  armTick?: number;
  /**
   * ROPE: ratchet pretension, N. Until `armTick` the rope's slack length is taken up so it holds this
   * tension (the load settles onto the deck after a strap is cinched: a fixed rest length went slack).
   */
  pretension?: number;
  /**
   * LINK: yield force, N. Beyond it the member flows plastically: the rest length ratchets by the excess
   * over k (a steel rail stretched past its yield stays longer). `repair` restores the original rest.
   * With `ruptureStrain` the yield force hardens linearly from `yieldF` to `breakF` at that plastic strain
   * (steel: yield → ultimate by ≈ 15–20 % elongation), and the member tears there.
   */
  yieldF?: number;
  ruptureStrain?: number;
  /**
   * AXIAL CHAIN member (a guardrail rail row: its chord links, the splices and the terminal anchors along
   * it): the joints forming an unbranched path are solved together, exactly, along the path (a tridiagonal
   * backward-Euler system, Thomas algorithm) — Gauss-Seidel over a 160-link row converges far too slowly
   * (the rail behaved 5× too stretchy). A LINK in a chain is axial only; a BALL in a chain has its axial part
   * solved in the chain and its transverse part by Gauss-Seidel.
   */
  chain?: boolean;
  /** LINK: compression only (a bearing face: pushes, never pulls). */
  strut?: boolean;
}

export interface Joint extends JointSpec {
  broken: boolean;
  /** The rest length at creation (yielding links ratchet `rest`; repair restores it). */
  rest0: number;
  /** |F| of the last tick, N (diagnostics, tests), and its vector on node B. */
  force: number;
  fx: number;
  fy: number;
  fz: number;
  /** Peak |F| since creation, N. */
  peak: number;
  /** This tick's accumulated impulse on node B (solver scratch), N·s: Gauss-Seidel part, chain part. */
  lx: number;
  ly: number;
  lz: number;
  cx: number;
  cy: number;
  cz: number;
  /** Chain members: the chain's axis at this joint (unit, A → B sense of the chain) this tick. */
  ax: number;
  ay: number;
  az: number;
}

/** One unbranched path of chain joints (see JointSpec.chain). Node p_i … p_{i+1} per element i. */
interface Chain {
  elems: Joint[];
  /** The distinct objects along the chain (all asleep → nothing to solve). */
  objs: SimObject[];
  /** 1 = the element's joint runs B → A along the chain. */
  flip: Uint8Array;
  nodeObj: SimObject[];
  nodeLocal: Int32Array;
  /** Scratch (per element / node). */
  lam: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  nz: Float64Array;
  lo: Float64Array;
  di: Float64Array;
  up: Float64Array;
  rhs: Float64Array;
  im: Float64Array;
  gi: Int32Array;
}

function makeChain(elems: Joint[], flip: number[], nodeObj: SimObject[], nodeLocal: number[]): Chain {
  const n = elems.length;
  return {
    elems,
    objs: [...new Set(nodeObj)],
    flip: Uint8Array.from(flip),
    nodeObj,
    nodeLocal: Int32Array.from(nodeLocal),
    lam: new Float64Array(n),
    nx: new Float64Array(n),
    ny: new Float64Array(n),
    nz: new Float64Array(n),
    lo: new Float64Array(n),
    di: new Float64Array(n),
    up: new Float64Array(n),
    rhs: new Float64Array(n),
    im: new Float64Array(n + 1),
    gi: new Int32Array(n + 1),
  };
}

export class JointSet {
  readonly joints: Joint[] = [];
  /** Objects whose wake a joint requested this tick (engine drains it at the next tick boundary). */
  readonly wakeRequests: SimObject[] = [];

  add(spec: JointSpec): Joint {
    if (spec.objA === spec.objB && spec.nodeA === spec.nodeB) throw new Error(`joint ${spec.tag}: both ends on one node`);
    for (const v of [spec.k, spec.c, spec.rest, spec.play]) if (!(Number.isFinite(v) && v >= 0)) throw new Error(`joint ${spec.tag}: invalid parameter ${v}`);
    if (!(spec.breakF > 0)) throw new Error(`joint ${spec.tag}: breakF must be > 0`);
    // One fixed shape for every joint (optional fields present, in one order): the hot loops stay monomorphic
    // (spread specs with different optional keys made them megamorphic: ~1 µs per joint and sweep).
    const j: Joint = {
      kind: spec.kind,
      tag: spec.tag,
      objA: spec.objA,
      nodeA: spec.nodeA,
      objB: spec.objB,
      nodeB: spec.nodeB,
      k: spec.k,
      c: spec.c,
      rest: spec.rest,
      play: spec.play,
      breakF: spec.breakF,
      armTick: spec.armTick ?? 0,
      pretension: spec.pretension,
      yieldF: spec.yieldF,
      ruptureStrain: spec.ruptureStrain,
      chain: spec.chain === true,
      strut: spec.strut === true,
      broken: false,
      rest0: spec.rest,
      force: 0,
      fx: 0,
      fy: 0,
      fz: 0,
      peak: 0,
      lx: 0,
      ly: 0,
      lz: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      ax: 1,
      ay: 0,
      az: 0,
    };
    this.joints.push(j);
    this.blocksDirty = true;
    if (j.chain) this.chainsDirty = true;
    return j;
  }

  /** Removes every joint with `tag` (or touching `obj`). Returns the count. */
  remove(pred: (j: Joint) => boolean): number {
    let w = 0;
    let n = 0;
    for (let r = 0; r < this.joints.length; r++) {
      const j = this.joints[r]!;
      if (pred(j)) n++;
      else this.joints[w++] = j;
    }
    this.joints.length = w;
    if (n > 0) {
      this.chainsDirty = true;
      this.blocksDirty = true;
    }
    return n;
  }

  removeObject(obj: SimObject): number {
    return this.remove((j) => j.objA === obj || j.objB === obj);
  }

  /** Repairs (un-breaks, un-yields) the joints matching `pred`. */
  repair(pred: (j: Joint) => boolean): void {
    for (const j of this.joints) {
      if (!pred(j)) continue;
      j.broken = false;
      if (j.yieldF !== undefined) j.rest = j.rest0;
    }
  }

  get size(): number {
    return this.joints.length;
  }

  /**
   * Gauss-Seidel sweeps per tick. 1 = each joint solved once with the velocities predicted from every force
   * so far (fine for couplings and straps). A dense network of stiff members (a guardrail's implicit rail)
   * needs a few: each sweep re-solves every joint against the others' latest impulses (accumulated impulses:
   * the joint's own previous impulse is taken out of the predicted velocity first), converging toward the
   * coupled backward-Euler solution — a single sweep left a slowly growing oscillation in spliced runs.
   */
  iterations = 1;
  private act = new Int32Array(64);
  /** Runs of consecutive joints between the same two objects: start indices (+ the end sentinel). */
  private blkStart = new Int32Array(2);
  private blkCount = 0;
  private blocksDirty = true;

  private rebuildBlocks(): void {
    this.blocksDirty = false;
    const js = this.joints;
    const st: number[] = [];
    for (let q = 0; q < js.length; q++) {
      const j = js[q]!;
      const p = q > 0 ? js[q - 1]! : null;
      if (!p || p.objA !== j.objA || p.objB !== j.objB) st.push(q);
    }
    st.push(js.length);
    this.blkStart = Int32Array.from(st);
    this.blkCount = st.length - 1;
  }
  private chains: Chain[] = [];
  private chainsDirty = false;

  /** Rebuilds the unbranched paths of chain joints (creation order decides the start; deterministic). */
  private rebuildChains(): void {
    this.chainsDirty = false;
    const key = (o: SimObject, l: number): string => `${o.objectId}:${l}`;
    const adj = new Map<string, { j: Joint; atA: boolean }[]>();
    const cj = this.joints.filter((j) => j.chain === true);
    for (const j of cj) {
      for (const atA of [true, false]) {
        const k = atA ? key(j.objA, j.nodeA) : key(j.objB, j.nodeB);
        let l = adj.get(k);
        if (!l) adj.set(k, (l = []));
        l.push({ j, atA });
      }
    }
    const used = new Set<Joint>();
    const chains: Chain[] = [];
    for (const start of cj) {
      if (used.has(start)) continue;
      // Walk to one end of start's path first.
      let j: Joint = start;
      let atA = true; // walk out of j through its A end
      for (let guard = 0; guard < cj.length; guard++) {
        const cur0: Joint = j;
        const k: string = atA ? key(cur0.objA, cur0.nodeA) : key(cur0.objB, cur0.nodeB);
        const nb: { j: Joint; atA: boolean }[] = adj.get(k)!.filter((e) => e.j !== cur0);
        if (nb.length !== 1 || nb[0]!.j === start) break;
        const e: { j: Joint; atA: boolean } = nb[0]!;
        j = e.j;
        atA = !e.atA; // continue out through its other end
      }
      // j is an end element; walk forward from the end we stopped at.
      const elems: Joint[] = [];
      const flip: number[] = [];
      const nodeObj: SimObject[] = [];
      const nodeLocal: number[] = [];
      let entryA = atA; // we enter the path at j's `entryA` end
      let cur: Joint | null = j;
      while (cur && !used.has(cur)) {
        used.add(cur);
        elems.push(cur);
        flip.push(entryA ? 0 : 1);
        if (entryA) {
          nodeObj.push(cur.objA);
          nodeLocal.push(cur.nodeA);
        } else {
          nodeObj.push(cur.objB);
          nodeLocal.push(cur.nodeB);
        }
        const exitK = entryA ? key(cur.objB, cur.nodeB) : key(cur.objA, cur.nodeA);
        const nb: { j: Joint; atA: boolean }[] = adj.get(exitK)!.filter((e) => e.j !== cur);
        const last: Joint = cur;
        cur = null;
        if (nb.length === 1 && !used.has(nb[0]!.j)) {
          cur = nb[0]!.j;
          entryA = nb[0]!.atA;
        }
        if (cur === null) {
          if (flip[flip.length - 1] === 0) {
            nodeObj.push(last.objB);
            nodeLocal.push(last.nodeB);
          } else {
            nodeObj.push(last.objA);
            nodeLocal.push(last.nodeA);
          }
        }
      }
      chains.push(makeChain(elems, flip, nodeObj, nodeLocal));
    }
    this.chains = chains;
  }

  /** Exact backward-Euler solve of one chain's axial impulses (accumulated: re-solvable each sweep). */
  private solveChain(c: Chain, state: SimState, dt: number): void {
    let awake = false;
    for (let q = 0; q < c.objs.length && !awake; q++) if ((c.objs[q]!.flags & SIM_OBJECT_FLAG_SLEEPING) === 0) awake = true;
    if (!awake) return;
    const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass } = state;
    const n = c.elems.length;
    const gi = c.gi;
    const im = c.im;
    for (let p = 0; p <= n; p++) {
      const o = c.nodeObj[p]!;
      const g = o.nodeStart + c.nodeLocal[p]!;
      gi[p] = g;
      im[p] = (o.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0 ? 0 : invMass[g]!;
    }
    // Axes (p_i → p_{i+1}); a zero-length element (a splice) borrows its neighbour's.
    for (let i = 0; i < n; i++) {
      const a = gi[i]!;
      const b = gi[i + 1]!;
      const ex = posX[b]! - posX[a]!;
      const ey = posY[b]! - posY[a]!;
      const ez = posZ[b]! - posZ[a]!;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d > 1e-4) {
        c.nx[i] = ex / d;
        c.ny[i] = ey / d;
        c.nz[i] = ez / d;
      } else {
        c.nx[i] = NaN;
      }
    }
    for (let i = 0; i < n; i++) {
      if (c.nx[i] === c.nx[i]) continue;
      let k = -1;
      for (let r = 1; r < n && k < 0; r++) {
        if (i - r >= 0 && c.nx[i - r] === c.nx[i - r]) k = i - r;
        else if (i + r < n && c.nx[i + r] === c.nx[i + r]) k = i + r;
      }
      if (k < 0) {
        c.nx[i] = 1;
        c.ny[i] = 0;
        c.nz[i] = 0;
      } else {
        c.nx[i] = c.nx[k]!;
        c.ny[i] = c.ny[k]!;
        c.nz[i] = c.nz[k]!;
      }
    }
    const lam = c.lam;
    // Rows: λ_{i−1}·(−g·im_i·(n_{i−1}·n_i)) + λ_i·(1 + g·(im_i + im_{i+1})) + λ_{i+1}·(−g·im_{i+1}·(n_{i+1}·n_i))
    //       = −dt·k·s − g·u*_i,   g = dt²·k + dt·c,  u* without this chain's own impulses.
    for (let i = 0; i < n; i++) {
      const j = c.elems[i]!;
      const a = gi[i]!;
      const b = gi[i + 1]!;
      const nx = c.nx[i]!;
      const ny = c.ny[i]!;
      const nz = c.nz[i]!;
      const ia = im[i]!;
      const ib = im[i + 1]!;
      if (j.broken || ia + ib === 0) {
        c.lo[i] = 0;
        c.di[i] = 1;
        c.up[i] = 0;
        c.rhs[i] = 0;
        continue;
      }
      // Own impulses out of the predicted velocities: node a got −λ_i n_i + λ_{i−1} n_{i−1}, node b got λ_i n_i − λ_{i+1} n_{i+1}.
      let vax = velX[a]! + frcX[a]! * ia * dt;
      let vay = velY[a]! + frcY[a]! * ia * dt;
      let vaz = velZ[a]! + frcZ[a]! * ia * dt;
      let vbx = velX[b]! + frcX[b]! * ib * dt;
      let vby = velY[b]! + frcY[b]! * ib * dt;
      let vbz = velZ[b]! + frcZ[b]! * ib * dt;
      const li = lam[i]!;
      vax += ia * li * nx;
      vay += ia * li * ny;
      vaz += ia * li * nz;
      vbx -= ib * li * nx;
      vby -= ib * li * ny;
      vbz -= ib * li * nz;
      if (i > 0) {
        const lp = lam[i - 1]!;
        vax -= ia * lp * c.nx[i - 1]!;
        vay -= ia * lp * c.ny[i - 1]!;
        vaz -= ia * lp * c.nz[i - 1]!;
      }
      if (i + 1 < n) {
        const ln = lam[i + 1]!;
        vbx += ib * ln * c.nx[i + 1]!;
        vby += ib * ln * c.ny[i + 1]!;
        vbz += ib * ln * c.nz[i + 1]!;
      }
      const u = (vbx - vax) * nx + (vby - vay) * ny + (vbz - vaz) * nz;
      const ex = posX[b]! - posX[a]!;
      const ey = posY[b]! - posY[a]!;
      const ez = posZ[b]! - posZ[a]!;
      let s: number;
      if (j.kind === JointKind.ball) {
        // Zero-length: the axial offset beyond the play.
        const along = ex * nx + ey * ny + ez * nz;
        s = along > j.play ? along - j.play : along < -j.play ? along + j.play : 0;
      } else {
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        s = d - j.rest;
        if (s > j.play) s -= j.play;
        else if (s < -j.play) s += j.play;
        else s = 0;
      }
      const g = dt * dt * j.k + dt * j.c;
      c.lo[i] = i > 0 ? -g * ia * (c.nx[i - 1]! * nx + c.ny[i - 1]! * ny + c.nz[i - 1]! * nz) : 0;
      c.up[i] = i + 1 < n ? -g * ib * (c.nx[i + 1]! * nx + c.ny[i + 1]! * ny + c.nz[i + 1]! * nz) : 0;
      c.di[i] = 1 + g * (ia + ib);
      c.rhs[i] = -dt * j.k * s - g * u;
    }
    // Thomas algorithm (diagonally dominant): forward elimination into up / rhs, back substitution into a
    // fresh λ (kept in lo as scratch until the deltas are applied).
    for (let i = 0; i < n; i++) {
      const m = i > 0 ? c.lo[i]! : 0;
      const den = c.di[i]! - (i > 0 ? m * c.up[i - 1]! : 0);
      c.up[i] = c.up[i]! / den;
      c.rhs[i] = (c.rhs[i]! - (i > 0 ? m * c.rhs[i - 1]! : 0)) / den;
    }
    for (let i = n - 1; i >= 0; i--) c.lo[i] = c.rhs[i]! - (i + 1 < n ? c.up[i]! * c.lo[i + 1]! : 0);
    const invDt = 1 / dt;
    for (let i = 0; i < n; i++) {
      const j = c.elems[i]!;
      const nl = c.lo[i]!;
      const dl = nl - lam[i]!;
      lam[i] = nl;
      const a = gi[i]!;
      const b = gi[i + 1]!;
      const nx = c.nx[i]!;
      const ny = c.ny[i]!;
      const nz = c.nz[i]!;
      if (im[i + 1]! > 0) {
        frcX[b] = frcX[b]! + dl * nx * invDt;
        frcY[b] = frcY[b]! + dl * ny * invDt;
        frcZ[b] = frcZ[b]! + dl * nz * invDt;
      }
      if (im[i]! > 0) {
        frcX[a] = frcX[a]! - dl * nx * invDt;
        frcY[a] = frcY[a]! - dl * ny * invDt;
        frcZ[a] = frcZ[a]! - dl * nz * invDt;
      }
      // Bookkeeping on the joint (impulse on ITS node B; the axis in its A → B sense).
      const sg = c.flip[i] === 0 ? 1 : -1;
      j.cx = sg * nl * nx;
      j.cy = sg * nl * ny;
      j.cz = sg * nl * nz;
      j.ax = sg * nx;
      j.ay = sg * ny;
      j.az = sg * nz;
    }
  }

  /** Applies every intact joint (creation order). See the header for the law. */
  apply(state: SimState, dt: number, tick: number, events: EventSink): void {
    if (this.chainsDirty) this.rebuildChains();
    const js = this.joints;
    if (this.blocksDirty) this.rebuildBlocks();
    // This tick's active joints (intact, not asleep on both sides), in creation order; runs of joints
    // between the same two objects (a prop's own members, a splice) are skipped whole while both sleep.
    if (this.act.length < js.length) this.act = new Int32Array(js.length * 2);
    const act = this.act;
    let n = 0;
    const bs = this.blkStart;
    for (let b = 0; b < this.blkCount; b++) {
      const j0 = js[bs[b]!]!;
      if ((j0.objA.flags & j0.objB.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) continue;
      const e = bs[b + 1]!;
      for (let q = bs[b]!; q < e; q++) {
        const j = js[q]!;
        if (j.broken) continue;
        j.lx = 0;
        j.ly = 0;
        j.lz = 0;
        j.cx = 0;
        j.cy = 0;
        j.cz = 0;
        act[n++] = q;
      }
    }
    if (n === 0) return;
    const ch = this.chains;
    for (let q = 0; q < ch.length; q++) ch[q]!.lam.fill(0);
    const it = this.iterations > 1 ? this.iterations : 1;
    // Symmetric sweeps (forward, backward, …): a one-directional order propagates corrections down a long
    // chain in one sweep but up it one link per sweep, and the far end rang. Chains are re-solved exactly
    // after every sweep.
    for (let k = 0; k < it; k++) {
      if ((k & 1) === 0) for (let q = 0; q < n; q++) this.solve(js[act[q]!]!, state, dt, tick);
      else for (let q = n - 1; q >= 0; q--) this.solve(js[act[q]!]!, state, dt, tick);
      for (let q = 0; q < ch.length; q++) this.solveChain(ch[q]!, state, dt);
    }
    const { posX, posY, posZ, invMass, frcX, frcY, frcZ } = state;
    const invDt = 1 / dt;
    for (let qq = 0; qq < n; qq++) {
      const j = js[act[qq]!]!;
      if (j.broken) continue;
      const Fx = (j.lx + j.cx) * invDt;
      const Fy = (j.ly + j.cy) * invDt;
      const Fz = (j.lz + j.cz) * invDt;
      const F = Math.sqrt(Fx * Fx + Fy * Fy + Fz * Fz);
      j.force = F;
      j.fx = Fx;
      j.fy = Fy;
      j.fz = Fz;
      if (F > j.peak) j.peak = F;
      const oa = j.objA;
      const ob = j.objB;
      const a = oa.nodeStart + j.nodeA;
      const b = ob.nodeStart + j.nodeB;
      if (F > j.breakF && tick >= (j.armTick ?? 0)) {
        // Broken: its impulse this tick is taken back out (it let go).
        j.broken = true;
        j.force = 0;
        const sa = (oa.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
        const sb = (ob.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
        if (!sb && invMass[b]! > 0) {
          frcX[b] = frcX[b]! - Fx;
          frcY[b] = frcY[b]! - Fy;
          frcZ[b] = frcZ[b]! - Fz;
        }
        if (!sa && invMass[a]! > 0) {
          frcX[a] = frcX[a]! + Fx;
          frcY[a] = frcY[a]! + Fy;
          frcZ[a] = frcZ[a]! + Fz;
        }
        events.impact(oa.objectId, MaterialId.metal, posX[a]!, posY[a]!, posZ[a]!, 0, 1, 0, F * dt);
        continue;
      }
      // Plastic flow of a yielding link: the rest length follows the excess force (hardening toward breakF).
      const y0 = j.yieldF;
      if (y0 !== undefined && j.kind === JointKind.link) {
        const ru = j.ruptureStrain;
        const ep = (j.rest - j.rest0) / j.rest0;
        const epa = ep < 0 ? -ep : ep;
        const yf = ru !== undefined ? y0 + ((j.breakF - y0) * epa) / ru : y0;
        if (F > yf) {
          const ex = posX[b]! - posX[a]!;
          const ey = posY[b]! - posY[a]!;
          const ez = posZ[b]! - posZ[a]!;
          const tension = -(Fx * ex + Fy * ey + Fz * ez) >= 0;
          j.rest += (tension ? F - yf : yf - F) / j.k;
          if (ru !== undefined && tension && (j.rest - j.rest0) / j.rest0 > ru) {
            j.broken = true;
            j.force = 0;
            events.impact(oa.objectId, MaterialId.metal, posX[a]!, posY[a]!, posZ[a]!, 0, 1, 0, F * dt);
          }
        }
      }
      if (F > JOINT_WAKE_FORCE) {
        if ((oa.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) this.wakeRequests.push(oa);
        else if ((ob.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) this.wakeRequests.push(ob);
      }
    }
  }

  /** One joint's backward-Euler solve against the current predicted velocities (accumulates its impulse). */
  private solve(j: Joint, state: SimState, dt: number, tick: number): void {
    if (j.broken) return;
    const inChain = j.chain === true;
    if (inChain && j.kind !== JointKind.ball) return; // axial only: the chain solve owns it
    const { posX, posY, posZ, velX, velY, velZ, frcX, frcY, frcZ, invMass } = state;
    const oa = j.objA;
    const ob = j.objB;
    const sa = (oa.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
    const sb = (ob.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0;
    if (sa && sb) return;
    const a = oa.nodeStart + j.nodeA;
    const b = ob.nodeStart + j.nodeB;
    const ima = sa ? 0 : invMass[a]!;
    const imb = sb ? 0 : invMass[b]!;
    const ims = ima + imb;
    if (ims === 0) return;
    const mr = 1 / ims;
    // Predicted relative velocity WITHOUT this joint's own impulse so far (frc holds it as lam/dt).
    const ux = velX[b]! + frcX[b]! * imb * dt - velX[a]! - frcX[a]! * ima * dt - j.lx * ims;
    const uy = velY[b]! + frcY[b]! * imb * dt - velY[a]! - frcY[a]! * ima * dt - j.ly * ims;
    const uz = velZ[b]! + frcZ[b]! * imb * dt - velZ[a]! - frcZ[a]! * ima * dt - j.lz * ims;
    const ex = posX[b]! - posX[a]!;
    const ey = posY[b]! - posY[a]!;
    const ez = posZ[b]! - posZ[a]!;
    const kd = (dt * j.k) / mr;
    const den = 1 + (dt * j.c) / mr + dt * kd;
    let jx = 0;
    let jy = 0;
    let jz = 0;
    if (j.kind === JointKind.ball) {
      let fx = ex;
      let fy = ey;
      let fz = ez;
      if (j.play > 0) {
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const s = d > j.play ? (d - j.play) / d : 0;
        fx *= s;
        fy *= s;
        fz *= s;
      }
      jx = mr * ((ux - kd * fx) / den - ux);
      jy = mr * ((uy - kd * fy) / den - uy);
      jz = mr * ((uz - kd * fz) / den - uz);
      if (inChain) {
        // Transverse only (the chain carries the axial part).
        const an = jx * j.ax + jy * j.ay + jz * j.az;
        jx -= an * j.ax;
        jy -= an * j.ay;
        jz -= an * j.az;
      }
    } else if (j.kind === JointKind.link) {
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d < 1e-9) return;
      let s = d - j.rest;
      if (s > j.play) s -= j.play;
      else if (s < -j.play) s += j.play;
      else s = 0;
      const nx = ex / d;
      const ny = ey / d;
      const nz = ez / d;
      const un = ux * nx + uy * ny + uz * nz;
      let jn = mr * ((un - kd * s) / den - un);
      if (j.strut === true && jn < 0) jn = 0; // a bearing only pushes
      jx = jn * nx;
      jy = jn * ny;
      jz = jn * nz;
    } else {
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (j.pretension !== undefined && tick < (j.armTick ?? 0)) {
        const r = d - j.pretension / j.k;
        if (r < j.rest && r > 0.02) j.rest = r;
      }
      const s = d - j.rest;
      if (s > 0 && d >= 1e-9) {
        const nx = ex / d;
        const ny = ey / d;
        const nz = ez / d;
        const un = ux * nx + uy * ny + uz * nz;
        let jn = mr * ((un - kd * s) / den - un);
        if (jn > 0) jn = 0; // a rope only pulls
        jx = jn * nx;
        jy = jn * ny;
        jz = jn * nz;
      }
    }
    // Apply the change of this joint's impulse.
    const invDt = 1 / dt;
    const dx = (jx - j.lx) * invDt;
    const dy = (jy - j.ly) * invDt;
    const dz = (jz - j.lz) * invDt;
    j.lx = jx;
    j.ly = jy;
    j.lz = jz;
    if (imb > 0) {
      frcX[b] = frcX[b]! + dx;
      frcY[b] = frcY[b]! + dy;
      frcZ[b] = frcZ[b]! + dz;
    }
    if (ima > 0) {
      frcX[a] = frcX[a]! - dx;
      frcY[a] = frcY[a]! - dy;
      frcZ[a] = frcZ[a]! - dz;
    }
  }
}
