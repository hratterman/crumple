/**
 * patchMaterial — the ONE place shader features are composed into a lit
 * material and its shadow-pass twins (contract: render/types.ts
 * "COMPOSITION ORDER — FROZEN").
 *
 *   csm → flexbody → damage   (PATCH_ORDER)
 *
 * CSM's setupMaterial OVERWRITES material.onBeforeCompile, so it runs first;
 * the hook it leaves (plus any hook the material already had, e.g. a terrain
 * splat patch) is captured and called before the feature patches. Every
 * patched material gets a customProgramCacheKey made of the prior key and
 * the feature keys, because the composed hook's toString() is identical for
 * all materials and would otherwise alias programs.
 *
 * R-GFX (additive): every material patched WITH a CSM (= world-lit) also gets
 * the environment patch (lighting/envPatch.ts: aerial perspective, and the
 * time-of-day / weather uniforms) after the PATCH_ORDER features, key
 * `env:<ENV_PATCH_KEY>`; `features.env === false` opts out.
 */
import { Material, MeshDepthMaterial, MeshDistanceMaterial, RGBADepthPacking } from 'three';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';

import { envPatchFor } from './lighting/envUniforms';
import { PATCH_ORDER } from './types';
import type { MaterialFeatures, PatchedMaterialSet, PatchTarget, ShaderPatch } from './types';

type Hook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

const patched = new WeakSet<Material>();

/** Marker exposed for debugging/tests: the feature keys applied, in order. */
export const PATCH_INFO = Symbol('crumple.patchInfo');
export interface PatchInfo {
  readonly features: readonly string[];
  readonly key: string;
}

/** The hook three installs by default (no-op) — not a "prior hook". */
const DEFAULT_HOOK = Material.prototype.onBeforeCompile;

function ownHook(material: Material): Hook | null {
  const hook = material.onBeforeCompile;
  return hook === DEFAULT_HOOK ? null : (hook as Hook);
}

function ownKeyFn(material: Material): (() => string) | null {
  return Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
    ? material.customProgramCacheKey.bind(material)
    : null;
}

function featureList(features: MaterialFeatures): { name: string; patch: ShaderPatch }[] {
  const out: { name: string; patch: ShaderPatch }[] = [];
  for (const name of PATCH_ORDER) {
    if (name === 'csm') continue;
    const patch = features[name];
    if (patch) out.push({ name, patch });
  }
  return out;
}

function compose(prior: readonly Hook[], patches: readonly ShaderPatch[], target: PatchTarget): Hook {
  return function composedHook(this: Material, shader, renderer) {
    for (const h of prior) h.call(this, shader, renderer);
    for (const p of patches) p.apply(shader, target, renderer);
  };
}

function shadowTwin<T extends MeshDepthMaterial | MeshDistanceMaterial>(
  twin: T,
  patches: readonly ShaderPatch[],
  target: PatchTarget,
): T {
  const key = `${target}|${patches.map((p) => p.key).join('|')}`;
  twin.onBeforeCompile = compose([], patches, target);
  twin.customProgramCacheKey = () => key;
  twin.needsUpdate = true;
  return twin;
}

/**
 * Compose CSM + P4 features into `material` (mutated in place and returned as
 * `color`) and build depth/distance twins when a feature deforms geometry.
 * Throws if the material was already patched (patch a fresh clone instead).
 */
export function patchMaterial<M extends Material>(material: M, features: MaterialFeatures): PatchedMaterialSet<M> {
  if (patched.has(material)) {
    throw new Error(`patchMaterial: material "${material.name || material.uuid}" is already patched; patch a clone`);
  }
  patched.add(material);

  // Capture what the material carried before anything is touched.
  const preHook = ownHook(material);
  const preKeyFn = ownKeyFn(material);
  const preHookSrc = preHook ? preHook.toString() : '';

  const prior: Hook[] = [];
  if (preHook) prior.push(preHook);

  const keys: string[] = [];
  const csm = features.csm ?? null;
  if (csm) {
    csm.setupMaterial(material); // overwrites onBeforeCompile with its uniform hook
    const csmHook = ownHook(material);
    if (csmHook && csmHook !== preHook) prior.push(csmHook);
    keys.push(`csm${csm.cascades}${csm.fade ? 'f' : ''}`);
  }

  const list = featureList(features);
  if (csm && features.env !== false) list.push({ name: 'env', patch: envPatchFor(features.env ?? {}) });
  for (const f of list) keys.push(`${f.name}:${f.patch.key}`);

  const colorPatches = list.filter((f) => f.patch.targets.includes('color')).map((f) => f.patch);
  const depthPatches = list.filter((f) => f.patch.targets.includes('depth')).map((f) => f.patch);
  const distancePatches = list.filter((f) => f.patch.targets.includes('distance')).map((f) => f.patch);

  material.onBeforeCompile = compose(prior, colorPatches, 'color');
  const featureKey = keys.join('|');
  material.customProgramCacheKey = preKeyFn
    ? () => `${preKeyFn()}|${featureKey}`
    : () => `${preHookSrc}|${featureKey}`;
  material.needsUpdate = true;
  (material as unknown as Record<symbol, PatchInfo>)[PATCH_INFO] = {
    features: [...(csm ? ['csm'] : []), ...list.map((f) => f.name)],
    key: featureKey,
  };

  // RGBADepthPacking per contract; r185 shadow maps read the depth attachment, so the packing is inert.
  const depth = depthPatches.length
    ? shadowTwin(new MeshDepthMaterial({ depthPacking: RGBADepthPacking }), depthPatches, 'depth')
    : null;
  const distance = distancePatches.length ? shadowTwin(new MeshDistanceMaterial(), distancePatches, 'distance') : null;

  return { color: material, depth, distance };
}

/** True once patchMaterial has run on this material. */
export function isPatched(material: Material): boolean {
  return patched.has(material);
}
