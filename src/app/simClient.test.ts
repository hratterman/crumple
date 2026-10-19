/**
 * SimClient.groundHeightfield (P3, D) against a stub Worker: request
 * posting, terrainReady resolution, the mismatch error that trails a
 * resolved terrainReady, outright failures and fatal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainToWorker, WorkerToMain } from '../protocol/messages';
import { DEFAULT_LAYOUT } from '../world/layout';
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

describe('SimClient.groundHeightfield', () => {
  let saved: unknown;
  beforeEach(() => {
    const g = globalThis as { Worker?: unknown };
    saved = g.Worker;
    g.Worker = FakeWorker;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = saved;
    vi.restoreAllMocks();
  });

  it('posts the layout + hash and resolves with terrainReady (also kept in .terrain)', async () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    const p = client.groundHeightfield(DEFAULT_LAYOUT, 0xf9180370);
    expect(w.sent.at(-1)).toEqual({ type: 'groundHeightfield', layout: DEFAULT_LAYOUT, terrainHash: 0xf9180370 });
    expect(client.terrain).toBeNull();
    w.reply({ type: 'terrainReady', layoutId: DEFAULT_LAYOUT.id, terrainHash: 0xf9180370, matched: true, generateMs: 900 });
    await expect(p).resolves.toEqual({ layoutId: DEFAULT_LAYOUT.id, terrainHash: 0xf9180370, matched: true, generateMs: 900 });
    expect(client.terrain?.matched).toBe(true);
    client.dispose();
  });

  it('a hash mismatch resolves (matched:false) and its trailing error does not reject the next request', async () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    const a = client.groundHeightfield(DEFAULT_LAYOUT, 0x1234);
    const b = client.groundHeightfield(DEFAULT_LAYOUT, 0);
    w.reply({ type: 'terrainReady', layoutId: 'crumple-valley', terrainHash: 0x9999, matched: false, generateMs: 1 });
    w.reply({ type: 'error', command: 'groundHeightfield', message: 'terrain hash mismatch' });
    w.reply({ type: 'terrainReady', layoutId: 'crumple-valley', terrainHash: 0x9999, matched: false, generateMs: 1 });
    await expect(a).resolves.toMatchObject({ matched: false, terrainHash: 0x9999 });
    await expect(b).resolves.toMatchObject({ matched: false });
    client.dispose();
  });

  it('rejects on a generation error, on fatal and after dispose', async () => {
    const client = new SimClient({ seed: 1 });
    const w = FakeWorker.last!;
    const bad = client.groundHeightfield(DEFAULT_LAYOUT, 1);
    w.reply({ type: 'error', command: 'groundHeightfield', message: 'WorldLayoutError: nope' });
    await expect(bad).rejects.toThrow('WorldLayoutError: nope');
    const pending = client.groundHeightfield(DEFAULT_LAYOUT, 1);
    w.reply({ type: 'fatal', message: 'boom' });
    await expect(pending).rejects.toThrow(/fatal: boom/);
    await expect(client.groundHeightfield(DEFAULT_LAYOUT, 1)).rejects.toThrow(/dead/);
    const c2 = new SimClient({ seed: 2 });
    const p2 = c2.groundHeightfield(DEFAULT_LAYOUT, 0);
    c2.dispose();
    await expect(p2).rejects.toThrow(/disposed/);
  });
});
