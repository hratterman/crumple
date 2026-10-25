/**
 * R-CRASH hinged closures (pure data module, main-importable like the vehicle defs): doors, trunk lids,
 * tailgates as physical sub-rigs that swing on real hinge axes.
 *
 * A closure is a small grid of skin nodes (its own node group), stiffened out of plane by a few INNER
 * nodes (the inner panel / reinforcement, inset from the skin: a planar grid alone folds along any row
 * like paper — a door's window frame flopped about its belt line), with:
 *  - HINGES: every node of the hinge column / row is beamed to BOTH ends of the hinge axis (two body
 *    nodes). Two fixed distances put each hinged node on a circle about that axis, and the skin ties the
 *    hinged nodes together: the panel can only rotate about the axis (a revolute joint out of beams).
 *    Hinge beams yield (bent hinge) and break (torn off) at their own forces.
 *  - LATCHES: elastic beams from the shut edge to the latch pillar that snap at `latchBreak` — by an
 *    impact load, or when the body around them deforms (the latch beam stretches with the opening).
 *  - STOPS: compression-only `support` rests from the shut edge into the body: the panel cannot be pushed
 *    in past closed, and is free to swing out once the latch has gone.
 *  - CHECK STRAP / GAS STRUT: one soft preloaded `shock` beam whose length grows with the opening angle:
 *    `strapForce` N at closed, zero at `holdOpenDeg`. An unlatched door pops ajar (as its seals push a real
 *    one) and then swings with the car's motion (opens under braking, swings shut under acceleration,
 *    flaps at speed); a trunk lid rises on its struts. Pushed shut, it springs back out.
 *  - OPEN STOP: a compression-only `support` beam from a panel node to a body node chosen so that its
 *    length first GROWS as the panel opens and comes back to its closed length at `maxOpenDeg` (the
 *    panel's edge reaching the fender / the hinge's own stop): slack in between, a hard stop beyond, and
 *    a second closed-position stop for free. Overextended (a door bent forward by a hit or a barrier)
 *    it breaks, and the hinges take the load (bend, then tear off).
 * Stiffness follows the defs' per-node budget rule: each closure node's Σk ≤ budget·m, split by weight
 * over its beams; a body endpoint never limits it (the def counts the closure k as FIXED k at its body
 * nodes, so their auto beams shrink to fit, as for the P4 hood).
 */
import type { RigBeamDef, RigNodeDef } from '../rig/types';

export type V3 = readonly [number, number, number];

export interface ClosureSpec {
  /** Node-id prefix (`${id}_${row}${col}`), e.g. 'dFR'. */
  id: string;
  /** Node group (one per kind: 'door', 'trunk', …; shell / friction / radius per group). */
  group: string;
  /** Skin nodes, rows (bottom → top) × cols (hinge edge → shut edge); null = no node; rig-local rest positions. */
  grid: readonly (readonly (V3 | null)[])[];
  /** Inner-panel nodes (rig-local rest positions, inset from the skin): each is beamed to every skin node within `innerReach`. */
  inner: readonly V3[];
  innerReach: number;
  /** Skin quad diagonals: 2 (both, default) or 1 (alternating: a lighter panel for a tight beam budget). */
  diagonals?: 1 | 2;
  /** Mass of each skin node, kg (fixed: outside the def's structure mass solve). */
  nodeMass: number;
  /** Hinge axis: two body node ids. */
  hingeAxis: readonly [string, string];
  /** Grid cells beamed to both axis ends ([row, col]). */
  hinged: readonly (readonly [number, number])[];
  /** Latch beams: grid cell → body node. */
  latches: readonly { cell: readonly [number, number]; to: string }[];
  /** Closed-position stops (support beams): grid cell → body node (inside the body). */
  stops: readonly { cell: readonly [number, number]; to: string }[];
  /**
   * Aperture racking sensors: body node pairs across the opening (hinge pillar ↔ latch pillar). A soft
   * elastic beam that breaks when the opening distorts by `rackStrain`: listed with the latches, so the
   * closure unlatches when the body around it is twisted / crushed (a rollover, a hard side hit), as real
   * latches pop when their striker moves out of line.
   */
  rack: readonly (readonly [string, string])[];
  rackStrain: number;
  /** Check strap / gas strut: grid cell → body node; its length must grow with the opening. */
  strap: { cell: readonly [number, number]; to: string } | null;
  /** Strap push at closed, N (zero at holdOpenDeg). */
  strapForce: number;
  /** Body nodes searched for the open stop (see the header). */
  stopCandidates: readonly string[];
  /** Grid rows whose cells may carry the open stop (the stiff panel, not a window frame). */
  stopRows: readonly number[];
  /** Rest pose of the strap node at the hold-open / max-open angles (computed by the def: its length → preload / bound). */
  holdOpenDeg: number;
  maxOpenDeg: number;
  /** Σk / m allowed per closure node, (N/m)/kg (the def's BUDGET_PER_KG). */
  budgetPerKg: number;
  skin: { zeta: number; yieldStrain: number; minDeform: number; breakRatio: number };
  hingeDeform: number;
  hingeBreak: number;
  latchBreak: number;
  stopBreak: number;
}

export interface ClosureBuild {
  nodes: RigNodeDef[];
  beams: RigBeamDef[];
  /** Node ids, grid order (null where the grid has none). */
  ids: (string | null)[][];
  /** Every beam whose breaking unlatches the closure (latches + racking sensors), as node-id pairs. */
  latchPairs: [string, string][];
}

/** Rotates p about the axis a → b by `deg` degrees (right-handed about a→b). */
export function rotateAbout(p: V3, a: V3, b: V3, deg: number): [number, number, number] {
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const l = Math.hypot(ax, ay, az);
  const ux = ax / l, uy = ay / l, uz = az / l;
  const px = p[0] - a[0], py = p[1] - a[1], pz = p[2] - a[2];
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const dot = ux * px + uy * py + uz * pz;
  const cx = uy * pz - uz * py, cy = uz * px - ux * pz, cz = ux * py - uy * px;
  return [
    a[0] + px * c + cx * s + ux * dot * (1 - c),
    a[1] + py * c + cy * s + uy * dot * (1 - c),
    a[2] + pz * c + cz * s + uz * dot * (1 - c),
  ];
}

/**
 * The open stop (see the header): over every panel cell × candidate body node, the pair whose distance
 * grows as the panel opens and returns to its closed value closest to maxOpenDeg (within 12°), with at
 * least 2 cm of slack at its widest. Throws when none qualifies (the def lists better candidates).
 */
function findOpenStop(
  spec: ClosureSpec,
  ids: (string | null)[][],
  P: (id: string) => V3,
  bodyPos: (id: string) => V3,
  openSign: 1 | -1,
): { cell: string; to: string; deg: number } {
  const a = bodyPos(spec.hingeAxis[0]);
  const b = bodyPos(spec.hingeAxis[1]);
  let best: { cell: string; to: string; deg: number; score: number } | null = null;
  for (const r of spec.stopRows) {
    for (const c of ids[r] ?? []) {
      if (!c) continue;
      const p0 = P(c);
      for (const q of spec.stopCandidates) {
        const Q = bodyPos(q);
        const d0 = dist(p0, Q);
        let widest = 0;
        let deg = -1;
        let grew = false;
        for (let t = 0.5; t <= 150; t += 0.5) {
          const d = dist(rotateAbout(p0, a, b, openSign * t), Q);
          if (t === 0.5) grew = d > d0;
          if (!grew) break;
          widest = Math.max(widest, d - d0);
          if (d <= d0) {
            deg = t;
            break;
          }
        }
        if (deg < 0 || widest < 0.02) continue;
        const score = Math.abs(deg - spec.maxOpenDeg) - widest;
        if (Math.abs(deg - spec.maxOpenDeg) <= 12 && (!best || score < best.score)) best = { cell: c, to: q, deg, score };
      }
    }
  }
  if (!best) throw new Error(`closure ${spec.id}: no open stop near ${spec.maxOpenDeg}° among the candidates`);
  return best;
}

const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;
const sig3 = (x: number): number => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(3)));
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Builds a closure sub-rig. `bodyPos(id)` returns a body node's rest position, `bodyMass(id)` its mass
 * (damping of the body-side beams). `openSign` = ±1: the rotation sense about hingeAxis[0] → [1] that
 * OPENS the panel (the def picks it so the shut edge swings outward).
 */
export function buildClosure(spec: ClosureSpec, bodyPos: (id: string) => V3, bodyMass: (id: string) => number, openSign: 1 | -1): ClosureBuild {
  const nodes: RigNodeDef[] = [];
  const ids: (string | null)[][] = spec.grid.map((row, r) =>
    row.map((p, c) => {
      if (!p) return null;
      const id = `${spec.id}_${r}${c}`;
      nodes.push({ id, pos: [round(p[0]), round(p[1]), round(p[2])], mass: spec.nodeMass, group: spec.group });
      return id;
    }),
  );
  const innerIds = spec.inner.map((p, k) => {
    const id = `${spec.id}_i${k}`;
    nodes.push({ id, pos: [round(p[0]), round(p[1]), round(p[2])], mass: spec.nodeMass, group: spec.group });
    return id;
  });
  const own = new Map<string, V3>();
  for (const n of nodes) own.set(n.id, n.pos as V3);
  const P = (id: string): V3 => own.get(id) ?? bodyPos(id);
  const M = (id: string): number => (own.has(id) ? spec.nodeMass : bodyMass(id));
  const cell = (rc: readonly [number, number]): string => {
    const id = ids[rc[0]]?.[rc[1]];
    if (!id) throw new Error(`closure ${spec.id}: no node at ${rc.join(',')}`);
    return id;
  };

  type B = { a: string; b: string; w: number; kind: 'skin' | 'hinge' | 'latch' | 'stop' | 'strap' | 'openStop' };
  const list: B[] = [];
  // skin: grid edges + both quad diagonals (where the quad's corners exist)
  const at = (r: number, c: number): string | null => ids[r]?.[c] ?? null;
  for (let r = 0; r < ids.length; r++) {
    for (let c = 0; c < ids[r]!.length; c++) {
      const a = at(r, c);
      const right = at(r, c + 1);
      const up = at(r + 1, c);
      const diag = at(r + 1, c + 1);
      if (a && right) list.push({ a, b: right, w: 1, kind: 'skin' });
      if (a && up) list.push({ a, b: up, w: 1, kind: 'skin' });
      const both = (spec.diagonals ?? 2) === 2;
      const first = both || (r + c) % 2 === 0;
      if (a && diag && (first || !(right && up))) list.push({ a, b: diag, w: 0.5, kind: 'skin' });
      if (right && up && (both || !(first && a && diag))) list.push({ a: right, b: up, w: 0.5, kind: 'skin' });
    }
  }
  for (const iid of innerIds) {
    for (const row of ids) for (const c of row) if (c && dist(own.get(iid)!, own.get(c)!) <= spec.innerReach) list.push({ a: iid, b: c, w: 0.75, kind: 'skin' });
  }
  for (let k = 1; k < innerIds.length; k++) list.push({ a: innerIds[k - 1]!, b: innerIds[k]!, w: 0.75, kind: 'skin' });
  for (const rc of spec.hinged) for (const end of spec.hingeAxis) list.push({ a: cell(rc), b: end, w: 1.5, kind: 'hinge' });
  for (const l of spec.latches) list.push({ a: cell(l.cell), b: l.to, w: 1, kind: 'latch' });
  for (const s of spec.stops) list.push({ a: cell(s.cell), b: s.to, w: 0.5, kind: 'stop' });
  if (spec.strap) list.push({ a: cell(spec.strap.cell), b: spec.strap.to, w: 0, kind: 'strap' });
  const os = findOpenStop(spec, ids, P, bodyPos, openSign);
  list.push({ a: os.cell, b: os.to, w: 1, kind: 'openStop' });

  const W = new Map<string, number>();
  for (const b of list) for (const id of [b.a, b.b]) if (own.has(id)) W.set(id, (W.get(id) ?? 0) + b.w);
  const share = (id: string): number => (own.has(id) ? (spec.budgetPerKg * spec.nodeMass) / W.get(id)! : Infinity);

  const beams: RigBeamDef[] = [];
  for (const { a, b, w, kind } of list) {
    const k = sig3(0.995 * w * Math.min(share(a), share(b)));
    const ma = M(a);
    const mb = M(b);
    const d = sig3(2 * spec.skin.zeta * Math.sqrt((k * ma * mb) / (ma + mb)));
    const L = dist(P(a), P(b));
    if (kind === 'skin') {
      const deform = sig3(Math.max(spec.skin.yieldStrain * k * L, spec.skin.minDeform));
      beams.push({ a, b, type: 'normal', k, d, deform, breakF: sig3(spec.skin.breakRatio * deform) });
    } else if (kind === 'hinge') {
      beams.push({ a, b, type: 'normal', k, d, deform: spec.hingeDeform, breakF: spec.hingeBreak });
    } else if (kind === 'latch') {
      beams.push({ a, b, type: 'normal', k, d, deform: 0, breakF: spec.latchBreak });
    } else if (kind === 'stop') {
      beams.push({ a, b, type: 'support', k, d, deform: 0, breakF: spec.stopBreak });
    } else if (kind === 'openStop') {
      // a rubber-padded stop: light damping (it spans to a body node whose damping budget is the def's)
      beams.push({ a, b, type: 'support', k, d: sig3(0.15 * d), deform: 0, breakF: spec.hingeBreak });
    } else {
      // check strap / strut: a soft spring with its (preloaded) rest at holdOpenDeg
      const sp = P(a);
      const lHold = dist(rotateAbout(sp, bodyPos(spec.hingeAxis[0]), bodyPos(spec.hingeAxis[1]), openSign * spec.holdOpenDeg), P(b));
      if (!(lHold > L + 0.01)) throw new Error(`closure ${spec.id}: the check strap must lengthen as it opens (${L} → ${lHold})`);
      const ks = sig3(spec.strapForce / (lHold - L));
      // ≈ critically damped for the whole panel's mass on the strap: it swings, it does not ring
      const n = nodes.length;
      const ds = sig3(2 * Math.sqrt(ks * n * spec.nodeMass));
      beams.push({ a, b, type: 'shock', k: ks, d: ds, deform: 0, breakF: spec.hingeBreak, preload: sig3(spec.strapForce), boundsLow: 1, boundsHigh: 10 });
    }
  }
  // racking sensors: soft (1e4 N/m, negligible next to the cell), elastic, break at rackStrain
  const latchPairs: [string, string][] = spec.latches.map((l) => [cell(l.cell), l.to]);
  for (const [a, b] of spec.rack) {
    const L = dist(P(a), P(b));
    const k = 1e4;
    beams.push({ a, b, type: 'normal', k, d: sig3(0.2 * Math.sqrt(k * Math.min(M(a), M(b)))), deform: 0, breakF: sig3(k * L * spec.rackStrain) });
    latchPairs.push([a, b]);
  }
  return { nodes, beams, ids, latchPairs };
}

// ====================================================================== shared door layout (station cages)
/**
 * A side door on a station cage (`${station}_${tag}_${side}` ids: sl sill, hp hinge pillar, dm door
 * middle, bt belt, rf roof rail, qm quarter middle, fl floor, tn tunnel): 3 × 3 skin grid from the hinge
 * pillar to the latch pillar between the sill and the belt, plus the window-frame top row (rf less
 * 1 / 4 cm) where `top` says, two inner-panel nodes. Same rules as the sedan's hand-written doors.
 */
export interface StationDoor {
  id: string;
  side: 'L' | 'R';
  /** Hinge / latch pillar stations and the station between them (rows, x). */
  hinge: string;
  latch: string;
  mid: string;
  /** Hinge pillar's upper hinge tag ('hp' A-pillar, 'dm' B-pillar) and the latch pillar's striker tag ('dm' | 'qm'). */
  hingeTag: string;
  latchTag: string;
  /** Rack sensor's upper hinge-pillar node tag ('cw' A-pillar base, 'dm'). */
  rackTag: string;
  /** Stations with roof-rail nodes (`rf`), front → rear: the frame top follows them. */
  rails: readonly string[];
  /** Window-frame top row per column (hinge → shut). */
  top: readonly [boolean, boolean, boolean];
  /** Check-strap body node. */
  strapTo: string;
  /** Centre-line tunnel node of the latch station (upper stop), e.g. `${latch}_tn`. */
  tunnel: string;
}

export function stationDoorSpec(
  pos: (id: string) => V3,
  d: StationDoor,
  common: Pick<ClosureSpec, 'nodeMass' | 'budgetPerKg' | 'skin' | 'hingeDeform' | 'hingeBreak' | 'latchBreak' | 'stopBreak' | 'rackStrain' | 'holdOpenDeg' | 'maxOpenDeg' | 'strapForce'>,
): ClosureSpec {
  const n = (st: string, tag: string): string => `${st}_${tag}_${d.side}`;
  const sx = Math.sign(pos(n(d.mid, 'sl'))[0]);
  const zH = pos(n(d.hinge, 'sl'))[2];
  const zL = pos(n(d.latch, 'sl'))[2];
  const zs = [zH + 0.06, (zH + 0.06 + zL - 0.05) / 2, zL - 0.05];
  const m = { sl: pos(n(d.mid, 'sl')), dm: pos(n(d.mid, 'dm')), bt: pos(n(d.mid, 'bt')) };
  const rows: [number, number][] = [
    [Math.abs(m.sl[0]) + 0.005, m.sl[1] + 0.07],
    [Math.abs(m.dm[0]) + 0.005, m.dm[1] + 0.02],
    [Math.abs(m.bt[0]) + 0.005, m.bt[1] - 0.01],
  ];
  const rail = d.rails.map((st) => pos(n(st, 'rf')));
  const railAt = (z: number): [number, number] => {
    if (z <= rail[0]![2]) return [Math.abs(rail[0]![0]), rail[0]![1]];
    for (let k = 1; k < rail.length; k++) {
      const a = rail[k - 1]!;
      const b = rail[k]!;
      if (z <= b[2]) {
        const f = (z - a[2]) / (b[2] - a[2]);
        return [Math.abs(a[0] + f * (b[0] - a[0])), a[1] + f * (b[1] - a[1])];
      }
    }
    const l = rail[rail.length - 1]!;
    return [Math.abs(l[0]), l[1]];
  };
  const grid: (V3 | null)[][] = rows.map(([x, y]) => zs.map((z) => [sx * x, y, z] as V3));
  grid.push(zs.map((z, c) => (d.top[c] ? ([sx * (railAt(z)[0] - 0.01), railAt(z)[1] - 0.04, z] as V3) : null)));
  return {
    id: d.id,
    group: 'door',
    grid,
    inner: [
      [sx * (rows[0]![0] - 0.14), (rows[0]![1] + rows[1]![1]) / 2, zs[1]!],
      [sx * (rows[2]![0] - 0.14), rows[2]![1], (zs[1]! + zs[2]!) / 2],
    ],
    innerReach: 0.75,
    hingeAxis: [n(d.hinge, 'sl'), n(d.hinge, d.hingeTag)],
    hinged: [[0, 0], [1, 0], [2, 0]],
    latches: [
      { cell: [1, 2], to: n(d.latch, d.latchTag) },
      { cell: [1, 2], to: n(d.latch, 'fl') },
    ],
    stops: [
      { cell: [0, 2], to: n(d.latch, 'fl') },
      { cell: [2, 2], to: d.tunnel },
    ],
    rack: [
      [n(d.hinge, d.rackTag), n(d.latch, 'sl')],
      [n(d.hinge, 'sl'), n(d.latch, d.latchTag)],
    ],
    strap: { cell: [1, 1], to: d.strapTo },
    stopCandidates: [],
    stopRows: [1, 2],
    ...common,
  };
}

/**
 * Opening sense and open-stop candidates of each closure (in place), given the def's rest positions:
 * the sense that moves the shut edge outward (doors: |x| grows) / upward (lids: y grows); candidates =
 * structure nodes (`isStructure`) within 1.1 m of the hinge axis' midpoint.
 */
export function planClosures(specs: { spec: ClosureSpec; openSign: 1 | -1 }[], pos: ReadonlyMap<string, V3>, isStructure: (id: string) => boolean): void {
  const structIds = [...pos.keys()].filter(isStructure);
  for (const c of specs) {
    const a = pos.get(c.spec.hingeAxis[0])!;
    const b = pos.get(c.spec.hingeAxis[1])!;
    const mid = [0, 1, 2].map((k) => (a[k]! + b[k]!) / 2);
    c.spec = { ...c.spec, stopCandidates: structIds.filter((id) => Math.hypot(...[0, 1, 2].map((k) => pos.get(id)![k]! - mid[k]!)) < 1.1) };
    const shut = c.spec.latches[0]!.cell;
    const p = c.spec.grid[shut[0]]![shut[1]]!;
    const q = rotateAbout(p, a, b, 10);
    const lid = c.spec.group !== 'door';
    c.openSign = (lid ? q[1] > p[1] : Math.abs(q[0]) > Math.abs(p[0])) ? 1 : -1;
  }
}

/**
 * Beams of every planned closure (after the def's structure mass solve: its closure beams count as
 * fixed k at their body nodes) and their latched shell zones (`release`: when an impact on the closed
 * panel lets it go, like the cell around it). `seen` / `key`: the def's duplicate-beam guard.
 */
export function buildClosureSet(
  specs: readonly { spec: ClosureSpec; openSign: 1 | -1 }[],
  pos: ReadonlyMap<string, V3>,
  massOf: ReadonlyMap<string, number>,
  seen: Set<string>,
  key: (a: string, b: string) => string,
  release: { lo: number; hi: number; vLo: number; vHi: number },
): { beams: RigBeamDef[]; zones: { ids: string[]; release: { lo: number; hi: number; vLo: number; vHi: number }; whole: true; yield: true; latch: [string, string][] }[] } {
  const beams: RigBeamDef[] = [];
  const zones: { ids: string[]; release: { lo: number; hi: number; vLo: number; vHi: number }; whole: true; yield: true; latch: [string, string][] }[] = [];
  for (const c of specs) {
    const built = buildClosure(c.spec, (id) => pos.get(id)!, (id) => massOf.get(id)!, c.openSign);
    for (const b of built.beams) {
      const k = key(b.a, b.b);
      if (seen.has(k)) throw new Error(`closure ${c.spec.id}: duplicate beam ${b.a}–${b.b}`);
      seen.add(k);
      beams.push(b);
    }
    zones.push({ ids: [`${c.spec.id}_*`], release, whole: true, yield: true, latch: built.latchPairs });
  }
  return { beams, zones };
}

/** Adds every closure node (skin grid, then inner panel) through the def's addNode (fixed mass, not structure). */
export function addClosureNodes(
  specs: readonly { spec: ClosureSpec }[],
  addNode: (id: string, p: readonly number[], mass: number, group: string, collidable?: boolean, isStructure?: boolean) => string,
): void {
  for (const { spec } of specs) {
    spec.grid.forEach((row, r) => row.forEach((pt, k) => pt && addNode(`${spec.id}_${r}${k}`, pt, spec.nodeMass, spec.group, true, false)));
    spec.inner.forEach((pt, k) => addNode(`${spec.id}_i${k}`, pt, spec.nodeMass, spec.group, true, false));
  }
}
