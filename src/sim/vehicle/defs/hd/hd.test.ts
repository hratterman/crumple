/**
 * R-RIG: every car's high-density variants — denser than the standard rig and within the tier budget, valid
 * (one connected structure, stable by construction: no MINIMASS drift beyond the standard's own), mass, CG and
 * inertia of the standard car, collision triangles over the sheets, every generated node in a rigid shell cluster, the
 * standard harness probes still resolvable; and determinism + replay re-simulation on the HD rigs.
 */
import { describe, expect, it } from 'vitest';
import { MaterialId, type MainToWorker, type WorkerToMain } from '../../../../protocol/messages';
import type { ReplayFile } from '../../../../protocol/replay';
import { hashSimState } from '../../../replay/hash';
import { resimulate } from '../../../replay/resim';
import { WorkerHost } from '../../../worker';
import { compileVehicle, validateVehicle } from '../../builder';
import { nodesMatching } from '../../crash';
import { compileShells } from '../../shellDefs';
import type { VehicleDef } from '../../types';
import { STANDARD_VARIANTS, vehicleVariantSync } from './index';
import { PHYSICS_QUALITY_BUDGETS } from './variants';

const CARS = ['sedan', 'coupe', 'pickup', 'boxtruck', 'beater'] as const;

/** Inertia drift allowed (the field matches mass + CG; refine.ts `matchInertia` matches the second moments too). */
const INERTIA_TOL = 0.05;

/** Inertia about the CG, axes x (pitch), y (yaw), z (roll), kg·m². */
function inertia(cv: ReturnType<typeof compileVehicle>): [number, number, number] {
  const R = cv.rig;
  const c = [0, 0, 0];
  for (let i = 0; i < R.nodeCount; i++) for (let k = 0; k < 3; k++) c[k] = c[k]! + (R.nodeMass[i]! * R.nodePos[3 * i + k]!) / cv.totalMass;
  const I: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < R.nodeCount; i++) {
    const d = [0, 1, 2].map((k) => R.nodePos[3 * i + k]! - c[k]!);
    I[0] += R.nodeMass[i]! * (d[1]! ** 2 + d[2]! ** 2);
    I[1] += R.nodeMass[i]! * (d[0]! ** 2 + d[2]! ** 2);
    I[2] += R.nodeMass[i]! * (d[0]! ** 2 + d[1]! ** 2);
  }
  return I;
}

describe('HD variants', { timeout: 600_000 }, () => {
  for (const car of CARS) {
    const std = compileVehicle(STANDARD_VARIANTS[car].def);
    for (const tier of ['high', 'ultra'] as const) {
      it(`${car}.${tier}: denser, within budget, valid, same mass + CG, sheets in the shell, probes resolve`, () => {
        const v = vehicleVariantSync(car, tier);
        const cv = compileVehicle(v.def);
        const r = v.report!;
        const nodeRatio = cv.rig.nodeCount / std.rig.nodeCount;
        const beamRatio = cv.rig.beamCount / std.rig.beamCount;
        console.log(
          `[hd] ${car}.${tier}: ${cv.rig.nodeCount} nodes (${nodeRatio.toFixed(2)}×), ${cv.rig.beamCount} beams (${beamRatio.toFixed(2)}×); ` +
            `sheets ${r.skinNodes} nodes ${r.massBy.skins!.toFixed(1)} kg, members ${r.memberNodes} nodes ${r.massBy.members!.toFixed(1)} kg, seams ${r.weldBeams}; ` +
            `worst ω·dt ${r.worstOmegaDt.toFixed(4)} (${r.worstNode}), (Σd/m)·dt ${r.worstDampDt.toFixed(3)}`,
        );
        expect(nodeRatio).toBeGreaterThan(tier === 'high' ? 2.3 : 3.5);
        expect(beamRatio).toBeGreaterThan(tier === 'high' ? 2.3 : 3.5);
        expect(cv.rig.beamCount).toBeLessThanOrEqual(PHYSICS_QUALITY_BUDGETS[tier].playerBeams);
        expect(cv.rig.nodeCount).toBeLessThanOrEqual(PHYSICS_QUALITY_BUDGETS[tier].playerNodes);
        const val = validateVehicle(v.def, PHYSICS_QUALITY_BUDGETS[tier].playerBeams);
        expect(val.errors).toEqual([]);
        expect(val.islands).toBe(1);
        expect(cv.massDriftPct).toBeLessThanOrEqual(std.massDriftPct + 1e-6);
        expect(Math.abs(cv.totalMass - std.totalMass)).toBeLessThan(0.02);
        for (let k = 0; k < 3; k++) expect(Math.abs(r.cg[k]! - r.baseCg[k]!)).toBeLessThan(1e-3);
        // …and the inertia tensor's diagonal (pitch / yaw / roll about the CG) stays close: the sheets' mass sits
        // about where the standard car had it lumped
        const Ih = inertia(cv);
        const Is = inertia(std);
        console.log(`[hd] ${car}.${tier} inertia drift pitch / yaw / roll ` + Ih.map((x, k) => `${((x / Is[k]! - 1) * 100).toFixed(2)} %`).join(' / '));
        for (let k = 0; k < 3; k++) expect(Math.abs(Ih[k]! / Is[k]! - 1)).toBeLessThan(INERTIA_TOL);
        // collision triangles over the sheets (R-CORE node-vs-triangle input)
        const ids = new Set(cv.rig.nodeIds);
        expect(v.collision!.length).toBeGreaterThan(400);
        for (const t of v.collision!) for (const id of [t.a, t.b, t.c]) expect(ids.has(id)).toBe(true);
        // every generated node is held by a rigid shell cluster
        const shells = compileShells(cv.rig, cv.bodyNodeCount, v.def.shell);
        const inShell = new Set<number>();
        for (const s of shells) for (const n of s.nodes) inShell.add(n);
        cv.rig.nodeIds.forEach((id, i) => {
          if (id.startsWith('k_') || id.startsWith('m_')) expect(inShell.has(i), id).toBe(true);
        });
        // the standard probes still resolve on the HD rig
        const p = v.probes;
        for (const set of [p.front, p.cabin, p.firewall, p.cellRear, p.cellFront, p.doorMid, [p.doorR], [p.doorL], [p.sillR], [p.sillL]]) expect(nodesMatching(cv, set).length).toBeGreaterThan(0);
      });
    }
  }

  const replayRun = (def: VehicleDef): { hash: number; file: ReplayFile } => {
    const held: ArrayBuffer[] = [];
    const out: WorkerToMain[] = [];
    const host = new WorkerHost((m) => {
      if (m.type === 'snapshot') held.push(m.buffer);
      else out.push(m);
    }, { now: () => 0, schedule: () => {} });
    const send = (m: MainToWorker): void => host.handle(m);
    send({ type: 'init', seed: 11, gravity: [0, -9.81, 0], snapshotHz: 120, debugStrains: false, capacity: { maxObjects: 4, nodeCapacity: 4096, beamCapacity: 16384 } });
    send({ type: 'ground', mode: 'plane', y: 0, materialId: MaterialId.asphalt });
    send({ type: 'setColliders', colliders: [{ id: 'wall', kind: 'box', pos: [0, 1, -14], quat: [0, 0, 0, 1], size: [6, 1, 0.6], material: MaterialId.concrete }] });
    send({ type: 'spawnVehicle', objectId: 1, vehicle: def, transform: { pos: [0, 0.05, 0], quat: [0, 0, 0, 1] }, catalogId: 'sedan' });
    let frame = 0;
    while (host.engine!.tick < 5000) {
      host.runSteps(17 + (frame % 9));
      frame++;
      const t = host.engine!.tick / 2000;
      send({ type: 'input', objectId: 1, actions: { throttle: t < 1.6 ? 1 : 0, brake: 0, steer: Math.round(Math.sin(t * 2) * 8) / 40, gearSelect: 1, handbrake: 0, clutch: 0 } });
      if (frame % 2 === 0) while (held.length > 0) send({ type: 'returnBuffer', buffer: held.shift()! });
    }
    const hash = hashSimState(host.engine!);
    send({ type: 'replayFileRequest', requestId: 1 });
    const msg = out.find((m) => m.type === 'replayFile');
    if (!msg || msg.type !== 'replayFile') throw new Error('no replay file');
    return { hash, file: msg.file };
  };

  for (const [car, tier] of [['sedan', 'ultra'], ['coupe', 'high']] as const) {
    it(`determinism + resimulate: ${car}.${tier} driving into a wall reproduces its state hash bit-exactly`, () => {
      const def = vehicleVariantSync(car, tier).def;
      const a = replayRun(def);
      const b = replayRun(def);
      expect(b.hash).toBe(a.hash);
      expect(resimulate(a.file).hash).toBe(a.hash);
    });
  }
});
