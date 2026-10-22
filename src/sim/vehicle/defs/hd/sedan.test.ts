/**
 * SEDAN high-density variants (R-RIG): density vs the standard rig, the
 * tier budget, validation, collision triangles, shell coverage, and
 * determinism + replay re-simulation on the HD rig.
 */
import { describe, expect, it } from 'vitest';
import { MaterialId, type MainToWorker, type WorkerToMain } from '../../../../protocol/messages';
import type { ReplayFile } from '../../../../protocol/replay';
import { hashSimState } from '../../../replay/hash';
import { resimulate } from '../../../replay/resim';
import { WorkerHost } from '../../../worker';
import { compileVehicle, validateVehicle } from '../../builder';
import { compileShells } from '../../shellDefs';
import { SEDAN } from '../sedan';
import { sedanHD } from './sedan';
import { PHYSICS_QUALITY_BUDGETS } from './variants';

const base = compileVehicle(SEDAN);

describe('SEDAN HD variants', { timeout: 300_000 }, () => {
  for (const tier of ['high', 'ultra'] as const) {
    const r = sedanHD(tier);
    const cv = compileVehicle(r.def);
    it(`${tier}: denser than the standard rig and within the tier budget`, () => {
      const nodeRatio = cv.rig.nodeCount / base.rig.nodeCount;
      const beamRatio = cv.rig.beamCount / base.rig.beamCount;
      console.log(`[hd] sedan.${tier}: ${cv.rig.nodeCount} nodes (${nodeRatio.toFixed(2)}×), ${cv.rig.beamCount} beams (${beamRatio.toFixed(2)}×), skins ${r.report.skinNodes} nodes ${r.report.massBy.skins!.toFixed(1)} kg, seams ${r.report.weldBeams}`);
      expect(nodeRatio).toBeGreaterThan(tier === 'high' ? 2 : 3.5);
      expect(beamRatio).toBeGreaterThan(tier === 'high' ? 2 : 3.5);
      expect(cv.rig.beamCount).toBeLessThanOrEqual(PHYSICS_QUALITY_BUDGETS[tier].playerBeams);
      expect(cv.rig.nodeCount).toBeLessThanOrEqual(PHYSICS_QUALITY_BUDGETS[tier].playerNodes);
    });

    it(`${tier}: validates at its budget (one connected structure, no MINIMASS drift)`, () => {
      const v = validateVehicle(r.def, PHYSICS_QUALITY_BUDGETS[tier].playerBeams);
      expect(v.errors).toEqual([]);
      expect(v.islands).toBe(1);
      expect(v.massDriftPct).toBeLessThan(1e-6);
    });

    it(`${tier}: collision triangles cover the sheets (R-CORE node-vs-triangle input)`, () => {
      const ids = new Set(cv.rig.nodeIds);
      expect(r.collision.length).toBeGreaterThan(500);
      for (const t of r.collision) for (const id of [t.a, t.b, t.c]) expect(ids.has(id)).toBe(true);
    });

    it(`${tier}: every sheet node is in the rigid shell cluster`, () => {
      const shells = compileShells(cv.rig, cv.bodyNodeCount, r.def.shell);
      const inShell = new Set<number>();
      for (const s of shells) for (const n of s.nodes) inShell.add(n);
      const skin = cv.rig.nodeIds.map((id, i) => [id, i] as const).filter(([id]) => id.startsWith('k_'));
      expect(skin.length).toBe(r.report.skinNodes);
      for (const [, i] of skin) expect(inShell.has(i)).toBe(true);
    });
  }

  it('determinism + resimulate: an HD sedan driving into a wall reproduces its state hash bit-exactly', () => {
    const def = sedanHD('high').def;
    const live = (): { hash: number; file: ReplayFile } => {
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
    const a = live();
    const b = live();
    expect(b.hash).toBe(a.hash);
    expect(resimulate(a.file).hash).toBe(a.hash);
  });
});
