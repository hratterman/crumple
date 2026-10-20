/**
 * SEDAN_TRAFFIC visual (P6 T2): the player sedan's body (buildSedanVisual)
 * re-pointed at the cheaper traffic rig (src/sim/vehicle/defs/sedanTraffic.ts).
 *
 * The traffic rig keeps every sedan node id at the same rest position
 * except the hood sub-rig (hood_*), the engine / gearbox block (eng_*,
 * gbx_*), the B-pillar floor pans (s7_fl_L/R) and whole stations
 * (SKIP_STATIONS: the door stations s6 / s8 and the trunk stations s11 /
 * s12), and its beam topology differs. So, per panel:
 *  - a node selector on a skipped station becomes the same tag on the kept
 *    stations either side of it (s6_bt_R → s7_bt_R; a station without that
 *    tag lends its nodes on the same side: s12_ld_R → s13_*_R): the panel
 *    spans the longer bay the rig has there;
 *  - other selectors that match no traffic node are dropped (the rest of
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
import { SEDAN_TRAFFIC, SKIP_STATIONS } from '../../../sim/vehicle/defs/sedanTraffic';
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
 * roof diagonals (the s6 station is gone) become every beam from the cowl
 * to the B-pillar hoop's roof and belt nodes.
 */
export const TRAFFIC_GLASS_BEAMS: Readonly<Record<string, BeamSelector>> = {
  windscreen: { between: [['s5_cw', 's5_cw_*'], ['s7_rf', 's7_rf_*', 's7_bt_*']] },
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

/** A selector on a skipped station → the same tag on the nearest kept stations either side that have it. */
function acrossSkipped(sel: string): string[] {
  const m = /^s(\d+)_(.*)$/.exec(sel);
  if (!m || !SKIP_STATIONS.has(Number(m[1]))) return [];
  const out: string[] = [];
  for (const dir of [-1, 1]) {
    let k = Number(m[1]) + dir;
    while (SKIP_STATIONS.has(k)) k += dir;
    if (k < 0) continue;
    const s = `s${k}_${m[2]}`;
    // Same tag there, else that station's nodes on the same side (a tag the station does not have).
    const side = /_([LR])$/.exec(m[2])?.[1];
    const ring = side ? `s${k}_*_${side}` : `s${k}_*`;
    if (matches(s)) out.push(s);
    else if (matches(ring)) out.push(ring);
  }
  return out;
}

/** A panel's node selectors on the traffic rig (see the header). */
function repointBind(bind: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sel of bind) {
    if (matches(sel)) out.add(sel);
    else for (const s of acrossSkipped(sel)) out.add(s);
  }
  return [...out];
}

/** A dropped node id → the glob of its station/tag family that survives ('s6_rf' → 's6_rf_*'), or its skipped-station stand-ins. */
function family(id: string): string[] {
  if (TRAFFIC_NODES.has(id)) return [id];
  const stem = id.replace(/_[LRC]$/, '');
  const glob = `${stem}_*`;
  if (matches(glob)) return [glob];
  return acrossSkipped(id);
}

function repointBeams(sel: BeamSelector): BeamSelector {
  if (!('pairs' in sel)) {
    return { between: [repointBind(sel.between[0]), repointBind(sel.between[1])] };
  }
  const kept = sel.pairs.filter(([a, b]) => TRAFFIC_BEAMS.has(`${a}|${b}`));
  if (kept.length > 0) return { pairs: kept };
  const A = new Set<string>();
  const B = new Set<string>();
  for (const [a, b] of sel.pairs) {
    for (const f of family(a)) A.add(f);
    for (const f of family(b)) B.add(f);
  }
  return { between: [[...A], [...B]] };
}

function repointPanel(p: PanelDef): PanelDef {
  const rebind = TRAFFIC_REBIND[p.id];
  const bind = rebind ?? repointBind(p.bind);
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
