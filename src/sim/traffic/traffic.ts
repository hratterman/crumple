/**
 * AI traffic simulation (P6, T1; worker-only): agents, driver model,
 * awake ⇄ ghost scheduler, recovery and respawns. docs/CONTRACTS.md "P6
 * contracts" (Decisions, Driver model, Awake budget) and
 * src/protocol/traffic.ts (record layout, flags, constants).
 *
 * TICK. `update(engine)` runs every TRAFFIC_AI_TICKS fixed ticks at the
 * START of a tick, before phase 1 (SimEngine.step): (1) the focus pose,
 * (2) awake agents measured from their frame nodes (pose, speed, path
 * tracking, wreck / stuck / off-route), (3) the moved props (obstacles),
 * (4) every live agent in index order: plan upkeep, lane change, leader,
 * junction yield, IDM, pure pursuit → ghost integration or the awake car's
 * ActionState, (5) the scheduler (recycle, demote, promote, respawn).
 * Deterministic: a pure function of (engine state, config, rng); the only
 * randomness is the config's seeded core/rng stream, consumed in agent
 * order; only + − × ÷ sqrt.
 *
 * GHOSTS integrate s += v·dt, v += a·dt (dt = TRAFFIC_AI_TICKS·SIM_DT) with
 * the same IDM and leaders; pose = routePose(plan[0], s) (+ a lane change's
 * decaying lateral offset). Snapshot records extrapolate s by v over the
 * ticks since the AI tick (presentation only).
 */
import type { SnapshotWriter } from '../../protocol/codec';
import { Action, isPropObjectId, PROP_DYNAMIC_ID_BASE, PROP_DYNAMIC_MAX, PROP_LAYOUT_ID_BASE } from '../../protocol/messages';
import {
  TRAFFIC_AI_TICKS,
  TRAFFIC_BUBBLE_DEFAULTS,
  TRAFFIC_CONTACT_M,
  TRAFFIC_FLAG_AWAKE,
  TRAFFIC_FLAG_BRAKE,
  TRAFFIC_FLAG_HORN,
  TRAFFIC_FLAG_HAZARD,
  TRAFFIC_FLAG_HEADLIGHTS,
  TRAFFIC_FLAG_INDICATOR_L,
  TRAFFIC_FLAG_INDICATOR_R,
  TRAFFIC_FLAG_TELEPORTED,
  TRAFFIC_FLAG_WRECKED,
  TRAFFIC_FLAG_YIELDING,
  TRAFFIC_ID_BASE,
  TRAFFIC_MAX_AGENTS,
  TRAFFIC_MAX_AWAKE,
  TRAFFIC_PLAYER_BASELINE_BEAMS,
  TRAFFIC_SPAWN_CONE_M,
  TRAFFIC_SPAWN_MIN_M,
  TRAFFIC_WRECK_DAMAGE,
  TrafficAiState,
  createTrafficAgentFrame,
  type TrafficAgentFrame,
  type TrafficBubble,
  type TrafficDensity,
} from '../../protocol/traffic';
import { createRng, type Rng } from '../../core/rng';
import {
  createRoutePose,
  createRouteSample,
  poseFromFrame,
  projectToRoute,
  sampleRoute,
} from '../../world/routes';
import { ROUTE_STATION_SPACING, ROUTE_STATION_STRIDE, type RouteNetwork, type RoutePath, type RoutePose } from '../../world/types';
import type { SimEngine } from '../engine';
import { SIM_OBJECT_FLAG_SLEEPING } from '../types';
import { computeDamage } from '../vehicle/runtime';
import {
  atanR,
  BRAKE_LAMP_MIN,
  CORRIDOR_MARGIN,
  CURVE_LAT_ACC,
  DEMOTE_MAX_DAMAGE,
  DEMOTE_SNAP_COS,
  DEMOTE_SNAP_M,
  GHOST_BRAKE_DECEL,
  IDM_B,
  idmAccel,
  INDICATOR_M,
  INDICATOR_S,
  JUNCTION_FOCUS_R,
  LANE_CHANGE_COOLDOWN_S,
  LANE_CHANGE_END_M,
  LANE_CHANGE_GAP_S,
  LANE_CHANGE_S,
  LOOKAHEAD_MIN_M,
  OFF_ROUTE_M,
  OFF_ROUTE_S,
  OVERTAKE_FRACTION,
  PI_HORIZON,
  PP_GAIN,
  PP_MAX,
  PP_MIN,
  PP_OFFSET,
  PROP_MOVED_M,
  SIGHT_COS,
  SIGHT_FAR_M,
  SIGHT_NEAR_M,
  smooth01,
  SPAWN_CONE_COS,
  SPAWN_SPACING_M,
  STEER_SLEW,
  STUCK_S,
  STUCK_SPEED,
  SWAP_MARGIN_M,
  TEMPERAMENT_T,
  TEMPERAMENT_V0,
  TURN_WEIGHT_LEFT,
  TURN_WEIGHT_RIGHT,
  TURN_WEIGHT_STRAIGHT,
  WRECK_UP_Y,
  YIELD_DEADLOCK_S,
  YIELD_HORIZON_S,
} from './model';
import { measurePose, spawnAtPose, type TrafficVariant } from './templates';

/** AI tick length, s. */
export const AI_DT = TRAFFIC_AI_TICKS / 2000;
/** Planned paths kept per agent (plan[0] = current). */
export const PLAN_LEN = 5;
const SP = ROUTE_STATION_SPACING;
const STRIDE = ROUTE_STATION_STRIDE;
const FAR = 1e12;
/** Cross-track integral gain (steer per m·s) and clamp. */
const LAT_KI = 0.002;
const LAT_I_MAX = 0.05;
/**
 * Understeer gradient of the traffic sedan, rad per m/s² of lateral
 * acceleration (step steer at 60 km/h: 0.255 rad/s yaw for 0.066 rad road
 * wheel → δ_us ≈ 0.024 rad at 4.3 m/s²). Pure pursuit alone settles
 * δ_us·L²/(2·wheelbase) outside a bend (≈ 2 m at 110 km/h).
 */
const UNDERSTEER_K = 0.0055;
/** Cruise throttle feed-forward ∝ v² (aero + rolling of a sedan in top gear ≈ 0.17 at 31 m/s). */
const CRUISE_FF = 0.00018;
/** A moved prop this far inside the front bumper line (m, negative) is already in contact: ignored as a leader. */
const OBSTACLE_TOUCH_M = -0.5;
/** The moved-prop scan runs every this many AI ticks (25 Hz). */
const OBSTACLE_EVERY = 4;
/** Throttle cap: (base + per_ms·v)·(1 − steer_k·|steer|). */
const THROTTLE_CAP_BASE = 0.35;
const THROTTLE_CAP_PER_MS = 0.06;
const THROTTLE_CAP_STEER = 0.6;

/** Connector priority (higher has right of way): through straight/right 3, through left 2, branch straight/right 1, branch left / U-turn 0. Lanes 4. */
function connectorPriority(net: RouteNetwork, p: RoutePath): number {
  if (p.kind === 'lane') return 4;
  if (p.turn === 'uturn') return 0;
  const j = net.junctions.find((x) => x.id === p.junction);
  const fromRoad = net.paths[p.prev[0]!]!.road;
  const through = j !== undefined && fromRoad === j.through;
  if (through) return p.turn === 'left' ? 2 : 3;
  return p.turn === 'left' ? 0 : 1;
}

export class TrafficAgent {
  alive = false;
  /** Retiring (density lowered): an awake car leaves once out of sight. */
  retiring = false;
  variant = 0;
  paint = 0;
  awake = false;
  objectId = 0;
  readonly plan = new Int32Array(PLAN_LEN);
  s = 0;
  v = 0;
  /** Last commanded acceleration, m/s². */
  a = 0;
  v0Scale = 1;
  T = 1.4;
  steer = 0;
  brakeLamp = 0;
  state: number = TrafficAiState.cruise;
  yielding = false;
  /** Connector index the agent committed to entering (−1 none). */
  committed = -1;
  waitS = 0;
  // lane change
  lcActive = false;
  lcFrom = -1;
  lcOffset0 = 0;
  lcT = 0;
  lcDir = 0;
  lcCooldown = 0;
  /** P8 horn: seconds left honking, cooldown, time held up by a stopped focus (AI ticks). */
  honkS = 0;
  honkCool = 0;
  blockedS = 0;
  // awake
  piI = 0;
  /** Cross-track integral (steer units). */
  steerI = 0;
  stuckS = 0;
  offS = 0;
  damage = 0;
  wrecked = false;
  stuck = false;
  /** Tool / test hook: brake to a stop and stand parked (exempt from the stuck rule). */
  hold = false;
  /** Diagnostics: why the agent was last flagged wrecked ('' = not). */
  wreckReason = '';
  /** Respawns so far (diagnostics). */
  respawns = 0;
  latErr = 0;
  // pose (last AI tick; awake: measured)
  readonly pos: [number, number, number] = [0, 0, 0];
  readonly quat: [number, number, number, number] = [0, 0, 0, 1];
  /** forward xyz, up xyz (world). */
  readonly frame = new Float64Array(6);
  teleported = false;
  /** Leader gap (m) and speed of the last tick (diagnostics / state). */
  gap = FAR;
  leaderV = 0;
  /** Desired speed of the last tick, m/s. */
  v0 = 0;
  constructor(readonly index: number) {}
}

export interface TrafficSetup {
  seed: number;
  variants: TrafficVariant[];
  density: TrafficDensity;
  focusObjectId: number;
  bubble?: TrafficBubble;
}

/** Focus (player) state per AI tick. */
interface Focus {
  present: boolean;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  speed: number;
  beams: number;
  /** Footprint corners (4) + centre, plan xz. */
  pts: Float64Array;
}

export class TrafficSim {
  readonly agents: TrafficAgent[] = [];
  density: TrafficDensity;
  readonly bubble: TrafficBubble;
  readonly focusObjectId: number;
  readonly rng: Rng;
  /** Per path: right-of-way priority, lane half width, highway flag, junction index (connectors). */
  private readonly prio: Int8Array;
  private readonly laneHalfW: Float64Array;
  private readonly highway: Uint8Array;
  private readonly junctionOf: Int32Array;
  /** Per path, per station: curve speed envelope (see the constructor). */
  private readonly curveEnv: Float64Array[];
  /** Cumulative lane lengths (spawn sampling). */
  private readonly laneCum: Float64Array;
  private readonly maxVariantBeams: number;
  private readonly weightSum: number;
  private readonly focus: Focus = { present: false, x: 0, y: 0, z: 0, fx: 0, fz: -1, speed: 0, beams: 0, pts: new Float64Array(10) };
  /** Node 0 of every prop where traffic first saw it (moved test). */
  private readonly propRest = new Float64Array(3 * (PROP_DYNAMIC_ID_BASE + PROP_DYNAMIC_MAX - PROP_LAYOUT_ID_BASE));
  /** Moved props: plan boxes (x0, z0, x1, z1) and count. */
  private obstacles = new Float64Array(64);
  private obstacleCount = 0;
  /** The engine this sim drives (set by init; tool hooks only). */
  private eng: SimEngine | null = null;
  /** AI ticks run so far. */
  private aiTicks = 0;
  /** Last AI tick (engine tick) for record extrapolation. */
  lastAiTick = 0;
  /** Effective awake cap of the last scheduler tick (pool rule). */
  effectiveMaxAwake = 0;
  // Path occupancy (per AI tick): agents on each path (plan[0]) and lane-changers by their origin lane;
  // singly linked lists in ascending agent index.
  private readonly occHead: Int32Array;
  private readonly lcHead: Int32Array;
  private readonly occNext = new Int32Array(TRAFFIC_MAX_AGENTS);
  private readonly lcNext = new Int32Array(TRAFFIC_MAX_AGENTS);
  // scratch
  private readonly base = new Float64Array(PLAN_LEN + 1);
  private readonly baseB = new Float64Array(PLAN_LEN + 1);
  private readonly order: number[] = [];
  private readonly dist2: Float64Array = new Float64Array(TRAFFIC_MAX_AGENTS);
  private readonly proj = { s: 0, d: 0, dist: 0 };
  private readonly proj2 = { s: 0, d: 0, dist: 0 };
  private readonly smp = createRouteSample();
  private readonly pose: RoutePose = createRoutePose();
  private readonly rec: TrafficAgentFrame = createTrafficAgentFrame();
  private readonly tmpPos: [number, number, number] = [0, 0, 0];
  private readonly tmpQuat: [number, number, number, number] = [0, 0, 0, 1];
  private readonly tmpFrame = new Float64Array(6);

  constructor(
    readonly net: RouteNetwork,
    readonly variants: TrafficVariant[],
    setup: TrafficSetup,
  ) {
    this.density = clampDensity(setup.density);
    this.bubble = setup.bubble ?? { ...TRAFFIC_BUBBLE_DEFAULTS };
    this.focusObjectId = setup.focusObjectId;
    this.rng = createRng(setup.seed >>> 0);
    const n = net.paths.length;
    this.prio = new Int8Array(n);
    this.laneHalfW = new Float64Array(n);
    this.highway = new Uint8Array(n);
    this.junctionOf = new Int32Array(n).fill(-1);
    for (const p of net.paths) {
      this.prio[p.index] = connectorPriority(net, p);
      this.laneHalfW[p.index] = p.kind === 'lane' && p.lane >= 0 ? Math.abs(p.offset) / (p.lane + 0.5) / 2 : 1.75;
      this.highway[p.index] = p.kind === 'lane' && p.road === 'highway' && (p.left >= 0 || p.right >= 0) ? 1 : 0;
      if (p.junction !== null && p.kind === 'connector') this.junctionOf[p.index] = net.junctions.findIndex((j) => j.id === p.junction);
    }
    // Curve envelopes: per station the highest speed from which every curve later on the same path can
    // be taken at CURVE_LAT_ACC after braking at IDM_B (backward pass of sqrt(v² + 2·b·Δs)).
    this.curveEnv = net.paths.map((p) => {
      const n = p.stationCount;
      const env = new Float64Array(n);
      let next = FAR;
      for (let i = n - 1; i >= 0; i--) {
        const kap = Math.abs(p.stations[i * STRIDE + 7]!);
        let vc = kap > 1e-5 ? Math.sqrt(CURVE_LAT_ACC / kap) : FAR;
        if (i < n - 1 && next < FAR) {
          const ds = (i + 1 === n - 1 ? p.length : (i + 1) * SP) - i * SP;
          const vb = Math.sqrt(next * next + 2 * IDM_B * ds);
          if (vb < vc) vc = vb;
        }
        env[i] = vc;
        next = vc;
      }
      return env;
    });
    this.occHead = new Int32Array(n).fill(-1);
    this.lcHead = new Int32Array(n).fill(-1);
    this.laneCum = new Float64Array(net.laneCount + 1);
    for (let i = 0; i < net.laneCount; i++) this.laneCum[i + 1] = this.laneCum[i]! + net.paths[i]!.length;
    let mb = 0;
    let ws = 0;
    for (const v of variants) {
      mb = Math.max(mb, v.beams);
      ws += v.weight;
    }
    this.maxVariantBeams = mb;
    this.weightSum = ws;
    for (let i = 0; i < TRAFFIC_MAX_AGENTS; i++) this.agents.push(new TrafficAgent(i));
  }

  /** Places the initial ghosts (respawn rule). Call once after construction with the engine's focus. */
  init(eng: SimEngine): void {
    this.eng = eng;
    this.measureFocus(eng);
    for (let i = 0; i < this.density.agents; i++) this.respawn(this.agents[i]!);
    this.lastAiTick = eng.tick;
  }

  get agentCount(): number {
    let n = 0;
    for (const a of this.agents) if (a.alive) n++;
    return n;
  }

  get awakeCount(): number {
    let n = 0;
    for (const a of this.agents) if (a.alive && a.awake) n++;
    return n;
  }

  /** Retunes the density (protocol setTrafficDensity); takes effect at the next AI tick. */
  setDensity(d: TrafficDensity): void {
    this.density = clampDensity(d);
  }

  /** Removes every awake traffic object (full restart / traffic off). */
  clear(eng: SimEngine): void {
    for (const a of this.agents) {
      if (a.awake && eng.arena.get(a.objectId)) eng.despawn(a.objectId);
      a.awake = false;
      a.alive = false;
    }
  }

  // ================================================================== AI tick
  update(eng: SimEngine): void {
    this.lastAiTick = eng.tick;
    this.measureFocus(eng);
    for (const a of this.agents) if (a.alive && a.awake) this.trackAwake(eng, a);
    // Moved props change slowly: refreshed every OBSTACLE_EVERY AI ticks.
    if (this.aiTicks++ % OBSTACLE_EVERY === 0) this.collectObstacles(eng);
    this.buildOccupancy();
    for (const a of this.agents) if (a.alive) this.drive(eng, a);
    this.schedule(eng);
  }

  /** Rebuilds the per-path agent lists from the agents' current paths. */
  private buildOccupancy(): void {
    this.occHead.fill(-1);
    this.lcHead.fill(-1);
    for (let i = TRAFFIC_MAX_AGENTS - 1; i >= 0; i--) {
      const a = this.agents[i]!;
      if (!a.alive) continue;
      const p = a.plan[0]!;
      this.occNext[i] = this.occHead[p]!;
      this.occHead[p] = i;
      if (a.lcActive && a.lcFrom >= 0) {
        this.lcNext[i] = this.lcHead[a.lcFrom]!;
        this.lcHead[a.lcFrom] = i;
      }
    }
  }

  // ------------------------------------------------------------ focus / obstacles
  private measureFocus(eng: SimEngine): void {
    const f = this.focus;
    const obj = eng.arena.get(this.focusObjectId);
    f.present = obj !== undefined;
    if (!obj) return;
    const s = eng.state;
    const veh = eng.getVehicle(this.focusObjectId);
    let ox: number;
    let oy: number;
    let oz: number;
    let fx = 0;
    let fz = -1;
    let speed = 0;
    if (veh) {
      const fr = veh.vehicle.frameNodes;
      const o = obj.nodeStart + fr[0]!;
      const fn = obj.nodeStart + fr[1]!;
      ox = s.posX[o]!;
      oy = s.posY[o]!;
      oz = s.posZ[o]!;
      fx = s.posX[fn]! - ox;
      fz = s.posZ[fn]! - oz;
      const l = Math.sqrt(fx * fx + fz * fz);
      if (l > 1e-6) {
        fx /= l;
        fz /= l;
      } else {
        fx = 0;
        fz = -1;
      }
      speed = s.velX[o]! * fx + s.velZ[o]! * fz;
    } else {
      ox = 0;
      oy = 0;
      oz = 0;
      for (let i = 0; i < obj.nodeCount; i++) {
        ox += s.posX[obj.nodeStart + i]!;
        oy += s.posY[obj.nodeStart + i]!;
        oz += s.posZ[obj.nodeStart + i]!;
      }
      ox /= obj.nodeCount;
      oy /= obj.nodeCount;
      oz /= obj.nodeCount;
    }
    // Footprint in the heading frame (plan): min/max along / across over the nodes.
    const rx = -fz;
    const rz = fx;
    let a0 = 0;
    let a1 = 0;
    let l0 = 0;
    let l1 = 0;
    for (let i = obj.nodeStart; i < obj.nodeStart + obj.nodeCount; i++) {
      const dx = s.posX[i]! - ox;
      const dz = s.posZ[i]! - oz;
      const al = dx * fx + dz * fz;
      const la = dx * rx + dz * rz;
      if (al < a0) a0 = al;
      if (al > a1) a1 = al;
      if (la < l0) l0 = la;
      if (la > l1) l1 = la;
    }
    const p = f.pts;
    p[0] = ox + fx * a1 + rx * l0;
    p[1] = oz + fz * a1 + rz * l0;
    p[2] = ox + fx * a1 + rx * l1;
    p[3] = oz + fz * a1 + rz * l1;
    p[4] = ox + fx * a0 + rx * l0;
    p[5] = oz + fz * a0 + rz * l0;
    p[6] = ox + fx * a0 + rx * l1;
    p[7] = oz + fz * a0 + rz * l1;
    p[8] = ox;
    p[9] = oz;
    f.x = ox;
    f.y = oy;
    f.z = oz;
    f.fx = fx;
    f.fz = fz;
    f.speed = speed;
    f.beams = obj.beamCount;
  }

  /**
   * Props knocked away from where traffic first saw them (awake or asleep
   * where they lie) are lane obstacles. A sleeping prop at its first-seen
   * spot costs one node read per AI tick.
   */
  private collectObstacles(eng: SimEngine): void {
    this.obstacleCount = 0;
    const s = eng.state;
    const objs = eng.arena.objects;
    const seen = this.propRest;
    for (let o = 0; o < objs.length; o++) {
      const obj = objs[o]!;
      if (!isPropObjectId(obj.objectId)) continue;
      const i0 = obj.nodeStart;
      const r = obj.objectId - PROP_LAYOUT_ID_BASE;
      if (seen[3 * r + 2] !== obj.nodeCount) {
        seen[3 * r] = s.posX[i0]!;
        seen[3 * r + 1] = s.posZ[i0]!;
        seen[3 * r + 2] = obj.nodeCount;
      }
      const dx0 = s.posX[i0]! - seen[3 * r]!;
      const dz0 = s.posZ[i0]! - seen[3 * r + 1]!;
      if (dx0 * dx0 + dz0 * dz0 < PROP_MOVED_M * PROP_MOVED_M) continue;
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = i0; i < i0 + obj.nodeCount; i++) {
        const x = s.posX[i]!;
        const z = s.posZ[i]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      if (this.obstacleCount * 4 + 4 > this.obstacles.length) {
        const g = new Float64Array(this.obstacles.length * 2);
        g.set(this.obstacles);
        this.obstacles = g;
      }
      const w = this.obstacleCount * 4;
      this.obstacles[w] = x0;
      this.obstacles[w + 1] = z0;
      this.obstacles[w + 2] = x1;
      this.obstacles[w + 3] = z1;
      this.obstacleCount++;
    }
  }

  // ------------------------------------------------------------ awake tracking
  private trackAwake(eng: SimEngine, a: TrafficAgent): void {
    const veh = eng.getVehicle(a.objectId);
    if (!veh) {
      // Despawned under us (should not happen): back to a pending respawn.
      a.awake = false;
      a.alive = false;
      return;
    }
    const variant = this.variants[a.variant]!;
    const s = eng.state;
    if (!measurePose(s, veh, variant, a.pos, a.quat, a.frame)) {
      a.wrecked = true;
      a.wreckReason = 'frame';
      return;
    }
    // Speed along the heading: mean velocity of the frame nodes.
    const fr = veh.vehicle.frameNodes;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (let k = 0; k < 3; k++) {
      const i = veh.nodeStart + fr[k]!;
      vx += s.velX[i]!;
      vy += s.velY[i]!;
      vz += s.velZ[i]!;
    }
    a.v = (vx * a.frame[0]! + vy * a.frame[1]! + vz * a.frame[2]!) / 3;
    // Path tracking: project the rig origin, advancing through the plan.
    const pr = this.proj;
    let path = this.net.paths[a.plan[0]!]!;
    projectToRoute(path, a.pos[0], a.pos[2], pr, a.s);
    let guard = 0;
    while (pr.s >= path.length - 0.05 && guard++ < PLAN_LEN - 1) {
      const next = this.net.paths[a.plan[1]!]!;
      projectToRoute(next, a.pos[0], a.pos[2], this.proj2, 0);
      if (this.proj2.dist > pr.dist + 0.5) break;
      this.advancePlan(a);
      path = next;
      pr.s = this.proj2.s;
      pr.d = this.proj2.d;
      pr.dist = this.proj2.dist;
    }
    a.s = pr.s;
    const lc = a.lcActive ? a.lcOffset0 * (1 - smooth01(a.lcT / LANE_CHANGE_S)) : 0;
    a.latErr = pr.d - lc;
    a.offS = Math.abs(a.latErr) > OFF_ROUTE_M ? a.offS + AI_DT : 0;
    a.damage = computeDamage(s, veh);
    const upY = a.frame[4]!;
    if (!a.wrecked) {
      if (a.damage > TRAFFIC_WRECK_DAMAGE) a.wreckReason = 'damage';
      else if (upY < WRECK_UP_Y) a.wreckReason = 'upside';
      else if (a.offS > OFF_ROUTE_S) a.wreckReason = 'offroute';
      if (a.wreckReason !== '') a.wrecked = true;
    }
  }

  // ------------------------------------------------------------ plan
  private pickNext(from: number): number {
    const p = this.net.paths[from]!;
    const nx = p.next;
    if (nx.length === 1) return nx[0]!;
    let sum = 0;
    for (const n of nx) sum += turnWeight(this.net.paths[n]!);
    let r = this.rng.float() * sum;
    for (const n of nx) {
      r -= turnWeight(this.net.paths[n]!);
      if (r < 0) return n;
    }
    return nx[nx.length - 1]!;
  }

  /** Re-fills plan[1..] from plan[0]. */
  private replan(a: TrafficAgent): void {
    for (let k = 1; k < PLAN_LEN; k++) a.plan[k] = this.pickNext(a.plan[k - 1]!);
  }

  private advancePlan(a: TrafficAgent): void {
    for (let k = 0; k + 1 < PLAN_LEN; k++) a.plan[k] = a.plan[k + 1]!;
    a.plan[PLAN_LEN - 1] = this.pickNext(a.plan[PLAN_LEN - 2]!);
    const p = this.net.paths[a.plan[0]!]!;
    if (p.kind === 'lane') {
      a.committed = -1;
      a.waitS = 0;
    } else if (a.committed !== p.index) {
      a.committed = p.index;
    }
  }

  /** base[k] = distance from the agent to the start of plan[k] (base[0] = −s). */
  private fillBase(a: TrafficAgent, base: Float64Array): void {
    base[0] = -a.s;
    for (let k = 1; k <= PLAN_LEN; k++) base[k] = base[k - 1]! + this.net.paths[a.plan[k - 1]!]!.length;
  }

  // ------------------------------------------------------------ driver
  private drive(eng: SimEngine, a: TrafficAgent): void {
    const net = this.net;
    const variant = this.variants[a.variant]!;
    const v = a.v > 0 ? a.v : 0;
    const base = this.base;
    this.fillBase(a, base);
    const look = LOOKAHEAD_MIN_M + (v * v) / (2 * IDM_B) + 2 * v;

    // ---- desired speed: speed limits and curves ahead with braking distance
    // (per-path curve envelopes precomputed; O(plan) per tick).
    let vAllowed = this.envelopeAt(a.plan[0]!, a.s);
    const lim0 = net.paths[a.plan[0]!]!.speedLimit * a.v0Scale;
    if (lim0 < vAllowed) vAllowed = lim0;
    for (let k = 1; k < PLAN_LEN; k++) {
      const d = base[k]!;
      if (d > look) break;
      const p = net.paths[a.plan[k]!]!;
      let vl = p.speedLimit * a.v0Scale;
      const ce = this.curveEnv[p.index]![0]!;
      if (ce < vl) vl = ce;
      const al = Math.sqrt(vl * vl + 2 * IDM_B * (d > 0 ? d : 0));
      if (al < vAllowed) vAllowed = al;
    }
    const v0 = vAllowed;
    a.v0 = v0;

    // ---- leader: agents on the plan, the focus and moved props in the lane corridor.
    let gap = FAR;
    let vLead = 0;
    for (let k = 0; k < PLAN_LEN; k++) {
      if (base[k]! > look) break;
      const pk = a.plan[k]!;
      for (let pass = 0; pass < 2; pass++) {
        let j = pass === 0 ? this.occHead[pk]! : this.lcHead[pk]!;
        for (; j >= 0; j = pass === 0 ? this.occNext[j]! : this.lcNext[j]!) {
          const b = this.agents[j]!;
          if (b === a || !b.alive) continue;
          // The lists are built at the tick start; skip an agent that moved on during this pass.
          if (pass === 0 ? b.plan[0] !== pk : !(b.lcActive && b.lcFrom === pk)) continue;
          const ds = base[k]! + b.s;
          if (ds <= 0) continue;
          const g = ds - variant.front - this.variants[b.variant]!.rear;
          if (g < gap) {
            gap = g;
            vLead = b.v > 0 ? b.v : 0;
          }
        }
      }
      // Anything on a later plan path is farther than everything on this one.
      if (gap < FAR) break;
    }
    const f = this.focus;
    let focusLead = false;
    if (f.present) {
      const dx = f.x - a.pos[0];
      const dz = f.z - a.pos[2];
      if (dx * dx + dz * dz < (look + 15) * (look + 15)) {
        const g = this.corridorGap(a, base, look, f.pts, 5, variant.front);
        if (g < gap) {
          focusLead = true;
          gap = g;
          const p = net.paths[a.plan[0]!]!;
          sampleRoute(p, a.s, this.smp);
          const along = f.speed * (f.fx * this.smp.tx + f.fz * this.smp.tz);
          vLead = along > 0 ? along : 0;
        }
      }
    }
    for (let o = 0; o < this.obstacleCount; o++) {
      const w = o * 4;
      const ob = this.obstacles;
      const cx = (ob[w]! + ob[w + 2]!) / 2;
      const cz = (ob[w + 1]! + ob[w + 3]!) / 2;
      const dx = cx - a.pos[0];
      const dz = cz - a.pos[2];
      if (dx * dx + dz * dz > (look + 5) * (look + 5)) continue;
      const pts = this.boxPts(ob[w]!, ob[w + 1]!, ob[w + 2]!, ob[w + 3]!);
      const g = this.corridorGap(a, base, look, pts, 5, variant.front);
      // Already under / against the bumper (pushed along or driven over): not a reason to stop for good.
      if (g < OBSTACLE_TOUCH_M) continue;
      if (g < gap) {
        gap = g;
        vLead = 0;
      }
    }
    a.gap = gap;
    a.leaderV = vLead;

    // ---- junction yield (the first yielding connector ahead not yet committed).
    a.yielding = false;
    for (let k = 0; k < PLAN_LEN; k++) {
      if (base[k]! > look + 20) break;
      const p = net.paths[a.plan[k]!]!;
      if (p.kind !== 'connector' || !p.yield || a.committed === p.index) continue;
      if (k === 0) {
        a.committed = p.index;
        break;
      }
      const toLine = base[k]! - variant.front;
      const stopDist = (v * v) / (2 * IDM_B) + 10;
      if (toLine > stopDist) break;
      const clear = a.waitS > YIELD_DEADLOCK_S ? this.junctionPhysicallyClear(a, p) : this.junctionClear(a, p);
      if (clear) {
        a.committed = p.index;
        a.waitS = 0;
      } else {
        a.yielding = true;
        const g = toLine - 1;
        if (g < gap) {
          gap = g;
          vLead = 0;
        }
        if (v < 1) a.waitS += AI_DT;
      }
      break;
    }

    // ---- lane change (highway).
    if (a.lcActive) {
      a.lcT += AI_DT;
      if (a.lcT >= LANE_CHANGE_S) {
        a.lcActive = false;
        a.lcDir = 0;
        a.lcCooldown = LANE_CHANGE_COOLDOWN_S;
      }
    } else if (a.lcCooldown > 0) {
      a.lcCooldown -= AI_DT;
    } else if (!a.wrecked && this.highway[a.plan[0]!] === 1) {
      this.considerLaneChange(eng, a, gap, vLead, v0);
    }

    // ---- IDM.
    let acc = idmAccel(v, v0, a.T, gap, vLead);
    if (a.wrecked || a.stuck || a.hold) acc = -IDM_B;
    a.a = acc;

    // ---- P8 horn: the focus (player) cuts in / brakes in front (a hard brake forced by it), or blocks
    // the lane while stopped for 2.5 s. Brief, at most every 8 s per agent; pure AI state (deterministic).
    if (a.honkS > 0) a.honkS -= AI_DT;
    if (a.honkCool > 0) a.honkCool -= AI_DT;
    a.blockedS = focusLead && v < 0.5 && gap < 12 ? a.blockedS + AI_DT : 0;
    if (focusLead && !a.wrecked && a.honkCool <= 0 && ((acc < -3 && v > 3 && gap < 25) || a.blockedS > 2.5)) {
      a.honkS = a.blockedS > 2.5 ? 0.9 : 0.45;
      a.honkCool = 8;
      a.blockedS = 0;
    }

    if (!a.awake) {
      // Ghost: kinematic route follower.
      let nv = v + acc * AI_DT;
      if (nv < 0) nv = 0;
      a.v = nv;
      a.s += nv * AI_DT;
      let guard = 0;
      while (a.s > net.paths[a.plan[0]!]!.length && guard++ < PLAN_LEN) {
        a.s -= net.paths[a.plan[0]!]!.length;
        this.advancePlan(a);
      }
      const p = net.paths[a.plan[0]!]!;
      sampleRoute(p, a.s, this.smp);
      a.steer = steerFromCurvature(this.smp.curvature, variant);
      a.brakeLamp = acc <= -GHOST_BRAKE_DECEL ? 1 : 0;
      // Position only (the quaternion is built when a record is written / at promotion).
      this.ghostPosition(a);
    } else {
      this.driveAwake(eng, a, acc, variant);
    }
    a.state = this.aiState(a);
  }

  /** Curve envelope of `path` at arc s (the next station's value braked back to s). */
  private envelopeAt(path: number, s: number): number {
    const env = this.curveEnv[path]!;
    const p = this.net.paths[path]!;
    let i = Math.floor(s / SP);
    if (i < 0) i = 0;
    if (i >= p.stationCount - 1) return env[p.stationCount - 1]!;
    const a = env[i]!;
    const nx = env[i + 1]!;
    if (nx >= FAR) return a;
    const ds = (i + 1 === p.stationCount - 1 ? p.length : (i + 1) * SP) - s;
    const vb = Math.sqrt(nx * nx + 2 * IDM_B * (ds > 0 ? ds : 0));
    return vb < a ? vb : a;
  }

  /** Smallest bumper gap to a footprint (pts: n plan points) inside the lane corridor along the plan; FAR if none. */
  private corridorGap(a: TrafficAgent, base: Float64Array, look: number, pts: Float64Array, n: number, front: number): number {
    const pr = this.proj2;
    let best = FAR;
    for (let k = 0; k < PLAN_LEN; k++) {
      if (base[k]! > look) break;
      const p = this.net.paths[a.plan[k]!]!;
      const hw = this.laneHalfW[p.index]! + CORRIDOR_MARGIN;
      let sMin = FAR;
      for (let i = 0; i < n; i++) {
        const x = pts[2 * i]!;
        const z = pts[2 * i + 1]!;
        const ax = x - a.pos[0];
        const az = z - a.pos[2];
        const hint = Math.sqrt(ax * ax + az * az) - base[k]!;
        projectToRoute(p, x, z, pr, hint, 24);
        if (pr.s <= 0 || pr.s >= p.length) continue;
        if (pr.d > hw || pr.d < -hw) continue;
        if (pr.s < sMin) sMin = pr.s;
      }
      if (sMin < FAR) {
        const ds = base[k]! + sMin;
        if (ds > 0) {
          const g = ds - front;
          if (g < best) best = g;
        }
        break;
      }
    }
    return best;
  }

  private boxScratch = new Float64Array(10);
  private boxPts(x0: number, z0: number, x1: number, z1: number): Float64Array {
    const p = this.boxScratch;
    p[0] = x0;
    p[1] = z0;
    p[2] = x1;
    p[3] = z0;
    p[4] = x0;
    p[5] = z1;
    p[6] = x1;
    p[7] = z1;
    p[8] = (x0 + x1) / 2;
    p[9] = (z0 + z1) / 2;
    return p;
  }

  /** No higher-priority conflicting agent inside the junction box within YIELD_HORIZON_S, and the focus not in / about to enter it. */
  private junctionClear(a: TrafficAgent, c: RoutePath): boolean {
    const pr = this.prio[c.index]!;
    for (const ci of c.conflicts) {
      const po = this.prio[ci]!;
      if (po < pr || (po === pr && ci > c.index)) continue;
      for (const b of this.agents) {
        if (b === a || !b.alive) continue;
        let m = -1;
        for (let k = 0; k < PLAN_LEN; k++) {
          if (b.plan[k] === ci) {
            m = k;
            break;
          }
        }
        if (m < 0) continue;
        if (m === 0) return false;
        this.fillBase(b, this.baseB);
        const eta = this.baseB[m]! / (b.v > 0.5 ? b.v : 0.5);
        if (eta < YIELD_HORIZON_S) return false;
      }
    }
    return this.focusClearOf(c, true);
  }

  /** Deadlock breaker: nobody ON a conflicting connector, focus not in the box. */
  private junctionPhysicallyClear(a: TrafficAgent, c: RoutePath): boolean {
    for (const ci of c.conflicts) {
      for (const b of this.agents) {
        if (b !== a && b.alive && b.plan[0] === ci) return false;
      }
    }
    return this.focusClearOf(c, false);
  }

  private focusClearOf(c: RoutePath, approaching: boolean): boolean {
    const f = this.focus;
    const ji = this.junctionOf[c.index]!;
    if (!f.present || ji < 0) return true;
    const j = this.net.junctions[ji]!;
    const dx = j.pos[0] - f.x;
    const dz = j.pos[1] - f.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < JUNCTION_FOCUS_R) return false;
    if (!approaching || d < 1e-6) return true;
    const toward = (f.speed * (f.fx * dx + f.fz * dz)) / d;
    return !(toward > 1 && (d - JUNCTION_FOCUS_R) / toward < YIELD_HORIZON_S);
  }

  private considerLaneChange(eng: SimEngine, a: TrafficAgent, gap: number, vLead: number, v0: number): void {
    const p = this.net.paths[a.plan[0]!]!;
    if (p.length - a.s < LANE_CHANGE_END_M) return;
    let target = -1;
    if (p.right >= 0 && this.laneFree(a, p, this.net.paths[p.right]!)) target = p.right;
    else if (p.left >= 0 && gap < 60 && vLead < OVERTAKE_FRACTION * v0 && a.v > 5 && this.laneFree(a, p, this.net.paths[p.left]!)) target = p.left;
    if (target < 0) return;
    const t = this.net.paths[target]!;
    const sOn = (a.s * t.length) / p.length;
    a.lcActive = true;
    a.lcFrom = p.index;
    a.lcT = 0;
    a.lcDir = target === p.right ? 1 : -1;
    // Lateral of the old lane in the new lane's path frame (+ = right of travel).
    a.lcOffset0 = (p.offset - t.offset) * t.dir;
    if (a.awake) {
      projectToRoute(t, a.pos[0], a.pos[2], this.proj2, sOn);
      a.s = this.proj2.s;
      a.lcOffset0 = this.proj2.d;
    } else {
      a.s = sOn;
    }
    a.plan[0] = target;
    this.replan(a);
    void eng;
  }

  /** Gap ≥ LANE_CHANGE_GAP_S both ways on lane `t` (agents and the focus). */
  private laneFree(a: TrafficAgent, p: RoutePath, t: RoutePath): boolean {
    const sOn = (a.s * t.length) / p.length;
    const va = this.variants[a.variant]!;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = pass === 0 ? this.occHead[t.index]! : this.lcHead[t.index]!; j >= 0; j = pass === 0 ? this.occNext[j]! : this.lcNext[j]!) {
      const b = this.agents[j]!;
      if (b === a || !b.alive) continue;
      if (pass === 0 ? b.plan[0] !== t.index : !(b.lcActive && b.lcFrom === t.index)) continue;
      const vb = this.variants[b.variant]!;
      const ds = b.s - sOn;
      if (ds >= 0) {
        if (ds - va.front - vb.rear < Math.max(LANE_CHANGE_GAP_S * a.v, 8)) return false;
      } else if (-ds - vb.front - va.rear < Math.max(LANE_CHANGE_GAP_S * b.v, 8)) return false;
      }
    }
    const f = this.focus;
    if (f.present) {
      const dx = f.x - a.pos[0];
      const dz = f.z - a.pos[2];
      const r = Math.max(LANE_CHANGE_GAP_S * Math.max(a.v, f.speed), 8) + 6;
      if (dx * dx + dz * dz < r * r) {
        projectToRoute(t, f.x, f.z, this.proj2, sOn);
        if (Math.abs(this.proj2.d) < this.laneHalfW[t.index]! + 1.5) return false;
      }
    }
    return true;
  }

  /** Ghost position (pos only) from the last sampleRoute of plan[0] at a.s (this.smp), + lane-change offset. */
  private ghostPosition(a: TrafficAgent): void {
    const q = this.smp;
    let x = q.x;
    let z = q.z;
    if (a.lcActive) {
      const off = a.lcOffset0 * (1 - smooth01(a.lcT / LANE_CHANGE_S));
      const hl = Math.sqrt(q.tx * q.tx + q.tz * q.tz);
      if (hl > 1e-9) {
        x += (-q.tz / hl) * off;
        z += (q.tx / hl) * off;
      }
    }
    a.pos[0] = x;
    a.pos[1] = q.y;
    a.pos[2] = z;
  }

  /** Ghost / record pose at arc s on plan[0] (+ lane-change offset). */
  private ghostPose(a: TrafficAgent, s: number, pos: [number, number, number], quat: [number, number, number, number], lcT = a.lcT): void {
    const p = this.net.paths[a.plan[0]!]!;
    const q = sampleRoute(p, s, this.smp);
    let x = q.x;
    let z = q.z;
    if (a.lcActive) {
      const off = a.lcOffset0 * (1 - smooth01(lcT / LANE_CHANGE_S));
      const hl = Math.sqrt(q.tx * q.tx + q.tz * q.tz);
      if (hl > 1e-9) {
        x += (-q.tz / hl) * off;
        z += (q.tx / hl) * off;
      }
    }
    poseFromFrame(x, q.y, z, q.tx, q.ty, q.tz, q.bank, this.pose);
    pos[0] = this.pose.pos[0];
    pos[1] = this.pose.pos[1];
    pos[2] = this.pose.pos[2];
    quat[0] = this.pose.quat[0];
    quat[1] = this.pose.quat[1];
    quat[2] = this.pose.quat[2];
    quat[3] = this.pose.quat[3];
  }

  /** Pure pursuit + speed PI → the awake car's ActionState. */
  private driveAwake(eng: SimEngine, a: TrafficAgent, acc: number, variant: TrafficVariant): void {
    const obj = eng.arena.get(a.objectId);
    if (!obj) return;
    const v = a.v;
    const fx = a.frame[0]!;
    const fz = a.frame[2]!;
    // Rear-axle reference point (rig-local z = rearAxleZ behind the origin).
    const rax = a.pos[0] - fx * variant.rearAxleZ;
    const raz = a.pos[2] - fz * variant.rearAxleZ;
    const L = clamp(PP_GAIN * (v > 0 ? v : 0) + PP_OFFSET, PP_MIN, PP_MAX);
    // Target: the plan point L ahead of the car's projection (+ lane-change offset at that time).
    let k = 0;
    let st = a.s + L;
    while (k < PLAN_LEN - 1 && st > this.net.paths[a.plan[k]!]!.length) {
      st -= this.net.paths[a.plan[k]!]!.length;
      k++;
    }
    const tp = this.net.paths[a.plan[k]!]!;
    const q = sampleRoute(tp, st, this.smp);
    let tx = q.x;
    let tz = q.z;
    if (a.lcActive && k === 0) {
      const off = a.lcOffset0 * (1 - smooth01((a.lcT + L / Math.max(v, 3)) / LANE_CHANGE_S));
      const hl = Math.sqrt(q.tx * q.tx + q.tz * q.tz);
      if (hl > 1e-9) {
        tx += (-q.tz / hl) * off;
        tz += (q.tx / hl) * off;
      }
    }
    const dx = tx - rax;
    const dz = tz - raz;
    const d2 = dx * dx + dz * dz;
    // Right of the car (plan) = (−fz, fx).
    const y = dx * -fz + dz * fx;
    const fwd = dx * fx + dz * fz;
    let target: number;
    if (fwd <= 0.1) target = y >= 0 ? 1 : -1;
    else {
      const kap = (2 * y) / (d2 > 1 ? d2 : 1);
      // + understeer feed-forward δ_us = K_us·a_y (a_y = v²·κ).
      target = (atanR(kap * variant.wheelbase) + UNDERSTEER_K * v * v * kap) / variant.maxSteerRad;
    }
    // Cross-track integral (the car's steady-state understeer on long bends; pure pursuit alone ran 2 m wide at 110 km/h).
    if (!a.lcActive && v > 3) {
      a.steerI -= LAT_KI * a.latErr * AI_DT;
      a.steerI = clamp(a.steerI, -LAT_I_MAX, LAT_I_MAX);
    } else a.steerI *= 0.98;
    target = clamp(target + a.steerI, -1, 1);
    const ds = target - a.steer;
    const lim = STEER_SLEW * AI_DT;
    a.steer += ds > lim ? lim : ds < -lim ? -lim : ds;

    // Speed PI on v_cmd = v + a·PI_HORIZON.
    const e = acc * PI_HORIZON;
    let throttle = 0;
    let brake = 0;
    const stopped = v < 0.3 && acc <= 0;
    if (a.wrecked || a.stuck || (a.hold && v < 0.3)) {
      brake = 1;
      a.piI = 0;
    } else if (stopped) {
      brake = 1;
      a.piI = 0;
    } else {
      a.piI += 0.3 * e * AI_DT;
      a.piI = clamp(a.piI, -0.2, 0.5);
      const u = 0.6 * e + a.piI + CRUISE_FF * v * v;
      // A considerate driver: no full throttle at walking pace or on full lock (TC cannot cut below
      // 2.5 × idle rpm; flooring it in a tight junction turn spun the rears and folded the toe links).
      const cap = clamp(THROTTLE_CAP_BASE + THROTTLE_CAP_PER_MS * v, 0, 1) * (1 - THROTTLE_CAP_STEER * Math.abs(a.steer));
      if (u >= 0) throttle = u > cap ? cap : u;
      else {
        brake = -u * 0.8;
        if (brake > 1) brake = 1;
        if (a.piI > 0) a.piI *= 0.9;
      }
    }
    eng.setAction(obj, Action.throttle, throttle);
    eng.setAction(obj, Action.brake, brake);
    eng.setAction(obj, Action.steer, a.steer);
    eng.setAction(obj, Action.handbrake, 0);
    eng.setAction(obj, Action.gearSelect, 1);
    a.brakeLamp = brake >= BRAKE_LAMP_MIN ? brake : 0;
    // Stuck: crawling with nothing ahead and no yield.
    if (!a.wrecked && !a.hold && v < STUCK_SPEED && !a.yielding && a.gap > 10 && a.v0 > 2) a.stuckS += AI_DT;
    else a.stuckS = 0;
    if (a.stuckS > STUCK_S) a.stuck = true;
  }

  private aiState(a: TrafficAgent): number {
    if (a.wrecked) return TrafficAiState.wrecked;
    if (a.stuck) return TrafficAiState.stuck;
    if (a.yielding) return TrafficAiState.yield;
    if (a.lcActive) return TrafficAiState.laneChange;
    const p = this.net.paths[a.plan[0]!]!;
    if (p.kind === 'connector' && p.turn !== 'straight') return TrafficAiState.turn;
    if (a.v < 0.3) return TrafficAiState.stopped;
    const v = a.v;
    if (a.gap < 2 * (2.5 + v * a.T) + 10) return TrafficAiState.follow;
    return TrafficAiState.cruise;
  }

  // ================================================================== scheduler
  private schedule(eng: SimEngine): void {
    const f = this.focus;
    // Pool rule.
    let propBeams = 0;
    for (const o of eng.arena.objects) {
      if (isPropObjectId(o.objectId) && (o.flags & SIM_OBJECT_FLAG_SLEEPING) === 0) propBeams += o.beamCount;
    }
    const pool = this.density.awakePoolBeams - propBeams - Math.max(0, (f.present ? f.beams : 0) - TRAFFIC_PLAYER_BASELINE_BEAMS);
    const byPool = this.maxVariantBeams > 0 ? Math.floor(pool / this.maxVariantBeams) : 0;
    // Contract: never below 1 while any agent exists (a ghost the player can reach must be promotable).
    let eff = Math.min(this.density.maxAwake, byPool);
    if (eff < 1) eff = 1;
    this.effectiveMaxAwake = eff;

    // Density: retire the highest-index agents beyond `agents`; revive missing ones.
    for (let i = 0; i < TRAFFIC_MAX_AGENTS; i++) {
      const a = this.agents[i]!;
      if (i >= this.density.agents) {
        if (a.alive && !a.awake) a.alive = false;
        else if (a.alive && a.awake) a.retiring = true;
      } else a.retiring = false;
    }

    const d2 = this.dist2;
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (f.present) {
        const dx = a.pos[0] - f.x;
        const dz = a.pos[2] - f.z;
        d2[a.index] = dx * dx + dz * dz;
      } else d2[a.index] = FAR;
    }

    // 1. Awake cars that must go: wrecked / stuck / retiring (out of sight only), far ones demote.
    const demoteR2 = this.bubble.demoteM * this.bubble.demoteM;
    for (const a of this.agents) {
      if (!a.alive || !a.awake) continue;
      if (a.wrecked || a.stuck || a.retiring) {
        if (this.outOfSight(a)) {
          this.despawnAwake(eng, a);
          if (a.retiring) a.alive = false;
          else this.respawn(a);
        }
        continue;
      }
      if (f.present && d2[a.index]! >= demoteR2) this.demoteOrRecycle(eng, a);
    }
    // Over the cap (density / pool): demote the farthest undamaged cars.
    let awake = this.awakeCount;
    while (awake > eff) {
      let far = -1;
      for (const a of this.agents) {
        if (!a.alive || !a.awake || a.wrecked || a.stuck || a.damage > DEMOTE_MAX_DAMAGE) continue;
        if (far < 0 || d2[a.index]! > d2[far]!) far = a.index;
      }
      if (far < 0) break;
      const a = this.agents[far]!;
      if (!this.demoteOrRecycle(eng, a)) break;
      awake--;
    }

    // 2. Promotion candidates by distance ascending (tie: index).
    if (f.present && eff > 0) {
      const promoteR2 = this.bubble.promoteM * this.bubble.promoteM;
      const contactR2 = TRAFFIC_CONTACT_M * TRAFFIC_CONTACT_M;
      const order = this.order;
      order.length = 0;
      for (const a of this.agents) if (a.alive && !a.awake && d2[a.index]! <= promoteR2) order.push(a.index);
      for (let i = 1; i < order.length; i++) {
        const x = order[i]!;
        let j = i - 1;
        while (j >= 0 && (d2[order[j]!]! > d2[x]! || (d2[order[j]!]! === d2[x]! && order[j]! > x))) {
          order[j + 1] = order[j]!;
          j--;
        }
        order[j + 1] = x;
      }
      for (const idx of order) {
        const c = this.agents[idx]!;
        let ok = false;
        if (this.awakeCount < eff) ok = true;
        else {
          // Swap out the farthest undamaged awake car ≥ SWAP_MARGIN_M farther than the candidate.
          const dc = Math.sqrt(d2[idx]!);
          let far = -1;
          for (const a of this.agents) {
            if (!a.alive || !a.awake || a.wrecked || a.stuck || a.damage > DEMOTE_MAX_DAMAGE) continue;
            if (Math.sqrt(d2[a.index]!) < dc + SWAP_MARGIN_M) continue;
            if (far < 0 || d2[a.index]! > d2[far]!) far = a.index;
          }
          if (far >= 0 && this.demoteOrRecycle(eng, this.agents[far]!)) ok = true;
        }
        if (ok && this.promote(eng, c)) continue;
        if (d2[idx]! < contactR2) this.respawn(c);
      }
    }

    // 3. Pending respawns (failed spawn attempts, revived agents).
    for (let i = 0; i < this.density.agents; i++) {
      const a = this.agents[i]!;
      if (!a.alive) this.respawn(a);
    }
  }

  /** Out of the focus's sight (contract): ≥ 120 m, or > 40 m and > 100° off its heading. */
  private outOfSight(a: TrafficAgent): boolean {
    const f = this.focus;
    if (!f.present) return true;
    const dx = a.pos[0] - f.x;
    const dz = a.pos[2] - f.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= SIGHT_FAR_M) return true;
    if (d <= SIGHT_NEAR_M) return false;
    return (dx * f.fx + dz * f.fz) / d < SIGHT_COS;
  }

  /** Demotes an undamaged on-route awake car to a ghost; otherwise recycles it once out of sight. Returns true if it is no longer awake. */
  private demoteOrRecycle(eng: SimEngine, a: TrafficAgent): boolean {
    const p = this.net.paths[a.plan[0]!]!;
    const pr = this.proj;
    projectToRoute(p, a.pos[0], a.pos[2], pr, a.s);
    sampleRoute(p, pr.s, this.smp);
    const dy = a.pos[1] - this.smp.y;
    const off = Math.sqrt(pr.d * pr.d + dy * dy);
    const hl = Math.sqrt(this.smp.tx * this.smp.tx + this.smp.tz * this.smp.tz);
    const fl = Math.sqrt(a.frame[0]! * a.frame[0]! + a.frame[2]! * a.frame[2]!);
    const cos = hl > 0 && fl > 0 ? (a.frame[0]! * this.smp.tx + a.frame[2]! * this.smp.tz) / (hl * fl) : 0;
    const lcOff = a.lcActive ? a.lcOffset0 * (1 - smooth01(a.lcT / LANE_CHANGE_S)) : 0;
    const lateral = Math.abs(pr.d - lcOff);
    if (a.damage <= DEMOTE_MAX_DAMAGE && !a.wrecked && lateral <= DEMOTE_SNAP_M && Math.abs(dy) <= DEMOTE_SNAP_M && cos >= DEMOTE_SNAP_COS && off < 5) {
      this.despawnAwake(eng, a);
      a.s = pr.s;
      a.v = a.v > 0 ? a.v : 0;
      this.ghostPose(a, a.s, a.pos, a.quat);
      a.teleported = true;
      return true;
    }
    if (this.outOfSight(a)) {
      this.despawnAwake(eng, a);
      this.respawn(a);
      return true;
    }
    return false;
  }

  private despawnAwake(eng: SimEngine, a: TrafficAgent): void {
    if (eng.arena.get(a.objectId)) eng.despawn(a.objectId);
    a.awake = false;
    a.objectId = 0;
    a.piI = 0;
    a.steerI = 0;
    a.stuckS = 0;
    a.offS = 0;
    a.damage = 0;
  }

  /** Ghost → awake soft body at the ghost's pose and velocity. */
  private promote(eng: SimEngine, a: TrafficAgent): boolean {
    const variant = this.variants[a.variant]!;
    const objectId = TRAFFIC_ID_BASE + a.index;
    if (eng.arena.get(objectId)) return false;
    // Never spawn into the focus or another awake car.
    const f = this.focus;
    const clearR = variant.front + 3.5;
    if (f.present) {
      const dx = a.pos[0] - f.x;
      const dz = a.pos[2] - f.z;
      if (dx * dx + dz * dz < clearR * clearR * 1.5) return false;
    }
    for (const b of this.agents) {
      if (b === a || !b.alive || !b.awake) continue;
      const dx = a.pos[0] - b.pos[0];
      const dz = a.pos[2] - b.pos[2];
      if (dx * dx + dz * dz < clearR * clearR) return false;
    }
    const cap = eng.capacity;
    const s = eng.state;
    const rig = variant.compiled.rig;
    if (eng.arena.objects.length + 1 > cap.maxObjects || s.nodeCount + rig.nodeCount > s.nodeCapacity || s.beamCount + rig.beamCount > s.beamCapacity) return false;
    this.ghostPose(a, a.s, a.pos, a.quat);
    spawnAtPose(eng, objectId, variant, { pos: [a.pos[0], a.pos[1], a.pos[2]], quat: [a.quat[0], a.quat[1], a.quat[2], a.quat[3]] }, a.v);
    a.awake = true;
    a.objectId = objectId;
    a.piI = 0;
    a.stuckS = 0;
    a.offS = 0;
    a.damage = 0;
    a.wrecked = false;
    a.stuck = false;
    const veh = eng.getVehicle(objectId)!;
    measurePose(eng.state, veh, variant, a.pos, a.quat, a.frame);
    // Initial steer = the path curvature (no wheel snap at the hand-over).
    eng.setAction(eng.arena.get(objectId)!, Action.steer, a.steer);
    eng.setAction(eng.arena.get(objectId)!, Action.gearSelect, 1);
    return true;
  }

  /**
   * (Re)spawns agent `a` as a ghost by the respawn rule: a lane point ≥
   * TRAFFIC_SPAWN_MIN_M from the focus, outside its forward ±70° cone
   * closer than TRAFFIC_SPAWN_CONE_M, ≥ SPAWN_SPACING_M from any agent on
   * the same path. New variant / paint / temperament. Up to 48 rng draws;
   * failure leaves it pending (retried every AI tick).
   */
  private respawn(a: TrafficAgent): void {
    a.alive = false;
    a.awake = false;
    if (this.net.laneCount === 0 || this.variants.length === 0) return;
    const rng = this.rng;
    const f = this.focus;
    const total = this.laneCum[this.net.laneCount]!;
    for (let attempt = 0; attempt < 48; attempt++) {
      const r = rng.float() * total;
      let lo = 0;
      let hi = this.net.laneCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.laneCum[mid + 1]! <= r) lo = mid + 1;
        else hi = mid;
      }
      const lane = this.net.paths[lo]!;
      const s = r - this.laneCum[lo]!;
      if (s < 4 || s > lane.length - 4) continue;
      sampleRoute(lane, s, this.smp);
      if (f.present) {
        const dx = this.smp.x - f.x;
        const dz = this.smp.z - f.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < TRAFFIC_SPAWN_MIN_M) continue;
        if (d < TRAFFIC_SPAWN_CONE_M && (dx * f.fx + dz * f.fz) / d > SPAWN_CONE_COS) continue;
      }
      let crowded = false;
      for (const b of this.agents) {
        if (b === a || !b.alive || b.plan[0] !== lane.index) continue;
        if (Math.abs(b.s - s) < SPAWN_SPACING_M) {
          crowded = true;
          break;
        }
      }
      // (Respawns are rare: a full scan, not the per-tick occupancy lists, which may be stale here.)
      if (crowded) continue;
      // Variant (weighted), paint, temperament.
      let w = rng.float() * this.weightSum;
      let vi = 0;
      for (; vi < this.variants.length - 1; vi++) {
        w -= this.variants[vi]!.weight;
        if (w < 0) break;
      }
      a.variant = vi;
      const pc = this.variants[vi]!.paletteCount;
      a.paint = pc > 0 ? rng.int(0, pc - 1) : 0;
      a.v0Scale = rng.range(TEMPERAMENT_V0[0], TEMPERAMENT_V0[1]);
      a.T = rng.range(TEMPERAMENT_T[0], TEMPERAMENT_T[1]);
      a.plan[0] = lane.index;
      this.replan(a);
      a.s = s;
      let v = lane.speedLimit * a.v0Scale;
      const kap = Math.abs(this.smp.curvature);
      if (kap > 1e-5) v = Math.min(v, Math.sqrt(CURVE_LAT_ACC / kap));
      a.v = v;
      a.a = 0;
      a.alive = true;
      a.awake = false;
      a.objectId = 0;
      a.committed = -1;
      a.waitS = 0;
      a.lcActive = false;
      a.lcDir = 0;
      a.lcCooldown = 0;
      a.wrecked = false;
      a.wreckReason = '';
      a.hold = false;
      a.respawns++;
      a.stuck = false;
      a.stuckS = 0;
      a.offS = 0;
      a.damage = 0;
      a.steer = steerFromCurvature(this.smp.curvature, this.variants[vi]!);
      a.brakeLamp = 0;
      a.gap = FAR;
      a.teleported = true;
      this.ghostPose(a, s, a.pos, a.quat);
      a.frame[0] = this.smp.tx;
      a.frame[1] = this.smp.ty;
      a.frame[2] = this.smp.tz;
      a.frame[3] = 0;
      a.frame[4] = 1;
      a.frame[5] = 0;
      return;
    }
  }

  // ================================================================== test / tooling hooks
  /**
   * Places agent `index` as a ghost on `path` at arc `s` with speed `v`
   * (tests and tools; deterministic). `plan` (optional) forces the next
   * paths (each must be a successor of the previous); the rest is picked.
   */
  placeAgent(index: number, path: number, s: number, v: number, plan: readonly number[] = []): TrafficAgent {
    const a = this.agents[index]!;
    if (!a.alive) {
      this.respawn(a);
      if (!a.alive) {
        a.alive = true;
        a.variant = 0;
        a.v0Scale = 1;
        a.T = 1.4;
      }
    }
    if (a.awake) {
      if (!this.eng) throw new Error('placeAgent: not initialized');
      this.despawnAwake(this.eng, a);
    }
    a.plan[0] = path;
    for (let k = 1; k < PLAN_LEN; k++) {
      const forced = plan[k - 1];
      if (forced !== undefined) {
        if (!this.net.paths[a.plan[k - 1]!]!.next.includes(forced)) throw new Error(`placeAgent: ${forced} does not follow ${a.plan[k - 1]}`);
        a.plan[k] = forced;
      } else a.plan[k] = this.pickNext(a.plan[k - 1]!);
    }
    a.s = s;
    a.v = v;
    a.committed = -1;
    a.waitS = 0;
    a.lcActive = false;
    a.lcCooldown = 0;
    a.teleported = true;
    this.ghostPose(a, s, a.pos, a.quat);
    return a;
  }

  // ================================================================== snapshot
  /**
   * Writes one record per live agent (ascending). Ghost poses are
   * extrapolated by v over the ticks since the AI tick; awake poses are
   * measured now. Clears the one-shot TELEPORTED flags.
   */
  writeRecords(writer: SnapshotWriter, eng: SimEngine): void {
    const rec = this.rec;
    const dtSince = (eng.tick - this.lastAiTick) / 2000;
    for (const a of this.agents) {
      if (!a.alive) continue;
      const variant = this.variants[a.variant]!;
      rec.agent = a.index;
      rec.variant = a.variant;
      rec.paint = a.paint;
      rec.state = a.state;
      rec.path = a.plan[0]!;
      let flags = TRAFFIC_FLAG_HEADLIGHTS;
      if (a.awake) {
        const veh = eng.getVehicle(a.objectId);
        const obj = eng.arena.get(a.objectId);
        flags |= TRAFFIC_FLAG_AWAKE;
        rec.objectId = a.objectId;
        if (veh && obj && measurePose(eng.state, veh, variant, this.tmpPos, this.tmpQuat, this.tmpFrame)) {
          copy3(rec.pos, this.tmpPos);
          copy4(rec.quat, this.tmpQuat);
        } else {
          copy3(rec.pos, a.pos);
          copy4(rec.quat, a.quat);
        }
        rec.speed = a.v;
        rec.steer = obj ? obj.actions[Action.steer]! : a.steer;
        const br = obj ? obj.actions[Action.brake]! : 0;
        rec.brake = br >= BRAKE_LAMP_MIN ? br : 0;
        if (rec.brake > 0) flags |= TRAFFIC_FLAG_BRAKE;
      } else {
        rec.objectId = 0;
        // Extrapolate along the plan (presentation only).
        let s = a.s + a.v * dtSince;
        const p0 = this.net.paths[a.plan[0]!]!;
        if (s > p0.length) s = p0.length;
        this.ghostPose(a, s, this.tmpPos, this.tmpQuat, a.lcT + dtSince);
        copy3(rec.pos, this.tmpPos);
        copy4(rec.quat, this.tmpQuat);
        rec.speed = a.v;
        rec.steer = a.steer;
        rec.brake = a.brakeLamp;
        if (a.brakeLamp > 0) flags |= TRAFFIC_FLAG_BRAKE;
      }
      flags |= this.indicatorFlags(a);
      if (a.wrecked || a.stuck) flags |= TRAFFIC_FLAG_HAZARD;
      if (a.wrecked) flags |= TRAFFIC_FLAG_WRECKED;
      if (a.yielding) flags |= TRAFFIC_FLAG_YIELDING;
      if (a.honkS > 0) flags |= TRAFFIC_FLAG_HORN;
      if (a.teleported) flags |= TRAFFIC_FLAG_TELEPORTED;
      a.teleported = false;
      rec.flags = flags;
      writer.pushTrafficAgent(rec);
    }
  }

  private indicatorFlags(a: TrafficAgent): number {
    if (a.lcActive) return a.lcDir > 0 ? TRAFFIC_FLAG_INDICATOR_R : TRAFFIC_FLAG_INDICATOR_L;
    const range = Math.max(INDICATOR_M, INDICATOR_S * a.v);
    let d = -a.s;
    for (let k = 0; k < PLAN_LEN; k++) {
      const p = this.net.paths[a.plan[k]!]!;
      if (k > 0 && d > range) break;
      if (p.kind === 'connector' && (p.turn === 'left' || p.turn === 'right' || p.turn === 'uturn')) {
        return p.turn === 'right' ? TRAFFIC_FLAG_INDICATOR_R : TRAFFIC_FLAG_INDICATOR_L;
      }
      d += p.length;
    }
    return 0;
  }
}

function turnWeight(p: RoutePath): number {
  switch (p.turn) {
    case 'straight':
      return TURN_WEIGHT_STRAIGHT;
    case 'right':
      return TURN_WEIGHT_RIGHT;
    case 'left':
      return TURN_WEIGHT_LEFT;
    default:
      return 1;
  }
}

function steerFromCurvature(kappa: number, v: TrafficVariant): number {
  return clamp(atanR(kappa * v.wheelbase) / v.maxSteerRad, -1, 1);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function copy3(o: [number, number, number], i: readonly number[]): void {
  o[0] = i[0]!;
  o[1] = i[1]!;
  o[2] = i[2]!;
}
function copy4(o: [number, number, number, number], i: readonly number[]): void {
  o[0] = i[0]!;
  o[1] = i[1]!;
  o[2] = i[2]!;
  o[3] = i[3]!;
}

/** Clamps a density to the protocol limits (agents ≤ 64, maxAwake ≤ 6, pool ≥ 0). */
export function clampDensity(d: TrafficDensity): TrafficDensity {
  const int = (x: unknown, lo: number, hi: number): number => {
    const n = typeof x === 'number' && Number.isFinite(x) ? Math.floor(x) : lo;
    return n < lo ? lo : n > hi ? hi : n;
  };
  return {
    agents: int(d?.agents, 0, TRAFFIC_MAX_AGENTS),
    maxAwake: int(d?.maxAwake, 0, TRAFFIC_MAX_AWAKE),
    awakePoolBeams: int(d?.awakePoolBeams, 0, 1 << 30),
  };
}
