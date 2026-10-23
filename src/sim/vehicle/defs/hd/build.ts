/**
 * R-RIG: per-car high-density variant assembly (PURE DATA MODULE). A car
 * provides its standard def, crash probes, sampled skins and (optionally)
 * sheet construction, donor weights and members; everything else is
 * generic.
 */
import { refineVehicle, type RefineOptions, type RefinedVehicle } from '../../../rig/gen/refine';
import type { BoxMemberSpec } from '../../../rig/gen/member';
import type { SkinPanelData, SkinSet, SkinSpec } from '../../../rig/gen/types';
import type { CrashProbes } from '../../crash';
import { globMatch, type ShellDef } from '../../shellDefs';
import type { VehicleDef } from '../../types';
import type { HdCar, HdTier } from './skinSources';
import type { VehicleVariant } from './variants';

export interface HdCarConfig {
  car: HdCar;
  base: VehicleDef;
  /** The car's standard crash probes (every probed node is kept by the generator). */
  probes: CrashProbes;
  skins: Readonly<Record<HdTier, SkinSet>>;
  /** Sheet construction per sampled panel (default `defaultSkinSpec`). */
  skinSpec?: (p: SkinPanelData) => SkinSpec | null;
  /** Mass-donor weights (default `shellDonorWeight(base)`). */
  donorWeight?: (id: string) => number;
  members?: (tier: HdTier) => BoxMemberSpec[];
  /** refine.ts RefineOptions.matchInertia / wholeZoneSheetRelease / suspension. */
  matchInertia?: boolean;
  suspension?: boolean;
  localSkinMass?: boolean;
  wholeZoneSheetRelease?: RefineOptions['wholeZoneSheetRelease'];
  /** Sheets that can tear off whole in a crash (render panel ids): exempt from the crash harness's span check. */
  detachable?: readonly string[];
}

/** Outer-panel sheet of a modern car: 0.7–0.75 mm bake-hardening steel, 3 mm PP/EPDM fascias, 2.5 mm PP sill covers. */
export function defaultSkinSpec(p: SkinPanelData, outer: { grade: string; gauge: number } = { grade: 'BH220', gauge: 0.0007 }): SkinSpec | null {
  const thick = { grade: outer.grade, gauge: outer.gauge + 0.00005 };
  switch (p.kind) {
    case 'hood':
    case 'trunk':
    case 'door':
      return { panel: p.id, ...outer, seam: 'hem', standoff: 0.3 };
    case 'fender':
      return { panel: p.id, ...outer, seam: 'bolt', standoff: 0.2 };
    case 'roof':
      return { panel: p.id, ...thick, seam: 'weld', standoff: 0.3 };
    case 'bumper':
      return { panel: p.id, grade: 'PP_EPDM', gauge: 0.003, seam: 'bolt', standoff: 0.2 };
    case 'body':
      if (p.material === 'trim') return { panel: p.id, grade: 'PP_EPDM', gauge: 0.0025, seam: 'glue', standoff: 0.15 };
      return { panel: p.id, ...thick, seam: 'weld', standoff: 0.25 };
    default:
      return null;
  }
}

/**
 * Default mass-donor weights from the standard shell layout: the front crumple zone (tuned crush) 0.12, the
 * safety cell's side frames (|x| ≥ 0.8 of the widest cell node: door frames, sills, pillars — pole / door-wave
 * targets and the cell's yield bond) and the firewall ring 0.3, everything else (floor, tunnel, roof, rear zone,
 * hood / tailgate) 1. A small weight keeps a node's change inside its stability headroom.
 */
export function shellDonorWeight(base: VehicleDef): (id: string) => number {
  const shells: ShellDef[] = base.shell === false || base.shell === undefined ? [] : Array.isArray(base.shell) ? (base.shell as ShellDef[]) : [base.shell as ShellDef];
  const pos = new Map(base.body.nodes.map((n) => [n.id, n.pos]));
  const zoneOf = (id: string): { whole: boolean; yield: boolean; index: number } | null => {
    for (const s of shells) {
      if (s.ids && !s.ids.some((p) => globMatch(id, p))) continue;
      const zones = s.zones ?? [];
      const z = zones.findIndex((zn) => zn.ids.some((p) => globMatch(id, p)));
      return z < 0 ? null : { whole: !!zones[z]!.whole, yield: !!zones[z]!.yield, index: z };
    }
    return null;
  };
  let cellX = 0;
  for (const n of base.body.nodes) {
    const z = zoneOf(n.id);
    if (z && z.yield && !z.whole) cellX = Math.max(cellX, Math.abs(n.pos[0]));
  }
  return (id: string): number => {
    const z = zoneOf(id);
    if (!z) return 1;
    if (z.whole && z.yield) return z.index === 0 ? 0.12 : 1; // shellLayout: zone 0 = front crumple zone, 1 = rear
    if (z.whole) return 0.3; // firewall ring / box bodies
    if (z.yield && Math.abs(pos.get(id)?.[0] ?? 0) >= 0.8 * cellX) return 0.3;
    return 1;
  };
}

/**
 * Mass-donor weights of a station-lattice car (sedan / coupe / beater id scheme `s{i}_{tag}_{side}`): mostly the
 * floor, tunnel, roof rails and the rear zone give the sheets' mass; the bumper beam and crash-can tips (stations
 * 0–1) none (lighter, their mounts tore less at 100 km/h: 0.48 vs the standard's 0.56), the front crumple zone
 * (stations 2–4: tuned crush) 0.12, the cell's side frames (sills, door mids, belt line, hinge pillars, quarter / cowl, stations 5 to
 * `lastCellStation`: the pole / door-wave targets and the cell's yield bond) 0.3, the hood 0.6. Unlike
 * `shellDonorWeight`'s |x| rule, the hinge pillar is protected even where it sits inboard (the coupe's pole case
 * pulled a light `s5_hp` through the pole).
 */
export function stationDonorWeight(lastCellStation: number): (id: string) => number {
  return (id) => {
    const st = /^s(\d+)_([a-z]+)/.exec(id);
    if (id.startsWith('hood_')) return 0.6;
    if (!st) return 1;
    const i = Number(st[1]);
    if (i <= 1) return 0; // bumper beam + crash-can tips: their mass is the bumper's inertia (100 km/h mount tear)
    if (i <= 4) return 0.12;
    if (i <= lastCellStation && ['sl', 'dm', 'bt', 'hp', 'qm', 'cw'].includes(st[2]!)) return 0.3;
    return 1;
  };
}

/**
 * Closed-section members of a station-lattice car (sedan / coupe / beater id scheme `s{i}_{tag}_{side}`): beaded
 * crash cans between the bumper face (`bl`, `bu`) and the rail tips, the front rails (`rl` low / `rh` high) to the
 * engine-bay rear; ultra adds the rear rails and cans. Wall pitch 10 cm (high) / 8 cm (ultra), cans 5 cm.
 */
export function stationMembers(tier: HdTier, o: { frontRail: readonly number[]; rearRail: readonly number[]; rearBumper: number; grade?: string; gauge?: number }): BoxMemberSpec[] {
  const pitch = tier === 'ultra' ? 0.08 : 0.1;
  const grade = o.grade ?? 'HSLA340';
  const gauge = o.gauge ?? 0.0018;
  const rail = (i: number): string[] => [`s${i}_rl_R`, `s${i}_rh_R`];
  const out: BoxMemberSpec[] = [
    { id: 'canFR', stations: [['s0_bl_R', 's0_bu_R'], rail(o.frontRail[0]!)], width: 0.07, height: 0.2, inward: [-1, 0, 0], grade, gauge: gauge - 0.0002, pitch: 0.05, beads: 0.08, mirror: true },
    { id: 'railFR', stations: o.frontRail.map(rail), width: 0.07, height: 0.24, inward: [-1, 0, 0], grade, gauge, pitch, beads: 0.05, beadSpan: [0, 0.4], mirror: true },
  ];
  if (tier === 'ultra') {
    out.push(
      { id: 'railRR', stations: o.rearRail.map(rail), width: 0.07, height: 0.22, inward: [-1, 0, 0], grade: o.grade ?? 'DP600', gauge: gauge - 0.0002, pitch, beads: 0.05, beadSpan: [0.5, 1], mirror: true },
      { id: 'canRR', stations: [rail(o.rearRail[o.rearRail.length - 1]!), [`s${o.rearBumper}_bl_R`, `s${o.rearBumper}_bu_R`]], width: 0.07, height: 0.2, inward: [-1, 0, 0], grade, gauge: gauge - 0.0002, pitch: 0.05, beads: 0.08, mirror: true },
    );
  }
  return out;
}

export function hdProbes(probes: CrashProbes, detachable: readonly string[] = []): CrashProbes {
  return {
    ...probes,
    exemptPrefixes: [...probes.exemptPrefixes, ...detachable.map((p) => `k_${p}_`)],
    generatedPrefixes: ['k_', 'm_'],
  };
}

/** One generation (not memoized; experiments may override options). */
export function buildHd(cfg: HdCarConfig, tier: HdTier, overrides: Partial<RefineOptions> = {}): RefinedVehicle {
  return refineVehicle(cfg.base, {
    name: `${cfg.car}.${tier}`,
    skins: cfg.skins[tier],
    skinSpec: cfg.skinSpec ?? ((p) => defaultSkinSpec(p)),
    members: cfg.members?.(tier) ?? [],
    massDonorWeight: cfg.donorWeight ?? shellDonorWeight(cfg.base),
    ...(cfg.matchInertia ? { matchInertia: true } : {}),
    ...(cfg.suspension ? { suspension: true } : {}),
    ...(cfg.localSkinMass ? { localSkinMass: true } : {}),
    ...(cfg.wholeZoneSheetRelease ? { wholeZoneSheetRelease: cfg.wholeZoneSheetRelease } : {}),
    ...overrides,
  });
}

/** Memoized HD variants of a car. */
export function hdVariants(cfg: HdCarConfig): { raw: (tier: HdTier) => RefinedVehicle; variant: (tier: HdTier) => VehicleVariant; probes: CrashProbes } {
  const cache = new Map<HdTier, RefinedVehicle>();
  const probes = hdProbes(cfg.probes, cfg.detachable);
  const raw = (tier: HdTier): RefinedVehicle => {
    let r = cache.get(tier);
    if (!r) {
      r = buildHd(cfg, tier);
      cache.set(tier, r);
    }
    return r;
  };
  return {
    raw,
    probes,
    variant: (tier) => {
      const r = raw(tier);
      return { car: cfg.car, quality: tier, def: r.def, probes, report: r.report, collision: r.collision, skinNodes: r.skinNodes };
    },
  };
}
