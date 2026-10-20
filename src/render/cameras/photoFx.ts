/**
 * Photo-mode look (P7 R2): colour grade presets, extra vignette and film
 * grain as ONE effect in its own EffectPass appended after the post stack's
 * EffectPass (display-referred, after ACES). The pass exists only while photo
 * mode is on: `attach` adds it, `detach` removes and disposes it, so the
 * default frame never pays for it. Exposure is renderer.toneMappingExposure
 * (the tone-mapping effect reads it), restored on detach.
 */
import { Uniform, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';
import { BlendFunction, Effect, EffectPass, type EffectComposer } from 'postprocessing';
import type { Camera } from 'three';

export interface GradeParams {
  saturation: number;
  contrast: number;
  /** −1 cool … +1 warm. */
  temperature: number;
  /** −1 green … +1 magenta. */
  tint: number;
  /** Shadow / highlight split-tone colours (linear RGB multipliers around 1). */
  shadows: readonly [number, number, number];
  highlights: readonly [number, number, number];
  /** Lifted blacks (matte film), 0..0.2. */
  fade: number;
  /** 0 colour … 1 monochrome. */
  mono: number;
}

export type GradePresetId = 'natural' | 'vivid' | 'film' | 'golden' | 'tealOrange' | 'steel' | 'bleach' | 'noir';

export const GRADE_PRESETS: Readonly<Record<GradePresetId, { label: string; grade: GradeParams }>> = {
  natural: { label: 'Natural', grade: { saturation: 1, contrast: 1, temperature: 0, tint: 0, shadows: [1, 1, 1], highlights: [1, 1, 1], fade: 0, mono: 0 } },
  vivid: { label: 'Vivid', grade: { saturation: 1.28, contrast: 1.1, temperature: 0.02, tint: 0, shadows: [1, 1, 1.02], highlights: [1.02, 1, 0.98], fade: 0, mono: 0 } },
  film: { label: 'Film', grade: { saturation: 0.9, contrast: 1.06, temperature: 0.06, tint: -0.03, shadows: [0.96, 1.02, 1.06], highlights: [1.05, 1.01, 0.94], fade: 0.045, mono: 0 } },
  golden: { label: 'Golden hour', grade: { saturation: 1.12, contrast: 1.04, temperature: 0.32, tint: 0.04, shadows: [1.0, 0.97, 1.02], highlights: [1.08, 1.0, 0.88], fade: 0.015, mono: 0 } },
  tealOrange: { label: 'Teal & orange', grade: { saturation: 1.12, contrast: 1.1, temperature: 0.04, tint: 0, shadows: [0.86, 1.02, 1.12], highlights: [1.12, 1.0, 0.86], fade: 0.01, mono: 0 } },
  steel: { label: 'Cold steel', grade: { saturation: 0.78, contrast: 1.12, temperature: -0.3, tint: -0.02, shadows: [0.94, 1.0, 1.08], highlights: [0.98, 1.0, 1.04], fade: 0.02, mono: 0 } },
  bleach: { label: 'Bleach bypass', grade: { saturation: 0.52, contrast: 1.26, temperature: 0, tint: 0, shadows: [1, 1, 1], highlights: [1, 1, 1], fade: 0, mono: 0 } },
  noir: { label: 'Noir', grade: { saturation: 0, contrast: 1.32, temperature: 0, tint: 0, shadows: [1, 1, 1], highlights: [1, 1, 1], fade: 0.02, mono: 1 } },
};
export const GRADE_PRESET_IDS = Object.keys(GRADE_PRESETS) as GradePresetId[];

const FRAGMENT = /* glsl */ `
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uBalance;
uniform vec3 uShadows;
uniform vec3 uHighlights;
uniform float uFade;
uniform float uMono;
uniform float uVignette;
uniform float uGrain;
uniform float uSeed;

float crHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Grade in a perceptual (gamma 2.2) space, display-referred (after ACES).
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  c *= uBalance;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c * uShadows, c * uHighlights, smoothstep(0.15, 0.85, l));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = mix(c, vec3(l), uMono);
  c = (c - 0.5) * uContrast + 0.5;
  c = uFade + c * (1.0 - uFade);
  // Vignette (aspect-correct, soft).
  vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
  float v = smoothstep(0.35, 1.05, length(d) * 1.25);
  c *= 1.0 - uVignette * v;
  // Film grain: luma-weighted, strongest in the mid-tones.
  float n = crHash(uv * resolution + uSeed) + crHash(uv * resolution * 1.37 - uSeed) - 1.0;
  float w = 1.0 - abs(l * 2.0 - 1.0);
  c += n * uGrain * (0.35 + 0.65 * w);
  c = clamp(c, 0.0, 1.0);
  outputColor = vec4(pow(c, vec3(2.2)), inputColor.a);
}
`;

export class PhotoGradeEffect extends Effect {
  constructor() {
    super('CrumplePhotoGrade', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['uSaturation', new Uniform(1)],
        ['uContrast', new Uniform(1)],
        ['uBalance', new Uniform(new Vector3(1, 1, 1))],
        ['uShadows', new Uniform(new Vector3(1, 1, 1))],
        ['uHighlights', new Uniform(new Vector3(1, 1, 1))],
        ['uFade', new Uniform(0)],
        ['uMono', new Uniform(0)],
        ['uVignette', new Uniform(0)],
        ['uGrain', new Uniform(0)],
        ['uSeed', new Uniform(0)],
      ]),
    });
  }

  private u(name: string): Uniform {
    return this.uniforms.get(name)!;
  }

  setGrade(g: Readonly<GradeParams>): void {
    this.u('uSaturation').value = g.saturation;
    this.u('uContrast').value = g.contrast;
    // White balance: warm = +R −B, tint = +R+B −G (small, multiplicative).
    const t = g.temperature * 0.12;
    const m = g.tint * 0.06;
    (this.u('uBalance').value as Vector3).set(1 + t + m * 0.5, 1 - m, 1 - t + m * 0.5);
    (this.u('uShadows').value as Vector3).set(g.shadows[0], g.shadows[1], g.shadows[2]);
    (this.u('uHighlights').value as Vector3).set(g.highlights[0], g.highlights[1], g.highlights[2]);
    this.u('uFade').value = g.fade;
    this.u('uMono').value = g.mono;
  }

  set vignette(v: number) {
    this.u('uVignette').value = v;
  }
  set grain(v: number) {
    this.u('uGrain').value = v;
  }

  override update(): void {
    // A new grain pattern every frame (a still photo keeps the last one).
    this.u('uSeed').value = (this.u('uSeed').value as number + 17.13) % 1000;
  }
}

export interface PhotoLook {
  preset: GradePresetId;
  /** EV stops on top of the stack's exposure. */
  exposure: number;
  /** 0..1 extra vignette. */
  vignette: number;
  /** 0..1 film grain. */
  grain: number;
}

export const DEFAULT_PHOTO_LOOK: Readonly<PhotoLook> = { preset: 'natural', exposure: 0, vignette: 0.25, grain: 0.15 };

/** Adds / removes the photo grade pass on a composer (the post stack's EffectPass must stay before it). */
export class PhotoFx {
  private pass: EffectPass | null = null;
  private effect: PhotoGradeEffect | null = null;
  private baseExposure = 1;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly composer: EffectComposer,
    private readonly camera: Camera,
  ) {}

  get attached(): boolean {
    return this.pass !== null;
  }

  attach(): void {
    if (this.pass) return;
    this.baseExposure = this.renderer.toneMappingExposure;
    this.effect = new PhotoGradeEffect();
    this.pass = new EffectPass(this.camera, this.effect);
    // It is the last pass (8-bit output) now: dither like the stack's own EffectPass, or graded sky
    // gradients band.
    this.pass.dithering = true;
    this.composer.addPass(this.pass);
  }

  /** Keeps the grade pass last (a quality change rebuilds the stack's EffectPass at the end). */
  frame(): void {
    const p = this.pass;
    if (!p) return;
    const passes = this.composer.passes;
    if (passes[passes.length - 1] !== p) {
      this.composer.removePass(p);
      this.composer.addPass(p);
    }
  }

  apply(look: Readonly<PhotoLook>): void {
    const e = this.effect;
    if (!e) return;
    e.setGrade(GRADE_PRESETS[look.preset].grade);
    e.vignette = Math.min(Math.max(look.vignette, 0), 1) * 0.85;
    e.grain = Math.min(Math.max(look.grain, 0), 1) * 0.12;
    this.renderer.toneMappingExposure = this.baseExposure * Math.pow(2, look.exposure);
  }

  detach(): void {
    if (!this.pass) return;
    this.composer.removePass(this.pass);
    this.pass.dispose();
    this.pass = null;
    this.effect = null;
    this.renderer.toneMappingExposure = this.baseExposure;
  }
}
