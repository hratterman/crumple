/**
 * World loading on the main side: the render copy of the terrain comes from
 * a helper worker (src/app/terrainWorker.ts) so the page keeps animating the
 * loading screen; if workers are unavailable it is generated inline after a
 * yield (the page then freezes for the generation time).
 */
import { generateTerrain, hashTerrain } from '../world/terrain';
import type { TerrainData, WorldLayout } from '../world/types';
import type { TerrainJob, TerrainJobResult } from './terrainWorker';

export interface LoadedTerrain {
  terrain: TerrainData;
  /** Generation wall time, ms (inside the worker when `worker`). */
  generateMs: number;
  worker: boolean;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** The helper worker could not run (no Worker support, load failure): fall back to inline generation. */
class WorkerUnavailable extends Error {}

function generateInWorker(layout: WorldLayout): Promise<{ terrain: TerrainData; ms: number }> {
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
      if (r.ok) resolve({ terrain: r.terrain, ms: r.ms });
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
 * Generates `layout`'s terrain off the main thread and re-verifies its hash
 * after the transfer (hashTerrain, ~30 ms). Rejects on a layout error.
 */
export async function loadTerrain(layout: WorldLayout): Promise<LoadedTerrain> {
  try {
    const { terrain, ms } = await generateInWorker(layout);
    const hash = hashTerrain(terrain) >>> 0;
    if (hash !== terrain.hash >>> 0) throw new Error(`terrain transfer corrupted (hash ${hash} vs ${terrain.hash})`);
    return { terrain, generateMs: ms, worker: true };
  } catch (e) {
    if (!(e instanceof WorkerUnavailable)) throw e;
    console.warn('[world] terrain worker unavailable, generating on the main thread:', e);
    await nextFrame();
    const t0 = performance.now();
    const terrain = generateTerrain(layout);
    return { terrain, generateMs: performance.now() - t0, worker: false };
  }
}
