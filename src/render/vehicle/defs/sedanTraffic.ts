/**
 * SEDAN_TRAFFIC visual (P6 T2): the player sedan's body (buildSedanVisual)
 * re-pointed at the cheaper traffic rig (src/sim/vehicle/defs/sedanTraffic.ts).
 *
 * The traffic rig keeps every sedan node id at the same rest position
 * except the hood sub-rig (hood_*), the engine / gearbox block (eng_*,
 * gbx_*), the door-station floor pans (s6/s7/s8_fl_L/R) and the roof
 * centres s6_rf / s8_rf, and its beam topology differs. So, per panel:
 *  - node selectors that match no traffic node are dropped (the rest of
 *    the panel's frame carries it: floors on s5/s9 floors + tunnel + sills,
 *    roof on the rails);
 *  - panels left without nodes are RE-POINTED (REBIND): the hood binds to
 *    the fender tops, strut towers, radiator top and cowl (the structure it
 *    sits on); the engine cover to the towers and the rail tops;
 *  - glass beam pairs keep the pairs that are beams of the traffic rig,
 *    else become `between` the surviving endpoint groups;
 *  - the hood is welded on (no hood sub-rig to tear off: detach null).
 * Every panel binds at every LOD (sedanTraffic.test.ts).
 */
import { SEDAN_TRAFFIC } from '../../../sim/vehicle/defs/sedanTraffic';
import { once, setVisualExtras } from '../lods';
import type { BeamSelector, GlassSpec, PaintDef, PanelDef, VehicleVisualDef } from '../types';
import { buildSedanVisual, SEDAN_FOLLOW, type SedanBuildOptions } from './sedan';

/** Body node ids of the traffic rig (VehicleDef body nodes; wheel nodes are never panel binds). */
const TRAFFIC_NODE_IDS: readonly string[] = SEDAN_TRAFFIC.body.nodes.map((n) => n.id);
const TRAFFIC_NODES = new Set(TRAFFIC_NODE_IDS);
const TRAFFIC_BEAMS = new Set<string>();
for (const b of SEDAN_TRAFFIC.body.beams) {
  TRAFFIC_BEAMS.add(`${b.a}|${b.b}`);
  TRAFFIC_BEAMS.add(`${b.b}|${b.a}`);
}

/** Panels whose own nodes are gone from the traffic rig: the structure that carries them instead. */
export const TRAFFIC_REBIND: Readonly<Record<string, readonly string[]>> = {
  hood: ['s1_fd_*', 's2_fd_*', 's2_rt', 's3_fd_*', 's3_tw_*', 's4_fd_*', 's5_cw*', 's5_fw_*'],
  hoodSeal: ['s1_fd_*', 's2_fd_*', 's2_rt', 's3_fd_*', 's3_tw_*', 's4_fd_*', 's5_cw*', 's5_fw_*'],
  engineCover: ['s2_rt', 's2_rh_*', 's3_tw_*', 's3_rh_*', 's4_rh_*'],
};

/**
 * Glass strain beams with no traffic counterpart: the windscreen's cowl →
 * roof-centre diagonals (s6_rf is gone) become the cowl → belt-top
 * diagonals and the roof header across the screen top.
 */
export const TRAFFIC_GLASS_BEAMS: Readonly<Record<string, BeamSelector>> = {
  windscreen: { pairs: [['s5_cw', 's6_bt_R'], ['s5_cw', 's6_bt_L'], ['s6_rf_R', 's6_rf_L']] },
};

const globCache = new Map<string, RegExp>();
function matches(sel: string): boolean {
  if (!sel.includes('*')) return TRAFFIC_NODES.has(sel);
  let re = globCache.get(sel);
  if (!re) {
    re = new RegExp(`^${sel.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    globCache.set(sel, re);
  }
  return TRAFFIC_NODE_IDS.some((id) => re!.test(id));
}

/** A dropped node id → the glob of its station/tag family that survives ('s6_rf' → 's6_rf_*'). */
function family(id: string): string | null {
  if (TRAFFIC_NODES.has(id)) return id;
  const stem = id.replace(/_[LRC]$/, '');
  const glob = `${stem}_*`;
  return matches(glob) ? glob : null;
}

function repointBeams(sel: BeamSelector): BeamSelector {
  if (!('pairs' in sel)) {
    return { between: [sel.between[0].filter(matches), sel.between[1].filter(matches)] };
  }
  const kept = sel.pairs.filter(([a, b]) => TRAFFIC_BEAMS.has(`${a}|${b}`));
  if (kept.length > 0) return { pairs: kept };
  const A = new Set<string>();
  const B = new Set<string>();
  for (const [a, b] of sel.pairs) {
    const fa = family(a);
    const fb = family(b);
    if (fa) A.add(fa);
    if (fb) B.add(fb);
  }
  return { between: [[...A], [...B]] };
}

function repointPanel(p: PanelDef): PanelDef {
  const rebind = TRAFFIC_REBIND[p.id];
  const bind = rebind ?? p.bind.filter(matches);
  const out: PanelDef = { ...p, bind };
  if (p.id === 'hood') out.detach = null;
  else if (p.detach && p.detach.attach !== 'boundary') out.detach = { ...p.detach, attach: repointBeams(p.detach.attach) };
  if (p.glass) {
    const glass: GlassSpec = { ...p.glass, beams: TRAFFIC_GLASS_BEAMS[p.id] ?? repointBeams(p.glass.beams) };
    out.glass = glass;
  }
  return out;
}

/** Silver metallic: the catalog's palettes[0] (everyday colours; per-agent paint comes from the palette). */
export const SEDAN_TRAFFIC_PAINT: PaintDef = {
  color: 0xa9adb3,
  metallic: 0.85,
  roughness: 0.3,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
  flake: { density: 0.6, scale: 0.6, intensity: 0.6 },
};

/** The traffic sedan's visual at a render LOD (0 full, 1 ≈ 40 %, 2 ≈ 20 % of the triangles). */
export function buildSedanTrafficVisual(opts: SedanBuildOptions = { lod: 0 }): VehicleVisualDef {
  const base = buildSedanVisual(opts);
  return { ...base, vehicle: SEDAN_TRAFFIC.name, panels: base.panels.map(repointPanel), paint: SEDAN_TRAFFIC_PAINT, plate: 'TR 4FFC' };
}

/** LOD0 traffic sedan visual (its LOD1/LOD2 + door-card followers registered below). */
export const SEDAN_TRAFFIC_VISUAL: VehicleVisualDef = buildSedanTrafficVisual({ lod: 0 });

setVisualExtras(SEDAN_TRAFFIC_VISUAL, {
  lods: [once(() => buildSedanTrafficVisual({ lod: 1 })), once(() => buildSedanTrafficVisual({ lod: 2 }))],
  follow: SEDAN_FOLLOW,
});
