/**
 * A4 damage: strain ratchet (zero at rest, monotonic, persistence filter,
 * repair), detach at exactly the boundary rule, glass crack/shatter, scuff
 * deposits, node flags / block B, allocation-free update, GLSL injection.
 */
import { ShaderLib } from 'three';
import { describe, expect, it } from 'vitest';

import { compileRig } from '../../sim/rig/builder';
import { softCube } from '../../sim/rig/testrigs';
import type { CompiledRig, RigDef } from '../../sim/rig/types';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import { bindPanels } from './binder';
import { syntheticCubeSubject } from './synthetic';
import {
  applyDamageGlsl,
  boundaryAttachBeams,
  createVehicleDamage,
  ELASTIC_ALLOWANCE,
  elasticSlack,
  strainBeamSet,
  type VehicleDamageImpl,
} from './damage';
import {
  DAMAGE_DEFAULTS,
  FLEX_TRIADS,
  NODE_TEX_FLAG_BROKEN,
  NODE_TEX_FLAG_DETACHED,
  NODE_TEX_WIDTH,
  type BindingPanel,
  type BindingSet,
  type DamageFx,
  type FlexSkin,
  type VehicleFrameInput,
  type VehicleVisualDef,
} from './types';

// ---------------------------------------------------------------- fixture
/** 3×3×3 soft cube (27 nodes). Node (x,y,z) index = y·9 + z·3 + x. Tiny deform force: no elastic allowance. */
const RIG = compileRig(softCube({ seg: 2, deform: 1 }));
const idx = (x: number, y: number, z: number): number => y * 9 + z * 3 + x;
const TOP = Array.from({ length: 9 }, (_, k) => 18 + k); // y = 2 layer
const FRONT = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => idx(x, y, 2))).sort((a, b) => a - b); // z = 2 face

function vehicleOf(rig: CompiledRig, bodyNodeCount = rig.nodeCount): CompiledVehicle {
  return { name: rig.name, rig, bodyNodeCount, bodyBeamCount: rig.beamCount } as unknown as CompiledVehicle;
}

function beamsWithin(rig: CompiledRig, set: readonly number[]): Int32Array {
  const s = new Set(set);
  const out: number[] = [];
  for (let b = 0; b < rig.beamCount; b++) if (s.has(rig.beamA[b]!) && s.has(rig.beamB[b]!)) out.push(b);
  return Int32Array.from(out);
}

function panel(
  rig: CompiledRig,
  panelIndex: number,
  id: string,
  nodes: readonly number[],
  extra: Partial<BindingPanel>,
): BindingPanel {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const n of nodes) {
    cx += rig.nodePos[n * 3]!;
    cy += rig.nodePos[n * 3 + 1]!;
    cz += rig.nodePos[n * 3 + 2]!;
  }
  cx /= nodes.length;
  cy /= nodes.length;
  cz /= nodes.length;
  const u16 = Uint16Array.from(nodes);
  return {
    panelId: id,
    panelIndex,
    kind: 'body',
    material: 'paint',
    vertexCount: 1,
    restPosition: new Float32Array([cx, cy, cz]),
    restNormal: new Float32Array([0, 0, 1]),
    restTangent: null,
    uv: new Float32Array(2),
    index: new Uint32Array(0),
    triad: new Uint16Array(3 * FLEX_TRIADS),
    coef: new Float32Array(4 * FLEX_TRIADS),
    weight: new Float32Array([1, 0, 0]),
    frameNormal: new Float32Array(3 * FLEX_TRIADS),
    frameTangent: null,
    damageWeight: new Float32Array([1]),
    nodes: u16,
    bindNodes: u16,
    restCenter: [cx, cy, cz],
    restRadius: 1.1,
    detach: null,
    glass: null,
    lights: [],
    castShadow: true,
    ...extra,
  };
}

interface Fixture {
  rig: CompiledRig;
  dmg: VehicleDamageImpl;
  skin: FlexSkin & { visible: boolean[] };
  frame: VehicleFrameInput;
  binding: BindingSet;
  fx: DamageFx[];
  /** Write object-local node i (world = rest + offset). */
  set(i: number, x: number, y: number, z: number): void;
  restPose(): void;
  step(n?: number): void;
}

const NODE_OFFSET = 4; // another object's nodes come first in the global array

function fixture(
  opts: { laminated?: boolean; minBrokenFraction?: number; mode?: 'follow' | 'hide'; bodyNodeCount?: number; rig?: CompiledRig } = {},
): Fixture {
  const rig = opts.rig ?? RIG;
  const lidAttach = boundaryAttachBeams(rig, TOP);
  const panels: BindingPanel[] = [
    panel(rig, 0, 'shell', Array.from({ length: 18 }, (_, k) => k), {}),
    panel(rig, 1, 'lid', TOP, {
      kind: 'hood',
      detach: { attachBeams: lidAttach, minBrokenFraction: opts.minBrokenFraction ?? 0.5, mode: opts.mode ?? 'follow' },
    }),
    panel(rig, 2, 'pane', FRONT, {
      kind: 'glass',
      material: 'glass',
      damageWeight: new Float32Array([0]),
      glass: {
        laminated: opts.laminated ?? false,
        beams: beamsWithin(rig, FRONT),
        crackStrain: 0.02,
        shatterStrain: 0.08,
        crackImpulse: 50,
        shatterImpulse: 400,
        shatterBrokenFraction: 0.3,
      },
    }),
  ];
  const binding: BindingSet = {
    vehicle: rig.name,
    nodeCount: rig.nodeCount,
    rigHash: 0,
    panels,
    stats: { vertices: 0, triangles: 0, repaired: 0, welded: 0, maxAbsC: 0, minAngleDeg: 0, poolTriads: 0, meanTriads: 0 },
  };
  const compiled = vehicleOf(rig, opts.bodyNodeCount);
  const dmg = createVehicleDamage(compiled, binding, {} as VehicleVisualDef);
  const rows = Math.ceil(rig.nodeCount / NODE_TEX_WIDTH);
  const visible = panels.map(() => true);
  const skin = {
    rows,
    nodeData: new Float32Array(rows * 2 * NODE_TEX_WIDTH * 4),
    nodeFlags: new Uint8Array(rig.nodeCount),
    visible,
    setPanelVisible(i: number, v: boolean) {
      visible[i] = v;
    },
  } as unknown as FlexSkin & { visible: boolean[] };
  const nodes = new Float32Array((NODE_OFFSET + rig.nodeCount) * 3);
  const frame: VehicleFrameInput = {
    nodes,
    nodeOffset: NODE_OFFSET,
    tick: 0,
    broken: new Uint8Array(rig.beamCount),
    repairEpoch: 0,
    telemetry: null,
    dtS: 1 / 60,
  };
  const fx: DamageFx[] = [];
  dmg.onFx = (e) => fx.push(structuredClone(e));
  const OX = 700;
  const OY = 12;
  const OZ = -300;
  const set = (i: number, x: number, y: number, z: number): void => {
    const o = (NODE_OFFSET + i) * 3;
    nodes[o] = x + OX;
    nodes[o + 1] = y + OY;
    nodes[o + 2] = z + OZ;
  };
  const restPose = (): void => {
    for (let i = 0; i < rig.nodeCount; i++) set(i, rig.nodePos[i * 3]!, rig.nodePos[i * 3 + 1]!, rig.nodePos[i * 3 + 2]!);
  };
  restPose();
  const step = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      frame.tick += 16;
      dmg.update(frame, skin);
    }
  };
  return { rig, dmg, skin, frame, binding, fx, set, restPose, step };
}

const max = (a: ArrayLike<number>): number => {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]!);
  return m;
};

/** Scale the top layer's y offset from the middle layer (stretches vertical beams by `f`). */
function stretchTop(f: Fixture, factor: number): void {
  f.restPose();
  for (const i of TOP) {
    const y0 = f.rig.nodePos[i * 3 + 1]!;
    f.set(i, f.rig.nodePos[i * 3]!, (y0 - 0) * factor + 0, f.rig.nodePos[i * 3 + 2]!);
  }
}

// ---------------------------------------------------------------- strain
describe('plastic strain estimate', () => {
  it('is zero at rest and under rigid motion (rotation + far translation)', () => {
    const f = fixture();
    f.step(10);
    expect(max(f.dmg.strain)).toBe(0);
    // rotate the whole cube 40° about a tilted axis
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    for (let i = 0; i < f.rig.nodeCount; i++) {
      const x = f.rig.nodePos[i * 3]!;
      const y = f.rig.nodePos[i * 3 + 1]!;
      const z = f.rig.nodePos[i * 3 + 2]!;
      f.set(i, c * x + s * z, y, -s * x + c * z);
    }
    f.step(10);
    expect(max(f.dmg.strain)).toBe(0);
    expect(strainBeamSet(vehicleOf(f.rig)).length).toBe(f.rig.beamCount);
  });

  it('elastic loads inside the deadzone never register', () => {
    const f = fixture();
    stretchTop(f, 1 + DAMAGE_DEFAULTS.strainDeadzone * 0.9);
    f.step(20);
    expect(max(f.dmg.strain)).toBe(0);
  });

  it('allows ELASTIC_ALLOWANCE × yield strain before registering (soft lattices carry static strain)', () => {
    const rig = compileRig(softCube({ seg: 2 })); // deform = 0.15·k·h → εy 15 % (edges), 10.6 % (diagonals)
    const slack = elasticSlack(rig, strainBeamSet(vehicleOf(rig)));
    expect(slack[0]).toBeCloseTo(ELASTIC_ALLOWANCE * 0.15, 3);
    const f = fixture({ rig });
    stretchTop(f, 1.08); // 8 % < 0.6 · 15 %
    f.step(10);
    expect(max(f.dmg.strain)).toBe(0);
    stretchTop(f, 1.2); // 20 % − 9 % = 11 % ≥ strainFull
    f.step(10);
    expect(f.dmg.strain[TOP[4]!]).toBe(1);
  });

  it('drops transients shorter than strainPersist snapshots', () => {
    const f = fixture();
    f.step(4);
    stretchTop(f, 1.2);
    f.step(DAMAGE_DEFAULTS.strainPersist - 1);
    f.restPose();
    f.step(10);
    expect(max(f.dmg.strain)).toBe(0);
  });

  it('is monotonic (ratchet) and keeps its peak after the load is gone', () => {
    const f = fixture();
    f.step(4);
    let prev = 0;
    const seq = [1.02, 1.04, 1.03, 1.06, 1.01, 1.05, 1.1, 1.0];
    const peaks: number[] = [];
    for (const k of seq) {
      stretchTop(f, k);
      f.step(DAMAGE_DEFAULTS.strainPersist + 1);
      const m = f.dmg.strain[TOP[4]!]!;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
      peaks.push(m);
    }
    expect(peaks[0]).toBeGreaterThan(0);
    expect(peaks.at(-1)).toBe(1); // 1.1 → 10 % ≥ strainFull 8 %
    // remap: e = (6 % − 1 %) / (8 % − 1 %) for the y-beam stretch at 1.06 (vertical beams of the top layer: 1.06·0.75 − 0)
    const f2 = fixture();
    stretchTop(f2, 1.04);
    f2.step(10);
    const e = f2.dmg.strain[TOP[4]!]!;
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1);
    // nodes far from the stretched beams stay clean
    expect(f2.dmg.strain[idx(1, 0, 1)]).toBe(0);
  });

  it('a repair (epoch change) clears strain, scuff, flags, detach and glass; events queued with it are dropped', () => {
    const f = fixture();
    stretchTop(f, 1.2);
    f.step(6);
    f.frame.broken.fill(1);
    f.step(1);
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 1000 });
    f.step(1);
    expect(max(f.dmg.strain)).toBeGreaterThan(0);
    expect(max(f.dmg.scuff)).toBeGreaterThan(0);
    expect(f.dmg.panelState(1).detached).toBe(true);
    expect(f.dmg.panelState(2).shattered).toBe(true);
    expect(f.skin.visible[2]).toBe(false);

    f.frame.broken.fill(0);
    f.restPose();
    f.frame.repairEpoch = 1;
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 1000 });
    f.step(1);
    expect(max(f.dmg.strain)).toBe(0);
    expect(max(f.dmg.scuff)).toBe(0);
    expect(max(f.skin.nodeFlags)).toBe(0);
    expect(f.dmg.panelState(1).detached).toBe(false);
    expect(f.dmg.panelState(2)).toEqual({ detached: false, crack: 0, shattered: false });
    expect(f.skin.visible).toEqual([true, true, true]);
    expect(f.dmg.crackUniforms(2)!.uCrackA.value.w).toBe(0);
    f.step(10);
    expect(max(f.dmg.strain)).toBe(0);
  });
});

// ---------------------------------------------------------------- detach
describe('detach', () => {
  it("'boundary' = beams with exactly one endpoint in the bind set, minus support and unbreakable", () => {
    const def: RigDef = {
      name: 'b',
      nodes: [
        { id: 'a', pos: [0, 0, 0], mass: 1 },
        { id: 'b', pos: [1, 0, 0], mass: 1 },
        { id: 'c', pos: [0, 1, 0], mass: 1 },
        { id: 'd', pos: [1, 1, 0], mass: 1 },
      ],
      beams: [
        { a: 'a', b: 'b', type: 'normal' }, // inside
        { a: 'a', b: 'c', type: 'normal' }, // boundary
        { a: 'b', b: 'd', type: 'support' }, // boundary but support
        { a: 'b', b: 'c', type: 'normal', breakF: 0 }, // boundary but unbreakable
        { a: 'c', b: 'd', type: 'normal' }, // outside
        { a: 'd', b: 'a', type: 'bounded' }, // boundary
      ],
    };
    const rig = compileRig(def);
    expect(Array.from(boundaryAttachBeams(rig, [0, 1]))).toEqual([1, 5]);
    // cube lid: every boundary beam has exactly one endpoint on the top layer
    const lid = boundaryAttachBeams(RIG, TOP);
    expect(lid.length).toBeGreaterThan(0);
    for (const b of lid) expect(TOP.includes(RIG.beamA[b]!) !== TOP.includes(RIG.beamB[b]!)).toBe(true);
  });

  it("matches the binder's resolved attach set ('boundary' on the synthetic lid)", () => {
    const sub = syntheticCubeSubject(6);
    const binding = bindPanels(sub.compiled, sub.def, sub.geoms);
    const lid = binding.panels.find((p) => p.panelId === 'lid')!;
    expect(Array.from(lid.detach!.attachBeams)).toEqual(Array.from(boundaryAttachBeams(sub.compiled.rig, lid.bindNodes)));
  });

  it('fires exactly when broken/|attach| reaches minBrokenFraction, sticky, sets DETACHED flags', () => {
    for (const frac of [0.25, 0.5, 1]) {
      const f = fixture({ minBrokenFraction: frac });
      const attach = f.binding.panels[1]!.detach!.attachBeams;
      const need = Math.ceil(frac * attach.length - 1e-9);
      f.step(2);
      for (let k = 0; k < attach.length; k++) {
        f.frame.broken[attach[k]!] = 1;
        f.step(1);
        expect(f.dmg.panelState(1).detached).toBe(k + 1 >= need);
      }
      expect(f.fx.filter((e) => e.type === 'panelDetach')).toHaveLength(1);
      // sticky: the bitset reading intact again does not re-attach
      f.frame.broken.fill(0);
      f.step(3);
      expect(f.dmg.panelState(1).detached).toBe(true);
      for (const n of TOP) expect(f.skin.nodeFlags[n]! & NODE_TEX_FLAG_DETACHED).toBe(NODE_TEX_FLAG_DETACHED);
      expect(f.skin.visible[1]).toBe(true); // follow: keeps skinning to its nodes
    }
  });

  it("'hide' panels disappear and emit their FX with the panel's world centroid", () => {
    const f = fixture({ minBrokenFraction: 1, mode: 'hide' });
    f.step(2);
    for (const b of f.binding.panels[1]!.detach!.attachBeams) f.frame.broken[b] = 1;
    f.step(1);
    expect(f.skin.visible[1]).toBe(false);
    const e = f.fx.find((x) => x.type === 'panelDetach')!;
    expect(e).toMatchObject({ type: 'panelDetach', panelIndex: 1, mode: 'hide' });
    if (e.type === 'panelDetach') expect(e.pos[1]).toBeCloseTo(12.75, 4);
  });

  it('an unconfirmed beamBreak event counts early, then expires once the sim is known to write the bitset', () => {
    const f = fixture();
    f.step(2);
    // the sim writes the bitset: some unrelated beam is broken
    f.frame.broken[0] = 1;
    f.step(1);
    const b = f.rig.beamCount - 1;
    expect([f.rig.beamA[b], f.rig.beamB[b]]).not.toContain(f.rig.beamA[0]);
    expect([f.rig.beamA[b], f.rig.beamB[b]]).not.toContain(f.rig.beamB[0]);
    f.dmg.onBeamBreak({ objectId: 1, beamIndex: b, px: 700, py: 12, pz: -300 });
    f.step(1);
    expect(f.dmg.broken[b]).toBe(1);
    expect(f.skin.nodeFlags[f.rig.beamA[b]!]! & NODE_TEX_FLAG_BROKEN).toBe(0); // flags refresh at snapshot rate
    f.step(1);
    expect(f.skin.nodeFlags[f.rig.beamA[b]!]! & NODE_TEX_FLAG_BROKEN).toBe(NODE_TEX_FLAG_BROKEN);
    f.step(6);
    expect(f.dmg.broken[b]).toBe(0);
    expect(f.fx.some((e) => e.type === 'beamBreak' && e.beamIndex === b)).toBe(true);
  });
});

// ---------------------------------------------------------------- glass / scuff / texture
describe('glass', () => {
  const hit = (f: Fixture, impulse: number, x = 0, y = 0, z = 0.75): void => {
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700 + x, py: 12 + y, pz: -300 + z, nx: 0, ny: 0, nz: 1, impulse });
    f.step(1);
  };

  it('cracks by impulse (centre in rest space), grows, and tempered panes shatter + hide', () => {
    const f = fixture();
    f.step(4);
    hit(f, 20);
    expect(f.dmg.panelState(2).crack).toBe(0);
    hit(f, 60, 0.3, 0.3);
    const c1 = f.dmg.panelState(2).crack;
    expect(c1).toBeGreaterThan(0.29);
    const A = f.dmg.crackUniforms(2)!.uCrackA.value;
    expect(A.z).toBeCloseTo(0.75, 2);
    expect(A.x).toBeGreaterThan(0.2);
    expect(A.y).toBeGreaterThan(0.2);
    hit(f, 60, 0.3, 0.3);
    expect(f.dmg.panelState(2).crack).toBeGreaterThan(c1);
    hit(f, 80, -0.5, -0.5);
    expect(f.dmg.crackUniforms(2)!.uCrackB.value.w).toBeGreaterThan(0); // second centre
    expect(f.skin.visible[2]).toBe(true);
    hit(f, 500);
    expect(f.dmg.panelState(2).shattered).toBe(true);
    expect(f.skin.visible[2]).toBe(false);
    const s = f.fx.find((e) => e.type === 'glassShatter');
    expect(s).toMatchObject({ panelIndex: 2, laminated: false });
    if (s?.type === 'glassShatter') expect(s.normal[2]).toBeGreaterThan(0.9); // outward (+z face)
    // block B .z carries the crack level on the pane's nodes
    const baseB = f.skin.rows * NODE_TEX_WIDTH * 4;
    expect(f.skin.nodeData[baseB + FRONT[0]! * 4 + 2]).toBeGreaterThan(0);
  });

  it('laminated panes never disappear; shatter → crack 1', () => {
    const f = fixture({ laminated: true });
    f.step(4);
    hit(f, 1000);
    expect(f.dmg.panelState(2)).toMatchObject({ shattered: true, crack: 1 });
    expect(f.skin.visible[2]).toBe(true);
  });

  it('cracks by strain and shatters by broken fraction', () => {
    const f = fixture();
    f.step(4);
    // shear the front face slightly: ~4 % strain in its beams
    for (const i of FRONT) {
      const x = f.rig.nodePos[i * 3]!;
      const y = f.rig.nodePos[i * 3 + 1]!;
      f.set(i, x * 1.04, y, f.rig.nodePos[i * 3 + 2]!);
    }
    f.step(1);
    expect(f.dmg.panelState(2).crack).toBeGreaterThan(0.3);
    expect(f.dmg.panelState(2).shattered).toBe(false);
    const gb = f.binding.panels[2]!.glass!.beams;
    const need = Math.ceil(0.3 * gb.length);
    for (let k = 0; k < need; k++) f.frame.broken[gb[k]!] = 1;
    f.step(1);
    expect(f.dmg.panelState(2).shattered).toBe(true);
  });
});

describe('scuff + node texture', () => {
  it('deposits impulse/scuffFullImpulse with a smooth falloff over scuffRadius', () => {
    const f = fixture();
    f.step(2);
    const n = idx(1, 2, 1); // top centre
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 150 });
    f.step(1);
    expect(f.dmg.scuff[n]).toBeCloseTo(150 / DAMAGE_DEFAULTS.scuffFullImpulse, 5);
    expect(f.dmg.scuff[idx(0, 2, 1)]).toBe(0); // 0.75 m away > 0.35 m
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700.2, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 300 });
    f.step(1);
    expect(f.dmg.scuff[n]).toBeGreaterThan(0.5);
    expect(f.dmg.scuff[n]).toBeLessThanOrEqual(1);
    const baseB = f.skin.rows * NODE_TEX_WIDTH * 4;
    expect(f.skin.nodeData[baseB + n * 4 + 1]).toBeCloseTo(f.dmg.scuff[n]!, 6);
  });

  it('a late (stale) impact re-centres on the nearest body node within SCUFF_SNAP, else is dropped', () => {
    const f = fixture();
    f.step(2);
    const n = idx(1, 2, 1);
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 13.35, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 90 });
    f.step(1);
    expect(f.dmg.scuff[n]).toBeCloseTo(0.3, 4);
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 14.0, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 90 });
    f.step(1);
    expect(f.dmg.scuff[n]).toBeCloseTo(0.3, 4);
    expect(f.dmg.stats.missed).toBe(1);
  });

  it('skids and impacts at tyre (wheel) nodes do not scuff the body', () => {
    const f = fixture({ bodyNodeCount: 18 }); // top layer plays the wheels
    f.step(2);
    f.dmg.onSkid({ objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, slip: 8, load: 4000 });
    f.dmg.onImpact({ objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 300 });
    f.step(1);
    expect(max(f.dmg.scuff)).toBe(0);
    f.dmg.onSkid({ objectId: 1, materialId: 0, px: 700, py: 11.25, pz: -300, slip: 8, load: 4000 }); // underside scrape
    f.step(1);
    expect(f.dmg.scuff[idx(1, 0, 1)]).toBeGreaterThan(0);
  });

  it('broken beams flag both endpoints; block B layout = (strain, scuff, crack, 0) at row + rows', () => {
    const f = fixture();
    f.step(2);
    const b = 7;
    f.frame.broken[b] = 1;
    stretchTop(f, 1.2);
    f.step(5);
    expect(f.skin.nodeFlags[f.rig.beamA[b]!]! & NODE_TEX_FLAG_BROKEN).toBe(NODE_TEX_FLAG_BROKEN);
    expect(f.skin.nodeFlags[f.rig.beamB[b]!]! & NODE_TEX_FLAG_BROKEN).toBe(NODE_TEX_FLAG_BROKEN);
    const baseB = f.skin.rows * NODE_TEX_WIDTH * 4;
    for (let i = 0; i < f.rig.nodeCount; i++) {
      expect(f.skin.nodeData[baseB + i * 4]).toBe(f.dmg.strain[i]);
      expect(f.skin.nodeData[baseB + i * 4 + 3]).toBe(0);
      expect(f.skin.nodeData[i * 4]).toBe(0); // block A untouched
    }
  });
});

// ---------------------------------------------------------------- allocation
describe('update is allocation-free', () => {
  it('runs 50k snapshot-rate updates (with impacts and skids) allocating < 4 bytes per call', async () => {
    const proc = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process;
    const f = fixture();
    stretchTop(f, 1.03);
    const imp = { objectId: 1, materialId: 0, px: 700, py: 12.75, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 1 };
    const far = { objectId: 1, materialId: 0, px: 700, py: 13.3, pz: -300, nx: 0, ny: 1, nz: 0, impulse: 1 };
    const sk = { objectId: 1, materialId: 0, px: 700, py: 11.25, pz: -300, slip: 3, load: 100 };
    const run = (n: number): void => {
      for (let k = 0; k < n; k++) {
        f.dmg.onImpact(imp);
        f.dmg.onImpact(far); // re-centred deposit
        f.dmg.onSkid(sk);
        f.frame.tick += 16;
        f.dmg.update(f.frame, f.skin);
        f.dmg.panelState(k % 3);
      }
    };
    run(20000); // warm up / JIT
    let gcs = 0;
    const obs = new PerformanceObserver((list) => {
      gcs += list.getEntries().length;
    });
    obs.observe({ entryTypes: ['gc'] });
    // A GC during the window invalidates heapUsed deltas: retry (allocation-free code never triggers one)
    let measured = -1;
    for (let attempt = 0; attempt < 4 && measured < 0; attempt++) {
      await new Promise((r) => setTimeout(r, 20));
      gcs = 0;
      const before = proc.memoryUsage().heapUsed;
      run(50000);
      const after = proc.memoryUsage().heapUsed;
      await new Promise((r) => setTimeout(r, 20));
      if (gcs === 0) measured = after - before;
    }
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(measured).toBeLessThan(200_000);
    // control: the probe does see a loop that allocates (retained objects, ~32 B each)
    const keep: { k: number }[] = [];
    const before = proc.memoryUsage().heapUsed;
    gcs = 0;
    for (let k = 0; k < 50000; k++) keep.push({ k });
    const delta = proc.memoryUsage().heapUsed - before;
    await new Promise((r) => setTimeout(r, 20));
    obs.disconnect();
    expect(keep.length).toBe(50000);
    expect(gcs > 0 || delta > 800_000).toBe(true);
  });
});

// ---------------------------------------------------------------- GLSL
describe('dmg1 shader patch', () => {
  it('injects into the physical fragment shader per variant', () => {
    const fs = ShaderLib.physical.fragmentShader;
    const paint = applyDamageGlsl(fs, 'paint');
    expect(paint).toContain('float dmgNoise(vec3 x)');
    expect(paint).toContain('dmgCoatKill');
    expect(paint.indexOf('normal = dmgBump')).toBeLessThan(paint.indexOf('#include <clearcoat_normal_fragment_begin>'));
    expect(paint.indexOf('clearcoatNormal = dmgBump')).toBeGreaterThan(paint.indexOf('#include <clearcoat_normal_fragment_maps>'));
    expect(paint).not.toContain('dmgCrackWeb');
    const glass = applyDamageGlsl(fs, 'glass');
    expect(glass).toContain('dmgCrackWeb');
    expect(glass).toContain('material.transmission = transmission * (1.0 - dmgCrackM);');
    expect(glass).not.toContain('#include <transmission_fragment>');
    // non-standard shaders are left untouched
    expect(applyDamageGlsl(ShaderLib.basic.fragmentShader, 'paint')).toBe(ShaderLib.basic.fragmentShader);
  });

  it('patchFor: paint / glass variants, null for undamageable panels; key dmg1', () => {
    const f = fixture();
    expect(f.dmg.patchFor(0)!.key).toBe('dmg1:paint');
    expect(f.dmg.patchFor(2)!.key).toBe('dmg1:glass');
    expect(f.dmg.patchFor(0)!.targets).toEqual(['color']);
    const shader = { uniforms: {} as Record<string, unknown>, fragmentShader: ShaderLib.physical.fragmentShader };
    f.dmg.patchFor(2)!.apply(shader as never, 'color', null as never);
    expect(shader.uniforms.uCrackA).toBe(f.dmg.crackUniforms(2)!.uCrackA);
  });
});
