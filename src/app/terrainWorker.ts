/**
 * Main-side helper worker: generates the render copy of the terrain off the
 * main thread (generateTerrain blocks for ~2–3 s) and TRANSFERS the arrays
 * back (zero-copy). Independent of the physics worker, which regenerates its
 * own copy from the same layout (groundHeightfield); main compares hashes.
 */
import { generateTerrain } from '../world/terrain';
import type { TerrainData, WorldLayout } from '../world/types';

export interface TerrainJob {
  layout: WorldLayout;
}
export type TerrainJobResult = { ok: true; terrain: TerrainData; ms: number } | { ok: false; message: string };

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<TerrainJob>) => void) | null;
  postMessage(msg: TerrainJobResult, transfer: Transferable[]): void;
};

scope.onmessage = (ev) => {
  const t0 = performance.now();
  let terrain: TerrainData;
  try {
    terrain = generateTerrain(ev.data.layout);
  } catch (e) {
    scope.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }, []);
    return;
  }
  const buffers = new Set<ArrayBuffer>();
  for (const a of [terrain.heights, terrain.splat, terrain.material, ...terrain.roads.map((r) => r.stations)]) {
    if (a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  }
  scope.postMessage({ ok: true, terrain, ms: performance.now() - t0 }, [...buffers]);
};
