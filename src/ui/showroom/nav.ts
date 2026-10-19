/**
 * Menu navigation shared by the pause menu and the showroom (P6 S1):
 * spatial arrow-key focus movement between `[data-nav]` elements of an
 * overlay, and gamepad polling into the same intents (D-pad / left stick
 * with auto-repeat, A accept, B back, LB/RB prev/next). The driving input
 * mapper keeps polling the pad too: main only listens to its `pause`
 * command (Start) while a menu is open and drops the rest.
 */
export type NavIntent = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'prev' | 'next';

/** Standard-mapping buttons. */
const PAD: Readonly<Record<number, NavIntent>> = { 12: 'up', 13: 'down', 14: 'left', 15: 'right', 0: 'accept', 1: 'back', 4: 'prev', 5: 'next' };
const STICK_ON = 0.55;
const REPEAT_DELAY_S = 0.42;
const REPEAT_S = 0.12;

export interface PadLike {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

/** Edge + auto-repeat detection over gamepad snapshots (pure; feed it a pad each frame). */
export class PadNav {
  private held = new Map<NavIntent, number>();

  /** Intents fired this frame. `pad` null = released. */
  poll(pad: PadLike | null, dtS: number): NavIntent[] {
    const down = new Set<NavIntent>();
    if (pad) {
      for (const k in PAD) {
        const b = pad.buttons[Number(k)];
        if (b && (b.pressed || b.value > 0.5)) down.add(PAD[Number(k)]!);
      }
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      if (x < -STICK_ON) down.add('left');
      else if (x > STICK_ON) down.add('right');
      if (y < -STICK_ON) down.add('up');
      else if (y > STICK_ON) down.add('down');
    }
    const out: NavIntent[] = [];
    for (const k of [...this.held.keys()]) if (!down.has(k)) this.held.delete(k);
    for (const k of down) {
      const t = this.held.get(k);
      if (t === undefined) {
        out.push(k);
        this.held.set(k, -REPEAT_DELAY_S);
        continue;
      }
      const repeats = k === 'up' || k === 'down' || k === 'left' || k === 'right';
      let nt = t + dtS;
      if (repeats && nt >= REPEAT_S) {
        out.push(k);
        nt = 0;
      }
      this.held.set(k, nt);
    }
    return out;
  }

  reset(): void {
    this.held.clear();
  }
}

/** The first connected (standard-mapping preferred) gamepad, or null. */
export function firstGamepad(): PadLike | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  let pads: (Gamepad | null)[] = [];
  try {
    pads = navigator.getGamepads();
  } catch {
    return null;
  }
  let best: Gamepad | null = null;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    if (p.mapping === 'standard') return p;
    best ??= p;
  }
  return best;
}

export function keyIntent(code: string): NavIntent | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    case 'Enter':
    case 'NumpadEnter':
    case 'Space':
      return 'accept';
    case 'Escape':
    case 'Backspace':
      return 'back';
    case 'KeyQ':
    case 'PageUp':
      return 'prev';
    case 'KeyE':
    case 'PageDown':
      return 'next';
    default:
      return null;
  }
}

function visible(el: HTMLElement): boolean {
  if (el.hidden || (el as HTMLButtonElement).disabled) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Focusable nav targets of `root`, in DOM order. */
export function navTargets(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-nav]')].filter(visible);
}

/**
 * Moves focus from the active element to the nearest `[data-nav]` target
 * in direction `dir` (spatial: candidates whose centre lies in that half-
 * plane, scored by distance with an off-axis penalty). Returns the newly
 * focused element, or null when nothing lies that way.
 */
export function moveFocus(root: HTMLElement, dir: 'up' | 'down' | 'left' | 'right'): HTMLElement | null {
  const all = navTargets(root);
  if (all.length === 0) return null;
  const active = document.activeElement as HTMLElement | null;
  const from = active && all.includes(active) ? active : null;
  if (!from) {
    all[0]!.focus();
    return all[0]!;
  }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    let along: number;
    let across: number;
    if (dir === 'left' || dir === 'right') {
      along = dir === 'left' ? -dx : dx;
      across = Math.abs(dy);
    } else {
      along = dir === 'up' ? -dy : dy;
      across = Math.abs(dx);
    }
    if (along <= 1) continue;
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  best?.focus();
  return best;
}
