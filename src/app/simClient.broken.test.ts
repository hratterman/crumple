/**
 * SimClient P4 accessors (A4): brokenBeams / repairEpoch decode the snapshot
 * bitset section exactly as the protocol writer packs it; setColliders posts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SnapshotWriter } from '../protocol/codec';
import { computeSnapshotLayout } from '../protocol/layout';
import type { MainToWorker, WorkerToMain } from '../protocol/messages';
import { SimClient } from './simClient';

class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: MainToWorker[] = [];
  onmessage: ((ev: { data: WorkerToMain }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: MainToWorker): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  reply(msg: WorkerToMain): void {
    this.onmessage!({ data: msg });
  }
}

describe('SimClient broken-beam bitset', () => {
  let saved: unknown;
  beforeEach(() => {
    const g = globalThis as { Worker?: unknown };
    saved = g.Worker;
    g.Worker = FakeWorker;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = saved;
    vi.restoreAllMocks();
  });

  it('decodes per-object broken flags and repair epochs written by SnapshotWriter', () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    expect(client.brokenBeams(7, new Uint8Array(4))).toBe(-1);
    expect(client.repairEpoch(7)).toBe(0);

    const layout = computeSnapshotLayout(4, 256, 512, false);
    const buf = new ArrayBuffer(layout.totalBytes);
    const sw = new SnapshotWriter(layout).attach(buf);
    sw.begin(100, 0.05, 1);
    // object 3: 37 beams (crosses a word boundary at global 32), object 7: 70 beams at offset 37
    const a = sw.addObject(3, 0, 10, 37);
    const activeA = new Uint8Array(37).fill(1);
    for (const k of [0, 5, 31, 36]) activeA[k] = 0;
    sw.writeBrokenBeams(a, activeA, 0);
    sw.setRepairEpoch(a, 2);
    const b = sw.addObject(7, 0, 12, 70);
    const activeB = new Uint8Array(80).fill(1);
    for (const k of [0, 1, 26, 27, 59, 69]) activeB[10 + k] = 0;
    sw.writeBrokenBeams(b, activeB, 10);
    sw.setRepairEpoch(b, 5);
    w.reply({ type: 'snapshot', buffer: buf });

    expect(client.hasBrokenBeams).toBe(true);
    const outA = new Uint8Array(37);
    expect(client.brokenBeams(3, outA)).toBe(4);
    for (let k = 0; k < 37; k++) expect(outA[k]).toBe(activeA[k] ? 0 : 1);
    const outB = new Uint8Array(70);
    expect(client.brokenBeams(7, outB)).toBe(6);
    for (let k = 0; k < 70; k++) expect(outB[k]).toBe(activeB[10 + k] ? 0 : 1);
    expect(client.repairEpoch(3)).toBe(2);
    expect(client.repairEpoch(7)).toBe(5);
    expect(client.brokenBeams(4, outA)).toBe(-1);
    client.dispose();
  });

  it('setColliders posts the extra collider set', () => {
    const client = new SimClient({ seed: 1 });
    client.setColliders([]);
    expect(FakeWorker.last!.sent.at(-1)).toEqual({ type: 'setColliders', colliders: [] });
    client.dispose();
  });
});
