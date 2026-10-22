/**
 * R-RIG: real body-in-white material grades (pure data). Values are typical
 * catalogue minima (EN 10130 / EN 10268 / EN 10346 / VDA 239-100, Aluminium
 * EN 573 6016-T4, PP/EPDM fascia compound).
 *
 * How the generator uses them (docs/CONTRACTS.md "R-RIG"): the MASS of every
 * generated sheet / section is real (gauge × density × area); YIELD and CRUSH
 * forces of closed sections come from σ_y and the gauge (plastic collapse,
 * Abramowicz–Jones progressive folding); the ELASTIC stiffness cannot be real
 * at dt = 1/2000 s (steel's wave speed needs ~50× the node mass at 10 cm
 * pitch), so beams take the per-node stability budget, shared in proportion
 * to the members' real stiffness, and the shell cluster (shell.ts) supplies
 * the body's global stiffness while driving.
 */
import type { MaterialGrade } from './types';

const STEEL = { density: 7850, E: 210e9 };

export const GRADES: Readonly<Record<string, MaterialGrade>> = {
  /** Mild deep-drawing steel (inner panels, floor pans). */
  DC04: { id: 'DC04', yield: 180e6, uts: 300e6, elongation: 0.38, ...STEEL },
  /** Bake-hardening outer-panel steel (doors, fenders, roof, quarters). */
  BH220: { id: 'BH220', yield: 220e6, uts: 340e6, elongation: 0.32, ...STEEL },
  /** Mild structural (older cars: the beater). */
  S235: { id: 'S235', yield: 235e6, uts: 360e6, elongation: 0.26, ...STEEL },
  /** High-strength low-alloy (rails, crossmembers, crash cans). */
  HSLA340: { id: 'HSLA340', yield: 340e6, uts: 440e6, elongation: 0.22, ...STEEL },
  /** Dual phase (sills, rear rails). */
  DP600: { id: 'DP600', yield: 380e6, uts: 600e6, elongation: 0.18, ...STEEL },
  /** Press-hardened boron steel (A/B pillars, roof-rail reinforcements, door rings). */
  BORON: { id: 'BORON', yield: 1150e6, uts: 1500e6, elongation: 0.06, ...STEEL },
  /** Truck frame steel (ladder rails). */
  S500MC: { id: 'S500MC', yield: 500e6, uts: 600e6, elongation: 0.14, ...STEEL },
  /** Aluminium outer panel (hoods, closures). */
  AL6016: { id: 'AL6016', yield: 120e6, uts: 230e6, elongation: 0.24, density: 2700, E: 70e9 },
  /** Bumper fascia (PP/EPDM-T20). */
  PP_EPDM: { id: 'PP_EPDM', yield: 20e6, uts: 22e6, elongation: 2.0, density: 1040, E: 1.6e9 },
};

export function grade(id: string): MaterialGrade {
  const g = GRADES[id];
  if (!g) throw new Error(`rig gen: unknown material grade "${id}"`);
  return g;
}

/** Areal density of a sheet, kg/m². */
export function sheetMass(gradeId: string, gauge: number): number {
  return grade(gradeId).density * gauge;
}

/**
 * Mean progressive-folding (axial crush) force of a thin-walled square
 * tube, N: Abramowicz & Jones (1984), P_m = 13.06·σ0·t^(5/3)·C^(1/3), C =
 * mean side width, σ0 = flow stress ≈ (σ_y + σ_u)/2. Rectangular sections
 * use C = (w + h)/2.
 */
export function tubeCrushForce(gradeId: string, gauge: number, width: number, height: number): number {
  const g = grade(gradeId);
  const s0 = (g.yield + g.uts) / 2;
  const C = (width + height) / 2;
  return 13.06 * s0 * gauge ** (5 / 3) * C ** (1 / 3);
}

/** Fully plastic bending moment of a thin-walled rectangular tube (w across, h in the bending plane), N·m. */
export function tubePlasticMoment(gradeId: string, gauge: number, width: number, height: number): number {
  const g = grade(gradeId);
  // Z = t·h·(w + h/2) for a thin rectangular tube bent about the w axis
  return g.yield * gauge * height * (width + height / 2);
}
