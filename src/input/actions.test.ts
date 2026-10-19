import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_TUNING,
  applyDeadzone,
  applyStickCurve,
  createInputMapper,
  slewSteer,
  steerLimit,
  steerRate,
  type GamepadLike,
} from './actions';

const DT = 1 / 60;

function run(m: ReturnType<typeof createInputMapper>, seconds: number, speed = 0) {
  const n = Math.round(seconds / DT);
  let a = m.update(DT, speed);
  for (let i = 1; i < n; i++) a = m.update(DT, speed);
  return a;
}

function pad(x: number, rt = 0, lt = 0, pressed: number[] = []): GamepadLike {
  const buttons = Array.from({ length: 16 }, (_, i) => ({
    pressed: pressed.includes(i) || (i === 7 && rt > 0.5) || (i === 6 && lt > 0.5),
    value: i === 7 ? rt : i === 6 ? lt : pressed.includes(i) ? 1 : 0,
  }));
  return { axes: [x, 0, 0, 0], buttons };
}

describe('keyboard steering ramp', () => {
  it('ramps to full lock at keyboardSteerRate at standstill, not instantly', () => {
    const m = createInputMapper();
    m.keyDown('KeyD');
    const first = m.update(DT, 0).steer;
    expect(first).toBeCloseTo(DEFAULT_INPUT_TUNING.keyboardSteerRate * DT, 9);
    const half = run(m, 0.2 - DT, 0).steer;
    expect(half).toBeCloseTo(0.5, 6);
    expect(run(m, 0.5, 0).steer).toBe(1);
  });

  it('left is negative and returns to centre at keyboardReturnRate', () => {
    const m = createInputMapper();
    m.keyDown('ArrowLeft');
    expect(run(m, 1, 0).steer).toBe(-1);
    m.keyUp('ArrowLeft');
    const after = m.update(DT, 0).steer;
    expect(after).toBeCloseTo(-1 + DEFAULT_INPUT_TUNING.keyboardReturnRate * DT, 9);
    expect(run(m, 0.3, 0).steer).toBe(0);
  });

  it('opposite keys cancel', () => {
    const m = createInputMapper();
    m.keyDown('KeyA');
    m.keyDown('KeyD');
    expect(run(m, 1, 0).steer).toBe(0);
    m.keyUp('KeyA');
    expect(run(m, 1, 0).steer).toBe(1);
    m.keyDown('ArrowLeft');
    expect(run(m, 1, 0).steer).toBe(0);
  });

  it('slewSteer crosses centre using the return rate first, then the outward rate', () => {
    // 0.5 → 0 at inRate 5 takes 0.1 s; remaining 0.1 s at outRate 1 → −0.1.
    expect(slewSteer(0.5, -1, 1, 5, 0.2)).toBeCloseTo(-0.1, 12);
  });
});

describe('speed sensitivity', () => {
  it('limit and outward rate are monotonically non-increasing with speed', () => {
    let prevL = Infinity;
    let prevR = Infinity;
    for (let v = 0; v <= 80; v += 0.5) {
      const l = steerLimit(v);
      const r = steerRate(2.5, v);
      expect(l).toBeLessThanOrEqual(prevL);
      expect(r).toBeLessThanOrEqual(prevR);
      expect(l).toBeGreaterThanOrEqual(DEFAULT_INPUT_TUNING.minSteerLimit);
      prevL = l;
      prevR = r;
    }
    expect(steerLimit(0)).toBe(1);
    expect(steerLimit(-30)).toBe(steerLimit(30));
  });

  it('held steer settles lower and ramps slower at speed', () => {
    const slow = createInputMapper();
    const fast = createInputMapper();
    slow.keyDown('KeyD');
    fast.keyDown('KeyD');
    expect(fast.update(DT, 30).steer).toBeLessThan(slow.update(DT, 0).steer);
    const s = run(slow, 3, 0).steer;
    const f = run(fast, 3, 30).steer;
    expect(f).toBeLessThan(s);
    expect(f).toBeCloseTo(steerLimit(30), 9);
  });
});

describe('gamepad', () => {
  it('deadzone zeroes small deflections and is continuous at the edge', () => {
    const dz = DEFAULT_INPUT_TUNING.stickDeadzone;
    expect(applyDeadzone(0.05, dz)).toBe(0);
    expect(applyDeadzone(-dz, dz)).toBe(0);
    expect(applyDeadzone(dz + 1e-9, dz)).toBeLessThan(1e-6);
    expect(applyDeadzone(1, dz)).toBe(1);
    expect(applyDeadzone(-1, dz)).toBe(-1);
    expect(applyStickCurve(0.5, 2)).toBeCloseTo(0.25, 12);
    expect(applyStickCurve(-0.5, 2)).toBeCloseTo(-0.25, 12);
  });

  it('stick inside the deadzone leaves steer at 0; full stick reaches the speed limit', () => {
    const m = createInputMapper();
    m.setGamepad(pad(0.08));
    expect(run(m, 0.5, 0).steer).toBe(0);
    m.setGamepad(pad(1));
    expect(run(m, 1, 0).steer).toBe(1);
    m.setGamepad(pad(1));
    expect(run(m, 2, 25).steer).toBeCloseTo(steerLimit(25), 9);
  });

  it('triggers drive throttle/brake and buttons fire commands on rising edge', () => {
    const m = createInputMapper();
    m.setGamepad(pad(0, 0.8, 0, [5]));
    const a = m.update(DT, 10);
    expect(a.throttle).toBeCloseTo((0.8 - 0.04) / 0.96, 9);
    m.setGamepad(pad(0, 0, 0, [5]));
    expect(m.drainCommands()).toEqual(['shiftUp']);
  });
});

describe('pedals, gears and commands', () => {
  it('keyboard throttle ramps up and down', () => {
    const m = createInputMapper();
    m.keyDown('KeyW');
    expect(m.update(0.1, 0).throttle).toBeCloseTo(0.5, 9);
    expect(m.update(0.2, 0).throttle).toBe(1);
    m.keyUp('KeyW');
    expect(m.update(0.1, 0).throttle).toBeCloseTo(0.2, 9);
  });

  it('auto mode: brake at standstill engages reverse and swaps pedals', () => {
    const m = createInputMapper();
    m.keyDown('KeyS');
    let a = run(m, 0.5, 5);
    expect(a.gearSelect).toBe(1);
    expect(a.brake).toBe(1);
    a = run(m, 0.5, 0);
    expect(a.gearSelect).toBe(-1);
    expect(a.throttle).toBe(1);
    expect(a.brake).toBe(0);
    m.keyUp('KeyS');
    m.keyDown('KeyW');
    a = run(m, 0.5, -3);
    expect(a.gearSelect).toBe(-1);
    expect(a.brake).toBe(1);
    a = run(m, 0.5, 0);
    expect(a.gearSelect).toBe(1);
  });

  it('manual mode steps gears R..n and emits shift commands without key repeat', () => {
    const m = createInputMapper({ transmission: 'manual', gearCount: 3 });
    expect(m.update(DT, 0).gearSelect).toBe(1);
    for (let i = 0; i < 5; i++) {
      m.keyDown('KeyE');
      m.keyDown('KeyE', true);
      m.keyUp('KeyE');
    }
    expect(m.update(DT, 0).gearSelect).toBe(3);
    for (let i = 0; i < 6; i++) {
      m.keyDown('ControlLeft');
      m.keyUp('ControlLeft');
    }
    expect(m.update(DT, 0).gearSelect).toBe(-1);
    const cmds = m.drainCommands();
    expect(cmds.filter((c) => c === 'shiftUp')).toHaveLength(5);
    expect(cmds.filter((c) => c === 'shiftDown')).toHaveLength(6);
    expect(m.drainCommands()).toEqual([]);
  });

  it('discrete commands and handbrake', () => {
    const m = createInputMapper();
    for (const code of ['KeyR', 'KeyF', 'KeyC', 'KeyB', 'KeyP', 'KeyT', 'KeyX']) {
      expect(m.handleKeyEvent({ type: 'keydown', code })).toBe(true);
      m.handleKeyEvent({ type: 'keydown', code, repeat: true });
      m.handleKeyEvent({ type: 'keyup', code });
    }
    expect(m.drainCommands()).toEqual(['recover', 'repair', 'cameraCycle', 'toggleBeamView', 'pause', 'slowMo', 'toggleTractionControl']);
    expect(m.handleKeyEvent({ type: 'keydown', code: 'KeyZ' })).toBe(false);
    m.keyDown('Space');
    expect(m.update(DT, 0).handbrake).toBe(1);
    m.releaseAll();
    expect(m.update(DT, 0).handbrake).toBe(0);
  });
});
