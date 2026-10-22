/**
 * DEBRIS ISLAND SLEEP (R-PHYS2) — WORKER ONLY. A crashed vehicle's torn-off
 * parts (a bumper, a door, a hood: R-CRASH's detached sub-rigs) stay nodes
 * of the vehicle object — the renderer binds them there — and vehicles never
 * sleep, so every scrap would be stepped at 2 kHz forever. Here each
 * vehicle's BODY nodes are split into connected components over its intact
 * body beams (re-labelled only when a beam broke since the last labelling);
 * every component that does not hold the frame origin is a debris ISLAND:
 *
 *  - an island whose nodes all stay slower than DEBRIS_SLEEP_SPEED for
 *    DEBRIS_SLEEP_S FREEZES: its nodes are pinned in place (invMass 0,
 *    velocities 0; every kernel treats a pinned node as static: beams,
 *    contacts, the shell's fit skip it), so it costs a beam pass and no
 *    contact or integration work and is an immovable obstacle;
 *  - it WAKES (masses restored) when a moving object — another vehicle, a
 *    prop, or its own car's main body — comes within DEBRIS_WAKE_PAD of its
 *    box (checked at broadphase rebuilds, so a car can kick its own bumper);
 *  - BUDGET: at most DEBRIS_AWAKE_MAX islands awake over all vehicles; above
 *    it the slowest ones below DEBRIS_BUDGET_SPEED freeze early.
 * Wheel nodes are never part of an island (a detached wheel keeps rolling;
 * the wheel kernels divide by node masses). `reset` restores the masses
 * (the arena reloads the rig); `recover` wakes everything first.
 * Deterministic: labelling in node order, islands in label order.
 */
import type { SimObject, SimState } from '../types';
import type { VehicleRuntime } from '../vehicle/types';

export const DEBRIS_SLEEP_SPEED = 0.05;
export const DEBRIS_SLEEP_S = 1.0;
export const DEBRIS_WAKE_PAD = 0.4;
export const DEBRIS_AWAKE_MAX = 24;
export const DEBRIS_BUDGET_SPEED = 0.3;

export interface DebrisIsland {
  /** Object-local node indices. */
  nodes: Int32Array;
  frozen: boolean;
  stillS: number;
  /** Saved invMass per node while frozen. */
  saved: Float64Array;
  /** Node-centre box (min xyz, max xyz) and max speed at the last rebuild. */
  box: Float64Array;
  vmax: number;
}

export interface VehicleDebris {
  obj: SimObject;
  bodyNodes: number;
  bodyBeams: number;
  /** Broken body beams counted at the last labelling. */
  broken: number;
  islands: DebrisIsland[];
  /** Scratch: component label per body node. */
  label: Int32Array;
  /** Main-component box (for self wake). */
  mainBox: Float64Array;
}

export function createVehicleDebris(obj: SimObject, v: VehicleRuntime): VehicleDebris {
  return {
    obj,
    bodyNodes: v.vehicle.bodyNodeCount,
    bodyBeams: v.vehicle.bodyBeamCount,
    broken: 0,
    islands: [],
    label: new Int32Array(v.vehicle.bodyNodeCount),
    mainBox: new Float64Array(6),
  };
}

/** Wakes every island (restoring masses) and forgets them (recover / topology change). */
export function wakeAllIslands(state: SimState, d: VehicleDebris): void {
  for (const isl of d.islands) if (isl.frozen) thaw(state, d.obj, isl);
  d.islands = [];
  d.broken = -1;
}

function thaw(state: SimState, obj: SimObject, isl: DebrisIsland): void {
  const base = obj.nodeStart;
  for (let k = 0; k < isl.nodes.length; k++) state.invMass[base + isl.nodes[k]!] = isl.saved[k]!;
  isl.frozen = false;
  isl.stillS = 0;
}

function freeze(state: SimState, obj: SimObject, isl: DebrisIsland): void {
  const base = obj.nodeStart;
  for (let k = 0; k < isl.nodes.length; k++) {
    const i = base + isl.nodes[k]!;
    isl.saved[k] = state.invMass[i]!;
    state.invMass[i] = 0;
    state.velX[i] = 0;
    state.velY[i] = 0;
    state.velZ[i] = 0;
  }
  isl.frozen = true;
}

/** Re-labels the body's connected components when beams broke since the last labelling. */
function relabel(state: SimState, d: VehicleDebris, frameOrigin: number): void {
  const o = d.obj;
  let broken = 0;
  const be = o.beamStart + d.bodyBeams;
  for (let b = o.beamStart; b < be; b++) if (state.active[b] === 0) broken++;
  if (broken === d.broken) return;
  // Topology changed: thaw everything (labels move), then label by union-find over intact body beams.
  for (const isl of d.islands) if (isl.frozen) thaw(state, o, isl);
  d.broken = broken;
  const n = d.bodyNodes;
  const parent = d.label;
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const ns = o.nodeStart;
  for (let b = o.beamStart; b < be; b++) {
    if (state.active[b] === 0) continue;
    const a = state.aIdx[b]! - ns;
    const c = state.bIdx[b]! - ns;
    if (a >= n || c >= n || a < 0 || c < 0) continue;
    const ra = find(a);
    const rc = find(c);
    if (ra !== rc) {
      if (ra < rc) parent[rc] = ra;
      else parent[ra] = rc;
    }
  }
  const main = find(frameOrigin);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (r === main || state.invMass[ns + i] === 0) continue;
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  d.islands = [...groups.keys()]
    .sort((x, y) => x - y)
    .map((r) => {
      const nodes = Int32Array.from(groups.get(r)!);
      return { nodes, frozen: false, stillS: 0, saved: new Float64Array(nodes.length), box: new Float64Array(6), vmax: 0 };
    });
}

function measure(state: SimState, base: number, nodes: Int32Array | null, count: number, box: Float64Array): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  let v2 = 0;
  const { posX, posY, posZ, velX, velY, velZ } = state;
  for (let k = 0; k < count; k++) {
    const i = base + (nodes ? nodes[k]! : k);
    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    const s = velX[i]! * velX[i]! + velY[i]! * velY[i]! + velZ[i]! * velZ[i]!;
    if (s > v2) v2 = s;
  }
  box[0] = x0;
  box[1] = y0;
  box[2] = z0;
  box[3] = x1;
  box[4] = y1;
  box[5] = z1;
  return Math.sqrt(v2);
}

function near(a: Float64Array, b: Float64Array, ao: number, pad: number): boolean {
  return a[ao]! - pad <= b[3]! && a[ao + 3]! + pad >= b[0]! && a[ao + 1]! - pad <= b[4]! && a[ao + 4]! + pad >= b[1]! && a[ao + 2]! - pad <= b[5]! && a[ao + 5]! + pad >= b[2]!;
}

/**
 * Broadphase-rate update of every vehicle's debris (`elapsed` s since the
 * last one). `movers` = the broadphase's object boxes (6 per slot: min xyz,
 * max xyz), max node speeds and validity; `slotOf` maps a vehicle to its slot.
 */
export function updateDebris(
  state: SimState,
  all: readonly VehicleDebris[],
  frameOrigins: readonly number[],
  elapsed: number,
  boxes: Float64Array,
  vmax: Float64Array,
  objectCount: number,
  slotOf: readonly number[],
): void {
  let awake = 0;
  for (let v = 0; v < all.length; v++) {
    const d = all[v]!;
    relabel(state, d, frameOrigins[v]!);
    if (d.islands.length === 0) continue;
    const base = d.obj.nodeStart;
    // Main body box (self wake: the car rolls over its own scraps). Islands share the vehicle's slot box,
    // so the main box is measured over the frame-origin component only.
    let mx0 = Infinity;
    let my0 = Infinity;
    let mz0 = Infinity;
    let mx1 = -Infinity;
    let my1 = -Infinity;
    let mz1 = -Infinity;
    let mv = 0;
    const lab = d.label;
    const fo = frameOrigins[v]!;
    let root = fo;
    while (lab[root] !== root) root = lab[root]!;
    for (let i = 0; i < d.bodyNodes; i++) {
      let r = i;
      while (lab[r] !== r) r = lab[r]!;
      if (r !== root) continue;
      const g = base + i;
      const x = state.posX[g]!;
      const y = state.posY[g]!;
      const z = state.posZ[g]!;
      if (x < mx0) mx0 = x;
      if (x > mx1) mx1 = x;
      if (y < my0) my0 = y;
      if (y > my1) my1 = y;
      if (z < mz0) mz0 = z;
      if (z > mz1) mz1 = z;
      const s = state.velX[g]! ** 2 + state.velY[g]! ** 2 + state.velZ[g]! ** 2;
      if (s > mv) mv = s;
    }
    const mb = d.mainBox;
    mb[0] = mx0;
    mb[1] = my0;
    mb[2] = mz0;
    mb[3] = mx1;
    mb[4] = my1;
    mb[5] = mz1;
    const mainMoving = Math.sqrt(mv) > 0.1;
    for (const isl of d.islands) {
      if (isl.frozen) {
        let wake = mainMoving && near(mb, isl.box, 0, DEBRIS_WAKE_PAD);
        for (let o = 0; o < objectCount && !wake; o++) {
          if (o === slotOf[v] || vmax[o]! < 0.1) continue;
          wake = near(boxes, isl.box, 6 * o, DEBRIS_WAKE_PAD);
        }
        if (wake) thaw(state, d.obj, isl);
        continue;
      }
      isl.vmax = measure(state, base, isl.nodes, isl.nodes.length, isl.box);
      if (isl.vmax < DEBRIS_SLEEP_SPEED) {
        isl.stillS += elapsed;
        if (isl.stillS >= DEBRIS_SLEEP_S) freeze(state, d.obj, isl);
      } else isl.stillS = 0;
      if (!isl.frozen) awake++;
    }
  }
  if (awake <= DEBRIS_AWAKE_MAX) return;
  // Budget: freeze the slowest slow islands (vehicle order, then island order on ties).
  const cand: [number, DebrisIsland, VehicleDebris][] = [];
  for (const d of all) for (const isl of d.islands) if (!isl.frozen && isl.vmax < DEBRIS_BUDGET_SPEED) cand.push([isl.vmax, isl, d]);
  cand.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < cand.length && awake > DEBRIS_AWAKE_MAX; k++) {
    freeze(state, cand[k]![2].obj, cand[k]![1]);
    awake--;
  }
}
