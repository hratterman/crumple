/**
 * Main-side helper worker: generates the render copy of the terrain off the
 * main thread (generateTerrain blocks for ~2–3 s) and TRANSFERS the arrays
 * back (zero-copy). Independent of the physics worker, which regenerates its
 * own copy from the same layout (groundHeightfield); main compares hashes.
 * P5: also runs the pure vegetation scatter on the fresh terrain (same
 * function the physics worker runs for tree colliders) and transfers it.
 */
import { buildWorldContent } from '../world/content';
import type { WorldContent } from '../world/content/types';
import { generateTerrain } from '../world/terrain';
import type { TerrainData, VegetationScatter, WorldLayout } from '../world/types';
import { scatterBuffers, scatterVegetation } from '../world/vegetation';

export interface TerrainJob {
  layout: WorldLayout;
}
export type TerrainJobResult =
  | { ok: true; terrain: TerrainData; ms: number; vegetation: VegetationScatter; vegetationMs: number; content: WorldContent; contentMs: number }
  | { ok: false; message: string };

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<TerrainJob>) => void) | null;
  postMessage(msg: TerrainJobResult, transfer: Transferable[]): void;
};

scope.onmessage = (ev) => {
  const t0 = performance.now();
  let terrain: TerrainData;
  let vegetation: VegetationScatter;
  let content: WorldContent;
  let ms: number;
  let t1: number;
  let contentMs: number;
  try {
    terrain = generateTerrain(ev.data.layout);
    t1 = performance.now();
    ms = t1 - t0;
    // Layout v6: the world content (render part too), then the scatter that keeps clear of it.
    content = buildWorldContent(ev.data.layout, terrain, { render: true });
    contentMs = performance.now() - t1;
    t1 = performance.now();
    vegetation = scatterVegetation(ev.data.layout, terrain, content);
  } catch (e) {
    scope.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }, []);
    return;
  }
  const buffers = new Set<ArrayBuffer>();
  for (const a of [
    terrain.heights,
    terrain.splat,
    terrain.material,
    ...terrain.roads.map((r) => r.stations),
    ...(terrain.covers ?? []).flatMap((c) => [c.heights, c.splat]),
  ]) {
    if (a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  }
  for (const b of scatterBuffers(vegetation)) buffers.add(b);
  scope.postMessage({ ok: true, terrain, ms, vegetation, vegetationMs: performance.now() - t1, content, contentMs }, [...buffers]);
};
