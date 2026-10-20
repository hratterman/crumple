/**
 * World loading on the main side: the render copy of the terrain comes from
 * a helper worker (src/app/terrainWorker.ts) so the page keeps animating the
 * loading screen; if workers are unavailable it is generated inline after a
 * yield (the page then freezes for the generation time).
 */
import type { WorldContent } from '../world/content/types';
import type { TerrainData, VegetationScatter, WorldLayout } from '../world/types';
import type { TerrainJob, TerrainJobResult } from './terrainWorker';

export interface LoadedTerrain {
  terrain: TerrainData;
  /** Generation wall time, ms (inside the worker when `worker`). */
  generateMs: number;
  worker: boolean;
  /** P5: scatterVegetation(layout, terrain), computed next to the terrain. */
  vegetation: VegetationScatter;
  vegetationMs: number;
  /** Layout v6: buildWorldContent(layout, terrain, {render: true}), computed before the scatter. */
  content: WorldContent;
  contentMs: number;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** The helper worker could not run (no Worker support, load failure): fall back to inline generation. */
class WorkerUnavailable extends Error {}

function generateInWorker(
  layout: WorldLayout,
): Promise<{ terrain: TerrainData; ms: number; vegetation: VegetationScatter; vegetationMs: number; content: WorldContent; contentMs: number }> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new WorkerUnavailable(String(e)));
      return;
    }
    worker.onmessage = (ev: MessageEvent<TerrainJobResult>) => {
      worker.terminate();
      const r = ev.data;
      if (r.ok) resolve({ terrain: r.terrain, ms: r.ms, vegetation: r.vegetation, vegetationMs: r.vegetationMs, content: r.content, contentMs: r.contentMs });
      else reject(new Error(r.message));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      worker.terminate();
      reject(new WorkerUnavailable(`terrain worker: ${ev.message || 'failed to load'}`));
    };
    worker.postMessage({ layout } satisfies TerrainJob);
  });
}

/**
 * Generates `layout`'s terrain off the main thread. Rejects on a layout
 * error. No main-thread re-hash after the transfer (it blocked main for
 * ~30–100 ms): the worker's hash travels with the data and main.ts checks
 * it against the physics worker's own generation (terrainReady).
 * The generator itself is only loaded on main for the no-worker fallback.
 */
export async function loadTerrain(layout: WorldLayout): Promise<LoadedTerrain> {
  try {
    const { terrain, ms, vegetation, vegetationMs, content, contentMs } = await generateInWorker(layout);
    return { terrain, generateMs: ms, worker: true, vegetation, vegetationMs, content, contentMs };
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e;
    console.warn('[world] terrain worker unavailable, generating on the main thread:', e);
    const { generateTerrain } = await import('../world/terrain');
    const { scatterVegetation } = await import('../world/vegetation');
    const { buildWorldContent } = await import('../world/content');
    await nextFrame();
    const t0 = performance.now();
    const terrain = generateTerrain(layout);
    const t1 = performance.now();
    const content = buildWorldContent(layout, terrain, { render: true });
    const t2 = performance.now();
    const vegetation = scatterVegetation(layout, terrain, content);
    return { terrain, generateMs: t1 - t0, worker: false, vegetation, vegetationMs: performance.now() - t2, content, contentMs: t2 - t1 };
  }
}
