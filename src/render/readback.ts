/**
 * Asynchronous render-target readback that leaves the GL state clean.
 *
 * three r185's `readRenderTargetPixelsAsync` keeps its PIXEL_PACK_BUFFER
 * bound while it waits for the fence, so every synchronous `readPixels`
 * issued meanwhile (tests, dev pages, other readbacks) fails with
 * INVALID_OPERATION and returns stale data. The function runs synchronously
 * up to its first await (the readPixels into the buffer), so unbinding right
 * after the call is safe: it binds the buffer again before reading it back.
 */
import type { RenderTarget, TypedArray, WebGLRenderer } from 'three';

export function readPixelsAsync<T extends TypedArray>(renderer: WebGLRenderer, target: RenderTarget, x: number, y: number, w: number, h: number, buffer: T): Promise<T> {
  const p = renderer.readRenderTargetPixelsAsync(target as Parameters<WebGLRenderer['readRenderTargetPixelsAsync']>[0], x, y, w, h, buffer) as Promise<T>;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (typeof gl.bindBuffer === 'function' && gl.PIXEL_PACK_BUFFER !== undefined) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  return p;
}
