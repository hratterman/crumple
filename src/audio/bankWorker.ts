/**
 * One-shot bank synthesis off the main thread (P8 audio). Main posts
 * `{sampleRate}`; the worker renders every variant (dsp/oneshots.ts, crash
 * sounds first) and posts each as `{kind, variant, data}` with the samples
 * transferred, then `{done: true}`. ~0.3–0.6 s of CPU in total, none of it
 * on the frame loop.
 */
import { ONE_SHOT_KINDS, ONE_SHOT_VARIANTS, synthOneShot, type OneShotKind } from './dsp/oneshots';

const FIRST: readonly OneShotKind[] = ['thump', 'crunch', 'crumple', 'tap', 'boom', 'snap', 'plastic', 'glass', 'debris', 'glassCrack', 'concrete', 'drum', 'clang', 'cone', 'pole'];

const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };

scope.onmessage = (e: MessageEvent) => {
  const sr = (e.data as { sampleRate: number }).sampleRate;
  const order = [...FIRST, ...ONE_SHOT_KINDS.filter((k) => !FIRST.includes(k))];
  for (const kind of order) {
    for (let v = 0; v < ONE_SHOT_VARIANTS[kind]; v++) {
      const data = synthOneShot(kind, sr, v + 1);
      scope.postMessage({ kind, variant: v, data }, [data.buffer]);
    }
  }
  scope.postMessage({ done: true });
};
