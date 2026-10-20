/**
 * Re-simulation of a ReplayFile (P7): the exact order of protocol/replay.ts
 * on a fresh WorkerHost (no pacing, no snapshots needed). Worker-side helper
 * for tests, tools and P8 ghost runs; never imported by main.
 */
import { Action, ACTION_NAMES, type ActionState, type WorkerToMain } from '../../protocol/messages';
import type { ReplayFile } from '../../protocol/replay';
import { WorkerHost, type TerrainDeps } from '../worker';
import { hashSimState } from './hash';

export interface ResimResult {
  host: WorkerHost;
  /** hashSimState at file.toTick. */
  hash: number;
  /** Non-snapshot messages the host posted (errors the live run also got, terrainReady…). */
  messages: WorkerToMain[];
}

/**
 * Re-simulates `file` up to `toTick` (default file.toTick). `onTick(host)`
 * runs after every step (tests). Snapshots the host posts are returned to
 * its pool at once.
 */
export function resimulate(file: ReplayFile, opts: { terrainDeps?: TerrainDeps; toTick?: number; onTick?: (host: WorkerHost) => void } = {}): ResimResult {
  if (file.start.kind !== 'boot') throw new Error(`resimulate: start '${file.start.kind}' not supported in P7`);
  const messages: WorkerToMain[] = [];
  let hostRef: WorkerHost | null = null;
  const post = (m: WorkerToMain): void => {
    if (m.type === 'snapshot') hostRef?.handle({ type: 'returnBuffer', buffer: m.buffer });
    else messages.push(m);
  };
  const host = new WorkerHost(post, { now: () => 0, schedule: () => {} }, opts.terrainDeps);
  hostRef = host;
  const init = file.init;
  host.handle({ type: 'init', seed: init.seed, gravity: init.gravity, snapshotHz: init.snapshotHz, debugStrains: init.debugStrains, capacity: init.capacity });
  const eng = host.engine!;
  const toTick = opts.toTick ?? file.toTick;
  const stepTo = (tick: number): void => {
    while (eng.tick < tick) {
      eng.step();
      // Events are irrelevant to the state; keep the pending rings from overflowing.
      if ((eng.tick & 1023) === 0) eng.events.clear();
      opts.onTick?.(host);
    }
  };
  const inp = file.inputs;
  const one: Partial<ActionState> = {};
  let ii = 0;
  const applyInputsUntil = (limit: number): void => {
    for (; ii < limit && ii < inp.count; ii++) {
      const t = inp.tick[ii]!;
      if (t > toTick) return;
      stepTo(t);
      const obj = eng.arena.get(inp.objectId[ii]!);
      if (!obj) continue;
      const a = inp.action[ii]!;
      if (a > Action.gearSelect) continue;
      // Through the worker so the re-simulated run logs identically (exportable again).
      for (const k of ACTION_NAMES) delete one[k];
      one[ACTION_NAMES[a]!] = inp.value[ii]!;
      host.handle({ type: 'input', objectId: inp.objectId[ii]!, actions: one });
    }
  };
  for (const c of file.commands) {
    if (c.tick > toTick) break;
    applyInputsUntil(c.input);
    stepTo(c.tick);
    host.handle(c.cmd);
  }
  applyInputsUntil(inp.count);
  stepTo(toTick);
  eng.events.clear();
  return { host, hash: hashSimState(eng), messages };
}
