/**
 * Keyboard/gamepad → ActionState mapper — FROZEN interface (P2).
 *
 * PURE: no DOM globals, no three. Callers feed it event-like objects
 * (`{type, code, repeat}` from KeyboardEvent, a Gamepad-like snapshot each
 * frame) and call `update(dtS, speedMs)` once per frame; it returns the
 * smoothed ActionState to post as `input` and queues discrete commands.
 *
 * Bindings (KeyboardEvent.code):
 *   throttle W / ArrowUp      brake S / ArrowDown      steer A,D / ArrowLeft,ArrowRight
 *   handbrake Space           shiftUp Shift / E        shiftDown Ctrl / Q
 *   recover R   repair F   cameraCycle C   toggleBeamView B   pause P / Escape   slowMo T
 *   toggleTractionControl X (additive P5)   replay Backspace (additive P7: open the replay;
 *   inside it the replay UI takes the keyboard, see ui/replay/session.ts)
 * Gamepad (standard mapping): RT(7) throttle, LT(6) brake, left stick X (axis 0)
 *   steer, A(0) handbrake, RB(5)/LB(4) shift up/down, Y(3) recover,
 *   X(2) cameraCycle, Back(8) toggleBeamView, Start(9) pause,
 *   D-pad up(12) repair, D-pad down(13) slowMo, D-pad left(14) toggleTractionControl,
 *   D-pad right(15) replay (P7).
 *
 * Steering (all parameters in InputTuning):
 *   limit(v)   = max(minSteerLimit, 1 / (1 + (v/steerLimitSpeed)²))      max |steer| at speed v
 *   outRate(v) = rate / (1 + v/steerRateFalloffSpeed)                     slew away from centre
 *   Keyboard target = (right − left)·limit(v), slewed at keyboardSteerRate (out)
 *   and keyboardReturnRate (toward centre, constant). Gamepad target =
 *   curve(deadzone(x))·limit(v), slewed at gamepadSteerRate (out, speed-scaled)
 *   and gamepadSteerRate (toward centre). A deflected stick overrides keys.
 * Pedals: keyboard throttle/brake ramp at pedalRiseRate / pedalFallRate per
 *   second; triggers pass through after triggerDeadzone; the larger wins.
 * Gears: auto mode outputs gearSelect 1 (Drive) or −1 (Reverse). With
 *   autoReverse, holding brake (and no throttle) while v < reverseSpeed
 *   engages R and swaps the pedals (brake key = throttle); throttle at
 *   v > −reverseSpeed returns to D. Manual mode: shiftUp/shiftDown step
 *   gearSelect through −1 (R), 0 (N), 1..gearCount. shiftUp/shiftDown are
 *   also emitted as commands in both modes.
 */
import type { ActionState } from '../protocol/messages';

export type InputCommand =
  | 'shiftUp'
  | 'shiftDown'
  | 'recover'
  | 'repair'
  | 'cameraCycle'
  | 'toggleBeamView'
  | 'pause'
  | 'slowMo'
  | 'toggleTractionControl'
  /** P7: open the live replay. */
  | 'replay';

type HeldControl = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake';
export type InputControl = HeldControl | InputCommand;

export const KEY_BINDINGS: Readonly<Record<string, InputControl>> = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'shiftUp',
  ShiftRight: 'shiftUp',
  KeyE: 'shiftUp',
  ControlLeft: 'shiftDown',
  ControlRight: 'shiftDown',
  KeyQ: 'shiftDown',
  KeyR: 'recover',
  KeyF: 'repair',
  KeyC: 'cameraCycle',
  KeyB: 'toggleBeamView',
  KeyP: 'pause',
  // P6 (S1, additive): Escape opens the pause menu too.
  Escape: 'pause',
  KeyT: 'slowMo',
  KeyX: 'toggleTractionControl',
  // P7 (R2, additive): the live replay.
  Backspace: 'replay',
};

/** Standard-mapping gamepad button → command (rising edge). */
export const GAMEPAD_COMMAND_BUTTONS: Readonly<Record<number, InputCommand>> = {
  5: 'shiftUp',
  4: 'shiftDown',
  3: 'recover',
  2: 'cameraCycle',
  8: 'toggleBeamView',
  9: 'pause',
  12: 'repair',
  13: 'slowMo',
  14: 'toggleTractionControl',
  15: 'replay',
};
export const GAMEPAD_BUTTON_THROTTLE = 7;
export const GAMEPAD_BUTTON_BRAKE = 6;
export const GAMEPAD_BUTTON_HANDBRAKE = 0;
export const GAMEPAD_AXIS_STEER = 0;

export interface InputTuning {
  /** Keyboard steer slew away from centre at standstill, units/s (full lock in 1/rate s). */
  keyboardSteerRate: number;
  /** Keyboard steer slew toward centre, units/s (not speed-scaled). */
  keyboardReturnRate: number;
  /** Gamepad steer slew limit, units/s (outward speed-scaled like the keyboard). */
  gamepadSteerRate: number;
  /** m/s: outward slew = rate / (1 + v / steerRateFalloffSpeed). */
  steerRateFalloffSpeed: number;
  /** m/s: steer limit = max(minSteerLimit, 1 / (1 + (v / steerLimitSpeed)²)). */
  steerLimitSpeed: number;
  minSteerLimit: number;
  /** Stick X deadzone (|x| below → 0, rescaled above so the output stays continuous). */
  stickDeadzone: number;
  /** Response exponent after the deadzone: sign(x)·|x|^exp (≥ 1 = finer centre). */
  stickCurveExponent: number;
  triggerDeadzone: number;
  /** Keyboard pedal ramps, units/s. */
  pedalRiseRate: number;
  pedalFallRate: number;
  /** Arcade auto-reverse in auto mode. */
  autoReverse: boolean;
  /** m/s threshold for auto-reverse engagement / release. */
  reverseSpeed: number;
}

export const DEFAULT_INPUT_TUNING: Readonly<InputTuning> = {
  keyboardSteerRate: 2.5,
  keyboardReturnRate: 4,
  gamepadSteerRate: 6,
  steerRateFalloffSpeed: 15,
  steerLimitSpeed: 20,
  minSteerLimit: 0.25,
  stickDeadzone: 0.12,
  stickCurveExponent: 1.6,
  triggerDeadzone: 0.04,
  pedalRiseRate: 5,
  pedalFallRate: 8,
  autoReverse: true,
  reverseSpeed: 0.5,
};

export type TransmissionModeInput = 'auto' | 'manual';

export interface InputMapperOptions {
  tuning?: Partial<InputTuning>;
  transmission?: TransmissionModeInput;
  /** Forward gears for manual mode (default 6). */
  gearCount?: number;
}

export interface KeyEventLike {
  type: string; // 'keydown' | 'keyup'
  code: string;
  repeat?: boolean;
}

export interface GamepadButtonLike {
  pressed: boolean;
  value: number;
}
export interface GamepadLike {
  axes: readonly number[];
  buttons: readonly GamepadButtonLike[];
}

export interface InputMapper {
  /** Returns true when the code is bound (caller may preventDefault). Repeats never re-fire commands. */
  handleKeyEvent(ev: KeyEventLike): boolean;
  keyDown(code: string, repeat?: boolean): boolean;
  keyUp(code: string): boolean;
  /** Latest gamepad state (null = none). Call once per frame before update. */
  setGamepad(pad: GamepadLike | null): void;
  /** Releases every held key (window blur). */
  releaseAll(): void;
  /**
   * Advances smoothing by dtS and returns the ActionState for this frame.
   * speedMs = signed forward speed (telemetry slot 0). The returned object is
   * reused: copy it if you keep it past the next update.
   */
  update(dtS: number, speedMs: number): ActionState;
  /** Commands since the last drain, in arrival order (array is fresh; queue cleared). */
  drainCommands(): InputCommand[];
  setTransmission(mode: TransmissionModeInput): void;
  readonly transmission: TransmissionModeInput;
  setGearCount(n: number): void;
  /** Current smoothed steer (−1..1). */
  readonly steer: number;
}

// ------------------------------------------------------------ pure helpers
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Max |steer| at speed |v| (monotonically non-increasing in |v|). */
export function steerLimit(speedMs: number, t: Readonly<InputTuning> = DEFAULT_INPUT_TUNING): number {
  const r = Math.abs(speedMs) / t.steerLimitSpeed;
  return Math.max(t.minSteerLimit, 1 / (1 + r * r));
}

/** Outward steer slew at speed |v| for a base rate (monotonically non-increasing in |v|). */
export function steerRate(baseRate: number, speedMs: number, t: Readonly<InputTuning> = DEFAULT_INPUT_TUNING): number {
  return baseRate / (1 + Math.abs(speedMs) / t.steerRateFalloffSpeed);
}

/** Deadzone with rescale: |x| ≤ dz → 0, else sign(x)·(|x| − dz)/(1 − dz), clamped to [−1, 1]. */
export function applyDeadzone(x: number, dz: number): number {
  const a = Math.abs(x);
  if (!(a > dz)) return 0;
  return Math.sign(x) * Math.min(1, (a - dz) / (1 - dz));
}

/** Non-linear stick response sign(x)·|x|^exp. */
export function applyStickCurve(x: number, exponent: number): number {
  return Math.sign(x) * Math.pow(Math.abs(x), exponent);
}

/**
 * Slews `cur` toward `target` over dt: `outRate` while moving away from 0,
 * `inRate` while moving toward 0 (a sign change does both in sequence).
 */
export function slewSteer(cur: number, target: number, outRate: number, inRate: number, dt: number): number {
  let t = dt;
  for (let i = 0; i < 2 && t > 0 && cur !== target; i++) {
    const toward = (cur > 0 && target < cur) || (cur < 0 && target > cur);
    const rate = toward ? inRate : outRate;
    const segEnd = toward ? (cur > 0 ? Math.max(target, 0) : Math.min(target, 0)) : target;
    const dist = Math.abs(segEnd - cur);
    if (!(rate > 0)) break;
    const need = dist / rate;
    if (need <= t) {
      cur = segEnd;
      t -= need;
    } else {
      cur += Math.sign(segEnd - cur) * rate * t;
      t = 0;
    }
  }
  return cur;
}

function ramp(cur: number, target: number, rise: number, fall: number, dt: number): number {
  if (target > cur) return Math.min(target, cur + rise * dt);
  if (target < cur) return Math.max(target, cur - fall * dt);
  return cur;
}

// ------------------------------------------------------------ mapper
export function createInputMapper(opts: InputMapperOptions = {}): InputMapper {
  const tune: InputTuning = { ...DEFAULT_INPUT_TUNING, ...opts.tuning };
  let mode: TransmissionModeInput = opts.transmission ?? 'auto';
  let gearCount = Math.max(1, Math.round(opts.gearCount ?? 6));
  const held = new Set<HeldControl>();
  const heldCodes = new Set<string>();
  let commands: InputCommand[] = [];
  let pad: GamepadLike | null = null;
  const padPrev = new Map<number, boolean>();

  let steer = 0;
  let kbThrottle = 0;
  let kbBrake = 0;
  let reversing = false;
  let manualGear = 1;
  const out: ActionState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1 };

  function command(c: InputCommand): void {
    commands.push(c);
    if (mode === 'manual') {
      if (c === 'shiftUp') manualGear = Math.min(gearCount, manualGear + 1);
      else if (c === 'shiftDown') manualGear = Math.max(-1, manualGear - 1);
    }
  }

  function anyCodeHeld(control: HeldControl): boolean {
    for (const code of heldCodes) if (KEY_BINDINGS[code] === control) return true;
    return false;
  }

  function keyDown(code: string, repeat = false): boolean {
    const c = KEY_BINDINGS[code];
    if (c === undefined) return false;
    if (c === 'throttle' || c === 'brake' || c === 'left' || c === 'right' || c === 'handbrake') {
      heldCodes.add(code);
      held.add(c);
    } else if (!repeat && !heldCodes.has(code)) {
      heldCodes.add(code);
      command(c);
    }
    return true;
  }

  function keyUp(code: string): boolean {
    const c = KEY_BINDINGS[code];
    if (c === undefined) return false;
    heldCodes.delete(code);
    if (c === 'throttle' || c === 'brake' || c === 'left' || c === 'right' || c === 'handbrake') {
      if (!anyCodeHeld(c)) held.delete(c);
    }
    return true;
  }

  function padButton(i: number): GamepadButtonLike | undefined {
    return pad?.buttons[i];
  }

  function pollPadCommands(): void {
    for (const key of Object.keys(GAMEPAD_COMMAND_BUTTONS)) {
      const i = Number(key);
      const pressed = !!padButton(i)?.pressed;
      if (pressed && !padPrev.get(i)) command(GAMEPAD_COMMAND_BUTTONS[i]!);
      padPrev.set(i, pressed);
    }
  }

  return {
    handleKeyEvent(ev) {
      if (ev.type === 'keydown') return keyDown(ev.code, !!ev.repeat);
      if (ev.type === 'keyup') return keyUp(ev.code);
      return false;
    },
    keyDown,
    keyUp,
    setGamepad(p) {
      pad = p;
      if (p === null) padPrev.clear();
      else pollPadCommands();
    },
    releaseAll() {
      held.clear();
      heldCodes.clear();
    },
    update(dtS, speedMs) {
      const dt = dtS > 0 && Number.isFinite(dtS) ? dtS : 0;
      const v = Number.isFinite(speedMs) ? speedMs : 0;
      const limit = steerLimit(v, tune);

      // Steering: deflected stick overrides keys.
      const stick = applyDeadzone(pad?.axes[GAMEPAD_AXIS_STEER] ?? 0, tune.stickDeadzone);
      if (stick !== 0) {
        const target = applyStickCurve(stick, tune.stickCurveExponent) * limit;
        steer = slewSteer(steer, target, steerRate(tune.gamepadSteerRate, v, tune), tune.gamepadSteerRate, dt);
      } else {
        const dir = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
        steer = slewSteer(steer, dir * limit, steerRate(tune.keyboardSteerRate, v, tune), tune.keyboardReturnRate, dt);
      }
      steer = clamp(steer, -1, 1);

      // Pedals.
      kbThrottle = ramp(kbThrottle, held.has('throttle') ? 1 : 0, tune.pedalRiseRate, tune.pedalFallRate, dt);
      kbBrake = ramp(kbBrake, held.has('brake') ? 1 : 0, tune.pedalRiseRate, tune.pedalFallRate, dt);
      const padT = applyDeadzone(padButton(GAMEPAD_BUTTON_THROTTLE)?.value ?? 0, tune.triggerDeadzone);
      const padB = applyDeadzone(padButton(GAMEPAD_BUTTON_BRAKE)?.value ?? 0, tune.triggerDeadzone);
      const physT = Math.max(kbThrottle, padT);
      const physB = Math.max(kbBrake, padB);

      let throttle = physT;
      let brake = physB;
      let gear: number;
      if (mode === 'auto') {
        if (tune.autoReverse) {
          if (!reversing && physB > 0.5 && physT < 0.05 && v < tune.reverseSpeed) reversing = true;
          else if (reversing && physT > 0.5 && physB < 0.05 && v > -tune.reverseSpeed) reversing = false;
        }
        if (reversing) {
          throttle = physB;
          brake = physT;
        }
        gear = reversing ? -1 : 1;
      } else {
        gear = manualGear;
      }

      out.throttle = clamp(throttle, 0, 1);
      out.brake = clamp(brake, 0, 1);
      out.steer = steer;
      out.handbrake = held.has('handbrake') || !!padButton(GAMEPAD_BUTTON_HANDBRAKE)?.pressed ? 1 : 0;
      out.clutch = 0;
      out.gearSelect = gear;
      return out;
    },
    drainCommands() {
      const c = commands;
      commands = [];
      return c;
    },
    setTransmission(m) {
      mode = m;
      reversing = false;
      manualGear = 1;
    },
    get transmission() {
      return mode;
    },
    setGearCount(n) {
      gearCount = Math.max(1, Math.round(n));
      if (manualGear > gearCount) manualGear = gearCount;
    },
    get steer() {
      return steer;
    },
  };
}
