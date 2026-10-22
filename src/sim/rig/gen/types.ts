/**
 * R-RIG: high-density rig generator — shared types (PURE DATA MODULE: no
 * engine / state / worker imports, no three, no DOM; main-importable like
 * src/sim/rig/types.ts).
 *
 * PIPELINE (docs/CONTRACTS.md "R-RIG"):
 *   1. tools/rig-skins.mjs samples each car's lofted render panels (outer
 *      sheet only) into a node grid at the variant's skin pitch
 *      (sampleSkin, ./sample.ts) and writes SkinSet data modules next to the
 *      HD defs (src/sim/vehicle/defs/hd/skins/*). The sim never imports
 *      src/render: the surfaces cross the boundary as generated data.
 *   2. refineVehicle (./refine.ts) takes the STANDARD VehicleDef as the
 *      backbone (its ids, hardpoints, suspension, wheels, drivetrain and
 *      shell zones are kept, so every harness probe and R-PHYS's suspension
 *      rates apply unchanged), rebuilds chosen load paths as closed-section
 *      members (./member.ts), hangs the sheet-metal skins on it with spot-weld
 *      seams / hems / hinges (./skin.ts), redistributes the mass (real
 *      gauges for the new parts, the backbone rescaled so total mass and CG
 *      match: ./mass.ts) and re-derives every touched beam within the per-
 *      node stability budget.
 */

/** One sampled outer sheet of a render panel (rest pose, rig-local metres). */
export interface SkinPanelData {
  /** Render panel id (VehicleVisualDef.panels[].id). */
  id: string;
  /** Render PanelKind. */
  kind: string;
  /** Render material slot ('paint', 'trim', …). */
  material: string;
  /**
   * Standard-rig body node ids the render panel binds to (its NodeSelector
   * resolved against the standard rig): the structure the sheet is fastened
   * to.
   */
  attach: string[];
  /** Node rest positions, xyz flat (rounded to 0.1 mm). */
  pos: number[];
  /** Outward unit normals, xyz flat (rounded to 1e-3). */
  nrm: number[];
  /** Sample-grid coordinates (i along u, j along v) per node; bending beams run along grid lines. */
  ij: number[];
  /** Triangles (node indices), CCW seen from outside. Quads are split along (a, c) and listed in `quads`. */
  tris: number[];
  /** Quads a, b, c, d (CCW): their second diagonal (b, d) is a shear brace. */
  quads: number[];
  /** Nodes on the sheet boundary (flanges / shut lines / hems). */
  edge: number[];
  /** Outer area represented, m². */
  area: number;
}

/** All sampled skins of one car at one pitch. */
export interface SkinSet {
  vehicle: string;
  /** Target node pitch on the skin, m. */
  pitch: number;
  panels: SkinPanelData[];
  /** FNV-1a of the sampled data (regeneration check). */
  hash: number;
}

/** Sheet / section material (real grades). */
export interface MaterialGrade {
  id: string;
  /** Yield strength, Pa. */
  yield: number;
  /** Ultimate tensile strength, Pa. */
  uts: number;
  /** Elongation at break (engineering strain). */
  elongation: number;
  /** Density, kg/m³. */
  density: number;
  /** Young's modulus, Pa. */
  E: number;
}

/** How a sheet is fastened to the structure along its boundary. */
export type SeamKind = 'weld' | 'hem' | 'bolt' | 'glue';

/** Per panel construction of the skin (generator spec, per car). */
export interface SkinSpec {
  /** Render panel id. */
  panel: string;
  grade: string;
  /** Sheet thickness, m. */
  gauge: number;
  seam: SeamKind;
  /** Node-id prefix of the sheet, default `k_<panel>`. */
  prefix?: string;
  /**
   * Interior support: every interior sheet node also gets a soft standoff
   * to its nearest attach node within this reach, m (door inner panel,
   * anti-flutter mastic, roof bows). 0 = none.
   */
  standoff?: number;
  /** Shell tier override for the sheet's nodes ('front' | 'rear' | 'cell' | 'firewall'), default the attach nodes' majority. */
  zone?: ShellZoneName;
  /** Attach-node override (ids or globs on the backbone); default SkinPanelData.attach. */
  attach?: readonly string[];
  /** Membrane yield strain at the reference pitch, default materials.ts sheetYieldStrain(grade) (a tired, rusty sheet sets earlier). */
  yieldStrain?: number;
}

export type ShellZoneName = 'front' | 'rear' | 'cell' | 'firewall' | 'none';

/** A closed-section member rebuilt along a backbone chain (./member.ts). */
export interface MemberSpec {
  id: string;
  /**
   * Backbone node ids along the member, in order (the chain's own beams
   * between consecutive ids are REPLACED by the section). Mirrored for the
   * other side when `mirror` is set: `_R` ↔ `_L` suffixes swapped.
   */
  chain: readonly string[];
  mirror?: boolean;
  /** Section width (across, horizontal) and height, m. */
  width: number;
  height: number;
  grade: string;
  /** Wall thickness, m. */
  gauge: number;
  /** Station pitch along the member, m. */
  pitch: number;
  /** Crush-initiator beads: alternate stations' sections are this fraction larger / smaller (accordion folding). 0 = none. */
  beads?: number;
  /** Part of the chain (fractions of its length) carrying beads, default the whole chain. */
  beadSpan?: [number, number];
  /**
   * Axial crush force of the section, N (mean progressive-buckling force).
   * Default from the section (Abramowicz–Jones square tube, Pm = 13.06·σ0·t^5/3·C^1/3).
   */
  crushForce?: number;
  /** Multiplier on the derived crush force (tuning to the standard rig's load path). */
  crushScale?: number;
}

/** R-CORE node-vs-triangle collision: triangles over rig node ids (outer skin), CCW seen from outside. */
export interface CollisionTriangle {
  a: string;
  b: string;
  c: string;
}

/** Generator report (stability at real masses, counts, mass audit). */
export interface RigGenReport {
  name: string;
  nodes: number;
  beams: number;
  bodyNodes: number;
  bodyBeams: number;
  skinNodes: number;
  skinBeams: number;
  memberNodes: number;
  memberBeams: number;
  weldBeams: number;
  /** Total free mass, kg, and the standard rig's. */
  mass: number;
  baseMass: number;
  /** CG (rest) of the variant and the standard rig. */
  cg: [number, number, number];
  baseCg: [number, number, number];
  /** Mass by part: skins, members, backbone body, other. */
  massBy: Record<string, number>;
  /** Worst node ω·dt at the generated masses (per group limit) and the MINIMASS drift, %. */
  worstOmegaDt: number;
  worstNode: string;
  worstDampDt: number;
  massDriftPct: number;
  collisionTris: number;
}
