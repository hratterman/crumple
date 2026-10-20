import { describe, expect, it } from 'vitest';

import { createSpline } from '../../core/spline';
import type { LoftSurface, PanelGeometry } from './types';
import { VISUAL_DEFAULTS } from './types';
import {
  circleShape,
  createLoft,
  createSheet,
  crSegment,
  cutPanel,
  loftSurface,
  outlineBand,
  paramAt,
  stripMesh,
  surfacePatch,
  uAtMetric,
  polyShape,
  roundedBoxMesh,
  sideCut,
  tessellateSurface,
  tessellateVehicle,
  type V3,
} from './loft';

/** Quarter-cylinder-ish body side: sections in z, u from bottom (y 0) over the top to x = 0. */
function shell(nz = 6): V3[][] {
  const out: V3[][] = [];
  for (let j = 0; j < nz; j++) {
    const z = -1 + (2 * j) / (nz - 1);
    const sec: V3[] = [];
    for (let k = 0; k <= 8; k++) {
      const a = (Math.PI / 2) * (k / 8);
      sec.push([k === 8 ? 0 : Math.cos(a) * 0.9, Math.sin(a) * 0.6 + 0.3, z]);
    }
    out.push(sec);
  }
  return out;
}

function checkGeometry(g: PanelGeometry): void {
  const n = g.position.length / 3;
  expect(n).toBeGreaterThan(0);
  for (const a of [g.position, g.normal, g.uv, g.tangent!]) for (const x of a) expect(Number.isFinite(x)).toBe(true);
  for (const i of g.index) expect(i).toBeLessThan(n);
  for (let i = 0; i < n; i++) expect(Math.hypot(g.normal[i * 3]!, g.normal[i * 3 + 1]!, g.normal[i * 3 + 2]!)).toBeCloseTo(1, 4);
}

/** Fraction of triangles whose face normal agrees with their vertex normals (CCW outward). */
function windingAgreement(g: PanelGeometry): number {
  let ok = 0;
  let total = 0;
  const p = g.position;
  for (let q = 0; q < g.index.length; q += 3) {
    const a = g.index[q]! * 3;
    const b = g.index[q + 1]! * 3;
    const c = g.index[q + 2]! * 3;
    const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const fn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const len = Math.hypot(fn[0]!, fn[1]!, fn[2]!);
    if (len < 1e-10) continue;
    let vn = [0, 0, 0];
    for (const v of [a, b, c]) vn = vn.map((x, k) => x + g.normal[v + k]!);
    total++;
    if (fn[0]! * vn[0]! + fn[1]! * vn[1]! + fn[2]! * vn[2]! > 0) ok++;
  }
  return ok / Math.max(1, total);
}

describe('loft core', () => {
  it('crSegment matches core/spline (centripetal Barry–Goldman)', () => {
    const pts: V3[] = [
      [0, 0, 0],
      [1, 0.3, 0.1],
      [1.7, 1.2, -0.4],
      [3, 1, 0.2],
      [3.5, 0.2, 1],
    ];
    const sp = createSpline(pts);
    const a: V3 = [0, 0, 0];
    const ph0: V3 = [2 * pts[0]![0] - pts[1]![0], 2 * pts[0]![1] - pts[1]![1], 2 * pts[0]![2] - pts[1]![2]];
    for (const t of [0, 0.1, 0.33, 0.5, 0.77, 0.99]) {
      const f = t * 4;
      const seg = Math.min(3, Math.floor(f));
      const s = f - seg;
      const p0 = seg === 0 ? ph0 : pts[seg - 1]!;
      const p3 = seg + 2 < 5 ? pts[seg + 2]! : ([2 * pts[4]![0] - pts[3]![0], 2 * pts[4]![1] - pts[3]![1], 2 * pts[4]![2] - pts[3]![2]] as V3);
      crSegment(p0, pts[seg]!, pts[seg + 1]!, p3, s, a);
      const b = sp.position(t, [0, 0, 0]);
      for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k]!, 12);
    }
  });

  it('interpolates every control point at its knots; symmetric centre is exactly x = 0 with nx = 0', () => {
    const loft = createLoft(shell(), { symmetric: true });
    const p: V3 = [0, 0, 0];
    for (let j = 0; j < loft.nv; j++)
      for (let k = 0; k < loft.nu; k++) {
        loft.point(loft.uKnots[k]!, loft.vKnots[j]!, p);
        const c = loft.sections[j]![k]!;
        for (let q = 0; q < 3; q++) expect(p[q]).toBeCloseTo(c[q]!, 9);
      }
    expect(loft.symU1).toBe(true);
    const surf = loftSurface(loft);
    const n: V3 = [0, 0, 0];
    surf.frame(1, 0.4, n, [0, 0, 0], [0, 0, 0]);
    surf.point(1, 0.4, p);
    expect(p[0]).toBe(0);
    expect(Math.abs(n[0])).toBeLessThan(1e-6);
    expect(n[1]).toBeGreaterThan(0.99);
  });

  it('knots are increasing and arc-length normalized', () => {
    const loft = createLoft(shell());
    for (let k = 1; k < loft.uKnots.length; k++) expect(loft.uKnots[k]!).toBeGreaterThan(loft.uKnots[k - 1]!);
    // Ellipse quadrant: the middle CP sits past the arc midpoint (flat side longer), v sections equally spaced.
    expect(loft.uKnots[4]!).toBeGreaterThan(0.4);
    expect(loft.uKnots[4]!).toBeLessThan(0.5);
    expect(loft.vKnots[2]!).toBeCloseTo(0.4, 3);
  });

  // A full mirrored shell at 6 cm resolution (~1 s idle): an explicit budget.
  it('tessellates a LoftSurface: finite, unit normals, CCW outward, mirror seam bit-equal', () => {
    const surface: LoftSurface = { type: 'loft', sections: shell(), resolution: 0.06, mirrorX: true };
    const g = tessellateSurface('shell', surface);
    checkGeometry(g);
    expect(windingAgreement(g)).toBe(1);
    // Outward: normals point away from the axis (0, 0.3, z).
    for (let i = 0; i < g.position.length / 3; i++) {
      const dx = g.position[i * 3]!;
      const dy = g.position[i * 3 + 1]! - 0.3;
      expect(dx * g.normal[i * 3]! + dy * g.normal[i * 3 + 1]!).toBeGreaterThan(0);
    }
    // Seam: every x = 0 vertex has a bit-equal twin (the mirror copy).
    const keys = new Map<string, number>();
    for (let i = 0; i < g.position.length / 3; i++) {
      if (g.position[i * 3] !== 0) continue;
      const k = `${g.position[i * 3 + 1]},${g.position[i * 3 + 2]}`;
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    expect(keys.size).toBeGreaterThan(10);
    for (const c of keys.values()) expect(c % 2).toBe(0);
    // Max edge ≤ resolution (+ slack for clipped/curved spans).
    let maxEdge = 0;
    for (let q = 0; q < g.index.length; q += 3)
      for (let e = 0; e < 3; e++) {
        const a = g.index[q + e]! * 3;
        const b = g.index[q + ((e + 1) % 3)]! * 3;
        maxEdge = Math.max(maxEdge, Math.hypot(g.position[a]! - g.position[b]!, g.position[a + 1]! - g.position[b + 1]!, g.position[a + 2]! - g.position[b + 2]!));
      }
    expect(maxEdge).toBeLessThan(0.06 * Math.SQRT2 + 1e-3);
  }, 30_000);

  it('windows cut from one master leave a shut gap ≈ VISUAL_DEFAULTS.shutGap between neighbours', () => {
    const base = { type: 'loft' as const, sections: shell(), resolution: 0.05 };
    const a = tessellateSurface('a', { ...base, window: { u0: 0, u1: 1, v0: 0, v1: 0.5 } });
    const b = tessellateSurface('b', { ...base, window: { u0: 0, u1: 1, v0: 0.5, v1: 1 } });
    checkGeometry(a);
    checkGeometry(b);
    // Along z: a ends below z = 0, b starts above, gap = shutGap (both insets).
    let maxA = -Infinity;
    let minB = Infinity;
    for (let i = 0; i < a.position.length / 3; i++) maxA = Math.max(maxA, a.position[i * 3 + 2]!);
    for (let i = 0; i < b.position.length / 3; i++) minB = Math.min(minB, b.position[i * 3 + 2]!);
    expect(minB - maxA).toBeCloseTo(VISUAL_DEFAULTS.shutGap, 3);
  });

  it('thickness adds an inner shell with inward normals and closing flanges', () => {
    const g = tessellateSurface('t', { type: 'loft', sections: shell(), resolution: 0.08, window: { u0: 0.2, u1: 0.8, v0: 0.2, v1: 0.8 }, thickness: 0.02 });
    checkGeometry(g);
    let inward = 0;
    for (let i = 0; i < g.position.length / 3; i++) {
      const dx = g.position[i * 3]!;
      const dy = g.position[i * 3 + 1]! - 0.3;
      if (dx * g.normal[i * 3]! + dy * g.normal[i * 3 + 1]! < -0.5 * Math.hypot(dx, dy)) inward++;
    }
    expect(inward).toBeGreaterThan(g.position.length / 3 / 3);
    expect(windingAgreement(g)).toBeGreaterThan(0.98);
  });

  it('cutPanel clips exactly on a side-view circle (wheel arch) with a rolled lip', () => {
    const loft = createLoft(shell(9));
    const sheet = createSheet(loftSurface(loft), { resolution: 0.04 });
    const R = 0.35;
    const res = cutPanel({ sheet, cuts: [sideCut({ sd: (z, y) => -circleShape(0, 0.2, R).sd(z, y) }, 'arch')] });
    const m = res.mesh;
    expect(m.index.length).toBeGreaterThan(0);
    // Skin vertices (on the ellipse) stop at the circle + lip inset; the roll reaches the circle.
    let minSkin = Infinity;
    let minAll = Infinity;
    for (let i = 0; i < m.position.length / 3; i++) {
      const x = m.position[i * 3]!;
      const y = m.position[i * 3 + 1]!;
      const r = Math.hypot(m.position[i * 3 + 2]!, y - 0.2);
      minAll = Math.min(minAll, r);
      if (y > 0.301 && Math.abs((x / 0.9) ** 2 + ((y - 0.3) / 0.6) ** 2 - 1) < 6e-4) minSkin = Math.min(minSkin, r);
    }
    expect(minSkin).toBeGreaterThan(R + 0.007 - 2e-4);
    expect(minSkin).toBeLessThan(R + 0.012);
    expect(minAll).toBeGreaterThan(R - 0.04);
  });

  it('polyShape signs: closed inside > 0, open left > 0', () => {
    const sq = polyShape(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      true,
    );
    expect(sq.sd(0.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(sq.sd(2, 0.5)).toBeCloseTo(-1, 9);
    const line = polyShape(
      [
        [0, 0],
        [1, 0],
      ],
      false,
    );
    expect(line.sd(0.5, 0.3)).toBeCloseTo(0.3, 9);
    expect(line.sd(5, -0.2)).toBeCloseTo(-0.2, 9);
  });

  it('rounded box is closed and outward', () => {
    const m = roundedBoxMesh([0, 1, 0], [0.3, 0.2, 0.1], 0.03);
    const g = tessellateSurface('box', { type: 'mesh', position: m.position, index: m.index, normal: m.normal, uv: m.uv });
    checkGeometry(g);
    expect(windingAgreement(g)).toBe(1);
  });

  it('tessellateVehicle rejects bad ids and malformed specs', () => {
    const def = (id: string, sections: V3[][]) => ({
      vehicle: 'x',
      panels: [{ id, kind: 'body' as const, material: 'paint' as const, bind: ['a'], detach: null, surface: { type: 'loft' as const, sections, resolution: 0.1 } }],
      paint: { color: 0, metallic: 0, roughness: 0, clearcoat: 0, clearcoatRoughness: 0, flake: null },
      wheels: {} as never,
    });
    expect(() => tessellateVehicle(def('bad-id', shell()))).toThrow();
    expect(() => tessellateVehicle(def('ok', [shell()[0]!]))).toThrow();
    expect(() => tessellateVehicle(def('ok', [shell()[0]!, shell()[1]!.slice(1)]))).toThrow();
    expect(tessellateVehicle(def('ok', shell())).length).toBe(1);
  });

  it('stripMesh meshes a band thinner than a sheet cell; outlineBand rims a cut-out', () => {
    const loft = createLoft(shell(), { symmetric: true });
    const sheet = createSheet(loftSurface(loft), { resolution: 0.1 });
    const band = stripMesh(sheet, { u0: (v) => uAtMetric(sheet, v, 0.3), u1: (v) => uAtMetric(sheet, v, 0.308), v0: 0.1, v1: 0.9, segV: 20 });
    const g = tessellateSurface('band', { type: 'mesh', position: band.position, index: band.index, normal: band.normal, uv: band.uv });
    checkGeometry(g);
    expect(windingAgreement(g)).toBe(1);
    const hole = cutPanel({ sheet, cuts: [sideCut(circleShape(0, 0.6, 0.2), 'seam')], border: 'seam' }).mesh;
    const rim = outlineBand(hole, 0.01, 0.0, 0.003);
    const gr = tessellateSurface('rim', { type: 'mesh', position: rim.position, index: rim.index, normal: rim.normal, uv: rim.uv });
    checkGeometry(gr);
    expect(windingAgreement(gr)).toBeGreaterThan(0.98);
    // The rim hugs the circle.
    for (let i = 0; i < rim.position.length; i += 3) expect(Math.abs(Math.hypot(rim.position[i + 2]!, rim.position[i + 1]! - 0.6) - 0.2)).toBeLessThan(0.02);
  });

  it('paramAt inverts a 2-D projection; surfacePatch builds an outward, gap-free conforming part', () => {
    const loft = createLoft(shell(), { symmetric: true });
    const sheet = createSheet(loftSurface(loft), { resolution: 0.1 });
    const side = (q: V3): readonly [number, number] => [q[2], q[1]];
    const q: V3 = [0, 0, 0];
    for (const [z, y] of [
      [0.2, 0.6],
      [-0.7, 0.35],
      [0.55, 0.85],
    ] as const) {
      const [u, v] = paramAt(sheet, side, [z, y]);
      sheet.surface.point(u, v, q);
      expect(Math.abs(q[2] - z)).toBeLessThan(1e-6);
      expect(Math.abs(q[1] - y)).toBeLessThan(1e-6);
    }
    // A domed disc (collapsed centre ring) of radius 5 cm around (z, y) = (0.2, 0.6).
    const R = 0.05;
    const disc = surfacePatch(
      sheet,
      4,
      16,
      (i, j) => {
        const r = (R * i) / 4;
        const a = (j / 16) * Math.PI * 2;
        const [u, v] = paramAt(sheet, side, [0.2 + r * Math.cos(a), 0.6 + r * Math.sin(a)]);
        return { u, v, lift: 0.004 * (1 - (r / R) ** 2) };
      },
      { closedJ: true, smoothNormals: true },
    );
    const g = tessellateSurface('disc', { type: 'mesh', position: disc.position, index: disc.index, normal: disc.normal, uv: disc.uv });
    checkGeometry(g);
    expect(windingAgreement(g)).toBe(1);
    // 16 centre fan triangles + 3 rings of quads; the collapsed centre leaves no zero-area triangle.
    expect(g.index.length / 3).toBe(16 + 3 * 16 * 2);
    // Outward: away from the shell's axis (x = 0, y = 0.3).
    for (let i = 0; i < g.position.length; i += 3) expect(g.normal[i]! * g.position[i]! + g.normal[i + 1]! * (g.position[i + 1]! - 0.3)).toBeGreaterThan(0);
  });
});
