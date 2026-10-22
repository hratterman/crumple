/**
 * hashSimState (P7): FNV-1a 32 over the sim state that evolves — tick,
 * object table (id, flags, ranges, actions), every used node's position +
 * velocity (f64 bit patterns), every used beam's plastic state (rest length,
 * stiffness, active), and every live traffic agent's route state. Used by
 * `replayPause` / `stateHashRequest` answers and the ReplayFile end hash.
 * Not a hot path (allocation of two tiny views per call is fine).
 */
import type { SimEngine } from '../engine';
import { SOFT_TILE } from '../softground/softground';

export function hashSimState(eng: SimEngine): number {
  let h = 0x811c9dc5 | 0;
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  const mix = (w: number): void => {
    h = Math.imul(h ^ (w | 0), 0x01000193);
  };
  const word = (x: number): void => {
    f[0] = x;
    mix(u[0]!);
    mix(u[1]!);
  };
  mix(eng.tick);
  const objs = eng.objects;
  mix(objs.length);
  for (const o of objs) {
    mix(o.objectId);
    mix(o.flags);
    mix(o.nodeStart);
    mix(o.nodeCount);
    mix(o.beamStart);
    mix(o.beamCount);
    for (let k = 0; k < o.actions.length; k++) word(o.actions[k]!);
  }
  const s = eng.state;
  for (let i = 0; i < s.nodeCount; i++) {
    word(s.posX[i]!);
    word(s.posY[i]!);
    word(s.posZ[i]!);
    word(s.velX[i]!);
    word(s.velY[i]!);
    word(s.velZ[i]!);
  }
  for (let b = 0; b < s.beamCount; b++) {
    word(s.restLen[b]!);
    word(s.k[b]!);
    mix(s.active[b]!);
  }
  const tr = eng.traffic;
  if (tr) {
    for (const a of tr.agents) {
      if (!a.alive) continue;
      mix(a.index);
      mix(a.plan[0]!);
      word(a.s);
      word(a.v);
      mix(a.awake ? 1 : 0);
      mix(a.variant | (a.paint << 8));
    }
  }
  // R-PHYS2: vehicle water (compartment water, hydrolock), joints (broken / force-free state), soft ground ruts.
  for (const o of objs) {
    const w = eng.getVehicle(o.objectId)?.water;
    if (!w) continue;
    mix(w.hydrolocked);
    for (const c of w.comps) word(c.water);
  }
  const js = eng.towing.joints.joints;
  mix(js.length);
  for (const j of js) {
    mix(j.objA.objectId);
    mix(j.objB.objectId);
    mix(j.broken ? 1 : 0);
  }
  mix(eng.towing.cargo.size);
  const sg = eng.softGround;
  mix(sg.tileCount);
  const dv = new Uint32Array(sg.depth.buffer, sg.depth.byteOffset, sg.depth.length);
  for (let t = 0; t < sg.tileCount; t++) {
    mix(sg.tileX[t]!);
    mix(sg.tileZ[t]!);
    const base = t * SOFT_TILE * SOFT_TILE;
    for (let k = 0; k < SOFT_TILE * SOFT_TILE; k++) {
      const d = dv[base + k]!;
      if (d !== 0) {
        mix(k);
        mix(d);
      }
    }
  }
  return h >>> 0;
}
