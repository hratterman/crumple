/**
 * Eye adaptation (auto exposure) for the post stack.
 *
 *  - MeteringPass: after AO, the HDR frame is reduced to a 32×18 grid of
 *    (mean log2 luminance, mean luminance) — 16 taps per cell — in a float
 *    target, read back ASYNCHRONOUSLY every few frames (no GPU stall).
 *  - CPU: centre-weighted log average (the sky at the top counts less) →
 *    target exposure (partial adaptation: noon stays brighter than dusk, the
 *    night darker than the day), eased in EV with the eye's asymmetric speed
 *    (fast toward light, slow toward dark), clamped to EXPOSURE_RANGE.
 *  - ExposureEffect: multiplies the frame after bloom and before tone
 *    mapping (renderer.toneMappingExposure stays photo mode's EV), plus a
 *    Purkinje shift (rods: desaturated, blue) when adapted to the dark.
 * Bloom's threshold is divided by the same factor so emissives bloom at night.
 */
import { FloatType, NearestFilter, RGBAFormat, ShaderMaterial, Uniform, WebGLRenderTarget } from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { Effect, Pass } from 'postprocessing';

import { readPixelsAsync } from '../readback';

/** Metering grid. */
export const METER_W = 32;
export const METER_H = 18;
/** Scene-linear mean luminance (log average) that maps to factor 1: the golden-hour valley view the P3 exposure was tuned on. */
export const EXPOSURE_REF_LUM = 0.13;
/** Fraction of a luminance change the eye compensates (1 = full adaptation). */
export const EXPOSURE_ADAPT_K = 0.78;
/**
 * Auto factor limits (≈ −1.5 EV … +2.2 EV around the reference): the eye
 * never fully adapts to moonlight — a moonlit valley stays dark and blue,
 * lamps and headlights carry the night.
 */
export const EXPOSURE_RANGE: readonly [number, number] = [0.35, 4.5];
/** EV per second time constants: toward a brighter scene / toward a darker one. */
export const EXPOSURE_TAU_BRIGHTEN_S = 0.45;
export const EXPOSURE_TAU_DARKEN_S = 1.8;

/** Centre-weighted log2 average of metering data (RGBA floats, r = mean log2 lum). Rows bottom-up (GL readback). Pure. */
export function meteredLog2(data: ArrayLike<number>, w = METER_W, h = METER_H): number {
  let s = 0;
  let ws = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h; // 0 bottom … 1 top
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const l = data[(y * w + x) * 4]!;
      if (!Number.isFinite(l)) continue;
      const du = u - 0.5;
      const dv = v - 0.45;
      let wt = Math.exp(-(du * du) / 0.16 - (dv * dv) / 0.1);
      if (v > 0.62) wt *= 0.55; // sky band
      s += wt * l;
      ws += wt;
    }
  }
  return ws > 0 ? s / ws : Number.NaN;
}

/** Target auto factor for a metered log2 luminance (pure). */
export function exposureTarget(log2Lum: number): number {
  const ratio = EXPOSURE_REF_LUM / Math.max(2 ** log2Lum, 1e-6);
  const f = ratio ** EXPOSURE_ADAPT_K;
  return Math.max(EXPOSURE_RANGE[0], Math.min(EXPOSURE_RANGE[1], f));
}

/** One adaptation step in EV (pure). */
export function adaptExposure(current: number, target: number, dtS: number): number {
  const ev = Math.log2(current);
  const tv = Math.log2(target);
  const tau = tv > ev ? EXPOSURE_TAU_DARKEN_S : EXPOSURE_TAU_BRIGHTEN_S; // raising exposure = adapting to the dark
  const k = 1 - Math.exp(-Math.max(0, dtS) / tau);
  return 2 ** (ev + (tv - ev) * k);
}

const METER_FRAGMENT = /* glsl */ `
uniform sampler2D inputBuffer;
varying vec2 vUv;
void main() {
  vec2 cell = vec2(1.0 / ${METER_W}.0, 1.0 / ${METER_H}.0);
  vec2 base = vUv - 0.5 * cell;
  float lsum = 0.0;
  float lin = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = base + (vec2(float(i), float(j)) + 0.5) * 0.25 * cell;
      vec3 c = texture2D(inputBuffer, uv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      l = (l == l && l < 1e4) ? max(l, 0.0) : 0.0;
      lsum += log2(l + 1e-5);
      lin += l;
    }
  }
  gl_FragColor = vec4(lsum / 16.0, lin / 16.0, 0.0, 1.0);
}
`;
const METER_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/** Reduces the HDR frame to the metering grid; does not touch the composer's buffers. */
export class MeteringPass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly mat: ShaderMaterial;
  constructor() {
    super('MeteringPass');
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(METER_W, METER_H, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.mat = new ShaderMaterial({
      name: 'crumple.meter',
      uniforms: { inputBuffer: { value: null as Texture | null } },
      vertexShader: METER_VERTEX,
      fragmentShader: METER_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }
  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget | null): void {
    if (!inputBuffer) return;
    this.mat.uniforms.inputBuffer!.value = inputBuffer.texture;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }
  override dispose(): void {
    this.target.dispose();
    this.mat.dispose();
    super.dispose();
  }
}

const EXPOSURE_FRAGMENT = /* glsl */ `
uniform float autoExposure;
uniform float purkinje;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * autoExposure;
  if (purkinje > 0.0) {
    // scotopic (rod) response peaks near 507 nm: weights from the CIE V'(λ) fit in Rec.709 primaries
    float rod = max(dot(c, vec3(0.04, 0.55, 0.41)), 0.0);
    float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
    // the shift fades out where a light is bright enough for cones (headlights stay coloured)
    float k = purkinje * (1.0 - smoothstep(0.08, 0.6, l));
    c = mix(c, vec3(0.56, 0.7, 1.0) * rod * 1.15, k);
  }
  outputColor = vec4(c, inputColor.a);
}
`;

/** Auto exposure × Purkinje, placed after bloom and before tone mapping. */
export class ExposureEffect extends Effect {
  constructor() {
    super('ExposureEffect', EXPOSURE_FRAGMENT, {
      uniforms: new Map<string, Uniform>([
        ['autoExposure', new Uniform(1)],
        ['purkinje', new Uniform(0)],
      ]),
    });
  }
  set exposure(v: number) {
    this.uniforms.get('autoExposure')!.value = v;
  }
  get exposure(): number {
    return this.uniforms.get('autoExposure')!.value as number;
  }
  set purkinje(v: number) {
    this.uniforms.get('purkinje')!.value = v;
  }
}

/** CPU side: async readbacks → adapted factor. */
export class AutoExposure {
  value = 1;
  target = 1;
  log2Lum = Number.NaN;
  enabled = true;
  /** The next N metering results replace the adapted value (cuts, time-of-day jumps, boot; > 1 because reads lag a frame or two). */
  snapNext = 2;
  reads = 0;
  private reading = false;
  private gen = 0;
  private frame = 0;
  private readonly buf = new Float32Array(METER_W * METER_H * 4);

  /** Call once per rendered frame after the composer ran. */
  update(renderer: WebGLRenderer, meter: MeteringPass, dtS: number): void {
    this.frame++;
    if (!this.enabled) {
      this.value = 1;
      return;
    }
    if (!this.reading && this.frame % 3 === 0) {
      this.reading = true;
      const gen = this.gen;
      readPixelsAsync(renderer, meter.target, 0, 0, METER_W, METER_H, this.buf)
        .then((b) => {
          const l = meteredLog2(b);
          if (gen === this.gen && Number.isFinite(l)) {
            this.log2Lum = l;
            this.target = exposureTarget(l);
            this.reads++;
            if (this.snapNext > 0) {
              this.value = this.target;
              this.snapNext--;
            }
          }
        })
        .catch(() => {
          this.enabled = false; // no async readback: fixed exposure
        })
        .finally(() => {
          this.reading = false;
        });
    }
    this.value = adaptExposure(this.value, this.target, dtS);
  }

  /** Sets the adapted state (replay exit restores the live one); a readback in flight is dropped. */
  set(value: number, target = value): void {
    this.value = value;
    this.target = target;
    this.snapNext = 0;
    this.gen++;
  }

  /** Purkinje strength for the current adaptation (0 by day). */
  purkinje(): number {
    const ev = Math.log2(this.value);
    const t = Math.max(0, Math.min(1, (ev - 1.2) / 0.97));
    return 0.55 * t * t * (3 - 2 * t);
  }
}
