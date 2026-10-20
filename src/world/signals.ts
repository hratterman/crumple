/**
 * TRAFFIC SIGNALS — layout v6 contract (R-WORLD; docs/CONTRACTS.md "R-WORLD
 * contracts" → signals). Pure and deterministic: a signal's aspect is a
 * function of (plan, leg, sim TICK) only, in integer tick arithmetic, so the
 * worker's traffic AI (which runs at tick boundaries) and main's signal-head
 * visuals (presented sim time) agree, and replays reproduce it.
 *
 * PLANS. Every junction with `control: 'signal'` (layout order) gets one
 * SignalPlan. Its LEGS are the junction's approaches: for each listed road
 * (junction order) the side(s) it reaches the junction from — side −1 = the
 * part of the road at smaller s (its lanes travelling toward +s arrive
 * there), side +1 = the part at larger s — exactly the route network's leg
 * convention (src/world/routes.ts). Unrouted roads still get legs (their
 * heads are drawn) but no RoutePath links to them.
 *
 * PHASES (two-phase fixed time): phase 0 = the through road's legs (the
 * junction's highest-priority road; ties layout order), phase 1 = every
 * other leg. Each phase: green → amber (SIGNAL_AMBER_S) → all-red
 * (SIGNAL_ALL_RED_S). Green times: through SIGNAL_GREEN_THROUGH_S, branches
 * SIGNAL_GREEN_BRANCH_S. Each plan starts at its own deterministic offset
 * (FNV of the junction id) so neighbouring junctions are not in lockstep.
 *
 * AI RULE (for the traffic agent): a connector with RoutePath.signal set may
 * be ENTERED only while signalAspect(...) is 'green'; on 'amber' stop if the
 * stop line can be reached at ≤ 3 m/s² (else go); 'red' = stop at the leg's
 * stop line (SignalLeg.stop / the lane end). Turning left on green still
 * yields to the opposing straight (RoutePath.yield).
 */
import { createRoadProjection, createRoadSample, projectToRoad, sampleRoad } from './roads';
import { ROAD_KIND_DEFAULTS, type TerrainData, type Vec2, type WorldLayout, type WorldVec3 } from './types';

/** Sim tick rate the plans are timed in (= the physics step rate, 1 / dt). */
export const SIGNAL_TICK_HZ = 2000;
export const SIGNAL_GREEN_THROUGH_S = 24;
export const SIGNAL_GREEN_BRANCH_S = 14;
export const SIGNAL_AMBER_S = 3.5;
export const SIGNAL_ALL_RED_S = 1.5;

export type SignalAspect = 'green' | 'amber' | 'red';

export interface SignalLeg {
  /** Road id and side (−1 = approaches from smaller s, +1 = from larger s). */
  road: string;
  side: -1 | 1;
  /** Phase index this leg is green in. */
  phase: number;
  /** Stop-line centre on the approaching carriageway (world, surface y). */
  stop: WorldVec3;
  /** Unit (x, z) travel direction of the APPROACHING lanes (toward the junction). */
  dir: Vec2;
  /** Carriageway half width at the stop line (heads stand at the kerb beyond it), m. */
  halfWidth: number;
}
export interface SignalPhaseTiming {
  greenTicks: number;
  amberTicks: number;
  allRedTicks: number;
}
export interface SignalPlan {
  junction: string;
  pos: Vec2;
  /** Σ (green + amber + allRed) over the phases. */
  cycleTicks: number;
  offsetTicks: number;
  phases: SignalPhaseTiming[];
  legs: SignalLeg[];
}

const ticks = (s: number): number => Math.round(s * SIGNAL_TICK_HZ);

function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/**
 * The aspect a leg shows at sim tick `tick` (integer ≥ 0; negative ticks wrap).
 * Allocation-free, integer arithmetic only.
 */
export function signalAspect(plan: SignalPlan, leg: number, tick: number): SignalAspect {
  const L = plan.legs[leg];
  if (!L) return 'red';
  const c = plan.cycleTicks;
  let t = (Math.floor(tick) + plan.offsetTicks) % c;
  if (t < 0) t += c;
  for (let p = 0; p < plan.phases.length; p++) {
    const ph = plan.phases[p]!;
    if (t < ph.greenTicks) return p === L.phase ? 'green' : 'red';
    t -= ph.greenTicks;
    if (t < ph.amberTicks) return p === L.phase ? 'amber' : 'red';
    t -= ph.amberTicks;
    if (t < ph.allRedTicks) return 'red';
    t -= ph.allRedTicks;
  }
  return 'red';
}

/** Ticks until the leg's next green starts (0 while green). Allocation-free. */
export function ticksToGreen(plan: SignalPlan, leg: number, tick: number): number {
  const L = plan.legs[leg];
  if (!L) return Infinity;
  const c = plan.cycleTicks;
  let t = (Math.floor(tick) + plan.offsetTicks) % c;
  if (t < 0) t += c;
  // start of the leg's green within the cycle
  let start = 0;
  for (let p = 0; p < L.phase; p++) {
    const ph = plan.phases[p]!;
    start += ph.greenTicks + ph.amberTicks + ph.allRedTicks;
  }
  const g = plan.phases[L.phase]!.greenTicks;
  if (t >= start && t < start + g) return 0;
  const d = start - t;
  return d > 0 ? d : d + c;
}

/** Distance from the junction centre to a leg's stop line, m. */
export function stopLineDistance(myHalfReach: number, others: readonly { halfReach: number; sin: number }[]): number {
  let d = 8;
  for (const o of others) {
    const need = (o.halfReach + 2.5) / Math.max(o.sin, 0.35);
    if (need > d) d = need;
  }
  void myHalfReach;
  return d > 30 ? 30 : d;
}

/** Pure: one plan per `control: 'signal'` junction, layout order. */
export function buildSignalPlans(layout: WorldLayout, terrain: TerrainData): SignalPlan[] {
  const out: SignalPlan[] = [];
  const proj = createRoadProjection();
  const smp = createRoadSample();
  const index = new Map(layout.roads.map((r, i) => [r.id, i]));
  for (const j of layout.junctions) {
    if (j.control !== 'signal') continue;
    let through = -1;
    for (const id of j.roads) {
      const ri = index.get(id);
      if (ri === undefined) continue;
      if (through < 0 || ROAD_KIND_DEFAULTS[layout.roads[ri]!.kind].priority > ROAD_KIND_DEFAULTS[layout.roads[through]!.kind].priority) through = ri;
    }
    const here = j.roads.map((id) => {
      const ri = index.get(id)!;
      const road = terrain.roads[ri]!;
      projectToRoad(road, j.pos[0], j.pos[1], proj);
      sampleRoad(road, proj.s, smp);
      return { ri, road, s: proj.s, tx: smp.tx, tz: smp.tz };
    });
    const legs: SignalLeg[] = [];
    for (const h of here) {
      const road = h.road;
      const others = here
        .filter((o) => o !== h)
        .map((o) => ({ halfReach: o.road.width / 2 + o.road.shoulder, sin: Math.abs(h.tx * o.tz - h.tz * o.tx) }));
      const dist = stopLineDistance(road.width / 2 + road.shoulder, others);
      for (const side of [-1, 1] as const) {
        const sStop = h.s + side * dist;
        if (!road.closed && (sStop < 0 || sStop > road.length)) continue;
        sampleRoad(road, sStop, smp);
        // Approaching lanes travel toward the junction: from side −1 that is +tangent.
        const dx = -side * smp.tx;
        const dz = -side * smp.tz;
        legs.push({
          road: road.id,
          side,
          phase: h.ri === through ? 0 : 1,
          stop: [smp.x, smp.y, smp.z],
          dir: [dx, dz],
          halfWidth: road.width / 2,
        });
      }
    }
    const phases: SignalPhaseTiming[] = [
      { greenTicks: ticks(SIGNAL_GREEN_THROUGH_S), amberTicks: ticks(SIGNAL_AMBER_S), allRedTicks: ticks(SIGNAL_ALL_RED_S) },
      { greenTicks: ticks(SIGNAL_GREEN_BRANCH_S), amberTicks: ticks(SIGNAL_AMBER_S), allRedTicks: ticks(SIGNAL_ALL_RED_S) },
    ];
    let cycle = 0;
    for (const p of phases) cycle += p.greenTicks + p.amberTicks + p.allRedTicks;
    out.push({ junction: j.id, pos: [j.pos[0], j.pos[1]], cycleTicks: cycle, offsetTicks: fnv(j.id) % cycle, phases, legs });
  }
  return out;
}
