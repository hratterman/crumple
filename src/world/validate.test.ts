import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, WORLD_LAYOUTS } from './layout';
import { generateTerrain } from './terrain';
import { WorldLayoutError, type WorldLayout } from './types';
import { validateLayout } from './validate';

const clone = (): WorldLayout => JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as WorldLayout;
type Mut = { -readonly [K in keyof WorldLayout]: any };

function rejects(mutate: (l: Mut) => void, match: RegExp): void {
  const l = clone() as Mut;
  mutate(l);
  let err: unknown = null;
  try {
    validateLayout(l as WorldLayout);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorldLayoutError);
  expect((err as Error).message).toMatch(match);
}

describe('validateLayout', () => {
  it('accepts every registered layout', () => {
    for (const l of Object.values(WORLD_LAYOUTS)) expect(() => validateLayout(l)).not.toThrow();
    expect(WORLD_LAYOUTS[DEFAULT_LAYOUT.id]).toBe(DEFAULT_LAYOUT);
  });

  it('rejects malformed layouts with a pointed message', () => {
    rejects((l) => (l.size = 1000), /multiple of 64/);
    rejects((l) => (l.terrain.spacing = 0), /spacing/);
    rejects((l) => (l.terrain.minHeight = 500), /minHeight/);
    rejects((l) => (l.seed = 1.5), /seed/);
    rejects((l) => (l.roads[1].id = l.roads[0].id), /duplicate id/);
    rejects((l) => (l.roads[0].kind = 'freeway'), /unknown road kind/);
    rejects((l) => (l.roads[0].material = 9), /MaterialId/);
    rejects((l) => (l.roads[2].points[0] = [900, null, 0]), /outside the map/);
    rejects((l) => (l.roads[2].points[1] = l.roads[2].points[0]), /duplicate of the previous point/);
    rejects((l) => (l.roads[0].width = -1), /width/);
    rejects((l) => (l.junctions[0].roads = ['highway', 'nope']), /unknown road 'nope'/);
    rejects((l) => (l.junctions[0].roads = ['highway']), /needs >= 2 roads/);
    rejects((l) => (l.spawnPoints[1].road.id = 'nope'), /unknown road/);
    rejects((l) => (l.zones[3].shape = { type: 'rect', center: [0, 0], halfX: 10, halfZ: 10, blend: 5 }), /lake shape/);
    rejects((l) => (l.zones[2].params.peaks = []), /peak/);
    rejects((l) => (l.zones[0].params.detail.octaves = 0), /octaves/);
    rejects((l) => (l.zones[0].shape.axis = [1, 1]), /unit vector/);
    rejects((l) => (l.pads[0].height = Number.NaN), /finite/);
  });

  it('checks prop placement shapes (P5)', () => {
    const cone = { id: 'c', prop: 'cone', pos: [10, null, 10] };
    rejects((l) => (l.props = [cone, { ...cone }]), /props: duplicate id/);
    rejects((l) => (l.props = [{ ...cone, prop: '' }]), /catalog key/);
    rejects((l) => (l.props = [{ ...cone, pos: [900, null, 0] }]), /outside the map/);
    rejects((l) => (l.props = [{ ...cone, facing: [1, 1] }]), /unit vector/);
    rejects((l) => (l.props = [{ ...cone, stack: 0 }]), /stack/);
    rejects((l) => (l.props = [{ ...cone, row: { count: 2.5, step: [1, 0] } }]), /row.count/);
    rejects((l) => (l.props = [{ ...cone, row: { count: 400, step: [1, 0] } }]), /row.count/);
    rejects((l) => (l.props = [{ ...cone, row: { count: 200, step: [10, 0] } }]), /last row copy/);
    rejects((l) => (l.props = [{ ...cone, padId: 'nope' }]), /unknown pad/);
    const ok = clone() as Mut;
    ok.props = [{ ...cone, facing: [0.6, -0.8], stack: 1, row: { count: 3, step: [1, 0] }, padId: ok.pads[0].id }];
    expect(() => validateLayout(ok as WorldLayout)).not.toThrow();
  });

  it('generateTerrain validates (static and junction geometry)', () => {
    const bad = clone() as Mut;
    bad.size = 1000;
    expect(() => generateTerrain(bad as WorldLayout)).toThrow(WorldLayoutError);

    // Small map whose junction misses one of its roads by 6 m.
    const small: WorldLayout = {
      ...clone(),
      size: 128,
      zones: [],
      pads: [],
      roads: [
        { id: 'a', name: 'a', kind: 'country', closed: false, points: [[-50, 10, 0], [50, 10, 0]], width: 7, lanes: 1, shoulder: 1, material: 0, markings: 'center' },
        { id: 'b', name: 'b', kind: 'dirt', closed: false, points: [[0, null, 6], [0, null, 50]], width: 4, lanes: 1, shoulder: 1, material: 2, markings: 'none' },
      ],
      junctions: [{ id: 'j', pos: [0, 0], roads: ['a', 'b'] }],
      spawnPoints: [],
    };
    expect(() => generateTerrain(small)).toThrow(/junction 'j': road 'b' passes 6\.00 m/);
    small.junctions = [{ id: 'j', pos: [0, 6], roads: ['b', 'a'] }];
    expect(() => generateTerrain(small)).toThrow(/road 'a'/);
  });
});
