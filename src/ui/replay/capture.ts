/**
 * Photo capture (P7 R2): renders ONE frame at `scale` × the CSS size
 * (supersampled through the whole post stack: the composer buffers follow
 * the renderer's pixel ratio), copies it (cropped to the photo aspect) into
 * a 2D canvas in the same task the frame was drawn in (no
 * preserveDrawingBuffer needed), restores the renderer size and encodes a
 * PNG. Output is capped at MAX_PIXELS and the GPU's renderbuffer limit.
 */
import type { WebGLRenderer } from 'three';
import type { PostStack } from '../../render/types';
import { fitAspect } from './format';

export const MAX_PIXELS = 3840 * 2160 * 1.05;

export interface CaptureDeps {
  renderer: WebGLRenderer;
  post: PostStack;
  /** CSS size of the view. */
  width(): number;
  height(): number;
  /** Draws one full frame now (world + post) into the canvas. */
  renderFrame(): void;
  /** Called after each resize (the capture size, then the restored size): resolution-dependent settings. */
  resized?(): void;
}

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
}

/** Pixel ratio for a capture at `scale` × CSS px, within the size caps (pure). */
export function captureRatio(cssW: number, cssH: number, scale: number, maxDim: number): number {
  let r = Math.max(0.25, scale);
  const px = cssW * cssH * r * r;
  if (px > MAX_PIXELS) r *= Math.sqrt(MAX_PIXELS / px);
  const big = Math.max(cssW, cssH) * r;
  if (big > maxDim) r *= maxDim / big;
  return r;
}

export function capturePhoto(deps: CaptureDeps, scale: number, aspect: number | null): Promise<CaptureResult> {
  const { renderer, post } = deps;
  const w = deps.width();
  const hgt = deps.height();
  const gl = renderer.getContext();
  const maxDim = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, 8192);
  const prevRatio = renderer.getPixelRatio();
  const ratio = captureRatio(w, hgt, scale, maxDim);
  const out = document.createElement('canvas');
  try {
    renderer.setPixelRatio(ratio);
    post.setSize(w, hgt);
    deps.resized?.();
    deps.renderFrame();
    const src = renderer.domElement;
    const r = fitAspect(src.width, src.height, aspect);
    out.width = r.w;
    out.height = r.h;
    const c2d = out.getContext('2d');
    if (!c2d) throw new Error('2D canvas unavailable');
    c2d.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  } finally {
    renderer.setPixelRatio(prevRatio);
    post.setSize(w, hgt);
    deps.resized?.();
  }
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => (blob ? resolve({ blob, width: out.width, height: out.height }) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}
