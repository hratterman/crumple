/**
 * Synthetic flexbody test subject: a rounded box shell skinned to the
 * soft-cube rig (src/sim/rig/testrigs softCube). Pure (no three); used by
 * the binder/flexskin unit tests, the dev/skin.html harness and the e2e
 * shader compile check. Two panels so seams, bind-set restriction and
 * detach resolution are all exercised:
 *   'shell' — sides + bottom (5 faces, separate vertices per face → welded
 *             seams along the shared edges), bound to every cube node;
 *   'lid'   — the top face, bound only to the top node layer, detach
 *             'boundary' (beams from the top layer down).
 */
import { compileRig } from '../../sim/rig/builder';
import { softCube } from '../../sim/rig/testrigs';
import type { CompiledVehicle } from '../../sim/vehicle/types';
import type { PanelGeometry, VehicleVisualDef } from './types';

export interface SyntheticSubject {
  compiled: CompiledVehicle;
  def: VehicleVisualDef;
  geoms: PanelGeometry[];
}

/** Half extent of the shell (cube nodes sit at ±0.75), corner radius, grid cells per face edge. */
const HALF = 0.78;
const RADIUS = 0.2;

type Face = { axis: 0 | 1 | 2; sign: 1 | -1 };
const FACES: Record<string, Face> = {
  px: { axis: 0, sign: 1 },
  nx: { axis: 0, sign: -1 },
  py: { axis: 1, sign: 1 },
  ny: { axis: 1, sign: -1 },
  pz: { axis: 2, sign: 1 },
  nz: { axis: 2, sign: -1 },
};

function buildFaces(names: readonly string[], cells: number, panelId: string): PanelGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const tan: number[] = [];
  const idx: number[] = [];
  const inner = HALF - RADIUS;
  const coord = (k: number): number => -HALF + (2 * HALF * k) / cells;
  for (const name of names) {
    const { axis, sign } = FACES[name]!;
    const ua = ((axis + 1) % 3) as 0 | 1 | 2;
    const va = ((axis + 2) % 3) as 0 | 1 | 2;
    const base = pos.length / 3;
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const p = [0, 0, 0];
        p[axis] = sign * HALF;
        p[ua] = coord(i);
        p[va] = coord(j);
        const q = p.map((x) => Math.min(inner, Math.max(-inner, x)));
        const d = [p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!];
        const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
        const n = d.map((x) => x / dl);
        pos.push(q[0]! + RADIUS * n[0]!, q[1]! + RADIUS * n[1]!, q[2]! + RADIUS * n[2]!);
        nrm.push(n[0]!, n[1]!, n[2]!);
        uv.push(coord(i) + HALF, coord(j) + HALF);
        // Tangent: the face u axis, orthogonalized against the normal.
        const t = [0, 0, 0];
        t[ua] = 1;
        const dt = t[0]! * n[0]! + t[1]! * n[1]! + t[2]! * n[2]!;
        const to = [t[0]! - dt * n[0]!, t[1]! - dt * n[1]!, t[2]! - dt * n[2]!];
        const tl = Math.hypot(to[0]!, to[1]!, to[2]!);
        tan.push(to[0]! / tl, to[1]! / tl, to[2]! / tl, 1);
      }
    }
    // (ua × va) = +axis: CCW seen from outside needs the order flipped on negative faces.
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = base + j * (cells + 1) + i;
        const b = a + 1;
        const c = a + cells + 1;
        const e = c + 1;
        if (sign > 0) idx.push(a, b, e, a, e, c);
        else idx.push(a, e, b, a, c, e);
      }
    }
  }
  return {
    panelId,
    position: Float32Array.from(pos),
    normal: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    tangent: Float32Array.from(tan),
    index: Uint32Array.from(idx),
    damageWeight: null,
  };
}

/** The synthetic subject; `cells` = grid cells per face edge (default 26 ≈ 6 cm edges). */
export function syntheticCubeSubject(cells = 26): SyntheticSubject {
  const rigDef = softCube();
  const rig = compileRig(rigDef);
  const center = rig.nodeIds.indexOf('n1_1_1');
  const front = rig.nodeIds.indexOf('n1_1_0');
  const top = rig.nodeIds.indexOf('n1_2_1');
  const compiled = {
    name: rig.name,
    rig,
    bodyNodeCount: rig.nodeCount,
    bodyBeamCount: rig.beamCount,
    wheels: [],
    frameNodes: Int32Array.of(center, front, top),
    totalMass: 60,
    massDriftPct: 0,
  } as unknown as CompiledVehicle;
  const shell = buildFaces(['px', 'nx', 'ny', 'pz', 'nz'], cells, 'shell');
  const lid = buildFaces(['py'], cells, 'lid');
  const meshSurface = (g: PanelGeometry) => ({
    type: 'mesh' as const,
    position: Array.from(g.position),
    index: Array.from(g.index),
    normal: Array.from(g.normal),
    uv: Array.from(g.uv),
  });
  const def: VehicleVisualDef = {
    vehicle: rig.name,
    panels: [
      { id: 'shell', kind: 'body', material: 'paint', surface: meshSurface(shell), bind: ['n*'], detach: null },
      {
        id: 'lid',
        kind: 'roof',
        material: 'paint',
        surface: meshSurface(lid),
        bind: ['n*_3_*'],
        detach: { attach: 'boundary', minBrokenFraction: 1, mode: 'follow' },
      },
    ],
    paint: {
      color: 0xb3121b,
      metallic: 0.6,
      roughness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      flake: null,
    },
    wheels: {
      rim: { style: 'spoke', spokes: 5, spokeWidth: 0.3, dish: 0.03, lip: 0.015, finish: 'silver', boltCount: 5 },
      tire: { tread: 'street', sidewallText: null, bulge: 0.08 },
      brake: { discRadius: 0.15, caliperColor: 0xcc2222 },
    },
  };
  return { compiled, def, geoms: [shell, lid] };
}
