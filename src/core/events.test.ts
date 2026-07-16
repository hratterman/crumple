import { describe, expect, it } from 'vitest';
import { createEmitter } from './events';

interface TestEvents extends Record<string, unknown> {
  hit: { impulse: number };
  tick: number;
  pause: undefined;
}

describe('createEmitter', () => {
  it('delivers payloads to on() listeners', () => {
    const e = createEmitter<TestEvents>();
    const got: number[] = [];
    e.on('hit', (p) => got.push(p.impulse));
    e.emit('hit', { impulse: 42 });
    e.emit('hit', { impulse: 7 });
    expect(got).toEqual([42, 7]);
  });

  it('calls multiple listeners in registration order', () => {
    const e = createEmitter<TestEvents>();
    const order: string[] = [];
    e.on('tick', () => order.push('a'));
    e.on('tick', () => order.push('b'));
    e.on('tick', () => order.push('c'));
    e.emit('tick', 1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('off() stops delivery', () => {
    const e = createEmitter<TestEvents>();
    let count = 0;
    const fn = (): void => {
      count++;
    };
    e.on('tick', fn);
    e.emit('tick', 1);
    e.off('tick', fn);
    e.emit('tick', 2);
    expect(count).toBe(1);
  });

  it('on() returns a working unsubscribe function', () => {
    const e = createEmitter<TestEvents>();
    let count = 0;
    const unsub = e.on('tick', () => count++);
    e.emit('tick', 1);
    unsub();
    e.emit('tick', 2);
    expect(count).toBe(1);
  });

  it('once() fires exactly once', () => {
    const e = createEmitter<TestEvents>();
    let count = 0;
    e.once('tick', () => count++);
    e.emit('tick', 1);
    e.emit('tick', 2);
    e.emit('tick', 3);
    expect(count).toBe(1);
  });

  it('once() unsubscribe cancels before firing', () => {
    const e = createEmitter<TestEvents>();
    let count = 0;
    const unsub = e.once('tick', () => count++);
    unsub();
    e.emit('tick', 1);
    expect(count).toBe(0);
  });

  it('supports payload-less events via undefined payload type', () => {
    const e = createEmitter<TestEvents>();
    let fired = false;
    e.on('pause', () => {
      fired = true;
    });
    e.emit('pause');
    expect(fired).toBe(true);
  });

  it('emit on a type with no listeners is a no-op', () => {
    const e = createEmitter<TestEvents>();
    expect(() => e.emit('tick', 1)).not.toThrow();
  });

  it('off() of an unknown handler is a no-op', () => {
    const e = createEmitter<TestEvents>();
    expect(() => e.off('tick', () => undefined)).not.toThrow();
  });

  it('a listener removed mid-emit by an earlier listener does not fire', () => {
    const e = createEmitter<TestEvents>();
    const calls: string[] = [];
    const b = (): void => {
      calls.push('b');
    };
    e.on('tick', () => {
      calls.push('a');
      e.off('tick', b);
    });
    e.on('tick', b);
    e.on('tick', () => calls.push('c'));
    e.emit('tick', 1);
    expect(calls).toEqual(['a', 'c']);
    // and subsequent emits still work with the compacted list
    e.emit('tick', 2);
    expect(calls).toEqual(['a', 'c', 'a', 'c']);
  });

  it('a listener removing itself mid-emit does not skip later listeners', () => {
    const e = createEmitter<TestEvents>();
    const calls: string[] = [];
    const self = (): void => {
      calls.push('self');
      e.off('tick', self);
    };
    e.on('tick', self);
    e.on('tick', () => calls.push('after'));
    e.emit('tick', 1);
    e.emit('tick', 2);
    expect(calls).toEqual(['self', 'after', 'after']);
  });

  it('listeners added during emit fire on the next emit, not the current one', () => {
    const e = createEmitter<TestEvents>();
    const calls: string[] = [];
    e.on('tick', () => {
      calls.push('first');
      if (calls.length === 1) e.on('tick', () => calls.push('added'));
    });
    e.emit('tick', 1);
    expect(calls).toEqual(['first']);
    e.emit('tick', 2);
    expect(calls).toEqual(['first', 'first', 'added']);
  });

  it('nested emits do not corrupt listener lists', () => {
    const e = createEmitter<TestEvents>();
    const calls: string[] = [];
    e.on('tick', (n) => {
      calls.push(`tick${n}`);
      if (n === 1) e.emit('pause');
    });
    e.on('pause', () => calls.push('pause'));
    e.emit('tick', 1);
    e.emit('tick', 2);
    expect(calls).toEqual(['tick1', 'pause', 'tick2']);
  });
});
