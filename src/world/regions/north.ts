/**
 * NORTH (layout v6): North Road leaves the highway's north crest, bores
 * through the Northgate ridge in a tunnel and drops to the north valley;
 * North Valley Road runs west to the rally finish and east to the Northgate
 * quarry + industrial yard (benched pit, haul road). The radio mast and the
 * Northgate lookout sit on the ridge's east shoulder.
 */
import { MaterialId } from '../../protocol/messages';
import type { RegionData } from './types';

/** Highway north crest centreline where North Road leaves it (resolved spline probe). */
const HWY_NORTH: readonly [number, number] = [329.99, -585.0];
export const NORTH_FORK: readonly [number, number] = [330, -1004];
export const QUARRY = { floor: [690, -1040] as const, mast: [520, -820] as const } as const;

export const NORTH: RegionData = {
  pads: [
    // Quarry: yard at the valley floor, the pit floor 9 m below it, three benches cut into the hill behind.
    { id: 'quarryYard', purpose: 'yard', shape: { type: 'rect', center: [600, -1040], halfX: 62, halfZ: 46, blend: 14 }, height: null, material: MaterialId.gravel },
    { id: 'quarryPit', purpose: 'pit', shape: { type: 'rect', center: [740, -1050], halfX: 70, halfZ: 52, blend: 4 }, height: 7.5, material: MaterialId.gravel },
    { id: 'quarryBench1', purpose: 'pit', shape: { type: 'rect', center: [742, -982], halfX: 88, halfZ: 13, blend: 3 }, height: 15, material: MaterialId.rock },
    { id: 'quarryBench2', purpose: 'pit', shape: { type: 'rect', center: [744, -958], halfX: 96, halfZ: 9, blend: 3 }, height: 25, material: MaterialId.rock },
    { id: 'northLookout', purpose: 'lookout', shape: { type: 'circle', center: [QUARRY.mast[0] - 40, QUARRY.mast[1] + 6], radius: 18, blend: 14 }, height: null, material: MaterialId.gravel },
  ],
  roads: [
    {
      id: 'northRoad',
      name: 'North Road',
      kind: 'country',
      closed: false,
      // Highway crest (38.6 m) → south portal → Northgate Tunnel → north portal → valley.
      points: [
        [HWY_NORTH[0], 38.6, HWY_NORTH[1]],
        [332, 39.6, -620],
        [338, 41.4, -668],
        [344, 42.0, -720],
        [348, 37.6, -800],
        [346, 33.0, -880],
        [340, 29.0, -930],
        [334, 25.4, -972],
        [NORTH_FORK[0], 22.3, NORTH_FORK[1]],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      material: MaterialId.asphalt,
      markings: 'center',
      structures: [{ id: 'northgateTunnel', kind: 'tunnel', from: [342, -700], to: [344, -900] }],
    },
    {
      id: 'northValley',
      name: 'North Valley Road',
      kind: 'country',
      closed: false,
      points: [
        [-100, null, -1000],
        [-20, null, -1012],
        [80, null, -1006],
        [200, null, -1010],
        [NORTH_FORK[0], null, NORTH_FORK[1]],
        [420, null, -1012],
        [500, null, -1030],
        [560, null, -1040],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      bank: 0.04,
      material: MaterialId.asphalt,
      markings: 'center',
      wear: 'worn',
    },
    {
      id: 'quarryRoad',
      name: 'Quarry Haul Road',
      kind: 'dirt',
      closed: false,
      // Yard → down the ramp onto the pit floor (haul road, 8 m wide).
      points: [
        [640, null, -1060],
        [668, null, -1080],
        [700, null, -1082],
        [736, null, -1060],
      ],
      width: 8,
      lanes: 1,
      shoulder: 1,
      material: MaterialId.gravel,
      markings: 'none',
    },
  ],
  junctions: [
    { id: 'hwyNorthGate', pos: [HWY_NORTH[0], HWY_NORTH[1]], roads: ['highway', 'northRoad'] },
    { id: 'northFork', pos: [NORTH_FORK[0], NORTH_FORK[1]], roads: ['northValley', 'northRoad'], control: 'stop' },
    { id: 'rallyFinish', pos: [-100, -1000], roads: ['northValley', 'rallyStage'] },
  ],
  spawns: [
    { id: 'tunnel', name: 'Northgate Tunnel', road: { id: 'northRoad', s: 60, d: 1.9 }, area: 'northgateTunnel' },
    { id: 'rallyFinish', name: 'Rally Stage Finish', road: { id: 'northValley', s: 30, d: 1.9 }, area: 'rallyStage' },
    { id: 'quarry', name: 'Northgate Quarry', pos: [600, -1040], yaw: -Math.PI / 2, area: 'quarry' },
    { id: 'northLookout', name: 'Northgate Lookout', pos: [QUARRY.mast[0] - 40, QUARRY.mast[1] + 6], yaw: Math.PI, area: 'radioMast' },
  ],
  areas: [
    { id: 'northgateTunnel', name: 'Northgate Tunnel', kind: 'tunnel', bounds: { type: 'rect', center: [342, -800], halfX: 40, halfZ: 140, blend: 0 }, spawn: 'tunnel' },
    { id: 'quarry', name: 'Northgate Quarry', kind: 'quarry', bounds: { type: 'rect', center: [680, -1020], halfX: 150, halfZ: 90, blend: 0 }, spawn: 'quarry' },
    { id: 'radioMast', name: 'Northgate Mast', kind: 'landmark', bounds: { type: 'circle', center: QUARRY.mast, radius: 70, blend: 0 }, spawn: 'northLookout' },
  ],
  pois: [
    { id: 'quarry.entry', area: 'quarry', kind: 'start', name: 'Quarry Gate', pos: [565, null, -1040], heading: [1, 0], width: 10 },
    { id: 'quarry.floor', area: 'quarry', kind: 'target', name: 'Pit Floor', pos: [740, null, -1050], radius: 40 },
    { id: 'quarry.course', area: 'quarry', kind: 'start', name: 'Destruction Course', pos: [700, null, -1030], heading: [1, 0], width: 12 },
    { id: 'quarry.crane', area: 'quarry', kind: 'landmark', name: 'Gantry Crane', pos: [610, null, -1068] },
    { id: 'quarry.containerStack', area: 'quarry', kind: 'target', name: 'Container Stack', pos: [575, null, -1070], radius: 10 },
    { id: 'quarry.wreckYard', area: 'quarry', kind: 'target', name: 'Wreck Yard', pos: [630, null, -1010], radius: 16 },
    { id: 'delivery.quarry', area: 'quarry', kind: 'delivery', name: 'Quarry Weighbridge', pos: [580, null, -1020], radius: 10 },
    { id: 'landmark.radioMast', area: 'radioMast', kind: 'landmark', name: 'Northgate Radio Mast', pos: [QUARRY.mast[0], null, QUARRY.mast[1]] },
    { id: 'landmark.northLookout', area: 'radioMast', kind: 'lookout', name: 'Northgate Lookout', pos: [QUARRY.mast[0] - 40, null, QUARRY.mast[1] + 6], radius: 16 },
    { id: 'police.roadblockTunnel', area: 'northgateTunnel', kind: 'roadblock', name: 'Tunnel Roadblock', pos: [338, null, -660], heading: [0, -1], width: 10 },
  ],
};
