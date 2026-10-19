/**
 * PANEL FINISH / WEATHERING (P6, F4; contract: ./types.ts `PanelFinish`,
 * docs/CONTRACTS.md "P6 contracts").
 *
 * Per-panel paint finish of a vehicle: its own colour (mismatched doors, the
 * box truck's white box), single-stage `solid` paint, UV fade, primer
 * patches, rust (with rust-through holes), road grime, clear-coat peel,
 * cracked lenses and a hand-painted number. Everything is evaluated in the
 * FRAGMENT stage from REST-space procedural masks (vFlexRest), so it rides
 * with the panel and never swims when the body deforms; the damage patch
 * (scuffs, crumple shading) composes ON TOP (it runs after this hook).
 *
 * DATA: one RGBA32F DataTexture per material set, FINISH_TEX_WIDTH texels
 * per panel, row = LOD0 panel index (= flexskin's vFlexPanel; LOD ≥ 1 and
 * merged draws carry the same index, so every level shares it). Masks are
 * stored as THRESHOLDS, calibrated on the CPU against the noise field's
 * distribution (quantile tables below), so `primer: 0.3` covers ≈ 30 % of a
 * panel. A row of zeros/"never" thresholds is a pristine panel.
 *   t0  colour (linear rgb), has-colour 0|1
 *   t1  solid 0|1, fade, primer threshold, rust threshold
 *   t2  dirt, peel threshold, hole threshold, crack
 *   t3  panel rest yMin, yMax, noise seed, finished 0|1 (0 = skip everything)
 *   t4  number centre xyz, digit height (m) (0 = no number)
 *   t5  number colour (linear rgb), axis (1 = x: side panels, 2 = y: roof / hood)
 *   t6  digit segment masks (7-segment bits, up to 3 digits), digit count
 *   t7  panel rest centre xyz, crack radius
 *   t8  number background colour (linear rgb), background 0|1 (painted roundel)
 *
 * WHEN: only a vehicle def with ≥ 1 finished panel gets the hook, and only
 * on the slots that carry a finished panel (materials.ts). Every other
 * vehicle compiles exactly the programs it had before (same GLSL, same
 * cache keys): existing vehicles look identical.
 *
 * The CPU mirror (finishNoise / finishFbm / finishMasks) evaluates the same
 * fields in f64. It is used for the threshold calibration and by tests; the
 * GPU's f32 hash differs bit-wise, which leaves the statistics unchanged.
 */
import { Color, DataTexture, FloatType, NearestFilter, RGBAFormat, Vector4, type WebGLProgramParametersWithUniforms } from 'three';

import type { PanelDef, PanelFinish, VehicleVisualDef, Vec3T, MaterialSlot } from './types';

/** Texels per panel row. */
export const FINISH_TEX_WIDTH = 9;
/** A mask threshold no field value reaches (amount 0). */
export const FINISH_NEVER = 4;
/** A mask threshold every field value passes (amount 1). */
export const FINISH_ALWAYS = -4;

// ====================================================================== extras registry
/**
 * Render-side extras of a def that weathering needs but VehicleVisualDef
 * does not carry (registry like lods.ts setVisualExtras, so the frozen def
 * stays unchanged): wheel-arch lips in REST space, where rust and grime
 * grow. `z`, `y` = wheel centre, `r` = arch radius, `xMin` = |x| beyond
 * which a surface counts as the outer body side (the arch lip). Mirrored
 * to both sides.
 */
export interface FinishArch {
  z: number;
  y: number;
  r: number;
  xMin: number;
}
export interface FinishExtras {
  arches?: readonly FinishArch[];
}
const EXTRAS = new WeakMap<VehicleVisualDef, FinishExtras>();
/** Max arches the shader reads. */
export const FINISH_MAX_ARCHES = 2;

export function setFinishExtras(def: VehicleVisualDef, extras: FinishExtras): void {
  EXTRAS.set(def, extras);
}
export function finishExtras(def: VehicleVisualDef): FinishExtras {
  return EXTRAS.get(def) ?? {};
}

// ====================================================================== CPU mirror (noise)
const fract = (x: number): number => x - Math.floor(x);

/** = crWxHash (GLSL), f64. */
export function finishHash(x: number, y: number, z: number): number {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(z * 0.1031);
  const d = px * (pz + 31.32) + py * (py + 31.32) + pz * (px + 31.32);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

/** = crWxNoise: smooth trilinear value noise in [0, 1]. */
export function finishNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number): number => finishHash(ix + a, iy + b, iz + c);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(0, 0, 0), h(1, 0, 0), ux), lerp(h(0, 1, 0), h(1, 1, 0), ux), uy),
    lerp(lerp(h(0, 0, 1), h(1, 0, 1), ux), lerp(h(0, 1, 1), h(1, 1, 1), ux), uy),
    uz,
  );
}

/** = crWxFbm: three octaves, weights 0.5 / 0.3 / 0.2, in [0, 1]. */
export function finishFbm(x: number, y: number, z: number): number {
  return (
    0.5 * finishNoise(x, y, z) +
    0.3 * finishNoise(2.03 * x + 17.1, 2.03 * y + 17.1, 2.03 * z + 17.1) +
    0.2 * finishNoise(4.01 * x + 31.7, 4.01 * y + 31.7, 4.01 * z + 31.7)
  );
}

/** Field frequencies (per metre of rest space), shared by GLSL and the mirror. */
export const FINISH_FREQ = { primer: 2.2, primerEdge: 14, rust: 5.0, rustFine: 23, peel: 3.3, dirt: 3, fade: 1.3 } as const;

/** Primer field (blotchy patches with a ragged sanded edge), ~[0, 1]. */
export function primerField(x: number, y: number, z: number): number {
  const f = FINISH_FREQ;
  return 0.85 * finishFbm(f.primer * x, f.primer * y, f.primer * z) + 0.15 * finishNoise(f.primerEdge * x + 5.3, f.primerEdge * y + 5.3, f.primerEdge * z + 5.3);
}
/** Peel field (clear-coat flaking), ~[0, 1]. */
export function peelField(x: number, y: number, z: number): number {
  const f = FINISH_FREQ.peel;
  return 0.8 * finishFbm(f * x + 5.0, f * y + 5.0, f * z + 5.0) + 0.2 * finishNoise(21 * x + 2.2, 21 * y + 2.2, 21 * z + 2.2);
}
/** Rust field = noise + proximity to the lower edge / arch lips (prox ∈ [0, 1]). */
export function rustField(x: number, y: number, z: number, prox: number): number {
  const f = FINISH_FREQ;
  return 0.42 * finishFbm(f.rust * x, f.rust * y, f.rust * z) + 0.13 * finishNoise(f.rustFine * x + 9.1, f.rustFine * y + 9.1, f.rustFine * z + 9.1) + 0.45 * prox;
}

// ====================================================================== threshold calibration
/** Quantile table of a field over a deterministic sample of rest space. */
function quantileTable(field: (x: number, y: number, z: number, u: number) => number): Float64Array {
  const N = 6000;
  const v = new Float64Array(N);
  // golden-ratio lattice over a 4 m × 1.5 m × 2 m box (a car's rest space), plus a uniform 4th coordinate
  for (let i = 0; i < N; i++) {
    const a = fract(i * 0.6180339887498949);
    const b = fract(i * 0.7548776662466927);
    const c = fract(i * 0.5698402909980532);
    const d = fract(i * 0.4196238365224585 + 0.5 / N);
    v[i] = field(4 * a - 2, 1.5 * b, 2 * c - 1, d);
  }
  return v.sort();
}
let TABLES: { primer: Float64Array; peel: Float64Array; rust: Float64Array } | null = null;
function tables(): NonNullable<typeof TABLES> {
  TABLES ??= {
    primer: quantileTable((x, y, z) => primerField(x, y, z)),
    peel: quantileTable((x, y, z) => peelField(x, y, z)),
    // proximity over a panel ≈ uniform (a panel spans its lower edge to its top)
    rust: quantileTable((x, y, z, u) => rustField(x, y, z, u)),
  };
  return TABLES;
}

/** Field value above which `coverage` of the samples lie (coverage ≤ 0 → NEVER, ≥ 1 → ALWAYS). */
export function finishThreshold(kind: 'primer' | 'peel' | 'rust', coverage: number): number {
  if (!(coverage > 0)) return FINISH_NEVER;
  if (coverage >= 1) return FINISH_ALWAYS;
  const t = tables()[kind];
  const i = Math.min(t.length - 1, Math.max(0, Math.floor((1 - coverage) * t.length)));
  return t[i]!;
}

// ====================================================================== masks (CPU mirror of the GLSL)
export interface FinishMasks {
  primer: number;
  rust: number;
  hole: number;
  peel: number;
  dirt: number;
  fade: number;
}

/** Panel-level inputs of the masks (what the finish texture row holds). */
export interface FinishRow {
  solid: number;
  fade: number;
  tPrimer: number;
  tRust: number;
  dirt: number;
  tPeel: number;
  tHole: number;
  crack: number;
  yMin: number;
  yMax: number;
  seed: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Proximity of a rest point to the panel's lower edge and the arch lips, [0, 1] (= crWxProx). */
export function finishProximity(x: number, y: number, z: number, yMin: number, arches: readonly FinishArch[]): number {
  let p = 1 - smoothstep(0, 0.3, y - yMin);
  for (const a of arches.slice(0, FINISH_MAX_ARCHES)) {
    if (!(a.r > 0)) continue;
    const d = Math.hypot(z - a.z, y - a.y) - a.r;
    const lip = (1 - smoothstep(0, 0.11, Math.abs(d))) * (Math.abs(x) >= a.xMin ? 1 : 0) * smoothstep(a.y - 0.2, a.y, y);
    p = Math.max(p, lip);
  }
  return p;
}

/** Masks at rest point (x, y, z) of a panel row (f64 mirror of the GLSL masks; edges hard at the threshold). */
export function finishMasks(row: FinishRow, x: number, y: number, z: number, arches: readonly FinishArch[] = []): FinishMasks {
  const s = row.seed;
  const qx = x + 1.7 * s;
  const qy = y + 3.1 * s;
  const qz = z + 2.3 * s;
  const prox = finishProximity(x, y, z, row.yMin, arches);
  const rf = rustField(qx, qy, qz, prox);
  const step = (t: number, v: number): number => (v >= t ? 1 : 0);
  const dirtBase = 1 - smoothstep(0.12, 0.8, y);
  return {
    primer: step(row.tPrimer, primerField(qx, qy, qz)),
    rust: step(row.tRust, rf),
    hole: step(row.tHole, rf),
    peel: step(row.tPeel, peelField(qx, qy, qz)),
    dirt: Math.min(1, row.dirt * (dirtBase * (0.55 + 0.45 * finishFbm(FINISH_FREQ.dirt * qx, 9 * qy, FINISH_FREQ.dirt * qz)) + 0.6 * prox * dirtBase)),
    fade: row.fade * (0.55 + 0.45 * smoothstep(0.75, 1.35, y)) * (0.75 + 0.5 * finishFbm(FINISH_FREQ.fade * qx, FINISH_FREQ.fade * qy, FINISH_FREQ.fade * qz)),
  };
}

// ====================================================================== number decal
/** 7-segment masks (bit 0 a top, 1 b top-right, 2 c bottom-right, 3 d bottom, 4 e bottom-left, 5 f top-left, 6 g middle). */
export const SEVEN_SEGMENT: Readonly<Record<string, number>> = {
  '0': 0b0111111,
  '1': 0b0000110,
  '2': 0b1011011,
  '3': 0b1001111,
  '4': 0b1100110,
  '5': 0b1101101,
  '6': 0b1111101,
  '7': 0b0000111,
  '8': 0b1111111,
  '9': 0b1101111,
};
export const FINISH_MAX_DIGITS = 3;

// ====================================================================== data texture
function linear(hex: number): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
}

/** Rest-space y range and centre of a panel's surface control points. */
export function panelRestExtent(p: PanelDef): { yMin: number; yMax: number; center: Vec3T; radius: number } {
  let yMin = Infinity;
  let yMax = -Infinity;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  const pts: number[] = [];
  const add = (x: number, y: number, z: number): void => {
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
    sx += x;
    sy += y;
    sz += z;
    n++;
    pts.push(x, y, z);
  };
  const s = p.surface;
  if (s.type === 'mesh') for (let i = 0; i + 2 < s.position.length; i += 3) add(s.position[i]!, s.position[i + 1]!, s.position[i + 2]!);
  else {
    const w = s.window ?? { u0: 0, u1: 1, v0: 0, v1: 1 };
    const nv = s.sections.length;
    s.sections.forEach((sec, j) => {
      const v = nv > 1 ? j / (nv - 1) : 0;
      if (v < w.v0 - 0.08 || v > w.v1 + 0.08) return;
      sec.forEach((pt, i) => {
        const u = sec.length > 1 ? i / (sec.length - 1) : 0;
        if (u < w.u0 - 0.08 || u > w.u1 + 0.08) return;
        add(pt[0], pt[1], pt[2]);
      });
    });
  }
  if (n === 0) return { yMin: 0, yMax: 0, center: [0, 0, 0], radius: 0 };
  const c: Vec3T = [sx / n, sy / n, sz / n];
  let r = 0;
  for (let i = 0; i < pts.length; i += 3) r = Math.max(r, Math.hypot(pts[i]! - c[0], pts[i + 1]! - c[1], pts[i + 2]! - c[2]));
  return { yMin, yMax, center: c, radius: r };
}

/** FNV-1a of a panel id → a noise seed in [0, 97). */
function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 9700) / 100;
}

export function hasFinish(f: PanelFinish | undefined): boolean {
  if (!f) return false;
  return (
    f.color !== undefined ||
    !!f.solid ||
    (f.fade ?? 0) > 0 ||
    (f.primer ?? 0) > 0 ||
    (f.rust ?? 0) > 0 ||
    (f.dirt ?? 0) > 0 ||
    (f.peel ?? 0) > 0 ||
    (f.crack ?? 0) > 0 ||
    !!f.number
  );
}

/** The texture row of one panel (CPU mirror input + texture source). */
export function finishRow(p: PanelDef): FinishRow {
  const f = p.finish ?? {};
  const e = panelRestExtent(p);
  const rust = Math.min(1, Math.max(0, f.rust ?? 0));
  return {
    solid: f.solid ? 1 : 0,
    fade: Math.min(1, Math.max(0, f.fade ?? 0)),
    tPrimer: finishThreshold('primer', f.primer ?? 0),
    tRust: finishThreshold('rust', rust),
    dirt: Math.min(1, Math.max(0, f.dirt ?? 0)),
    tPeel: finishThreshold('peel', f.peel ?? 0),
    tHole: finishThreshold('rust', rust * Math.min(1, Math.max(0, f.holes ?? 0)) * 0.3),
    crack: Math.min(1, Math.max(0, f.crack ?? 0)),
    yMin: e.yMin,
    yMax: e.yMax,
    seed: seedOf(p.id),
  };
}

export interface FinishData {
  /** FINISH_TEX_WIDTH × 4 floats per panel. */
  data: Float32Array;
  rows: number;
  /** Slots that carry at least one finished panel (they get the weathering hook). */
  slots: ReadonlySet<MaterialSlot>;
  /** Panels with a finish. */
  finished: number;
}

export function buildFinishData(def: VehicleVisualDef): FinishData {
  const P = def.panels.length;
  const rows = Math.max(1, P);
  const W = FINISH_TEX_WIDTH;
  const data = new Float32Array(rows * W * 4);
  const slots = new Set<MaterialSlot>();
  let finished = 0;
  def.panels.forEach((p, i) => {
    const o = i * W * 4;
    const set = (t: number, a: number, b: number, c: number, d: number): void => {
      data[o + 4 * t] = a;
      data[o + 4 * t + 1] = b;
      data[o + 4 * t + 2] = c;
      data[o + 4 * t + 3] = d;
    };
    // pristine defaults: thresholds "never"
    set(1, 0, 0, FINISH_NEVER, FINISH_NEVER);
    set(2, 0, FINISH_NEVER, FINISH_NEVER, 0);
    const f = p.finish;
    if (!hasFinish(f)) return;
    finished++;
    slots.add(p.material);
    const r = finishRow(p);
    if (f!.color !== undefined) set(0, ...linear(f!.color), 1);
    set(1, r.solid, r.fade, r.tPrimer, r.tRust);
    set(2, r.dirt, r.tPeel, r.tHole, r.crack);
    set(3, r.yMin, r.yMax, r.seed, 1);
    const e = panelRestExtent(p);
    set(7, e.center[0], e.center[1], e.center[2], Math.max(0.03, e.radius));
    const n = f!.number;
    if (n) {
      const digits = [...n.text].filter((ch) => ch in SEVEN_SEGMENT).slice(0, FINISH_MAX_DIGITS);
      set(4, n.center[0], n.center[1], n.center[2], digits.length ? n.height : 0);
      set(5, ...linear(n.color), n.axis === 'y' ? 2 : 1);
      set(6, SEVEN_SEGMENT[digits[0] ?? ''] ?? 0, SEVEN_SEGMENT[digits[1] ?? ''] ?? 0, SEVEN_SEGMENT[digits[2] ?? ''] ?? 0, digits.length);
      if (n.background !== undefined) set(8, ...linear(n.background), 1);
    }
  });
  return { data, rows, slots, finished };
}

export function createFinishTexture(fd: FinishData): DataTexture {
  const t = new DataTexture(fd.data, FINISH_TEX_WIDTH, fd.rows, RGBAFormat, FloatType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.name = 'vehicleFinish';
  t.needsUpdate = true;
  return t;
}

// ====================================================================== GLSL
/** After <common>: uniforms + noise + helpers. */
export const WEATHER_PARS = /* glsl */ `
uniform highp sampler2D uCrWxFinish;
uniform vec4 uCrWxArch[ ${FINISH_MAX_ARCHES} ];
float crWxHash( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
float crWxNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( crWxHash( i ), crWxHash( i + vec3( 1.0, 0.0, 0.0 ) ), u.x ),
			mix( crWxHash( i + vec3( 0.0, 1.0, 0.0 ) ), crWxHash( i + vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
		mix( mix( crWxHash( i + vec3( 0.0, 0.0, 1.0 ) ), crWxHash( i + vec3( 1.0, 0.0, 1.0 ) ), u.x ),
			mix( crWxHash( i + vec3( 0.0, 1.0, 1.0 ) ), crWxHash( i + vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y ), u.z );
}
float crWxFbm( vec3 p ) {
	return 0.5 * crWxNoise( p ) + 0.3 * crWxNoise( 2.03 * p + 17.1 ) + 0.2 * crWxNoise( 4.01 * p + 31.7 );
}
vec4 crWxTexel( int k, int row ) {
	return texelFetch( uCrWxFinish, ivec2( k, row ), 0 );
}
float crWxProx( vec3 p, float yMin ) {
	float pr = 1.0 - smoothstep( 0.0, 0.3, p.y - yMin );
	for ( int i = 0; i < ${FINISH_MAX_ARCHES}; i++ ) {
		vec4 a = uCrWxArch[ i ];
		if ( a.z <= 0.0 ) continue;
		float d = length( vec2( p.z - a.x, p.y - a.y ) ) - a.z;
		float lip = ( 1.0 - smoothstep( 0.0, 0.11, abs( d ) ) ) * step( a.w, abs( p.x ) ) * smoothstep( a.y - 0.2, a.y, p.y );
		pr = max( pr, lip );
	}
	return pr;
}
float crWxSeg( vec2 p, vec2 a, vec2 b ) {
	vec2 pa = p - a;
	vec2 ba = b - a;
	float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
	return length( pa - ba * h );
}
// distance (digit-height units) to the lit segments of a 7-segment digit in the cell [0, 0.55] × [0, 1]
float crWxDigit( vec2 p, float mask ) {
	int m = int( mask + 0.5 );
	float d = 1e3;
	vec2 A = vec2( 0.0, 1.0 ), B = vec2( 0.55, 1.0 ), C = vec2( 0.0, 0.5 ), D = vec2( 0.55, 0.5 ), E = vec2( 0.0, 0.0 ), F = vec2( 0.55, 0.0 );
	if ( ( m & 1 ) != 0 ) d = min( d, crWxSeg( p, A, B ) );
	if ( ( m & 2 ) != 0 ) d = min( d, crWxSeg( p, B, D ) );
	if ( ( m & 4 ) != 0 ) d = min( d, crWxSeg( p, D, F ) );
	if ( ( m & 8 ) != 0 ) d = min( d, crWxSeg( p, E, F ) );
	if ( ( m & 16 ) != 0 ) d = min( d, crWxSeg( p, C, E ) );
	if ( ( m & 32 ) != 0 ) d = min( d, crWxSeg( p, A, C ) );
	if ( ( m & 64 ) != 0 ) d = min( d, crWxSeg( p, C, D ) );
	return d;
}
// Surface-gradient bump (Mikkelsen), h in metres.
vec3 crWxBump( vec3 surfPos, vec3 n, float h, float faceDir ) {
	vec3 sx = dFdx( surfPos );
	vec3 sy = dFdy( surfPos );
	vec3 r1 = cross( sy, n );
	vec3 r2 = cross( n, sx );
	float det = dot( sx, r1 ) * faceDir;
	vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
	vec3 nn = abs( det ) * n - grad;
	float l = length( nn );
	return l > 1e-12 ? nn / l : n;
}
float crWxLum( vec3 c ) {
	return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}
`;

/**
 * Before <normal_fragment_begin>: the surface (colour, roughness,
 * metalness) and this fragment's bump height / clear-coat factor / flake
 * gate. All work is unconditional (no derivative inside divergent flow);
 * a pristine row evaluates to "no change".
 */
export const WEATHER_SURFACE = /* glsl */ `
float crWxH = 0.0;
float crWxCoat = 1.0;
float crWxCoatRough = 0.0;
float crWxFlake = 1.0;
float crWxPearl = 1.0;
float crWxSolid = 0.0;
#ifdef FLEXBODY
{
	int row = int( vFlexPanel + 0.5 );
	vec4 t0 = crWxTexel( 0, row );
	vec4 t1 = crWxTexel( 1, row );
	vec4 t2 = crWxTexel( 2, row );
	vec4 t3 = crWxTexel( 3, row );
	vec3 p = vFlexRest;
	vec3 q = p + t3.z * vec3( 1.7, 3.1, 2.3 );
	float px = length( fwidth( p ) );
	if ( t3.w > 0.5 ) {
	// ---- base colour, single-stage, fade
	diffuseColor.rgb = mix( diffuseColor.rgb, t0.rgb, t0.a );
	crWxSolid = t1.x;
	metalnessFactor = mix( metalnessFactor, 0.0, crWxSolid );
	crWxFlake = 1.0 - crWxSolid;
	float fade = t1.y * ( 0.55 + 0.45 * smoothstep( 0.75, 1.35, p.y ) ) * ( 0.75 + 0.5 * crWxFbm( ${FINISH_FREQ.fade.toFixed(2)} * q ) );
	float lum = crWxLum( diffuseColor.rgb );
	vec3 chalk = mix( vec3( lum ), diffuseColor.rgb, 0.45 ) * 1.25 + 0.035;
	diffuseColor.rgb = mix( diffuseColor.rgb, chalk, clamp( fade, 0.0, 1.0 ) * 0.8 );
	roughnessFactor = mix( roughnessFactor, max( roughnessFactor, 0.72 ), clamp( fade, 0.0, 1.0 ) );
	crWxCoat *= 1.0 - clamp( fade * 1.2, 0.0, 1.0 );
	crWxPearl = 1.0 - max( max( t0.a, crWxSolid ), clamp( fade * 2.0, 0.0, 1.0 ) );
	// ---- clear-coat peel: matte chalky patches, lifted white flaky rims
	float pf = 0.8 * crWxFbm( ${FINISH_FREQ.peel.toFixed(2)} * q + 5.0 ) + 0.2 * crWxNoise( 21.0 * q + 2.2 );
	float peel = smoothstep( t2.y - 0.008, t2.y + 0.008, pf );
	float peelRim = smoothstep( t2.y - 0.035, t2.y - 0.004, pf ) * ( 1.0 - peel );
	lum = crWxLum( diffuseColor.rgb );
	diffuseColor.rgb = mix( diffuseColor.rgb, mix( vec3( lum ), diffuseColor.rgb, 0.6 ) * 1.12 + 0.02, peel );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.6 + vec3( 0.32 ), peelRim * 0.7 );
	roughnessFactor = mix( roughnessFactor, 0.82, peel );
	roughnessFactor = mix( roughnessFactor, 0.45, peelRim );
	crWxCoat *= 1.0 - max( peel, peelRim * 0.5 );
	crWxH += 0.00025 * peelRim;
	// ---- primer: matte grey patches, sanded feather ring
	float prf = 0.85 * crWxFbm( ${FINISH_FREQ.primer.toFixed(2)} * q ) + 0.15 * crWxNoise( ${FINISH_FREQ.primerEdge.toFixed(1)} * q + 5.3 );
	float primer = smoothstep( t1.z - 0.006, t1.z + 0.006, prf );
	float feather = smoothstep( t1.z - 0.06, t1.z - 0.006, prf ) * ( 1.0 - primer ) * step( t1.z, 1.5 );
	float pn = crWxNoise( 37.0 * q );
	vec3 primerCol = vec3( 0.2, 0.205, 0.21 ) * ( 0.88 + 0.24 * pn ) * ( 0.94 + 0.12 * crWxFbm( 3.0 * q + 4.0 ) );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.82 + 0.03, feather * 0.6 );
	roughnessFactor = mix( roughnessFactor, 0.8, feather * 0.6 );
	diffuseColor.rgb = mix( diffuseColor.rgb, primerCol, primer );
	roughnessFactor = mix( roughnessFactor, 0.86 + 0.08 * pn, primer );
	metalnessFactor = mix( metalnessFactor, 0.0, max( primer, feather ) );
	crWxCoat *= 1.0 - max( primer, feather * 0.8 );
	crWxFlake *= 1.0 - primer;
	crWxPearl *= 1.0 - primer;
	crWxH += 0.00018 * primer;
	// ---- painted number (house paint over whatever was there)
	vec4 n0 = crWxTexel( 4, row );
	if ( n0.w > 0.0 ) {
		vec4 n1 = crWxTexel( 5, row );
		vec4 n2 = crWxTexel( 6, row );
		vec4 n3 = crWxTexel( 8, row );
		float h = max( n0.w, 1e-3 );
		vec2 uv = n1.w > 1.5 ? vec2( p.x - n0.x, -( p.z - n0.z ) ) : vec2( -sign( p.x ) * ( p.z - n0.z ), p.y - n0.y );
		uv /= h;
		float cnt = n2.w;
		float wide = cnt * 0.55 + max( cnt - 1.0, 0.0 ) * 0.32;
		vec2 c = vec2( uv.x + 0.5 * wide, uv.y + 0.5 );
		c.x -= 0.1 * ( c.y - 0.5 ); // brush-hand slant
		float wob = 0.035 * ( crWxNoise( 18.0 * q ) - 0.5 ) + 0.012 * ( crWxNoise( 70.0 * q ) - 0.5 );
		float d = 1e3;
		for ( int i = 0; i < ${FINISH_MAX_DIGITS}; i++ ) {
			if ( float( i ) >= cnt ) break;
			float m = i == 0 ? n2.x : i == 1 ? n2.y : n2.z;
			d = min( d, crWxDigit( c - vec2( float( i ) * 0.87, 0.0 ), m ) );
		}
		float aa = max( px / h, 1e-4 ) * 1.5;
		float side = n1.w > 1.5 ? 1.0 : step( 0.3, abs( p.x ) );
		float on = step( 1e-3, n0.w ) * side;
		float ink = ( 1.0 - smoothstep( 0.1 - aa, 0.1 + aa, d + wob ) ) * on;
		float bgR = 0.5 * max( 1.0, wide ) + 0.28;
		float bg = ( 1.0 - smoothstep( bgR - aa, bgR + aa, length( uv ) + wob * 0.6 ) ) * n3.a * on;
		vec3 bgCol = n3.rgb * ( 0.9 + 0.1 * crWxNoise( 9.0 * q ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, bgCol, bg );
		diffuseColor.rgb = mix( diffuseColor.rgb, n1.rgb * ( 0.92 + 0.08 * crWxNoise( 11.0 * q ) ), ink );
		roughnessFactor = mix( roughnessFactor, 0.55, max( ink, bg ) );
		metalnessFactor = mix( metalnessFactor, 0.0, max( ink, bg ) );
		crWxFlake *= 1.0 - max( ink, bg );
		crWxCoat *= 1.0 - 0.7 * max( ink, bg );
		crWxH += 0.00012 * max( ink, bg );
	}
	// ---- rust: from the panel's lower edge and the arch lips; bubbling rim; eaten-through holes
	float prox = crWxProx( p, t3.x );
	float rf = 0.42 * crWxFbm( ${FINISH_FREQ.rust.toFixed(2)} * q ) + 0.13 * crWxNoise( ${FINISH_FREQ.rustFine.toFixed(1)} * q + 9.1 ) + 0.45 * prox;
	float rust = smoothstep( t1.w - 0.01, t1.w + 0.01, rf );
	float bubble = smoothstep( t1.w - 0.05, t1.w - 0.005, rf ) * ( 1.0 - rust ) * step( t1.w, 1.5 );
	float hole = smoothstep( t2.z - 0.006, t2.z + 0.006, rf );
	float holeRim = smoothstep( t2.z - 0.035, t2.z - 0.004, rf ) * ( 1.0 - hole ) * step( t2.z, 1.5 );
	float rn = crWxNoise( 61.0 * q );
	float rn2 = crWxFbm( 9.0 * q + 3.3 );
	vec3 rustCol = mix( vec3( 0.075, 0.03, 0.012 ), vec3( 0.32, 0.105, 0.03 ), rn2 );
	rustCol = mix( rustCol, vec3( 0.45, 0.17, 0.05 ), smoothstep( 0.62, 0.8, rn ) * 0.7 );
	rustCol = mix( rustCol, vec3( 0.035, 0.018, 0.01 ), max( holeRim, smoothstep( t1.w + 0.08, t1.w + 0.2, rf ) * 0.5 ) );
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.72, 0.6, 0.5 ), bubble * 0.7 );
	diffuseColor.rgb = mix( diffuseColor.rgb, rustCol, rust );
	roughnessFactor = mix( roughnessFactor, 0.9 + 0.08 * rn, rust );
	roughnessFactor = mix( roughnessFactor, 0.6, bubble * 0.5 );
	metalnessFactor = mix( metalnessFactor, 0.0, max( rust, bubble ) );
	crWxCoat *= 1.0 - max( rust, bubble * 0.7 );
	crWxFlake *= 1.0 - rust;
	crWxPearl *= 1.0 - rust;
	crWxH += rust * ( 0.0006 * rn + 0.0009 * rn2 ) + bubble * 0.0007 * crWxNoise( 45.0 * q ) - holeRim * 0.001;
	// a hole is a void: the panel is gone, the cavity behind it is dark
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.006, 0.005, 0.004 ), hole );
	roughnessFactor = mix( roughnessFactor, 1.0, hole );
	crWxH -= 0.0015 * hole;
	// ---- grime toward the bottom and around the arches
	float dirtBase = 1.0 - smoothstep( 0.12, 0.8, p.y );
	float dirt = clamp( t2.x * ( dirtBase * ( 0.55 + 0.45 * crWxFbm( vec3( ${FINISH_FREQ.dirt.toFixed(1)}, 9.0, ${FINISH_FREQ.dirt.toFixed(1)} ) * q ) ) + 0.6 * prox * dirtBase ), 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.058, 0.044 ) * ( 0.8 + 0.4 * rn2 ), dirt * 0.85 * ( 1.0 - hole ) );
	roughnessFactor = mix( roughnessFactor, 0.92, dirt );
	crWxCoat *= 1.0 - dirt;
	// ---- cracked lens: radial + ring cracks around the panel centre, a chipped-out core
	if ( t2.w > 0.001 ) {
		vec4 t7 = crWxTexel( 7, row );
		vec2 dv = ( p - t7.xyz ).xy;
		float r = length( dv ) / max( t7.w, 0.03 );
		float ang = atan( dv.y, dv.x + 1e-6 );
		float sect = ang * 1.4323945 + 0.6 * crWxNoise( vec3( r * 6.0, t3.z, 0.0 ) );
		float radial = abs( fract( sect ) - 0.5 ) * 2.0 * length( dv );
		float ring = abs( fract( r * 2.6 + 0.3 * crWxNoise( vec3( ang * 2.0, t3.z, 1.0 ) ) ) - 0.5 ) * max( t7.w, 0.03 ) / 2.6;
		float w = 0.0012 + px;
		float crackLine = ( 1.0 - smoothstep( w * 0.5, w, min( radial, ring ) ) ) * ( 1.0 - smoothstep( 0.55, 0.95, r ) );
		float chip = 1.0 - smoothstep( 0.12, 0.16, r + 0.05 * crWxNoise( 30.0 * q ) );
		float cr = t2.w;
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.55, 0.56, 0.56 ), crackLine * 0.8 );
		roughnessFactor = mix( roughnessFactor, 0.5, crackLine );
		float gone = chip * step( 0.6, cr );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.02 ), gone );
		roughnessFactor = mix( roughnessFactor, 0.9, gone );
		metalnessFactor = mix( metalnessFactor, 0.0, gone );
		crWxH += 0.0003 * crackLine - 0.002 * gone;
	}
	}
}
#endif
`;

/** Before <clearcoat_normal_fragment_begin>: single-stage paint loses the flake normal; rust / peel / holes shade. */
export const WEATHER_NORMAL = /* glsl */ `
normal = normalize( mix( normal, nonPerturbedNormal, crWxSolid ) );
normal = crWxBump( - vViewPosition, normal, crWxH, faceDirection );
`;

/** After <lights_physical_fragment>: the clear coat follows fade / peel / primer / rust / dirt. */
export const WEATHER_COAT = /* glsl */ `
#ifdef USE_CLEARCOAT
	material.clearcoat *= crWxCoat;
	material.clearcoatRoughness = clamp( material.clearcoatRoughness + crWxCoatRough, 0.0, 1.0 );
#endif
`;

/** Cache-key suffix of a weathered material. */
export const WEATHER_KEY = 'wx1';

export interface WeatherUniforms {
  finish: { value: DataTexture };
  /** Vector4 (three's uniform-array setter needs toArray). */
  arch: { value: Vector4[] };
}

export function createWeatherUniforms(texture: DataTexture, arches: readonly FinishArch[]): WeatherUniforms {
  const a = Array.from({ length: FINISH_MAX_ARCHES }, (_, i) => {
    const s = arches[i];
    return s ? new Vector4(s.z, s.y, s.r, s.xMin) : new Vector4(0, 0, 0, 0);
  });
  return { finish: { value: texture }, arch: { value: a } };
}

function must(src: string, anchor: string): void {
  if (!src.includes(anchor)) throw new Error(`weathering: shader lacks "${anchor}" (three chunk drift)`);
}

/**
 * The weathering hook (runs after the slot's own hook, before CSM /
 * flexbody / damage edits). Gates the paint hook's flake glint and pearl
 * by the finish (string edits on materials.ts PAINT_MAIN, if present).
 */
export function applyWeatherGlsl(shader: WebGLProgramParametersWithUniforms, u: WeatherUniforms): void {
  let fs = shader.fragmentShader;
  for (const a of ['#include <common>', '#include <normal_fragment_begin>', '#include <clearcoat_normal_fragment_begin>', '#include <lights_physical_fragment>']) must(fs, a);
  shader.uniforms.uCrWxFinish = u.finish;
  shader.uniforms.uCrWxArch = u.arch;
  fs = fs
    .replace('#include <common>', `#include <common>\n${WEATHER_PARS}`)
    .replace('#include <normal_fragment_begin>', `${WEATHER_SURFACE}\n#include <normal_fragment_begin>`)
    .replace('#include <clearcoat_normal_fragment_begin>', `${WEATHER_NORMAL}\n#include <clearcoat_normal_fragment_begin>`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${WEATHER_COAT}`);
  // paint hook (materials.ts): flake glints and the pearl flop follow the finish
  fs = fs.replace('crGlintW = crOn * uCrFlake.w', 'crGlintW = crWxFlake * crOn * uCrFlake.w').replace('uCrPearl.a * crGraze', 'uCrPearl.a * crWxPearl * crGraze');
  shader.fragmentShader = fs;
}
