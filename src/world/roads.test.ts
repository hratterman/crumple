import { describe, expect, it } from 'vitest';
import { createRng } from '../core/rng';
import {
  createRoadProjection,
  createRoadSample,
  detAtan2,
  headingToYaw,
  projectToRoad,
  resolveRoadProfiles,
  sampleRoad,
} from './roads';
import {
  ROAD_KIND_DEFAULTS,
  ROAD_STATION_SPACING,
  ROAD_STATION_STRIDE,
  RoadStation,
  WorldLayoutError,
  type JunctionDef,
  type RoadDef,
  type RoadProfile,
  type WorldLayout,
} from './types';

const flat = (): number => 10;

function layoutWith(roads: RoadDef[], junctions: JunctionDef[] = []): WorldLayout {
  return { roads, junctions } as unknown as WorldLayout;
}

function road(over: Partial<RoadDef> & Pick<RoadDef, 'id' | 'points'>): RoadDef {
  return {
    name: over.id,
    kind: 'country',
    closed: false,
    width: 7,
    lanes: 1,
    shoulder: 1,
    material: 0,
    markings: 'center',
    ...over,
  };
}

/** 16-point circle of radius R (rational parametrization, no trig), counter-clockwise in (x, z). */
function circlePoints(R: number, y: number | null): [number, number | null, number][] {
  const pts: [number, number | null, number][] = [];
  const ts = [0, 0.198912367, 0.414213562, 0.668178638, 1];
  // Quarter arc t = tan(θ/2) for θ = 0, 22.5°, 45°, 67.5°, 90°, then mirrored.
  const quarter = ts.map((t) => [(1 - t * t) / (1 + t * t), (2 * t) / (1 + t * t)] as const);
  for (let q = 0; q < 4; q++) {
    for (let k = 0; k < 4; k++) {
      const [c, s] = quarter[k]!;
      // rotate by q·90°
      const x = q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s;
      const z = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
      pts.push([R * x, y, R * z]);
    }
  }
  return pts;
}

describe('resolveRoadProfiles', () => {
  const straight = road({ id: 'straight', points: [[-100, 10, 0], [0, 10, 0], [100, 10, 0]] });
  const circle = road({ id: 'circle', closed: true, bank: 0.05, points: circlePoints(100, 10) });
  const [S, C] = resolveRoadProfiles(layoutWith([straight, circle]), flat) as [RoadProfile, RoadProfile];

  it('places stations every 2 m with the last at the road length (open)', () => {
    expect(S.length).toBeCloseTo(200, 6);
    expect(S.stationCount).toBe(101);
    const st = S.stations;
    for (let i = 0; i < S.stationCount; i++) {
      expect(st[i * ROAD_STATION_STRIDE]!).toBeCloseTo(-100 + i * ROAD_STATION_SPACING, 3);
      expect(st[i * ROAD_STATION_STRIDE + RoadStation.tx]!).toBeCloseTo(1, 9);
      expect(st[i * ROAD_STATION_STRIDE + RoadStation.curvature]!).toBeCloseTo(0, 9);
    }
    expect(S.surface).toBe('ribbon');
  });

  it('closes loops without duplicating the first station', () => {
    expect(C.length).toBeGreaterThan(2 * Math.PI * 100 - 1);
    expect(C.length).toBeLessThan(2 * Math.PI * 100 + 1);
    const gap = C.length - (C.stationCount - 1) * ROAD_STATION_SPACING;
    expect(gap).toBeGreaterThan(0.25);
    expect(gap).toBeLessThanOrEqual(2.25);
  });

  it('signs curvature and bank per the contract (+κ right turn, outside high)', () => {
    // Counter-clockwise in (x, z) with north = −Z is a RIGHT-hand loop seen from above.
    const smp = createRoadSample();
    for (let s = 50; s < C.length; s += 97) {
      sampleRoad(C, s, smp);
      expect(smp.curvature).toBeGreaterThan(0.009);
      expect(smp.curvature).toBeLessThan(0.011);
      // κ·bankFullRadius ≥ 1 → full bank, negative = left (outside) side higher.
      expect(smp.bank).toBeCloseTo(-0.05, 3);
      // Right vector points at the centre.
      expect(smp.x * smp.rx + smp.z * smp.rz).toBeLessThan(-99);
    }
  });

  it('limits the grade of over-steep designs and pins junction stations', () => {
    const steep = road({ id: 'steep', kind: 'street', points: [[0, 0, 0], [50, 10, 0], [100, 30, 0]] });
    const through = road({ id: 'through', kind: 'highway', bank: 0.05, points: [[100, 30, -150], [100, 32, 0], [100, 34, 150]] });
    const [st, th] = resolveRoadProfiles(
      layoutWith([steep, through], [{ id: 'j', pos: [100, 0], roads: ['through', 'steep'] }]),
      flat,
    ) as [RoadProfile, RoadProfile];
    const g = ROAD_KIND_DEFAULTS.street.maxGrade;
    let worst = 0;
    for (let i = 1; i < st.stationCount; i++) {
      const a = (i - 1) * ROAD_STATION_STRIDE;
      const b = i * ROAD_STATION_STRIDE;
      const run = Math.hypot(st.stations[b]! - st.stations[a]!, st.stations[b + 2]! - st.stations[a + 2]!);
      worst = Math.max(worst, Math.abs(st.stations[b + 1]! - st.stations[a + 1]!) / run);
    }
    expect(worst).toBeLessThanOrEqual(g);
    // Branch end = through-road surface at the junction; bank faded to 0 there.
    const p = projectToRoad(th, 100, 0, createRoadProjection());
    const end = (st.stationCount - 1) * ROAD_STATION_STRIDE;
    expect(Math.abs(st.stations[end + 1]! - p.y)).toBeLessThan(0.05);
    expect(st.stations[end + RoadStation.bank]!).toBeCloseTo(0, 9);
  });

  it('follows the terrain between null-y control points', () => {
    const wavy = (x: number): number => 10 + 3 * Math.sin(x / 40);
    const r = road({ id: 'r', kind: 'dirt', points: [[-200, null, 0], [-100, null, 0], [0, null, 0], [100, null, 0], [200, null, 0]] });
    const [p] = resolveRoadProfiles(layoutWith([r]), (x) => wavy(x)) as [RoadProfile];
    let worst = 0;
    for (let i = 10; i < p.stationCount - 10; i++) {
      const o = i * ROAD_STATION_STRIDE;
      worst = Math.max(worst, Math.abs(p.stations[o + 1]! - wavy(p.stations[o]!)));
    }
    // A 250 m sine (±3 m) survives the disc average + 14 m smoothing within ~0.5 m.
    expect(worst).toBeLessThan(0.5);
  });

  it('rejects a junction its roads do not pass through', () => {
    const a = road({ id: 'a', points: [[-100, 10, 0], [100, 10, 0]] });
    const b = road({ id: 'b', points: [[0, 10, 5], [0, 10, 100]] });
    expect(() => resolveRoadProfiles(layoutWith([a, b], [{ id: 'j', pos: [0, 0], roads: ['a', 'b'] }]), flat)).toThrow(
      WorldLayoutError,
    );
  });
});

describe('sampleRoad / projectToRoad', () => {
  const [S, C] = resolveRoadProfiles(
    layoutWith([
      road({ id: 's', points: [[-100, 10, 0], [0, 12, 0], [100, 14, 0]] }),
      road({ id: 'c', closed: true, bank: 0.05, points: circlePoints(100, 10) }),
    ]),
    flat,
  ) as [RoadProfile, RoadProfile];

  it('clamps open roads and wraps closed ones', () => {
    const a = createRoadSample();
    const b = createRoadSample();
    expect(sampleRoad(S, -5, a).s).toBe(0);
    expect(sampleRoad(S, 1e6, a).s).toBe(S.length);
    expect(a.x).toBeCloseTo(100, 6);
    sampleRoad(C, C.length + 10, a);
    sampleRoad(C, 10, b);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.z).toBeCloseTo(b.z, 9);
    sampleRoad(C, -10, a);
    sampleRoad(C, C.length - 10, b);
    expect(a.x).toBeCloseTo(b.x, 9);
    // Inside the wrap segment (last station → first).
    sampleRoad(C, C.length - 0.1, a);
    expect(Number.isFinite(a.x) && Math.hypot(a.tx, a.tz) > 0.999).toBe(true);
  });

  it('round-trips (s, d) through sample + offset + projection', () => {
    const smp = createRoadSample();
    const proj = createRoadProjection();
    for (const prof of [S, C]) {
      for (let s = 3; s < prof.length - 3; s += 17.3) {
        for (const d of [-3, 0, 2.5]) {
          sampleRoad(prof, s, smp);
          projectToRoad(prof, smp.x + smp.rx * d, smp.z + smp.rz * d, proj);
          expect(proj.s).toBeCloseTo(s, 1);
          expect(proj.d).toBeCloseTo(d, 2);
          expect(proj.dist).toBeCloseTo(Math.abs(d), 2);
          expect(proj.y).toBeCloseTo(smp.y + smp.bank * d, 2);
        }
      }
    }
  });

  it('measures distance past open ends (round caps)', () => {
    const p = projectToRoad(S, 120, 0, createRoadProjection());
    expect(p.s).toBeCloseTo(S.length, 6);
    expect(p.dist).toBeCloseTo(20, 3);
  });

  it('hinted local search agrees with the brute force', () => {
    const rng = createRng(99);
    const a = createRoadProjection();
    const b = createRoadProjection();
    for (let k = 0; k < 300; k++) {
      const s = rng.range(0, C.length);
      const smp = sampleRoad(C, s, createRoadSample());
      const x = smp.x + rng.range(-6, 6);
      const z = smp.z + rng.range(-6, 6);
      projectToRoad(C, x, z, a);
      projectToRoad(C, x, z, b, s + rng.range(-30, 30));
      expect(b.dist).toBeCloseTo(a.dist, 9);
      expect(b.s).toBeCloseTo(a.s, 6);
    }
    // A stale hint far away still finds the right place by walking.
    projectToRoad(C, 100, 0, a);
    projectToRoad(C, 100, 0, b, C.length / 2);
    expect(b.dist).toBeCloseTo(a.dist, 6);
  });
});

describe('deterministic angles', () => {
  it('detAtan2 matches Math.atan2 to 1e-9', () => {
    const rng = createRng(5);
    for (let k = 0; k < 5000; k++) {
      const x = rng.range(-10, 10);
      const y = rng.range(-10, 10);
      expect(Math.abs(detAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-9);
    }
    for (const [y, x] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1e-12, -1]] as const) {
      expect(Math.abs(detAtan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-9);
    }
  });

  it('headingToYaw follows the vehicle convention (yaw 0 faces −Z, π/2 faces −X)', () => {
    expect(headingToYaw(0, -1)).toBeCloseTo(0, 12);
    expect(headingToYaw(-1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(headingToYaw(1, 0)).toBeCloseTo(-Math.PI / 2, 12);
    expect(Math.abs(headingToYaw(0, 1))).toBeCloseTo(Math.PI, 12);
  });
});
