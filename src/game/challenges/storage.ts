/**
 * Personal bests: localStorage['crumple.challenges.v1'] (ChallengeStore v1).
 * Every access is wrapped: a private window / quota error / blocked storage
 * never breaks a run (nothing is saved, the session keeps its in-memory copy).
 */
import { beats, betterMedal } from './medals';
import { CHALLENGE_STORAGE_KEY, type ChallengeStore, type MedalId, type PbRecord, type ScoringDef } from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function emptyStore(): ChallengeStore {
  return { version: 1, records: {} };
}

/** Reads + validates the store (malformed records dropped; anything unreadable → empty). */
export function loadStore(storage: StorageLike | null = defaultStorage()): ChallengeStore {
  if (!storage) return emptyStore();
  try {
    const raw = storage.getItem(CHALLENGE_STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<ChallengeStore> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object' || parsed.records === null) return emptyStore();
    const out = emptyStore();
    for (const [id, r] of Object.entries(parsed.records)) {
      if (!r || typeof r !== 'object' || typeof r.best !== 'number' || !Number.isFinite(r.best)) continue;
      out.records[id] = {
        best: r.best,
        medal: (r.medal ?? 'none') as MedalId,
        bestMedal: (r.bestMedal ?? r.medal ?? 'none') as MedalId,
        at: typeof r.at === 'string' ? r.at : '',
        vehicle: typeof r.vehicle === 'string' ? r.vehicle : '',
        build: typeof r.build === 'string' ? r.build : '',
        attempts: typeof r.attempts === 'number' ? r.attempts : 1,
        ...(typeof r.ghost === 'string' ? { ghost: r.ghost } : {}),
        ...(typeof r.inputs === 'string' ? { inputs: r.inputs } : {}),
      };
    }
    return out;
  } catch {
    return emptyStore();
  }
}

/** Writes the store; on a quota error retries once without ghosts / inputs of the OTHER challenges. Returns success. */
export function saveStore(store: ChallengeStore, storage: StorageLike | null = defaultStorage(), keepGhostOf?: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CHALLENGE_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    try {
      const slim: ChallengeStore = { version: 1, records: {} };
      for (const [id, r] of Object.entries(store.records)) {
        if (id === keepGhostOf) slim.records[id] = r;
        else {
          const { ghost: _g, inputs: _i, ...rest } = r;
          slim.records[id] = rest;
        }
      }
      storage.setItem(CHALLENGE_STORAGE_KEY, JSON.stringify(slim));
      store.records = slim.records;
      return true;
    } catch {
      return false;
    }
  }
}

export interface RunRecordInput {
  id: string;
  score: number;
  medal: MedalId;
  completed: boolean;
  better: ScoringDef['better'];
  vehicle: string;
  build: string;
  at: string;
  ghost?: string;
  inputs?: string;
}

/**
 * Applies a finished run to the store (in place): counts the attempt, keeps
 * the best medal ever, replaces the PB (score, medal, ghost, inputs) when a
 * completed run beats it. Returns { previous best, isBest }.
 */
export function recordRun(store: ChallengeStore, run: RunRecordInput): { previousBest: number | null; isBest: boolean } {
  const prev = store.records[run.id] ?? null;
  const previousBest = prev ? prev.best : null;
  if (!run.completed || !Number.isFinite(run.score)) {
    if (prev) prev.attempts++;
    return { previousBest, isBest: false };
  }
  const isBest = !prev || beats(run.score, prev.best, run.better);
  if (isBest) {
    const rec: PbRecord = {
      best: run.score,
      medal: run.medal,
      bestMedal: betterMedal(run.medal, prev ? prev.bestMedal : 'none'),
      at: run.at,
      vehicle: run.vehicle,
      build: run.build,
      attempts: (prev ? prev.attempts : 0) + 1,
      ...(run.ghost ? { ghost: run.ghost } : {}),
      ...(run.inputs ? { inputs: run.inputs } : {}),
    };
    store.records[run.id] = rec;
  } else if (prev) {
    prev.attempts++;
    prev.bestMedal = betterMedal(run.medal, prev.bestMedal);
  }
  return { previousBest, isBest };
}
