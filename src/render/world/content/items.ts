/**
 * Instanced static items (R-WORLD render): street furniture, parked cars,
 * power poles, signal masts, fuel pumps, the gas canopy… One procedural mesh
 * per (kind, part) in a local frame (origin on the ground, front = −Z,
 * metres), instanced per spatial cell (CELL_M) so off-screen cells cull;
 * every kind has a draw distance. Parts flagged `tint` take the instance
 * colour (parked-car paint, awning canvas). Signal heads are a separate
 * instanced lamp mesh whose colours follow signalAspect every frame.
 */
import {
  Float32BufferAttribute,
  Matrix3,
  Mesh,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  BufferGeometry,
  type Camera,
  type Group,
  type Material,
} from 'three';
import type { ItemInstance } from '../../../world/content/types';
import { signalAspect, SIGNAL_TICK_HZ, type SignalPlan } from '../../../world/signals';
import { Geo, linear, type V3 } from './geo';

const CELL_M = 384;
/** Kinds whose variants are separate meshes (key `kind:variant`). */
const VARIANT_KEYED = new Set(['parkedCar', 'boulder', 'litter', 'chevron']);

interface Part {
  geo: Geo;
  tint: boolean;
  material: 'paint' | 'metal' | 'glass' | 'emissive';
}
interface KindDef {
  parts: Part[];
  /** Draw distance, m. */
  far: number;
  shadows: boolean;
}

const Y = (a: number): [number, number, number, number] => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const I: [number, number, number, number] = [0, 0, 0, 1];

function part(material: Part['material'], tint = false): Part {
  return { geo: new Geo(true), tint, material };
}

/** Low-poly parked car: body (paint), glasshouse (dark glass), wheels / bumpers (dark), lamps. */
function carParts(variant: number): Part[] {
  const body = part('paint', true);
  const glass = part('glass');
  const dark = part('metal');
  const L = variant === 2 ? 2.7 : variant === 1 ? 2.05 : 2.35; // half length
  const W = 0.9;
  const sill = 0.32;
  const belt = 0.92;
  const roof = variant === 2 ? 1.45 : 1.42;
  body.geo.color = [1, 1, 1];
  // lower body (rounded ends approximated by tapered boxes)
  body.geo.box([0, (sill + belt) / 2, 0], I, W, (belt - sill) / 2, L - 0.15);
  body.geo.box([0, (sill + belt) / 2 - 0.05, -L + 0.12], I, W - 0.04, (belt - sill) / 2 - 0.05, 0.14);
  body.geo.box([0, (sill + belt) / 2 - 0.05, L - 0.12], I, W - 0.04, (belt - sill) / 2 - 0.05, 0.14);
  if (variant === 2) {
    // pickup: cab + bed walls
    glass.geo.color = linear(0x151a1f);
    glass.geo.box([0, (belt + roof) / 2, -0.55], I, W - 0.08, (roof - belt) / 2, 0.75);
    body.geo.box([0, roof + 0.02, -0.55], I, W - 0.1, 0.03, 0.7);
    body.geo.box([W - 0.06, belt + 0.25, 1.35], I, 0.06, 0.25, 1.25);
    body.geo.box([-W + 0.06, belt + 0.25, 1.35], I, 0.06, 0.25, 1.25);
    body.geo.box([0, belt + 0.25, L - 0.06], I, W, 0.25, 0.06);
  } else {
    const front = variant === 1 ? -0.55 : -0.85;
    const back = variant === 1 ? 1.75 : 1.2;
    glass.geo.color = linear(0x151a1f);
    // glasshouse as a tapered prism: bottom at belt, top at roof
    const gw = W - 0.06;
    const tw = W - 0.2;
    const pts = (y: number, w: number, z0: number, z1: number): V3[] => [
      [-w, y, z0],
      [w, y, z0],
      [w, y, z1],
      [-w, y, z1],
    ];
    const b = pts(belt, gw, front, back);
    const t = pts(roof, tw, front + 0.45, back - (variant === 1 ? 0.15 : 0.4));
    for (let k = 0; k < 4; k++) glass.geo.poly([b[k]!, b[(k + 1) % 4]!, t[(k + 1) % 4]!, t[k]!]);
    body.geo.poly([t[3]!, t[2]!, t[1]!, t[0]!].reverse());
  }
  dark.geo.color = linear(0x1b1c1e);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) dark.geo.cylinder([sx * (W - 0.12), 0.33, sz * (L - 0.62)], [sx * (W + 0.02), 0.33, sz * (L - 0.62)], 0.33, 10, true);
  }
  dark.geo.box([0, 0.38, -L], I, W, 0.08, 0.05);
  dark.geo.box([0, 0.38, L], I, W, 0.08, 0.05);
  const lamps = part('emissive');
  lamps.geo.color = linear(0xfff2d8);
  lamps.geo.box([0.62, 0.72, -L - 0.01], I, 0.18, 0.06, 0.02);
  lamps.geo.box([-0.62, 0.72, -L - 0.01], I, 0.18, 0.06, 0.02);
  lamps.geo.color = linear(0x8a0e0a);
  lamps.geo.box([0.66, 0.78, L + 0.01], I, 0.14, 0.07, 0.02);
  lamps.geo.box([-0.66, 0.78, L + 0.01], I, 0.14, 0.07, 0.02);
  return [body, glass, dark, lamps];
}

function simple(build: (g: Geo, m: Geo, e: Geo) => void, far: number, shadows = true): KindDef {
  const p = part('paint');
  const m = part('metal');
  const e = part('emissive');
  build(p.geo, m.geo, e.geo);
  return { parts: [p, m, e].filter((x) => x.geo.vertexCount > 0), far, shadows };
}

function kindDefs(): Map<string, KindDef> {
  const k = new Map<string, KindDef>();
  for (let v = 0; v < 3; v++) k.set(`parkedCar:${v}`, { parts: carParts(v), far: 420, shadows: true });
  k.set(
    'bench',
    simple((g, m) => {
      g.color = linear(0x6b4a2e);
      for (let i = 0; i < 4; i++) g.box([0, 0.45, -0.15 + i * 0.1], I, 0.85, 0.02, 0.04);
      for (let i = 0; i < 3; i++) g.box([0, 0.62 + i * 0.12, 0.27], I, 0.85, 0.045, 0.02);
      m.color = linear(0x2b2d30);
      for (const sx of [-0.75, 0.75]) {
        m.box([sx, 0.22, 0], I, 0.03, 0.22, 0.25);
        m.box([sx, 0.6, 0.27], I, 0.03, 0.2, 0.02);
      }
    }, 140),
  );
  k.set(
    'bin',
    simple((g, m) => {
      g.color = linear(0x2f4a3c);
      g.cylinder([0, 0, 0], [0, 0.85, 0], 0.28, 12, true);
      m.color = linear(0x1e2022);
      m.cylinder([0, 0.85, 0], [0, 0.95, 0], 0.3, 12, true);
    }, 140),
  );
  k.set(
    'newsBox',
    simple((g) => {
      g.color = linear(0x2a5c9a);
      g.box([0, 0.55, 0], I, 0.25, 0.42, 0.22);
      g.color = linear(0xe8e8e8);
      g.box([0, 0.75, -0.225], I, 0.18, 0.12, 0.005);
    }, 120),
  );
  k.set(
    'planter',
    simple((g) => {
      g.color = linear(0x8a8580);
      g.box([0, 0.3, 0], I, 0.5, 0.3, 0.5);
      g.color = linear(0x2f5a24);
      g.box([0, 0.72, 0], I, 0.42, 0.14, 0.42);
    }, 140),
  );
  k.set(
    'hydrant',
    simple((g) => {
      g.color = linear(0xb81d16);
      g.cylinder([0, 0, 0], [0, 0.62, 0], 0.11, 10, true);
      g.cylinder([0, 0.62, 0], [0, 0.72, 0], 0.08, 10, true, 0.02);
      g.cylinder([-0.18, 0.42, 0], [0.18, 0.42, 0], 0.05, 8, true);
    }, 110),
  );
  k.set(
    'mailbox',
    simple((g, m) => {
      m.color = linear(0x4a3a2a);
      m.box([0, 0.5, 0], I, 0.05, 0.5, 0.05);
      g.color = linear(0x2b2d30);
      g.box([0, 1.08, 0], I, 0.13, 0.11, 0.26);
      g.cylinder([0, 1.19, -0.26], [0, 1.19, 0.26], 0.13, 10, true);
      g.color = linear(0xb81d16);
      g.box([0.14, 1.15, 0.12], I, 0.01, 0.1, 0.03);
    }, 110),
  );
  k.set(
    'treeGrate',
    simple((g) => {
      g.color = linear(0x3b3f43);
      g.box([0, 0.01, 0], I, 0.6, 0.01, 0.6, 4);
    }, 90, false),
  );
  k.set(
    'awning',
    {
      parts: (() => {
        const p = part('paint', true);
        p.geo.color = [1, 1, 1];
        // unit width (scaled per instance along X by the shop's half width): sloped canvas at 3 m
        p.geo.poly([[-1, 3.1, 0], [1, 3.1, 0], [1, 2.6, -1.4], [-1, 2.6, -1.4]]);
        p.geo.poly([[-1, 2.6, -1.4], [1, 2.6, -1.4], [1, 2.35, -1.4], [-1, 2.35, -1.4]]);
        return [p];
      })(),
      far: 260,
      shadows: true,
    },
  );
  k.set(
    'powerPole',
    simple((g, m) => {
      g.color = linear(0x5a4632);
      g.cylinder([0, -0.3, 0], [0, 9.2, 0], 0.15, 8, true, 0.11);
      g.box([0, 8.7, 0], I, 1.0, 0.06, 0.07);
      m.color = linear(0x9aa0a6);
      for (const x of [-0.7, 0, 0.7]) m.cylinder([x, 8.76, 0], [x, 8.95, 0], 0.04, 6, true);
      m.color = linear(0x6e7377);
      m.cylinder([0.25, 7.6, 0.12], [0.25, 8.2, 0.12], 0.22, 10, true);
    }, 520),
  );
  k.set(
    'signalMast',
    simple((g, m) => {
      // pole + arm of unit length along −X (scaled per instance to reach over the lanes); heads are the lamp mesh
      m.color = linear(0x3b3e41);
      m.cylinder([0, -0.2, 0], [0, 6.9, 0], 0.15, 10, true, 0.12);
      m.cylinder([0, 6.7, 0], [-1, 6.7, 0], 0.07, 8, true);
      g.color = linear(0x23262a);
      g.box([-1, 6.05, 0], I, 0.2, 0.5, 0.14);
      g.box([0, 2.9, 0.18], I, 0.16, 0.36, 0.12); // pedestrian box
    }, 520),
  );
  k.set(
    'fuelPump',
    simple((g, m, e) => {
      g.color = linear(0xe9e7e1);
      g.box([0, 0.85, 0], I, 0.32, 0.85, 0.25);
      g.color = linear(0xc52b22);
      g.box([0, 1.6, 0], I, 0.34, 0.12, 0.27);
      m.color = linear(0x1e2022);
      m.box([0.34, 0.95, 0], I, 0.03, 0.25, 0.08);
      e.color = linear(0x9ad0ff);
      e.box([0, 1.22, -0.255], I, 0.2, 0.12, 0.005);
    }, 180),
  );
  k.set(
    'gasCanopy',
    simple((g, m, e) => {
      g.color = linear(0xf2f2f0);
      g.box([0, 5.4, 0], I, 9.5, 0.45, 6.5);
      g.color = linear(0xc52b22);
      g.box([0, 5.4, -6.52], I, 9.5, 0.3, 0.02);
      g.box([0, 5.4, 6.52], I, 9.5, 0.3, 0.02);
      m.color = linear(0xd6d6d6);
      for (const x of [-7.5, 7.5]) for (const z of [-4.5, 4.5]) m.box([x, 2.5, z], I, 0.22, 2.5, 0.22);
      // pump islands (colliders w:gas:island*): raised concrete with yellow-nosed ends and bollards
      for (const x of [-4.5, 4.5]) {
        g.color = linear(0xb9b5ac);
        g.box([x, 0.1, 0], I, 0.7, 0.1, 3.2);
        g.color = linear(0xe0b21c);
        g.box([x, 0.101, -3.05], I, 0.71, 0.101, 0.16);
        g.box([x, 0.101, 3.05], I, 0.71, 0.101, 0.16);
        for (const z of [-2.85, 2.85]) g.cylinder([x, 0.2, z], [x, 1.1, z], 0.09, 8, true);
      }
      e.color = linear(0xffffff);
      for (const x of [-6, -2, 2, 6]) for (const z of [-3, 3]) e.box([x, 4.93, z], I, 0.6, 0.01, 0.3);
    }, 600),
  );
  k.set(
    'priceSign',
    simple((g, m, e) => {
      m.color = linear(0x8c9196);
      m.box([0, 2, 0], I, 0.12, 2, 0.12);
      g.color = linear(0xc52b22);
      g.box([0, 4.6, 0], I, 1.1, 0.6, 0.15);
      e.color = linear(0xfff2c0);
      e.box([0, 4.45, -0.16], I, 0.9, 0.32, 0.005);
    }, 500),
  );
  // ---- mode areas (R-WORLD unit: areas)
  k.set(
    'floodMast',
    simple((g, m, e) => {
      // 18 m lattice-look mast (scaled per instance), head frame with 6 lamps aimed along −Z
      m.color = linear(0x9aa0a6);
      m.cylinder([0, -0.3, 0], [0, 18, 0], 0.22, 8, true, 0.14);
      m.box([0, 18.2, -0.2], I, 1.6, 0.6, 0.08);
      e.color = linear(0xf2f4ff);
      for (let i = 0; i < 6; i++) e.box([-1.2 + (i % 3) * 1.2, 18.0 + Math.floor(i / 3) * 0.55, -0.32], I, 0.42, 0.22, 0.04);
      g.color = linear(0x5a5f63);
      g.box([0, 0.6, 0.4], I, 0.3, 0.5, 0.2);
    }, 1400),
  );
  k.set('truck', {
    parts: (() => {
      const body = part('paint', true);
      body.geo.color = [1, 1, 1];
      body.geo.box([0, 2.1, 1.2], I, 1.25, 1.6, 6.2); // box trailer
      body.geo.box([0, 1.7, -6.2], I, 1.2, 1.25, 1.2); // cab
      const dark = part('metal');
      dark.geo.color = linear(0x1b1c1e);
      for (const z of [-6.4, 3.8, 5.2]) for (const sx of [-1, 1]) dark.geo.cylinder([sx * 1.05, 0.5, z], [sx * 1.3, 0.5, z], 0.5, 10, true);
      dark.geo.box([0, 0.55, -0.5], I, 0.6, 0.15, 6.8);
      const glass = part('glass');
      glass.geo.color = linear(0x151a1f);
      glass.geo.box([0, 2.3, -7.41], I, 1.05, 0.45, 0.02);
      return [body, dark, glass];
    })(),
    far: 700,
    shadows: true,
  });
  k.set(
    'distanceBoard',
    simple((g, m) => {
      m.color = linear(0x8c9196);
      m.box([0, 0.9, 0], I, 0.05, 0.9, 0.05);
      g.color = linear(0xf2f2f0);
      g.box([0, 1.7, -0.06], I, 0.6, 0.45, 0.02);
      g.color = linear(0x1a1a1c);
      // stripes = hundreds (1–3 bars by variant via scale is not available: draw 3, darker for the rest)
      for (let i = 0; i < 3; i++) g.box([0, 1.45 + i * 0.25, -0.085], I, 0.45, 0.05, 0.005);
    }, 400),
  );
  k.set(
    'beamPost',
    simple((g, m, e) => {
      m.color = linear(0x2b2d30);
      m.box([0, 0.55, 0], I, 0.09, 0.55, 0.09);
      g.color = linear(0xe0b21c);
      g.box([0, 0.75, -0.1], I, 0.12, 0.1, 0.03);
      e.color = linear(0xff3a2a);
      e.box([0, 0.75, -0.135], I, 0.03, 0.03, 0.005);
    }, 300),
  );
  k.set(
    'windsock',
    simple((g, m) => {
      m.color = linear(0xd0d3d6);
      m.cylinder([0, 0, 0], [0, 6, 0], 0.06, 8, true);
      g.color = linear(0xff6a1a);
      g.cylinder([0, 5.8, 0], [1.6, 5.6, 0], 0.35, 10, false, 0.18);
      g.color = linear(0xf2f2f0);
      g.cylinder([0.55, 5.74, 0], [0.95, 5.68, 0], 0.3, 10, false, 0.26);
    }, 900),
  );
  k.set(
    'cameraTower',
    simple((g, m) => {
      m.color = linear(0x8c9196);
      for (const sx of [-0.4, 0.4]) for (const sz of [-0.4, 0.4]) m.box([sx, 2, sz], I, 0.04, 2, 0.04);
      m.box([0, 4.05, 0], I, 0.55, 0.05, 0.55);
      g.color = linear(0x1a1a1c);
      g.box([0, 4.3, -0.1], I, 0.15, 0.15, 0.3);
      g.box([0, 1.0, 0], I, 0.5, 0.03, 0.5);
    }, 300),
  );
  k.set('container', {
    parts: (() => {
      const body = part('paint', true);
      body.geo.color = [1, 1, 1];
      // 40 ft box with corrugated sides (ribs as thin boxes), doors at +Z
      body.geo.box([0, 1.295, 0], I, 1.22, 1.295, 6.06);
      for (let i = 0; i < 30; i++) {
        const z = -5.8 + i * 0.4;
        body.geo.box([1.235, 1.3, z], I, 0.02, 1.18, 0.07, 1);
        body.geo.box([-1.235, 1.3, z], I, 0.02, 1.18, 0.07, 2);
      }
      const dark = part('metal');
      dark.geo.color = linear(0x2b2d30);
      for (const sx of [-1, 1]) dark.geo.box([sx * 0.5, 1.3, 6.075], I, 0.02, 1.15, 0.01);
      for (const sx of [-1.1, 1.1]) for (const sz of [-5.95, 5.95]) dark.geo.box([sx, 1.295, sz], I, 0.12, 1.3, 0.12);
      return [body, dark];
    })(),
    far: 700,
    shadows: true,
  });
  k.set(
    'wreckDamage',
    simple((g) => {
      // crumpled-panel shards, flat tyres and rust patches laid over a parked-car body
      g.color = linear(0x3a2418);
      g.box([0.6, 0.95, -1.6], Y(0.4), 0.35, 0.08, 0.5);
      g.box([-0.5, 0.75, 1.9], Y(-0.3), 0.4, 0.15, 0.3);
      g.color = linear(0x15161a);
      g.box([0, 0.08, 0], I, 0.95, 0.08, 2.0);
      g.color = linear(0x5a3a22);
      g.box([0, 1.43, 0.2], I, 0.62, 0.02, 0.5);
    }, 400),
  );
  for (let v = 0; v < 4; v++) {
    k.set(
      `boulder:${v}`,
      simple((g) => {
        // faceted rock: an irregular octahedron-ish hull, unit radius (scaled per instance), half buried
        g.color = linear(0x8a8478);
        const pts: V3[] = [];
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          const r = 0.85 + 0.15 * Math.sin(i * 2.7 + v);
          pts.push([Math.cos(a) * r, (i % 2) * 0.5 - 0.35, Math.sin(a) * r * 0.9]);
        }
        const top: V3 = [0.1, 0.7, -0.05];
        const ring = pts.filter((_, i) => i % 2 === 1);
        const low = pts.filter((_, i) => i % 2 === 0);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % ring.length]!;
          const la = low[i]!;
          const lb = low[(i + 1) % low.length]!;
          g.poly([top, b, a]);
          g.poly([a, b, lb, la]);
        }
      }, 500),
    );
  }
  k.set(
    'markerPost',
    simple((g) => {
      g.color = linear(0xff6a1a);
      g.box([0, 0.6, 0], I, 0.05, 0.6, 0.05);
      g.color = linear(0xf2f2f0);
      g.box([0, 1.0, 0], I, 0.052, 0.08, 0.052);
    }, 250),
  );
  k.set(
    'tapePost',
    simple((g) => {
      g.color = linear(0xc9b48a);
      g.box([0, 0.5, 0], I, 0.025, 0.55, 0.025);
    }, 200),
  );
  k.set('spectator', {
    parts: (() => {
      const jacket = part('paint', true);
      jacket.geo.color = [1, 1, 1];
      jacket.geo.box([0, 1.22, 0], I, 0.21, 0.29, 0.12);
      jacket.geo.box([0.27, 1.2, 0], Y(0), 0.06, 0.28, 0.06);
      jacket.geo.box([-0.27, 1.2, 0], Y(0), 0.06, 0.28, 0.06);
      const other = part('metal');
      other.geo.color = linear(0x2a3346);
      other.geo.box([0.1, 0.46, 0], I, 0.08, 0.46, 0.08);
      other.geo.box([-0.1, 0.46, 0], I, 0.08, 0.46, 0.08);
      other.geo.color = linear(0xd8a888);
      other.geo.cylinder([0, 1.5, 0], [0, 1.72, 0], 0.1, 8, true, 0.09);
      other.geo.color = linear(0x2b2117);
      other.geo.cylinder([0, 1.7, 0], [0, 1.77, 0], 0.105, 8, true, 0.08);
      return [jacket, other];
    })(),
    far: 260,
    shadows: true,
  });
  k.set(
    'binoculars',
    simple((g, m) => {
      m.color = linear(0x5a5f63);
      m.cylinder([0, 0, 0], [0, 1.1, 0], 0.05, 8, true);
      g.color = linear(0x2f6b3a);
      g.box([0, 1.25, 0], I, 0.18, 0.12, 0.2);
      g.cylinder([0.08, 1.3, -0.2], [0.08, 1.3, -0.32], 0.05, 8, true);
      g.cylinder([-0.08, 1.3, -0.2], [-0.08, 1.3, -0.32], 0.05, 8, true);
    }, 150),
  );
  k.set(
    'hayBale',
    simple((g) => {
      g.color = linear(0xc9a85a);
      g.cylinder([-0.6, 0.7, 0], [0.6, 0.7, 0], 0.7, 12, true);
    }, 400),
  );
  k.set(
    'tractor',
    simple((g, m) => {
      g.color = linear(0x2f7a3a);
      g.box([0, 1.1, -0.6], I, 0.5, 0.45, 1.1);
      g.box([0, 1.6, 0.6], I, 0.6, 0.7, 0.6);
      m.color = linear(0x1b1c1e);
      for (const sx of [-1, 1]) {
        m.cylinder([sx * 0.75, 0.8, 0.8], [sx * 1.15, 0.8, 0.8], 0.8, 14, true);
        m.cylinder([sx * 0.6, 0.45, -1.3], [sx * 0.9, 0.45, -1.3], 0.45, 12, true);
      }
      m.cylinder([0.3, 1.5, -1.2], [0.3, 2.4, -1.2], 0.05, 6, true);
    }, 400),
  );
  k.set(
    'campfire',
    simple((g, m, e) => {
      m.color = linear(0x6e6a64);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        m.box([Math.cos(a) * 0.7, 0.1, Math.sin(a) * 0.7], Y(a), 0.16, 0.12, 0.12);
      }
      g.color = linear(0x3a2a1c);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI;
        g.cylinder([Math.cos(a) * 0.45, 0.05, Math.sin(a) * 0.45], [-Math.cos(a) * 0.1, 0.4, -Math.sin(a) * 0.1], 0.06, 6, true);
      }
      e.color = linear(0xff8a2a);
      e.cylinder([0, 0.05, 0], [0, 0.45, 0], 0.22, 6, true, 0.02);
    }, 250),
  );
  k.set('tent', {
    parts: (() => {
      const fly = part('paint', true);
      fly.geo.color = [1, 1, 1];
      // ridge tent 2.2 × 1.6 m, 1.2 m high, door at −Z
      const P: V3[] = [
        [-0.8, 0, -1.1],
        [0.8, 0, -1.1],
        [0.8, 0, 1.1],
        [-0.8, 0, 1.1],
        [0, 1.2, -1.1],
        [0, 1.2, 1.1],
      ];
      fly.geo.poly([P[1]!, P[2]!, P[5]!, P[4]!]);
      fly.geo.poly([P[3]!, P[0]!, P[4]!, P[5]!]);
      fly.geo.poly([P[2]!, P[3]!, P[5]!]);
      fly.geo.color = [0.25, 0.25, 0.25];
      fly.geo.poly([P[0]!, P[1]!, P[4]!]);
      return [fly];
    })(),
    far: 300,
    shadows: true,
  });
  k.set(
    'picnicTable',
    simple((g) => {
      g.color = linear(0x7a5a3a);
      g.box([0, 0.74, 0], I, 0.9, 0.03, 0.4);
      for (const sz of [-0.68, 0.68]) g.box([0, 0.45, sz], I, 0.9, 0.025, 0.14);
      for (const sx of [-0.7, 0.7]) {
        g.box([sx, 0.37, 0], I, 0.04, 0.37, 0.04);
        g.box([sx, 0.3, 0], I, 0.04, 0.03, 0.8);
      }
    }, 200),
  );
  // rally chevron board (variant 0 points right, 1 left), facing the approaching traffic
  for (let v = 0; v < 2; v++) {
    k.set(
      `chevron:${v}`,
      simple((g, m) => {
        m.color = linear(0x8c9196);
        m.box([0, 0.6, 0.03], I, 0.035, 0.6, 0.035);
        g.color = linear(0xf0c020);
        g.box([0, 1.25, 0], I, 0.42, 0.3, 0.015);
        g.color = linear(0x15161a);
        const sx = v === 0 ? 1 : -1;
        for (let i = 0; i < 2; i++) {
          const x = (i - 0.5) * 0.36;
          const Z = (a: number): [number, number, number, number] => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
          g.box([x, 1.33, -0.017], Z(sx * 0.6), 0.03, 0.1, 0.004);
          g.box([x, 1.17, -0.017], Z(-sx * 0.6), 0.03, 0.1, 0.004);
        }
      }, 300),
    );
  }
  // ---- natural detail (render-only; one mesh per kind per cell: few draws)
  k.set('flowers', {
    parts: (() => {
      // a patch of ~14 flower heads on short stems in a 1.2 m disc; heads take the instance colour
      const stems = part('paint');
      const heads = part('paint', true);
      heads.geo.color = [1, 1, 1];
      for (let i = 0; i < 14; i++) {
        const a = i * 2.39996;
        const r = 0.15 + 0.6 * Math.sqrt((i + 0.5) / 14);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const h = 0.22 + ((i * 37) % 11) / 30;
        stems.geo.color = linear(0x4c7a2a);
        stems.geo.box([x, h / 2, z], Y(a), 0.008, h / 2, 0.008, 63 & ~12);
        heads.geo.box([x, h + 0.02, z], Y(a), 0.035, 0.012, 0.035, 63 & ~8);
      }
      return [stems, heads];
    })(),
    far: 130,
    shadows: false,
  });
  k.set(
    'tussock',
    simple((g) => {
      // crossed blade fans (both windings), a few straw-coloured blades
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI;
        const lean = 0.18 + ((i * 13) % 7) / 30;
        const h = 0.6 + ((i * 7) % 5) / 20;
        const dx = Math.cos(a) * 0.12;
        const dz = Math.sin(a) * 0.12;
        const tip: V3 = [Math.cos(a + 1.3) * lean, h, Math.sin(a + 1.3) * lean];
        g.color = linear(i % 4 === 0 ? 0x9a9256 : 0x5d7a34);
        const A: V3 = [-dx, 0, -dz];
        const B: V3 = [dx, 0, dz];
        g.poly([A, B, tip]);
        g.poly([B, A, tip]);
      }
    }, 110, false),
  );
  k.set(
    'stones',
    simple((g) => {
      for (let i = 0; i < 7; i++) {
        const a = i * 2.1;
        const r = 0.3 + ((i * 17) % 7) / 10;
        const sz = 0.12 + ((i * 11) % 5) / 25;
        g.color = linear(i % 2 === 0 ? 0x8d877c : 0x76726a);
        g.box([Math.cos(a) * r, sz * 0.5, Math.sin(a) * r], Y(a * 1.7), sz * 1.2, sz, sz);
      }
    }, 160, false),
  );
  k.set(
    'litter:0',
    simple((g) => {
      g.color = linear(0xc42a1e); // crushed can
      g.cylinder([-0.06, 0.03, 0], [0.06, 0.03, 0.02], 0.032, 8, true, 0.026);
    }, 60, false),
  );
  k.set(
    'litter:1',
    simple((g) => {
      g.color = linear(0x3a6a3a); // bottle
      g.cylinder([-0.12, 0.035, 0], [0.08, 0.035, 0], 0.035, 8, true);
      g.cylinder([0.08, 0.035, 0], [0.15, 0.035, 0], 0.014, 6, true);
    }, 60, false),
  );
  k.set(
    'litter:2',
    simple((g) => {
      g.color = linear(0x1d1e20); // old tyre, half sunk
      g.cylinder([0, -0.05, 0], [0, 0.12, 0], 0.32, 12, true);
    }, 140, false),
  );
  k.set(
    'litter:3',
    simple((g) => {
      g.color = linear(0xd8d4c8); // bag
      g.box([0, 0.06, 0], Y(0.4), 0.18, 0.06, 0.12);
    }, 60, false),
  );
  return k;
}

export interface ItemsRenderer {
  readonly meshes: InstancedMesh[];
  update(camera: Camera, simTimeS: number): void;
  dispose(): void;
}

export function createItems(
  root: Group,
  items: readonly ItemInstance[],
  signals: readonly SignalPlan[],
  mats: { paint: Material; metal: Material; glass: Material; emissive: Material },
  groundAt: (x: number, z: number) => number,
): ItemsRenderer {
  const defs = kindDefs();
  const geoCache = new Map<string, BufferGeometry[]>();
  const geosOf = (key: string): BufferGeometry[] => {
    let g = geoCache.get(key);
    if (!g) {
      g = defs.get(key)!.parts.map((p) => p.geo.build());
      geoCache.set(key, g);
    }
    return g;
  };
  // Static furniture is MERGED (one mesh per material × shadow flag × draw-distance class × MERGE_CELL_M
  // cell, instance transform + tint baked in): a town block of 30 kinds costs a handful of draws instead
  // of one per kind and part. Dense natural detail stays instanced (vertex count).
  const merged = mergeItems(root, items, defs, mats, groundAt);
  // group instanced (detail) items by (key, cell)
  const groups = new Map<string, { key: string; list: ItemInstance[] }>();
  for (const it of items) {
    const key = VARIANT_KEYED.has(it.kind) ? `${it.kind}:${it.variant}` : it.kind;
    if (!defs.has(key) || !isDetail(key)) continue;
    const cx = Math.floor(it.pos[0] / CELL_M);
    const cz = Math.floor(it.pos[2] / CELL_M);
    const gk = `${key}|${cx}|${cz}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { key, list: [] }));
    g.list.push(it);
  }
  const meshes: InstancedMesh[] = [];
  const far: number[] = [];
  const m4 = new Matrix4();
  const q = new Quaternion();
  const pv = new Vector3();
  const sv = new Vector3();
  const col = new Color();
  for (const { key, list } of groups.values()) {
    const def = defs.get(key)!;
    const geos = geosOf(key);
    def.parts.forEach((p, pi) => {
      const mesh = new InstancedMesh(geos[pi]!, mats[p.material], list.length);
      list.forEach((it, i) => {
        const yaw = Math.atan2(-it.dir[0], -it.dir[1]);
        q.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        const y = it.pos[1] !== 0 ? it.pos[1] : groundAt(it.pos[0], it.pos[2]);
        pv.set(it.pos[0], y, it.pos[2]);
        if (key === 'awning') sv.set(it.scale, 1, 1);
        else if (key === 'signalMast') sv.set(it.scale - 0.6, 1, 1);
        else sv.set(it.scale, it.scale, it.scale);
        m4.compose(pv, q, sv);
        mesh.setMatrixAt(i, m4);
        if (p.tint) mesh.setColorAt(i, col.set(it.color ?? 0xffffff).convertSRGBToLinear());
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = def.shadows && p.material !== 'emissive' && p.material !== 'glass';
      mesh.receiveShadow = true;
      mesh.name = `worldContent:item:${key}`;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      meshes.push(mesh);
      far.push(def.far);
    });
  }
  // ---- signal heads: 3 lamps per head (red / amber / green), colours per frame
  const heads: { plan: number; leg: number; lamp: number }[] = [];
  const headM: Matrix4[] = [];
  for (const it of items) {
    if (it.kind !== 'signalMast') continue;
    const plan = Math.floor(it.variant / 64);
    const leg = it.variant % 64;
    const yaw = Math.atan2(-it.dir[0], -it.dir[1]);
    q.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    const y = it.pos[1] !== 0 ? it.pos[1] : groundAt(it.pos[0], it.pos[2]);
    const arm = it.scale - 0.6;
    for (let lamp = 0; lamp < 3; lamp++) {
      const local = new Vector3(-arm, 6.35 - lamp * 0.3, -0.15).applyQuaternion(q);
      pv.set(it.pos[0] + local.x, y + local.y, it.pos[2] + local.z);
      heads.push({ plan, leg, lamp });
      headM.push(new Matrix4().compose(pv.clone(), q.clone(), new Vector3(1, 1, 1)));
      // the pole-mounted repeater head
      const l2 = new Vector3(0.0, 3.25 - lamp * 0.24, 0.31).applyQuaternion(q);
      heads.push({ plan, leg, lamp });
      headM.push(new Matrix4().compose(new Vector3(it.pos[0] + l2.x, y + l2.y, it.pos[2] + l2.z), q.clone(), new Vector3(0.75, 0.75, 0.75)));
    }
  }
  let lampMesh: InstancedMesh | null = null;
  if (heads.length > 0) {
    const g = new Geo(true);
    g.color = [1, 1, 1];
    g.cylinder([0, 0, 0], [0, 0, -0.03], 0.1, 12, true);
    const mat = new MeshStandardMaterial({ name: 'wc-signal', color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
    mat.onBeforeCompile = (shader) => {
      // instance colour drives the emissive lens (off lenses keep a dim tint)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\ntotalEmissiveRadiance = vColor.rgb * 6.0;\n#endif',
      );
    };
    mat.customProgramCacheKey = () => 'wc-signal-v1';
    lampMesh = new InstancedMesh(g.build(), mat, heads.length);
    headM.forEach((m, i) => lampMesh!.setMatrixAt(i, m));
    lampMesh.instanceColor = new InstancedBufferAttribute(new Float32Array(heads.length * 3), 3);
    lampMesh.instanceColor.setUsage(DynamicDrawUsage);
    lampMesh.computeBoundingSphere();
    lampMesh.name = 'worldContent:signalLamps';
    lampMesh.matrixAutoUpdate = false;
    root.add(lampMesh);
    mats.emissive.userData.signals = true;
  }
  const RED = linear(0xff2a1a);
  const AMBER = linear(0xffa21a);
  const GREEN = linear(0x2aff7a);
  let lastTick = -1;
  return {
    meshes,
    update(camera: Camera, simTimeS: number) {
      const cp = camera.position;
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i]!;
        const bs = m.boundingSphere;
        if (!bs) continue;
        const d = Math.hypot(bs.center.x - cp.x, bs.center.z - cp.z) - bs.radius;
        m.visible = d < far[i]!;
      }
      for (const b of merged) {
        const bs = b.mesh.geometry.boundingSphere!;
        const d = Math.hypot(bs.center.x - cp.x, bs.center.z - cp.z) - bs.radius;
        b.mesh.visible = d < b.far;
        b.mesh.castShadow = b.shadow && d < 300; // shadow LOD (see SHADOW_CASTER_M)
      }
      if (lampMesh) {
        const tick = Math.floor(simTimeS * SIGNAL_TICK_HZ);
        if (tick === lastTick) return;
        lastTick = tick;
        const arr = lampMesh.instanceColor!.array as Float32Array;
        heads.forEach((h, i) => {
          const plan = signals[h.plan];
          const a = plan ? signalAspect(plan, h.leg, tick) : 'red';
          const on = (h.lamp === 0 && a === 'red') || (h.lamp === 1 && a === 'amber') || (h.lamp === 2 && a === 'green');
          const c = h.lamp === 0 ? RED : h.lamp === 1 ? AMBER : GREEN;
          const k = on ? 1 : 0.025;
          arr[i * 3] = c[0] * k;
          arr[i * 3 + 1] = c[1] * k;
          arr[i * 3 + 2] = c[2] * k;
        });
        lampMesh.instanceColor!.needsUpdate = true;
      }
    },
    dispose() {
      for (const gs of geoCache.values()) for (const g of gs) g.dispose();
      for (const m of meshes) m.removeFromParent();
      for (const b of merged) {
        b.mesh.geometry.dispose();
        b.mesh.removeFromParent();
      }
      if (lampMesh) {
        lampMesh.geometry.dispose();
        (lampMesh.material as Material).dispose();
        lampMesh.removeFromParent();
      }
    },
  };
}

void Y;

const MERGE_CELL_M = 512;
/** Natural detail kinds: many instances of a few hundred vertices each — instanced, short draw distance. */
function isDetail(key: string): boolean {
  return key === 'flowers' || key === 'tussock' || key === 'stones' || key.startsWith('litter:');
}

/** Instance transform of an item (shared by the merged and the instanced paths). */
function itemMatrix(key: string, it: ItemInstance, groundAt: (x: number, z: number) => number, out: Matrix4): Matrix4 {
  const yaw = Math.atan2(-it.dir[0], -it.dir[1]);
  const q = new Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  const y = it.pos[1] !== 0 ? it.pos[1] : groundAt(it.pos[0], it.pos[2]);
  const sv = key === 'awning' ? new Vector3(it.scale, 1, 1) : key === 'signalMast' ? new Vector3(it.scale - 0.6, 1, 1) : new Vector3(it.scale, it.scale, it.scale);
  return out.compose(new Vector3(it.pos[0], y, it.pos[2]), q, sv);
}

interface MergedBucket {
  mesh: Mesh;
  far: number;
  shadow: boolean;
}

function mergeItems(
  root: Group,
  items: readonly ItemInstance[],
  defs: Map<string, KindDef>,
  mats: { paint: Material; metal: Material; glass: Material; emissive: Material },
  groundAt: (x: number, z: number) => number,
): MergedBucket[] {
  interface Acc {
    pos: number[];
    nrm: number[];
    uv: number[];
    col: number[];
    idx: number[];
    material: Part['material'];
    shadow: boolean;
    far: number;
  }
  const acc = new Map<string, Acc>();
  const m4 = new Matrix4();
  const nm = new Matrix3();
  const v = new Vector3();
  const tint = new Color();
  for (const it of items) {
    const key = VARIANT_KEYED.has(it.kind) ? `${it.kind}:${it.variant}` : it.kind;
    const def = defs.get(key);
    if (!def || isDetail(key)) continue;
    itemMatrix(key, it, groundAt, m4);
    nm.getNormalMatrix(m4);
    // two draw-distance classes: small street furniture (≤ 300 m, no shadow casting: its shadow is a
    // few pixels, and every caster costs a draw per cascade) and everything farther-reaching
    const cls = def.far <= 300 ? 0 : 1;
    const cx = Math.floor(it.pos[0] / MERGE_CELL_M);
    const cz = Math.floor(it.pos[2] / MERGE_CELL_M);
    for (const p of def.parts) {
      const shadow = cls === 1 && def.shadows && p.material !== 'emissive' && p.material !== 'glass';
      const bk = `${p.material}|${shadow ? 1 : 0}|${cls}|${cx}|${cz}`;
      let a = acc.get(bk);
      if (!a) acc.set(bk, (a = { pos: [], nrm: [], uv: [], col: [], idx: [], material: p.material, shadow, far: 0 }));
      a.far = Math.max(a.far, def.far);
      const g = p.geo;
      const base = a.pos.length / 3;
      if (p.tint) tint.set(it.color ?? 0xffffff).convertSRGBToLinear();
      else tint.setRGB(1, 1, 1);
      for (let i = 0; i < g.pos.length; i += 3) {
        v.set(g.pos[i]!, g.pos[i + 1]!, g.pos[i + 2]!).applyMatrix4(m4);
        a.pos.push(v.x, v.y, v.z);
        v.set(g.nrm[i]!, g.nrm[i + 1]!, g.nrm[i + 2]!).applyMatrix3(nm).normalize();
        a.nrm.push(v.x, v.y, v.z);
        a.col.push((g.col[i] ?? 1) * tint.r, (g.col[i + 1] ?? 1) * tint.g, (g.col[i + 2] ?? 1) * tint.b);
      }
      for (let i = 0; i < g.uv.length; i++) a.uv.push(g.uv[i]!);
      for (const k of g.idx) a.idx.push(base + k);
    }
  }
  const out: MergedBucket[] = [];
  for (const [bk, a] of acc) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(a.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(a.nrm, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(a.uv, 2));
    geo.setAttribute('color', new Float32BufferAttribute(a.col, 3));
    geo.setIndex(a.pos.length / 3 > 65535 ? new Uint32BufferAttribute(a.idx, 1) : new Uint16BufferAttribute(a.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new Mesh(geo, mats[a.material]);
    mesh.name = `worldContent:items:${bk}`;
    mesh.castShadow = a.shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    out.push({ mesh, far: a.far, shadow: a.shadow });
  }
  return out;
}
