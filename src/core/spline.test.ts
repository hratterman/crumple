import { describe, expect, it } from 'vitest';
import type { Vec3 } from './math';
import { vec3Dist, vec3Length } from './math';
import { createSpline } from './spline';

const line: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
];

// Diamond in the XZ plane (Y-up world), radius 2.
const diamond: Vec3[] = [
  [2, 0, 0],
  [0, 0, 2],
  [-2, 0, 0],
  [0, 0, -2],
];

describe('createSpline', () => {
  it('rejects too few control points', () => {
    expect(() => createSpline([[0, 0, 0]])).toThrow(RangeError);
    expect(() =>
      createSpline(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        true,
      ),
    ).toThrow(RangeError);
  });

  it('interpolates its control points (open)', () => {
    const s = createSpline(line);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < line.length; i++) {
      s.position(i / (line.length - 1), out);
      expect(vec3Dist(out, line[i] as Vec3)).toBeLessThan(1e-9);
    }
  });

  it('interpolates its control points (closed)', () => {
    const s = createSpline(diamond, true);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < diamond.length; i++) {
      s.position(i / diamond.length, out);
      expect(vec3Dist(out, diamond[i] as Vec3)).toBeLessThan(1e-9);
    }
  });

  it('clamps t outside [0,1] when open', () => {
    const s = createSpline(line);
    const out: Vec3 = [0, 0, 0];
    s.position(-0.5, out);
    expect(vec3Dist(out, [0, 0, 0])).toBeLessThan(1e-9);
    s.position(1.5, out);
    expect(vec3Dist(out, [3, 0, 0])).toBeLessThan(1e-9);
  });

  describe('straight-line degeneracy', () => {
    it('stays exactly on the line', () => {
      const s = createSpline(line);
      const out: Vec3 = [0, 0, 0];
      for (let i = 0; i <= 100; i++) {
        s.position(i / 100, out);
        expect(Math.abs(out[1])).toBeLessThan(1e-12);
        expect(Math.abs(out[2])).toBeLessThan(1e-12);
      }
    });

    it('arc length is linear: table length matches within 1e-3', () => {
      const s = createSpline(line);
      const table = s.buildArcTable(256);
      expect(Math.abs(table.length - 3)).toBeLessThan(1e-3);
    });

    it('posAtDistance walks the line linearly within 1e-3', () => {
      const s = createSpline(line);
      const table = s.buildArcTable(256);
      const out: Vec3 = [0, 0, 0];
      for (let sDist = 0; sDist <= 3; sDist += 0.25) {
        table.posAtDistance(sDist, out);
        expect(Math.abs(out[0] - sDist)).toBeLessThan(1e-3);
      }
    });

    it('tangent points along the line everywhere', () => {
      const s = createSpline(line);
      const out: Vec3 = [0, 0, 0];
      for (let i = 0; i <= 20; i++) {
        s.tangent(i / 20, out);
        expect(out[0]).toBeCloseTo(1, 9);
        expect(Math.abs(out[1])).toBeLessThan(1e-9);
        expect(Math.abs(out[2])).toBeLessThan(1e-9);
      }
    });
  });

  describe('arc table', () => {
    it('clamps distances outside [0, length] when open', () => {
      const s = createSpline(line);
      const table = s.buildArcTable(64);
      const out: Vec3 = [0, 0, 0];
      table.posAtDistance(-5, out);
      expect(vec3Dist(out, [0, 0, 0])).toBeLessThan(1e-9);
      table.posAtDistance(100, out);
      expect(vec3Dist(out, [3, 0, 0])).toBeLessThan(1e-9);
    });

    it('wraps distances when closed', () => {
      const s = createSpline(diamond, true);
      const table = s.buildArcTable(512);
      const a: Vec3 = [0, 0, 0];
      const b: Vec3 = [0, 0, 0];
      table.posAtDistance(1.25, a);
      table.posAtDistance(1.25 + table.length, b);
      expect(vec3Dist(a, b)).toBeLessThan(1e-9);
      table.posAtDistance(-table.length + 1.25, b);
      expect(vec3Dist(a, b)).toBeLessThan(1e-9);
    });

    it('tAtDistance is monotonic', () => {
      const s = createSpline(diamond, true);
      const table = s.buildArcTable(256);
      let prev = -1;
      for (let sDist = 0; sDist < table.length; sDist += table.length / 50) {
        const t = table.tAtDistance(sDist);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    });
  });

  describe('closestPoint', () => {
    it('finds the obvious nearest point on a straight spline', () => {
      const s = createSpline(line);
      const res = s.closestPoint([1.5, 1, 0], 64, 40);
      expect(res.distance).toBeCloseTo(1, 3);
      expect(res.point[0]).toBeCloseTo(1.5, 3);
      expect(Math.abs(res.point[1])).toBeLessThan(1e-9);
    });

    it('returns distance 0 for a point on the spline', () => {
      const s = createSpline(line);
      const res = s.closestPoint([2, 0, 0], 64, 40);
      expect(res.distance).toBeLessThan(1e-6);
      expect(res.point[0]).toBeCloseTo(2, 6);
    });

    it('handles queries near the closed-loop seam (t = 0/1)', () => {
      const s = createSpline(diamond, true);
      // Slightly offset from control point 0, which sits at the seam.
      const res = s.closestPoint([2.5, 0, 0.01], 64, 48);
      const out: Vec3 = [0, 0, 0];
      s.position(res.t, out);
      // Reported point must actually be on the curve at the reported t.
      expect(vec3Dist(out, res.point)).toBeLessThan(1e-9);
      expect(res.point[0]).toBeCloseTo(2, 2);
      expect(Math.abs(res.point[1])).toBeLessThan(1e-9);
      expect(res.t).toBeGreaterThanOrEqual(0);
      expect(res.t).toBeLessThan(1);
    });

    it('reuses the result object (documented contract)', () => {
      const s = createSpline(line);
      const r1 = s.closestPoint([0, 1, 0]);
      const r2 = s.closestPoint([3, 1, 0]);
      expect(r1).toBe(r2);
    });
  });

  describe('closed-loop continuity', () => {
    it('position(0) equals position(1)', () => {
      const s = createSpline(diamond, true);
      const a: Vec3 = [0, 0, 0];
      const b: Vec3 = [0, 0, 0];
      s.position(0, a);
      s.position(1, b);
      expect(vec3Dist(a, b)).toBeLessThan(1e-12);
    });

    it('is C0/C1 across the seam and every knot', () => {
      const s = createSpline(diamond, true);
      const eps = 1e-6;
      const pa: Vec3 = [0, 0, 0];
      const pb: Vec3 = [0, 0, 0];
      const ta: Vec3 = [0, 0, 0];
      const tb: Vec3 = [0, 0, 0];
      for (let k = 0; k <= diamond.length; k++) {
        const t = k / diamond.length;
        s.position(t - eps, pa);
        s.position(t + eps, pb);
        expect(vec3Dist(pa, pb)).toBeLessThan(1e-4);
        s.tangent(t - eps, ta);
        s.tangent(t + eps, tb);
        expect(vec3Dist(ta, tb)).toBeLessThan(1e-4);
      }
    });

    it('tangent stays unit length around the loop', () => {
      const s = createSpline(diamond, true);
      const out: Vec3 = [0, 0, 0];
      for (let i = 0; i < 100; i++) {
        s.tangent(i / 100, out);
        expect(vec3Length(out)).toBeCloseTo(1, 9);
      }
    });

    it('closed-loop arc length is close to the true perimeter scale', () => {
      const s = createSpline(diamond, true);
      const table = s.buildArcTable(1024);
      // Curve interpolates 4 points at radius 2: perimeter must be at least
      // the inscribed square (8·sqrt(2) ≈ 11.31) and well under 2x that.
      expect(table.length).toBeGreaterThan(8 * Math.SQRT2 - 1e-6);
      expect(table.length).toBeLessThan(16);
    });
  });

  it('handles uneven control spacing without cusps (centripetal property)', () => {
    // Sharp spacing change — uniform CR would overshoot/loop here.
    const pts: Vec3[] = [
      [0, 0, 0],
      [0.1, 0, 0],
      [0.2, 0, 0.1],
      [5, 0, 0.2],
      [10, 0, 0],
    ];
    const s = createSpline(pts);
    const out: Vec3 = [0, 0, 0];
    let prevX = -Infinity;
    // x should progress monotonically along this gently-bending run.
    for (let i = 0; i <= 200; i++) {
      s.position(i / 200, out);
      expect(out[0]).toBeGreaterThanOrEqual(prevX - 1e-9);
      prevX = out[0];
    }
  });
});
