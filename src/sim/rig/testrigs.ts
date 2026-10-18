/**
 * Reference rigs for the P1 demos and kernel tests. PURE DATA (see
 * docs/CONTRACTS.md boundary amendment): returns plain-JSON RigDefs.
 * All rigs are authored in rig-local space; the spawn transform places them.
 */
import type { RigBeamDef, RigDef, RigNodeDef } from './types';

const DT = 1 / 2000;

export interface SoftCubeOptions {
  /** Edge length, m. Default 1.5. */
  size?: number;
  /** Cells per edge (nodes per edge = seg + 1). Default 3. */
  seg?: number;
  /** kg, spread evenly over all nodes. Default 60. */
  totalMass?: number;
  /** Worst-node ω·dt the beam stiffness is solved for. Default 0.2. */
  targetOmegaDt?: number;
  /** Worst-node (Σd/m)·dt the beam damping is solved for. Default 0.25. */
  targetDampDt?: number;
  /** Override solved per-beam stiffness, N/m. */
  k?: number;
  /** Override solved per-beam damping, N·s/m. */
  d?: number;
  /** Plastic threshold, N. Default derived (see softCube). */
  deform?: number;
  /** Break force, N. Default derived (see softCube). */
  breakF?: number;
  friction?: number;
  /** Contact radius, m. Default 0.3 × node spacing. */
  radius?: number;
  name?: string;
}

/**
 * seg³ lattice cube centred on the origin, (seg+1)³ nodes, with edge,
 * face-diagonal (both per square face) and body-diagonal (4 per cell) beams,
 * all type 'normal' and of equal k/d.
 *
 * Tuning math (defaults: size 1.5, seg 3 → 64 nodes, h = 0.5 m, m = 60/64 = 0.9375 kg):
 * - Interior node valence = 6 edges + 12 face diagonals + 8 body diagonals = 26.
 * - ω·dt = sqrt(26·k/m)·dt = 0.2  →  k = (0.2/dt)²·m/26 = 160000·0.9375/26 ≈ 5769 N/m.
 * - (Σd/m)·dt = 26·d·dt/m = 0.25 →  d = 0.25·m/(26·dt) ≈ 18 N·s/m
 *   (single-beam ζ = d / (2·sqrt(k·m/2)) ≈ 0.17).
 * - Vertical layer stiffness ≈ 16 edges·k + 48 face diags·k/2 + 36 body diags·k/3 = 52k ≈ 3.0e5 N/m;
 *   3 layers in series → K ≈ 1.0e5 N/m. Static sag under 589 N < 1 cm (holds shape).
 * - 6 m drop: v = sqrt(2·g·6) ≈ 10.9 m/s, E ≈ 3.5 kJ. Rigid-ground squish
 *   x ≈ sqrt(2E/K) ≈ 0.27 m upper bound; a scratch drop sim (this kernel model, penalty ground)
 *   gave ≈ 0.22 m (15 % of the edge: visible) with peak elastic beam force ≈ 580 N.
 * - deform = 0.15·k·h ≈ 433 N (15 % strain): ~30 bottom-layer beams yield briefly → ≈ 1–2 cm
 *   permanent sag (slight). breakF = 0.6·k·h ≈ 1730 N (60 % strain, 3× the peak) → no breakage.
 */
export function softCube(opts: SoftCubeOptions = {}): RigDef {
  const size = opts.size ?? 1.5;
  const seg = Math.max(1, Math.floor(opts.seg ?? 3));
  const totalMass = opts.totalMass ?? 60;
  const targetOmegaDt = opts.targetOmegaDt ?? 0.2;
  const targetDampDt = opts.targetDampDt ?? 0.25;
  const n1 = seg + 1;
  const h = size / seg;
  const nodeMass = totalMass / (n1 * n1 * n1);
  // Max valence: interior node (seg ≥ 2) has 26 beams; seg = 1 corners have 7.
  const maxValence = seg >= 2 ? 26 : 7;
  const k = opts.k ?? round3(((targetOmegaDt / DT) ** 2 * nodeMass) / maxValence);
  const d = opts.d ?? round3((targetDampDt * nodeMass) / (maxValence * DT));
  const deform = opts.deform ?? round3(0.15 * k * h);
  const breakF = opts.breakF ?? round3(0.6 * k * h);

  const id = (x: number, y: number, z: number): string => `n${x}_${y}_${z}`;
  const nodes: RigNodeDef[] = [];
  const half = size / 2;
  for (let y = 0; y < n1; y++) {
    for (let z = 0; z < n1; z++) {
      for (let x = 0; x < n1; x++) {
        nodes.push({
          id: id(x, y, z),
          pos: [x * h - half, y * h - half, z * h - half],
          mass: nodeMass,
          group: 'cube',
        });
      }
    }
  }

  const beams: RigBeamDef[] = [];
  const add = (a: string, b: string): void => {
    beams.push({ a, b, type: 'normal', k, d, deform, breakF });
  };
  // Edges.
  for (let y = 0; y < n1; y++)
    for (let z = 0; z < n1; z++)
      for (let x = 0; x < n1; x++) {
        if (x < seg) add(id(x, y, z), id(x + 1, y, z));
        if (y < seg) add(id(x, y, z), id(x, y + 1, z));
        if (z < seg) add(id(x, y, z), id(x, y, z + 1));
      }
  // Face diagonals: both diagonals of every lattice square in each axis plane.
  for (let y = 0; y < n1; y++)
    for (let z = 0; z < n1; z++)
      for (let x = 0; x < n1; x++) {
        if (x < seg && y < seg) {
          add(id(x, y, z), id(x + 1, y + 1, z));
          add(id(x + 1, y, z), id(x, y + 1, z));
        }
        if (x < seg && z < seg) {
          add(id(x, y, z), id(x + 1, y, z + 1));
          add(id(x + 1, y, z), id(x, y, z + 1));
        }
        if (y < seg && z < seg) {
          add(id(x, y, z), id(x, y + 1, z + 1));
          add(id(x, y + 1, z), id(x, y, z + 1));
        }
      }
  // Body diagonals: 4 per cell.
  for (let y = 0; y < seg; y++)
    for (let z = 0; z < seg; z++)
      for (let x = 0; x < seg; x++) {
        add(id(x, y, z), id(x + 1, y + 1, z + 1));
        add(id(x + 1, y, z), id(x, y + 1, z + 1));
        add(id(x, y + 1, z), id(x + 1, y, z + 1));
        add(id(x, y, z + 1), id(x + 1, y + 1, z));
      }

  return {
    name: opts.name ?? 'softCube',
    nodes,
    beams,
    groupDefaults: {
      cube: { friction: opts.friction ?? 0.8, radius: opts.radius ?? round3(0.3 * h) },
    },
  };
}

function round3(v: number): number {
  const p = 10 ** (3 - Math.ceil(Math.log10(Math.abs(v) || 1)));
  return Math.round(v * p) / p;
}

/**
 * Pinned anchor at the origin + 1 m horizontal beam + 5 kg bob: released, it
 * swings down (small-angle period 2π·sqrt(1/9.81) ≈ 2.006 s).
 * k = 1e6 → ω·dt = sqrt(1e6/5)/2000 ≈ 0.224; d = 200 → (d/m)·dt = 0.02.
 * Bottom-of-swing tension 3mg ≈ 147 N stretches it 0.15 mm. Never deforms or breaks.
 */
export function beamPendulum(): RigDef {
  return {
    name: 'beamPendulum',
    nodes: [
      { id: 'anchor', pos: [0, 0, 0], mass: 0, collidable: false },
      { id: 'bob', pos: [1, 0, 0], mass: 5, radius: 0.1 },
    ],
    beams: [{ a: 'anchor', b: 'bob', type: 'normal', k: 1e6, d: 200, deform: 0, breakF: 0 }],
  };
}

/**
 * Pinned anchor at the origin, 8-link chain laid out along +X (0.5 m links),
 * and a 7-node octahedral ball cluster (r = 0.4 m, ≈ 400 kg) on the end;
 * released, it swings down through the origin's vertical.
 * Chain: 5 kg nodes, k 1e6 → ω·dt = sqrt(2e6/5)/2000 ≈ 0.316.
 * Ball: 400/7 kg nodes, 6 beams each at k 4e6 (+1e6 chain on the hook)
 *   → ω·dt ≈ sqrt(2.5e7/57.1)/2000 ≈ 0.331.
 * Peak swing tension ≈ 3·440·g ≈ 13 kN ≪ chain breakF 1e6.
 */
export function wreckingBall(): RigDef {
  const LINKS = 8;
  const LINK = 0.5;
  const R = 0.4;
  const ballMass = 400 / 7;
  const nodes: RigNodeDef[] = [{ id: 'anchor', pos: [0, 0, 0], mass: 0, collidable: false }];
  const beams: RigBeamDef[] = [];
  const chainBeam = (a: string, b: string): RigBeamDef => ({
    a,
    b,
    type: 'normal',
    k: 1e6,
    d: 300,
    deform: 0,
    breakF: 1e6,
  });
  let prev = 'anchor';
  for (let i = 1; i <= LINKS; i++) {
    const id = `c${i}`;
    nodes.push({ id, pos: [i * LINK, 0, 0], mass: 5, group: 'chain' });
    beams.push(chainBeam(prev, id));
    prev = id;
  }
  const cx = (LINKS + 1) * LINK + R;
  const ball: [string, [number, number, number]][] = [
    ['ballHook', [cx - R, 0, 0]],
    ['ballCenter', [cx, 0, 0]],
    ['ballFar', [cx + R, 0, 0]],
    ['ballUp', [cx, R, 0]],
    ['ballDown', [cx, -R, 0]],
    ['ballFront', [cx, 0, R]],
    ['ballBack', [cx, 0, -R]],
  ];
  for (const [id, pos] of ball) {
    nodes.push({ id, pos, mass: ballMass, group: 'ball', collidable: id !== 'ballCenter' });
  }
  beams.push(chainBeam(prev, 'ballHook'));
  const ballBeam = (a: string, b: string): RigBeamDef => ({ a, b, type: 'normal', k: 4e6, d: 2000, deform: 0, breakF: 0 });
  const shell = ['ballHook', 'ballFar', 'ballUp', 'ballDown', 'ballFront', 'ballBack'];
  for (const s of shell) beams.push(ballBeam('ballCenter', s));
  // Octahedron edges: every shell pair except the 3 opposite pairs.
  const opposite: Record<string, string> = {
    ballHook: 'ballFar',
    ballFar: 'ballHook',
    ballUp: 'ballDown',
    ballDown: 'ballUp',
    ballFront: 'ballBack',
    ballBack: 'ballFront',
  };
  for (let i = 0; i < shell.length; i++)
    for (let j = i + 1; j < shell.length; j++) {
      const a = shell[i]!;
      const b = shell[j]!;
      if (opposite[a] !== b) beams.push(ballBeam(a, b));
    }
  // Opposite pairs (through-beams) for torsional rigidity.
  beams.push(ballBeam('ballHook', 'ballFar'), ballBeam('ballUp', 'ballDown'), ballBeam('ballFront', 'ballBack'));
  return {
    name: 'wreckingBall',
    nodes,
    beams,
    groupDefaults: {
      chain: { friction: 0.4, radius: 0.06 },
      ball: { friction: 0.6, radius: 0.25 },
    },
  };
}
