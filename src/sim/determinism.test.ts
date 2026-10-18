/**
 * PRIMARY REGRESSION NET: bit-exact determinism of the step kernels.
 * Self-contained (no rig builder): a seeded random blob of every beam type,
 * stepped 5000 times; the FNV hash over every arena buffer must be identical
 * across runs, and identical when snapshots are written in between.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../core/rng';
import { BufferPool, SnapshotReader, SnapshotWriter } from '../protocol/codec';
import { computeSnapshotLayout } from '../protocol/layout';
import { applyBeamForces } from './beams';
import { integrateNodes } from './integrator';
import { createSimState } from './state';
import { BeamType, type EventSink, type SimState } from './types';

const DT = 1 / 2000;
const NODES = 200;
const BEAMS = 1000;
const STEPS = 5000;
const SEED = 0xc0ffee;

function buildBlob(seed: number): SimState {
  const rng = createRng(seed);
  const s = createSimState(NODES, BEAMS);
  s.nodeCount = NODES;
  s.beamCount = BEAMS;
  for (let i = 0; i < NODES; i++) {
    s.posX[i] = rng.range(-1, 1);
    s.posY[i] = rng.range(0, 2);
    s.posZ[i] = rng.range(-1, 1);
    s.velX[i] = rng.range(-4, 4);
    s.velY[i] = rng.range(-4, 4);
    s.velZ[i] = rng.range(-4, 4);
    s.radius[i] = 0.05;
    s.friction[i] = 0.5;
  }
  const sumK = new Float64Array(NODES);
  const sumD = new Float64Array(NODES);
  const types = [BeamType.normal, BeamType.normal, BeamType.bounded, BeamType.support, BeamType.hydro, BeamType.shock];
  for (let b = 0; b < BEAMS; b++) {
    const a = rng.int(0, NODES - 1);
    let c = rng.int(0, NODES - 2);
    if (c >= a) c++;
    const dx = s.posX[c]! - s.posX[a]!;
    const dy = s.posY[c]! - s.posY[a]!;
    const dz = s.posZ[c]! - s.posZ[a]!;
    const rest = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = rng.range(2e4, 2e5);
    const d = rng.range(5, 60);
    s.aIdx[b] = a;
    s.bIdx[b] = c;
    s.k[b] = s.k0[b] = k;
    s.d[b] = d;
    s.restLen[b] = s.restLen0[b] = rest;
    s.deform[b] = k * rest * rng.range(0.005, 0.05);
    s.breakF[b] = s.deform[b]! * rng.range(1.5, 6);
    s.type[b] = rng.pick(types);
    s.boundsLow[b] = rng.range(0.05, 0.2);
    s.boundsHigh[b] = rng.range(0.05, 0.2);
    s.preload[b] = s.type[b] === BeamType.shock ? rng.range(0, 200) : 0;
    s.active[b] = 1;
    sumK[a]! += k;
    sumK[c]! += k;
    sumD[a]! += d;
    sumD[c]! += d;
  }
  // Masses from the per-node stability rule, sqrt(Σk/m)·dt ≤ 0.35, (Σd/m)·dt ≤ 0.5.
  for (let i = 0; i < NODES; i++) {
    const m = Math.max(1, (sumK[i]! * DT * DT) / (0.35 * 0.35), (sumD[i]! * DT) / 0.5);
    s.invMass[i] = i % 50 === 0 ? 0 : 1 / m; // 4 pinned anchors
  }
  return s;
}

class CountingSink implements EventSink {
  breaks = 0;
  acc = 0;
  impact(): void {}
  skid(): void {}
  beamBreak(beam: number, px: number, py: number, pz: number): void {
    this.breaks++;
    this.acc = (this.acc * 31 + beam + px + py + pz) % 1e9;
  }
}

function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

function hashState(s: SimState): string {
  let h = 0x811c9dc5;
  const arrays = [
    s.posX, s.posY, s.posZ, s.velX, s.velY, s.velZ, s.frcX, s.frcY, s.frcZ, s.invMass, s.radius, s.friction,
    s.flags, s.aIdx, s.bIdx, s.k, s.d, s.restLen, s.restLen0, s.k0, s.deform, s.breakF, s.boundsLow,
    s.boundsHigh, s.preload, s.type, s.active, s.strainOut,
  ];
  for (const a of arrays) h = fnv(h, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return h.toString(16).padStart(8, '0');
}

interface RunResult {
  hash: string;
  breaks: number;
  eventAcc: number;
  plastic: number;
  finite: boolean;
  snapshots: number;
}

function run(withSnapshots: boolean): RunResult {
  const s = buildBlob(SEED);
  const sink = new CountingSink();
  const layout = computeSnapshotLayout(1, NODES, BEAMS, true);
  const pool = new BufferPool(layout.totalBytes);
  const writer = new SnapshotWriter(layout);
  const reader = new SnapshotReader();
  let snapshots = 0;
  for (let t = 0; t < STEPS; t++) {
    // Hydro drive: triangle wave in [-1, 1] (arithmetic only).
    const phase = (t % 800) / 400;
    const steer = phase < 1 ? phase * 2 - 1 : 3 - phase * 2;
    for (let b = 0; b < BEAMS; b++) {
      if (s.type[b] === BeamType.hydro) s.restLen[b] = s.restLen0[b]! * (1 + 0.1 * steer);
    }
    applyBeamForces(s, 0, BEAMS, sink, true);
    integrateNodes(s, 0, NODES, DT, 0, -9.81, 0);
    if (withSnapshots && t % 17 === 0) {
      const buf = pool.acquire()!;
      writer.attach(buf);
      writer.begin(t, t * DT, 1);
      const oi = writer.addObject(1, 0, NODES, BEAMS);
      writer.writeNodesSoA(oi, s.posX, s.posY, s.posZ, 0);
      writer.writeStrains(oi, s.strainOut, 0);
      writer.pushBeamBreak(1, sink.breaks, s.posX[0]!, s.posY[0]!, s.posZ[0]!);
      reader.attach(buf);
      expect(reader.nodes[3 * 7 + 1]).toBe(Math.fround(s.posY[7]!));
      pool.release(buf);
      snapshots++;
    }
  }
  let plastic = 0;
  for (let b = 0; b < BEAMS; b++) if (s.restLen[b] !== s.restLen0[b] && s.type[b] !== BeamType.hydro) plastic++;
  let finite = true;
  for (let i = 0; i < NODES; i++) {
    if (!Number.isFinite(s.posX[i]!) || !Number.isFinite(s.posY[i]!) || !Number.isFinite(s.posZ[i]!)) finite = false;
  }
  return { hash: hashState(s), breaks: sink.breaks, eventAcc: sink.acc, plastic, finite, snapshots };
}

describe('determinism', () => {
  it(`${NODES}-node / ${BEAMS}-beam blob: ${STEPS} steps hash identically, with and without snapshot writes`, () => {
    const a = run(false);
    const b = run(false);
    const c = run(true);
    // The scenario must actually exercise plasticity and breaking, and stay finite.
    expect(a.finite).toBe(true);
    expect(a.breaks).toBeGreaterThan(0);
    expect(a.breaks).toBeLessThan(BEAMS);
    expect(a.plastic).toBeGreaterThan(0);
    expect(c.snapshots).toBeGreaterThan(200);

    expect(b.hash).toBe(a.hash);
    expect(b.breaks).toBe(a.breaks);
    expect(b.eventAcc).toBe(a.eventAcc);
    expect(c.hash).toBe(a.hash);
    expect(c.breaks).toBe(a.breaks);
    expect(c.eventAcc).toBe(a.eventAcc);
  });

  it('a different seed gives a different hash (the hash is sensitive)', () => {
    const s1 = buildBlob(SEED);
    const s2 = buildBlob(SEED + 1);
    expect(hashState(s1)).not.toBe(hashState(s2));
  });
});
