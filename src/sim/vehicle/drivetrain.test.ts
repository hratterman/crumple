import { describe, expect, it } from 'vitest';
import { Action, ACTION_COUNT } from '../../protocol/messages';
import { TELEMETRY_SLOTS } from '../../protocol/layout';
import type { SimState } from '../types';
import {
  buildTorqueLut,
  createDrivetrainState,
  RPM_PER_RAD_S,
  sampleTorqueLut,
  stepDrivetrain,
  type DrivetrainStateEx,
} from './drivetrain';
import {
  DIFF_TYPE_ID,
  TORQUE_LUT_STEP_RPM,
  type CompiledDrivetrain,
  type CompiledWheel,
  type DiffType,
  type TransmissionMode,
  type VehicleRuntime,
  type WheelRuntime,
} from './types';

const DT = 1 / 2000;
const CURVE: [number, number][] = [
  [0, 120],
  [1000, 180],
  [4000, 250],
  [6000, 220],
  [7000, 180],
];
const RATIOS = [3.5, 2.1, 1.4, 1.0, 0.8];
const WHEEL_I = 1.2; // kg·m² per wheel (rim + tyre)
const MASS = 1400;
const RADIUS = 0.31;

function makeDrivetrain(diff: DiffType = 'open', transmission: TransmissionMode = 'auto'): CompiledDrivetrain {
  return {
    torqueLut: buildTorqueLut(CURVE),
    lutStepRpm: TORQUE_LUT_STEP_RPM,
    idleRpm: 800,
    redlineRpm: 6500,
    revLimitRpm: 6800,
    engineInertia: 0.2,
    engineBrakeTorque: 80,
    gearRatioTable: new Float64Array([-3.3, 0, ...RATIOS]),
    gearCount: RATIOS.length,
    finalDrive: 3.9,
    shiftTimeS: 0.25,
    autoShiftUpRpm: 6000,
    autoShiftDownRpm: 2500,
    diff: DIFF_TYPE_ID[diff],
    diffLockTorque: 300,
    clutchMaxTorque: 450,
    drivenWheels: new Int32Array([2, 3]),
    transmission,
  };
}

function makeVehicle(diff: DiffType = 'open', transmission: TransmissionMode = 'auto'): VehicleRuntime {
  const dt = makeDrivetrain(diff, transmission);
  const corners = ['FL', 'FR', 'RL', 'RR'];
  const wheels: WheelRuntime[] = corners.map((id, i) => {
    const front = i < 2;
    const cw = {
      id,
      index: i,
      axle: front ? 'front' : 'rear',
      corner: i,
      radius: RADIUS,
      driven: !front,
      braked: true,
      handbrake: !front,
      brakeTorque: front ? 2000 : 1000,
      handbrakeTorque: front ? 0 : 1500,
    } as unknown as CompiledWheel;
    return {
      wheel: cw,
      hubI: 0,
      hubO: 0,
      rimStart: 0,
      tireStart: 0,
      ringCount: 24,
      hubLinkBeams: new Int32Array(0),
      omega: 0,
      load: 0,
      slipSpeed: 0,
      slipRatio: 0,
      rollRadius: 0.3,
      contact: 1,
      detached: 0,
      driveTorque: 0,
      brakeTorque: 0,
    };
  });
  const inertia = new Float64Array([WHEEL_I, WHEEL_I, WHEEL_I, WHEEL_I]);
  return {
    objectId: 1,
    vehicle: { drivetrain: dt } as unknown as VehicleRuntime['vehicle'],
    nodeStart: 0,
    beamStart: 0,
    wheels,
    drivetrain: createDrivetrainState(dt, inertia, transmission),
    telemetry: new Float32Array(TELEMETRY_SLOTS),
  };
}

const NO_STATE = {} as SimState;

function actions(a: Partial<Record<keyof typeof Action, number>>): Float64Array {
  const out = new Float64Array(ACTION_COUNT);
  for (const [k, v] of Object.entries(a)) out[Action[k as keyof typeof Action]] = v;
  return out;
}

/**
 * Lumped car: all 4 wheels roll at the same ω (perfect grip), so the drive
 * axle sees wheel inertia + car mass·r². Rolling resistance + aero drag.
 */
class ToyCar {
  omega = 0;
  constructor(readonly v: VehicleRuntime) {}
  get speed(): number {
    return this.omega * RADIUS;
  }
  step(a: Float64Array): void {
    for (const w of this.v.wheels) w.omega = this.omega;
    stepDrivetrain(NO_STATE, this.v, a, DT, this.v.telemetry);
    let torque = 0;
    for (const w of this.v.wheels) {
      const ramp = Math.max(-1, Math.min(1, this.omega / 1));
      torque += w.driveTorque - w.brakeTorque * ramp;
    }
    const v = this.speed;
    const drag = (0.4 * v * Math.abs(v) + 150 * Math.sign(v)) * RADIUS;
    const I = 4 * WHEEL_I + MASS * RADIUS * RADIUS;
    this.omega += (DT * (torque - drag)) / I;
  }
}

function ds(v: VehicleRuntime): DrivetrainStateEx {
  return v.drivetrain as DrivetrainStateEx;
}

describe('torque LUT', () => {
  it('is exact at curve points / samples and linear between samples', () => {
    const lut = buildTorqueLut(CURVE);
    expect(lut.length).toBe(7000 / TORQUE_LUT_STEP_RPM + 1);
    for (const [rpm, nm] of CURVE) {
      expect(lut[rpm / TORQUE_LUT_STEP_RPM]).toBeCloseTo(nm, 12);
      expect(sampleTorqueLut(lut, TORQUE_LUT_STEP_RPM, rpm)).toBeCloseTo(nm, 12);
    }
    for (let i = 0; i < lut.length; i++) {
      expect(sampleTorqueLut(lut, TORQUE_LUT_STEP_RPM, i * TORQUE_LUT_STEP_RPM)).toBe(lut[i]);
    }
    // Linear between samples (also where the curve has a knee at 1000).
    const a = lut[19]!;
    const b = lut[20]!;
    for (const f of [0.1, 0.25, 0.5, 0.9]) {
      expect(sampleTorqueLut(lut, TORQUE_LUT_STEP_RPM, (19 + f) * TORQUE_LUT_STEP_RPM)).toBeCloseTo(a + (b - a) * f, 10);
    }
    // Curve interpolation at a sample between points: 2500 rpm on the 1000→4000 segment.
    expect(lut[50]).toBeCloseTo(180 + (70 * 1500) / 3000, 12);
    // Clamped at both ends.
    expect(sampleTorqueLut(lut, TORQUE_LUT_STEP_RPM, -100)).toBe(120);
    expect(sampleTorqueLut(lut, TORQUE_LUT_STEP_RPM, 9000)).toBe(180);
  });

  it('rejects non-ascending curves', () => {
    expect(() => buildTorqueLut([[1000, 100], [1000, 120]])).toThrow();
  });
});

describe('engine', () => {
  it('rev limiter caps rpm at full throttle in neutral', () => {
    const v = makeVehicle();
    const a = actions({ throttle: 1, gearSelect: 0 });
    let maxRpm = 0;
    let limited = false;
    for (let t = 0; t < 4000; t++) {
      stepDrivetrain(NO_STATE, v, a, DT, v.telemetry);
      maxRpm = Math.max(maxRpm, ds(v).rpm);
      limited ||= ds(v).revLimiterActive;
    }
    expect(limited).toBe(true);
    expect(maxRpm).toBeGreaterThan(6700);
    expect(maxRpm).toBeLessThan(6800 + 60);
    expect(ds(v).rpm).toBeGreaterThan(6800 - 400);
  });

  it('idle governor holds idle and engine braking pulls rpm down', () => {
    const v = makeVehicle();
    const idle = actions({ gearSelect: 0 });
    for (let t = 0; t < 4000; t++) stepDrivetrain(NO_STATE, v, idle, DT, v.telemetry);
    expect(ds(v).rpm).toBeGreaterThan(700);
    expect(ds(v).rpm).toBeLessThan(820);
    const rev = actions({ throttle: 1, gearSelect: 0 });
    for (let t = 0; t < 1000; t++) stepDrivetrain(NO_STATE, v, rev, DT, v.telemetry);
    const high = ds(v).rpm;
    stepDrivetrain(NO_STATE, v, idle, DT, v.telemetry);
    expect(ds(v).engineTorque).toBeLessThan(0);
    for (let t = 0; t < 400; t++) stepDrivetrain(NO_STATE, v, idle, DT, v.telemetry);
    expect(ds(v).rpm).toBeLessThan(high - 500);
  });
});

describe('clutch + gearbox', () => {
  for (const throttle of [0.3, 1]) {
    it(`launch at throttle ${throttle}: clutch slips then locks without rpm collapse`, () => {
      const v = makeVehicle();
      const car = new ToyCar(v);
      const a = actions({ throttle, gearSelect: 1 });
      let minRpm = Infinity;
      let lockedAt = -1;
      for (let t = 0; t < 8000; t++) {
        car.step(a);
        if (t > 10) minRpm = Math.min(minRpm, ds(v).rpm);
        const s = ds(v);
        if (lockedAt < 0 && s.gear === 1 && s.clutch < 0.01 && Math.abs(s.engineOmega - s.gearboxOmega) < 0.5) lockedAt = t;
        for (const x of [s.rpm, car.omega]) expect(Number.isFinite(x)).toBe(true);
      }
      expect(minRpm).toBeGreaterThan(0.9 * 800);
      expect(lockedAt).toBeGreaterThan(0);
      expect(car.speed).toBeGreaterThan(3);
      // Locked: zero steady-state slip (spring term).
      const s = ds(v);
      if (s.shiftTimer === 0 && s.clutch < 0.01) {
        expect(Math.abs(s.engineOmega - s.gearboxOmega) * RPM_PER_RAD_S).toBeLessThan(20);
      }
    });
  }

  it('auto: shifts up under acceleration, down when slowing, never hunts', () => {
    const v = makeVehicle();
    const car = new ToyCar(v);
    const gears: number[] = [];
    const log = (): void => {
      const g = ds(v).gear;
      if (gears[gears.length - 1] !== g) gears.push(g);
    };
    const accel = actions({ throttle: 1, gearSelect: 1 });
    for (let t = 0; t < 60000; t++) {
      car.step(accel);
      log();
    }
    const upSeq = gears.slice();
    expect(Math.max(...upSeq)).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < upSeq.length; i++) expect(upSeq[i]!).toBeGreaterThan(upSeq[i - 1]!);
    expect(car.speed).toBeGreaterThan(40);
    // rpm never sat on the limiter for long in auto
    expect(ds(v).rpm).toBeLessThan(6800);

    // Steady cruise at part throttle: no shifting at all for 10 s.
    const cruiseStart = gears.length;
    const cruise = actions({ throttle: 0.35, gearSelect: 1 });
    for (let t = 0; t < 20000; t++) {
      car.step(cruise);
      log();
    }
    const settled = gears.length;
    for (let t = 0; t < 20000; t++) {
      car.step(cruise);
      log();
    }
    expect(gears.length).toBe(settled);
    expect(settled - cruiseStart).toBeLessThanOrEqual(2);

    // Brake to a stop: downshifts monotonically back to 1st.
    const downStart = gears.length;
    const brake = actions({ brake: 0.5, gearSelect: 1 });
    for (let t = 0; t < 40000 && car.speed > 0.05; t++) {
      car.step(brake);
      log();
    }
    const downSeq = gears.slice(downStart - 1);
    expect(downSeq[downSeq.length - 1]).toBe(1);
    for (let i = 1; i < downSeq.length; i++) expect(downSeq[i]!).toBeLessThan(downSeq[i - 1]!);
    // At standstill the auto-clutch is open and the engine idles.
    for (let t = 0; t < 2000; t++) car.step(brake);
    expect(ds(v).clutch).toBeGreaterThan(0.9);
    expect(ds(v).rpm).toBeGreaterThan(700);
  });

  it('kickdown: full throttle at moderate speed drops a gear', () => {
    const v = makeVehicle();
    const car = new ToyCar(v);
    car.omega = 25 / RADIUS;
    const cruise = actions({ throttle: 0.2, gearSelect: 1 });
    for (let t = 0; t < 20000; t++) car.step(cruise);
    const g0 = ds(v).gear;
    expect(g0).toBeGreaterThanOrEqual(3);
    const floor = actions({ throttle: 1, gearSelect: 1 });
    let minGear = g0;
    for (let t = 0; t < 2000; t++) {
      car.step(floor);
      minGear = Math.min(minGear, ds(v).targetGear, ds(v).gear);
    }
    expect(minGear).toBeLessThan(g0);
  });

  it('manual mode honours gearSelect; reverse drives backwards', () => {
    const v = makeVehicle('open', 'manual');
    const car = new ToyCar(v);
    for (let t = 0; t < 2000; t++) car.step(actions({ gearSelect: 3 }));
    expect(ds(v).gear).toBe(3);
    const r = new ToyCar(makeVehicle('open', 'auto'));
    for (let t = 0; t < 6000; t++) r.step(actions({ throttle: 0.5, gearSelect: -1 }));
    expect(ds(r.v).gear).toBe(-1);
    expect(r.speed).toBeLessThan(-1);
    expect(r.v.telemetry[30]).toBeLessThan(1e9);
  });

  it('cuts torque during a shift', () => {
    const v = makeVehicle('open', 'manual');
    const car = new ToyCar(v);
    for (let t = 0; t < 4000; t++) car.step(actions({ throttle: 0.6, gearSelect: 1 }));
    car.step(actions({ throttle: 0.6, gearSelect: 2 }));
    expect(ds(v).shiftTimer).toBeGreaterThan(0);
    expect(ds(v).clutch).toBe(1);
    expect(ds(v).driveTorque).toBe(0);
    for (let t = 0; t < 1000; t++) car.step(actions({ throttle: 0.6, gearSelect: 2 }));
    expect(ds(v).gear).toBe(2);
    expect(ds(v).driveTorque).toBeGreaterThan(0);
  });
});

describe('differential + brakes', () => {
  it('open diff splits torque equally regardless of wheel speed', () => {
    const v = makeVehicle('open', 'manual');
    const a = actions({ throttle: 1, gearSelect: 1 });
    for (let t = 0; t < 3000; t++) {
      v.wheels[2]!.omega = 10;
      v.wheels[3]!.omega = 30;
      stepDrivetrain(NO_STATE, v, a, DT, v.telemetry);
      expect(v.wheels[2]!.driveTorque).toBe(v.wheels[3]!.driveTorque);
      expect(v.wheels[0]!.driveTorque).toBe(0);
    }
    expect(v.wheels[2]!.driveTorque).toBeGreaterThan(0);
    expect(v.wheels[2]!.driveTorque + v.wheels[3]!.driveTorque).toBeCloseTo(ds(v).driveTorque, 9);
  });

  /** Two free driven wheels; the left one has a strong resisting torque. */
  function splitRun(diff: DiffType): { dw: number; total: number } {
    const v = makeVehicle(diff, 'manual');
    const L = v.wheels[2]!;
    const R = v.wheels[3]!;
    // Pre-spin the wheels to 2nd-gear road speed so the clutch is locked.
    L.omega = R.omega = 30;
    const a = actions({ throttle: 0.5, gearSelect: 2 });
    let total = 0;
    for (let t = 0; t < 4000; t++) {
      stepDrivetrain(NO_STATE, v, a, DT, v.telemetry);
      total = L.driveTorque + R.driveTorque;
      const carI = (MASS * RADIUS * RADIUS) / 2;
      L.omega += (DT * (L.driveTorque - 0.9 * 400)) / (WHEEL_I + carI);
      R.omega += (DT * R.driveTorque) / WHEEL_I; // unloaded wheel (on ice)
    }
    return { dw: Math.abs(L.omega - R.omega), total };
  }

  it('locked diff equalizes driven-wheel speeds (open diff lets one spin up)', () => {
    const open = splitRun('open');
    const locked = splitRun('locked');
    const limited = splitRun('limited');
    expect(open.dw).toBeGreaterThan(50);
    expect(locked.dw).toBeLessThan(0.5);
    expect(limited.dw).toBeLessThan(open.dw);
    expect(Number.isFinite(locked.total)).toBe(true);
  });

  it('locked diff conserves total torque (pure redistribution)', () => {
    const v = makeVehicle('locked', 'manual');
    const a = actions({ throttle: 1, gearSelect: 1 });
    for (let t = 0; t < 3000; t++) {
      v.wheels[2]!.omega = 10;
      v.wheels[3]!.omega = 12;
      stepDrivetrain(NO_STATE, v, a, DT, v.telemetry);
      expect(v.wheels[2]!.driveTorque + v.wheels[3]!.driveTorque).toBeCloseTo(ds(v).driveTorque, 6);
    }
    expect(v.wheels[2]!.driveTorque).toBeGreaterThan(v.wheels[3]!.driveTorque);
  });

  it('detached driven wheel gets no drive torque', () => {
    const v = makeVehicle('open', 'manual');
    v.wheels[3]!.detached = 1;
    const a = actions({ throttle: 1, gearSelect: 1 });
    for (let t = 0; t < 3000; t++) {
      v.wheels[2]!.omega = 5;
      v.wheels[3]!.omega = 100;
      stepDrivetrain(NO_STATE, v, a, DT, v.telemetry);
      expect(v.wheels[3]!.driveTorque).toBe(0);
    }
    expect(v.wheels[2]!.driveTorque).toBeGreaterThan(0);
  });

  it('brake torque uses the biased per-wheel max and the handbrake on the rear', () => {
    const v = makeVehicle();
    stepDrivetrain(NO_STATE, v, actions({ brake: 0.5, handbrake: 0.2 }), DT, v.telemetry);
    expect(v.wheels.map((w) => w.brakeTorque)).toEqual([1000, 1000, 500, 500]);
    stepDrivetrain(NO_STATE, v, actions({ brake: 0.1, handbrake: 1 }), DT, v.telemetry);
    expect(v.wheels.map((w) => w.brakeTorque)).toEqual([200, 200, 1500, 1500]);
    expect(v.telemetry[4]).toBeCloseTo(0.1, 6);
    expect(v.telemetry[7]).toBe(1);
  });
});
