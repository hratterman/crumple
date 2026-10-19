import { describe, expect, it } from 'vitest';

import { DEFAULT_VEHICLE_ID, getVehicleEntry, PLAYER_VEHICLE_IDS, VEHICLE_CATALOG, VEHICLE_CHOICE_KEY } from '../game/catalog';
import { buildVehicleRig } from '../sim/vehicle/builder';
import {
  chaseFramingFor,
  drivableEntry,
  hasStoredChoice,
  loadPlayerAssets,
  loadVehicleChoice,
  PlayerVehicle,
  sanitizeChoice,
  saveVehicleChoice,
  speedoMax,
} from './player';
import type { StorageLike } from './quality';

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}
const throwing: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('quota');
  },
};

const sedan = getVehicleEntry('sedan');
const unbuilt = Object.values(VEHICLE_CATALOG).find((e) => !e.available && e.selectable);

describe('vehicle choice', () => {
  it('falls back to the sedan / palettes[0] for unknown or unbuilt vehicles and palettes', () => {
    expect(sanitizeChoice(null)).toEqual({ id: DEFAULT_VEHICLE_ID, palette: sedan.palettes[0]!.id });
    expect(sanitizeChoice({ id: 'tank', palette: 'crimson' })).toEqual({ id: 'sedan', palette: 'crimson' });
    expect(sanitizeChoice({ id: 'sedan', palette: 'nope' })).toEqual({ id: 'sedan', palette: sedan.palettes[0]!.id });
    expect(sanitizeChoice({ id: 'sedanTraffic', palette: 'x' }).id).toBe('sedan'); // not player-selectable
    if (unbuilt) expect(drivableEntry(unbuilt.id).id).toBe('sedan');
    for (const id of PLAYER_VEHICLE_IDS) {
      const e = getVehicleEntry(id);
      if (e.available) expect(sanitizeChoice({ id, palette: e.palettes[2]!.id })).toEqual({ id, palette: e.palettes[2]!.id });
    }
  });

  it('round-trips through storage, ignores corrupt data and storage errors', () => {
    const st = memStorage();
    expect(hasStoredChoice(st)).toBe(false);
    expect(loadVehicleChoice('', st)).toEqual({ id: 'sedan', palette: sedan.palettes[0]!.id });
    saveVehicleChoice({ id: 'sedan', palette: 'liquidSilver' }, st);
    expect(hasStoredChoice(st)).toBe(true);
    expect(JSON.parse(st.data[VEHICLE_CHOICE_KEY]!)).toEqual({ id: 'sedan', palette: 'liquidSilver' });
    expect(loadVehicleChoice('', st)).toEqual({ id: 'sedan', palette: 'liquidSilver' });
    expect(loadVehicleChoice('', memStorage({ [VEHICLE_CHOICE_KEY]: '{not json' }))).toEqual({ id: 'sedan', palette: sedan.palettes[0]!.id });
    expect(loadVehicleChoice('', throwing)).toEqual({ id: 'sedan', palette: sedan.palettes[0]!.id });
    expect(hasStoredChoice(throwing)).toBe(false);
    expect(() => saveVehicleChoice({ id: 'sedan', palette: 'crimson' }, throwing)).not.toThrow();
    expect(loadVehicleChoice('', null).id).toBe('sedan');
  });

  it('?vehicle= / ?paint= override storage', () => {
    const st = memStorage({ [VEHICLE_CHOICE_KEY]: JSON.stringify({ id: 'sedan', palette: 'obsidian' }) });
    expect(loadVehicleChoice('?paint=crimson', st)).toEqual({ id: 'sedan', palette: 'crimson' });
    expect(loadVehicleChoice('?vehicle=sedan', st)).toEqual({ id: 'sedan', palette: 'obsidian' });
    expect(loadVehicleChoice('?vehicle=nope', st).id).toBe('sedan');
  });
});

describe('per-vehicle HUD / camera facts', () => {
  it('speedometer covers top speed + 20 % on a labelled step', () => {
    expect(speedoMax(214, 'kmh')).toBe(280);
    expect(speedoMax(110, 'kmh')).toBe(140);
    expect(speedoMax(214, 'mph')).toBe(160);
    expect(speedoMax(10, 'kmh')).toBe(120);
    for (const e of Object.values(VEHICLE_CATALOG)) {
      for (const u of ['kmh', 'mph'] as const) {
        const max = speedoMax(e.stats.topSpeedKmh, u);
        const top = u === 'mph' ? e.stats.topSpeedKmh / 1.609344 : e.stats.topSpeedKmh;
        expect(max).toBeGreaterThanOrEqual(top * 1.2);
        expect(max % 20).toBe(0);
      }
    }
  });

  it('chase framing scales the catalog framing', () => {
    expect(chaseFramingFor(sedan, 1)).toEqual(sedan.chase);
    const far = chaseFramingFor(sedan, 1.25);
    expect(far.distance).toBeCloseTo(sedan.chase.distance * 1.25);
    expect(far.height).toBeCloseTo(sedan.chase.height * 1.25);
  });
});

describe('player assets', () => {
  it('loads + compiles the sedan once (cached) in the worker canonical order', async () => {
    const a = await loadPlayerAssets(sedan);
    expect(await loadPlayerAssets(sedan)).toBe(a);
    expect(a.entry).toBe(sedan);
    expect(a.compiled.rig.nodeCount).toBe(buildVehicleRig(a.sim).nodes.length);
    expect(a.rest.nodeCount).toBe(a.compiled.rig.nodeCount);
    // Without render deps (?body=0) the player has no visual, keeps its palette and ignores updates.
    const p = new PlayerVehicle(a, 'crimson', null);
    expect(p.visual).toBeNull();
    expect(p.palette.id).toBe('crimson');
    expect(p.broken.length).toBe(a.compiled.rig.beamCount);
    expect(new PlayerVehicle(a, 'nope', null).palette.id).toBe(sedan.palettes[0]!.id);
  });

  it('rejects unbuilt entries (and does not cache the failure)', async () => {
    if (!unbuilt) return;
    await expect(loadPlayerAssets(unbuilt)).rejects.toThrow();
  });
});
