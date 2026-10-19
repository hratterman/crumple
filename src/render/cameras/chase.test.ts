import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ChaseCamera, type ChaseTarget } from './chase';

/** Drives a target around a circle (vehicle forward −Z at t = 0, turning right). */
function circleRun(opts: { radius: number; speed: number; slipDeg?: number; seconds: number }) {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 500);
  const chase = new ChaseCamera(camera);
  const target: ChaseTarget = {
    position: new Vector3(),
    forward: new Vector3(),
    up: new Vector3(0, 1, 0),
    velocity: new Vector3(),
  };
  const dt = 1 / 60;
  const w = opts.speed / opts.radius;
  const slip = ((opts.slipDeg ?? 0) * Math.PI) / 180;
  let worstBehindDeg = 0;
  let worstNdc = 0;
  const ndc = new Vector3();
  for (let i = 0; i < opts.seconds * 60; i++) {
    const t = i * dt;
    const th = w * t; // heading angle, right turn: forward rotates from −Z toward +X
    const vel = new Vector3(Math.sin(th), 0, -Math.cos(th)).multiplyScalar(opts.speed);
    // Centre of the circle at (+R, 0, 0).
    target.position.set(opts.radius - opts.radius * Math.cos(th), 0.5, -opts.radius * Math.sin(th));
    target.velocity.copy(vel);
    // Nose points into the turn by the slip angle (drift attitude).
    target.forward.set(Math.sin(th + slip), 0, -Math.cos(th + slip));
    chase.update(dt, target);
    camera.updateMatrixWorld();
    if (t < 1) continue; // settle
    // Camera behind the line of travel: angle between (car − camera) and the velocity.
    const toCar = target.position.clone().sub(camera.position).setY(0).normalize();
    const along = vel.clone().setY(0).normalize();
    worstBehindDeg = Math.max(worstBehindDeg, (Math.acos(Math.min(1, toCar.dot(along))) * 180) / Math.PI);
    ndc.copy(target.position).project(camera);
    worstNdc = Math.max(worstNdc, Math.abs(ndc.x), Math.abs(ndc.y));
    expect(ndc.z).toBeLessThan(1); // in front of the camera
  }
  return { worstBehindDeg, worstNdc, distance: camera.position.distanceTo(target.position) };
}

describe('chase camera', () => {
  it('keeps the car framed from behind while it turns (R 40 m, 15 m/s)', () => {
    const r = circleRun({ radius: 40, speed: 15, seconds: 12 });
    expect(r.worstBehindDeg).toBeLessThan(25);
    expect(r.worstNdc).toBeLessThan(0.6);
    expect(r.distance).toBeGreaterThan(4);
    expect(r.distance).toBeLessThan(10);
  });

  it('tight turn at speed and a 25° drift stay framed (camera follows the line of travel)', () => {
    const tight = circleRun({ radius: 15, speed: 12, seconds: 10 });
    expect(tight.worstBehindDeg).toBeLessThan(45);
    expect(tight.worstNdc).toBeLessThan(0.8);
    const drift = circleRun({ radius: 30, speed: 14, slipDeg: 25, seconds: 10 });
    expect(drift.worstBehindDeg).toBeLessThan(35);
    expect(drift.worstNdc).toBeLessThan(0.8);
  });

  it('rises for a parked car and settles back when it drives off', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 500);
    const chase = new ChaseCamera(camera);
    const target: ChaseTarget = {
      position: new Vector3(0, 0.5, 0),
      forward: new Vector3(0, 0, -1),
      up: new Vector3(0, 1, 0),
      velocity: new Vector3(),
    };
    const dt = 1 / 60;
    chase.update(dt, target);
    const h0 = camera.position.y;
    for (let i = 0; i < 60 * 8; i++) chase.update(dt, target);
    const o = chase.options;
    expect(chase.idleBlend).toBe(1);
    expect(camera.position.y - h0).toBeCloseTo(o.idleExtraHeight, 1);
    const ndc = target.position.clone().project(camera);
    expect(Math.abs(ndc.y)).toBeLessThan(0.6); // car still framed
    // Drive off at 8 m/s: back to the normal chase height within ~1 s.
    target.velocity.set(0, 0, -8);
    for (let i = 0; i < 60 * 2; i++) {
      target.position.z -= 8 * dt;
      chase.update(dt, target);
    }
    expect(chase.idleBlend).toBe(0);
    expect(camera.position.y - h0).toBeLessThan(0.3);
  });
});

describe('ChaseCamera.setFraming (P6 per-vehicle framing)', () => {
  it('applies valid values and ignores invalid ones', () => {
    const chase = new ChaseCamera(new PerspectiveCamera(60, 16 / 9, 0.1, 500));
    chase.setFraming({ distance: 7.2, height: 2.4, lookHeight: 1.1, baseFov: 65 });
    expect(chase.options).toMatchObject({ distance: 7.2, height: 2.4, lookHeight: 1.1, baseFov: 65 });
    chase.setFraming({ distance: -1, height: 0, baseFov: 300 });
    expect(chase.options).toMatchObject({ distance: 7.2, height: 2.4, baseFov: 65 });
  });
});
