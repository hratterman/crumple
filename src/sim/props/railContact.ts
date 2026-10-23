/**
 * RAIL FACE CONTACT (R-PHYS2) — WORKER ONLY. A guardrail's W-beam face is a
 * smooth steel surface; node spheres every 0.24 m along it are not: a car's
 * corner node dropped 6 cm into the valley between two rail spheres and
 * snagged (a 100 km/h glancing hit stopped dead in 0.3 s). So the rail
 * nodes carry no node-vs-node contact (rig objContact false), and vehicle
 * nodes contact the rail's face TRIANGLES instead — the two peak rows, one
 * quad per bay (rt_k, rb_k, rb_k+1, rt_k+1), facing traffic (−Z at rest),
 * following the rail as it bends — with the carrier surface law
 * (trailer/carrier.ts: penalty + implicit Coulomb, bounded push-out; the
 * rail nodes take the reaction). Posts and blockouts have no contact either:
 * a car's 0.2 m node spheres reach through the face to them (they sit only
 * 0.1–0.3 m behind it) and snagged a glancing hit to a stop — LIMITATION: a
 * wheel that pockets behind a flattened rail does not snag a post.
 *
 * Per tick, for each rail and each vehicle whose broadphase box overlaps it
 * (a sleeping rail is woken first: its face nodes are not in the props'
 * sleep / wake box): every contact node of the vehicle inside the rail's box
 * finds the nearest column (scan along the top row) and tests the two bays
 * beside it. Deterministic (arena order, node order); zero allocation.
 */
import { createCarrierRuntime, findTri, pushTri, updateTriFrames, type CarrierRuntime } from '../trailer/carrier';
import { NODE_FLAG_OBJ_CONTACT, SIM_OBJECT_FLAG_SLEEPING, type SimObject, type SimState } from '../types';
import type { CompiledRig } from '../rig/types';

/** Steel on painted / galvanized steel, sliding. */
export const RAIL_FRICTION = 0.3;
/** The W-beam's front (its peaks) ahead of the rail node centres, m. */
export const RAIL_LIFT = 0.04;

export interface RailSurface {
  c: CarrierRuntime;
  /** Object-local top-row node per column. */
  top: Int32Array;
  cols: number;
  /** Node-centre box of the rail this tick (padded by the largest vehicle node radius at use). */
  box: Float64Array;
}

/** Builds the face surface of a guardrail prop (rig nodes rt{k} / rb{k}); null if the rig has none. */
export function createRailSurface(obj: SimObject, rig: CompiledRig): RailSurface | null {
  const top: number[] = [];
  const bot: number[] = [];
  for (let k = 0; ; k++) {
    const t = rig.nodeIds.indexOf(`rt${k}`);
    const b = rig.nodeIds.indexOf(`rb${k}`);
    if (t < 0 || b < 0) break;
    top.push(t);
    bot.push(b);
  }
  if (top.length < 2) return null;
  const tri: number[] = [];
  for (let k = 0; k + 1 < top.length; k++) {
    // (rt_k, rb_k, rb_k+1) and (rt_k, rb_k+1, rt_k+1); oriented below so the normal faces −Z (traffic).
    tri.push(top[k]!, bot[k]!, bot[k + 1]!, top[k]!, bot[k + 1]!, top[k + 1]!);
  }
  const t = Int32Array.from(tri);
  const n = t.length / 3;
  // Orientation check at rest: flip a triangle whose normal points +Z.
  for (let q = 0; q < n; q++) {
    const a = t[3 * q]!;
    const b = t[3 * q + 1]!;
    const d = t[3 * q + 2]!;
    const P = rig.nodePos;
    const e0x = P[3 * b]! - P[3 * a]!;
    const e0y = P[3 * b + 1]! - P[3 * a + 1]!;
    const e1x = P[3 * d]! - P[3 * a]!;
    const e1y = P[3 * d + 1]! - P[3 * a + 1]!;
    if (e0x * e1y - e0y * e1x > 0) {
      t[3 * q + 1] = d;
      t[3 * q + 2] = b;
    }
  }
  const c = createCarrierRuntime(obj, t, new Uint8Array(n), RAIL_LIFT, RAIL_FRICTION);
  // A car pressed into the rail at 100 km/h loads a few nodes with tens of kN each: the spring keeps growing
  // to 3 node radii (a cap at 0.6 r let corner nodes sink through the face into the blockouts and posts).
  c.penCap = 3;
  // The node rows sit inside the W-beam's edges: the face reaches 0.12 × its height (≈ 3 cm) past them,
  // so the contact face spans the whole 0.31 m rail (and a low bumper meets its lower edge).
  c.margin = 0.12;
  return { c, top: Int32Array.from(top), cols: top.length, box: new Float64Array(6) };
}

function railBox(state: SimState, r: RailSurface): void {
  const { posX, posY, posZ } = state;
  const base = r.c.obj.nodeStart;
  const tri = r.c.tri;
  const b = r.box;
  b[0] = b[1] = b[2] = Infinity;
  b[3] = b[4] = b[5] = -Infinity;
  for (let q = 0; q < tri.length; q++) {
    const i = base + tri[q]!;
    const x = posX[i]!;
    const y = posY[i]!;
    const z = posZ[i]!;
    if (x < b[0]!) b[0] = x;
    if (y < b[1]!) b[1] = y;
    if (z < b[2]!) b[2] = z;
    if (x > b[3]!) b[3] = x;
    if (y > b[4]!) b[4] = y;
    if (z > b[5]!) b[5] = z;
  }
}

/** PAD: a vehicle node within this of the rail's node box is tested (≥ the largest node radius + travel). */
const PAD = 0.35;

/**
 * Rail face contacts of every awake rail with every vehicle in `vehicles` (objects, their broadphase boxes
 * `boxes` 6 per slot and slot indices `slots`).
 */
export function applyRailContacts(
  state: SimState,
  rails: readonly RailSurface[],
  vehicles: readonly SimObject[],
  boxes: Float64Array,
  slots: readonly number[],
  dt: number,
  gx: number,
  gy: number,
  gz: number,
  wake: (obj: SimObject) => void,
): void {
  const { posX, posY, posZ, objRadius, flags, invMass } = state;
  const invDt = 1 / dt;
  for (let q = 0; q < rails.length; q++) {
    const r = rails[q]!;
    const ro = r.c.obj;
    let frames = false;
    for (let v = 0; v < vehicles.length; v++) {
      const vo = vehicles[v]!;
      const s6 = 6 * slots[v]!;
      if (!frames) {
        railBox(state, r);
      }
      const b = r.box;
      if (boxes[s6]! > b[3]! + PAD || boxes[s6 + 3]! < b[0]! - PAD || boxes[s6 + 1]! > b[4]! + PAD || boxes[s6 + 4]! < b[1]! - PAD || boxes[s6 + 2]! > b[5]! + PAD || boxes[s6 + 5]! < b[2]! - PAD) continue;
      // A sleeping rail (its contact-less face is not in the sleep box) wakes as soon as a vehicle reaches it.
      if ((ro.flags & SIM_OBJECT_FLAG_SLEEPING) !== 0) wake(ro);
      if (!frames) {
        updateTriFrames(state, r.c);
        frames = true;
      }
      const base = ro.nodeStart;
      const end = vo.nodeStart + vo.nodeCount;
      for (let i = vo.nodeStart; i < end; i++) {
        if (invMass[i] === 0 || (flags[i]! & NODE_FLAG_OBJ_CONTACT) === 0) continue;
        const px = posX[i]!;
        const py = posY[i]!;
        const pz = posZ[i]!;
        if (px < b[0]! - PAD || px > b[3]! + PAD || py < b[1]! - PAD || py > b[4]! + PAD || pz < b[2]! - PAD || pz > b[5]! + PAD) continue;
        // Nearest column (top row) → the bays on either side of it.
        let kc = 0;
        let bd = Infinity;
        for (let k = 0; k < r.cols; k++) {
          const g = base + r.top[k]!;
          const dx = posX[g]! - px;
          const dz = posZ[g]! - pz;
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d;
            kc = k;
          }
        }
        const k0 = kc > 0 ? kc - 1 : 0;
        const k1 = kc + 1 < r.cols ? kc + 1 : r.cols - 1;
        const rad = objRadius[i]!;
        const t = findTri(state, r.c, base, 2 * k0, 2 * k1, 0, px, py, pz, rad, -1);
        if (t < 0) continue;
        pushTri(state, r.c, i, t, r.c.hitS, r.c.hitU, r.c.hitV, r.c.hitW, rad, dt, invDt, gx, gy, gz);
      }
    }
  }
}
