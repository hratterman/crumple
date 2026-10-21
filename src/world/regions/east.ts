/**
 * EAST (layout v6): Eastfield — a flat airfield / proving ground beyond the
 * highway's east side: a 1.7 km concrete runway (high-speed and braking
 * tests), the apron with hangars, the crash-test lab (a 400 m run-up lane
 * into the lab hall: rigid barrier, offset barrier, pole, side-impact sled)
 * and the Eastfield Dragway (quarter mile, Christmas tree, timing beams,
 * shutdown and a return road).
 */
import { MaterialId } from '../../protocol/messages';
import type { RegionData } from './types';

export const EASTFIELD_Y = 12;
/** Dragway: start line z, lanes x, quarter mile (402.336 m) run toward −Z (north). */
export const DRAGWAY = { x: 1060, startZ: 330, laneOffset: 3.4, quarterMile: 402.336 } as const;
/** Crash lab: run-up lane x, the barrier face z (lane runs south, +Z, into it). */
export const CRASH_LAB = { x: 760, startZ: -560, barrierZ: -128, hallZ: -112 } as const;
export const RUNWAY = { x: 880, northZ: -700, southZ: 1000 } as const;

const FT = 0.3048;

export const EAST: RegionData = {
  zones: [
    {
      id: 'eastfield',
      name: 'Eastfield',
      kind: 'town',
      shape: { type: 'rect', center: [905, 195], halfX: 225, halfZ: 915, blend: 55 },
      params: { height: EASTFIELD_Y },
    },
  ],
  pads: [
    { id: 'apron', purpose: 'apron', shape: { type: 'rect', center: [760, 330], halfX: 58, halfZ: 120, blend: 6 }, height: EASTFIELD_Y, material: MaterialId.concrete },
    { id: 'crashLabPad', purpose: 'apron', shape: { type: 'rect', center: [CRASH_LAB.x, -100], halfX: 40, halfZ: 34, blend: 6 }, height: EASTFIELD_Y, material: MaterialId.concrete },
    { id: 'dragPits', purpose: 'parking', shape: { type: 'rect', center: [1000, 420], halfX: 40, halfZ: 30, blend: 6 }, height: EASTFIELD_Y, material: MaterialId.asphalt },
  ],
  roads: [
    {
      id: 'airfieldRoad',
      name: 'Airfield Road',
      kind: 'country',
      closed: false,
      points: [
        [596, 10.6, 330],
        [630, null, 330],
        [670, null, 330],
        [700, EASTFIELD_Y, 330],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'runway',
      name: 'Runway 18/36',
      kind: 'arena',
      closed: false,
      points: [
        [RUNWAY.x, EASTFIELD_Y, RUNWAY.northZ],
        [RUNWAY.x, EASTFIELD_Y, -275],
        [RUNWAY.x, EASTFIELD_Y, 150],
        [RUNWAY.x, EASTFIELD_Y, 575],
        [RUNWAY.x, EASTFIELD_Y, RUNWAY.southZ],
      ],
      width: 30,
      lanes: 1,
      shoulder: 7.5,
      material: MaterialId.concrete,
      markings: 'edge',
    },
    {
      id: 'crashLane',
      name: 'Crash Lab Run-up',
      kind: 'arena',
      closed: false,
      points: [
        [CRASH_LAB.x, EASTFIELD_Y, CRASH_LAB.startZ],
        [CRASH_LAB.x, EASTFIELD_Y, -340],
        [CRASH_LAB.x, EASTFIELD_Y, -150],
      ],
      width: 10,
      lanes: 1,
      shoulder: 1,
      material: MaterialId.concrete,
      markings: 'edge',
    },
    {
      id: 'dragStrip',
      name: 'Eastfield Dragway',
      kind: 'arena',
      closed: false,
      points: [
        [DRAGWAY.x, EASTFIELD_Y, DRAGWAY.startZ + 50],
        [DRAGWAY.x, EASTFIELD_Y, 0],
        [DRAGWAY.x, EASTFIELD_Y, -240],
        [DRAGWAY.x, EASTFIELD_Y, -480],
      ],
      width: 16,
      lanes: 1,
      shoulder: 2,
      material: MaterialId.concrete,
      markings: 'edge',
    },
    {
      // 'arena' (unrouted): a private loop with the strip, no public traffic.
      id: 'dragReturn',
      name: 'Dragway Return Road',
      kind: 'arena',
      closed: false,
      points: [
        [DRAGWAY.x, EASTFIELD_Y, -480],
        [1086, EASTFIELD_Y, -470],
        [1110, EASTFIELD_Y, -440],
        [1116, EASTFIELD_Y, -300],
        [1116, EASTFIELD_Y, 0],
        [1116, EASTFIELD_Y, 300],
        [1108, EASTFIELD_Y, 372],
        [1088, EASTFIELD_Y, 394],
        [DRAGWAY.x, EASTFIELD_Y, DRAGWAY.startZ + 50],
      ],
      width: 6.5,
      lanes: 1,
      shoulder: 1,
      material: MaterialId.asphalt,
      markings: 'center',
    },
  ],
  junctions: [
    { id: 'dragNorth', pos: [DRAGWAY.x, -480], roads: ['dragStrip', 'dragReturn'] },
    { id: 'dragSouth', pos: [DRAGWAY.x, DRAGWAY.startZ + 50], roads: ['dragStrip', 'dragReturn'] },
  ],
  spawns: [
    { id: 'dragway', name: 'Eastfield Dragway', pos: [DRAGWAY.x - DRAGWAY.laneOffset, DRAGWAY.startZ + 8], yaw: 0, area: 'dragway' },
    { id: 'runway', name: 'Eastfield Runway', road: { id: 'runway', s: 30, d: -6 }, area: 'provingGround' },
    { id: 'crashLab', name: 'Crash Test Lab', road: { id: 'crashLane', s: 12, d: 0 }, area: 'crashLab' },
  ],
  areas: [
    { id: 'dragway', name: 'Eastfield Dragway', kind: 'drag', bounds: { type: 'rect', center: [1088, -40], halfX: 50, halfZ: 470, blend: 0 }, spawn: 'dragway' },
    { id: 'provingGround', name: 'Eastfield Proving Ground', kind: 'proving', bounds: { type: 'rect', center: [880, 150], halfX: 140, halfZ: 900, blend: 0 }, spawn: 'runway' },
    { id: 'crashLab', name: 'Crash Test Lab', kind: 'crashLab', bounds: { type: 'rect', center: [CRASH_LAB.x, -330], halfX: 45, halfZ: 260, blend: 0 }, spawn: 'crashLab' },
  ],
  pois: [
    { id: 'drag.tree', area: 'dragway', kind: 'tree', name: 'Christmas Tree', pos: [DRAGWAY.x, null, DRAGWAY.startZ - 2], heading: [0, -1] },
    { id: 'drag.stageL', area: 'dragway', kind: 'start', name: 'Left Lane Stage', pos: [DRAGWAY.x - DRAGWAY.laneOffset, null, DRAGWAY.startZ], heading: [0, -1], width: 5 },
    { id: 'drag.stageR', area: 'dragway', kind: 'start', name: 'Right Lane Stage', pos: [DRAGWAY.x + DRAGWAY.laneOffset, null, DRAGWAY.startZ], heading: [0, -1], width: 5 },
    ...(
      [
        ['beam60ft', '60 ft', 60],
        ['beam330ft', '330 ft', 330],
        ['beam660ft', '1/8 mile', 660],
        ['beam1000ft', '1000 ft', 1000],
        ['finish', '1/4 mile', 1320],
      ] as const
    ).map(([id, name, ft]) => ({
      id: `drag.${id}`,
      area: 'dragway',
      kind: id === 'finish' ? ('finish' as const) : ('timingBeam' as const),
      name,
      pos: [DRAGWAY.x, null, DRAGWAY.startZ - ft * FT] as const,
      heading: [0, -1] as const,
      width: 16,
    })),
    { id: 'drag.shutdownEnd', area: 'dragway', kind: 'hazard', name: 'Shutdown End', pos: [DRAGWAY.x, null, -470], heading: [0, -1], width: 16 },
    { id: 'drag.returnLane', area: 'dragway', kind: 'checkpoint', name: 'Return Road', pos: [1116, null, 0], heading: [0, 1], width: 7 },
    { id: 'proving.runwayStart', area: 'provingGround', kind: 'start', name: 'Runway 18 Threshold', pos: [RUNWAY.x - 6, null, RUNWAY.northZ + 40], heading: [0, 1], width: 30 },
    { id: 'proving.runwayEnd', area: 'provingGround', kind: 'finish', name: 'Runway 36 Threshold', pos: [RUNWAY.x, null, RUNWAY.southZ - 40], heading: [0, 1], width: 30 },
    { id: 'proving.speedTrapIn', area: 'provingGround', kind: 'timingBeam', name: 'Speed Trap In', pos: [RUNWAY.x, null, 600], heading: [0, 1], width: 30 },
    { id: 'proving.speedTrapOut', area: 'provingGround', kind: 'timingBeam', name: 'Speed Trap Out', pos: [RUNWAY.x, null, 700], heading: [0, 1], width: 30 },
    { id: 'proving.brakeMark', area: 'provingGround', kind: 'checkpoint', name: 'Brake Marker', pos: [RUNWAY.x, null, 760], heading: [0, 1], width: 30 },
    { id: 'crashLab.runup', area: 'crashLab', kind: 'runup', name: 'Run-up Start', pos: [CRASH_LAB.x, null, CRASH_LAB.startZ + 12], heading: [0, 1], width: 10 },
    { id: 'crashLab.barrier', area: 'crashLab', kind: 'barrier', name: 'Rigid Barrier', pos: [CRASH_LAB.x, null, CRASH_LAB.barrierZ], heading: [0, 1], width: 4 },
    { id: 'crashLab.offsetBarrier', area: 'crashLab', kind: 'barrier', name: 'Offset Barrier (40 %)', pos: [CRASH_LAB.x + 12, null, CRASH_LAB.barrierZ], heading: [0, 1], width: 1.6 },
    { id: 'crashLab.pole', area: 'crashLab', kind: 'pole', name: 'Side Pole', pos: [CRASH_LAB.x - 13, null, CRASH_LAB.barrierZ + 14] },
    { id: 'crashLab.sled', area: 'crashLab', kind: 'sled', name: 'Side-impact Sled', pos: [CRASH_LAB.x + 24, null, -96], heading: [-1, 0] },
    { id: 'delivery.hangar', area: 'provingGround', kind: 'delivery', name: 'Hangar 2', pos: [745, null, 330], radius: 12 },
  ],
};
