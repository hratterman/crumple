/**
 * Shadow-pass LOD switching (U6). Vehicle skins and wheels draw dedicated
 * caster meshes in the shadow pass (LOD1 into cascade 0, LOD2 into cascades
 * ≥ 1) and their colour meshes in every other pass. three has no per-pass
 * visibility, so this wraps `renderer.shadowMap.render` once per renderer
 * (visibility of the caster meshes flips on around it) and each CSM
 * cascade light's `shadow.updateMatrices` (called right before that
 * cascade renders: the clients pick the caster LOD for it). The colour
 * pass's render list is built before the shadow pass inside
 * renderer.render, so toggling there never leaks into the colour draws.
 * Composes with lighting.ts setNearCasters (which wraps the same hooks to
 * toggle a whole subtree per cascade).
 */
import type { LightShadow, WebGLRenderer } from 'three';

import type { LightingStack } from '../types';

export interface ShadowLodClient {
  /** Shadow pass starts: show the caster meshes (default cascade 0 choice). */
  shadowBegin(): void;
  /** CSM cascade `index` is about to render. */
  shadowCascade(index: number): void;
  /** Shadow pass over: colour-pass visibility back. */
  shadowEnd(): void;
}

interface Hook {
  clients: Set<ShadowLodClient>;
  stacks: Set<LightingStack>;
  wrapped: WeakSet<LightShadow>;
}

const hooks = new WeakMap<object, Hook>();

function wrapCascades(h: Hook): void {
  for (const stack of h.stacks) {
    const lights = stack.csm?.lights;
    if (!lights) continue;
    for (let i = 0; i < lights.length; i++) {
      const shadow = lights[i]!.shadow;
      if (h.wrapped.has(shadow)) continue;
      h.wrapped.add(shadow);
      const orig = shadow.updateMatrices;
      const index = i;
      shadow.updateMatrices = function (this: LightShadow, light) {
        for (const c of h.clients) c.shadowCascade(index);
        return orig.call(this, light);
      };
    }
  }
}

/**
 * Registers a client; returns the unregister function. No-op (returns a
 * no-op) when the renderer has no shadow map (headless tests).
 */
export function attachShadowLod(renderer: WebGLRenderer | null | undefined, lighting: LightingStack, client: ShadowLodClient): () => void {
  const sm = renderer?.shadowMap as (WebGLRenderer['shadowMap'] & { render?: unknown }) | undefined;
  if (!renderer || !sm || typeof sm.render !== 'function') return () => {};
  let h = hooks.get(renderer);
  if (!h) {
    const hook: Hook = { clients: new Set(), stacks: new Set(), wrapped: new WeakSet() };
    h = hook;
    hooks.set(renderer, hook);
    const orig = sm.render as (...args: unknown[]) => void;
    sm.render = function (this: unknown, ...args: unknown[]) {
      wrapCascades(hook);
      for (const c of hook.clients) c.shadowBegin();
      try {
        orig.apply(this, args);
      } finally {
        for (const c of hook.clients) c.shadowEnd();
      }
    } as typeof sm.render;
  }
  h.clients.add(client);
  h.stacks.add(lighting);
  const hook = h;
  return () => {
    hook.clients.delete(client);
  };
}

/** True when shadow LOD switching can run for this renderer (caster meshes are worth building). */
export function shadowLodAvailable(renderer: WebGLRenderer | null | undefined): boolean {
  const sm = renderer?.shadowMap as { render?: unknown } | undefined;
  return !!sm && typeof sm.render === 'function';
}
