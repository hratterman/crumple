import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from './layout';
import { createRoadProjection, createRoadSample, projectToRoad, sampleRoad, structureAt } from './roads';
import { baseSurface } from './surfaces';
import { compileShape } from './shapes';
import { dominantMaterial, generateTerrain, hashTerrain, lastTerrainTimings } from './terrain';
import {
  ROAD_KIND_DEFAULTS,
  RoadStation,
  ROAD_STATION_STRIDE,
  type TerrainData,
  type WorldLayout,
} from './types';

/** Small synthetic layout (256 m) exercising every zone kind, a pad and two roads. */
function smallLayout(seed = 1234): WorldLayout {
  return {
    id: 'test-small',
    name: 'Test',
    version: 1,
    seed,
    size: 256,
    terrain: {
      spacing: 1,
      baseHeight: 10,
      detail: { amplitude: 2, wavelength: 120, octaves: 3 },
      edgeRise: { width: 20, height: 10 },
      minHeight: -10,
      maxHeight: 120,
    },
    waterLevel: 6,
    zones: [
      { id: 'pl', name: 'p', kind: 'plains', shape: { type: 'rect', center: [0, 40], halfX: 100, halfZ: 40, blend: 20 }, params: { detail: { amplitude: 1, wavelength: 40, octaves: 3 } } },
      { id: 'hi', name: 'h', kind: 'hills', shape: { type: 'circle', center: [-60, -40], radius: 40, blend: 20 }, params: { noise: { amplitude: 6, wavelength: 50, octaves: 3 }, lift: 3 } },
      {
        id: 'mt',
        name: 'm',
        kind: 'mountains',
        shape: { type: 'polygon', points: [[0, -128], [128, -128], [128, 0], [0, 0]], blend: 20 },
        params: { peaks: [{ name: 'p', center: [70, -70], height: 50, radiusX: 60, radiusZ: 50 }], ridged: { amplitude: 5, wavelength: 50, octaves: 5 }, rockSlope: 0.65 },
      },
      { id: 'lk', name: 'l', kind: 'lake', shape: { type: 'ellipse', center: [-60, 60], radiusX: 30, radiusZ: 22, blend: 10 }, params: { depth: 4, shoreLift: 1 } },
      { id: 'ar', name: 'a', kind: 'arena', shape: { type: 'rect', center: [60, 60], halfX: 25, halfZ: 25, blend: 10 }, params: { height: 10, material: 5 } },
    ],
    pads: [{ id: 'pad', purpose: 'lookout', shape: { type: 'circle', center: [20, -40], radius: 8, blend: 6 }, height: null, material: 4 }],
    roads: [
      {
        id: 'loop',
        name: 'Loop',
        kind: 'country',
        closed: true,
        points: [[-90, null, 0], [-30, null, -95], [40, null, -100], [95, null, -10], [95, null, 95], [0, null, 100], [-95, null, 95]],
        width: 7,
        lanes: 1,
        shoulder: 1,
        bank: 0.05,
        material: 0,
        markings: 'center',
      },
      {
        id: 'spur',
        name: 'Spur',
        kind: 'dirt',
        closed: false,
        points: [[-90, null, 0], [-40, null, 10], [10, null, 20], [40, null, 60]],
        width: 4,
        lanes: 1,
        shoulder: 1,
        material: 2,
        markings: 'none',
      },
    ],
    junctions: [{ id: 'j', pos: [-90, 0], roads: ['loop', 'spur'] }],
    spawnPoints: [
      { id: 's1', name: 'S1', road: { id: 'loop', s: 30, d: 2 } },
      { id: 's2', name: 'S2', pos: [60, 60], yaw: 1 },
    ],
    colliders: [],
    props: [],
  };
}

const at = (t: TerrainData, x: number, z: number): number => {
  const u = (x - t.originX) / t.spacing;
  const v = (z - t.originZ) / t.spacing;
  const c = Math.min(Math.max(Math.floor(u), 0), t.cols - 2);
  const r = Math.min(Math.max(Math.floor(v), 0), t.rows - 2);
  const fu = u - c;
  const fv = v - r;
  const i = r * t.cols + c;
  const h = t.heights;
  const a = h[i]! + (h[i + 1]! - h[i]!) * fu;
  const b = h[i + t.cols]! + (h[i + t.cols + 1]! - h[i + t.cols]!) * fu;
  return a + (b - a) * fv;
};

describe('generateTerrain (DEFAULT_LAYOUT)', () => {
  let t: TerrainData;
  let again: TerrainData;
  let ms = Infinity;

  beforeAll(() => {
    // Two runs: the second is the determinism check; the budget is asserted on
    // the faster one so a transient load spike on a shared runner cannot flake it.
    // The budget is CPU time of this process (generation is synchronous on one thread), so a
    // descheduled run on an oversubscribed box does not count against it; wall time is logged too.
    const cpuMs = (): number => {
      const u = (globalThis as unknown as { process: { cpuUsage(): { user: number; system: number } } }).process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    for (let k = 0; k < 2; k++) {
      const t0 = performance.now();
      const c0 = cpuMs();
      const r = generateTerrain(DEFAULT_LAYOUT);
      const cpu = cpuMs() - c0;
      const dt = performance.now() - t0;
      if (k === 0) t = r;
      else again = r;
      ms = Math.min(ms, cpu);
      const stages = Object.entries(lastTerrainTimings)
        .map(([n, v]) => `${n} ${v.toFixed(0)}`)
        .join(', ');
      console.log(`generateTerrain(${DEFAULT_LAYOUT.id}) run ${k + 1}: ${dt.toFixed(0)} ms (cpu ${cpu.toFixed(0)}), hash 0x${r.hash.toString(16)}, h ${r.minHeight.toFixed(1)}..${r.maxHeight.toFixed(1)} [${stages}]`);
    }
  }, 120_000);

  // Layout v6 (2560 m, 3.3× the P3 samples): target < 6 s CPU (~8 s measured on a loaded 4-core
  // box; the browser caches it per build). The hard ceiling is loose because shared CI/dev machines
  // are often oversubscribed; it only catches pathological regressions. Watch the logged timings.
  it('runs within the regression ceiling (< 25 s CPU; target < 6 s)', () => {
    expect(ms).toBeLessThan(25_000);
  });

  it('has the contract grid dimensions', () => {
    const n = DEFAULT_LAYOUT.size + 1; // layout v6: 2560 m → 2561²
    expect(n).toBe(2561);
    expect(t.cols).toBe(n);
    expect(t.rows).toBe(n);
    expect(t.heights.length).toBe(n * n);
    expect(t.splat.length).toBe(n * n * 4);
    expect(t.material.length).toBe(n * n);
    expect(t.originX).toBe(-DEFAULT_LAYOUT.size / 2);
    expect(t.originZ).toBe(-DEFAULT_LAYOUT.size / 2);
    expect(t.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(t.roads.map((r) => r.id)).toEqual(DEFAULT_LAYOUT.roads.map((r) => r.id));
    expect(t.spawns.map((s) => s.id)).toEqual(DEFAULT_LAYOUT.spawnPoints.map((s) => s.id));
  });

  it('is deterministic (same hash and bytes twice)', () => {
    expect(again.hash).toBe(t.hash);
    expect(hashTerrain(again)).toBe(t.hash);
    let diff = 0;
    for (let i = 0; i < t.heights.length; i++) if (again.heights[i] !== t.heights[i]) diff++;
    expect(diff).toBe(0);
    for (let i = 0; i < t.roads.length; i++) expect(again.roads[i]!.stations).toEqual(t.roads[i]!.stations);
    expect(again.spawns).toEqual(t.spawns);
  });

  it('has no NaN and stays in the expected height range', () => {
    let lo = Infinity;
    let hi = -Infinity;
    let bad = 0;
    for (const h of t.heights) {
      if (!Number.isFinite(h)) bad++;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    expect(bad).toBe(0);
    expect(t.minHeight).toBe(lo);
    expect(t.maxHeight).toBe(hi);
    expect(lo).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.terrain.minHeight);
    expect(hi).toBeLessThanOrEqual(DEFAULT_LAYOUT.terrain.maxHeight);
    // Lake floor ≈ waterLevel − depth; Crumple Peak ≈ 10 + 150 (+ ridges).
    expect(lo).toBeGreaterThan(DEFAULT_LAYOUT.waterLevel - 8 - 2.5);
    expect(hi).toBeGreaterThan(150);
    expect(hi).toBeLessThan(200);
  });

  it('keeps the lake below the water level with a dry shore', () => {
    const lake = DEFAULT_LAYOUT.zones.find((z) => z.kind === 'lake')!;
    const s = compileShape(lake.shape);
    let wet = 0;
    let aboveWater = 0;
    let dryShore = 0;
    let shore = 0;
    for (let r = 0; r < t.rows; r += 2) {
      for (let c = 0; c < t.cols; c += 2) {
        const x = t.originX + c;
        const z = t.originZ + r;
        const rr = s.radius(x, z);
        const h = t.heights[r * t.cols + c]!;
        // The shoreline wanders ±14 m around the ellipse (r ≈ 0.9 – 1.1).
        if (rr <= 0.85) {
          wet++;
          if (h >= DEFAULT_LAYOUT.waterLevel) aboveWater++;
        } else if (s.outside(x, z) > 20 && s.outside(x, z) < lake.shape.blend + 20) {
          shore++;
          if (h >= DEFAULT_LAYOUT.waterLevel + 0.5) dryShore++;
        }
      }
    }
    expect(wet).toBeGreaterThan(1000);
    expect(aboveWater).toBe(0);
    expect(dryShore / shore).toBeGreaterThan(0.95);
    const [cx, cz] = (lake.shape as { center: readonly [number, number] }).center;
    expect(at(t, cx, cz)).toBeLessThan(DEFAULT_LAYOUT.waterLevel - 8 * 0.8);
  });

  it('flattens the arena pad to ±2 cm', () => {
    const arena = DEFAULT_LAYOUT.zones.find((z) => z.kind === 'arena')!;
    const s = compileShape(arena.shape);
    const H = (arena.params as { height: number }).height;
    let n = 0;
    let worst = 0;
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const x = t.originX + c;
        const z = t.originZ + r;
        if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ || s.outside(x, z) > 0) continue;
        n++;
        worst = Math.max(worst, Math.abs(t.heights[r * t.cols + c]! - H));
      }
    }
    expect(n).toBeGreaterThan(180 * 180 * 0.95);
    expect(worst).toBeLessThanOrEqual(0.02);
  });

  it('keeps splat sums ≤ 255 and material = dominant splat channel (v6 surfaces: their base)', () => {
    const { splat, material } = t;
    const counts = new Array(15).fill(0);
    let over = 0;
    let mismatch = 0;
    for (let i = 0; i < material.length; i++) {
      const o = i * 4;
      const q0 = splat[o]!;
      const q1 = splat[o + 1]!;
      const q2 = splat[o + 2]!;
      const q3 = splat[o + 3]!;
      if (q0 + q1 + q2 + q3 > 255) over++;
      const m = material[i]!;
      counts[m]++;
      const b = baseSurface(m);
      const paved = b === 5 ? 5 : 0;
      if (b !== dominantMaterial(q0, q1, q2, q3, paved)) mismatch++;
    }
    expect(over).toBe(0);
    expect(mismatch).toBe(0);
    console.log(`material share %: ${counts.map((c) => ((100 * c) / material.length).toFixed(2)).join(' / ')} (asphalt grass dirt rock gravel concrete metal · · · · mud sand wetGrass asphaltWorn)`);
    // Every ground material occurs (v6: mud, sand, wet grass, worn asphalt too); grass dominates the map.
    for (const m of [0, 1, 2, 3, 4, 5, 11, 12, 13, 14]) expect(counts[m], `material ${m}`).toBeGreaterThan(500);
    expect(counts[1]).toBeGreaterThan(material.length * 0.4);
  });

  it('carves roads flat across (cross-slope ≤ bank + 1 %) on their resolved profile', () => {
    const smp = createRoadSample();
    for (const [ri, prof] of t.roads.entries()) {
      const def = DEFAULT_LAYOUT.roads[ri]!;
      const maxBank = def.bank ?? 0;
      const a = prof.width / 2;
      let worstCross = 0;
      let worstY = 0;
      let checked = 0;
      for (let s = 0; s <= prof.length; s += 3) {
        sampleRoad(prof, s, smp);
        // Skip junction surroundings (another road's surface wins there).
        const nearJ = DEFAULT_LAYOUT.junctions.some(
          (j) => j.roads.includes(prof.id) && Math.hypot(j.pos[0] - smp.x, j.pos[1] - smp.z) < 45,
        );
        if (nearJ) continue;
        if (!prof.closed && (s < 6 || s > prof.length - 6)) continue;
        // Layout v6 bridges: the deck is the profile; the terrain below is not carved.
        const st = structureAt(prof, s);
        if (st && st.kind === 'bridge') continue;
        if (prof.structures?.some((b) => b.kind === 'bridge' && s > b.s0 - 12 && s < b.s1 + 12)) continue;
        const d = 0.8 * a;
        const hl = at(t, smp.x - smp.rx * d, smp.z - smp.rz * d);
        const hr = at(t, smp.x + smp.rx * d, smp.z + smp.rz * d);
        const hc = at(t, smp.x, smp.z);
        worstCross = Math.max(worstCross, Math.abs((hr - hl) / (2 * d)));
        worstY = Math.max(worstY, Math.abs(hc - smp.y));
        checked++;
      }
      let bridged = 0;
      for (const b of prof.structures ?? []) if (b.kind === 'bridge') bridged += b.s1 - b.s0 + 24;
      if (prof.length - bridged > 120) expect(checked, prof.id).toBeGreaterThan(5);
      expect(worstCross, `${prof.id} cross-slope`).toBeLessThanOrEqual(maxBank + 0.01);
      expect(worstY, `${prof.id} surface vs profile`).toBeLessThan(0.05);
    }
  });

  it('keeps every road within its kind grade limit', () => {
    for (const prof of t.roads) {
      const st = prof.stations;
      const maxG = ROAD_KIND_DEFAULTS[prof.kind].maxGrade;
      const n = prof.stationCount;
      let worst = 0;
      for (let i = 0; i < (prof.closed ? n : n - 1); i++) {
        const a = i * ROAD_STATION_STRIDE;
        const b = ((i + 1) % n) * ROAD_STATION_STRIDE;
        const run = Math.hypot(st[b]! - st[a]!, st[b + 2]! - st[a + 2]!);
        if (run < 0.25) continue;
        worst = Math.max(worst, Math.abs(st[b + 1]! - st[a + 1]!) / run);
      }
      expect(worst, prof.id).toBeLessThanOrEqual(maxG);
    }
  });

  it('has well-formed road profiles (spacing, unit tangents, bank limits)', () => {
    for (const [ri, prof] of t.roads.entries()) {
      const st = prof.stations;
      expect(st.length).toBe(prof.stationCount * ROAD_STATION_STRIDE);
      const maxBank = DEFAULT_LAYOUT.roads[ri]!.bank ?? 0;
      let bad = 0;
      for (let i = 0; i < prof.stationCount; i++) {
        const o = i * ROAD_STATION_STRIDE;
        for (let k = 0; k < ROAD_STATION_STRIDE; k++) if (!Number.isFinite(st[o + k]!)) bad++;
        if (Math.abs(Math.hypot(st[o + RoadStation.tx]!, st[o + RoadStation.tz]!) - 1) > 1e-9) bad++;
        if (Math.abs(st[o + RoadStation.bank]!) > maxBank + 1e-9) bad++;
      }
      // Station chord ≈ 2 m (3D arc spacing). Terrain-following dirt roads through rough hills
      // (the v6 rally stage) keep the spline's arc spacing while their final profile is smoothed and
      // grade-limited, so their chords may shorten to 1.7 m.
      const lo = prof.kind === 'dirt' ? 1.7 : 1.9;
      for (let i = 1; i < prof.stationCount - 1; i++) {
        const a = (i - 1) * ROAD_STATION_STRIDE;
        const b = i * ROAD_STATION_STRIDE;
        const d = Math.hypot(st[b]! - st[a]!, st[b + 1]! - st[a + 1]!, st[b + 2]! - st[a + 2]!);
        if (d < lo || d > 2.05) bad++;
      }
      expect(bad, prof.id).toBe(0);
    }
  });

  it('joins roads continuously at junctions (< 5 cm)', () => {
    const proj = createRoadProjection();
    for (const j of DEFAULT_LAYOUT.junctions) {
      const profs = j.roads.map((id) => t.roads.find((r) => r.id === id)!);
      const through = profs.reduce((a, b) =>
        ROAD_KIND_DEFAULTS[b.kind].priority > ROAD_KIND_DEFAULTS[a.kind].priority ? b : a,
      );
      projectToRoad(through, j.pos[0], j.pos[1], proj);
      const yThrough = proj.y;
      expect(proj.dist, `${j.id} through`).toBeLessThan(1.05);
      expect(Math.abs(at(t, j.pos[0], j.pos[1]) - yThrough), `${j.id} terrain`).toBeLessThan(0.05);
      for (const p of profs) {
        projectToRoad(p, j.pos[0], j.pos[1], proj);
        expect(proj.dist, `${j.id}/${p.id}`).toBeLessThan(1.05);
        expect(Math.abs(proj.y - yThrough), `${j.id}/${p.id} surface`).toBeLessThan(0.05);
      }
    }
  });

  it('lets roads meet only at junctions', () => {
    const proj = createRoadProjection();
    const reach = (id: string): number => {
      const r = DEFAULT_LAYOUT.roads.find((q) => q.id === id)!;
      return r.width / 2 + r.shoulder;
    };
    for (let a = 0; a < t.roads.length; a++) {
      for (let b = a + 1; b < t.roads.length; b++) {
        const A = t.roads[a]!;
        const B = t.roads[b]!;
        const lim = reach(A.id) + reach(B.id) + 2;
        for (let i = 0; i < A.stationCount; i++) {
          const x = A.stations[i * ROAD_STATION_STRIDE]!;
          const z = A.stations[i * ROAD_STATION_STRIDE + 2]!;
          projectToRoad(B, x, z, proj);
          if (proj.dist >= lim) continue;
          // Layout v6 overpass exception: one road crosses the other on a bridge span.
          const sA = i * 2;
          if (structureAt(A, sA)?.kind === 'bridge' || structureAt(B, proj.s)?.kind === 'bridge') continue;
          const ok = DEFAULT_LAYOUT.junctions.some(
            (j) => j.roads.includes(A.id) && j.roads.includes(B.id) && Math.hypot(j.pos[0] - x, j.pos[1] - z) < 40,
          );
          expect(ok, `${A.id} meets ${B.id} at (${x.toFixed(0)}, ${z.toFixed(0)}) outside a junction`).toBe(true);
        }
      }
    }
  });

  it('grades hairpin interiors to the road (no pit below the legs)', () => {
    // Every R < 17 m apex (the R16 hairpins) of the mountain road: the ground inside the turn
    // (its curvature disc, clear of the verge) must not sink more than 1 m
    // below the lowest road station around it.
    const prof = t.roads.find((r) => r.kind === 'mountain')!;
    const st = prof.stations;
    const S = ROAD_STATION_STRIDE;
    const verge = prof.width / 2 + prof.shoulder;
    let apexes = 0;
    for (let i = 2; i < prof.stationCount - 2; i++) {
      const k = st[i * S + RoadStation.curvature]!;
      const kPrev = Math.abs(st[(i - 1) * S + RoadStation.curvature]!);
      const kNext = Math.abs(st[(i + 1) * S + RoadStation.curvature]!);
      if (Math.abs(k) < 1 / 17 || Math.abs(k) < kPrev || Math.abs(k) <= kNext) continue;
      apexes++;
      const R = 1 / Math.abs(k);
      const sg = Math.sign(k);
      const cx = st[i * S]! - st[i * S + RoadStation.tz]! * sg * R;
      const cz = st[i * S + 2]! + st[i * S + RoadStation.tx]! * sg * R;
      let roadMin = Infinity;
      for (let j = 0; j < prof.stationCount; j++) {
        if (Math.hypot(st[j * S]! - cx, st[j * S + 2]! - cz) < R + verge) roadMin = Math.min(roadMin, st[j * S + 1]!);
      }
      const inner = R - verge - 1;
      let lo = Infinity;
      for (let a = 0; a < 32; a++) {
        for (const f of [0, 0.4, 0.8, 1]) {
          const x = cx + Math.cos((a / 32) * 2 * Math.PI) * inner * f;
          const z = cz + Math.sin((a / 32) * 2 * Math.PI) * inner * f;
          lo = Math.min(lo, at(t, x, z));
        }
      }
      expect(lo, `hairpin at station ${i} (${cx.toFixed(0)}, ${cz.toFixed(0)})`).toBeGreaterThan(roadMin - 1);
    }
    expect(apexes).toBeGreaterThanOrEqual(3);
  });

  it('resolves spawns onto the carved surface', () => {
    for (const [k, s] of t.spawns.entries()) {
      const def = DEFAULT_LAYOUT.spawnPoints[k]!;
      const [x, y, z] = s.pos;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(s.yaw)).toBe(true);
      const prof0 = def.road ? t.roads.find((r) => r.id === def.road!.id)! : null;
      const onDeck = prof0 !== null && structureAt(prof0, def.road!.s)?.kind === 'bridge';
      if (!onDeck) expect(Math.abs(y - at(t, x, z))).toBeLessThan(1e-3);
      if (def.road) {
        const prof = t.roads.find((r) => r.id === def.road!.id)!;
        const proj = projectToRoad(prof, x, z, createRoadProjection());
        expect(Math.abs(proj.d - def.road.d)).toBeLessThan(0.05);
        expect(Math.abs(y - proj.y)).toBeLessThan(0.05);
        // Heading = direction of travel: yaw 0 faces −Z, π/2 faces −X.
        // `reverse` faces against the station order.
        const smp = sampleRoad(prof, proj.s, createRoadSample());
        const dir = def.road.reverse ? -1 : 1;
        expect(-Math.sin(s.yaw)).toBeCloseTo(dir * smp.tx, 3);
        expect(-Math.cos(s.yaw)).toBeCloseTo(dir * smp.tz, 3);
      } else {
        expect(s.yaw).toBe(def.yaw);
      }
    }
  });
});

describe('generateTerrain (small layout)', () => {
  // Three generations of the 257² layout (~1 s idle): an explicit budget, not the 5 s default.
  it('is deterministic and the hash follows the seed', { timeout: 60_000 }, () => {
    const a = generateTerrain(smallLayout(1));
    const b = generateTerrain(smallLayout(1));
    const c = generateTerrain(smallLayout(2));
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(a.cols).toBe(257);
    // Changing only splat/material also changes the hash (all arrays are hashed).
    const d = { ...a, material: a.material.slice() };
    d.material[0] = (d.material[0]! + 1) % 7;
    expect(hashTerrain(d)).not.toBe(a.hash);
    const e = { ...a, roads: a.roads.map((r) => ({ ...r, stations: r.stations.slice() })) };
    e.roads[0]!.stations[1] = e.roads[0]!.stations[1]! + 1e-9;
    expect(hashTerrain(e)).not.toBe(a.hash);
  });

  it('honours the junction and pad contracts on a synthetic map', () => {
    const t = generateTerrain(smallLayout(7));
    const loop = t.roads[0]!;
    const spur = t.roads[1]!;
    const proj = createRoadProjection();
    projectToRoad(loop, -90, 0, proj);
    const y0 = proj.y;
    projectToRoad(spur, -90, 0, proj);
    expect(Math.abs(proj.y - y0)).toBeLessThan(0.05);
    // Pad with height null: flat at the mean pre-pad height (core samples away from roads).
    const pad = compileShape(smallLayout().pads[0]!.shape);
    const hs: number[] = [];
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const x = t.originX + c;
        const z = t.originZ + r;
        if (pad.outside(x, z) <= 0) hs.push(t.heights[r * t.cols + c]!);
      }
    }
    expect(hs.length).toBeGreaterThan(150);
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(0.02);
    expect(t.heights.every((h) => Number.isFinite(h))).toBe(true);
  });
});
