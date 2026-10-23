import { describe, expect, it } from 'vitest';
import { MaterialId } from '../../protocol/messages';
import { createTerrainSampler } from '../../world/sampler';
import { syntheticTerrain } from '../../world/sampler.testkit';
import { SimEngine } from '../engine';
import { computeRigStats, computeStabilityReport } from '../rig/builder';
import { RIG_NODE_FLAG_OBJ_CONTACT } from '../rig/types';
import { compilePropRig, PROP_CATALOG, PROP_OMEGA_DT_LIMIT } from './catalog';
import { footprintHeight } from './placement';
import { PROP_KEYS, PROP_MIN_OBJ_RADIUS, PROP_RIG_BUDGET, type PropKey } from './types';

/** Nominal (realistic) masses, kg, of the free nodes. */
const NOMINAL_MASS: Record<PropKey, [number, number]> = {
  cone: [3.8, 4.3],
  barrel: [17, 19],
  tire: [8.5, 9.5],
  boxCardboard: [2.8, 3.2],
  boxWood: [24, 26],
  signPost: [14, 19],
  stopSign: [14, 19],
  mailbox: [10, 12],
  lightPole: [110, 140],
  concreteBlock: [990, 1010],
  // R-PHYS2
  barrelFull: [214, 222],
  waterBarrier: [430, 470],
  jerseyBarrier: [1750, 1850],
  hayBale: [300, 340],
  pallet: [24, 26],
  fencePanel: [45, 60],
  guardrail: [90, 130],
  guardrailEnd: [90, 130],
};

/** Props whose contact is a triangle face, not node spheres (no node has object contact). */
const FACE_CONTACT: readonly PropKey[] = ['guardrail', 'guardrailEnd'];

const PREFIXES: Record<PropKey, RegExp> = {
  cone: /^(base_\d|shell_\d_\d|tip)$/,
  barrel: /^(rim\d_\d+|lidT_c|lidB_c)$/,
  tire: /^t[IOT]_\d+$/,
  boxCardboard: /^[cf]_\d$/,
  boxWood: /^[cf]_\d$/,
  signPost: /^(anchor_\d|post_(\d_\d|s\d)|sign_(\d|c))$/,
  stopSign: /^(anchor_\d|post_(\d_\d|s\d)|sign_(\d|c))$/,
  mailbox: /^(anchor_\d|post_(\d_\d|s\d)|box_\d)$/,
  lightPole: /^(anchor_\d|pole_(\d_\d|s\d)|arm_\d_\d|lamp_\d)$/,
  concreteBlock: /^[cf]_\d$/,
  barrelFull: /^(rim\d_\d+|lidT_c|lidB_c)$/,
  waterBarrier: /^(s\d_(b|t)[LR]|end_\d|core)$/,
  jerseyBarrier: /^s\d_[bkt][LR]$/,
  hayBale: /^(r\d_\d|ax_\d|core)$/,
  pallet: /^[bt]\d\d$/,
  fencePanel: /^(anchor_\d|p\d_(\d_\d|c)|rail\d\d_\d|pk\d_[bt])$/,
  guardrail: /^(r[tb]\d+|rv\d+|p\d_\d|k\d[tb]|h\d[tb]|a\d_\d)$/,
  guardrailEnd: /^(r[tb]\d+|rv\d+|p\d_\d|k\d[tb]|h\d[tb]|a\d_\d|ea\d[tb])$/,
};

/** Spawns one prop (awake) on a flat plane and steps `seconds`; returns the engine. */
function settle(key: PropKey, seconds: number, ground?: (x: number, z: number) => number): SimEngine {
  const eng = new SimEngine({ gravity: [0, -9.81, 0], debugStrains: false });
  if (ground) {
    const terrain = syntheticTerrain({ cols: 41, rows: 41, spacing: 1, height: ground, material: () => MaterialId.asphalt });
    eng.setGroundTerrain(terrain);
  } else {
    eng.setGroundPlane(0, MaterialId.asphalt);
  }
  const sampler = ground ? createTerrainSampler(syntheticTerrain({ cols: 41, rows: 41, spacing: 1, height: ground })) : null;
  const y = sampler ? footprintHeight(PROP_CATALOG[key], 0, 0, [0, 0, 0, 1], (x, z) => sampler.heightAt(x, z)) : 0;
  eng.spawnProp(4096, key, { pos: [0, y, 0], quat: [0, 0, 0, 1] }, false);
  const steps = Math.round(seconds * 2000);
  for (let i = 0; i < steps; i++) eng.step();
  return eng;
}

function maxSpeed(eng: SimEngine): number {
  const s = eng.state;
  let v = 0;
  for (let i = 0; i < s.nodeCount; i++) v = Math.max(v, Math.hypot(s.velX[i]!, s.velY[i]!, s.velZ[i]!));
  return v;
}

describe('prop catalog', () => {
  it('has every key, matching rig names, frames and node-id prefixes', () => {
    for (const key of PROP_KEYS) {
      const d = PROP_CATALOG[key];
      expect(d.key).toBe(key);
      expect(d.rig.name).toBe(key);
      const ids = new Set(d.rig.nodes.map((n) => n.id));
      for (const f of [d.frame.origin, d.frame.front, d.frame.top]) expect(ids.has(f), `${key} frame ${f}`).toBe(true);
      for (const n of d.rig.nodes) expect(n.id, key).toMatch(PREFIXES[key]);
    }
  });

  it('frames: forward = front − origin is exactly −Z, top is above', () => {
    for (const key of PROP_KEYS) {
      const d = PROP_CATALOG[key];
      const p = (id: string) => d.rig.nodes.find((n) => n.id === id)!.pos;
      const o = p(d.frame.origin);
      const f = p(d.frame.front);
      const t = p(d.frame.top);
      expect(Math.abs(f[0] - o[0]), key).toBeLessThan(1e-9);
      expect(Math.abs(f[1] - o[1]), key).toBeLessThan(1e-9);
      expect(f[2] - o[2], key).toBeLessThan(-0.05);
      // (a flat pallet is 0.144 m thick: its top face is the up reference)
      expect(t[1] - o[1], key).toBeGreaterThan(key === 'pallet' ? 0.04 : 0.1);
    }
  });

  it('stays inside the per-key node/beam budgets with realistic masses', () => {
    for (const key of PROP_KEYS) {
      const c = compilePropRig(key);
      const st = computeRigStats(c);
      expect(c.nodeCount, key).toBeLessThanOrEqual(PROP_RIG_BUDGET[key].nodes);
      expect(c.beamCount, key).toBeLessThanOrEqual(PROP_RIG_BUDGET[key].beams);
      const [lo, hi] = NOMINAL_MASS[key];
      expect(st.totalMass, key).toBeGreaterThanOrEqual(lo);
      expect(st.totalMass, key).toBeLessThanOrEqual(hi);
    }
  });

  it('is stable per node: ω·dt ≤ PROP_OMEGA_DT_LIMIT, (Σd/m)·dt ≤ 1, no MINIMASS drift', () => {
    for (const key of PROP_KEYS) {
      const rep = computeStabilityReport(compilePropRig(key), { limit: PROP_OMEGA_DT_LIMIT });
      expect(rep.ok, `${key}: ${JSON.stringify(rep.worst[0])}`).toBe(true);
      expect(rep.massDriftPct, key).toBe(0);
      // (the hay bale is soft by design: its stiffness is solved well below the budget)
      expect(rep.worst[0]!.omegaDt, key).toBeGreaterThan(key === 'hayBale' ? 0.1 : 0.3);
    }
  });

  it('rests the base on y = 0, contact radii ≥ PROP_MIN_OBJ_RADIUS, proxy encloses every node sphere', () => {
    for (const key of PROP_KEYS) {
      const d = PROP_CATALOG[key];
      const c = compilePropRig(key);
      let minBase = Infinity;
      for (let i = 0; i < c.nodeCount; i++) {
        if (c.nodeInvMass[i] === 0) {
          expect(c.nodeFlags[i]! & RIG_NODE_FLAG_OBJ_CONTACT, `${key} anchor objContact`).toBe(0);
          continue;
        }
        // The guardrail is contacted through its rail FACE (props/railContact.ts), not node spheres.
        if (FACE_CONTACT.includes(key)) expect(c.nodeFlags[i]! & RIG_NODE_FLAG_OBJ_CONTACT, key).toBe(0);
        else {
          expect(c.nodeFlags[i]! & RIG_NODE_FLAG_OBJ_CONTACT, key).not.toBe(0);
          expect(c.nodeObjRadius[i]!, key).toBeGreaterThanOrEqual(PROP_MIN_OBJ_RADIUS);
        }
        const y = c.nodePos[3 * i + 1]!;
        minBase = Math.min(minBase, y - c.nodeRadius[i]!);
        const r = Math.max(c.nodeRadius[i]!, c.nodeObjRadius[i]!);
        for (let a = 0; a < 3; a++) {
          const p = c.nodePos[3 * i + a]!;
          expect(p - r, `${key} proxy lo ${a}`).toBeGreaterThanOrEqual(d.proxy.center[a]! - d.proxy.halfExtents[a]! - 1e-6);
          expect(p + r, `${key} proxy hi ${a}`).toBeLessThanOrEqual(d.proxy.center[a]! + d.proxy.halfExtents[a]! + 1e-6);
        }
      }
      expect(Math.abs(minBase), key).toBeLessThan(1e-9);
      if (d.anchor) {
        const pinned = d.rig.nodes.filter((n) => n.mass <= 0);
        expect(pinned.length, key).toBeGreaterThanOrEqual(3);
        for (const n of pinned) expect(n.collidable, key).toBe(false);
      }
      if (d.stackHeight > 0) {
        // Stack pitch = top of the contact surface: highest node + its radius.
        let top = -Infinity;
        for (let i = 0; i < c.nodeCount; i++) top = Math.max(top, c.nodePos[3 * i + 1]! + c.nodeObjRadius[i]!);
        expect(top, `${key} stack pitch`).toBeCloseTo(d.stackHeight, 9);
      }
    }
  });

  it.each(PROP_KEYS.map((k) => [k]))('%s comes to rest on flat ground (≤ 1 mm/s after 3.5 s, no sag)', (key) => {
    const eng = settle(key as PropKey, 3.5);
    expect(maxSpeed(eng), key).toBeLessThanOrEqual(1e-3);
    const c = compilePropRig(key as PropKey);
    const s = eng.state;
    let maxDev = 0;
    let minY = Infinity;
    for (let i = 0; i < c.nodeCount; i++) {
      maxDev = Math.max(maxDev, Math.hypot(s.posX[i]! - c.nodePos[3 * i]!, s.posY[i]! - c.nodePos[3 * i + 1]!, s.posZ[i]! - c.nodePos[3 * i + 2]!));
      // (pinned anchors are non-collidable: a post's soil anchors sit below ground by design)
      if (c.nodeInvMass[i] !== 0) minY = Math.min(minY, s.posY[i]! - s.radius[i]!);
    }
    // Settled shape within a few cm of the rest pose (elastic sag + contact penetration).
    expect(maxDev, key).toBeLessThan(key === 'lightPole' ? 0.08 : 0.025);
    expect(minY, key).toBeGreaterThan(-0.01);
    for (let b = 0; b < s.beamCount; b++) expect(s.active[b], `${key} beam ${b}`).toBe(1);
  });

  it.each(PROP_KEYS.map((k) => [k]))('%s rests on a 6 % heightfield slope without creeping', (key) => {
    const slope = (x: number, z: number) => 10 + 0.06 * x + 0.02 * z;
    const eng = settle(key as PropKey, 3.5, slope);
    expect(maxSpeed(eng), key).toBeLessThanOrEqual(1e-3);
  });
});
