/**
 * MILLBROOK (layout v6): the town grows from the ring + Main St into a real
 * small town — residential lanes off Mill Road (Birch Lane north, Cedar Lane
 * south) and Park Street across Main St south of the ring, every street with
 * raised sidewalks and kerbs. Buildings, lots, furniture and signals are
 * generated from these streets by src/world/content/town.ts.
 */
import { MaterialId } from '../../protocol/messages';
import type { RegionData } from './types';

export const TOWN_SIDEWALK = { width: 3.6, kerb: 0.14 } as const;
const STREET = { kind: 'street' as const, closed: false, width: 7, lanes: 1, shoulder: 0.5, material: MaterialId.asphalt, markings: 'center' as const, sidewalk: TOWN_SIDEWALK, wear: 'worn' as const };

export const TOWN: RegionData = {
  roads: [
    {
      ...STREET,
      id: 'birchLane',
      name: 'Birch Lane',
      points: [
        [30, 10.5, 336],
        [30, 10.5, 300],
        [32, 10.5, 262],
        [36, 10.5, 226],
      ],
    },
    {
      ...STREET,
      id: 'cedarLane',
      name: 'Cedar Lane',
      points: [
        [30, 10.5, 336],
        [29, 10.5, 380],
        [27, 10.5, 420],
        [30, 10.5, 458],
      ],
    },
    {
      ...STREET,
      id: 'parkStreetE',
      name: 'Park Street',
      points: [
        [150, 10.5, 440],
        [200, 10.5, 440],
        [252, 10.5, 442],
      ],
    },
    {
      ...STREET,
      id: 'parkStreetW',
      name: 'Park Street',
      points: [
        [150, 10.5, 440],
        [100, 10.5, 440],
        [58, 10.5, 438],
      ],
    },
  ],
  junctions: [
    { id: 'birchCross', pos: [30, 336], roads: ['millRoad', 'birchLane', 'cedarLane'], control: 'stop' },
    { id: 'parkCross', pos: [150, 440], roads: ['mainStreet', 'parkStreetE', 'parkStreetW'], control: 'allStop' },
  ],
};
