import { describe, expect, it } from 'vitest';
import {
  compileRig,
  computeRigStats,
  computeStabilityReport,
  suggestMinimumMasses,
  withMasses,
} from './builder';
import { beamPendulum, softCube, wreckingBall } from './testrigs';
import { RIG_BEAM_TYPE_ID, RIG_DEFAULTS, RIG_NODE_FLAG_COLLIDABLE, type RigDef } from './types';

function tri(): RigDef {
  return {
    name: 'tri',
    nodes: [
      { id: 'z', pos: [0, 0, 0], mass: 1 },
      { id: 'a', pos: [1, 0, 0], mass: 2, group: 'g' },
      { id: 'm', pos: [0, 1, 0], mass: 0, group: 'g', friction: 0.9 },
    ],
    beams: [
      { a: 'm', b: 'z', type: 'normal' },
      { a: 'z', b: 'a', type: 'shock', k: 100, d: 5, deform: 0, breakF: -1, preload: 20, boundsLow: 0.2 },
      { a: 'a', b: 'm', type: 'hydro', hydroTravel: 0.1 },
    ],
    groupDefaults: { g: { friction: 2, radius: 0.2 } },
  };
}

describe('compileRig', () => {
  it('preserves declaration order exactly (never sorts ids)', () => {
    const c = compileRig(tri());
    expect(c.nodeIds).toEqual(['z', 'a', 'm']);
    expect(Array.from(c.nodePos)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(c.beamA)).toEqual([2, 0, 1]);
    expect(Array.from(c.beamB)).toEqual([0, 1, 2]);
    expect(Array.from(c.beamType)).toEqual([RIG_BEAM_TYPE_ID.normal, RIG_BEAM_TYPE_ID.shock, RIG_BEAM_TYPE_ID.hydro]);
    expect(c.beamRestLen[2]).toBeCloseTo(Math.SQRT2, 12);

    const cube = softCube();
    const cc = compileRig(cube);
    expect(cc.nodeIds).toEqual(cube.nodes.map((n) => n.id));
    cube.beams.forEach((b, i) => {
      expect(cc.nodeIds[cc.beamA[i]!]).toBe(b.a);
      expect(cc.nodeIds[cc.beamB[i]!]).toBe(b.b);
    });
  });

  it('resolves node value → group default → RIG_DEFAULTS, and pins mass <= 0', () => {
    const c = compileRig(tri());
    expect(Array.from(c.nodeFriction)).toEqual([RIG_DEFAULTS.friction, 2, 0.9]);
    expect(Array.from(c.nodeRadius)).toEqual([RIG_DEFAULTS.radius, 0.2, 0.2]);
    expect(c.groups).toEqual(['g']);
    expect(Array.from(c.nodeGroup)).toEqual([-1, 0, 0]);
    expect(Array.from(c.nodeMass)).toEqual([1, 2, 0]);
    expect(Array.from(c.nodeInvMass)).toEqual([1, 0.5, 0]);
    const neg = compileRig({ ...tri(), nodes: tri().nodes.map((n) => (n.id === 'z' ? { ...n, mass: -3 } : n)) });
    expect(neg.nodeMass[0]).toBe(0);
    expect(neg.nodeInvMass[0]).toBe(0);
    expect(Array.from(c.nodeFlags)).toEqual([RIG_NODE_FLAG_COLLIDABLE, RIG_NODE_FLAG_COLLIDABLE, RIG_NODE_FLAG_COLLIDABLE]);
    expect(compileRig(beamPendulum()).nodeFlags[0]).toBe(0);
  });

  it('applies beam defaults and maps deform/breakF <= 0 to Infinity', () => {
    const c = compileRig(tri());
    expect(c.beamK[0]).toBe(RIG_DEFAULTS.k);
    expect(c.beamD[0]).toBe(RIG_DEFAULTS.d);
    expect(c.beamDeform[0]).toBe(RIG_DEFAULTS.deform);
    expect(c.beamBreakF[0]).toBe(RIG_DEFAULTS.breakF);
    expect(c.beamBoundsLow[0]).toBe(RIG_DEFAULTS.boundsLow);
    expect(c.beamBoundsHigh[0]).toBe(RIG_DEFAULTS.boundsHigh);
    expect(c.beamK[1]).toBe(100);
    expect(c.beamD[1]).toBe(5);
    expect(c.beamDeform[1]).toBe(Infinity);
    expect(c.beamBreakF[1]).toBe(Infinity);
    expect(c.beamPreload[1]).toBe(20);
    expect(c.beamBoundsLow[1]).toBe(0.2);
    expect(c.beamHydroTravel[2]).toBe(0.1);
    expect(c.beamPreload[2]).toBe(0);
  });

  it('throws precise errors', () => {
    const base = tri();
    const bad = (patch: Partial<RigDef>): (() => void) => () => compileRig({ ...base, ...patch });
    expect(bad({ nodes: [...base.nodes, { id: 'a', pos: [5, 5, 5], mass: 1 }] })).toThrow(
      'compileRig("tri"): duplicate node id "a" at node[3] (first declared at node[1])',
    );
    expect(bad({ beams: [...base.beams, { a: 'z', b: 'nope', type: 'normal' }] })).toThrow(
      'compileRig("tri"): beam[3] (z-nope) references unknown node "nope" (endpoint b)',
    );
    expect(bad({ beams: [{ a: 'ghost', b: 'z', type: 'normal' }] })).toThrow(
      'compileRig("tri"): beam[0] (ghost-z) references unknown node "ghost" (endpoint a)',
    );
    expect(bad({ beams: [{ a: 'm', b: 'm', type: 'normal' }] })).toThrow(
      'compileRig("tri"): beam[0] (m-m) connects node "m" to itself',
    );
    expect(bad({ nodes: [{ id: 'z', pos: [0, NaN, 0], mass: 1 }] })).toThrow(
      'compileRig("tri"): node[0] "z" pos[1] must be a finite number (got NaN)',
    );
    expect(bad({ nodes: [{ id: 'z', pos: [0, 0, 0], mass: Infinity }], beams: [] })).toThrow(
      'compileRig("tri"): node[0] "z" mass must be a finite number (got Infinity)',
    );
    expect(bad({ beams: [{ a: 'z', b: 'a', type: 'normal', k: Infinity }] })).toThrow(
      'compileRig("tri"): beam[0] (z-a) k must be a finite number (got Infinity)',
    );
    expect(bad({ beams: [{ a: 'z', b: 'a', type: 'normal', breakF: NaN }] })).toThrow(
      'compileRig("tri"): beam[0] (z-a) breakF must be a finite number (got NaN)',
    );
    expect(bad({ beams: [{ a: 'z', b: 'a', type: 'normal', d: -1 }] })).toThrow(
      'compileRig("tri"): beam[0] (z-a) d must be >= 0 (got -1)',
    );
    expect(bad({ groupDefaults: { g: { radius: NaN } } })).toThrow(
      'compileRig("tri"): groupDefaults["g"] radius must be a finite number (got NaN)',
    );
    expect(bad({ beams: [{ a: 'z', b: 'a', type: 'spring' as never }] })).toThrow(
      'compileRig("tri"): beam[0] (z-a) has unknown type "spring"',
    );
    expect(
      bad({
        nodes: [...base.nodes, { id: 'twin', pos: [1, 0, 0], mass: 1 }],
        beams: [{ a: 'a', b: 'twin', type: 'normal' }],
      }),
    ).toThrow('compileRig("tri"): beam[0] (a-twin) has zero rest length (nodes "a" and "twin" coincide)');
  });
});

describe('stability', () => {
  it('computes ω·dt and damping ratio per node, pinned excluded', () => {
    const r = computeStabilityReport(beamPendulum());
    expect(r.dt).toBe(1 / 2000);
    expect(r.limit).toBe(0.35);
    expect(r.omegaDt[0]).toBe(0);
    expect(r.omegaDt[1]).toBeCloseTo(Math.sqrt(1e6 / 5) / 2000, 12);
    expect(r.dampDt[1]).toBeCloseTo((200 / 5) / 2000, 12);
    expect(r.suggestedMinMass[0]).toBe(0);
    expect(r.worst.map((w) => w.id)).toEqual(['bob']);
    expect(r.ok).toBe(true);
  });

  it('flags an unstable def and suggestMinimumMasses fixes it', () => {
    // Default RoR beams (k 9e6, d 12e3) on 1 kg nodes: ω·dt = sqrt(2·9e6)/2000 ≈ 2.1.
    const def: RigDef = {
      name: 'unstable',
      nodes: [
        { id: 'p', pos: [0, 0, 0], mass: 0 },
        { id: 'a', pos: [1, 0, 0], mass: 1 },
        { id: 'b', pos: [2, 0, 0], mass: 20 },
        { id: 'c', pos: [2, 1, 0], mass: 1000 },
      ],
      beams: [
        { a: 'p', b: 'a', type: 'normal' },
        { a: 'a', b: 'b', type: 'normal' },
        { a: 'b', b: 'c', type: 'normal' },
      ],
    };
    const r = computeStabilityReport(def);
    expect(r.ok).toBe(false);
    expect(r.violations).toBe(2);
    expect(r.worst[0]!.id).toBe('a');
    expect(r.worst[0]!.omegaDt).toBeCloseTo(Math.sqrt(1.8e7) / 2000, 9);
    expect(r.massDriftPct).toBeGreaterThan(0);

    const { masses, driftPct } = suggestMinimumMasses(def);
    expect(driftPct).toBeCloseTo(r.massDriftPct, 9);
    masses.forEach((m, i) => {
      const declared = def.nodes[i]!.mass;
      if (declared > 0) expect(m).toBeGreaterThanOrEqual(declared);
      else expect(m).toBe(declared);
    });
    expect(masses[3]).toBe(1000); // already stable: never lowered
    const fixed = computeStabilityReport(withMasses(def, masses));
    expect(fixed.ok).toBe(true);
    expect(fixed.violations).toBe(0);
    expect(fixed.massDriftPct).toBe(0);
    for (const w of fixed.omegaDt) expect(w).toBeLessThanOrEqual(0.35 + 1e-9);
    for (const z of fixed.dampDt) expect(z).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('honours a custom target', () => {
    const def = beamPendulum();
    const { masses } = suggestMinimumMasses(def, 0.1);
    expect(masses[1]).toBeCloseTo((1e6 / 2000 / 2000) / 0.01, 9);
    expect(computeStabilityReport(withMasses(def, masses), { limit: 0.1 }).ok).toBe(true);
  });
});

describe('testrigs', () => {
  it('softCube compiles with every node ≤ 0.35 ω·dt (worst ≈ 0.2)', () => {
    const def = softCube();
    const c = compileRig(def);
    expect(c.nodeCount).toBe(64);
    expect(c.beamCount).toBe(144 + 216 + 108);
    const r = computeStabilityReport(c);
    expect(r.ok).toBe(true);
    for (const w of r.omegaDt) expect(w).toBeLessThanOrEqual(0.35);
    expect(r.worst[0]!.omegaDt).toBeGreaterThan(0.18);
    expect(r.worst[0]!.omegaDt).toBeLessThan(0.22);
    const stats = computeRigStats(c);
    expect(stats.totalMass).toBeCloseTo(60, 9);
    expect(stats.boundsMin).toEqual([-0.75, -0.75, -0.75]);
    expect(stats.boundsMax).toEqual([0.75, 0.75, 0.75]);
    const b = def.beams[0]!;
    expect(b.breakF!).toBeGreaterThan(b.deform!);
  });

  it('softCube scales with options and stays stable', () => {
    const r = computeStabilityReport(softCube({ seg: 5, size: 2, totalMass: 200 }));
    expect(r.ok).toBe(true);
    expect(computeStabilityReport(softCube({ seg: 1 })).ok).toBe(true);
  });

  it('pendulum and wrecking ball are stable within the structural budget', () => {
    for (const def of [beamPendulum(), wreckingBall()]) {
      const r = computeStabilityReport(def);
      expect(r.ok, `${def.name}: ${JSON.stringify(r.worst[0])}`).toBe(true);
    }
    const wb = compileRig(wreckingBall());
    expect(wb.nodeMass[0]).toBe(0);
    expect(wb.nodeIds.filter((id) => /^c\d$/.test(id))).toHaveLength(8);
    expect(computeRigStats(wb).totalMass).toBeCloseTo(440, 6);
  });

  it('all rigs are JSON round-trippable and structuredClone-safe', () => {
    for (const def of [softCube(), beamPendulum(), wreckingBall()]) {
      const json = JSON.parse(JSON.stringify(def)) as RigDef;
      expect(json).toStrictEqual(def);
      expect(structuredClone(def)).toStrictEqual(def);
      const a = compileRig(def);
      const b = compileRig(json);
      expect(b).toStrictEqual(a);
      expect(structuredClone(a)).toStrictEqual(a);
    }
  });
});
