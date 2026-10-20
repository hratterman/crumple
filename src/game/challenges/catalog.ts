/**
 * The challenge catalog (P8-C): ten hand-built challenges on Crumple
 * Valley's stunt park, ski jump and roads. Data only, except that road
 * courses (Hill Climb, Drift King) place their gates on the resolved road
 * profiles, so the catalog is built once per terrain (`challengeCatalog`).
 * Medal thresholds come from measured runs (docs/CONTRACTS.md "P8
 * challenges as built" lists the runs behind each number).
 */
import { createRoadSample, sampleRoad } from '../../world/roads';
import { BARREL_ROLL, BOWLING, DERBY_PIT, PARK_BAYS, SKI_INRUN, SKI_JUMP_X, SKI_LIP, WRECK_JUMP } from '../../world/stuntpark';
import type { RoadProfile } from '../../world/types';
import { dirYaw } from './eval/geometry';
import type { ChallengeDef, ChallengePropDef, GateDef, SpawnDef, XZ } from './types';

export interface CatalogWorld {
  roads: readonly RoadProfile[];
}

function road(world: CatalogWorld, id: string): RoadProfile {
  const r = world.roads.find((x) => x.id === id);
  if (!r) throw new Error(`challenge catalog: road '${id}' missing`);
  return r;
}

/** Gates across a road every `step` m from s0 to s1 (the last one at s1), on the road surface. */
function roadGates(r: RoadProfile, s0: number, s1: number, step: number, width: number): GateDef[] {
  const out: GateDef[] = [];
  const q = createRoadSample();
  const n = Math.max(1, Math.round((s1 - s0) / step));
  for (let i = 1; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    sampleRoad(r, s, q);
    out.push({ pos: [q.x, q.y, q.z], yawDeg: dirYaw(q.tx, q.tz), width, height: 6 });
  }
  return out;
}

function roadSpawn(r: RoadProfile, s: number, d: number): SpawnDef {
  const q = createRoadSample();
  sampleRoad(r, s, q);
  return { pos: [q.x + q.rx * d, null, q.z + q.rz * d], yawDeg: dirYaw(q.tx, q.tz) };
}

function roadLine(r: RoadProfile, s0: number, s1: number, step: number, d = 0): XZ[] {
  const q = createRoadSample();
  const out: XZ[] = [];
  for (let s = s0; s <= s1; s += step) {
    sampleRoad(r, s, q);
    out.push([q.x + q.rx * d, q.z + q.rz * d]);
  }
  return out;
}

/** Ten 200 L drums in a bowling triangle, head pin toward the lane start (east). */
function bowlingPins(): ChallengePropDef[] {
  const out: ChallengePropDef[] = [];
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k <= row; k++) {
      const z = BOWLING.laneZ + (k - row / 2) * 1.55;
      out.push({ group: 'pins', prop: 'barrel', pos: [BOWLING.headPinX - row * 1.35, null, z] });
    }
  }
  return out;
}

let cached: { world: CatalogWorld; defs: ChallengeDef[] } | null = null;

/** The catalog for a terrain (memoized per roads array). */
export function challengeCatalog(world: CatalogWorld): readonly ChallengeDef[] {
  if (cached && cached.world.roads === world.roads) return cached.defs;
  const defs = buildCatalog(world);
  cached = { world, defs };
  return defs;
}

export function findChallenge(world: CatalogWorld, id: string): ChallengeDef | null {
  return challengeCatalog(world).find((d) => d.id === id) ?? null;
}

function buildCatalog(world: CatalogWorld): ChallengeDef[] {
  const ridge = road(world, 'ridgePass');
  const ring = road(world, 'townRing');
  const [inrunZ0, inrunY0] = SKI_INRUN[0]!;

  const defs: ChallengeDef[] = [
    {
      id: 'long-jump',
      name: 'Long Jump',
      blurb: 'Drop in off the Anvil ski jump. Distance counts, but only if it lands on its wheels.',
      brief: 'Roll off the start tower, build speed down the in-run and launch off the table. Distance is measured from the lip to the first touchdown. Too much speed carries you past the landing hill onto the flat, and a crash landing halves the distance.',
      where: 'Anvil Ski Jump',
      icon: 'jump',
      vehicle: { kind: 'forced', id: 'sedan' },
      spawn: { pos: [SKI_JUMP_X, inrunY0, inrunZ0 + 4], yawDeg: 180 },
      traffic: 0,
      objectives: [
        { type: 'jump', takeoff: { kind: 'rect', center: [SKI_JUMP_X, SKI_LIP[2] - 2], halfX: 4, halfZ: 5 }, ends: true, settleS: 3, minAirtimeS: 0.4 },
        { type: 'landUpright', mode: 'bonus', factor: 0.5 },
        { type: 'timeLimit', seconds: 40, onExpire: 'fail' },
      ],
      scoring: { metric: 'jumpDistance', better: 'higher', unit: 'm', decimals: 1 },
      medals: { bronze: 35, silver: 50, gold: 65, crumple: 76 },
      introCamera: { pos: [SKI_JUMP_X + 40, 105, -300], target: [SKI_JUMP_X, 100, -360] },
      botLine: [[SKI_JUMP_X, inrunZ0 + 4], [SKI_JUMP_X, SKI_LIP[2]], [SKI_JUMP_X, -200]],
    },
    {
      id: 'barrel-roll',
      name: 'Barrel Roll',
      blurb: 'One wheel up the side kicker, the rest is physics. Count the rolls.',
      brief: 'Line up on the yellow guide stripe so only the left wheels climb the narrow kicker. Speed sets the roll rate: too slow and it just tips, too fast and it barely lifts. Every quarter roll counts; a crash landing halves it.',
      where: 'Stunt Park',
      icon: 'roll',
      vehicle: { kind: 'forced', id: 'coupe' },
      spawn: { pos: [BARREL_ROLL.laneX, null, BARREL_ROLL.startZ], yawDeg: 0 },
      traffic: 0,
      objectives: [
        { type: 'flips', axis: 'roll' },
        // the finish gate 30 m past the kicker (a tumbling car crosses it too); the rolls keep counting while it settles
        { type: 'gates', gates: [{ pos: [BARREL_ROLL.laneX, null, BARREL_ROLL.kickerZ - 32], yawDeg: 0, width: 22, height: 9 }] },
        { type: 'jump', takeoff: { kind: 'rect', center: [BARREL_ROLL.laneX, BARREL_ROLL.kickerZ - 3], halfX: 5, halfZ: 9 }, minAirtimeS: 0.2 },
        { type: 'landUpright', mode: 'bonus', factor: 0.5 },
        { type: 'timeLimit', seconds: 16, onExpire: 'finish' },
      ],
      scoring: { metric: 'rolls', better: 'higher', unit: 'rolls', decimals: 2 },
      medals: { bronze: 0.25, silver: 0.5, gold: 1, crumple: 2 },
      botLine: [[BARREL_ROLL.laneX, BARREL_ROLL.startZ], [BARREL_ROLL.laneX, BARREL_ROLL.kickerZ - 40]],
    },
    {
      id: 'wall-of-fame',
      name: 'Wall of Fame',
      blurb: '100 km/h into the crash wall. Measured in centimetres of crumple.',
      brief: 'The crash-test lane gives you 134 m to reach 100 km/h before the 2 m concrete wall. Anything slower does not count. The score is the permanent crush of the front end once the car has settled.',
      where: 'Crash Test Lane',
      icon: 'wall',
      vehicle: { kind: 'forced', id: 'sedan' },
      spawn: { pos: [360, null, 400], yawDeg: 0 },
      traffic: 0,
      objectives: [
        { type: 'impact', minKmh: 100, settleS: 2.5 },
        { type: 'timeLimit', seconds: 25, onExpire: 'fail' },
      ],
      scoring: { metric: 'crush', better: 'higher', unit: 'cm', decimals: 0 },
      medals: { bronze: 70, silver: 95, gold: 115, crumple: 135 },
      botLine: [[360, 400], [360, 250]],
    },
    {
      id: 'bowling',
      name: 'Bowling',
      blurb: 'Ten oil drums, one sedan. Go for the strike.',
      brief: 'Ten 200 L drums stand in a bowling triangle at the end of the lane. Hit the head pin square and fast to scatter them all. The run ends once the pins have settled.',
      where: 'Stunt Park',
      icon: 'bowling',
      vehicle: { kind: 'forced', id: 'sedan' },
      spawn: { pos: [BOWLING.startX, null, BOWLING.laneZ], yawDeg: 90 },
      traffic: 0,
      props: bowlingPins(),
      objectives: [
        { type: 'pins', group: 'pins' },
        { type: 'timeLimit', seconds: 15, onExpire: 'finish' },
      ],
      scoring: { metric: 'pins', better: 'higher', unit: 'pins', decimals: 0 },
      medals: { bronze: 5, silver: 7, gold: 9, crumple: 10 },
      botLine: [[BOWLING.startX, BOWLING.laneZ], [BOWLING.headPinX - 20, BOWLING.laneZ]],
    },
    {
      id: 'drift-king',
      name: 'Drift King',
      blurb: 'Two laps of the Millbrook Ring in a 300 kW coupe, traction control off. Angle, speed, style.',
      brief: 'Drift points build with slip angle × speed × time; hold a drift and the multiplier climbs to ×8. Touch anything and the chain is gone. Two laps through every checkpoint; points bank when you straighten up, and the clock stops the run at 90 s.',
      where: 'Millbrook Ring',
      icon: 'drift',
      vehicle: { kind: 'forced', id: 'coupe' },
      spawn: roadSpawn(ring, 8, 0),
      traffic: 0,
      tractionControl: false,
      objectives: [
        { type: 'drift' },
        { type: 'gates', gates: roadGates(ring, 8, 8 + 2 * ring.length, ring.length / 8, 11) },
        { type: 'timeLimit', seconds: 90, onExpire: 'finish' },
      ],
      scoring: { metric: 'drift', better: 'higher', unit: 'pts', decimals: 0 },
      medals: { bronze: 300, silver: 900, gold: 2000, crumple: 4000 },
      botLine: [...roadLine(ring, 8, 8 + 2 * ring.length + 40, 5, 0)],
    },
    {
      id: 'truck-topple',
      name: 'Truck Topple',
      blurb: 'Six and a half tonnes through the runway slalom. Do not tip it.',
      brief: 'Weave the box truck through the seven slalom cones, alternating sides, as fast as you dare. Its 1.35 m centre of gravity lifts the inside wheels at about half a g: roll it and the run is over.',
      where: 'Arena Runway',
      icon: 'truck',
      vehicle: { kind: 'forced', id: 'boxtruck' },
      spawn: { pos: [590, null, 330], yawDeg: 90 },
      traffic: 0,
      objectives: [
        {
          type: 'gates',
          gates: [
            { pos: [575, null, 330], yawDeg: 90, width: 10 },
            ...[560, 545, 530, 515, 500, 485, 470].map((x, k): GateDef => ({ pos: [x, null, k % 2 === 0 ? 333 : 327], yawDeg: 90, width: 5.6 })),
            { pos: [452, null, 330], yawDeg: 90, width: 10 },
          ],
        },
        { type: 'upright', graceS: 0.8 },
        { type: 'timeLimit', seconds: 60, onExpire: 'fail' },
      ],
      scoring: { metric: 'time', better: 'lower', unit: 's', decimals: 2 },
      medals: { bronze: 34, silver: 28, gold: 24, crumple: 21.5 },
      botLine: [[590, 330], [575, 330], [560, 333.5], [545, 326.5], [530, 333.5], [515, 326.5], [500, 333.5], [485, 326.5], [470, 333.5], [452, 330], [420, 330]],
    },
    {
      id: 'demolition-derby',
      name: 'Demolition Derby',
      blurb: 'The beater against four rammers in the derby pit. Last one moving wins.',
      brief: 'Four traffic sedans are out to ram you, joining one after another. Knock them out: wreck them or leave them stalled for 10 s. When you are wrecked or stalled 15 s, the derby ends. Knock-outs score 1000, damage dealt to the rest up to 500 each, every second survived 10.',
      where: 'Derby Pit',
      icon: 'derby',
      vehicle: { kind: 'forced', id: 'beater' },
      spawn: { pos: [DERBY_PIT.centre[0], null, DERBY_PIT.centre[1] + 16], yawDeg: 0 },
      traffic: 0,
      opponents: [
        { vehicle: 'sedanTraffic', spawn: { pos: [DERBY_PIT.minX + 7, null, DERBY_PIT.minZ + 8], yawDeg: 225 }, aggression: 0.75 },
        { vehicle: 'sedanTraffic', spawn: { pos: [DERBY_PIT.maxX - 7, null, DERBY_PIT.minZ + 8], yawDeg: 135 }, aggression: 0.65 },
        { vehicle: 'sedanTraffic', spawn: { pos: [DERBY_PIT.minX + 7, null, DERBY_PIT.minZ + 34], yawDeg: 270 }, aggression: 0.7 },
        { vehicle: 'sedanTraffic', spawn: { pos: [DERBY_PIT.maxX - 7, null, DERBY_PIT.minZ + 34], yawDeg: 90 }, aggression: 0.8 },
      ],
      objectives: [
        { type: 'derby', immobileS: 10, wreckDamage: 0.16, playerImmobileS: 15, playerWreckDamage: 0.6 },
        { type: 'timeLimit', seconds: 150, onExpire: 'finish' },
      ],
      scoring: { metric: 'derby', better: 'higher', unit: 'pts', decimals: 0 },
      medals: { bronze: 1200, silver: 2200, gold: 3400, crumple: 4800 },
    },
    {
      id: 'hill-climb',
      name: 'Hill Climb',
      blurb: 'Ridge Pass, base to summit: 1.5 km, three hairpins, one clock.',
      brief: 'A time trial up Ridge Pass to the summit lookout through every checkpoint. Bring any car. Your best run comes back as a ghost to race against.',
      where: 'Ridge Pass',
      icon: 'climb',
      vehicle: { kind: 'choice' },
      spawn: roadSpawn(ridge, 26, 1.75),
      traffic: 0,
      objectives: [
        { type: 'gates', gates: roadGates(ridge, 26, ridge.length - 6, 120, 9) },
        { type: 'timeLimit', seconds: 210, onExpire: 'fail' },
      ],
      scoring: { metric: 'time', better: 'lower', unit: 's', decimals: 2 },
      medals: { bronze: 110, silver: 92, gold: 80, crumple: 72 },
      botLine: roadLine(ridge, 26, ridge.length - 2, 5, 1.2),
    },
    {
      id: 'precision-park',
      name: 'Precision Park',
      blurb: 'The pickup, a tight bay between two wrecks. Fast, central, square.',
      brief: 'Park the pickup in the yellow bay, nose or tail first: all four wheels inside, within 8° of square, stopped for 1.5 s. Points for speed, centring and angle. Scrape a wreck and you are out.',
      where: 'Stunt Park',
      icon: 'park',
      vehicle: { kind: 'forced', id: 'pickup' },
      spawn: { pos: [332, null, PARK_BAYS.zs[PARK_BAYS.target]! - 4], yawDeg: 90 },
      traffic: 0,
      objectives: [
        {
          type: 'park',
          bay: { center: [PARK_BAYS.x, PARK_BAYS.zs[PARK_BAYS.target]!], yawDeg: 90, halfWidth: PARK_BAYS.width / 2, halfLength: PARK_BAYS.depth / 2 },
          maxYawDeg: 8,
          holdS: 1.5,
        },
        { type: 'damageCap', max: 0.015 },
        { type: 'timeLimit', seconds: 60, onExpire: 'fail' },
      ],
      scoring: { metric: 'park', better: 'higher', unit: 'pts', decimals: 0 },
      medals: { bronze: 500, silver: 650, gold: 780, crumple: 860 },
      botLine: [[332, PARK_BAYS.zs[PARK_BAYS.target]! - 4], [300, PARK_BAYS.zs[PARK_BAYS.target]!], [PARK_BAYS.x, PARK_BAYS.zs[PARK_BAYS.target]!]],
    },
    {
      id: 'stunt-jam',
      name: 'Stunt Jam',
      blurb: '75 seconds in the stunt park. Air, flips, drifts: chain them for points.',
      brief: 'Free run: the wreck jump, the kickers, the quarter-pipe and the drift pad are all yours. Airtime, height, every roll or flip and banked drifts score. Land it to keep it.',
      where: 'Stunt Park',
      icon: 'air',
      vehicle: { kind: 'choice' },
      spawn: { pos: [WRECK_JUMP.runStartX + 5, null, WRECK_JUMP.laneZ], yawDeg: -90 },
      traffic: 0,
      objectives: [
        { type: 'jump', minAirtimeS: 0.3 },
        { type: 'flips', axis: 'any' },
        { type: 'drift' },
        { type: 'timeLimit', seconds: 75, onExpire: 'finish' },
      ],
      scoring: { metric: 'stunt', better: 'higher', unit: 'pts', decimals: 0 },
      medals: { bronze: 300, silver: 900, gold: 1800, crumple: 3200 },
      botLine: [[WRECK_JUMP.runStartX + 5, WRECK_JUMP.laneZ], [WRECK_JUMP.landingX + 20, WRECK_JUMP.laneZ]],
    },
  ];
  return defs;
}
