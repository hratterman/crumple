/**
 * Challenge set-up helpers (pure; shared by app/challenges.ts and the
 * headless playtests): spawn transforms, challenge prop spawns (dynamic
 * ids) + their pin watches, opponent ids.
 */
import { placeOnGround, type RestPose } from '../../app/spawn';
import { PROP_DYNAMIC_ID_BASE, type PropSpawn, type Transform } from '../../protocol/messages';
import { compilePropRig } from '../../sim/props/catalog';
import { resolvePropInstances } from '../../sim/props/placement';
import type { PropInstance } from '../../sim/props/types';
import type { PinWatch } from './sample';
import type { ChallengeDef, SpawnDef } from './types';

/** Challenge props take dynamic prop ids from here (leaves the low dynamic ids to debug tools). */
export const CHALLENGE_PROP_ID_BASE = PROP_DYNAMIC_ID_BASE + 512;
/** Challenge opponents: vehicle objectIds 20.. (player 1, the soft cube 2, traffic 100+). */
export const OPPONENT_ID_BASE = 20;

const DEG = Math.PI / 180;

/** Start transform for a rig: y null → dropped on the terrain, y given → on that deck height. */
export function spawnTransform(sp: SpawnDef, rest: RestPose, heightAt: (x: number, z: number) => number): Transform {
  const y = sp.pos[1];
  const ground = y === null ? { heightAt } : { heightAt: () => y };
  return placeOnGround(rest, ground, sp.pos[0], sp.pos[2], sp.yawDeg * DEG);
}

export interface ChallengePropSetup {
  spawns: PropSpawn[];
  /** Instances as the prop renderer / FX want them (dynamic ids). */
  instances: PropInstance[];
  pins: PinWatch[];
}

/** Resolves a def's props (y on the terrain footprint like layout props) into dynamic-id spawns + pin watches. */
export function challengeProps(def: ChallengeDef, heightAt: (x: number, z: number) => number): ChallengePropSetup {
  const list = def.props ?? [];
  if (list.length === 0) return { spawns: [], instances: [], pins: [] };
  const placements = list.map((p, k) => ({
    id: `${def.id}:${p.group}${k}`,
    prop: p.prop,
    pos: [p.pos[0], p.pos[1], p.pos[2]] as [number, number | null, number],
    ...(p.facing ? { facing: [p.facing[0], p.facing[1]] as [number, number] } : {}),
  }));
  const resolved = resolvePropInstances(placements, heightAt);
  const instances: PropInstance[] = resolved.map((r, k) => ({ ...r, objectId: CHALLENGE_PROP_ID_BASE + k }));
  const spawns: PropSpawn[] = instances.map((r) => ({ objectId: r.objectId, prop: r.prop, transform: { pos: [...r.transform.pos], quat: [...r.transform.quat] }, asleep: true }));
  const pins: PinWatch[] = [];
  instances.forEach((r, k) => {
    const rig = compilePropRig(r.prop);
    let cy = 0;
    for (let i = 0; i < rig.nodeCount; i++) cy += rig.nodePos[3 * i + 1]!;
    cy /= rig.nodeCount;
    pins.push({ objectId: r.objectId, group: list[k]!.group, x: r.transform.pos[0], z: r.transform.pos[2], cy: r.transform.pos[1] + cy, baseY: r.transform.pos[1] });
  });
  return { spawns, instances, pins };
}
