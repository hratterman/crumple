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
import type { PropPlacement, WorldLayout } from './types';

// ------------------------------------------------------------ props (P5)
// Soft-body props (catalog keys in src/sim/props/types.ts). Pitches leave a
// 1–2 cm gap between proxies (cone 0.38, barrel 0.585, tyre 0.65, box 0.6,
// crate 0.8 wide), stacks use the catalog stack pitch. `facing` = where the
// prop's front looks: a sign's face, a street light's arm.
const DIAG = Math.SQRT1_2;
/** Valley Loop Highway centreline z along the south straight (spline samples, x 200..360). */
function highwaySouthZ(x: number): number {
  const xs = [200, 240, 280, 320, 360];
  const zs = [601.5, 603.91, 606.34, 607.79, 606.91];
  let k = 0;
  while (k < xs.length - 2 && x > xs[k + 1]!) k++;
  const t = (x - xs[k]!) / (xs[k + 1]! - xs[k]!);
  return Math.round((zs[k]! + (zs[k + 1]! - zs[k]!) * t) * 100) / 100;
}
const BOX_PYRAMID = [1, 2, 3, 4, 3, 2, 1];

const ARENA_PROPS: PropPlacement[] = [
  // Runway slalom: 7 cones on the centreline every 15 m + entry / exit gates.
  { id: 'slalom', prop: 'cone', pos: [560, null, 330], row: { count: 7, step: [-15, 0] } },
  { id: 'slalomGateIn', prop: 'cone', pos: [575, null, 324.5], row: { count: 2, step: [0, 11] } },
  { id: 'slalomGateOut', prop: 'cone', pos: [455, null, 324.5], row: { count: 2, step: [0, 11] } },
  // Barrel wall across the runway mouth (two staggered rows of 200 L drums).
  { id: 'barrelWallA', prop: 'barrel', pos: [446, null, 324.8], row: { count: 11, step: [0, 0.6] } },
  { id: 'barrelWallB', prop: 'barrel', pos: [446.6, null, 325.1], row: { count: 10, step: [0, 0.6] } },
  // Tyre walls around the side-pole row: three stacks of 3 on the approach (east) side, one behind.
  ...[276, 288, 300, 312, 324].flatMap((z, k): PropPlacement[] => [
    { id: `tyreWall${k + 1}`, prop: 'tire', pos: [300.9, null, z - 0.66], stack: 3, row: { count: 3, step: [0, 0.66] } },
    { id: `tyreBack${k + 1}`, prop: 'tire', pos: [299.1, null, z], stack: 3 },
  ]),
  // Cardboard pyramid to smash: 7 columns (1-2-3-4-3-2-1 high), two deep.
  ...BOX_PYRAMID.map((n, k): PropPlacement => ({ id: `pyramid${k + 1}`, prop: 'boxCardboard', pos: [332.2 + 0.62 * k, null, 345], stack: n, row: { count: 2, step: [0, 0.62] } })),
  // Ramp jump landing zone: cone-lined strip, a cardboard wall and crates to land in.
  { id: 'landingConesW', prop: 'cone', pos: [406.5, null, 281], row: { count: 5, step: [0, -8] } },
  { id: 'landingConesE', prop: 'cone', pos: [413.5, null, 281], row: { count: 5, step: [0, -8] } },
  { id: 'landingCrates', prop: 'boxWood', pos: [409, null, 264.5], row: { count: 2, step: [2, 0] } },
  { id: 'landingWall', prop: 'boxCardboard', pos: [408.45, null, 258], stack: 2, row: { count: 6, step: [0.62, 0] } },
  { id: 'landingCrateStack', prop: 'boxWood', pos: [410, null, 251.5], stack: 2 },
  // Precast block wall (2 high, 1 t each) in the south-east quarter.
  { id: 'blockWall', prop: 'concreteBlock', pos: [384.2, null, 372], stack: 2, row: { count: 4, step: [1.22, 0] } },
  // Street lights: runway (staggered, arms over the lane), arena corners (arms inward), Main St.
  { id: 'runwayLightS', prop: 'lightPole', pos: [470, null, 336.3], row: { count: 2, step: [60, 0] } },
  { id: 'runwayLightN', prop: 'lightPole', pos: [500, null, 323.7], facing: [0, 1], row: { count: 2, step: [60, 0] } },
  { id: 'arenaLightNW', prop: 'lightPole', pos: [274, null, 244], facing: [DIAG, DIAG] },
  { id: 'arenaLightNE', prop: 'lightPole', pos: [446, null, 244], facing: [-DIAG, DIAG] },
  { id: 'arenaLightSW', prop: 'lightPole', pos: [274, null, 416], facing: [DIAG, -DIAG] },
  { id: 'arenaLightSE', prop: 'lightPole', pos: [446, null, 416], facing: [-DIAG, -DIAG] },
  { id: 'mainLightE', prop: 'lightPole', pos: [155.5, null, 280], facing: [-1, 0], row: { count: 2, step: [0, 90] } },
  { id: 'mainLightW', prop: 'lightPole', pos: [144.5, null, 300], facing: [1, 0], row: { count: 2, step: [0, 90] } },
  // Warning signs facing the traffic they warn.
  { id: 'runwaySign', prop: 'signPost', pos: [485, null, 336.6], facing: [1, 0] },
  { id: 'crashWallSign', prop: 'signPost', pos: [347.5, null, 267], facing: [0, 1] },
  { id: 'townSignN', prop: 'signPost', pos: [156.5, null, 243.5] },
  { id: 'townSignS', prop: 'signPost', pos: [143.5, null, 416.5], facing: [0, 1] },
  { id: 'townSignW', prop: 'signPost', pos: [95.5, null, 337], facing: [-1, 0] },
  // Highway work zone (south straight): signs, a cone taper closing the outer lane, a cone line, drums in the closed lane.
  { id: 'worksSign', prop: 'signPost', pos: [195, null, highwaySouthZ(195) + 11.3], facing: [-1, 0], row: { count: 2, step: [15, 0] } },
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k): PropPlacement => {
    const x = 225 + 5 * k;
    return { id: `worksTaper${k + 1}`, prop: 'cone', pos: [x, null, highwaySouthZ(x) + 7.3 - (3.7 * k) / 8] };
  }),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k): PropPlacement => {
    const x = 272.5 + 7.5 * k;
    return { id: `worksLine${k + 1}`, prop: 'cone', pos: [x, null, highwaySouthZ(x) + 3.6] };
  }),
  ...[280, 300, 320].map((x, k): PropPlacement => ({ id: `worksDrum${k + 1}`, prop: 'barrel', pos: [x, null, highwaySouthZ(x) + 5.4] })),
];

export const DEFAULT_LAYOUT: WorldLayout = {
  id: 'crumple-valley',
  name: 'Crumple Valley',
  version: 4,
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
      // 180 × 180 m flat concrete; the wall, poles, ramp and barriers are `colliders` below (P4).
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
    { id: 'highway', name: 'Highway East', road: { id: 'highway', s: 2400, d: -5.25, reverse: true } },
    { id: 'mountainBase', name: 'Ridge Pass Base', road: { id: 'ridgePass', s: 30, d: 1.75 } },
    { id: 'summit', name: 'Summit Lookout', pos: [166, -356], yaw: (185 * Math.PI) / 180 },
    { id: 'dirtTrail', name: 'Hollow Creek Trailhead', road: { id: 'dirtTrail', s: 15, d: 0 } },
    { id: 'lakeshore', name: 'Lakeshore Drive', road: { id: 'lakeshore', s: 120, d: 1.9 } },
    { id: 'town', name: 'Millbrook', road: { id: 'mainStreet', s: 12, d: 2 } },
  ],

  // Crash Test Arena furniture (P4, arena core x 270..450, z 240..420, y 10.5).
  // Version 3: colliders added (terrain unchanged; replays key on the version).
  colliders: [
    // Rigid crash wall: 20 m × 2 m tall × 1.2 m thick concrete barrier, face
    // toward the arena spawn (360, 400) — 134 m of run-up heading north.
    { id: 'crashWall', kind: 'box', pos: [360, null, 265], quat: [0, 0, 0, 1], size: [10, 1, 0.6], material: MaterialId.concrete, visual: 'wall' },
    // Pole row (side-pole and slalom tests): r 0.15 m, 6 m tall steel, 12 m apart.
    ...[276, 288, 300, 312, 324].map((z, k) => ({
      id: `pole${k + 1}`,
      kind: 'cylinder' as const,
      pos: [300, null, z] as const,
      quat: [0, 0, 0, 1] as const,
      size: [0.15, 3, 0] as const,
      material: MaterialId.metal,
      visual: 'pole' as const,
    })),
    // Kicker ramp: 5 m wide, 9 m long, 1.4 m lip (≈ 8.8°), climbs heading north.
    { id: 'ramp', kind: 'ramp', pos: [410, null, 290], quat: [0, 0, 0, 1], size: [2.5, 0.7, 4.5], material: MaterialId.concrete, visual: 'ramp' },
    // Jersey-barrier line: 8 × (3.0 m × 0.81 m × 0.6 m) segments, 0.1 m gaps, along X.
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({
      id: `jersey${k + 1}`,
      kind: 'box' as const,
      pos: [283.5 + 3.1 * k, null, 385] as const,
      quat: [0, 0, 0, 1] as const,
      size: [1.5, 0.405, 0.3] as const,
      material: MaterialId.concrete,
      visual: 'jersey' as const,
    })),
  ],
  props: ARENA_PROPS,
};

/** Registry by id (saves, replays and the protocol name layouts by id). */
export const WORLD_LAYOUTS: Readonly<Record<string, WorldLayout>> = {
  [DEFAULT_LAYOUT.id]: DEFAULT_LAYOUT,
};
