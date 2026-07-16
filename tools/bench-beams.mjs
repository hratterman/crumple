#!/usr/bin/env node
// CRUMPLE P0 beam-kernel microbenchmark — gates all physics budgets.
// Zero dependencies, plain Node. Run: node tools/bench-beams.mjs  (npm run bench)
//
// Measures the EXACT hot-kernel shape src/sim/ will use:
//   SoA typed arrays; beams as index pairs + per-beam k, d, restLen, plastic state.
//   Beam pass : dx/dy/dz, dist=sqrt, 1/dist, spring k*(dist-rest), axial
//               relative-velocity damping, present-but-rarely-taken plasticity
//               branch (restLen ratchet + k weakening, RoR-style force threshold),
//               equal/opposite accumulation into f32 force arrays (6 RMW).
//   Node pass : semi-implicit Euler v += f*invMass*dt (+gravity), p += v*dt, f=0.
// Variants: positions+velocities in Float32Array vs Float64Array (forces f32 both
// ways) — the result decides the sim's precision choice.
// Hot loop obeys the sim numerics contract: only + - * / sqrt, no allocation,
// seeded PRNG only (never Math.random), fixed iteration order.

import { performance } from 'node:perf_hooks';

const DT = 1 / 2000;          // fixed physics dt (RoR PHYSICS_DT)
const GRAVITY_Y = -9.81;
const SPRING_BASE = 9e6;      // N/m   (RoR default beam spring)
const DAMP_BASE = 12e3;       // N·s/m (RoR default beam damp)
const DEFORM_BASE = 4e5;      // N     (plastic threshold is a FORCE, per plan)
const MIN_NODE_MASS = 3;      // kg    (MINIMASS floor)
const CFL = 0.35;             // per-node sqrt(Σk/m)·dt ≤ 0.35 (structure headroom)
const NODE_SPACING = 0.3;     // m
const JITTER = 0.12;          // m, ±0.06 — keeps grid irregular, never degenerate
const LONG_RANGE_FRAC = 0.05; // beams that jump across the structure (hydros/supports)
const WARMUP_MS = 1100;
const RUN_MS = 1000;
const RUNS = 5;

const CONFIGS = [
  { name: 'rig', nx: 7, ny: 5, nz: 10, beams: 3500, seed: 0x0c0ffee1 },   // player-rig scale
  { name: 'fleet', nx: 10, ny: 10, nz: 25, beams: 10000, seed: 0x0c0ffee2 }, // awake-fleet scale
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The kernel. One full fixed step: beam pass then node pass.
// Damping applies force opposing axial relative velocity (the "-d*vrel" term,
// sign folded into the shared application direction below).
// ---------------------------------------------------------------------------
function beamNodeStep(w, dt) {
  const beamA = w.beamA, beamB = w.beamB;
  const k = w.k, d = w.d, restLen = w.restLen, deformF = w.deformF;
  const px = w.px, py = w.py, pz = w.pz;
  const vx = w.vx, vy = w.vy, vz = w.vz;
  const fx = w.fx, fy = w.fy, fz = w.fz;
  const invMass = w.invMass, gy = w.gy;
  const nb = w.beamCount, nn = w.nodeCount;
  let plastic = 0;
  for (let b = 0; b < nb; b++) {
    const i = beamA[b], j = beamB[b];
    const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inv = 1 / dist;
    const kb = k[b];
    const stretch = dist - restLen[b];
    const fSpring = kb * stretch; // >0 tension, <0 compression
    const vrel = ((vx[j] - vx[i]) * dx + (vy[j] - vy[i]) * dy + (vz[j] - vz[i]) * dz) * inv;
    const fAxial = fSpring + d[b] * vrel;
    const fAbs = fSpring < 0 ? -fSpring : fSpring;
    if (fAbs > deformF[b]) {
      // plastic deformation: ratchet rest length toward current, weaken spring;
      // mild work-hardening keeps the branch rare after the first crash transient
      restLen[b] += stretch * 0.05;
      k[b] = kb * 0.995;
      deformF[b] = deformF[b] * 1.01;
      plastic++;
    }
    const s = fAxial * inv;
    const bx = s * dx, by = s * dy, bz = s * dz;
    fx[i] += bx; fy[i] += by; fz[i] += bz;
    fx[j] -= bx; fy[j] -= by; fz[j] -= bz;
  }
  for (let n = 0; n < nn; n++) {
    const im = invMass[n] * dt;
    vx[n] += fx[n] * im;
    vy[n] += fy[n] * im + gy[n] * dt; // gy=0 for anchor nodes (invMass=0) so they never drift
    vz[n] += fz[n] * im;
    px[n] += vx[n] * dt;
    py[n] += vy[n] * dt;
    pz[n] += vz[n] * dt;
    fx[n] = 0; fy[n] = 0; fz[n] = 0;
  }
  return plastic;
}

// Each variant gets its own compiled function instance (fresh JIT type feedback):
// otherwise f32/f64 array maps make every element access polymorphic and the
// second-measured variant pays the first one's IC pollution.
const stepF32 = beamNodeStep;
const stepF64 = (0, eval)('(' + beamNodeStep.toString() + ')');

// ---------------------------------------------------------------------------
// World construction: jittered 3D grid, beams mostly near-index neighbors
// (cache-realistic), small long-range fraction, canonical sort.
// ---------------------------------------------------------------------------
function buildWorld(cfg, FloatArr) {
  const rand = mulberry32(cfg.seed);
  const { nx, ny, nz } = cfg;
  const nodeCount = nx * ny * nz;
  const beamCount = cfg.beams;

  const used = new Set();
  const pairs = [];
  const addPair = (a, b) => {
    if (a > b) { const t = a; a = b; b = t; }
    const key = a * nodeCount + b;
    if (used.has(key)) return false;
    used.add(key);
    pairs.push([a, b]);
    return true;
  };
  const idx = (x, y, z) => x + nx * (y + ny * z);
  const collect = (offsets, sink) => {
    for (const [ox, oy, oz] of offsets) {
      for (let z = 0; z < nz; z++) {
        const z2 = z + oz;
        if (z2 < 0 || z2 >= nz) continue;
        for (let y = 0; y < ny; y++) {
          const y2 = y + oy;
          if (y2 < 0 || y2 >= ny) continue;
          for (let x = 0; x < nx; x++) {
            const x2 = x + ox;
            if (x2 < 0 || x2 >= nx) continue;
            sink(idx(x, y, z), idx(x2, y2, z2));
          }
        }
      }
    }
  };

  // structural core: every axial neighbor beam
  collect([[1, 0, 0], [0, 1, 0], [0, 0, 1]], addPair);
  // bracing pool: diagonals + skip-one beams, sampled to hit the exact budget
  const pool = [];
  collect(
    [[1, 1, 0], [1, -1, 0], [0, 1, 1], [0, 1, -1], [1, 0, 1], [1, 0, -1],
     [1, 1, 1], [1, -1, 1], [1, 1, -1], [1, -1, -1], [2, 0, 0], [0, 2, 0], [0, 0, 2]],
    (a, b) => pool.push([a, b]),
  );
  for (let i = pool.length - 1; i > 0; i--) { // Fisher-Yates, seeded
    const j = (rand() * (i + 1)) | 0;
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const longCount = Math.round(beamCount * LONG_RANGE_FRAC);
  for (let p = 0; p < pool.length && pairs.length < beamCount - longCount; p++) {
    addPair(pool[p][0], pool[p][1]);
  }
  if (pairs.length < beamCount - longCount) {
    throw new Error(`config ${cfg.name}: near-neighbor pool exhausted at ${pairs.length} beams`);
  }
  // long-range beams (steering hydros / supports jump across the rig)
  const farMin = 2 * nx * ny + 2 * nx + 3; // beyond any near-offset index distance
  while (pairs.length < beamCount) {
    const a = (rand() * nodeCount) | 0;
    const b = (rand() * nodeCount) | 0;
    if (b - a >= farMin || a - b >= farMin) addPair(a, b);
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]); // canonical order, like the real rig builder

  const beamA = new Int32Array(beamCount);
  const beamB = new Int32Array(beamCount);
  for (let b = 0; b < beamCount; b++) { beamA[b] = pairs[b][0]; beamB[b] = pairs[b][1]; }

  // jittered grid positions (variant-typed), velocities zero, forces f32 always
  const px = new FloatArr(nodeCount), py = new FloatArr(nodeCount), pz = new FloatArr(nodeCount);
  const vx = new FloatArr(nodeCount), vy = new FloatArr(nodeCount), vz = new FloatArr(nodeCount);
  const fx = new Float32Array(nodeCount), fy = new Float32Array(nodeCount), fz = new Float32Array(nodeCount);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const n = idx(x, y, z);
        px[n] = x * NODE_SPACING + (rand() - 0.5) * JITTER;
        py[n] = y * NODE_SPACING + (rand() - 0.5) * JITTER;
        pz[n] = z * NODE_SPACING + (rand() - 0.5) * JITTER;
      }
    }
  }

  const k = new Float32Array(beamCount);
  const d = new Float32Array(beamCount);
  const restLen = new Float32Array(beamCount);
  const deformF = new Float32Array(beamCount);
  const sumK = new Float64Array(nodeCount);
  const sumD = new Float64Array(nodeCount);
  for (let b = 0; b < beamCount; b++) {
    k[b] = SPRING_BASE * (0.5 + rand());
    d[b] = DAMP_BASE * (0.5 + rand());
    deformF[b] = DEFORM_BASE * (0.75 + 0.5 * rand());
    const i = beamA[b], j = beamB[b];
    const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
    restLen[b] = Math.sqrt(dx * dx + dy * dy + dz * dz); // equilibrium at spawn
    sumK[i] += k[b]; sumK[j] += k[b];
    sumD[i] += d[b]; sumD[j] += d[b];
  }

  // per-node stability rule (plan): sqrt(Σk/m)·dt ≤ CFL → auto-raise mass (MINIMASS
  // approach, never soften k). y=0 anchor nodes are pinned: invMass=0, no gravity.
  const invMass = new Float32Array(nodeCount);
  const gy = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    const y = ((n / nx) | 0) % ny;
    const x = n % nx;
    const z = (n / (nx * ny)) | 0;
    const pinned = y === 0 && (x + z) % 3 === 0;
    if (pinned) { invMass[n] = 0; gy[n] = 0; continue; }
    const m = Math.max(MIN_NODE_MASS, (sumK[n] * DT * DT) / (CFL * CFL));
    if ((sumD[n] / m) * DT > 1) throw new Error(`node ${n}: damper rule violated`);
    invMass[n] = 1 / m;
    gy[n] = GRAVITY_Y;
  }

  return {
    name: cfg.name, nodeCount, beamCount,
    beamA, beamB, k, d, restLen, deformF,
    px, py, pz, vx, vy, vz, fx, fy, fz, invMass, gy,
    kickRand: mulberry32(cfg.seed ^ 0x9e3779b9),
  };
}

// crash-like velocity impulse so the plasticity branch actually fires (then
// settles), giving realistic rarely-taken branch behavior inside timed windows
function kick(w, mag) {
  const r = w.kickRand;
  for (let n = 0; n < w.nodeCount; n++) {
    const a = (r() * 2 - 1) * mag, b = (r() * 2 - 1) * mag, c = (r() * 2 - 1) * mag;
    if (w.invMass[n] === 0) continue; // pinned anchors never move
    w.vx[n] += a; w.vy[n] += b; w.vz[n] += c;
  }
}

function timedRun(step, w, minMs, batch) {
  let steps = 0, plastic = 0;
  const t0 = performance.now();
  let t;
  do {
    for (let s = 0; s < batch; s++) plastic += step(w, DT);
    steps += batch;
    t = performance.now();
  } while (t - t0 < minMs);
  return { ms: t - t0, steps, plastic };
}

function checkFinite(w, label) {
  for (let n = 0; n < w.nodeCount; n++) {
    if (!Number.isFinite(w.px[n]) || !Number.isFinite(w.py[n]) || !Number.isFinite(w.pz[n])) {
      throw new Error(`NaN guard FAILED [${label}]: node ${n} position not finite ` +
        `(${w.px[n]}, ${w.py[n]}, ${w.pz[n]})`);
    }
  }
}

function measure(cfg, FloatArr, step, label) {
  const w = buildWorld(cfg, FloatArr);
  kick(w, 15); // hard initial crash: exercises + then work-hardens the plastic branch
  const warm = timedRun(step, w, WARMUP_MS, 16);
  const estNsPerStep = (warm.ms * 1e6) / warm.steps;
  const batch = Math.max(1, Math.min(4096, Math.round(2e6 / estNsPerStep))); // ~2 ms per clock check
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    kick(w, 8); // per-run bump keeps a small realistic plastic burst inside the window
    const run = timedRun(step, w, RUN_MS, batch);
    runs.push({ nsPerStep: (run.ms * 1e6) / run.steps, steps: run.steps, plastic: run.plastic });
  }
  checkFinite(w, label);
  const sorted = runs.map((r) => r.nsPerStep).sort((a, b) => a - b);
  return {
    best: sorted[0],
    median: sorted[(RUNS - 1) / 2],
    steps: Math.round(runs.reduce((s, r) => s + r.steps, 0) / RUNS),
    plastic: Math.round(runs.reduce((s, r) => s + r.plastic, 0) / RUNS),
    warmPlastic: warm.plastic,
    world: w,
  };
}

// ---------------------------------------------------------------------------
const round2 = (x) => Math.round(x * 100) / 100;
const pad = (s, w) => String(s).padStart(w);

console.log(`CRUMPLE beam-kernel microbenchmark  (${process.version}, dt=${DT}s, ` +
  `${WARMUP_MS} ms warmup, ${RUNS} runs x >=${RUN_MS} ms)`);
console.log('kernel: SoA spring-damper beams + plasticity branch + semi-implicit Euler node pass');
console.log('ns/beam and ns/node amortize the FULL step (beam pass + node pass) over that count\n');

const results = { f32: {}, f64: {} };
const header =
  `${pad('config', 18)} ${pad('var', 4)} ${pad('steps/run', 10)} ${pad('ns/step best', 13)} ` +
  `${pad('ns/step med', 12)} ${pad('ns/beam', 8)} ${pad('ns/node', 8)} ${pad('Mbeam/s', 8)} ` +
  `${pad('plastic warm/run', 17)}`;
console.log(header);
console.log('-'.repeat(header.length));

for (const cfg of CONFIGS) {
  for (const [variant, FloatArr, step] of [['f32', Float32Array, stepF32], ['f64', Float64Array, stepF64]]) {
    const r = measure(cfg, FloatArr, step, `${cfg.name}/${variant}`);
    const nodes = cfg.nx * cfg.ny * cfg.nz;
    results[variant][cfg.name] = {
      nsPerStepBest: r.best,
      nsPerStepMed: r.median,
      nsPerBeam: r.median / cfg.beams,
      nsPerNode: r.median / nodes,
      plastic: r.plastic,
      warmPlastic: r.warmPlastic,
    };
    console.log(
      `${pad(`${cfg.name} ${nodes}n/${cfg.beams}b`, 18)} ${pad(variant, 4)} ${pad(r.steps, 10)} ` +
      `${pad(round2(r.best), 13)} ${pad(round2(r.median), 12)} ${pad(round2(r.median / cfg.beams), 8)} ` +
      `${pad(round2(r.median / nodes), 8)} ${pad(round2(cfg.beams * 1e3 / r.median), 8)} ` +
      `${pad(`${r.warmPlastic}/${r.plastic}`, 17)}`,
    );
  }
}

// budget gate math (median, f32 = the sim's presumptive choice)
const rigStepsPerSec = 1e9 / results.f32.rig.nsPerStepMed;
const fleetNsPerBeam = results.f32.fleet.nsPerBeam;
const gateBeams = 3500 + 2 * 1500; // player rig + 2 awake traffic rigs (validator budgets)
const pctCore = (gateBeams * 2000 * fleetNsPerBeam) / 1e9 * 100;
const mBeamUpdatesPerSec = 1e3 / fleetNsPerBeam; // millions, fleet-scale f32

console.log(`\nplayer rig (f32): ${Math.round(rigStepsPerSec)} steps/s -> ` +
  `${round2(rigStepsPerSec / 2000)}x headroom over the 2000 Hz target`);
console.log(`fleet-scale f32: ${round2(fleetNsPerBeam)} ns/beam = ${round2(mBeamUpdatesPerSec)} M beam-updates/s/core`);
console.log(`(3500 + 2x1500) beams @ 2 kHz: ${round2(pctCore)}% of one core`);
console.log(`budget gate (plan: total awake ~10 M beam-updates/s must fit): ` +
  `${mBeamUpdatesPerSec >= 10 && pctCore < 100 ? 'PASS' : 'FAIL'}`);
console.log('NaN guard: all positions finite in all 4 worlds');

console.log(JSON.stringify({
  nsPerBeam: {
    f32: { rig: round2(results.f32.rig.nsPerBeam), fleet: round2(results.f32.fleet.nsPerBeam) },
    f64: { rig: round2(results.f64.rig.nsPerBeam), fleet: round2(results.f64.fleet.nsPerBeam) },
  },
  nsPerNode: {
    f32: { rig: round2(results.f32.rig.nsPerNode), fleet: round2(results.f32.fleet.nsPerNode) },
    f64: { rig: round2(results.f64.rig.nsPerNode), fleet: round2(results.f64.fleet.nsPerNode) },
  },
  stepsPerSec2kHzPlayerRig: Math.round(rigStepsPerSec),
  pctCoreFor2kHz_3500p_2x1500t: round2(pctCore),
}));
