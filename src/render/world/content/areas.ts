/**
 * Mode-area visuals (R-WORLD render): barrier strips (armco W-beam on posts,
 * concrete walls, tyre walls, red / white kerbs, catch fences), collider-
 * driven solids (crash-lab barriers, sled, pipes, logs) and the free-standing
 * structure records (grandstands, start-lights gantry, sign gantries + arches,
 * the drag-strip tree, the quarry crane, the radio mast, farm silos). All
 * merged per material by the caller.
 */
import type { ResolvedCollider } from '../../../world/types';
import type { StripInstance, StructureInstance } from '../../../world/content/types';
import { add, Geo, linear, norm, qrot, scale, sub, type Q, type V3 } from './geo';

export interface AreaGeos {
  concrete: Geo;
  concreteDark: Geo;
  steel: Geo;
  /** Vertex-coloured painted metal / rubber / plastic. */
  painted: Geo;
  lamp: Geo;
}

/** The geometry set of the spatial cell holding (x, z) (per-cell batches cull and shadow-cull). */
export type GeoAt = (x: number, z: number) => AreaGeos;

/** A text board for the sign atlas (gantry signs, arches, banners). */
export interface TextBoard {
  text: string;
  bg: number;
  fg: number;
  centre: V3;
  right: V3;
  up: V3;
  w: number;
  h: number;
}

const yawQ = (t: readonly number[]): Q => {
  const a = Math.atan2(t[0]!, t[2]!);
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
};

function polyline(st: StripInstance): V3[] {
  const out: V3[] = [];
  for (let i = 0; i + 2 < st.points.length; i += 3) out.push([st.points[i]!, st.points[i + 1]!, st.points[i + 2]!]);
  return out;
}

/** Walks the polyline in steps of `step` m, calling fn(point, unit plan tangent, distance). */
function walk(pts: readonly V3[], step: number, fn: (p: V3, t: V3, s: number) => void): void {
  let carry = 0;
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (L < 1e-6) continue;
    const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
    let u = carry;
    while (u <= L) {
      const f = u / L;
      fn([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], t, s + u);
      u += step;
    }
    carry = u - L;
    s += L;
  }
}

export function addAreaStrips(geoAt: GeoAt, strips: readonly StripInstance[]): void {
  for (const st of strips) {
    const pts = polyline(st);
    if (pts.length < 2) continue;
    const g = geoAt(pts[0]![0], pts[0]![2]);
    switch (st.kind) {
      case 'armco': {
        // W-beam (two ribs + flat) 0.31 m tall at 0.45–0.76 m on C-posts every 2 m, faced toward the road side.
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
          const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
          const q = yawQ(t);
          const m = scale(add(a, b), 0.5);
          const r: V3 = scale([-t[2], 0, t[0]], -st.side * 0.14); // toward the road
          for (const [dy, dr] of [
            [0.53, 0.035],
            [0.68, 0.035],
          ] as const)
            g.steel.box(add(add(m, [0, dy, 0]), scale(r, 1 + dr / 0.14)), q, 0.02, 0.07, L / 2 + 0.02);
          g.steel.box(add(add(m, [0, 0.605, 0]), r), q, 0.012, 0.155, L / 2 + 0.02);
        }
        walk(pts, 2, (p, t) => g.steel.box(add(p, [0, 0.36, 0]), yawQ(t), 0.05, 0.42, 0.04));
        break;
      }
      case 'kerbConcrete': {
        // Concrete wall, slightly tapered faces (jersey-like), with a painted top stripe.
        const hw = st.width / 2;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
          const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
          const q = yawQ(t);
          const m = scale(add(a, b), 0.5);
          g.concrete.box(add(m, [0, (st.height - 0.25) / 2, 0]), q, hw, (st.height + 0.25) / 2, L / 2 + 0.01, 63 & ~8);
          g.concrete.box(add(m, [0, 0.12, 0]), q, hw + 0.12, 0.2, L / 2 + 0.01, 63 & ~(8 | 16 | 32));
        }
        break;
      }
      case 'tyreWall': {
        // Two rows of tyre stacks, 4 high, 0.6 m apart, bolted; a white top tyre every 4th stack.
        const hw = st.width / 2;
        walk(pts, 0.62, (p, t, s) => {
          const r: V3 = [-t[2], 0, t[0]];
          const k = Math.round(s / 0.62);
          for (const side of [-0.5, 0.5]) {
            const c = add(p, scale(r, side * hw * 1.0));
            for (let h = 0; h < 4; h++) {
              g.painted.color = h === 3 && k % 4 === 0 ? linear(0xe8e8e4) : h === 3 && k % 4 === 2 ? linear(0xc8281e) : linear(0x1d1e20);
              const y0 = c[1] - 0.05 + h * 0.235;
              g.painted.cylinder([c[0], y0, c[2]], [c[0], y0 + 0.22, c[2]], 0.31, 8, h === 3);
            }
          }
        });
        break;
      }
      case 'kerbRedWhite': {
        // Flat painted kerb (1 m blocks), slight crown toward the outer edge.
        let s = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
          const t = norm([b[0] - a[0], 0, b[2] - a[2]]);
          const r: V3 = scale([-t[2], 0, t[0]], st.side);
          const n = Math.max(1, Math.round(L));
          for (let k = 0; k < n; k++) {
            const f0 = k / n;
            const f1 = (k + 1) / n;
            const p0: V3 = [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0 + 0.03, a[2] + (b[2] - a[2]) * f0];
            const p1: V3 = [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1 + 0.03, a[2] + (b[2] - a[2]) * f1];
            g.painted.color = Math.floor(s + (k + 0.5) * (L / n)) % 2 === 0 ? linear(0xc8281e) : linear(0xeeeeea);
            const q0 = add(p0, add(scale(r, st.width * 0.55), [0, st.height, 0]));
            const q1 = add(p1, add(scale(r, st.width * 0.55), [0, st.height, 0]));
            const o0 = add(p0, scale(r, st.width));
            const o1 = add(p1, scale(r, st.width));
            g.painted.polyFacing([p0, p1, q1, q0], [0, 1, 0]);
            g.painted.polyFacing([q0, q1, o1, o0], [0, 1, 0]);
          }
          s += L;
        }
        break;
      }
      case 'fenceChain': {
        // Catch fence: posts every 3 m, top + mid rails, three tension wires (the mesh itself reads as nothing at distance).
        walk(pts, 3, (p) => g.steel.cylinder(p, add(p, [0, st.height, 0]), 0.045, 6, true));
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          for (const h of [st.height, st.height * 0.5]) g.steel.cylinder(add(a, [0, h, 0]), add(b, [0, h, 0]), 0.025, 5, false);
          for (const h of [0.25, st.height * 0.75]) g.steel.cylinder(add(a, [0, h, 0]), add(b, [0, h, 0]), 0.008, 3, false);
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Collider-driven solids of the mode areas. */
export function addAreaColliders(geoAt: GeoAt, colliders: readonly ResolvedCollider[]): void {
  for (const c of colliders) {
    const [hx, hy, hz] = c.size;
    const g = geoAt(c.pos[0], c.pos[2]);
    switch (c.visual) {
      case 'crashBarrier':
        if (c.kind === 'cylinder') {
          // test pole: painted yellow / black bands
          for (let k = 0; k < 8; k++) {
            g.painted.color = k % 2 === 0 ? linear(0xe0b21c) : linear(0x1a1a1c);
            const a = add(c.pos, qrot(c.quat, [0, -hy + (2 * hy * k) / 8, 0]));
            const b = add(c.pos, qrot(c.quat, [0, -hy + (2 * hy * (k + 1)) / 8, 0]));
            g.painted.cylinder(a, b, hx, 14, k === 7);
          }
        } else {
          g.concreteDark.box(c.pos, c.quat, hx, hy, hz);
          // steel face plate on the approach (−Z) face, with a yellow / black chevron band on top
          g.steel.box(add(c.pos, qrot(c.quat, [0, 0, -hz - 0.02])), c.quat, hx, hy, 0.02);
          for (let k = 0; k < 8; k++) {
            g.painted.color = k % 2 === 0 ? linear(0xe0b21c) : linear(0x1a1a1c);
            const x = -hx + (2 * hx * (k + 0.5)) / 8;
            g.painted.box(add(c.pos, qrot(c.quat, [x, hy + 0.01, -hz + 0.1])), c.quat, hx / 8, 0.01, 0.1);
          }
        }
        break;
      case 'sled':
        g.steel.box(c.pos, c.quat, hx, hy * 0.6, hz);
        g.painted.color = linear(0xd8d8d0);
        g.painted.box(add(c.pos, qrot(c.quat, [0, hy * 0.25, -hz - 0.25])), c.quat, hx, hy * 0.75, 0.25); // honeycomb face
        g.painted.color = linear(0x1a1a1c);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.painted.cylinder(add(c.pos, qrot(c.quat, [sx * hx, -hy + 0.25, sz * hz * 0.7])), add(c.pos, qrot(c.quat, [sx * (hx + 0.15), -hy + 0.25, sz * hz * 0.7])), 0.25, 10, true);
        break;
      case 'pipe': {
        const a = add(c.pos, qrot(c.quat, [0, -hy, 0]));
        const b = add(c.pos, qrot(c.quat, [0, hy, 0]));
        g.concrete.cylinder(a, b, hx, 18, false);
        g.concreteDark.cylinder(b, a, hx * 0.82, 18, false); // inner bore (inverted winding via reversed ends is not enough: draw the bore slightly smaller)
        // end rings
        const d = norm(sub(b, a));
        for (const [p, s] of [
          [a, -1],
          [b, 1],
        ] as const) g.concrete.cylinder(p, add(p, scale(d, s * 0.02)), hx, 18, true);
        break;
      }
      case 'log': {
        const a = add(c.pos, qrot(c.quat, [0, -hy, 0]));
        const b = add(c.pos, qrot(c.quat, [0, hy, 0]));
        g.painted.color = linear(0x4a3624);
        g.painted.cylinder(a, b, hx, 10, false);
        g.painted.color = linear(0xb08a5a);
        const d = norm(sub(b, a));
        g.painted.cylinder(a, add(a, scale(d, -0.01)), hx * 0.98, 10, true);
        g.painted.cylinder(b, add(b, scale(d, 0.01)), hx * 0.98, 10, true);
        break;
      }
      default:
        break;
    }
  }
}

/** Free-standing structure records (pos-based). Pushes text boards for the sign atlas. */
export function addAreaRecords(geoAt: GeoAt, records: readonly StructureInstance[], boards: TextBoard[]): void {
  for (const st of records) {
    if (!st.pos || !st.dir) continue;
    const g = geoAt(st.pos[0], st.pos[2]);
    const prm = st.params ?? {};
    const o: V3 = [st.pos[0], st.pos[1], st.pos[2]];
    const f = norm([st.dir[0], 0, st.dir[1]]);
    const r: V3 = [-f[2], 0, f[0]];
    const q = yawQ(f);
    const at = (along: number, side: number, up: number): V3 => add(add(add(o, scale(f, along)), scale(r, side)), [0, up, 0]);
    switch (st.kind) {
      case 'grandstand': {
        // front = dir; rows step up away from the front: row k top at 1.2 + 0.45 k, depth 0.85
        const hw = prm.hw ?? 20;
        const rows = prm.rows ?? 10;
        const hd = prm.hd ?? 6;
        const front = hd; // the front edge at +hd along dir
        const seat = [0x1f4f8a, 0xc52b22, 0xd9a21b];
        for (let k = 0; k < rows; k++) {
          const top = 1.2 + 0.45 * k;
          const w = front - 1 - (k + 0.5) * 0.85;
          g.concrete.box(at(w, 0, top / 2 - 0.2), q, hw, top / 2 + 0.2, 0.425, k === rows - 1 ? 63 : 63 & ~(32 | 8));
          g.painted.color = linear(seat[Math.floor(k / 4) % 3]!);
          g.painted.box(at(w + 0.1, 0, top + 0.22), q, hw - 0.4, 0.04, 0.2);
          g.painted.box(at(w - 0.1, 0, top + 0.42), q, hw - 0.4, 0.2, 0.03);
        }
        // front wall + back wall + side walls
        g.concrete.box(at(front - 0.6, 0, 0.6), q, hw, 0.6, 0.1);
        const backW = front - 1 - rows * 0.85;
        const backH = 1.2 + 0.45 * rows + 3.4;
        g.concrete.box(at(backW - 0.15, 0, backH / 2 - 0.3), q, hw, backH / 2 + 0.3, 0.15);
        // roof: steel sheet on columns cantilevered over the seats
        const roofY = backH + 0.2;
        g.steel.box(at((front + backW) / 2 + 0.6, 0, roofY), q, hw + 0.5, 0.08, (front - backW) / 2 + 0.8);
        for (let k = 0; k <= Math.round(hw / 8); k++) {
          const sx = -hw + (2 * hw * k) / Math.round(hw / 8);
          g.steel.cylinder(at(backW - 0.4, sx, 0), at(backW - 0.4, sx, roofY), 0.15, 8, false);
        }
        break;
      }
      case 'startGantry': {
        const span = prm.span ?? 10;
        const clear = prm.clear ?? 6;
        for (const sd of [-1, 1]) g.steel.cylinder(at(0, sd * span, -0.5), at(0, sd * span, clear + 1.6), 0.3, 12, true);
        // truss: two chords + diagonal web
        for (const y of [clear + 0.2, clear + 1.4]) g.steel.cylinder(at(0, -span, y), at(0, span, y), 0.09, 8, false);
        const n = Math.round(span);
        for (let k = 0; k < n; k++) {
          const x0 = -span + (2 * span * k) / n;
          const x1 = -span + (2 * span * (k + 1)) / n;
          g.steel.cylinder(at(0, x0, clear + 0.2), at(0, x1, clear + 1.4), 0.04, 5, false);
        }
        // light box: 5 columns × 2 red + a top row of ambers, faces −dir (toward the grid)
        g.painted.color = linear(0x15171a);
        g.painted.box(at(-0.2, 0, clear - 0.5), q, 2.4, 0.75, 0.2);
        for (let k = 0; k < 5; k++) {
          for (let j = 0; j < 2; j++) {
            g.painted.color = linear(0x5a0c08);
            g.painted.cylinder(at(-0.41, -1.8 + k * 0.9, clear - 0.85 + j * 0.42), at(-0.43, -1.8 + k * 0.9, clear - 0.85 + j * 0.42), 0.16, 12, true);
          }
          g.painted.color = linear(0x6a4a08);
          g.painted.cylinder(at(-0.41, -1.8 + k * 0.9, clear - 0.02), at(-0.43, -1.8 + k * 0.9, clear - 0.02), 0.1, 10, true);
        }
        boards.push({ text: 'CRUMPLE VALLEY', bg: 0x15171a, fg: 0xf2f2f0, centre: at(-0.42, 0, clear + 0.8), right: scale(r, -1), up: [0, 1, 0], w: span * 1.4, h: 0.9 });
        boards.push({ text: 'CRUMPLE VALLEY', bg: 0x15171a, fg: 0xf2f2f0, centre: at(0.42, 0, clear + 0.8), right: r, up: [0, 1, 0], w: span * 1.4, h: 0.9 });
        break;
      }
      case 'gantry': {
        const span = prm.span ?? 8;
        const clear = prm.clear ?? 5.5;
        const banner = (prm.banner ?? 0) > 0;
        for (const sd of [-1, 1]) {
          if (banner) g.steel.cylinder(at(0, sd * span, -0.3), at(0, sd * span, clear + 1.4), 0.18, 10, true);
          else g.steel.box(at(0, sd * span, (clear + 2.6) / 2 - 0.3), q, 0.35, (clear + 2.6) / 2 + 0.3, 0.35);
        }
        if (banner) {
          g.painted.color = linear(0xe8e8e4);
          g.painted.box(at(0, 0, clear + 0.7), q, span, 0.7, 0.04);
          const text = st.texts?.[0] ?? '';
          for (const sd of [-1, 1]) boards.push({ text, bg: 0xe8e8e4, fg: 0xc52b22, centre: at(sd * 0.05, 0, clear + 0.7), right: scale(r, sd), up: [0, 1, 0], w: span * 1.9, h: 1.3 });
          break;
        }
        // box truss over the carriageway
        for (const y of [clear + 2.2, clear + 2.9]) for (const a of [-0.45, 0.45]) g.steel.cylinder(at(a, -span, y), at(a, span, y), 0.07, 6, false);
        const n = Math.round(span / 1.5);
        for (let k = 0; k < n; k++) {
          const x0 = -span + (2 * span * k) / n;
          const x1 = -span + (2 * span * (k + 1)) / n;
          for (const a of [-0.45, 0.45]) g.steel.cylinder(at(a, x0, clear + 2.2), at(a, x1, clear + 2.9), 0.035, 4, false);
        }
        // sign panels hung on the approach face (−dir side), one per text, laid out from the right
        const texts = st.texts ?? [];
        const pw = Math.min(7.5, (2 * span - 2) / Math.max(1, texts.length));
        texts.forEach((text, i) => {
          const x = span - 1 - pw / 2 - i * (pw + 0.6);
          g.painted.color = linear(0x1f6b3a);
          g.painted.box(at(-0.6, x, clear + 1.3), q, pw / 2, 1.3, 0.05);
          boards.push({ text, bg: 0x1f6b3a, fg: 0xf4f4f0, centre: at(-0.66, x, clear + 1.3), right: scale(r, -1), up: [0, 1, 0], w: pw - 0.2, h: 2.4 });
        });
        break;
      }
      case 'tree': {
        // Christmas tree: pole, staging bulbs (blue/white), 3 ambers, green, red per lane side.
        g.steel.cylinder(at(0, 0, 0), at(0, 0, 2.6), 0.08, 8, true);
        g.painted.color = linear(0x15171a);
        g.painted.box(at(0, 0, 1.75), q, 0.42, 0.95, 0.12);
        const lamps: [number, number][] = [
          [2.5, 0x9ab8ff],
          [2.35, 0x9ab8ff],
          [2.0, 0xffb21a],
          [1.75, 0xffb21a],
          [1.5, 0xffb21a],
          [1.2, 0x2aff7a],
          [0.92, 0xff2a1a],
        ];
        for (const [y, col] of lamps) {
          for (const sd of [-1, 1]) {
            g.painted.color = linear(col, 0.35);
            g.painted.cylinder(at(-0.13, sd * 0.2, y), at(-0.16, sd * 0.2, y), y > 2.3 ? 0.06 : 0.09, 10, true);
          }
        }
        break;
      }
      case 'crane': {
        const span = (prm.span ?? 22) / 2;
        const h = prm.height ?? 16;
        g.painted.color = linear(0xe0b21c);
        for (const sx of [-span, span]) {
          for (const sz of [-4, 4]) g.painted.box(at(sz, sx, h / 2), q, 0.4, h / 2, 0.4);
          g.painted.box(at(0, sx, 0.6), q, 0.5, 0.6, 5);
          g.painted.box(at(0, sx, h - 0.4), q, 0.5, 0.4, 4.6);
          // diagonal brace between the legs
          g.painted.cylinder(at(-4, sx, 1.2), at(4, sx, h - 1.2), 0.12, 6, false);
        }
        for (const sz of [-1.2, 1.2]) g.painted.box(at(sz, 0, h + 0.6), q, 0.45, 0.8, span + 0.6, 63);
        g.painted.box(at(0, 2, h + 1.6), q, 1.6, 0.4, 1.4);
        g.steel.cylinder(at(0, 2, h + 1.2), at(0, 2, 5), 0.03, 4, false);
        g.painted.color = linear(0x1a1a1c);
        g.painted.box(at(0, 2, 4.6), q, 0.5, 0.35, 0.3);
        break;
      }
      case 'mast': {
        const h = prm.height ?? 100;
        if ((prm.silo ?? 0) > 0) {
          const rad = prm.r ?? 3;
          g.steel.cylinder(at(0, 0, -0.3), at(0, 0, h), rad, 24, false);
          g.steel.cylinder(at(0, 0, h), at(0, 0, h + rad * 0.45), rad, 24, true, rad * 0.25);
          g.concrete.cylinder(at(0, 0, -0.3), at(0, 0, 0.5), rad + 0.25, 24, true);
          // ladder cage
          g.painted.color = linear(0x8c9196);
          for (const s of [-0.25, 0.25]) g.painted.cylinder(at(rad + 0.15, s, 0.5), at(rad + 0.15, s, h), 0.025, 4, false);
          break;
        }
        // triangular lattice, 1.8 m faces, red / white bands every 15 m
        const R = 1.05;
        const legs: V3[] = [0, 1, 2].map((k) => [Math.cos((k * 2 * Math.PI) / 3) * R, 0, Math.sin((k * 2 * Math.PI) / 3) * R]);
        const bay = 4;
        const n = Math.ceil(h / bay);
        for (let k = 0; k < n; k++) {
          const y0 = k * bay;
          const y1 = Math.min(h, (k + 1) * bay);
          const band = Math.floor(y0 / 15) % 2 === 0;
          g.painted.color = band ? linear(0xc8281e) : linear(0xeeeeea);
          for (let l = 0; l < 3; l++) {
            const a = legs[l]!;
            const b = legs[(l + 1) % 3]!;
            g.painted.cylinder(add(o, [a[0], y0, a[2]]), add(o, [a[0], y1, a[2]]), 0.07, 5, false);
            g.painted.cylinder(add(o, [a[0], y0, a[2]]), add(o, [b[0], y1, b[2]]), 0.03, 4, false);
            g.painted.cylinder(add(o, [a[0], y1, a[2]]), add(o, [b[0], y1, b[2]]), 0.03, 4, false);
          }
        }
        g.painted.color = linear(0xff2010, 0.6);
        for (const y of [40, 80, h]) g.painted.box(add(o, [0, y + 0.3, 0]), [0, 0, 0, 1], 0.2, 0.2, 0.2);
        g.concrete.box(add(o, [0, 0.2, 0]), [0, 0, 0, 1], 1.6, 0.5, 1.6);
        break;
      }
      default:
        break;
    }
  }
}
