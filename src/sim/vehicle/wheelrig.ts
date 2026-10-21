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
 * Per-node stability with the declared masses at dt = 1/2000 (wheel alone,
 * wheels.test.ts): tread node m 0.392 kg Σk 3.18e5 ω·dt 0.451 (tread nodes
 * may run to TREAD_OMEGA_DT_LIMIT 0.49, builder.ts), rim node m 1.0 kg Σk
 * 4.83e5 ω·dt 0.347, hub node 5 kg ω·dt 0.315; (Σd/m)·dt ≤ 0.051. The hoop
 * tension's geometric stiffness at HOOP_OMEGA_MAX (wheels.ts) adds in
 * quadrature: tread 0.451 → 0.498 (f 0.5), rim 0.347 → 0.459 (f 1) —
 * tireMass 9.4 kg (was 8) buys the tread that headroom.
 *
 * Contact model (handling harness, src/sim/vehicle/handling.test.ts):
 *  - tread contact layer (tireContactSpring 8e4 N/m per node, soft-layer
 *    law in ground.ts): tread nodes run into the "rubber" instead of being
 *    stopped dead at touchdown (8e4: stiffer re-excited a fore/aft rocking
 *    of the parked car on the tread polygon); ≈ 40 mm hub drop at 3.5 kN;
 *  - light tread (9.4 kg) and light carcass damping: rolling loss is the
 *    tread nodes' touchdown impact (∝ tread mass), not hysteresis;
 *  - rolling resistance C_rr 0.008 (Coulomb-like at rest, see
 *    ROLL_RES_OMEGA_EPS): the viscous carcass has almost no loss at
 *    walking pace;
 *  - rim hoop tension 1 (wheels.ts applyRimHoopTension): the rim does not
 *    balloon with speed;
 *  - lateral tread brush (treadBrushStiffness 7e4 N/m per node): lateral
 *    grip without carcass stiffness (wheels.ts applyTreadBrush);
 *    longitudinal grip is the node-level stick through the carcass
 *    (κ ≈ 0.03 at 500 N·m);
 *  - friction 1.1 (performance road tyre on dry asphalt, μ literal: the
 *    ground law is implicit Coulomb, not RoR's regularized 2.0).
 */
export const WHEEL_TUNING_205_55R16 = {
  radius: 0.32,
  rimRadius: 0.2,
  width: 0.15,
  rays: 12,
  tireNodeRadius: 0.045,
  tireContactSpring: 8e4,
  // R-PHYS: 7e4 → 1.6e5 (flat-track bench, realism/tyreSweeps.ts): cornering stiffness C_α/Fz 8.8 → 15.2/rad and
  // peak slip angle 11.9° → 7.3° at 4 kN (205/55R16 data: C_α/Fz 15–20/rad, peak 6–9°; Pacejka §4.3)
  treadBrushStiffness: 1.6e5,
  treadBrushDamping: 30,
  rimHoopTension: 1,
  treadHoopTension: 0.5,
  rollingResistance: 0.008,
  tireRingSpring: 2.65e4,
  tireRingDamp: 4,
  rimSpring: 5.4e4,
  rimDamp: 6,
  sidewallSpring: 5.3e4,
  sidewallDamp: 6,
  hubMass: 10,
  rimMass: 24,
  tireMass: 9.4,
  // R-PHYS: 1.1 → 1.25 (μ_x of a summer 205/55R16 on dry asphalt; μ_y = 0.85 of it, tyreLateralMu): ABS stops
  // ≈ 1.0 g, skidpad ≈ 0.9 g (in-car braking reaches ≈ 0.85 μ_x: load sensitivity and dive camber)
  friction: 1.25,
  // R-PHYS tyre model (tyre.ts): μ load sensitivity, sliding fall-off to 0.8 of peak (dry asphalt 0.7–0.85)
  tyreLoadSensitivity: 0.1,
  tyreSlideRatio: 0.8,
  tyrePeakSlip: 0.07,
  tyreSlideSlip: 0.5,
  // μ_y/μ_x: summer car tyres corner at ≈ 0.85–0.95 of their braking μ (skidpad ≈ 0.9 g vs ABS ≈ 1.0 g)
  tyreLateralMu: 0.85,
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
 * tireI[], tireO[]) and 2·attach.length + 1 + 22·rays beams in WHEEL BEAM
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
  const tireContactSpring = nonNeg(id, 'tireContactSpring', wheel.tireContactSpring ?? WHEEL_DEFAULTS.tireContactSpring);
  const brush = nonNeg(id, 'treadBrushStiffness', wheel.treadBrushStiffness ?? WHEEL_DEFAULTS.treadBrushStiffness) > 0;
  nonNeg(id, 'treadBrushDamping', wheel.treadBrushDamping ?? WHEEL_DEFAULTS.treadBrushDamping);
  for (const [field, v] of [
    ['rimHoopTension', wheel.rimHoopTension ?? WHEEL_DEFAULTS.rimHoopTension],
    ['treadHoopTension', wheel.treadHoopTension ?? WHEEL_DEFAULTS.treadHoopTension],
  ] as const) {
    if (nonNeg(id, field, v) > 1) fail(id, `${field} must be in [0, 1] (got ${v})`);
  }
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
        ...(tireContactSpring > 0 ? { contactSpring: tireContactSpring } : {}),
        ...(brush ? { tread: true } : {}),
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
  const rim = (a: string, b: string, f = 1): void => {
    beams.push({ a, b, type: 'normal', k: rimK * f, d: rimD * f, deform: WHEEL_DEFAULTS.rimDeform, breakF: WHEEL_DEFAULTS.rimBreakF });
  };
  const tread = (a: string, b: string, f = 1): void => {
    beams.push({ a, b, type: 'normal', k: treadK * f, d: treadD * f, deform: WHEEL_DEFAULTS.tireDeform, breakF: WHEEL_DEFAULTS.tireBreakF });
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
    rim(rI(k), rO(k1), 0.5);
    tread(tI(k), tI(k1));
    tread(tO(k), tO(k1));
    tread(tI(k), tO(k));
    tread(tI(k), tO(k1), 0.5);
    side(rI(k), tI(k));
    side(rO(k), tO(k));
    side(rI(k), tI(k1));
    side(rO(k), tO(k1));
    side(rI(k1), tI(k));
    side(rO(k1), tO(k));
    side(hubI, tO(k));
    side(hubO, tI(k));
    // X-bracing: the mirrored diagonals (each diagonal at half stiffness).
    // One-way diagonals make a wheel chiral: torsion couples into axial
    // shear, and since left and right rings run in opposite rotational
    // senses both wheels of an axle crabbed the SAME way under drive/brake
    // torque (net side force: the sedan spun out on a straight launch).
    // Zig-zag alternation is achiral but gives every other node two
    // diagonals and its neighbour none (uneven ω·dt and radial stiffness).
    rim(rO(k), rI(k1), 0.5);
    tread(tO(k), tI(k1), 0.5);
    if (beams.length - before !== WHEEL_BEAMS_PER_RAY) fail(id, 'internal: per-ray beam count drifted from WHEEL_BEAMS_PER_RAY');
  }
  return { nodes, beams };
};
