/**
 * Temporal anti-aliasing with reprojection + motion blur.
 *
 *  - JITTER: the camera projection is offset by a Halton(2, 3) sub-pixel
 *    sequence (8 samples) for the whole composer render, restored after it
 *    (CSM fitting, culling and the velocity pass see the clean matrix).
 *  - MOTION VECTORS (`MotionVectors`): only DYNAMIC objects are drawn — the
 *    player's soft body, wheels, pooled traffic, awake props register their
 *    roots. Each mesh draws with a velocity twin of its OWN depth material
 *    (the flexbody / wheel / prop patch deforms it exactly like the shadow
 *    pass), previous clip position = this frame's skinned position under the
 *    previous model matrix and view-projection: the motion of the object's
 *    frame exactly (the flexbody's anchor translation, wheel spin), the
 *    deformation / yaw carried in the node texture over one frame (≪ the
 *    motion) ignored. One twin per mesh (its own previous model matrix;
 *    meshes sharing a depth material share its program).
 *    Target RG16F-ish: rg = Δuv (current − previous), b = view depth, a = 1.
 *  - Static pixels reproject through the depth buffer and the previous
 *    unjittered view-projection (no draw at all for the world).
 *  - RESOLVE (`TAAPass`): closest-depth velocity dilation in 3×3, Catmull-Rom
 *    history fetch, YCoCg variance clipping of the history against the
 *    current neighbourhood, luma-weighted blend (8 % current when still, more
 *    as the motion grows), off-screen → reset; NaN / overflow guarded (the
 *    history would keep a bad texel forever). Runs before bloom, on HDR, so
 *    AO noise and dithered foliage fades resolve too; SMAA is off while it is
 *    on.
 *  - MOTION BLUR (`MotionBlurPass`, preset strength): along the same
 *    velocities (object or camera), depth-aware, never into the history.
 */
import {
  Camera,
  Color,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { CopyMaterial, Pass } from 'postprocessing';

/** Halton low-discrepancy value of index i in base b (pure). */
export function halton(i: number, b: number): number {
  let f = 1;
  let r = 0;
  let k = i;
  while (k > 0) {
    f /= b;
    r += f * (k % b);
    k = Math.floor(k / b);
  }
  return r;
}

export const TAA_SAMPLES = 8;

/** Sub-pixel jitter of frame n in pixels, centred (−0.5 … 0.5). */
export function jitterOffset(n: number, out: Vector2): Vector2 {
  const i = (n % TAA_SAMPLES) + 1;
  return out.set(halton(i, 2) - 0.5, halton(i, 3) - 0.5);
}

// ------------------------------------------------------------ motion vectors
const VEL_KEY = 'vel1';

function velocityTwin(base: Material | null | undefined): Material {
  const src = base ?? new MeshDepthMaterial();
  const twin = src instanceof MeshDepthMaterial ? new MeshDepthMaterial() : (src.clone() as Material);
  if (twin instanceof MeshDepthMaterial && src instanceof MeshDepthMaterial) twin.depthPacking = src.depthPacking;
  const prior = src.onBeforeCompile === Material.prototype.onBeforeCompile ? null : src.onBeforeCompile;
  const priorKey = src.customProgramCacheKey ? src.customProgramCacheKey.call(src) : '';
  twin.onBeforeCompile = function (shader, renderer) {
    if (prior) prior.call(src, shader, renderer);
    shader.uniforms.uVelPrevModel = { value: new Matrix4() };
    shader.uniforms.uVelPrevViewProj = MOTION_SHARED.uVelPrevViewProj;
    (twin.userData as { velUniforms?: unknown }).velUniforms = shader.uniforms;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uVelPrevModel;\nuniform mat4 uVelPrevViewProj;\nvarying vec4 vVelCur;\nvarying vec4 vVelPrev;\nvarying float vVelDepth;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	{
		vec4 velP = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			velP = instanceMatrix * velP;
		#endif
		vVelCur = gl_Position;
		vVelPrev = uVelPrevViewProj * uVelPrevModel * velP;
		vVelDepth = - mvPosition.z;
	}`,
      );
    const fs = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vVelCur;\nvarying vec4 vVelPrev;\nvarying float vVelDepth;');
    shader.fragmentShader = `${fs.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void crumpleDepthMain() {')}
void main() {
	crumpleDepthMain();
	vec2 c = vVelCur.xy / vVelCur.w;
	vec2 p = vVelPrev.xy / max( abs( vVelPrev.w ), 1e-5 ) * sign( vVelPrev.w );
	gl_FragColor = vec4( ( c - p ) * 0.5, vVelDepth, 1.0 );
}`;
  };
  twin.customProgramCacheKey = () => `${priorKey}|${VEL_KEY}`;
  twin.needsUpdate = true;
  return twin;
}

const MOTION_SHARED = { uVelPrevViewProj: { value: new Matrix4() } };

export interface MotionVectors {
  readonly texture: Texture;
  /** The dynamic subtrees this frame (player vehicle, pooled traffic); null entries skipped. */
  setRoots(roots: readonly (Object3D | null | undefined)[]): void;
  setSize(width: number, height: number): void;
  /** Draws the registered objects' velocities with the UNJITTERED camera; call before the composer. */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera): void;
  /** Stores this frame's matrices as the previous ones; call after the frame. */
  endFrame(camera: Camera): void;
  readonly stats: { meshes: number };
  dispose(): void;
}

export function createMotionVectors(): MotionVectors {
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  let roots: readonly (Object3D | null | undefined)[] = [];
  const twins = new WeakMap<Mesh, Material>();
  const prevModel = new WeakMap<Object3D, Matrix4>();
  const viewProj = new Matrix4();
  const prevViewProj = MOTION_SHARED.uVelPrevViewProj.value;
  let havePrev = false;
  const saved: { m: Mesh; mat: Material | Material[] }[] = [];
  const clear = new Color();
  const stats = { meshes: 0 };

  const twinFor = (mesh: Mesh): Material => {
    let t = twins.get(mesh);
    if (!t) {
      t = velocityTwin(mesh.customDepthMaterial ?? null);
      twins.set(mesh, t);
    }
    return t;
  };
  const skip = (m: Mesh): boolean => {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    // glass / decals: the surface behind carries the motion; lines / points never
    return !m.isMesh || !m.geometry || !mat || mat.transparent || !mat.depthWrite || !mat.visible;
  };

  return {
    texture: target.texture,
    stats,
    setRoots(list) {
      roots = list;
    },
    setSize(w, h) {
      target.setSize(Math.max(1, w), Math.max(1, h));
    },
    render(renderer, camera) {
      camera.updateMatrixWorld();
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (!havePrev) prevViewProj.copy(viewProj);
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      saved.length = 0;
      stats.meshes = 0;
      for (const root of roots) {
        if (!root || !root.visible || !root.parent) continue;
        root.traverseVisible((o) => {
          const m = o as Mesh;
          if (skip(m)) return;
          const t = twinFor(m);
          const u = (t.userData as { velUniforms?: Record<string, { value: Matrix4 }> }).velUniforms;
          if (u?.uVelPrevModel) u.uVelPrevModel.value.copy(prevModel.get(m) ?? m.matrixWorld);
          saved.push({ m, mat: m.material });
          m.material = t;
          stats.meshes++;
        });
        const auto = root.matrixWorldAutoUpdate;
        root.matrixWorldAutoUpdate = false; // drawn as its own scene: keep the parent's transform
        renderer.render(root, camera);
        root.matrixWorldAutoUpdate = auto;
        for (const s of saved) s.m.material = s.mat;
        saved.length = 0;
      }
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clear, prevAlpha);
    },
    endFrame(camera) {
      camera.updateMatrixWorld();
      prevViewProj.multiplyMatrices((camera as PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
      havePrev = true;
      for (const root of roots)
        root?.traverse((o) => {
          if (!(o as Mesh).isMesh) return;
          let m = prevModel.get(o);
          if (!m) {
            m = new Matrix4();
            prevModel.set(o, m);
          }
          m.copy(o.matrixWorld);
        });
    },
    dispose() {
      target.dispose();
      roots = [];
    },
  };
}

// ------------------------------------------------------------ shared GLSL
const REPROJECT_GLSL = /* glsl */ `
uniform highp sampler2D depthBuffer;
uniform highp sampler2D tVelocity;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec2 uTexel;
uniform vec2 uNearFar;
float taaLinear( float d ) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / ( uNearFar.y + uNearFar.x - z * ( uNearFar.y - uNearFar.x ) );
}
/** uv this pixel had last frame: the dynamic object's own motion where it is the visible surface, else the camera's. */
vec2 taaPrevUv( vec2 uv, vec2 uvD, float d ) {
  vec4 vel = texture2D( tVelocity, uvD );
  if ( vel.a > 0.5 ) {
    float lin = taaLinear( d );
    if ( abs( vel.b - lin ) < 0.15 + lin * 0.04 ) return uv - vel.rg;
  }
  vec4 w;
  if ( d >= 0.999999 ) {
    // sky: direction only (rotation reprojection)
    w = uInvViewProj * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
    w.xyz /= w.w;
    w = vec4( w.xyz, 0.0 );
    vec4 pc = uPrevViewProj * w;
    return pc.xy / pc.w * 0.5 + 0.5;
  }
  w = uInvViewProj * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  w /= w.w;
  vec4 pc = uPrevViewProj * w;
  return pc.xy / pc.w * 0.5 + 0.5;
}
`;

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const TAA_FRAGMENT = /* glsl */ `
uniform highp sampler2D inputBuffer;
uniform highp sampler2D tHistory;
uniform float uReset;
uniform float uFeedback;
uniform float uAccum;
varying vec2 vUv;
${REPROJECT_GLSL}
vec3 toYCoCg( vec3 c ) { return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b ); }
vec3 fromYCoCg( vec3 c ) { return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z ); }
vec3 safe( vec3 c ) { return ( c.r == c.r && c.g == c.g && c.b == c.b ) ? clamp( c, vec3( 0.0 ), vec3( 1024.0 ) ) : vec3( 0.0 ); }
// a compressive weight keeps fireflies from dominating the blend (Karis)
vec3 tmap( vec3 c ) { return c / ( 1.0 + toYCoCg( c ).x ); }
vec3 tunmap( vec3 c ) { return c / max( 1.0 - toYCoCg( c ).x, 1e-3 ); }
vec3 historyCR( vec2 uv ) {
  // Catmull-Rom in 5 bilinear taps
  vec2 tex = 1.0 / uTexel;
  vec2 pos = uv * tex;
  vec2 c1 = floor( pos - 0.5 ) + 0.5;
  vec2 f = pos - c1;
  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = ( c1 - 1.0 ) * uTexel;
  vec2 t3 = ( c1 + 2.0 ) * uTexel;
  vec2 t12 = ( c1 + o12 ) * uTexel;
  vec3 r = texture2D( tHistory, vec2( t12.x, t0.y ) ).rgb * ( w12.x * w0.y )
    + texture2D( tHistory, vec2( t0.x, t12.y ) ).rgb * ( w0.x * w12.y )
    + texture2D( tHistory, t12 ).rgb * ( w12.x * w12.y )
    + texture2D( tHistory, vec2( t3.x, t12.y ) ).rgb * ( w3.x * w12.y )
    + texture2D( tHistory, vec2( t12.x, t3.y ) ).rgb * ( w12.x * w3.y );
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max( r / wsum, vec3( 0.0 ) );
}
void main() {
  vec2 uv = vUv;
  vec3 cur = safe( texture2D( inputBuffer, uv ).rgb );
  // neighbourhood moments (YCoCg) + the closest depth for velocity dilation
  vec3 m1 = vec3( 0.0 );
  vec3 m2 = vec3( 0.0 );
  float dMin = 1.0;
  vec2 uvD = uv;
  for ( int j = -1; j <= 1; j ++ )
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 o = vec2( float( i ), float( j ) ) * uTexel;
      vec3 c = toYCoCg( tmap( safe( texture2D( inputBuffer, uv + o ).rgb ) ) );
      m1 += c;
      m2 += c * c;
      float d = texture2D( depthBuffer, uv + o ).r;
      if ( d < dMin ) { dMin = d; uvD = uv + o; }
    }
  m1 /= 9.0;
  vec3 sigma = sqrt( max( m2 / 9.0 - m1 * m1, vec3( 0.0 ) ) );
  vec2 prevUv = taaPrevUv( uv, uvD, dMin );
  bool off = prevUv.x < 0.0 || prevUv.y < 0.0 || prevUv.x > 1.0 || prevUv.y > 1.0;
  vec3 res;
  if ( uReset > 0.5 || off ) {
    res = cur;
  } else {
    vec3 hist = toYCoCg( tmap( safe( historyCR( prevUv ) ) ) );
    // variance clipping: pull the history toward the neighbourhood box
    vec3 lo = m1 - 1.25 * sigma;
    vec3 hi = m1 + 1.25 * sigma;
    vec3 ctr = 0.5 * ( lo + hi );
    vec3 ext = max( 0.5 * ( hi - lo ), vec3( 1e-4 ) );
    vec3 v = hist - ctr;
    vec3 a = abs( v / ext );
    float ma = max( a.x, max( a.y, a.z ) );
    if ( ma > 1.0 ) hist = ctr + v / ma;
    vec3 c = toYCoCg( tmap( cur ) );
    // faster response under motion (less blur), slower when still (less shimmer)
    float speed = length( ( uv - prevUv ) / uTexel );
    // right after a reset the history is a running mean of the frames so far (a still converges in TAA_SAMPLES frames)
    float k = max( mix( uFeedback, 0.35, smoothstep( 2.0, 24.0, speed ) ), uAccum );
    res = tunmap( fromYCoCg( mix( hist, c, k ) ) );
  }
  gl_FragColor = vec4( safe( res ), 1.0 );
}
`;

const BLUR_FRAGMENT = /* glsl */ `
uniform highp sampler2D inputBuffer;
uniform float uStrength;
varying vec2 vUv;
${REPROJECT_GLSL}
void main() {
  vec2 uv = vUv;
  float d0 = texture2D( depthBuffer, uv ).r;
  vec2 v = ( uv - taaPrevUv( uv, uv, d0 ) ) * uStrength;
  float l = length( v );
  float maxL = 0.035;
  if ( l > maxL ) v *= maxL / l;
  vec3 c0 = texture2D( inputBuffer, uv ).rgb;
  if ( length( v / uTexel ) < 0.75 ) { gl_FragColor = vec4( c0, 1.0 ); return; }
  float z0 = taaLinear( d0 );
  vec3 acc = c0;
  float wsum = 1.0;
  for ( int i = 1; i <= 8; i ++ ) {
    float t = ( float( i ) / 8.0 - 0.5 ) * 2.0;
    vec2 suv = uv + v * t * 0.5;
    float zs = taaLinear( texture2D( depthBuffer, suv ).r );
    // a sample far behind the centre may not smear over it (no background streaks on a sharp car)
    float w = zs + 0.5 < z0 ? 1.0 : smoothstep( z0 * 1.4 + 2.0, z0 * 1.05, zs );
    acc += texture2D( inputBuffer, suv ).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4( acc / wsum, 1.0 );
}
`;

interface ReprojectUniforms {
  depthBuffer: { value: Texture | null };
  tVelocity: { value: Texture | null };
  uInvViewProj: { value: Matrix4 };
  uPrevViewProj: { value: Matrix4 };
  uTexel: { value: Vector2 };
  uNearFar: { value: Vector2 };
}

/** Matrices the resolve + blur share, filled once per frame by `TaaState.update`. */
export class TaaState {
  readonly invViewProj = new Matrix4();
  readonly prevViewProj = new Matrix4();
  readonly nearFar = new Vector2(0.1, 1000);
  private readonly cur = new Matrix4();
  private have = false;
  /** Call before the composer renders, with the UNJITTERED camera. */
  update(camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    this.cur.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invViewProj.copy(this.cur).invert();
    if (!this.have) this.prevViewProj.copy(this.cur);
    this.nearFar.set(camera.near, camera.far);
  }
  /** Call after the frame. */
  end(): void {
    this.prevViewProj.copy(this.cur);
    this.have = true;
  }
  reset(): void {
    this.have = false;
  }
}

function reprojectUniforms(state: TaaState, velocity: Texture): ReprojectUniforms {
  return {
    depthBuffer: { value: null },
    tVelocity: { value: velocity },
    uInvViewProj: { value: state.invViewProj },
    uPrevViewProj: { value: state.prevViewProj },
    uTexel: { value: new Vector2(1, 1) },
    uNearFar: { value: state.nearFar },
  };
}

export class TAAPass extends Pass {
  private readonly mat: ShaderMaterial;
  private hist: [WebGLRenderTarget, WebGLRenderTarget];
  private idx = 0;
  private since = 0;
  private readonly copy = new CopyMaterial();
  reset = true;
  constructor(state: TaaState, velocity: Texture, feedback = 0.08) {
    super('TAAPass');
    this.needsDepthTexture = true;
    const mk = (): WebGLRenderTarget =>
      new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.hist = [mk(), mk()];
    this.mat = new ShaderMaterial({
      name: 'crumple.taa',
      uniforms: { ...reprojectUniforms(state, velocity), inputBuffer: { value: null }, tHistory: { value: null }, uReset: { value: 1 }, uFeedback: { value: feedback }, uAccum: { value: 1 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: TAA_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }
  override setDepthTexture(depthTexture: Texture): void {
    this.mat.uniforms.depthBuffer!.value = depthTexture;
  }
  override setSize(width: number, height: number): void {
    for (const h of this.hist) h.setSize(width, height);
    (this.mat.uniforms.uTexel!.value as Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.reset = true;
  }
  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null, outputBuffer: WebGLRenderTarget | null): void {
    if (!inputBuffer) return;
    const read = this.hist[this.idx]!;
    const write = this.hist[1 - this.idx]!;
    const u = this.mat.uniforms;
    u.inputBuffer!.value = inputBuffer.texture;
    u.tHistory!.value = read.texture;
    if (this.reset) this.since = 0;
    u.uReset!.value = this.reset ? 1 : 0;
    u.uAccum!.value = 1 / (this.since + 1);
    this.since++;
    this.fullscreenMaterial = this.mat;
    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);
    // the resolved frame goes on down the chain; the history keeps it for the next frame
    this.copy.inputBuffer = write.texture;
    this.fullscreenMaterial = this.copy;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.mat;
    this.idx = 1 - this.idx;
    this.reset = false;
  }
  override dispose(): void {
    for (const h of this.hist) h.dispose();
    this.mat.dispose();
    this.copy.dispose();
    super.dispose();
  }
}

export class MotionBlurPass extends Pass {
  private readonly mat: ShaderMaterial;
  constructor(state: TaaState, velocity: Texture, strength: number) {
    super('MotionBlurPass');
    this.needsDepthTexture = true;
    this.mat = new ShaderMaterial({
      name: 'crumple.motionBlur',
      uniforms: { ...reprojectUniforms(state, velocity), inputBuffer: { value: null }, uStrength: { value: strength } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }
  set strength(v: number) {
    this.mat.uniforms.uStrength!.value = v;
  }
  override setDepthTexture(depthTexture: Texture): void {
    this.mat.uniforms.depthBuffer!.value = depthTexture;
  }
  override setSize(width: number, height: number): void {
    (this.mat.uniforms.uTexel!.value as Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }
  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null, outputBuffer: WebGLRenderTarget | null): void {
    if (!inputBuffer) return;
    this.mat.uniforms.inputBuffer!.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }
  override dispose(): void {
    this.mat.dispose();
    super.dispose();
  }
}

/** Applies / removes the sub-pixel jitter on a camera's projection (pixels → NDC). */
export function applyJitter(camera: PerspectiveCamera, jitterPx: Vector2, width: number, height: number, sign: 1 | -1): void {
  const e = camera.projectionMatrix.elements;
  e[8] = e[8]! + (sign * 2 * jitterPx.x) / Math.max(1, width);
  e[9] = e[9]! + (sign * 2 * jitterPx.y) / Math.max(1, height);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

export type { DepthTexture };
