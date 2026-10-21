/**
 * Buildings (R-WORLD render): every BuildingInstance → world-space walls,
 * roofs and roof clutter, merged into THREE draws for the whole map (walls,
 * roofs, trim/clutter) plus one for the sign boards.
 *
 * WALLS carry the facade rule as vertex attributes (aFac = bay width,
 * storey height, window width / height; aFac2 = wall layer, flags, door u,
 * seed) and the facade shader draws windows, shopfronts, doors and garage
 * doors per fragment. Windows are INTERIOR-MAPPED: the view ray is
 * intersected with a virtual room box behind the glass (side walls, floor,
 * ceiling, back wall with per-room tint, furniture band, blinds) and shown
 * through a glossy pane (the standard lighting adds the sky reflection); the
 * room light is emissive and scales with uWorldNight (R-GFX may drive it).
 * UV = metres: u along the facade from its left corner, v up from the floor.
 */
import {
  MeshStandardMaterial,
  Vector2,
  type DataArrayTexture,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { BuildingInstance } from '../../../world/content/types';
import { add, Geo, linear, norm, scale, type V3 } from './geo';
import { RoofLayer, WallLayer, WALL_TILE_M, ROOF_TILE_M } from './buildingTextures';

/** Facade flags (aFac2.y bits). */
const F_FRONT = 1;
const F_SHOP = 2;
const F_GARAGE = 4;
const F_BLANK = 8;
const F_CHURCH = 16;

export interface BuildingGeos {
  walls: Geo;
  roofs: Geo;
  trim: Geo;
}

export function newBuildingGeos(): BuildingGeos {
  return { walls: new Geo(true, true), roofs: new Geo(true, true), trim: new Geo(true) };
}

function rand(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Facade {
  bayW: number;
  storeyH: number;
  winW: number;
  winH: number;
  layer: number;
  flags: number;
  doorU: number;
}

function wallLayerOf(b: BuildingInstance): number {
  switch (b.style) {
    case 'warehouse':
    case 'hangar':
      return WallLayer.metal;
    case 'barn':
      return WallLayer.boards;
    case 'garage':
    case 'pitGarage':
    case 'lab':
      return WallLayer.block;
    case 'shop':
    case 'shopRow':
    case 'office':
      // brick-coloured walls read as brick, light ones as stucco
      return (b.wall >> 16) - (b.wall & 255) > 40 ? WallLayer.brick : WallLayer.stucco;
    case 'church':
    case 'diner':
    case 'gasStation':
      return WallLayer.stucco;
    default:
      return rand(b.seed, 7) < 0.75 ? WallLayer.siding : WallLayer.brick;
  }
}

/** Brick tint: luminance ratio to the texture's mean brick (linear ≈ 0.2), clamped, with 25 % of the hue. */
function brickTint(c: V3): V3 {
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = Math.min(1.25, Math.max(0.75, lum / 0.12));
  const m = Math.max(c[0], c[1], c[2], 1e-3);
  return [k * (0.75 + 0.25 * (c[0] / m)), k * (0.75 + 0.25 * (c[1] / m)), k * (0.75 + 0.25 * (c[2] / m))];
}

/** One wall quad (ground → top), CCW from outside; u0 = facade u at its left end. */
function wall(g: Geo, a: V3, b: V3, y0: number, y1: number, fac: Facade, color: V3, trim: V3, u0: number): void {
  g.color = color;
  g.extra = [fac.layer, fac.flags, fac.doorU, 0];
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const A: V3 = [a[0], y0, a[2]];
  const B: V3 = [b[0], y0, b[2]];
  const C: V3 = [b[0], y1, b[2]];
  const D: V3 = [a[0], y1, a[2]];
  const base = a[1];
  g.quadUV(A, B, C, D, [u0, y0 - base, u0 + len, y0 - base, u0 + len, y1 - base, u0, y1 - base]);
  void trim;
}

/** Per-wall-vertex facade rule (aFac): written after the quad (4 vertices). */
function setFac(g: Geo, fac: Facade, trim: V3): void {
  // aFac rides in the colour-free slot: we store it in a parallel array (facAttr) below.
  facAttr.push(fac.bayW, fac.storeyH, fac.winW, fac.winH, fac.bayW, fac.storeyH, fac.winW, fac.winH, fac.bayW, fac.storeyH, fac.winW, fac.winH, fac.bayW, fac.storeyH, fac.winW, fac.winH);
  for (let k = 0; k < 4; k++) trimAttr.push(trim[0], trim[1], trim[2]);
  void g;
}
let facAttr: number[] = [];
let trimAttr: number[] = [];

export function buildingAttrs(): { fac: Float32Array; trim: Float32Array } {
  const r = { fac: new Float32Array(facAttr), trim: new Float32Array(trimAttr) };
  facAttr = [];
  trimAttr = [];
  return r;
}

/** Adds a building's walls, roof and clutter. */
export function addBuilding(geo: BuildingGeos, b: BuildingInstance, groundAt: (x: number, z: number) => number): void {
  const [cx, , cz] = b.pos;
  centre = [cx, 0, cz];
  const fx = b.front[0];
  const fz = b.front[1];
  // local axes: right r (width, hw), back = −front (depth, hd)
  const rx = -fz;
  const rz = fx;
  const P = (u: number, w: number): [number, number] => [cx + rx * u - fx * w, cz + rz * u - fz * w];
  // ground: lowest terrain under the footprint corners, walls start 0.3 below it (no gaps on slopes)
  let gmin = Infinity;
  let gmax = -Infinity;
  for (const [u, w] of [
    [-b.hw, -b.hd],
    [b.hw, -b.hd],
    [b.hw, b.hd],
    [-b.hw, b.hd],
  ] as const) {
    const [x, z] = P(u, w);
    const h = groundAt(x, z);
    gmin = Math.min(gmin, h);
    gmax = Math.max(gmax, h);
  }
  const floorY = gmax + (b.style === 'house' || b.style === 'houseTwoStorey' || b.style === 'bungalow' ? 0.45 : 0.05);
  const y0 = gmin - 0.3;
  const top = floorY + b.height;
  const trimC = linear(b.trim);
  const roofC = linear(b.roofColor);
  const res = b.style === 'house' || b.style === 'houseTwoStorey' || b.style === 'bungalow' || b.style === 'cabin';
  const layer = wallLayerOf(b);
  // Brick carries its own colour in the texture: the wall colour only shifts it (brightness + a little hue), never multiplies red by red.
  const wallC: V3 = layer === WallLayer.brick ? brickTint(linear(b.wall)) : linear(b.wall);
  const bay = res ? 2.6 + rand(b.seed, 1) * 0.8 : b.style === 'shop' || b.style === 'shopRow' ? 3.4 : b.style === 'warehouse' || b.style === 'hangar' || b.style === 'barn' ? 6 : 3.2;
  const storey = b.floors > 0 ? (b.height - 0.3) / b.floors : b.height;
  const base: Facade = {
    bayW: bay,
    storeyH: storey,
    winW: res ? 1.0 + rand(b.seed, 2) * 0.35 : b.style === 'warehouse' || b.style === 'hangar' ? 1.6 : 1.4,
    winH: res ? 1.3 + rand(b.seed, 3) * 0.3 : b.style === 'warehouse' ? 0.9 : 1.6,
    layer,
    flags: 0,
    doorU: -1,
  };
  if (b.style === 'church') {
    base.winW = 1.1;
    base.winH = storey * 0.62;
    base.flags |= F_CHURCH;
  }
  // corners CCW seen from above starting front-left: front face spans u ∈ [−hw, hw] at w = −hd
  const corners: [number, number][] = [P(-b.hw, -b.hd), P(b.hw, -b.hd), P(b.hw, b.hd), P(-b.hw, b.hd)];
  const faceLen = [2 * b.hw, 2 * b.hd, 2 * b.hw, 2 * b.hd];
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const c = corners[(k + 1) % 4]!;
    const fac: Facade = { ...base };
    if (k === 0) {
      fac.flags |= F_FRONT;
      fac.doorU = b.hw + (res ? (rand(b.seed, 4) - 0.5) * b.hw : 0);
      if (b.style === 'shop' || b.style === 'shopRow' || b.style === 'diner' || b.style === 'gasStation') fac.flags |= F_SHOP;
      if (b.style === 'garage' || b.style === 'pitGarage' || b.style === 'warehouse' || b.style === 'hangar' || b.style === 'barn') fac.flags |= F_GARAGE;
    } else if ((b.style === 'shopRow' || b.style === 'shop') && k !== 2) {
      fac.flags |= F_BLANK; // party walls of a terraced row
    }
    // wall order: the quad from a to c goes clockwise around the footprint seen from above when
    // walking front-left → front-right; outward normal = (c − a) × up … flip via point order.
    wall(geo.walls, [c[0], floorY, c[1]], [a[0], floorY, a[1]], y0, top, fac, wallC, trimC, 0);
    setFac(geo.walls, fac, trimC);
    void faceLen;
  }
  // ---- roofs
  const ov = res || b.style === 'church' || b.style === 'barn' ? 0.45 : 0;
  geo.roofs.color = roofC;
  const roofLayer = b.roof === 'flat' ? RoofLayer.membrane : b.style === 'warehouse' || b.style === 'hangar' || b.style === 'barn' || b.roof === 'barrel' ? RoofLayer.seam : rand(b.seed, 5) < 0.15 ? RoofLayer.tile : RoofLayer.shingle;
  geo.roofs.extra = [roofLayer, 0, 0, 0];
  const Q = (u: number, w: number, y: number): V3 => {
    const [x, z] = P(u, w);
    return [x, y, z];
  };
  const hw = b.hw + ov;
  const hd = b.hd + ov;
  // the ridge runs along the longer side
  const alongW = b.hw >= b.hd;
  if (b.roof === 'gable' || b.roof === 'hip' || b.roof === 'shed') {
    const span = alongW ? b.hd : b.hw;
    const pitch = b.style === 'church' ? 1.0 : res ? 0.55 + rand(b.seed, 6) * 0.25 : 0.3;
    const rise = span * pitch;
    const eave = top - ov * pitch;
    const ridge = top + rise;
    if (b.roof === 'shed') {
      // single slope down to the back
      const tl = Q(-hw, -hd, ridge - rise * 0.4);
      const tr = Q(hw, -hd, ridge - rise * 0.4);
      const bl = Q(-hw, hd, eave);
      const br = Q(hw, hd, eave);
      geo.roofs.polyFacing([tl, bl, br, tr], UP);
      gableEnd(geo.walls, Q(-b.hw, -b.hd, top), Q(-b.hw, b.hd, top), Q(-b.hw, -b.hd, ridge - rise * 0.4), wallC, base);
      gableEnd(geo.walls, Q(b.hw, b.hd, top), Q(b.hw, -b.hd, top), Q(b.hw, -b.hd, ridge - rise * 0.4), wallC, base);
    } else if (alongW) {
      const hipIn = b.roof === 'hip' ? Math.min(span, b.hw * 0.8) : 0;
      const r0 = Q(-hw + hipIn, 0, ridge);
      const r1 = Q(hw - hipIn, 0, ridge);
      geo.roofs.polyFacing([Q(-hw, -hd, eave), Q(hw, -hd, eave), r1, r0], UP); // front slope (seen from the front)
      geo.roofs.polyFacing([Q(hw, hd, eave), Q(-hw, hd, eave), r0, r1], UP); // back slope
      if (b.roof === 'hip') {
        geo.roofs.polyFacing([Q(-hw, hd, eave), Q(-hw, -hd, eave), r0], UP);
        geo.roofs.polyFacing([Q(hw, -hd, eave), Q(hw, hd, eave), r1], UP);
      } else {
        gableEnd(geo.walls, Q(-b.hw, b.hd, top), Q(-b.hw, -b.hd, top), Q(-b.hw, 0, ridge - ov * pitch), wallC, base);
        gableEnd(geo.walls, Q(b.hw, -b.hd, top), Q(b.hw, b.hd, top), Q(b.hw, 0, ridge - ov * pitch), wallC, base);
        // verge boards (trim)
        geo.trim.color = trimC;
      }
    } else {
      const hipIn = b.roof === 'hip' ? Math.min(span, b.hd * 0.8) : 0;
      const r0 = Q(0, -hd + hipIn, ridge);
      const r1 = Q(0, hd - hipIn, ridge);
      geo.roofs.polyFacing([Q(hw, -hd, eave), Q(hw, hd, eave), r1, r0], UP);
      geo.roofs.polyFacing([Q(-hw, hd, eave), Q(-hw, -hd, eave), r0, r1], UP);
      if (b.roof === 'hip') {
        geo.roofs.polyFacing([Q(-hw, -hd, eave), Q(hw, -hd, eave), r0], UP);
        geo.roofs.polyFacing([Q(hw, hd, eave), Q(-hw, hd, eave), r1], UP);
      } else {
        gableEnd(geo.walls, Q(-b.hw, -b.hd, top), Q(b.hw, -b.hd, top), Q(0, -b.hd, ridge - ov * pitch), wallC, base);
        gableEnd(geo.walls, Q(b.hw, b.hd, top), Q(-b.hw, b.hd, top), Q(0, b.hd, ridge - ov * pitch), wallC, base);
      }
    }
    // soffit (underside of the overhang) as trim
    if (ov > 0) {
      geo.trim.color = scale(trimC, 0.8);
      geo.trim.polyFacing([Q(-hw, hd, eave), Q(hw, hd, eave), Q(hw, -hd, eave), Q(-hw, -hd, eave)], DOWN);
    }
    // chimney on houses
    if (res && rand(b.seed, 8) < 0.6) {
      const cu = (rand(b.seed, 9) - 0.5) * b.hw;
      const c = Q(cu, b.hd * 0.4, 0);
      geo.trim.color = linear(rand(b.seed, 10) < 0.6 ? 0x8c4f3c : 0x9aa0a6);
      geo.trim.box([c[0], (top + ridge) / 2 + 0.6, c[2]], yawQ(fx, fz), 0.42, (ridge - top) / 2 + 1.0, 0.42);
    }
  } else if (b.roof === 'barrel') {
    const span = alongW ? hd : hw;
    const rise = span * 0.32;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const t0 = -1 + (2 * k) / n;
      const t1 = -1 + (2 * (k + 1)) / n;
      const h0 = top + rise * (1 - t0 * t0);
      const h1 = top + rise * (1 - t1 * t1);
      if (alongW) geo.roofs.polyFacing([Q(-hw, t1 * span, h1), Q(hw, t1 * span, h1), Q(hw, t0 * span, h0), Q(-hw, t0 * span, h0)], UP);
      else geo.roofs.polyFacing([Q(t0 * span, -hd, h0), Q(t1 * span, -hd, h1), Q(t1 * span, hd, h1), Q(t0 * span, hd, h0)], UP);
    }
    // end walls under the barrel
    for (let k = 0; k < n; k++) {
      const t0 = -1 + (2 * k) / n;
      const t1 = -1 + (2 * (k + 1)) / n;
      const h0 = top + rise * (1 - t0 * t0);
      const h1 = top + rise * (1 - t1 * t1);
      if (alongW) {
        gableEnd(geo.walls, Q(-b.hw, t1 * b.hd, top), Q(-b.hw, t0 * b.hd, top), Q(-b.hw, t0 * b.hd, h0), wallC, base, Q(-b.hw, t1 * b.hd, h1));
        gableEnd(geo.walls, Q(b.hw, t0 * b.hd, top), Q(b.hw, t1 * b.hd, top), Q(b.hw, t1 * b.hd, h1), wallC, base, Q(b.hw, t0 * b.hd, h0));
      }
    }
  } else {
    // flat roof: membrane deck slightly below a parapet
    const py = top + 0.6;
    geo.roofs.polyFacing([Q(-b.hw, b.hd, top + 0.05), Q(b.hw, b.hd, top + 0.05), Q(b.hw, -b.hd, top + 0.05), Q(-b.hw, -b.hd, top + 0.05)], UP);
    geo.trim.color = scale(wallC, 0.9);
    const q = yawQ(fx, fz);
    const pc = (u: number, w: number, hx: number, hz: number): void => {
      const c = Q(u, w, (top + py) / 2);
      geo.trim.box(c, q, hx, (py - top) / 2, hz);
    };
    pc(0, -b.hd + 0.12, b.hw, 0.12);
    pc(0, b.hd - 0.12, b.hw, 0.12);
    pc(-b.hw + 0.12, 0, 0.12, b.hd);
    pc(b.hw - 0.12, 0, 0.12, b.hd);
    // rooftop AC units / vents
    const nAc = 1 + Math.floor(rand(b.seed, 11) * 3);
    geo.trim.color = linear(0xb8bcbf);
    for (let k = 0; k < nAc; k++) {
      const u = (rand(b.seed, 12 + k) - 0.5) * (b.hw * 1.2);
      const w = (rand(b.seed, 20 + k) - 0.5) * (b.hd * 1.2);
      const c = Q(u, w, top + 0.55);
      geo.trim.box(c, q, 0.7, 0.5, 0.55);
      geo.trim.color = linear(0x8c9196);
      geo.trim.box(add(c, [0, 0.52, 0]), q, 0.42, 0.04, 0.42);
      geo.trim.color = linear(0xb8bcbf);
    }
  }
  // house extras: porch slab + steps at the door, an AC box by the side wall
  if (res) {
    const q = yawQ(fx, fz);
    geo.trim.color = linear(0xb9b3a8);
    const du = (rand(b.seed, 4) - 0.5) * b.hw;
    const pc = Q(du, -b.hd - 1.0, (floorY + gmin) / 2);
    geo.trim.box(pc, q, 1.4, (floorY - gmin) / 2 + 0.05, 1.0);
    geo.trim.color = linear(0xa0a4a6);
    const ac = Q(b.hw + 0.5, b.hd * 0.3, gmin + 0.45);
    geo.trim.box(ac, q, 0.35, 0.45, 0.45);
  }
}

function yawQ(fx: number, fz: number): [number, number, number, number] {
  // rotation about +Y taking local −Z to (fx, fz)
  const ang = Math.atan2(-fx, -fz);
  return [0, Math.sin(ang / 2), 0, Math.cos(ang / 2)];
}

/** Gable / end triangle (or quad) above the wall top, wall material, no windows. */
let centre: V3 = [0, 0, 0];
const UP: V3 = [0, 1, 0];
const DOWN: V3 = [0, -1, 0];
function gableEnd(g: Geo, a: V3, b: V3, apex: V3, color: V3, fac: Facade, apex2?: V3): void {
  g.color = color;
  g.extra = [fac.layer, F_BLANK, -1, 0];
  const u0 = 0;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const pts = apex2 ? [a, b, apex, apex2] : [a, b, apex];
  // UVs: u along a→b, v = height above a (metres)
  const dir = norm([b[0] - a[0], 0, b[2] - a[2]]);
  const n = g.vertexCount;
  const out = norm([(a[0] + b[0]) / 2 - centre[0], 0, (a[2] + b[2]) / 2 - centre[2]]);
  g.polyFacing(pts, out, dir, [0, 1, 0], u0, -a[1]);
  for (let k = 0; k < pts.length; k++) facAttr.push(99, 99, 0, 0);
  for (let k = 0; k < pts.length; k++) trimAttr.push(color[0], color[1], color[2]);
  void n;
  void len;
}

/** Sign boards above shopfronts (text drawn into a canvas atlas by the caller). */
export function signBoard(b: BuildingInstance): { centre: V3; right: V3; up: V3; w: number; h: number } | null {
  if (!b.sign) return null;
  const fx = b.front[0];
  const fz = b.front[1];
  const rx = -fz;
  const rz = fx;
  const y = b.pos[1] + Math.min(b.height - 0.6, b.style === 'gasStation' || b.style === 'diner' ? b.height - 0.8 : 3.6);
  const w = Math.min(2 * b.hw - 1, Math.max(4, b.sign.length * 0.62));
  const centre: V3 = [b.pos[0] + fx * (b.hd + 0.08), y, b.pos[2] + fz * (b.hd + 0.08)];
  return { centre, right: [rx, 0, rz], up: [0, 1, 0], w, h: 0.9 };
}

// ------------------------------------------------------------------ facade material
const FACADE_VERT_PARS = /* glsl */ `
attribute vec4 aExtra;
attribute vec4 aFac;
attribute vec3 aTrim;
varying vec2 vFacUV;
varying vec4 vFac;
varying vec4 vFac2;
varying vec3 vTrim;
varying vec3 vWPos;
varying vec3 vWNrm;
`;
const FACADE_VERT_MAIN = /* glsl */ `
vFacUV = uv;
vFac = aFac;
vFac2 = aExtra;
vTrim = aTrim;
vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * normal);
`;
const FACADE_FRAG_PARS = /* glsl */ `
uniform sampler2DArray tWallA;
uniform sampler2DArray tWallN;
uniform float uWorldNight;
varying vec2 vFacUV;
varying vec4 vFac;
varying vec4 vFac2;
varying vec3 vTrim;
varying vec3 vWPos;
varying vec3 vWNrm;
float fHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Interior mapping: room box [0,w]×[0,h]×[0,D] behind the pane; p = (x, y) on the pane, ray dir r (tangent space, r.z > 0 into the room).
vec3 interiorRoom(vec2 p, vec2 room, float D, vec3 r, vec2 cell, out float lit) {
  vec3 o = vec3(p, 0.0);
  vec3 tMax = vec3(
    r.x > 0.0 ? (room.x - o.x) / r.x : -o.x / min(r.x, -1e-4),
    r.y > 0.0 ? (room.y - o.y) / r.y : -o.y / min(r.y, -1e-4),
    D / max(r.z, 1e-4));
  float t = min(min(tMax.x, tMax.y), tMax.z);
  vec3 hp = o + r * t;
  float h1 = fHash(cell);
  float h2 = fHash(cell + 17.3);
  vec3 wallTint = mix(vec3(0.62, 0.58, 0.5), vec3(0.45, 0.52, 0.58), h1);
  wallTint = mix(wallTint, vec3(0.7, 0.62, 0.48), step(0.7, h2));
  vec3 c;
  if (t == tMax.z) {
    c = wallTint * 0.9;
    // furniture band / shelving silhouette on the back wall
    float band = step(hp.y, 0.85 + h2 * 0.5) * step(0.15 + 0.5 * h1, hp.x / room.x) * step(hp.x / room.x, 0.55 + 0.4 * h2);
    c = mix(c, vec3(0.16, 0.12, 0.1), band * 0.8);
    // picture frame
    float pic = step(abs(hp.x / room.x - 0.3 - 0.4 * h1), 0.08) * step(abs(hp.y - room.y * 0.62), 0.25);
    c = mix(c, vec3(0.25, 0.3, 0.28), pic * 0.7);
  } else if (t == tMax.y) {
    c = r.y > 0.0 ? vec3(0.82, 0.8, 0.76) : mix(vec3(0.32, 0.22, 0.14), vec3(0.4, 0.38, 0.35), h2); // ceiling / floor
    if (r.y > 0.0) c += vec3(1.0, 0.9, 0.7) * 0.8 * smoothstep(0.35, 0.0, length(hp.xz - vec2(room.x * 0.5, D * 0.5)) / room.x);
  } else {
    c = wallTint * 0.75;
  }
  // depth darkening
  c *= 0.55 + 0.45 * smoothstep(D, 0.0, hp.z);
  lit = step(0.45, fHash(cell + 3.1));
  return c;
}
`;

export interface FacadeUniforms {
  uWorldNight: IUniform<number>;
}

/** Wall material: texture-array albedo × vertex tint, facade rule + interior mapping in the fragment. */
export function createFacadeMaterial(walls: { albedo: DataArrayTexture; normal: DataArrayTexture }, shared: FacadeUniforms): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ name: 'wc-facade', vertexColors: true, roughness: 0.85, metalness: 0 });
  m.normalScale = new Vector2(1, 1);
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.tWallA = { value: walls.albedo };
    shader.uniforms.tWallN = { value: walls.normal };
    shader.uniforms.uWorldNight = shared.uWorldNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_VERT_PARS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${FACADE_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_FRAG_PARS}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        // ---- facade rule
        float layer = vFac2.x;
        float flags = vFac2.y;
        bool isFront = mod(flags, 2.0) >= 1.0;
        bool isShop = mod(floor(flags / 2.0), 2.0) >= 1.0;
        bool isGarage = mod(floor(flags / 4.0), 2.0) >= 1.0;
        bool isBlank = mod(floor(flags / 8.0), 2.0) >= 1.0;
        bool isChurch = mod(floor(flags / 16.0), 2.0) >= 1.0;
        vec2 fu = vFacUV;
        // pixel footprint (m): sub-pixel facade detail (mullions, frames) drops out with distance instead of aliasing into speckle
        float fpx = max(fwidth(fu.x), fwidth(fu.y));
        vec3 wallTex = texture(tWallA, vec3(fu / ${WALL_TILE_M.toFixed(1)}, layer)).rgb;
        vec3 albedo = wallTex * vColor.rgb;
        float bayW = vFac.x;
        float storeyH = vFac.y;
        float winW = vFac.z;
        float winH = vFac.w;
        float storey = floor(fu.y / storeyH);
        float ly = fu.y - storey * storeyH;
        float bay = floor(fu.x / bayW);
        float lx = fu.x - bay * bayW;
        float sill = (storeyH - winH) * 0.55;
        float winMask = 0.0;
        float frameMask = 0.0;
        float doorMask = 0.0;
        vec2 pane = vec2(0.0);
        vec2 room = vec2(bayW, storeyH);
        if (!isBlank && fu.y > 0.0 && storeyH < 50.0) {
          float dx = abs(lx - bayW * 0.5);
          float wy0 = sill;
          float wy1 = sill + winH;
          float ww = winW;
          if (isShop && isFront && storey < 0.5) { ww = bayW - 0.5; wy0 = 0.55; wy1 = storeyH - 0.7; }
          if (isChurch) { wy1 = sill + winH; }
          winMask = step(dx, ww * 0.5) * step(wy0, ly) * step(ly, wy1);
          if (isChurch) winMask *= step(length(vec2(dx / (ww * 0.5), max(ly - (wy1 - ww * 0.5), 0.0) / (ww * 0.5))), 1.0);
          frameMask = step(dx, ww * 0.5 + 0.09) * step(wy0 - 0.12, ly) * step(ly, wy1 + 0.09) * (1.0 - winMask);
          pane = vec2(lx - (bayW * 0.5 - ww * 0.5), ly - wy0);
          room = vec2(ww, wy1 - wy0);
          // mullions
          if (fpx > 0.1) { winMask = max(winMask, frameMask); frameMask = 0.0; }
          if (winMask > 0.5 && !isShop && fpx < 0.03) {
            float mx = abs(pane.x - ww * 0.5);
            float my = abs(pane.y - (wy1 - wy0) * 0.62);
            if (mx < 0.03 || my < 0.025) { winMask = 0.0; frameMask = 1.0; }
          }
          // door on the front face's ground floor
          if (isFront && storey < 0.5 && vFac2.z > 0.0) {
            float dd = abs(fu.x - vFac2.z);
            float dw = isGarage ? 1.6 : 0.5;
            float dh = isGarage ? 2.9 : 2.15;
            if (dd < dw && fu.y < dh) { doorMask = 1.0; winMask = 0.0; frameMask = 0.0; }
            else if (dd < dw + 0.1 && fu.y < dh + 0.1) { frameMask = 1.0; winMask = 0.0; }
          }
          if (isGarage && isFront && storey < 0.5 && fu.y < 3.2 && doorMask < 0.5 && lx > 0.6 && lx < bayW - 0.6 && mod(bay, 2.0) < 1.0) {
            doorMask = 2.0; winMask = 0.0; frameMask = 0.0;
          }
        }
        vec4 diffuseColor_ = vec4(albedo, 1.0);
        float glass = 0.0;
        vec3 interior = vec3(0.0);
        float lit = 0.0;
        if (winMask > 0.5) {
          // tangent frame of the wall: T = horizontal along u, B = up, N = outward
          vec3 N0 = normalize(vWNrm);
          vec3 T0 = normalize(cross(vec3(0.0, 1.0, 0.0), N0));
          vec3 V = normalize(vWPos - cameraPosition);
          vec3 r = vec3(dot(V, T0), dot(V, vec3(0.0, 1.0, 0.0)), -dot(V, N0));
          interior = interiorRoom(pane, room, isShop ? 5.0 : 3.6, r, vec2(bay, storey) + vec2(vFac2.w, layer * 7.0), lit);
          // blinds / curtains on some windows
          float blind = step(0.62, fHash(vec2(bay, storey) + 9.7)) * step(room.y - pane.y, room.y * (0.3 + 0.5 * fHash(vec2(storey, bay))));
          interior = mix(interior, vec3(0.78, 0.74, 0.66), blind * 0.92);
          glass = 1.0;
          diffuseColor_.rgb = vec3(0.02);
        } else if (frameMask > 0.5) {
          diffuseColor_.rgb = vTrim;
        } else if (doorMask > 1.5) {
          // roll-up garage door: horizontal slats
          float slat = fract(fu.y / 0.18);
          diffuseColor_.rgb = mix(vec3(0.62), vec3(0.5), step(0.85, slat)) * mix(vec3(1.0), vTrim, 0.25);
        } else if (doorMask > 0.5) {
          diffuseColor_.rgb = vTrim * 0.7;
        }
        diffuseColor *= diffuseColor_;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, glass);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += interior * glass * (0.22 + uWorldNight * 1.6 * lit);`,
      );
  };
  m.customProgramCacheKey = () => 'wc-facade-v1';
  return m;
}

/** Roof material: texture-array albedo (layer in aExtra.x, metres UV projected on the slope) × vertex tint. */
export function createRoofMaterial(roofs: { albedo: DataArrayTexture; normal: DataArrayTexture }): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ name: 'wc-roof', vertexColors: true, roughness: 0.8, metalness: 0.05 });
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.tRoofA = { value: roofs.albedo };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aExtra;\nvarying vec2 vRoofUV;\nvarying float vRoofLayer;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvRoofUV = uv;\nvRoofLayer = aExtra.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2DArray tRoofA;\nvarying vec2 vRoofUV;\nvarying float vRoofLayer;')
      .replace(
        '#include <map_fragment>',
        `diffuseColor.rgb *= texture(tRoofA, vec3(vRoofUV / ${ROOF_TILE_M.toFixed(1)}, vRoofLayer)).rgb;\nfloat seamy = vRoofLayer > 0.5 && vRoofLayer < 1.5 ? 1.0 : 0.0;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, seamy);\n')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.6, seamy);\n');
  };
  m.customProgramCacheKey = () => 'wc-roof-v1';
  return m;
}

export function trimMaterial(): Material {
  return new MeshStandardMaterial({ name: 'wc-trim', vertexColors: true, roughness: 0.7, metalness: 0.05 });
}

void scale;
