/**
 * PROP CATALOG (P5, U1). PURE DATA MODULE: main may import it (P5 boundary
 * amendment); no engine/state/worker imports, no three, no DOM.
 *
 * Every entry's rig is solved at module load from realistic masses (see
 * defs/build.ts): node ω·dt ≤ PROP_OMEGA_DT_LIMIT, (Σd/m)·dt ≤ 0.6, base
 * node spheres touching y = 0, every node's ground radius = object-contact
 * radius (the nominal outer surface is the contact surface; nodes sit that
 * radius inside it). Node-id prefixes per key are documented in
 * ./types.ts (PropDef) and each def file.
 */
import { MaterialId } from '../../protocol/messages';
import { compileRig } from '../rig/builder';
import type { CompiledRig, RigDef } from '../rig/types';
import { BARREL_FULL_RIG, BARREL_FULL_WATER_KG, BARREL_RIG } from './defs/barrel';
import { FENCE_ANCHOR_BREAK_F, FENCE_PANEL_RIG, HAY_BALE_RIG, JERSEY_BARRIER_RIG, PALLET_RIG, WATER_BARRIER_RIG, WATER_BARRIER_WATER_KG } from './defs/barriers';
import { BOX_CARDBOARD_RIG, BOX_WOOD_RIG, CONCRETE_BLOCK_RIG } from './defs/box';
import { CONE_RIG } from './defs/cone';
import { LIGHT_POLE_ANCHOR_BREAK_F, LIGHT_POLE_RIG, MAILBOX_ANCHOR_BREAK_F, MAILBOX_RIG, SIGN_POST_ANCHOR_BREAK_F, SIGN_POST_RIG, STOP_SIGN_RIG } from './defs/posts';
import { GUARDRAIL_END_LINKS, GUARDRAIL_END_RIG, GUARDRAIL_LINKS, GUARDRAIL_RIG, GUARDRAIL_SOIL_BREAK } from './defs/guardrail';
import { TIRE_RIG } from './defs/tire';
import { PROP_KEYS, PROP_SLEEP_DEFAULTS, type PropDef, type PropKey, type PropProxy } from './types';

/** Worst-node beam ω·dt any catalog rig may have (contacts add ≤ sqrt(0.2) in quadrature). */
export const PROP_OMEGA_DT_LIMIT = 0.48;

/** Proxy = rest AABB of every node sphere (pos ± max(radius, objRadius)), pinned anchors excluded. */
export function proxyOf(rig: RigDef): PropProxy {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const n of rig.nodes) {
    if (n.mass <= 0) continue;
    const r = Math.max(n.radius ?? 0, n.objRadius ?? 0);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, n.pos[a]! - r);
      hi[a] = Math.max(hi[a]!, n.pos[a]! + r);
    }
  }
  const q = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    center: [q((lo[0]! + hi[0]!) / 2), q((lo[1]! + hi[1]!) / 2), q((lo[2]! + hi[2]!) / 2)],
    halfExtents: [q((hi[0]! - lo[0]!) / 2), q((hi[1]! - lo[1]!) / 2), q((hi[2]! - lo[2]!) / 2)],
  };
}

function def(
  key: PropKey,
  name: string,
  rig: RigDef,
  rest: Omit<PropDef, 'key' | 'name' | 'rig' | 'proxy' | 'sleep'> & { sleep?: PropDef['sleep'] },
): PropDef {
  if (rig.name !== key) throw new Error(`prop catalog: rig name ${rig.name} !== key ${key}`);
  return { key, name, rig, proxy: proxyOf(rig), sleep: rest.sleep ?? PROP_SLEEP_DEFAULTS, ...rest };
}

/**
 * Frames follow VehicleFrameDef: forward = normalize(front − origin) is
 * exactly −Z at rest, up = (top − origin) orthogonalized against it.
 */
const BOX_FRAME = { origin: 'c_4', front: 'c_0', top: 'c_6' };

export const PROP_CATALOG: Readonly<Record<PropKey, PropDef>> = {
  cone: def('cone', 'Traffic cone', CONE_RIG, {
    surface: 'plastic',
    material: MaterialId.plastic,
    density: 600,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 'base_3', front: 'base_0', top: 'tip' },
  }),
  barrel: def('barrel', '200 L steel drum', BARREL_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 200,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 'lidB_c', front: 'rim0_0', top: 'lidT_c' },
  }),
  tire: def('tire', 'Loose tyre', TIRE_RIG, {
    surface: 'rubber',
    material: MaterialId.rubber,
    density: 700,
    stackHeight: 0.2,
    anchor: null,
    frame: { origin: 'tI_6', front: 'tI_0', top: 'tO_6' },
  }),
  boxCardboard: def('boxCardboard', 'Cardboard box', BOX_CARDBOARD_RIG, {
    surface: 'cardboard',
    material: MaterialId.cardboard,
    density: 150,
    stackHeight: 0.6,
    anchor: null,
    frame: BOX_FRAME,
  }),
  boxWood: def('boxWood', 'Wooden crate', BOX_WOOD_RIG, {
    surface: 'wood',
    material: MaterialId.wood,
    density: 550,
    stackHeight: 0.8,
    anchor: null,
    frame: BOX_FRAME,
  }),
  signPost: def('signPost', 'Sign post', SIGN_POST_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 7800,
    stackHeight: 0,
    anchor: { nodes: 'anchor_*', breakF: SIGN_POST_ANCHOR_BREAK_F },
    frame: { origin: 'post_s0', front: 'post_0_0', top: 'post_s1' },
  }),
  lightPole: def('lightPole', 'Street light', LIGHT_POLE_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 7800,
    stackHeight: 0,
    anchor: { nodes: 'anchor_*', breakF: LIGHT_POLE_ANCHOR_BREAK_F },
    frame: { origin: 'pole_s0', front: 'pole_0_0', top: 'pole_s1' },
  }),
  stopSign: def('stopSign', 'Stop sign', STOP_SIGN_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 7800,
    stackHeight: 0,
    anchor: { nodes: 'anchor_*', breakF: SIGN_POST_ANCHOR_BREAK_F },
    frame: { origin: 'post_s0', front: 'post_0_0', top: 'post_s1' },
  }),
  mailbox: def('mailbox', 'Mailbox', MAILBOX_RIG, {
    surface: 'wood',
    material: MaterialId.wood,
    density: 700,
    stackHeight: 0,
    anchor: { nodes: 'anchor_*', breakF: MAILBOX_ANCHOR_BREAK_F },
    frame: { origin: 'post_s0', front: 'post_0_0', top: 'post_s1' },
  }),
  concreteBlock: def('concreteBlock', 'Concrete block', CONCRETE_BLOCK_RIG, {
    surface: 'concrete',
    material: MaterialId.concrete,
    density: 2400,
    stackHeight: 0.6,
    anchor: null,
    frame: BOX_FRAME,
  }),
  // ---- R-PHYS2
  barrelFull: def('barrelFull', '200 L drum (full)', BARREL_FULL_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    // 218 kg in 0.236 m³ (it barely floats, low)
    density: 924,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 'lidB_c', front: 'rim0_0', top: 'lidT_c' },
    fluid: { mass: BARREL_FULL_WATER_KG, areaPerBreak: 0.004, maxArea: 0.03, height: 0.85 },
  }),
  waterBarrier: def('waterBarrier', 'Water-filled barrier', WATER_BARRIER_RIG, {
    surface: 'plastic',
    material: MaterialId.plastic,
    density: 730,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 's1_bR', front: 's1_bL', top: 's1_tR' },
    fluid: { mass: WATER_BARRIER_WATER_KG, areaPerBreak: 0.006, maxArea: 0.05, height: 0.75, crackStrain: 0.01 },
  }),
  jerseyBarrier: def('jerseyBarrier', 'Concrete barrier', JERSEY_BARRIER_RIG, {
    surface: 'concrete',
    material: MaterialId.concrete,
    density: 2400,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 's1_bR', front: 's1_bL', top: 's1_tR' },
  }),
  hayBale: def('hayBale', 'Round hay bale', HAY_BALE_RIG, {
    surface: 'cardboard',
    material: MaterialId.cardboard,
    density: 150,
    stackHeight: 0,
    anchor: null,
    frame: { origin: 'ax_0', front: 'r0_6', top: 'r0_4' },
  }),
  pallet: def('pallet', 'Wooden pallet', PALLET_RIG, {
    surface: 'wood',
    material: MaterialId.wood,
    density: 550,
    stackHeight: 0.144,
    anchor: null,
    frame: { origin: 'b11', front: 'b10', top: 't11' },
  }),
  fencePanel: def('fencePanel', 'Picket fence', FENCE_PANEL_RIG, {
    surface: 'wood',
    material: MaterialId.wood,
    density: 600,
    stackHeight: 0,
    anchor: { nodes: 'anchor_*', breakF: FENCE_ANCHOR_BREAK_F },
    frame: { origin: 'p0_c', front: 'p0_0_0', top: 'p0_1_0' },
  }),
  guardrail: def('guardrail', 'W-beam guardrail', GUARDRAIL_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 7800,
    stackHeight: 0,
    anchor: { nodes: 'a*', breakF: GUARDRAIL_SOIL_BREAK },
    frame: { origin: 'k0b', front: 'h0b', top: 'rt4' },
    links: GUARDRAIL_LINKS,
  }),
  guardrailEnd: def('guardrailEnd', 'W-beam guardrail (anchored end)', GUARDRAIL_END_RIG, {
    surface: 'metal',
    material: MaterialId.metal,
    density: 7800,
    stackHeight: 0,
    anchor: { nodes: 'a*', breakF: GUARDRAIL_SOIL_BREAK },
    frame: { origin: 'k0b', front: 'h0b', top: 'rt4' },
    links: GUARDRAIL_END_LINKS,
  }),
};

export function isPropKey(key: unknown): key is PropKey {
  return typeof key === 'string' && (PROP_KEYS as readonly string[]).includes(key);
}

export function getPropDef(key: PropKey): PropDef {
  const d = PROP_CATALOG[key];
  if (!d) throw new Error(`unknown prop key '${String(key)}'`);
  return d;
}

const compiled = new Map<PropKey, CompiledRig>();
/** compileRig(PROP_CATALOG[key].rig), cached per key (both sides; the result is treated as immutable). */
export function compilePropRig(key: PropKey): CompiledRig {
  let c = compiled.get(key);
  if (c === undefined) {
    c = compileRig(getPropDef(key).rig);
    compiled.set(key, c);
  }
  return c;
}
