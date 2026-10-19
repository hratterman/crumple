/**
 * DEFAULT_LAYOUT — the CRUMPLE map as data ("Crumple Valley", 1408 m square,
 * ~2 km²). Hand-designed control points; noise only adds terrain detail.
 * Pure data (no three, no DOM): imported by the worker (groundHeightfield)
 * and by main.
 *
 *  N (−Z) up, 1 char ≈ 29 m × 59 m, x −704 → +704 left → right
 *  ||||||||||||||||||||||||||||||||||||||||||||||||
 *  ||        ........#################........   ||
 *  ||          #######......'''''''''.######     ||
 *  ||       ####  .......''''^^^^^^''''... ###   ||
 *  ||     ###    ..''''''''^^^^^^^^^^'''''''.##  ||
 *  ||    ##  ::: ..'''''''^^^^^^@^SS^^''^^'''.## ||
 *  ||   ##  :: :: ......''SSSS^^SSSS^'''''''.  # ||
 *  ||   #  ::   ::     ..''SSSSSSS'SSSSS..     # ||
 *  ||  ##  ::    :o-SSSSS....'SSSSSSSSS        # ||
 *  ||  #  ::       --   SSSSSSSSSSSS           # ||
 *  || ## ::         ---                        # ||
 *  || #  ::           ---                      # ||
 *  || #   ::::           --                   ## ||
 *  || #       ::          ---                 #  ||
 *  || ##  -----o---         ---               #  ||
 *  ||  ----    ~  ----        --o             ## ||
 *  ||  o   ~~~~~~~~~ --      +++o++ AAAAAA     # ||
 *  ||  #  ~~~~~~~~~~~ -- ----+ot+to++AAAAA>>>>>o ||
 *  ||  #  ~~~~~~~~~~~ o---   +++o++ AAAAAA     # ||
 *  ||  ##   ~~~~~~~~  -       ++++             # ||
 *  ||   ##            --        +             ## ||
 *  ||    ######        --       +          ###   ||
 *  ||         ##########o#######o###########     ||
 *  ||||||||||||||||||||||||||||||||||||||||||||||||
 *  S (+Z)
 *
 *  #  Valley Loop Highway (closed, 4.2 km)   S  Ridge Pass (mountain, hairpins)
 *  :  Hollow Creek Trail (dirt)              -  Lakeshore Dr / Valley Rd / Mill Rd
 *  +  Millbrook streets (ring + Main St)     >  Arena Runway (concrete run-up)
 *  A  Crash Test Arena 180×180 (concrete)    t  Millbrook town pad
 *  ~  Mirror Lake (water 6 m)                o  junction   @ summit lookout
 *  ^ ' .  terrain > 110 / > 60 / > 30 m      |  rim (edge rise)
 *
 * Network (all at-grade, overpass-free): the 4.2 km HIGHWAY loop (W side
 * 11 m → N crest 48 m through a cutting below the North Downs → 9 m along
 * the south) meets LAKESHORE DRIVE (W + S junctions), MAIN ST (S) and the
 * ARENA RUNWAY (E). Lakeshore feeds the DIRT TRAIL (north through the
 * western hills to the mountain BASE) and MILL RD (east to Millbrook's
 * ring). The VALLEY RD links BASE and Millbrook; RIDGE PASS climbs from
 * BASE (10.5 m) to the summit lookout (150.5 m): 1.55 km, ~10–11 % grade,
 * three R16 hairpins.
 */
import { MaterialId } from '../protocol/messages';
import type { WorldLayout } from './types';

export const DEFAULT_LAYOUT: WorldLayout = {
  id: 'crumple-valley',
  name: 'Crumple Valley',
  version: 2,
  seed: 0x5eed_c0de,
  size: 1408,
  terrain: {
    spacing: 1,
    baseHeight: 10,
    detail: { amplitude: 2.5, wavelength: 220, octaves: 4 },
    edgeRise: { width: 90, height: 40 },
    minHeight: -10,
    maxHeight: 220,
  },
  waterLevel: 6,

  zones: [
    {
      id: 'plains',
      name: 'Central Plains',
      kind: 'plains',
      shape: { type: 'rect', center: [80, 180], halfX: 420, halfZ: 300, blend: 120 },
      params: { detail: { amplitude: 1.5, wavelength: 90, octaves: 3 } },
    },
    {
      id: 'westernHills',
      name: 'Western Hills',
      kind: 'hills',
      shape: {
        type: 'polygon',
        points: [
          [-545, 115],
          [-545, -300],
          [-470, -420],
          [-330, -430],
          [-265, -300],
          [-265, -120],
          [-300, 115],
        ],
        blend: 60,
      },
      params: { noise: { amplitude: 14, wavelength: 160, octaves: 3 }, lift: 6 },
    },
    {
      id: 'range',
      name: 'Crumple Range',
      kind: 'mountains',
      shape: {
        type: 'polygon',
        points: [
          [-420, -704],
          [704, -704],
          [704, -120],
          [380, -120],
          [-60, -90],
          [-300, -260],
          [-420, -460],
        ],
        blend: 80,
      },
      params: {
        peaks: [
          { name: 'Crumple Peak', center: [150, -390], height: 150, radiusX: 400, radiusZ: 300 },
          { name: 'Gable', center: [-170, -420], height: 70, radiusX: 200, radiusZ: 180 },
          { name: 'Anvil', center: [420, -380], height: 105, radiusX: 170, radiusZ: 160 },
          { name: 'North Downs', center: [60, -680], height: 44, radiusX: 900, radiusZ: 330 },
        ],
        ridged: { amplitude: 9, wavelength: 140, octaves: 5 },
        rockSlope: 0.65,
      },
    },
    {
      id: 'mirrorLake',
      name: 'Mirror Lake',
      kind: 'lake',
      shape: { type: 'ellipse', center: [-330, 340], radiusX: 165, radiusZ: 135, blend: 30 },
      params: { depth: 8, shoreLift: 1.2 },
    },
    {
      id: 'millbrook',
      name: 'Millbrook',
      kind: 'town',
      shape: { type: 'rect', center: [150, 330], halfX: 80, halfZ: 100, blend: 40 },
      params: { height: 10.5 },
    },
    {
      id: 'arena',
      name: 'Crash Test Arena',
      kind: 'arena',
      // 180 × 180 m flat concrete; P5 places ramps, walls, poles, barriers here.
      shape: { type: 'rect', center: [360, 330], halfX: 90, halfZ: 90, blend: 30 },
      params: { height: 10.5, material: MaterialId.concrete },
    },
  ],

  pads: [
    {
      id: 'summitLookout',
      purpose: 'lookout',
      shape: { type: 'circle', center: [150, -372], radius: 24, blend: 18 },
      height: 150.5,
      material: MaterialId.gravel,
    },
    {
      id: 'beachParking',
      purpose: 'parking',
      shape: { type: 'rect', center: [-200, 205], halfX: 18, halfZ: 12, blend: 10 },
      height: null,
      material: MaterialId.gravel,
    },
  ],

  roads: [
    {
      id: 'highway',
      name: 'Valley Loop Highway',
      kind: 'highway',
      closed: true,
      // Clockwise seen from above (N up): north along the W side, east
      // over the crest, south down the E side, west along the S straight.
      points: [
        [-578, 10.5, 250],
        [-592, 11, 60],
        [-575, 12.6, -150],
        [-520, 14, -330],
        [-420, 21.9, -470],
        [-270, 30, -560],
        [-80, 38.6, -598],
        [130, 48, -602],
        [330, 38.6, -585],
        [480, 31, -530],
        [575, 23.9, -420],
        [600, 15, -240],
        [590, 13, -40],
        [585, 11, 160],
        [596, 10.6, 330],
        [588, 10.2, 470],
        [520, 9.9, 565],
        [380, 9.6, 605],
        [150, 9, 600],
        [-80, 9.2, 605],
        [-290, 9.4, 598],
        [-460, 9.5, 560],
        [-560, 9.9, 440],
      ],
      width: 14,
      lanes: 2,
      shoulder: 3,
      bank: 0.05,
      material: MaterialId.asphalt,
      markings: 'highway',
    },
    {
      id: 'ridgePass',
      name: 'Ridge Pass',
      kind: 'mountain',
      closed: false,
      // BASE → four switchback legs on Crumple Peak's south face (3 hairpins
      // at the E and W ends, R ≈ 16 m) → summit lookout. y pinned to a
      // ~10.5 % average grade; legs track the macro terrain within ±9 m.
      points: [
        [-235, 10.5, -185],
        [-205, 12.4, -226],
        [-154.7, 14.2, -230],
        [-66.5, 18, -178.4],
        [34, 21.8, -150.9],
        [135.9, 32.4, -148],
        [229.3, 42.4, -167.9],
        [305.9, 51.3, -206.4],
        [349.5, 57.1, -241.7],
        [359.8, 59.1, -258],
        [361.8, 60.4, -270.1],
        [354.8, 61.7, -280],
        [342.7, 62.9, -282.1],
        [332.7, 64.2, -275],
        [322.5, 66.2, -258.8],
        [274, 71.5, -244],
        [207.8, 78.6, -228.3],
        [140.6, 85.6, -228.5],
        [78.9, 92.7, -243.5],
        [28.1, 99.2, -270.9],
        [1.2, 102.9, -290.2],
        [-7.7, 105, -307.2],
        [-8.8, 106.4, -319.4],
        [-1, 107.8, -328.8],
        [11.2, 109.2, -329.9],
        [20.6, 110.6, -322.1],
        [29.6, 112.7, -305.1],
        [57.6, 115.9, -299.7],
        [100.2, 120.9, -287.4],
        [143.9, 125.8, -285.6],
        [184.5, 130.2, -293.6],
        [218.2, 134.2, -309.7],
        [232.2, 135.9, -315.6],
        [242.5, 137.9, -331.8],
        [244.5, 139.2, -343.9],
        [237.5, 140.6, -353.9],
        [225.4, 141.9, -355.9],
        [215.4, 143.2, -348.8],
        [200, 145, -339],
        [178, 147.1, -337],
        [158, 149.2, -345],
        [150, 150.5, -356],
      ],
      width: 7,
      lanes: 1,
      shoulder: 1,
      bank: 0.08,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'lakeshore',
      name: 'Lakeshore Drive',
      kind: 'country',
      closed: false,
      // Highway W → along the north and east shore of Mirror Lake → highway S.
      points: [
        [-578, null, 250],
        [-540, null, 205],
        [-480, null, 175],
        [-410, null, 166],
        [-330, null, 163],
        [-255, null, 172],
        [-190, null, 200],
        [-140, null, 250],
        [-120, null, 310],
        [-118, null, 370],
        [-128, null, 440],
        [-118, null, 510],
        [-95, null, 565],
        [-80, null, 605],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      bank: 0.05,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'dirtTrail',
      name: 'Hollow Creek Trail',
      kind: 'dirt',
      closed: false,
      // Lakeshore → north through the western hills (crests, dips, a fast
      // sweeper by the highway) → mountain BASE. y follows the hills.
      points: [
        [-330, null, 163],
        [-345, null, 110],
        [-380, null, 60],
        [-430, null, 30],
        [-480, null, -10],
        [-505, null, -70],
        [-490, null, -130],
        [-450, null, -170],
        [-420, null, -230],
        [-440, null, -290],
        [-400, null, -345],
        [-340, null, -360],
        [-300, null, -320],
        [-290, null, -260],
        [-270, null, -215],
        [-235, null, -185],
      ],
      width: 5,
      lanes: 1,
      shoulder: 1,
      material: MaterialId.dirt,
      markings: 'none',
    },
    {
      id: 'valleyRoad',
      name: 'Valley Road',
      kind: 'country',
      closed: false,
      points: [
        [-235, null, -185],
        [-170, null, -110],
        [-90, null, -30],
        [-10, null, 50],
        [60, null, 130],
        [120, null, 190],
        [150, 10.5, 225],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      bank: 0.04,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'millRoad',
      name: 'Mill Road',
      kind: 'country',
      closed: false,
      points: [
        [-118, null, 370],
        [-40, null, 352],
        [30, null, 336],
        [90, 10.5, 330],
      ],
      width: 7.5,
      lanes: 1,
      shoulder: 1.5,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'townRing',
      name: 'Millbrook Ring',
      kind: 'street',
      closed: true,
      points: [
        [90, 10.5, 330],
        [90, 10.5, 265],
        [105, 10.5, 250],
        [150, 10.5, 250],
        [195, 10.5, 250],
        [210, 10.5, 265],
        [210, 10.5, 330],
        [210, 10.5, 395],
        [195, 10.5, 410],
        [150, 10.5, 410],
        [105, 10.5, 410],
        [90, 10.5, 395],
      ],
      width: 8,
      lanes: 1,
      shoulder: 0.5,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'mainStreet',
      name: 'Main Street',
      kind: 'street',
      closed: false,
      points: [
        [150, 10.5, 225],
        [150, 10.5, 250],
        [150, 10.5, 330],
        [150, 10.5, 410],
        [150, 10.2, 480],
        [150, 9.6, 550],
        [150, 9, 600],
      ],
      width: 8,
      lanes: 1,
      shoulder: 0.5,
      material: MaterialId.asphalt,
      markings: 'center',
    },
    {
      id: 'gateStreet',
      name: 'Arena Gate',
      kind: 'street',
      closed: false,
      points: [
        [210, 10.5, 330],
        [240, 10.5, 330],
        [275, 10.5, 330],
      ],
      width: 8,
      lanes: 1,
      shoulder: 0.5,
      material: MaterialId.asphalt,
      markings: 'edge',
    },
    {
      id: 'arenaRunway',
      name: 'Arena Runway',
      kind: 'arena',
      closed: false,
      // Crash-test run-up: highway E → 150 m straight west into the arena.
      points: [
        [596, 10.6, 330],
        [540, 10.5, 330],
        [490, 10.5, 330],
        [440, 10.5, 330],
      ],
      width: 12,
      lanes: 1,
      shoulder: 1,
      material: MaterialId.concrete,
      markings: 'edge',
    },
  ],

  junctions: [
    { id: 'hwyWest', pos: [-578, 250], roads: ['highway', 'lakeshore'] },
    { id: 'hwySouthLake', pos: [-80, 605], roads: ['highway', 'lakeshore'] },
    { id: 'hwySouthTown', pos: [150, 600], roads: ['highway', 'mainStreet'] },
    { id: 'hwyEastArena', pos: [596, 330], roads: ['highway', 'arenaRunway'] },
    { id: 'trailhead', pos: [-330, 163], roads: ['lakeshore', 'dirtTrail'] },
    { id: 'millJunction', pos: [-118, 370], roads: ['lakeshore', 'millRoad'] },
    { id: 'base', pos: [-235, -185], roads: ['ridgePass', 'valleyRoad', 'dirtTrail'] },
    { id: 'townNorth', pos: [150, 225], roads: ['valleyRoad', 'mainStreet'] },
    { id: 'ringWest', pos: [90, 330], roads: ['townRing', 'millRoad'] },
    { id: 'ringNorth', pos: [150, 250], roads: ['townRing', 'mainStreet'] },
    { id: 'ringSouth', pos: [150, 410], roads: ['townRing', 'mainStreet'] },
    { id: 'ringEast', pos: [210, 330], roads: ['townRing', 'gateStreet'] },
  ],

  spawnPoints: [
    { id: 'arena', name: 'Crash Test Arena', pos: [360, 400], yaw: 0 },
    { id: 'arenaRunway', name: 'Arena Runway', road: { id: 'arenaRunway', s: 8, d: 3 } },
    { id: 'highway', name: 'Highway East', road: { id: 'highway', s: 2400, d: 5.25 } },
    { id: 'mountainBase', name: 'Ridge Pass Base', road: { id: 'ridgePass', s: 30, d: 1.75 } },
    { id: 'summit', name: 'Summit Lookout', pos: [150, -372], yaw: Math.PI },
    { id: 'dirtTrail', name: 'Hollow Creek Trailhead', road: { id: 'dirtTrail', s: 15, d: 0 } },
    { id: 'lakeshore', name: 'Lakeshore Drive', road: { id: 'lakeshore', s: 120, d: 1.9 } },
    { id: 'town', name: 'Millbrook', road: { id: 'mainStreet', s: 12, d: 2 } },
  ],

  colliders: [],
  props: [],
};

/** Registry by id (saves, replays and the protocol name layouts by id). */
export const WORLD_LAYOUTS: Readonly<Record<string, WorldLayout>> = {
  [DEFAULT_LAYOUT.id]: DEFAULT_LAYOUT,
};
