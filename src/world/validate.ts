/**
 * Static WorldLayout validation (A). generateTerrain calls this first; the
 * geometric junction check (every listed road passes within 1 m of the
 * junction) runs inside road resolution, once the centrelines exist.
 * Throws WorldLayoutError with a path-like message on the first problem.
 */
import {
  ROAD_KIND_DEFAULTS,
  TERRAIN_CHUNK_CELLS,
  WorldLayoutError,
  type NoiseParams,
  type Vec2,
  type WorldLayout,
  type ZoneShape,
} from './types';

import { isTerrainMaterial } from '../protocol/messages';
/** Prop placement shape limits (P5). */
export const PROP_MAX_STACK = 16;
export const PROP_MAX_ROW = 256;

const fail = (msg: string): never => {
  throw new WorldLayoutError(msg);
};

const finite = (v: unknown, where: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: expected a finite number, got ${String(v)}`);
  return v as number;
};

const positive = (v: unknown, where: string): number => {
  const n = finite(v, where);
  if (!(n > 0)) fail(`${where}: must be > 0 (got ${n})`);
  return n;
};

function checkVec2(p: Vec2 | undefined, where: string, half: number): void {
  if (!p || p.length !== 2) fail(`${where}: expected [x, z]`);
  const x = finite(p![0], `${where}[0]`);
  const z = finite(p![1], `${where}[1]`);
  if (Math.abs(x) > half || Math.abs(z) > half) fail(`${where}: (${x}, ${z}) lies outside the map (±${half} m)`);
}

function checkAxis(axis: Vec2 | undefined, where: string): void {
  if (axis === undefined) return;
  const ax = finite(axis[0], `${where}.axis[0]`);
  const az = finite(axis[1], `${where}.axis[1]`);
  if (Math.abs(Math.sqrt(ax * ax + az * az) - 1) > 1e-3) fail(`${where}.axis must be a unit vector`);
}

function checkShape(s: ZoneShape, where: string, half: number): void {
  if (!s || typeof s !== 'object') fail(`${where}: missing shape`);
  if (!(finite(s.blend, `${where}.blend`) >= 0)) fail(`${where}.blend must be >= 0`);
  switch (s.type) {
    case 'circle':
      checkVec2(s.center, `${where}.center`, half);
      positive(s.radius, `${where}.radius`);
      break;
    case 'ellipse':
      checkVec2(s.center, `${where}.center`, half);
      positive(s.radiusX, `${where}.radiusX`);
      positive(s.radiusZ, `${where}.radiusZ`);
      checkAxis(s.axis, where);
      break;
    case 'rect':
      checkVec2(s.center, `${where}.center`, half);
      positive(s.halfX, `${where}.halfX`);
      positive(s.halfZ, `${where}.halfZ`);
      checkAxis(s.axis, where);
      break;
    case 'polygon':
      if (!Array.isArray(s.points) || s.points.length < 3) fail(`${where}: polygon needs >= 3 points`);
      // Polygons may extend to the map edge (zones covering a whole side).
      s.points.forEach((p, i) => checkVec2(p, `${where}.points[${i}]`, half + 1e-9));
      break;
    default:
      fail(`${where}: unknown shape type ${(s as { type: string }).type}`);
  }
}

function checkNoise(p: NoiseParams, where: string): void {
  if (!p) fail(`${where}: missing noise params`);
  if (!(finite(p.amplitude, `${where}.amplitude`) >= 0)) fail(`${where}.amplitude must be >= 0`);
  positive(p.wavelength, `${where}.wavelength`);
  if (!Number.isInteger(p.octaves) || p.octaves < 1 || p.octaves > 12) fail(`${where}.octaves must be an integer in 1..12`);
  if (p.lacunarity !== undefined) positive(p.lacunarity, `${where}.lacunarity`);
  if (p.gain !== undefined) positive(p.gain, `${where}.gain`);
}

function checkMaterial(m: unknown, where: string): void {
  if (!Number.isInteger(m) || !isTerrainMaterial(m as number)) fail(`${where}: invalid terrain MaterialId ${String(m)}`);
}

function uniqueIds(items: readonly { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const it of items) {
    if (typeof it.id !== 'string' || it.id.length === 0) fail(`${what}: empty id`);
    if (seen.has(it.id)) fail(`${what}: duplicate id '${it.id}'`);
    seen.add(it.id);
  }
}

/** Static checks of a WorldLayout. Throws WorldLayoutError. */
export function validateLayout(layout: WorldLayout): void {
  if (!layout || typeof layout !== 'object') fail('layout: missing');
  if (typeof layout.id !== 'string' || layout.id.length === 0) fail('layout.id: empty');
  if (!Number.isInteger(layout.version) || layout.version < 0) fail('layout.version must be a non-negative integer');
  if (!Number.isInteger(layout.seed)) fail('layout.seed must be an integer');
  const t = layout.terrain;
  if (!t) fail('layout.terrain: missing');
  const spacing = positive(t.spacing, 'terrain.spacing');
  const size = positive(layout.size, 'layout.size');
  const cells = size / spacing;
  if (!Number.isInteger(cells) || cells % TERRAIN_CHUNK_CELLS !== 0) {
    fail(`layout.size / terrain.spacing = ${cells} must be an integer multiple of ${TERRAIN_CHUNK_CELLS}`);
  }
  if (cells > 8192) fail(`layout.size / terrain.spacing = ${cells} is too large (max 8192)`);
  finite(t.baseHeight, 'terrain.baseHeight');
  checkNoise(t.detail, 'terrain.detail');
  if (!t.edgeRise) fail('terrain.edgeRise: missing');
  if (!(finite(t.edgeRise.width, 'terrain.edgeRise.width') >= 0)) fail('terrain.edgeRise.width must be >= 0');
  finite(t.edgeRise.height, 'terrain.edgeRise.height');
  const minH = finite(t.minHeight, 'terrain.minHeight');
  const maxH = finite(t.maxHeight, 'terrain.maxHeight');
  if (!(minH < maxH)) fail('terrain.minHeight must be < terrain.maxHeight');
  const water = finite(layout.waterLevel, 'layout.waterLevel');
  if (water < minH || water > maxH) fail('layout.waterLevel outside [minHeight, maxHeight]');

  const half = size / 2;
  for (const key of ['zones', 'pads', 'roads', 'junctions', 'spawnPoints', 'colliders', 'props'] as const) {
    if (!Array.isArray(layout[key])) fail(`layout.${key} must be an array`);
  }
  uniqueIds(layout.zones, 'zones');
  uniqueIds(layout.pads, 'pads');
  uniqueIds(layout.roads, 'roads');
  uniqueIds(layout.junctions, 'junctions');
  uniqueIds(layout.spawnPoints, 'spawnPoints');

  layout.zones.forEach((z, i) => {
    const w = `zones[${i}] '${z.id}'`;
    checkShape(z.shape, `${w}.shape`, half);
    switch (z.kind) {
      case 'plains':
        checkNoise(z.params.detail, `${w}.params.detail`);
        break;
      case 'hills':
        checkNoise(z.params.noise, `${w}.params.noise`);
        finite(z.params.lift, `${w}.params.lift`);
        break;
      case 'mountains':
        if (!Array.isArray(z.params.peaks) || z.params.peaks.length === 0) fail(`${w}.params.peaks: need >= 1 peak`);
        z.params.peaks.forEach((p, k) => {
          const pw = `${w}.params.peaks[${k}]`;
          checkVec2(p.center, `${pw}.center`, half);
          finite(p.height, `${pw}.height`);
          positive(p.radiusX, `${pw}.radiusX`);
          positive(p.radiusZ, `${pw}.radiusZ`);
          checkAxis(p.axis, pw);
        });
        checkNoise(z.params.ridged, `${w}.params.ridged`);
        positive(z.params.rockSlope, `${w}.params.rockSlope`);
        break;
      case 'lake':
        if (z.shape.type !== 'circle' && z.shape.type !== 'ellipse') fail(`${w}: lake shape must be a circle or ellipse`);
        if (!(finite(z.params.depth, `${w}.params.depth`) >= 0)) fail(`${w}.params.depth must be >= 0`);
        if (!(finite(z.params.shoreLift, `${w}.params.shoreLift`) >= 0)) fail(`${w}.params.shoreLift must be >= 0`);
        break;
      case 'arena':
        finite(z.params.height, `${w}.params.height`);
        checkMaterial(z.params.material, `${w}.params.material`);
        break;
      case 'town':
        finite(z.params.height, `${w}.params.height`);
        break;
      default:
        fail(`${w}: unknown zone kind ${(z as { kind: string }).kind}`);
    }
  });

  layout.pads.forEach((p, i) => {
    const w = `pads[${i}] '${p.id}'`;
    checkShape(p.shape, `${w}.shape`, half);
    if (p.height !== null) finite(p.height, `${w}.height`);
    if (p.material !== undefined) checkMaterial(p.material, `${w}.material`);
  });

  const roadIds = new Set<string>();
  layout.roads.forEach((r, i) => {
    const w = `roads[${i}] '${r.id}'`;
    roadIds.add(r.id);
    if (!(r.kind in ROAD_KIND_DEFAULTS)) fail(`${w}: unknown road kind '${r.kind}'`);
    if (!Array.isArray(r.points) || r.points.length < (r.closed ? 3 : 2)) {
      fail(`${w}: needs >= ${r.closed ? 3 : 2} control points`);
    }
    r.points.forEach((p, k) => {
      if (!p || p.length !== 3) fail(`${w}.points[${k}]: expected [x, y|null, z]`);
      checkVec2([p[0], p[2]], `${w}.points[${k}]`, half);
      if (p[1] !== null) finite(p[1], `${w}.points[${k}][1]`);
      const q = r.points[k - 1];
      if (q && Math.abs(q[0] - p[0]) + Math.abs(q[2] - p[2]) < 0.5) fail(`${w}.points[${k}]: duplicate of the previous point`);
    });
    positive(r.width, `${w}.width`);
    if (!Number.isInteger(r.lanes) || r.lanes < 1) fail(`${w}.lanes must be an integer >= 1`);
    if (!(finite(r.shoulder, `${w}.shoulder`) >= 0)) fail(`${w}.shoulder must be >= 0`);
    if (r.bank !== undefined && !(finite(r.bank, `${w}.bank`) >= 0 && r.bank <= 0.2)) fail(`${w}.bank must be in [0, 0.2]`);
    checkMaterial(r.material, `${w}.material`);
    if (!['highway', 'center', 'edge', 'none'].includes(r.markings)) fail(`${w}: unknown markings '${r.markings}'`);
  });

  layout.junctions.forEach((j, i) => {
    const w = `junctions[${i}] '${j.id}'`;
    checkVec2(j.pos, `${w}.pos`, half);
    if (!Array.isArray(j.roads) || j.roads.length < 2) fail(`${w}: needs >= 2 roads`);
    const seen = new Set<string>();
    for (const id of j.roads) {
      if (!roadIds.has(id)) fail(`${w}: unknown road '${id}'`);
      if (seen.has(id)) fail(`${w}: road '${id}' listed twice`);
      seen.add(id);
    }
  });

  // Props (P5): shape checks only — the catalog key, stackability and proxy
  // overlap are checked by resolvePropInstances (src/world never imports src/sim).
  uniqueIds(layout.props, 'props');
  const padIds = new Set(layout.pads.map((p) => p.id));
  layout.props.forEach((p, i) => {
    const w = `props[${i}] '${p.id}'`;
    if (typeof p.prop !== 'string' || p.prop.length === 0) fail(`${w}.prop: expected a catalog key`);
    if (!Array.isArray(p.pos) || p.pos.length !== 3) fail(`${w}.pos: expected [x, y|null, z]`);
    checkVec2([p.pos[0], p.pos[2]], `${w}.pos`, half);
    if (p.pos[1] !== null) finite(p.pos[1], `${w}.pos[1]`);
    if (p.facing !== undefined) {
      const fx = finite(p.facing[0], `${w}.facing[0]`);
      const fz = finite(p.facing[1], `${w}.facing[1]`);
      if (Math.abs(Math.sqrt(fx * fx + fz * fz) - 1) > 1e-3) fail(`${w}.facing must be a unit vector`);
    }
    if (p.stack !== undefined && (!Number.isInteger(p.stack) || p.stack < 1 || p.stack > PROP_MAX_STACK)) {
      fail(`${w}.stack must be an integer in 1..${PROP_MAX_STACK}`);
    }
    if (p.row !== undefined) {
      if (!p.row || !Number.isInteger(p.row.count) || p.row.count < 1 || p.row.count > PROP_MAX_ROW) {
        fail(`${w}.row.count must be an integer in 1..${PROP_MAX_ROW}`);
      }
      if (!Array.isArray(p.row.step) || p.row.step.length !== 2) fail(`${w}.row.step: expected [x, z]`);
      finite(p.row.step[0], `${w}.row.step[0]`);
      finite(p.row.step[1], `${w}.row.step[1]`);
      const last: Vec2 = [p.pos[0] + (p.row.count - 1) * p.row.step[0], p.pos[2] + (p.row.count - 1) * p.row.step[1]];
      checkVec2(last, `${w}: last row copy`, half);
    }
    if (p.padId !== undefined && !padIds.has(p.padId)) fail(`${w}: unknown pad '${p.padId}'`);
  });

  layout.spawnPoints.forEach((s, i) => {
    const w = `spawnPoints[${i}] '${s.id}'`;
    if (s.road) {
      if (!roadIds.has(s.road.id)) fail(`${w}: unknown road '${s.road.id}'`);
      if (!(finite(s.road.s, `${w}.road.s`) >= 0)) fail(`${w}.road.s must be >= 0`);
      finite(s.road.d, `${w}.road.d`);
    } else {
      checkVec2(s.pos, `${w}.pos`, half);
      finite(s.yaw, `${w}.yaw`);
    }
  });
}
