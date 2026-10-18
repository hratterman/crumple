/**
 * Soft-body wheel generator (Rigs of Rods `wheels2` structure).
 *
 * PURE DATA MODULE (docs/CONTRACTS.md boundary amendment, P2): main-thread
 * code may import it. No engine/state/worker imports, no three, no DOM. Not a
 * hot loop: allocation and Math.* are fine here.
 *
 * Node order and beam order follow the FROZEN rules in ./types.ts
 * (wheelNodeId, canonical merged order, WHEEL BEAM ORDER).
 */
import type { RigBeamDef, RigNodeDef } from '../rig/types';
import { VehicleCompileError } from './builder';
import {
  WHEEL_BEAMS_PER_RAY,
  WHEEL_DEFAULTS,
  WHEEL_RAYS_MAX,
  WHEEL_RAYS_MIN,
  wheelNodeId,
  type BuildWheelRig,
  type WheelDef,
} from './types';

/**
 * Recommended tyre/rim tuning for a 205/55R16-class road tyre (0.32 m
 * radius, 16" rim), 12 rays. Spread it into a WheelDef and add the
 * placement/role fields (id, hubInner/hubOuter, axle, flags, attach).
 *
 * Every generated node passes the per-node structure limit with the
 * declared masses (no MINIMASS raise), checked by wheels.test.ts with
 * computeStabilityReport at dt = 1/2000 (wheel alone; attach + suspension
 * beams load the hubs further and MINIMASS covers them):
 *   tyre node  m 0.667 kg  Σk 3.18e5  ω·dt 0.345  (Σd/m)·dt 0.48
 *   rim node   m 1.000 kg  Σk 4.83e5  ω·dt 0.347  (Σd/m)·dt 0.39
 *   hub node   m 5.0 kg    Σk 1.99e6  ω·dt 0.315  (Σd/m)·dt 0.32
 * (10 rays passes too; 14 rays has lighter nodes and needs MINIMASS.)
 *
 * Static load (hubs held, flat asphalt, wheels.test.ts): 3.5 kN deflects
 * the tyre 25.6 mm at the hub, ≈ 7 mm of it the ground kernel's penalty
 * depth (KC_MAX = 2.5e5 N/m on the 2 contact nodes), monotone (no sidewall
 * collapse) past 3.5 kN.
 *
 * WHY not 1–2 cm: the ω·dt ≤ 0.35 rule caps every node at
 * Σk ≤ 4.9e5·m (N/m per kg). At 12 rays only the bottom tyre node pair
 * carries the load (the next ray sits 3.9 cm higher), so the carcass
 * stiffness is bounded by ~0.6 of two tyre nodes' Σk, and the rim nodes
 * (6 rim + 3 sidewall beams each) bound the rim path the same way. A grid
 * search over masses/allocations measured ≈ 30 mm at a realistic 38 kg
 * wheel and ≈ 22 mm at 60 kg; this tuning (50 kg incl. hubs, I ≈ 2.3 kg·m²,
 * about 2× a real wheel) is the compromise. Sidewall/tread/rim stiffness
 * are each set near their nodes' budgets (tread ≈ ½ sidewall resists
 * sidewall splay); damping ≈ 0.25–0.35 of 2·sqrt(k·μ_reduced).
 */
export const WHEEL_TUNING_205_55R16 = {
  radius: 0.32,
  rimRadius: 0.2,
  width: 0.15,
  rays: 12,
  tireRingSpring: 2.65e4,
  tireRingDamp: 60,
  rimSpring: 5.4e4,
  rimDamp: 80,
  sidewallSpring: 5.3e4,
  sidewallDamp: 100,
  hubMass: 10,
  rimMass: 24,
  tireMass: 16,
  friction: 2.0,
} as const satisfies Partial<WheelDef>;

function fail(wheel: string, msg: string): never {
  throw new VehicleCompileError(`buildWheelRig("${wheel}"): ${msg}`);
}

function positive(wheel: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) fail(wheel, `${field} must be a finite number > 0 (got ${String(v)})`);
  return v;
}

function nonNeg(wheel: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(wheel, `${field} must be a finite number >= 0 (got ${String(v)})`);
  return v;
}

function vec(wheel: string, field: string, v: unknown): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    fail(wheel, `${field} must be a finite [x, y, z]`);
  }
  return [v[0] as number, v[1] as number, v[2] as number];
}

/**
 * Generates one wheel: 2 + 4·rays nodes (hubI, hubO, rimI[], rimO[],
 * tireI[], tireO[]) and 2·attach.length + 1 + 20·rays beams in WHEEL BEAM
 * ORDER. Geometry, masses and groups exactly as documented on WheelDef.
 */
export const buildWheelRig: BuildWheelRig = (wheel, bodyNodeLookup) => {
  const id = typeof wheel?.id === 'string' ? wheel.id : '?';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(id, `id must match [A-Za-z0-9_-]+`);
  const n = wheel.rays;
  if (!Number.isInteger(n) || n % 2 !== 0 || n < WHEEL_RAYS_MIN || n > WHEEL_RAYS_MAX) {
    fail(id, `rays must be an even integer in [${WHEEL_RAYS_MIN}, ${WHEEL_RAYS_MAX}] (got ${String(n)})`);
  }
  const hubInner = vec(id, 'hubInner', wheel.hubInner);
  const hubOuter = vec(id, 'hubOuter', wheel.hubOuter);
  const radius = positive(id, 'radius', wheel.radius);
  const rimRadius = positive(id, 'rimRadius', wheel.rimRadius);
  const width = positive(id, 'width', wheel.width);
  const tireNodeRadius = positive(id, 'tireNodeRadius', wheel.tireNodeRadius ?? WHEEL_DEFAULTS.tireNodeRadius);
  const tireRingRadius = radius - tireNodeRadius;
  if (!(rimRadius < tireRingRadius)) {
    fail(id, `rimRadius ${rimRadius} must be < radius - tireNodeRadius = ${tireRingRadius}`);
  }
  const hubMass = positive(id, 'hubMass', wheel.hubMass);
  const rimMass = positive(id, 'rimMass', wheel.rimMass);
  const tireMass = positive(id, 'tireMass', wheel.tireMass);
  const friction = nonNeg(id, 'friction', wheel.friction);
  const rimK = nonNeg(id, 'rimSpring', wheel.rimSpring);
  const rimD = nonNeg(id, 'rimDamp', wheel.rimDamp);
  const treadK = nonNeg(id, 'tireRingSpring', wheel.tireRingSpring);
  const treadD = nonNeg(id, 'tireRingDamp', wheel.tireRingDamp);
  const sideK = nonNeg(id, 'sidewallSpring', wheel.sidewallSpring);
  const sideD = nonNeg(id, 'sidewallDamp', wheel.sidewallDamp);
  const attachK = nonNeg(id, 'attachSpring', wheel.attachSpring ?? rimK);
  const attachD = nonNeg(id, 'attachDamp', wheel.attachDamp ?? rimD);
  const attachBreakF = wheel.attachBreakF ?? WHEEL_DEFAULTS.attachBreakF;
  if (typeof attachBreakF !== 'number' || !Number.isFinite(attachBreakF)) fail(id, 'attachBreakF must be finite');
  if (!Array.isArray(wheel.attach)) fail(id, 'attach must be an array of body node ids');

  // Axle frame (see WheelDef doc): a outboard, e1/e2 span the wheel plane.
  let ax = hubOuter[0] - hubInner[0];
  let ay = hubOuter[1] - hubInner[1];
  let az = hubOuter[2] - hubInner[2];
  const aLen = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(aLen > 1e-6)) fail(id, 'hubInner and hubOuter coincide');
  ax /= aLen;
  ay /= aLen;
  az /= aLen;
  // e1 = Y × a = (az, 0, −ax); fallback X × a = (0, −az, ay).
  let e1x = az;
  let e1y = 0;
  let e1z = -ax;
  let e1Len = Math.sqrt(e1x * e1x + e1z * e1z);
  if (e1Len < 1e-6) {
    e1x = 0;
    e1y = -az;
    e1z = ay;
    e1Len = Math.sqrt(e1y * e1y + e1z * e1z);
  }
  e1x /= e1Len;
  e1y /= e1Len;
  e1z /= e1Len;
  const e2x = ay * e1z - az * e1y;
  const e2y = az * e1x - ax * e1z;
  const e2z = ax * e1y - ay * e1x;
  const cx = (hubInner[0] + hubOuter[0]) * 0.5;
  const cy = (hubInner[1] + hubOuter[1]) * 0.5;
  const cz = (hubInner[2] + hubOuter[2]) * 0.5;
  const hw = width * 0.5;

  const ringPos = (k: number, r: number, side: -1 | 1): [number, number, number] => {
    const th = (2 * Math.PI * k) / n;
    const c = Math.cos(th);
    const s = Math.sin(th);
    return [
      cx + side * hw * ax + r * (c * e1x + s * e2x),
      cy + side * hw * ay + r * (c * e1y + s * e2y),
      cz + side * hw * az + r * (c * e1z + s * e2z),
    ];
  };

  const hubNodeMass = hubMass / 2;
  const rimNodeMass = rimMass / (2 * n);
  const tireNodeMass = tireMass / (2 * n);
  const nodes: RigNodeDef[] = [];
  const hubNode = (part: 'hubI' | 'hubO', pos: [number, number, number]): RigNodeDef => ({
    id: wheelNodeId(id, part),
    pos: [pos[0], pos[1], pos[2]],
    mass: hubNodeMass,
    friction: WHEEL_DEFAULTS.rimFriction,
    radius: WHEEL_DEFAULTS.rimNodeRadius,
    group: WHEEL_DEFAULTS.hubGroup,
    collidable: false,
  });
  nodes.push(hubNode('hubI', hubInner), hubNode('hubO', hubOuter));
  for (const [part, side] of [
    ['rimI', -1],
    ['rimO', 1],
  ] as const) {
    for (let k = 0; k < n; k++) {
      nodes.push({
        id: wheelNodeId(id, part, k),
        pos: ringPos(k, rimRadius, side),
        mass: rimNodeMass,
        friction: WHEEL_DEFAULTS.rimFriction,
        radius: WHEEL_DEFAULTS.rimNodeRadius,
        group: WHEEL_DEFAULTS.rimGroup,
        collidable: true,
      });
    }
  }
  for (const [part, side] of [
    ['tireI', -1],
    ['tireO', 1],
  ] as const) {
    for (let k = 0; k < n; k++) {
      nodes.push({
        id: wheelNodeId(id, part, k),
        pos: ringPos(k, tireRingRadius, side),
        mass: tireNodeMass,
        friction,
        radius: tireNodeRadius,
        group: WHEEL_DEFAULTS.tireGroup,
        collidable: true,
      });
    }
  }

  const beams: RigBeamDef[] = [];
  const hubI = wheelNodeId(id, 'hubI');
  const hubO = wheelNodeId(id, 'hubO');
  for (const bodyId of wheel.attach) {
    if (typeof bodyId !== 'string' || bodyNodeLookup(bodyId) === undefined) {
      fail(id, `attach references unknown body node "${String(bodyId)}"`);
    }
    for (const hub of [hubI, hubO]) {
      beams.push({ a: hub, b: bodyId, type: 'normal', k: attachK, d: attachD, deform: WHEEL_DEFAULTS.rimDeform, breakF: attachBreakF });
    }
  }
  const rim = (a: string, b: string): void => {
    beams.push({ a, b, type: 'normal', k: rimK, d: rimD, deform: WHEEL_DEFAULTS.rimDeform, breakF: WHEEL_DEFAULTS.rimBreakF });
  };
  const tread = (a: string, b: string): void => {
    beams.push({ a, b, type: 'normal', k: treadK, d: treadD, deform: WHEEL_DEFAULTS.tireDeform, breakF: WHEEL_DEFAULTS.tireBreakF });
  };
  const side = (a: string, b: string): void => {
    beams.push({ a, b, type: 'normal', k: sideK, d: sideD, deform: WHEEL_DEFAULTS.tireDeform, breakF: WHEEL_DEFAULTS.tireBreakF });
  };
  rim(hubI, hubO);
  const rI = (k: number) => wheelNodeId(id, 'rimI', k);
  const rO = (k: number) => wheelNodeId(id, 'rimO', k);
  const tI = (k: number) => wheelNodeId(id, 'tireI', k);
  const tO = (k: number) => wheelNodeId(id, 'tireO', k);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const before = beams.length;
    rim(hubI, rI(k));
    rim(hubO, rO(k));
    rim(hubI, rO(k));
    rim(hubO, rI(k));
    rim(rI(k), rO(k));
    rim(rI(k), rI(k1));
    rim(rO(k), rO(k1));
    rim(rI(k), rO(k1));
    tread(tI(k), tI(k1));
    tread(tO(k), tO(k1));
    tread(tI(k), tO(k));
    tread(tI(k), tO(k1));
    side(rI(k), tI(k));
    side(rO(k), tO(k));
    side(rI(k), tI(k1));
    side(rO(k), tO(k1));
    side(rI(k1), tI(k));
    side(rO(k1), tO(k));
    side(hubI, tO(k));
    side(hubO, tI(k));
    if (beams.length - before !== WHEEL_BEAMS_PER_RAY) fail(id, 'internal: per-ray beam count drifted from WHEEL_BEAMS_PER_RAY');
  }
  return { nodes, beams };
};
