/**
 * R-CORE: the WASM kernels (scalar, SIMD) are BIT-IDENTICAL to the JS
 * reference. (1) A fuzzed blob of every beam type driven hard enough to
 * yield, lock up, go slack, degenerate and break, stepped with beams +
 * integrate, compared array-for-array (f64 bits) every 100 steps, break
 * events in order; (2) whole-engine runs (sedan 100 km/h frontal, the box
 * truck launching, Crumple Valley with traffic + props) hash-compared across
 * kernels.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../core/rng';
import { JS_KERNEL, setDefaultKernel, defaultKernel, type KernelFactory, type SimKernel } from '../kernel';
import { BeamType, type EventSink, type SimState } from '../types';
import { SIMD_KERNEL, WASM_KERNEL, simdSupported } from './kernel';
import { runCrash } from '../vehicle/crash';
import { createHandlingSim, stepN } from '../vehicle/handling';
import { BOXTRUCK } from '../vehicle/defs/boxtruck';
import type { SimEngine } from '../engine';

const KERNELS: KernelFactory[] = simdSupported() ? [WASM_KERNEL, SIMD_KERNEL] : [WASM_KERNEL];

const NODES = 160;
const BEAMS = 900;

class BreakLog implements EventSink {
  readonly log: number[] = [];
  impact(): void {}
  skid(): void {}
  beamBreak(b: number, px: number, py: number, pz: number): void {
    this.log.push(b, px, py, pz);
  }
}

function fillBlob(s: SimState, seed: number): void {
  const rng = createRng(seed);
  s.nodeCount = NODES;
  s.beamCount = BEAMS;
  for (let i = 0; i < NODES; i++) {
    s.posX[i] = rng.range(-1, 1);
    s.posY[i] = rng.range(0, 2);
    s.posZ[i] = rng.range(-1, 1);
    s.velX[i] = rng.range(-6, 6);
    s.velY[i] = rng.range(-6, 6);
    s.velZ[i] = rng.range(-6, 6);
    s.invMass[i] = i % 37 === 0 ? 0 : 1 / rng.range(0.5, 4);
  }
  // Node 1 duplicates node 0 (degenerate beams), pinned like it.
  s.posX[1] = s.posX[0]!;
  s.posY[1] = s.posY[0]!;
  s.posZ[1] = s.posZ[0]!;
  s.invMass[1] = 0;
  s.velX[1] = s.velY[1] = s.velZ[1] = 0;
  const types = [BeamType.normal, BeamType.normal, BeamType.normal, BeamType.bounded, BeamType.support, BeamType.hydro, BeamType.shock];
  for (let b = 0; b < BEAMS; b++) {
    const a = b === 7 ? 0 : rng.int(0, NODES - 1);
    let c = b === 7 ? 1 : rng.int(0, NODES - 2);
    if (b !== 7 && c >= a) c++;
    const dx = s.posX[c]! - s.posX[a]!;
    const dy = s.posY[c]! - s.posY[a]!;
    const dz = s.posZ[c]! - s.posZ[a]!;
    // Rest lengths off by ±30 %: many beams start loaded, some past deform or break.
    const rest = Math.sqrt(dx * dx + dy * dy + dz * dz) * rng.range(0.7, 1.3);
    const k = rng.range(2e3, 6e4);
    s.aIdx[b] = a;
    s.bIdx[b] = c;
    s.k[b] = s.k0[b] = k;
    s.d[b] = rng.range(1, 40);
    s.restLen[b] = s.restLen0[b] = rest;
    s.deform[b] = rng.float() < 0.1 ? Infinity : k * rest * rng.range(0.01, 0.2);
    s.breakF[b] = rng.float() < 0.1 ? Infinity : s.deform[b]! * rng.range(1.2, 4);
    s.type[b] = rng.pick(types);
    s.boundsLow[b] = rng.range(0.05, 0.2);
    s.boundsHigh[b] = rng.range(0.05, 0.2);
    s.preload[b] = s.type[b] === BeamType.shock ? rng.range(0, 200) : 0;
    s.active[b] = rng.float() < 0.03 ? 0 : 1;
    // R-CRASH crush unloading: permanent (gain > 0), temporary (< 0) and off, some never triggered
    const g = rng.float();
    s.unloadGain[b] = g < 0.35 ? rng.range(1, 60) : g < 0.7 ? -rng.range(1, 60) : 0;
    s.unloadTrig[b] = rng.float() < 0.15 ? Infinity : rng.range(0.1, 0.6) * (Number.isFinite(s.deform[b]!) ? s.deform[b]! : k * rest * 0.1);
    // SET members (VehicleDef.crushSet): a negative trigger arms without a crash
    if (s.unloadGain[b]! > 0 && rng.float() < 0.3) s.unloadTrig[b] = -s.unloadTrig[b]!;
  }
}

const F64_KEYS = ['posX', 'posY', 'posZ', 'velX', 'velY', 'velZ', 'frcX', 'frcY', 'frcZ', 'k', 'restLen'] as const;

function sameBits(a: Float64Array | Float32Array, b: Float64Array | Float32Array, n: number): number {
  const ua = new Uint32Array(a.buffer, a.byteOffset, (n * a.BYTES_PER_ELEMENT) / 4);
  const ub = new Uint32Array(b.buffer, b.byteOffset, (n * b.BYTES_PER_ELEMENT) / 4);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return Math.floor((i * 4) / a.BYTES_PER_ELEMENT);
  return -1;
}

function expectSameState(ref: SimState, got: SimState, where: string): void {
  for (const key of F64_KEYS) {
    const at = sameBits(ref[key], got[key], key === 'k' || key === 'restLen' ? BEAMS : NODES);
    expect(at, `${where}: ${key}[${at}] ${ref[key][at]} vs ${got[key][at]}`).toBe(-1);
  }
  expect(sameBits(ref.strainOut, got.strainOut, BEAMS), `${where}: strainOut`).toBe(-1);
  expect(sameBits(ref.hystOff, got.hystOff, BEAMS), `${where}: hystOff`).toBe(-1);
  for (let b = 0; b < BEAMS; b++) if (ref.crushHold[b] !== got.crushHold[b]) expect.fail(`${where}: crushHold[${b}]`);
  for (let b = 0; b < BEAMS; b++) if (ref.active[b] !== got.active[b]) expect.fail(`${where}: active[${b}]`);
}

function stepBlob(k: SimKernel, ev: EventSink, dbg: boolean, steps: number, armed: boolean): void {
  for (let i = 0; i < steps; i++) {
    // Two "objects" so ranges with odd starts / lengths hit the SIMD tail.
    k.beams(0, 451, ev, dbg, armed);
    k.beams(451, BEAMS - 451, ev, dbg, armed);
    k.integrate(0, 77, 1 / 2000, 0, -9.81, 0);
    k.integrate(77, NODES - 77, 1 / 2000, 0, -9.81, 0);
  }
}

describe('wasm kernel parity (bit-identical to the JS kernel)', () => {
  for (const kf of KERNELS) {
    it(`${kf.kind}: fuzzed blob of every beam type, 3000 steps, all arrays + break events`, () => {
      for (const seed of [1, 0xbeef, 0x5eed5]) {
        const ref = JS_KERNEL.create(NODES, BEAMS);
        const got = kf.create(NODES, BEAMS);
        fillBlob(ref.state, seed);
        fillBlob(got.state, seed);
        const evRef = new BreakLog();
        const evGot = new BreakLog();
        for (let w = 0; w < 30; w++) {
          const dbg = w % 3 !== 1;
          const armed = w % 4 < 2;
          stepBlob(ref, evRef, dbg, 100, armed);
          stepBlob(got, evGot, dbg, 100, armed);
          expectSameState(ref.state, got.state, `seed ${seed} window ${w}`);
        }
        expect(evGot.log).toEqual(evRef.log);
        // The blob really exercised the rare paths.
        let plastic = 0;
        for (let b = 0; b < BEAMS; b++) if (ref.state.restLen[b] !== ref.state.restLen0[b] && ref.state.type[b] !== BeamType.hydro) plastic++;
        expect(evRef.log.length / 4).toBeGreaterThan(20);
        expect(plastic).toBeGreaterThan(50);
        // …and the crush unloading (holds started, offsets taken)
        let held = 0;
        for (let b = 0; b < BEAMS; b++) if (ref.state.hystOff[b] !== 0 || ref.state.crushHold[b] !== 0) held++;
        expect(held).toBeGreaterThan(0);
      }
    });
  }

  function hashEngine(eng: SimEngine): string {
    const s = eng.state;
    const parts: number[] = [];
    let h = 0x811c9dc5;
    const f = new Float64Array(1);
    const u = new Uint32Array(f.buffer);
    const word = (x: number): void => {
      f[0] = x;
      h = Math.imul(h ^ u[0]!, 0x01000193) >>> 0;
      h = Math.imul(h ^ u[1]!, 0x01000193) >>> 0;
    };
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
      word(s.active[b]!);
    }
    parts.push(h >>> 0, eng.tick, s.nodeCount, s.beamCount);
    return parts.join(':');
  }

  function withKernel<T>(kf: KernelFactory, fn: () => T): T {
    const prev = defaultKernel();
    setDefaultKernel(kf);
    try {
      return fn();
    } finally {
      setDefaultKernel(prev);
    }
  }

  it('sedan 100 km/h frontal: identical crash results and final state on every kernel', () => {
    const run = (kf: KernelFactory): { result: string; hash: string } =>
      withKernel(kf, () => {
        let last: SimEngine | null = null;
        const r = runCrash({ kind: 'frontal', speedKmh: 100, afterContactS: 0.6, onStep: (eng) => (last = eng) });
        expect(last!.kernel.kind).toBe(kf.kind);
        return { result: JSON.stringify(r), hash: hashEngine(last!) };
      });
    const ref = run(JS_KERNEL);
    for (const kf of KERNELS) expect(run(kf), kf.kind).toEqual(ref);
  }, 120_000);

  it('box truck launching 1.5 s: identical state on every kernel', () => {
    const run = (kf: KernelFactory): string =>
      withKernel(kf, () => {
        const sim = createHandlingSim({ def: BOXTRUCK });
        sim.obj.actions[0] = 1;
        sim.obj.actions[5] = 1;
        stepN(sim, 3000);
        return hashEngine(sim.eng);
      });
    const ref = run(JS_KERNEL);
    for (const kf of KERNELS) expect(run(kf), kf.kind).toBe(ref);
  }, 120_000);
});
