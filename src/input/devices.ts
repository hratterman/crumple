/**
 * DOM glue for the pure input mapper (actions.ts): keyboard listeners and
 * per-frame Gamepad API polling. The only input module that touches the DOM.
 *
 * Focus loss (window blur, tab hidden) releases every held key, so a key
 * released while the page is unfocused never stays stuck down.
 */
import type { GamepadLike, InputMapper } from './actions';

export type InputDevice = 'keyboard' | 'gamepad';

export interface InputDevices {
  /** Polls the first connected gamepad into the mapper. Call once per frame before `mapper.update`. */
  poll(): void;
  /** Device that produced the most recent input. */
  readonly lastDevice: InputDevice;
  /** Gamepad id when one is connected, else null. */
  readonly gamepadId: string | null;
  dispose(): void;
}

const GAMEPAD_ACTIVITY_EPS = 0.2;

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

function isModifierCode(code: string): boolean {
  return code === 'ControlLeft' || code === 'ControlRight' || code === 'ShiftLeft' || code === 'ShiftRight';
}

function padActive(p: GamepadLike): boolean {
  for (const a of p.axes) if (Math.abs(a) > GAMEPAD_ACTIVITY_EPS) return true;
  for (const b of p.buttons) if (b.pressed || b.value > GAMEPAD_ACTIVITY_EPS) return true;
  return false;
}

export function attachInputDevices(mapper: InputMapper, target: Window = window): InputDevices {
  let lastDevice: InputDevice = 'keyboard';
  let gamepadId: string | null = null;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    // Leave browser shortcuts (Ctrl+R, Cmd+W, …) alone; Ctrl/Shift on their own are shift keys.
    if (e.metaKey || e.altKey || (e.ctrlKey && !isModifierCode(e.code))) return;
    if (mapper.handleKeyEvent(e)) {
      e.preventDefault();
      lastDevice = 'keyboard';
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    // Always forward releases so a held control can never stick.
    if (mapper.handleKeyEvent(e)) e.preventDefault();
  };
  const onBlur = (): void => mapper.releaseAll();
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') mapper.releaseAll();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  const hasGamepadApi = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

  return {
    poll() {
      let pad: Gamepad | null = null;
      if (hasGamepadApi) {
        let pads: (Gamepad | null)[] = [];
        try {
          pads = navigator.getGamepads();
        } catch {
          // Blocked by permissions policy: behave as if none is connected.
        }
        for (const p of pads) {
          if (p && p.connected) {
            // Prefer a standard-mapping pad; fall back to the first connected one.
            if (p.mapping === 'standard') {
              pad = p;
              break;
            }
            pad ??= p;
          }
        }
      }
      gamepadId = pad ? pad.id : null;
      mapper.setGamepad(pad);
      if (pad && padActive(pad)) lastDevice = 'gamepad';
    },
    get lastDevice() {
      return lastDevice;
    },
    get gamepadId() {
      return gamepadId;
    },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      mapper.releaseAll();
      mapper.setGamepad(null);
    },
  };
}
