/**
 * Traffic driver model + scheduler on Crumple Valley (P6, T1): lane
 * following at highway speed, stopping behind a stopped car and the parked
 * player, junction yield, promotion / demotion without a pose jump,
 * recycling out of sight, stuck recovery, player-vs-traffic contact and
 * determinism with traffic.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SnapshotReader } from '../../protocol/codec';
import { createTrafficAgentFrame, TRAFFIC_AI_TICKS, TRAFFIC_CONTACT_M, TRAFFIC_FLAG_TELEPORTED } from '../../protocol/traffic';
import type { RoutePath } from '../../world/types';
import { createRoutePose, routePose } from '../../world/routes';
import { measurePose } from './templates';
import { distToPlayer, placePlayer, run, stateHash, trafficWorld, valleyTerrain } from './testkit';
import type { TrafficAgent } from './traffic';

beforeAll(() => {
  valleyTerrain();
}, 120_000);

/** Far-away parking spot for the player (the arena), so the focus never interferes. */
const ARENA: [number, number, number] = [360, 400, 0];
const BIG_BUBBLE = { promoteM: 5000, demoteM: 6000 };
/** Highway, first interval, direction +1: lane 0 (inner) and lane 1 (kerb). */
const HWY_INNER = 0;
const HWY_KERB = 1;

describe('driver model (awake, soft body)', () => {
  it('follows a highway lane at speed without leaving it: lateral error < 0.5 m', () => {
    const { eng, tr } = trafficWorld({ agents: 1, maxAwake: 1, bubble: BIG_BUBBLE, player: ARENA });
    const a = tr.placeAgent(0, HWY_KERB, 60, 28);
    let maxLat = 0;
    let vSum = 0;
    let n = 0;
    run(eng, 2000 * 30, (i) => {
      if (i < 2000 * 3 || i % TRAFFIC_AI_TICKS !== 1 || a.lcActive) return;
      maxLat = Math.max(maxLat, Math.abs(a.latErr));
      vSum += a.v;
      n++;
    });
    const limit = tr.net.paths[HWY_KERB]!.speedLimit;
    console.log(`[traffic] highway lane following: max lateral error ${maxLat.toFixed(2)} m, mean speed ${(vSum / n).toFixed(1)} m/s (limit ${limit.toFixed(1)}), ${a.s.toFixed(0)} m on path ${a.plan[0]}`);
    expect(a.awake).toBe(true);
    expect(a.wrecked).toBe(false);
    expect(maxLat).toBeLessThan(0.5);
    expect(vSum / n).toBeGreaterThan(0.85 * limit);
    expect(vSum / n).toBeLessThan(1.1 * limit);
  }, 180_000);

  it('stops behind a stopped car (both soft bodies), no contact', () => {
    const { eng, tr } = trafficWorld({ agents: 2, maxAwake: 2, bubble: BIG_BUBBLE, player: ARENA });
    const lead = tr.placeAgent(1, HWY_KERB, 400, 0);
    lead.hold = true;
    const a = tr.placeAgent(0, HWY_KERB, 150, 25);
    a.lcCooldown = 1e9; // no overtaking: this test is about stopping
    run(eng, 2000 * 25);
    const vl = tr.variants[lead.variant]!;
    const va = tr.variants[a.variant]!;
    const gap = lead.s - a.s - va.front - vl.rear;
    console.log(`[traffic] stopped behind a stopped car: gap ${gap.toFixed(2)} m, speed ${a.v.toFixed(2)} m/s`);
    expect(a.awake && lead.awake).toBe(true);
    expect(a.plan[0]).toBe(HWY_KERB);
    expect(Math.abs(a.v)).toBeLessThan(0.3);
    expect(gap).toBeGreaterThan(1);
    expect(gap).toBeLessThan(8);
    expect(a.damage).toBe(0);
    expect(lead.damage).toBe(0);
  }, 180_000);

  it('stops behind the parked player in its lane', () => {
    const { eng, tr } = trafficWorld({ agents: 1, maxAwake: 1, bubble: BIG_BUBBLE, player: ARENA });
    placePlayer(eng, HWY_KERB, 500);
    run(eng, 400);
    const a = tr.placeAgent(0, HWY_KERB, 250, 25);
    a.lcCooldown = 1e9;
    run(eng, 2000 * 25);
    const d = distToPlayer(eng, a);
    console.log(`[traffic] stopped behind the player: centre distance ${d.toFixed(2)} m, speed ${a.v.toFixed(2)} m/s`);
    expect(a.awake).toBe(true);
    expect(Math.abs(a.v)).toBeLessThan(0.3);
    // Centre distance = gap + traffic front (≈ 2.3) + player rear (≈ 2.4).
    expect(d).toBeGreaterThan(5.5);
    expect(d).toBeLessThan(13);
    expect(a.damage).toBe(0);
  }, 180_000);
});

describe('junction yield (ghost logic = awake logic)', () => {
  it('a branch left turn waits for the highway straight it crosses, then goes', () => {
    const { eng, tr } = trafficWorld({ agents: 2, maxAwake: 1, player: ARENA });
    const net = tr.net;
    const j = net.junctions.find((x) => x.id === 'hwyWest')!;
    const conns = j.connectors.map((i) => net.paths[i]!);
    const left = conns.find((c) => net.paths[c.prev[0]!]!.road === 'lakeshore' && c.turn === 'left')!;
    expect(left.yield).toBe(true);
    const straight = left.conflicts.map((i) => net.paths[i]!).find((c) => c.turn === 'straight')!;
    const inLane = net.paths[left.prev[0]!]!;
    const hwyLane = net.paths[straight.prev[0]!]!;
    // B (highway) 2 s from its connector at 25 m/s; A (lakeshore) 20 m short of its line at 8 m/s.
    const b = tr.placeAgent(1, hwyLane.index, hwyLane.length - 50, 25, [straight.index]);
    const a = tr.placeAgent(0, inLane.index, inLane.length - 20, 8, [left.index]);
    let yielded = false;
    let enteredWhileBusy = false;
    let entered = false;
    run(eng, 2000 * 12, (i) => {
      if (i % TRAFFIC_AI_TICKS !== 1) return;
      if (a.yielding) yielded = true;
      if (a.plan[0] === left.index) {
        entered = true;
        if (b.plan[0] === straight.index || (b.plan[0] === hwyLane.index && b.plan[1] === straight.index)) enteredWhileBusy = true;
      }
    });
    console.log(`[traffic] junction yield: yielded ${yielded}, entered ${entered}, entered while the straight was busy ${enteredWhileBusy}`);
    expect(yielded).toBe(true);
    expect(enteredWhileBusy).toBe(false);
    expect(entered).toBe(true);
  }, 180_000);
});

describe('scheduler', () => {
  it('promotion spawns the soft body exactly at the ghost pose (no jump); demotion snaps ≤ 0.5 m with TELEPORTED', () => {
    const { host, eng, tr, out } = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA });
    placePlayer(eng, HWY_KERB, 900);
    run(eng, 400);
    const a = tr.placeAgent(0, HWY_KERB, 900 - 140, 25);
    let promotedAt = -1;
    // Step until the promotion; the AI tick spawns at the ghost pose of that tick.
    for (let i = 0; i < 2000 * 5 && promotedAt < 0; i++) {
      host.runSteps(1); // writes snapshots (clears the placement's TELEPORTED)
      if (a.awake) promotedAt = eng.tick;
    }
    expect(promotedAt).toBeGreaterThan(0);
    // The ghost advanced one AI tick before promoting: compare with routePose at the promoted s.
    const pose = routePose(tr.net.paths[a.plan[0]!]!, a.s, createRoutePose());
    const pos: [number, number, number] = [0, 0, 0];
    const quat: [number, number, number, number] = [0, 0, 0, 1];
    const fr = new Float64Array(6);
    measurePose(eng.state, eng.getVehicle(a.objectId)!, tr.variants[a.variant]!, pos, quat, fr);
    const dPos = Math.hypot(pos[0] - pose.pos[0], pos[1] - pose.pos[1], pos[2] - pose.pos[2]);
    const dot = Math.abs(quat[0] * pose.quat[0] + quat[1] * pose.quat[1] + quat[2] * pose.quat[2] + quat[3] * pose.quat[3]);
    const angle = 2 * Math.acos(Math.min(1, dot));
    console.log(`[traffic] promotion: pose error ${(dPos * 100).toFixed(2)} cm, ${((angle * 180) / Math.PI).toFixed(3)}° after 1 tick`);
    expect(dPos).toBeLessThan(0.02 + a.v / 2000);
    expect(angle).toBeLessThan((0.5 * Math.PI) / 180);
    // The first records after the promotion are not TELEPORTED.
    out.length = 0;
    host.runSteps(60);
    const r = new SnapshotReader();
    const rec = createTrafficAgentFrame();
    for (const m of out) {
      if (m.type !== 'snapshot') continue;
      r.attach(m.buffer);
      r.readTrafficAgent(r.findTrafficAgent(0), rec);
      expect(rec.flags & TRAFFIC_FLAG_TELEPORTED).toBe(0);
    }
    // Demotion: the player leaves (teleported 1 km down the road); the car demotes at the next AI tick.
    run(eng, 2000);
    const before = [...a.pos];
    placePlayer(eng, HWY_KERB, 2200);
    out.length = 0;
    let demoted = false;
    for (let i = 0; i < 60 && !demoted; i++) {
      host.runSteps(1);
      if (!a.awake) demoted = true;
    }
    expect(demoted).toBe(true);
    const snap = Math.hypot(a.pos[0] - before[0]!, a.pos[2] - before[2]!) - a.v * 0.03;
    console.log(`[traffic] demotion snap ≈ ${snap.toFixed(3)} m`);
    expect(snap).toBeLessThan(0.5);
    host.runSteps(40);
    let tele = false;
    for (const m of out) {
      if (m.type !== 'snapshot') continue;
      r.attach(m.buffer);
      r.readTrafficAgent(r.findTrafficAgent(0), rec);
      if (rec.flags & TRAFFIC_FLAG_TELEPORTED) tele = true;
    }
    expect(tele).toBe(true);
    expect(eng.arena.get(100)).toBeUndefined();
  }, 180_000);

  it('a ghost that cannot be promoted is recycled before it gets within 45 m of the focus', () => {
    const { eng, tr } = trafficWorld({ agents: 2, maxAwake: 1, player: ARENA });
    placePlayer(eng, HWY_KERB, 900);
    run(eng, 400);
    // The single slot is taken by a car parked 12 m ahead of the player (never swapped: it is nearer).
    const parked = tr.placeAgent(1, HWY_KERB, 900 + 12, 0);
    parked.hold = true;
    run(eng, 400);
    expect(parked.awake).toBe(true);
    const g = tr.placeAgent(0, HWY_INNER, 900 - 200, 28);
    let minD = Infinity;
    const respawns = g.respawns;
    run(eng, 2000 * 10, (i) => {
      if (i % TRAFFIC_AI_TICKS !== 1 || !g.alive || g.awake) return;
      minD = Math.min(minD, distToPlayer(eng, g));
    });
    console.log(`[traffic] unpromotable ghost: closest ${minD.toFixed(1)} m, respawns ${g.respawns - respawns}`);
    expect(g.awake).toBe(false);
    expect(g.respawns).toBeGreaterThan(respawns);
    expect(minD).toBeGreaterThan(TRAFFIC_CONTACT_M - 1);
  }, 180_000);

  it('a car stuck against a wall (< 0.5 m/s for 8 s, nothing ahead) is recycled only once out of the focus’s sight', () => {
    const { host, eng, tr, out } = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA });
    placePlayer(eng, HWY_KERB, 900);
    run(eng, 400);
    // A concrete block across the kerb lane 45 m ahead of the player (static colliders are not in the leader search).
    const wall = routePose(tr.net.paths[HWY_KERB]!, 945, createRoutePose());
    const yaw = Math.atan2(-wall.forward[0], -wall.forward[2]);
    host.handle({ type: 'setColliders', colliders: [{ id: 'blocker', kind: 'box', pos: [wall.pos[0], null, wall.pos[2]], quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], size: [2.5, 1, 0.5], material: 5 }] });
    expect(out.filter((m) => m.type === 'error')).toEqual([]);
    const a = tr.placeAgent(0, HWY_KERB, 930, 3);
    a.lcCooldown = 1e9;
    const respawns = a.respawns;
    run(eng, 2000 * 18);
    console.log(`[traffic] stuck at a wall: v ${a.v.toFixed(2)} m/s, stuck ${a.stuck} (${a.stuckS.toFixed(1)} s), wrecked ${a.wrecked} (${a.wreckReason}), damage ${a.damage.toFixed(3)}, gap ${a.gap.toFixed(1)}, v0 ${a.v0.toFixed(1)}, yielding ${a.yielding}, state ${a.state}`);
    expect(a.awake).toBe(true);
    expect(a.stuck || a.wrecked).toBe(true);
    expect(a.respawns).toBe(respawns); // in sight (≈ 40 m ahead of the player): stays, hazards on
    placePlayer(eng, HWY_KERB, 2200); // the focus leaves
    run(eng, 100);
    expect(a.respawns).toBe(respawns + 1);
    expect(eng.arena.get(100)).toBeUndefined();
  }, 180_000);

  it('player into the rear of an awake traffic car at 50 km/h: no NaN, the car takes the damage', () => {
    const { eng, tr } = trafficWorld({ agents: 1, maxAwake: 1, player: ARENA });
    placePlayer(eng, HWY_KERB, 900);
    run(eng, 400);
    const a = tr.placeAgent(0, HWY_KERB, 900 + 14, 0);
    a.hold = true;
    run(eng, 1000);
    expect(a.awake).toBe(true);
    // Player at 50 km/h straight into the stationary car's rear.
    const p = eng.arena.get(1)!;
    const s = eng.state;
    const pose = routePose(tr.net.paths[HWY_KERB]!, 900, createRoutePose());
    for (let i = p.nodeStart; i < p.nodeStart + p.nodeCount; i++) {
      s.velX[i] = pose.forward[0] * (50 / 3.6);
      s.velY[i] = pose.forward[1] * (50 / 3.6);
      s.velZ[i] = pose.forward[2] * (50 / 3.6);
    }
    run(eng, 2000 * 3);
    let finite = true;
    for (let i = 0; i < s.nodeCount; i++) if (!Number.isFinite(s.posX[i]! + s.posY[i]! + s.posZ[i]!)) finite = false;
    console.log(`[traffic] rear-ended at 50 km/h: damage ${a.damage.toFixed(3)}, wrecked ${a.wrecked} (${a.wreckReason}), stuck ${a.stuck}`);
    expect(finite).toBe(true);
    expect(a.damage).toBeGreaterThan(0);
    expect(a.awake).toBe(true);
  }, 180_000);
});

describe('determinism with traffic', () => {
  it('two runs with promotions, demotions and AI driving hash identically', () => {
    const hashes: number[] = [];
    for (let k = 0; k < 2; k++) {
      const { eng, tr, host } = trafficWorld({ agents: 10, maxAwake: 2, player: ARENA, seed: 11 });
      placePlayer(eng, HWY_KERB, 900);
      run(eng, 200);
      tr.placeAgent(0, HWY_KERB, 800, 25);
      tr.placeAgent(1, HWY_INNER, 760, 28);
      tr.placeAgent(2, HWY_KERB, 950, 20);
      host.handle({ type: 'input', objectId: 1, actions: { throttle: 0.6, gearSelect: 1 } });
      run(eng, 2000 * 8);
      const awake = tr.agents.filter((a: TrafficAgent) => a.alive && a.awake).length;
      hashes.push(stateHash(eng));
      if (k === 0) console.log(`[traffic] determinism: ${tr.agentCount} agents, ${awake} awake, hash 0x${hashes[0]!.toString(16)}`);
    }
    expect(hashes[1]).toBe(hashes[0]);
  }, 240_000);
});

/** Debug helper kept for failures: path description. */
export function describePath(p: RoutePath): string {
  return `${p.index}:${p.kind}:${p.road ?? p.turn}:${p.dir}:${p.lane}`;
}
