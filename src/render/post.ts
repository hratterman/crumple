/**
 * Post stack (contract: render/types.ts CreatePostStack).
 *
 *   RenderPass → N8AOPostPass → [Sanitize] → EffectPass(SMAA, Bloom, ToneMapping ACES, Vignette)
 *
 * Sanitize (when bloom is on): a mirror-sharp surface reflecting the sun can
 * overflow the HalfFloat target (Inf) or produce NaN; bloom's mip blur then
 * spreads one bad pixel over the whole frame (black frame). The pass replaces
 * non-finite texels (IEEE exponent all ones, tested on the bits: isnan() may
 * be compiled away) with black and clamps the rest to SANITIZE_MAX. Bloom
 * reads its own input buffer, so the guard must be a pass before the
 * EffectPass, not an effect inside it.
 *
 * n8ao transparencyAware is forced OFF: its auto-detection traversed the
 * scene every frame and, once any transparent material existed (glass, road
 * fringes), rendered the scene twice more (re-rendering every CSM cascade
 * each time: three re-renders shadow maps on every renderer.render).
 *
 * HalfFloat buffers, no MSAA (SMAA does AA). renderer.toneMapping must stay
 * NoToneMapping (postprocessing tone-maps in the EffectPass, which is also
 * where the sRGB output conversion happens), so n8ao's gammaCorrection is
 * forced false. Exposure is renderer.toneMappingExposure: three uploads it to
 * every program that declares it, including the tone-mapping effect.
 */
import { HalfFloatType, NoToneMapping, ShaderMaterial, SRGBColorSpace } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ShaderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { Effect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

import type { CreatePostStack, PostStack, QualityPreset, RenderContext } from './types';

// ============================================================ tuning
/**
 * Exposure into ACES. Matched to the lighting stack's scale (sun ≈ 6,
 * sky = HDRI × ENV_SCALE 0.136): mid-grey sunlit asphalt lands mid-tone.
 */
export const POST_EXPOSURE = 2.4;
export const TONE_MAPPING = ToneMappingMode.ACES_FILMIC;
/** n8ao world radius, m: car-scale contact shadows + terrain creases. */
export const AO_RADIUS_M = 2;
export const AO_DISTANCE_FALLOFF = 1;
export const AO_INTENSITY = 2;
/** Bloom only on HDR highlights (sun glints, sky near the sun, headlights). Scene-linear, pre-exposure (×4 on screen). */
export const BLOOM_THRESHOLD = 1.8;
export const BLOOM_SMOOTHING = 0.6;
export const BLOOM_INTENSITY = 0.22;
export const BLOOM_RADIUS = 0.7;
export const VIGNETTE_OFFSET = 0.32;
export const VIGNETTE_DARKNESS = 0.32;

/** Largest scene-linear value that reaches bloom (the sun disc is ~60; HalfFloat max is 65504). */
export const SANITIZE_MAX = 1024;

/** The guard's fragment shader (exported for the unit test). */
export const SANITIZE_FRAGMENT = /* glsl */ `
uniform highp sampler2D inputBuffer;
varying vec2 vUv;
bool crumpleBad(float x) {
  // exponent bits all ones = Inf or NaN (bit test: survives fast-math NaN folding)
  return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u || isnan(x) || isinf(x);
}
void main() {
  vec4 c = texture2D(inputBuffer, vUv);
  if (crumpleBad(c.r) || crumpleBad(c.g) || crumpleBad(c.b) || crumpleBad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragColor = clamp(c, vec4(-${SANITIZE_MAX}.0), vec4(${SANITIZE_MAX}.0));
}
`;

const SANITIZE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/** Fullscreen NaN/Inf/overflow guard (see the header). */
export function createSanitizePass(): ShaderPass {
  const material = new ShaderMaterial({
    name: 'crumple.sanitize',
    uniforms: { inputBuffer: { value: null } },
    vertexShader: SANITIZE_VERTEX,
    fragmentShader: SANITIZE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const pass = new ShaderPass(material, 'inputBuffer');
  pass.name = 'SanitizePass';
  return pass;
}

export interface PostFlags {
  ao: boolean;
  smaa: boolean;
  bloom: boolean;
  /** NaN/overflow guard before the EffectPass (only needed when bloom can spread a bad texel). */
  sanitize: boolean;
}

/** Which effects a preset enables (pure; disabled effects are not in the pass). */
export function postFlags(q: QualityPreset): PostFlags {
  return { ao: q.aoEnabled, smaa: q.smaa, bloom: q.bloom, sanitize: q.bloom };
}

/** SMAA search quality per preset: the edge search dominates SMAA's cost on slow GPUs. */
export function smaaPresetFor(q: QualityPreset): SMAAPreset {
  switch (q.level) {
    case 'low':
      return SMAAPreset.LOW;
    case 'medium':
      return SMAAPreset.MEDIUM;
    case 'ultra':
      return SMAAPreset.ULTRA;
    default:
      return SMAAPreset.HIGH;
  }
}

/** n8ao settings for a preset (pure). Denoise samples follow at half the AO samples. */
export function aoSettings(q: QualityPreset): { aoSamples: number; denoiseSamples: number; denoiseRadius: number; halfRes: boolean } {
  const aoSamples = Math.max(4, q.aoSamples | 0);
  return {
    aoSamples,
    denoiseSamples: Math.max(4, aoSamples >> 1),
    denoiseRadius: aoSamples >= 32 ? 8 : 12,
    halfRes: aoSamples <= 8,
  };
}

/** Effect list in the frozen order for the given flags (pure over effect instances). */
export function orderedEffects<T>(flags: PostFlags, fx: { smaa: T; bloom: T; tone: T; vignette: T }): T[] {
  const out: T[] = [];
  if (flags.smaa) out.push(fx.smaa);
  if (flags.bloom) out.push(fx.bloom);
  out.push(fx.tone, fx.vignette);
  return out;
}

export const createPostStack: CreatePostStack = (ctx: RenderContext): PostStack => {
  const renderer: WebGLRenderer = ctx.renderer;
  const scene: Scene = ctx.scene;
  const camera: Camera = ctx.camera;
  renderer.toneMapping = NoToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMappingExposure = POST_EXPOSURE;

  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
    multisampling: 0,
    stencilBuffer: false,
    depthBuffer: true,
  });

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const ao = new N8AOPostPass(scene, camera, Math.max(1, ctx.width), Math.max(1, ctx.height));
  // No per-frame transparency auto-detection / extra scene renders (see the header). Assigning
  // transparencyAware only disables detection when the value changes, so clear the flag directly.
  (ao as unknown as { autoDetectTransparency: boolean }).autoDetectTransparency = false;
  ao.configuration.transparencyAware = false;
  ao.configuration.gammaCorrection = false;
  ao.configuration.screenSpaceRadius = false;
  ao.configuration.aoRadius = AO_RADIUS_M;
  ao.configuration.distanceFalloff = AO_DISTANCE_FALLOFF;
  ao.configuration.intensity = AO_INTENSITY;
  ao.configuration.depthAwareUpsampling = true;
  composer.addPass(ao);

  let toneMode: ToneMappingMode = TONE_MAPPING;
  let effectPass: EffectPass | null = null;
  let sanitizePass: ShaderPass | null = null;
  let effects: { smaa: SMAAEffect; bloom: BloomEffect; tone: ToneMappingEffect; vignette: VignetteEffect } | null = null;
  let flagsKey = '';

  const makeEffects = (q: QualityPreset) => ({
    smaa: new SMAAEffect({ preset: smaaPresetFor(q) }),
    bloom: new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: BLOOM_THRESHOLD,
      luminanceSmoothing: BLOOM_SMOOTHING,
      intensity: BLOOM_INTENSITY,
      radius: BLOOM_RADIUS,
    }),
    tone: new ToneMappingEffect({ mode: toneMode }),
    vignette: new VignetteEffect({ offset: VIGNETTE_OFFSET, darkness: VIGNETTE_DARKNESS }),
  });

  const applyAo = (q: QualityPreset): void => {
    ao.enabled = q.aoEnabled;
    if (!q.aoEnabled) return;
    const s = aoSettings(q);
    // each assignment re-configures only when the value changes
    ao.configuration.halfRes = s.halfRes;
    ao.configuration.aoSamples = s.aoSamples;
    ao.configuration.denoiseSamples = s.denoiseSamples;
    ao.configuration.denoiseRadius = s.denoiseRadius;
  };

  /** Disabled effects are left out of the pass (no cost); the pass and its effects are rebuilt together. */
  const rebuildEffects = (q: QualityPreset, force = false): void => {
    const flags = postFlags(q);
    const key = `${flags.smaa}|${flags.bloom}|${flags.sanitize}|${smaaPresetFor(q)}`;
    if (!force && key === flagsKey && effectPass) return;
    flagsKey = key;
    if (effectPass) {
      composer.removePass(effectPass);
      effectPass.dispose(); // also disposes its effects
    }
    if (sanitizePass && !flags.sanitize) {
      composer.removePass(sanitizePass);
      sanitizePass.dispose();
      sanitizePass = null;
    } else if (!sanitizePass && flags.sanitize) {
      sanitizePass = createSanitizePass();
      composer.addPass(sanitizePass);
    }
    effects = makeEffects(q);
    effectPass = new EffectPass(camera, ...orderedEffects<Effect>(flags, effects));
    effectPass.dithering = true; // 8-bit output of half-float sky gradients bands without it
    composer.addPass(effectPass);
  };

  const setQuality = (q: QualityPreset): void => {
    applyAo(q);
    rebuildEffects(q);
  };
  setQuality(ctx.quality);
  composer.setSize(Math.max(1, ctx.width), Math.max(1, ctx.height));

  const stack: PostStack & { debug: PostDebug } = {
    composer,
    render(dtS: number) {
      composer.render(dtS);
    },
    setSize(width: number, height: number) {
      // EffectComposer.setSize → renderer.setSize (keeps the renderer's pixel ratio) → every pass at drawing-buffer size
      composer.setSize(Math.max(1, width), Math.max(1, height));
    },
    setQuality,
    dispose() {
      composer.removeAllPasses();
      effectPass?.dispose();
      sanitizePass?.dispose();
      ao.dispose();
      renderPass.dispose();
      composer.dispose();
    },
    debug: {
      ao,
      get sanitize() {
        return sanitizePass;
      },
      get effects() {
        return effects;
      },
      setToneMapping(mode: ToneMappingMode) {
        toneMode = mode;
        rebuildEffects(ctx.quality, true);
      },
    },
  };
  return stack;
};

/** Dev/test handle (not part of the contract). */
export interface PostDebug {
  readonly ao: N8AOPostPass;
  readonly sanitize: ShaderPass | null;
  readonly effects: { smaa: SMAAEffect; bloom: BloomEffect; tone: ToneMappingEffect; vignette: VignetteEffect } | null;
  setToneMapping(mode: ToneMappingMode): void;
}

export function postDebug(stack: PostStack): PostDebug {
  return (stack as PostStack & { debug: PostDebug }).debug;
}
