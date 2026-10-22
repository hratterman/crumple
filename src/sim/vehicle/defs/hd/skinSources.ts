/**
 * R-RIG: which render panels become sampled skins, per car, and the
 * extraction used by tools/rig-skins.mjs (and the render-side drift test).
 *
 * PURE: no render import. The visual def and its tessellation are passed in
 * structurally (the tool / the render test load them); module paths are
 * plain strings.
 */
import type { VehicleDef } from '../../types';
import { envelopeOf, hashSkins, sampleSkin, type SampleMesh } from '../../../rig/gen/sample';
import type { SkinPanelData, SkinSet } from '../../../rig/gen/types';

export type HdCar = 'sedan' | 'coupe' | 'pickup' | 'boxtruck' | 'beater';
export type HdTier = 'high' | 'ultra';

/** Skin pitch per tier, m (R-RIG brief: ~8–12 cm on outer skins; high a little coarser). */
export const SKIN_TIERS: Readonly<Record<HdTier, number>> = { high: 0.15, ultra: 0.11 };

export const SKIN_SOURCES: Readonly<Record<HdCar, { visualModule: string; visualExport: string; simModule: string; simExport: string }>> = {
  sedan: { visualModule: 'render/vehicle/defs/sedan.ts', visualExport: 'SEDAN_VISUAL', simModule: 'sim/vehicle/defs/sedan.ts', simExport: 'SEDAN' },
  coupe: { visualModule: 'render/vehicle/defs/coupe.ts', visualExport: 'COUPE_VISUAL', simModule: 'sim/vehicle/defs/coupe.ts', simExport: 'COUPE' },
  pickup: { visualModule: 'render/vehicle/defs/pickup.ts', visualExport: 'PICKUP_VISUAL', simModule: 'sim/vehicle/defs/pickup.ts', simExport: 'PICKUP' },
  boxtruck: { visualModule: 'render/vehicle/defs/boxtruck.ts', visualExport: 'BOXTRUCK_VISUAL', simModule: 'sim/vehicle/defs/boxtruck.ts', simExport: 'BOXTRUCK' },
  beater: { visualModule: 'render/vehicle/defs/beater.ts', visualExport: 'BEATER_VISUAL', simModule: 'sim/vehicle/defs/beater.ts', simExport: 'BEATER' },
};

/**
 * Per-panel pitch multipliers: big flat panels (the box truck's box: 9–10 m² aluminium sides / roof on posts and
 * bows) sample coarser so the truck stays within ~3× its standard node count.
 */
export const SKIN_PITCH_SCALE: Readonly<Partial<Record<HdCar, Readonly<Record<string, number>>>>> = {
  boxtruck: { boxSideR: 2, boxSideL: 2, boxRoof: 2.4, boxRails: 1.6, rollerDoor: 1.8, boxFront: 1.5, cabShell: 1.15 },
};

/**
 * Panels left on their frame nodes: the box truck's rub rails and battens are strips one sample row wide (no
 * well-shaped triads for the binder on a single row).
 */
export const SKIN_EXCLUDE: Readonly<Partial<Record<HdCar, readonly string[]>>> = {
  boxtruck: ['boxRails', 'battensR', 'battensL'],
};

/** Render panel kinds whose outer sheet becomes a skin (paint / exterior sheet metal and fascias). */
const SKIN_KINDS = new Set(['hood', 'trunk', 'door', 'fender', 'bumper', 'roof', 'body']);
const SKIN_MATERIALS = new Set(['paint', 'trim']);
/** Smallest outer area worth a sheet, m² (sails, fuel doors, intake fins stay on their frame nodes). */
const MIN_AREA = 0.05;

/** Structural view of a render panel (render/vehicle/types.ts PanelDef). */
export interface SkinSourcePanel {
  id: string;
  kind: string;
  material: string;
  bind: readonly string[];
}

/** `*` glob (render NodeSelector semantics: `*` = any run of characters). */
export function globToRegExp(sel: string): RegExp {
  return new RegExp(`^${sel.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** Body node ids of `def` matching a render NodeSelector (wheel nodes never). */
export function resolveBind(def: VehicleDef, bind: readonly string[]): string[] {
  const ids = def.body.nodes.map((n) => n.id);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sel of bind) {
    const re = globToRegExp(sel);
    for (const id of ids) {
      if (!seen.has(id) && re.test(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function isSkinPanel(p: SkinSourcePanel): boolean {
  return SKIN_KINDS.has(p.kind) && SKIN_MATERIALS.has(p.material);
}

/** Samples a car's skin panels at `pitch` (geoms = tessellateVehicle(visual), same order as visual.panels). */
export function extractSkins(
  car: string,
  visual: { panels: readonly SkinSourcePanel[] },
  geoms: readonly SampleMesh[],
  def: VehicleDef,
  pitch: number,
): SkinSet {
  const all: number[] = [];
  visual.panels.forEach((p, i) => {
    if (p.kind === 'interior' || p.kind === 'glass') return;
    const g = geoms[i]!;
    for (let k = 0; k < g.position.length; k++) all.push(g.position[k]!);
  });
  const envelope = envelopeOf(all);
  const panels: SkinPanelData[] = [];
  visual.panels.forEach((p, i) => {
    if (!isSkinPanel(p)) return;
    const attach = resolveBind(def, p.bind);
    if (attach.length === 0) return;
    const scale = SKIN_PITCH_SCALE[car as HdCar]?.[p.id] ?? 1;
    const s = sampleSkin(geoms[i]!, { id: p.id, kind: p.kind, material: p.material, attach }, { pitch: pitch * scale, envelope });
    if (s && s.area >= MIN_AREA && s.pos.length >= 4 * 3 && !SKIN_EXCLUDE[car as HdCar]?.includes(p.id)) panels.push(s);
  });
  return { vehicle: car, pitch, panels, hash: hashSkins(panels) };
}

/** The generated TS data module (typed, so tsc never infers a literal type for the arrays). */
export function formatSkinModule(set: SkinSet, label: string): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * GENERATED by tools/rig-skins.mjs (${label}): outer sheets of the render panels sampled at`);
  lines.push(` * ${set.pitch} m (src/sim/rig/gen/sample.ts). Do not edit; re-run the tool after a body-shape change.`);
  lines.push(' */');
  lines.push("import type { SkinSet } from '../../../../rig/gen/types';");
  lines.push('');
  lines.push('export const SKINS: SkinSet = {');
  lines.push(`  vehicle: ${JSON.stringify(set.vehicle)},`);
  lines.push(`  pitch: ${set.pitch},`);
  lines.push(`  hash: 0x${set.hash.toString(16)},`);
  lines.push('  panels: [');
  for (const p of set.panels) {
    lines.push('    {');
    lines.push(`      id: ${JSON.stringify(p.id)}, kind: ${JSON.stringify(p.kind)}, material: ${JSON.stringify(p.material)}, area: ${p.area},`);
    lines.push(`      attach: ${JSON.stringify(p.attach)},`);
    lines.push(`      pos: ${JSON.stringify(p.pos)},`);
    lines.push(`      nrm: ${JSON.stringify(p.nrm)},`);
    lines.push(`      ij: ${JSON.stringify(p.ij)},`);
    lines.push(`      tris: ${JSON.stringify(p.tris)},`);
    lines.push(`      quads: ${JSON.stringify(p.quads)},`);
    lines.push(`      edge: ${JSON.stringify(p.edge)},`);
    lines.push('    },');
  }
  lines.push('  ],');
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}
