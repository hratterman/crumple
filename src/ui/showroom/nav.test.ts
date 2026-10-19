import { describe, expect, it } from 'vitest';

import { keyIntent, PadNav, type PadLike } from './nav';

function pad(buttons: number[] = [], axes: number[] = [0, 0]): PadLike {
  const b = Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 }));
  return { axes, buttons: b };
}

describe('PadNav', () => {
  it('fires on the press edge only for accept/back, with auto-repeat for directions', () => {
    const n = new PadNav();
    expect(n.poll(pad([0]), 0.016)).toEqual(['accept']);
    expect(n.poll(pad([0]), 1)).toEqual([]);
    expect(n.poll(pad([]), 0.016)).toEqual([]);
    expect(n.poll(pad([0]), 0.016)).toEqual(['accept']);
    const d = new PadNav();
    expect(d.poll(pad([13]), 0.016)).toEqual(['down']);
    expect(d.poll(pad([13]), 0.2)).toEqual([]); // inside the repeat delay
    expect(d.poll(pad([13]), 0.4)).toEqual(['down']); // delay passed
    expect(d.poll(pad([13]), 0.13)).toEqual(['down']); // repeat
  });

  it('reads the left stick and the shoulder buttons', () => {
    const n = new PadNav();
    expect(n.poll(pad([], [-0.9, 0]), 0.016)).toEqual(['left']);
    expect(n.poll(pad([], [0, 0.9]), 0.016)).toEqual(['down']);
    expect(new PadNav().poll(pad([4, 5]), 0.016).sort()).toEqual(['next', 'prev']);
    expect(new PadNav().poll(null, 0.016)).toEqual([]);
  });

  it('maps keys', () => {
    expect(keyIntent('ArrowLeft')).toBe('left');
    expect(keyIntent('Enter')).toBe('accept');
    expect(keyIntent('Escape')).toBe('back');
    expect(keyIntent('KeyE')).toBe('next');
    expect(keyIntent('KeyZ')).toBeNull();
  });
});
