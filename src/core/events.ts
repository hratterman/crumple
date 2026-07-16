/**
 * Tiny typed event emitter. Zero allocation on emit (beyond the engine's own
 * argument handling): listeners live in plain arrays that are never copied.
 *
 * Reentrancy rules:
 * - Listeners removed during an emit are tombstoned (never called again,
 *   even later in the same emit) and the array is compacted after the
 *   outermost emit finishes.
 * - Listeners added during an emit fire from the NEXT emit onward.
 */

// Payload of `undefined | void` makes the emit payload argument optional.
type EmitArgs<T> = undefined extends T ? [payload?: T] : [payload: T];

type AnyHandler = (payload: never) => void;

interface Bucket {
  fns: (AnyHandler | null)[];
  emitDepth: number;
  needsCompact: boolean;
}

export interface Emitter<E extends Record<string, unknown>> {
  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void;
  /**
   * Unsubscribe a handler registered with `on`. Handlers registered with
   * `once` are wrapped internally — remove those via their returned
   * unsubscribe function instead.
   */
  off<K extends keyof E>(type: K, fn: (payload: E[K]) => void): void;
  /** Subscribe for a single emit; returns an unsubscribe function. */
  once<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void;
  emit<K extends keyof E>(type: K, ...args: EmitArgs<E[K]>): void;
}

export function createEmitter<E extends Record<string, unknown>>(): Emitter<E> {
  const buckets = new Map<keyof E, Bucket>();

  const compact = (b: Bucket): void => {
    let w = 0;
    for (let r = 0; r < b.fns.length; r++) {
      const fn = b.fns[r];
      if (fn !== null && fn !== undefined) {
        b.fns[w] = fn;
        w++;
      }
    }
    b.fns.length = w;
    b.needsCompact = false;
  };

  const on = <K extends keyof E>(type: K, fn: (payload: E[K]) => void): (() => void) => {
    let b = buckets.get(type);
    if (b === undefined) {
      b = { fns: [], emitDepth: 0, needsCompact: false };
      buckets.set(type, b);
    }
    b.fns.push(fn as AnyHandler);
    return () => off(type, fn);
  };

  const off = <K extends keyof E>(type: K, fn: (payload: E[K]) => void): void => {
    const b = buckets.get(type);
    if (b === undefined) return;
    const i = b.fns.indexOf(fn as AnyHandler);
    if (i === -1) return;
    if (b.emitDepth > 0) {
      // Splicing mid-emit would shift the iteration cursor; tombstone instead.
      b.fns[i] = null;
      b.needsCompact = true;
    } else {
      b.fns.splice(i, 1);
    }
  };

  const once = <K extends keyof E>(type: K, fn: (payload: E[K]) => void): (() => void) => {
    const wrap = (payload: E[K]): void => {
      off(type, wrap);
      fn(payload);
    };
    return on(type, wrap);
  };

  const emit = <K extends keyof E>(type: K, ...args: EmitArgs<E[K]>): void => {
    const b = buckets.get(type);
    if (b === undefined) return;
    const payload = args[0];
    b.emitDepth++;
    // Snapshot length so listeners added during this emit do not fire now.
    const len = b.fns.length;
    for (let i = 0; i < len; i++) {
      const fn = b.fns[i];
      if (fn !== null && fn !== undefined) fn(payload as never);
    }
    b.emitDepth--;
    if (b.emitDepth === 0 && b.needsCompact) compact(b);
  };

  return { on, off, once, emit };
}
