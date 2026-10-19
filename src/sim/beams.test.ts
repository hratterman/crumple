import { describe, expect, it } from 'vitest';
import {
  applyBeamForces,
  BOUND_STIFFNESS_RAMP,
  PLASTIC_COMPRESS_FLOOR,
  PLASTIC_K_FLOOR,
  PLASTIC_RATCHET,
  PLASTIC_WEAKEN,
} from './beams';
import { integrateNodes } from './integrator';
import beamsSrc from './beams.ts?raw';
import integratorSrc from './integrator.ts?raw';
import { createSimState } from './state';
import { BeamType, type EventSink, type SimState } from './types';

const DT = 1 / 2000;

interface BreakRec {
  beam: number;
  px: number;
  py: number;
  pz: number;
}

function recordingSink(): EventSink & { breaks: BreakRec[] } {
  const breaks: BreakRec[] = [];
  return {
    breaks,
    impact() {},
    skid() {},
    beamBreak(beam, px, py, pz) {
      breaks.push({ beam, px, py, pz });
    },
  };
}

interface BeamOpts {
  k?: number;
  d?: number;
  rest?: number;
  deform?: number;
  breakF?: number;
  type?: number;
  boundsLow?: number;
  boundsHigh?: number;
  preload?: number;
}

/** Two nodes on the x axis (a at 0, b at x) joined by one beam. massA <= 0 pins a. */
function pair(x: number, massA: number, massB: number, o: BeamOpts = {}): SimState {
  const s = createSimState(2, 1);
  s.nodeCount = 2;
  s.beamCount = 1;
  s.posX[1] = x;
  s.invMass[0] = massA > 0 ? 1 / massA : 0;
  s.invMass[1] = massB > 0 ? 1 / massB : 0;
  s.aIdx[0] = 0;
  s.bIdx[0] = 1;
  const k = o.k ?? 1e4;
  s.k[0] = k;
  s.k0[0] = k;
  s.d[0] = o.d ?? 0;
  s.restLen[0] = o.rest ?? 1;
  s.restLen0[0] = o.rest ?? 1;
  s.deform[0] = o.deform ?? Infinity;
  s.breakF[0] = o.breakF ?? Infinity;
  s.type[0] = o.type ?? BeamType.normal;
  s.boundsLow[0] = o.boundsLow ?? 0.1;
  s.boundsHigh[0] = o.boundsHigh ?? 0.1;
  s.preload[0] = o.preload ?? 0;
  s.active[0] = 1;
  return s;
}

function step(s: SimState, sink: EventSink, debug = false): void {
  applyBeamForces(s, 0, s.beamCount, sink, debug);
  integrateNodes(s, 0, s.nodeCount, DT, 0, 0, 0);
}

describe('applyBeamForces: elastic', () => {
  it('two-mass oscillator period = 2π·sqrt(μ/k) within 1% at dt 1/2000', () => {
    const m1 = 2;
    const m2 = 3;
    const k = 1e4;
    const mu = (m1 * m2) / (m1 + m2);
    const expected = 2 * Math.PI * Math.sqrt(mu / k);
    const s = pair(1.05, m1, m2, { k });
    const sink = recordingSink();
    const crossings: number[] = [];
    let prev = s.posX[1]! - s.posX[0]! - 1;
    for (let n = 1; n <= 4000; n++) {
      step(s, sink);
      const cur = s.posX[1]! - s.posX[0]! - 1;
      if (prev > 0 && cur <= 0) crossings.push((n - 1 + prev / (prev - cur)) * DT);
      prev = cur;
    }
    expect(crossings.length).toBeGreaterThan(10);
    const period = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1);
    expect(Math.abs(period - expected) / expected).toBeLessThan(0.01);
    // Momentum is conserved (equal/opposite forces): centre of mass never moves.
    const com = (m1 * s.posX[0]! + m2 * s.posX[1]!) / (m1 + m2);
    expect(com).toBeCloseTo((m2 * 1.05) / (m1 + m2), 12);
  });

  it('critical damping decays without overshoot', () => {
    const m = 1;
    const k = 1e4;
    const d = 2 * Math.sqrt(k * m);
    const x0 = 0.02;
    const s = pair(1 + x0, 0, m, { k, d });
    const sink = recordingSink();
    let minStretch = Infinity;
    for (let n = 0; n < 4000; n++) {
      step(s, sink);
      minStretch = Math.min(minStretch, s.posX[1]! - 1);
    }
    expect(s.posX[0]).toBe(0); // pinned
    expect(minStretch).toBeGreaterThanOrEqual(0);
    expect(s.posX[1]! - 1).toBeLessThan(x0 * 1e-6);
  });

  it('applies equal/opposite axial force, tension positive in strainOut', () => {
    const s = pair(1.01, 1, 1, { k: 1e4, breakF: 1000 });
    const sink = recordingSink();
    applyBeamForces(s, 0, 1, sink, true);
    const f = 1e4 * 0.01;
    expect(s.frcX[0]).toBeCloseTo(f, 9); // a pulled toward b (+x)
    expect(s.frcX[1]).toBeCloseTo(-f, 9);
    expect(s.strainOut[0]).toBeCloseTo(f / 1000, 6);

    const c = pair(0.99, 1, 1, { k: 1e4, breakF: 1000 });
    applyBeamForces(c, 0, 1, sink, true);
    expect(c.frcX[0]).toBeCloseTo(-f, 9);
    expect(c.strainOut[0]).toBeCloseTo(-f / 1000, 6);
  });

  it('axial damping opposes relative velocity', () => {
    const s = pair(1, 1, 1, { k: 1e4, d: 50 });
    s.velX[1] = 2; // separating
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.frcX[1]).toBeCloseTo(-100, 9);
    expect(s.frcX[0]).toBeCloseTo(100, 9);
  });

  it('strainOut is untouched without debugStrains', () => {
    const s = pair(1.01, 1, 1, { breakF: 1000 });
    s.strainOut[0] = 0.25;
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.strainOut[0]).toBe(0.25);
  });

  it('only processes beams in [first, first+count)', () => {
    const s = createSimState(4, 2);
    s.nodeCount = 4;
    s.beamCount = 2;
    for (let i = 0; i < 4; i++) s.invMass[i] = 1;
    s.posX[1] = 1.1;
    s.posX[2] = 5;
    s.posX[3] = 6.1;
    for (let b = 0; b < 2; b++) {
      s.aIdx[b] = 2 * b;
      s.bIdx[b] = 2 * b + 1;
      s.k[b] = s.k0[b] = 1000;
      s.restLen[b] = s.restLen0[b] = 1;
      s.deform[b] = s.breakF[b] = Infinity;
      s.active[b] = 1;
    }
    applyBeamForces(s, 1, 1, recordingSink(), false);
    expect(s.frcX[0]).toBe(0);
    expect(s.frcX[1]).toBe(0);
    expect(s.frcX[2]).toBeCloseTo(100, 9);
  });
});

describe('applyBeamForces: plasticity', () => {
  it('return-maps restLen by PLASTIC_RATCHET of the excess stretch and weakens k by 1.5% per plastic step, exactly', () => {
    const k0 = 1e5;
    const deform = 500;
    for (const dir of [1, -1]) {
      const s = pair(1, 0, 0, { k: k0, deform }); // both pinned: geometry driven by the test
      const sink = recordingSink();
      let rest = 1;
      let k = k0;
      let steps = 0;
      for (let n = 0; n < 40; n++) {
        const dist = 1 + dir * 0.002 * (n + 1); // monotonic loading, 0.2 % per step
        s.posX[1] = dist;
        const fs = k * (dist - rest);
        const fAbs = Math.abs(fs);
        const restBefore = rest;
        const kBefore = k;
        if (fAbs > deform) {
          const excess = (fAbs - deform) / k;
          rest = fs > 0 ? rest + PLASTIC_RATCHET * excess : rest - PLASTIC_RATCHET * excess;
          k = Math.max(k * PLASTIC_WEAKEN, PLASTIC_K_FLOOR * k0);
          steps++;
        }
        applyBeamForces(s, 0, 1, sink, false);
        expect(s.restLen[0]).toBe(rest);
        expect(s.k[0]).toBe(k);
        // Force applied this step uses the pre-update spring state.
        expect(s.frcX[0]).toBeCloseTo(kBefore * (dist - restBefore), 6);
        s.frcX[0] = 0;
        s.frcX[1] = 0;
      }
      expect(steps).toBeGreaterThan(20);
      // Rest length followed the loading; the elastic force stays at the threshold.
      if (dir > 0) expect(s.restLen[0]).toBeGreaterThan(1.05);
      else expect(s.restLen[0]).toBeLessThan(0.95);
      expect(sink.breaks).toHaveLength(0);
      expect(s.restLen0[0]).toBe(1);
      expect(s.k0[0]).toBe(k0);
    }
  });

  it('plastic weakening follows PLASTIC_WEAKEN per plastic step, floored at PLASTIC_K_FLOOR·k0', () => {
    const k0 = 1e6;
    const s = pair(1, 0, 0, { k: k0, deform: 1e-9 });
    const sink = recordingSink();
    let k = k0;
    for (let n = 0; n < 300; n++) {
      s.posX[1] = 1 + 0.001 * (n + 1);
      applyBeamForces(s, 0, 1, sink, false);
      k = Math.max(k * PLASTIC_WEAKEN, PLASTIC_K_FLOOR * k0);
    }
    expect(s.k[0]).toBe(k);
    expect(s.k[0]).toBeGreaterThanOrEqual(PLASTIC_K_FLOOR * k0);
    expect(s.restLen[0]).toBeGreaterThan(1.2);
    expect(s.restLen[0]).toBeLessThan(1.3);
  });

  it('compression lockup: plastic shortening stops at PLASTIC_COMPRESS_FLOOR·L0 and a locked beam does not break in compression', () => {
    const s = pair(1, 0, 0, { k: 1e5, deform: 100, breakF: 1e4 });
    const sink = recordingSink();
    for (let n = 0; n < 1000; n++) {
      s.posX[1] = 1 - 0.001 * (n + 1); // to 0.0: far past the lockup
      applyBeamForces(s, 0, 1, sink, false);
    }
    expect(s.restLen[0]).toBe(PLASTIC_COMPRESS_FLOOR);
    expect(Math.abs(1e5 * (0 - PLASTIC_COMPRESS_FLOOR))).toBeGreaterThan(1e4);
    expect(s.active[0]).toBe(1); // |f| ≫ breakF in compression, but locked
    expect(sink.breaks).toHaveLength(0);
    // Tension still breaks.
    s.posX[1] = 2;
    applyBeamForces(s, 0, 1, sink, false);
    expect(s.active[0]).toBe(0);
  });

  it('does not yield at or below the deform threshold', () => {
    const s = pair(1.01, 1, 1, { k: 1e4, deform: 100.001 }); // fs ≈ 100
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.restLen[0]).toBe(1);
    expect(s.k[0]).toBe(1e4);
  });
});

describe('applyBeamForces: breaking', () => {
  it('breaks over breakF: inactive, beamBreak event at the midpoint, NaN strain, no force', () => {
    const s = pair(1.2, 1, 1, { k: 1e4, deform: 100, breakF: 1500 }); // fs = 2000
    s.posY[0] = 1;
    s.posY[1] = 1;
    const sink = recordingSink();
    applyBeamForces(s, 0, 1, sink, true);
    expect(s.active[0]).toBe(0);
    expect(Number.isNaN(s.strainOut[0]!)).toBe(true);
    expect(sink.breaks).toEqual([{ beam: 0, px: 0.6, py: 1, pz: 0 }]);
    expect(s.frcX[0]).toBe(0);
    expect(s.frcX[1]).toBe(0);
    expect(s.restLen[0]).toBe(1); // no plastic update on the breaking step
    // Stays broken and silent afterwards.
    s.posX[1] = 1;
    applyBeamForces(s, 0, 1, sink, true);
    expect(sink.breaks).toHaveLength(1);
    expect(Number.isNaN(s.strainOut[0]!)).toBe(true);
    expect(s.frcX[0]).toBe(0);
  });

  it('marks strain NaN on break even without debugStrains, and reports the global beam index', () => {
    const s = createSimState(4, 3);
    s.nodeCount = 4;
    s.beamCount = 3;
    for (let i = 0; i < 4; i++) {
      s.invMass[i] = 1;
      s.posX[i] = i * 1.0;
    }
    for (let b = 0; b < 3; b++) {
      s.aIdx[b] = b;
      s.bIdx[b] = b + 1;
      s.k[b] = s.k0[b] = 1e4;
      s.restLen[b] = s.restLen0[b] = b === 2 ? 0.5 : 1;
      s.deform[b] = Infinity;
      s.breakF[b] = 1000;
      s.active[b] = 1;
    }
    const sink = recordingSink();
    applyBeamForces(s, 0, 3, sink, false);
    expect(sink.breaks.map((e) => e.beam)).toEqual([2]);
    expect(Number.isNaN(s.strainOut[2]!)).toBe(true);
    expect(s.active[0]).toBe(1);
  });
});

describe('applyBeamForces: beam types', () => {
  it('support beams push only in compression', () => {
    const t = pair(1.1, 1, 1, { type: BeamType.support, d: 100, breakF: 1e6 });
    t.velX[1] = 1;
    t.strainOut[0] = 0.5;
    applyBeamForces(t, 0, 1, recordingSink(), true);
    expect(t.frcX[0]).toBe(0);
    expect(t.frcX[1]).toBe(0);
    expect(t.strainOut[0]).toBe(0);

    const c = pair(0.9, 1, 1, { type: BeamType.support, breakF: 1e6 });
    applyBeamForces(c, 0, 1, recordingSink(), true);
    expect(c.frcX[0]).toBeCloseTo(-1000, 9); // pushes a away from b
    expect(c.frcX[1]).toBeCloseTo(1000, 9);
    expect(c.strainOut[0]).toBeLessThan(0);
  });

  it('bounded beams stiffen beyond their bounds', () => {
    const k = 1e4;
    const inside = pair(1.05, 1, 1, { type: BeamType.bounded, k, boundsHigh: 0.1 });
    applyBeamForces(inside, 0, 1, recordingSink(), false);
    expect(inside.frcX[0]).toBeCloseTo(k * 0.05, 9);

    const out = pair(1.15, 1, 1, { type: BeamType.bounded, k, boundsHigh: 0.1 });
    applyBeamForces(out, 0, 1, recordingSink(), false);
    expect(out.frcX[0]).toBeCloseTo(k * 0.15 + k * BOUND_STIFFNESS_RAMP * 0.05, 6);

    const comp = pair(0.8, 1, 1, { type: BeamType.bounded, k, boundsLow: 0.1 });
    applyBeamForces(comp, 0, 1, recordingSink(), false);
    expect(comp.frcX[0]).toBeCloseTo(-(k * 0.2 + k * BOUND_STIFFNESS_RAMP * 0.1), 6);
  });

  it('shock beams add their preload (pushing apart) and have bump stops', () => {
    const k = 1e4;
    const s = pair(1, 1, 1, { type: BeamType.shock, k, preload: 300 });
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.frcX[0]).toBeCloseTo(-300, 9);
    expect(s.frcX[1]).toBeCloseTo(300, 9);

    const stop = pair(0.85, 1, 1, { type: BeamType.shock, k, preload: 300, boundsLow: 0.1 });
    applyBeamForces(stop, 0, 1, recordingSink(), false);
    expect(stop.frcX[0]).toBeCloseTo(-(k * 0.15 + k * BOUND_STIFFNESS_RAMP * 0.05 + 300), 6);
  });

  it('hydro beams are springs about the (engine-driven) current restLen', () => {
    const s = pair(1.1, 1, 1, { type: BeamType.hydro, k: 1e4 });
    s.restLen[0] = 1.1;
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.frcX[0]).toBeCloseTo(0, 9);
    s.restLen[0] = 1.2;
    applyBeamForces(s, 0, 1, recordingSink(), false);
    expect(s.frcX[0]).toBeCloseTo(-1000, 6);
  });
});

describe('numerics contract', () => {
  it('beam and integrator kernels use no Math.* other than sqrt', () => {
    for (const [name, src] of [
      ['beams.ts', beamsSrc],
      ['integrator.ts', integratorSrc],
    ] as const) {
      const calls: string[] = src.match(/Math\.[a-zA-Z0-9_]+/g) ?? [];
      if (name === 'beams.ts') expect(calls).toContain('Math.sqrt');
      expect(
        calls.filter((c) => c !== 'Math.sqrt'),
        name,
      ).toEqual([]);
    }
  });
});
