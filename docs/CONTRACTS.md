# Contracts

Frozen contracts are load-bearing for parallel agents: once FROZEN, changes require updating every consumer in the same change and a note here.

## Repo layout — FROZEN

Directory map as documented in `CLAUDE.md` (src/core, src/protocol, src/sim, src/render, src/game, src/input, src/ui, src/audio, src/app, src/assets, tools/, tests/e2e). Hard boundaries apply (see CLAUDE.md).

## npm scripts — FROZEN

`dev`, `build`, `preview`, `typecheck`, `test`, `test:watch`, `e2e`, `bench`, `fetch-assets` as defined in `package.json`. CI and tooling key off these names.

## Asset manifest path — FROZEN

`src/assets/manifest.ts` — pinned asset IDs/paths with procedural fallbacks. No build/test path may hard-require downloaded files.

## Boundary amendment — FROZEN (P1)

Main-thread code (render/ui/game/app) MAY import the pure-data rig modules `src/sim/rig/types.ts`, `src/sim/rig/builder.ts` (`compileRig`) and `src/sim/rig/testrigs.ts`. These must stay pure (no engine/state/worker imports, no three, no DOM). Main-thread code must NEVER import sim engine, state, kernel or worker modules (including `src/sim/types.ts`). `src/protocol` may `import type` from `src/sim/rig/types.ts` (RigDef in `spawn`).

## protocol/ — FROZEN (P1)

- **messages.ts**: discriminated unions on `type`.
  - Main→worker: `init{seed, gravity, snapshotHz (default 120), debugStrains, capacity?}`, `ground{mode:'plane', y, materialId}` (`mode:'heightfield'` reserved for P3), `spawn{objectId, rig: RigDef, transform{pos, quat[x,y,z,w]}}`, `despawn`, `input{objectId, actions: Partial<ActionState>}` (merge), `reset{objectId, transform}` (full repair), `timescale{value}`, `returnBuffer{buffer}` (transferred). Reserved: `setBubble`, `keyframeRequest`, `replaySeek`.
  - Worker→main: `ready`, `snapshot{buffer}` (transferred), `fatal{message, stack?}`, `unimplemented{command}` (reserved commands/variants), `error{command, message, objectId?}` (recoverable rejection).
  - Commands apply in arrival order at the next step boundary.
- **Snapshot capacity** is fixed at `init` (`DEFAULT_CAPACITY` 64 objects / 32768 nodes / 131072 beams); spawns beyond it get `error`.
- **layout.ts**: `[header 128 B][objects][impacts][beamBreaks][skids][nodes][strains?]`, every section 16-byte aligned; all offsets are exported consts and also stored in the header. Magic `'CRMP'` (u32 0x504D5243), `SNAPSHOT_VERSION` 1. Object record 160 B: id, flags (bit0 sleeping), nodeOffset, nodeCount, beamOffset, beamCount (element indices), 2 reserved words, 32 f32 telemetry (zeros in P1; all 32 slots assigned in P2, see Vehicle telemetry). Nodes f32 xyz × nodeTotal. Strains (only with header flag bit0) f32 × beamTotal = signed force/breakF in [-1, 1], tension positive, NaN broken.
- **events.ts**: impact{objectId, materialId, pos, normal, impulse} cap 256; beamBreak{objectId, beamIndex (OBJECT-LOCAL), pos} cap 256; skid{objectId, materialId, pos, slip m/s, load N} cap 512. Discovery order; drops beyond capacity counted in per-kind header overflow. Events accumulate across skipped snapshots.
- **codec.ts**: `SnapshotWriter` / `SnapshotReader` (views created on `attach`, everything else allocation-free; reader subarrays lazy + cached per attach), `checkSnapshot`, `SnapshotFormatError`, `BufferPool`.
- **Buffer pool**: 3 buffers allocated by the worker at init. Worker acquires one per snapshot, transfers it; if none is free it skips the snapshot (never blocks). Main keeps ≤ 2 (previous + current for interpolation) and returns the older via `returnBuffer` as soon as a newer one arrives.

## ActionState — FROZEN (P1)

`throttle`=0 (0..1), `brake`=1 (0..1), `steer`=2 (-1 left..1 right), `handbrake`=3 (0..1), `clutch`=4 (0 engaged..1 disengaged), `gearSelect`=5 (integer: -1 R, 0 N, 1..n). Indices (`Action`) address the worker's per-object Float64Array and the replay input log.

## MaterialId — FROZEN (P1)

0 asphalt, 1 grass, 2 dirt, 3 rock, 4 gravel, 5 concrete, 6 metal. Defined in `src/protocol/messages.ts`, re-exported by `src/sim/types.ts`. Contact μ = node friction × material friction.

## HeightSampler — FROZEN (P1)

`src/sim/types.ts`: `heightAt(x,z)`, `normalAt(x,z,out: Float64Array)` (unit, C0-continuous smoothed, writes out[0..2]), `materialAt(x,z)`. Deterministic, allocation-free. Plane in P1, heightfield in P3.

## RigDef / CompiledRig — FROZEN (P1)

`src/sim/rig/types.ts`. RigDef is plain JSON: `name`, `nodes[{id, pos, mass, friction?, radius?, group?, collidable?}]` (**mass ≤ 0 = pinned**, invMass 0), `beams[{a, b, type: normal|bounded|support|hydro|shock, k?, d?, deform?, breakF?, boundsLow?, boundsHigh?, preload?, hydroTravel?}]`, `groupDefaults?`. Defaults in `RIG_DEFAULTS` (k 9e6, d 12e3, deform 4e5, breakF 1e6; deform/breakF ≤ 0 = never → Infinity when compiled). CompiledRig = resolved typed arrays in declaration order. `StabilityReport`, `RigStats` types live there too. Sim-side SoA arena (`SimState`), `SimObject`, `EventSink`, `BeamType` and kernel signatures are frozen in `src/sim/types.ts` (worker-internal).

## Canonical ordering — FROZEN (P1)

Nodes and beams in RigDef declaration order everywhere (arena, snapshots, GPU bindings; never sorted/compacted, broken beams stay with active 0). Objects by ascending objectId (stepping, arena allocation, snapshots). Fixed per-step phase order: commands → per object: beams → ground contacts → other forces → integrate (P2 amendment: vehicle pre-step and steering hydros run before beams, see VehicleDef). Events in discovery order. Cross-object contact pairs sorted (lower object id, then node index). Full text in `src/sim/types.ts`.

## Boundary amendment — FROZEN (P2)

Main-thread code MAY import `src/sim/vehicle/types.ts` (pure data + type-only refs to `SimState`, erased) and the pure vehicle builders `src/sim/vehicle/builder.ts` (`buildVehicleRig`, `compileVehicle`, `validateVehicle`, `VehicleCompileError`), `src/sim/vehicle/wheelrig.ts` (`buildWheelRig`) and vehicle data files (e.g. `src/sim/vehicle/sedan.ts`). Same purity rules as the P1 rig modules. Worker-runtime vehicle modules (`wheels.ts`, `drivetrain.ts`) are worker-only. `src/protocol` may `import type` from `src/sim/vehicle/types.ts`.

## VehicleDef / CompiledVehicle — FROZEN (P2)

`src/sim/vehicle/types.ts` (full spec in its doc comments).
- **Vehicle frame** (rig-local): up +Y, **forward −Z**, right +X. Wheel ω > 0 = rolling forward (spin axis = vehicle left). steer +1 = right.
- **VehicleDef** (plain JSON): `name`, `body: RigDef`, `wheels: WheelDef[]`, `drivetrain: DrivetrainDef`, `brakes{frontBias, handbrakeTorqueMax}`, `aero{dragCoeffArea, liftCoeffArea}`, `steering{maxWheelAngleDeg}`, `frame{origin, front, top}` (body node ids).
- **WheelDef**: `id`, `hubInner`/`hubOuter` (positions; hubs are ALWAYS generated; outer = outboard), `axle: front|rear`, `radius`, `rimRadius`, `width`, `rays` (even, 10–14), `tireRingSpring/Damp`, `rimSpring/Damp`, `sidewallSpring/Damp`, `hubMass/rimMass/tireMass` (wheel totals), `friction` (≈2.0), `steered`, `driven`, `braked`, `brakeTorqueMax`, `handbrake`, `attach: string[]` (body node ids; emits hubI–id, hubO–id per id), optional `tireNodeRadius`, `attachSpring/Damp/BreakF` (`WHEEL_DEFAULTS`).
- **Wheel node ids**: `${id}.hubI`, `${id}.hubO`, `${id}.rimI{k}`, `${id}.rimO{k}`, `${id}.tireI{k}`, `${id}.tireO{k}`, k = 0..rays−1 (`wheelNodeId()`). Body beams may reference them (suspension arms to hubs, steering hydros to knuckles).
- **Canonical merged order**: nodes = body nodes, then per wheel (declaration order) hubI, hubO, rimI[0..n), rimO[0..n), tireI[0..n), tireO[0..n) (2+4n). Beams = body beams, then per wheel: attach beams, axle hubI–hubO, then 22 beams per ray (8 rim, 4 tread, 8 sidewall, 2 X-brace) in the order documented at `WHEEL_BEAMS_PER_RAY`. **Amended (P2 handling):** every rim/tread quad is X-braced with two half-stiffness diagonals (`rimI{k}–rimO{k1}½ … rimO{k}–rimI{k1}½`, same for the tread); one-way diagonals made each wheel chiral, and since left/right rings are parameterized in opposite rotational senses both wheels of an axle crabbed the same way under torque (the sedan spun out on a straight launch). 4-wheel cars declare wheels FL, FR, RL, RR.
- **Steering**: every `hydro` beam in `body` is a steering hydro driven by the `steer` action (P1 engine hydro pass, unchanged).
- **DrivetrainDef**: `torqueCurve [rpm, Nm][]` (→ LUT, `TORQUE_LUT_STEP_RPM` 50, lerp), `idleRpm`, `redlineRpm`, `revLimitRpm`, `engineInertia`, `engineBrakeTorque`, `gearRatios` (forward), `reverseRatio` (magnitude), `finalDrive`, `shiftTimeS`, `autoShiftUpRpm`, `autoShiftDownRpm`, `diff open|locked|limited` (one diff across all driven wheels), `diffLockTorque?`, `clutchMaxTorque`, `transmission? auto|manual`.
- **Brakes**: per wheel `brakeTorqueMax · bias_axle / max(frontBias, 1−frontBias)`; handbrake `handbrake·handbrakeTorqueMax`; wheel gets the max.
- **CompiledVehicle**: merged `CompiledRig` (after MINIMASS at ω·dt 0.35), `bodyNodeCount/bodyBeamCount`, `CompiledWheel[]` (rig-local node/beam ranges, `spinSign`, `corner`, `tireRingRadius`, `hubLinkBeams`, biased brake torques), `CompiledDrivetrain` (`torqueLut`, `gearRatioTable` indexed gear+1 = [−rev, 0, r1..rn], `drivenWheels`), `frameNodes`, `totalMass`, `massDriftPct`. Builder signatures: `BuildWheelRig`, `BuildVehicleRig`, `CompileVehicle`, `ValidateVehicle` (beam budget 3500 player / 1500 traffic).
- **Per-tick order (amends canonical rule 3)**, per object ascending: vehicle pre-step [estimate ω all wheels → `stepDrivetrain` → `applyWheelTorques` per wheel → parking clamp → aero] → steering hydros → beams → ground → integrate. Positions are unchanged between pre-step and ground pass, so ground normal force evaluated in the pre-step (`groundNormalForce`, an additive export of `collision/ground.ts` with identical math) equals this tick's contact force.
- **ω estimate** (amended P2): INERTIA-WEIGHTED over the rim AND tyre rings, `ω = Σ m_i (v_i − v_hubMid)·(s × ρ_i) / Σ m_i |ρ_i|²` (= L_axle / I_axle), ρ = radial offset from the axle. A rim-only estimate is non-collocated with the tyre-ring torque and pumped the rim–tyre torsional mode under the brake ramp. **Slip ratio** (`WheelRuntime.slipRatio`) uses the effective rolling radius `WheelRuntime.rollRadius` = load-weighted axle → in-contact tyre-node-centre distance along the ground normal (unloaded radius when airborne); the unloaded radius read +0.09 on a free-rolling wheel.
- **Torque law**: τ = drive + brake about s; each of the N = 2·rays tire nodes gets `τ/(N·r)·t̂_i` (r = `tireRingRadius`); hubI and hubO each get `−ΣF/2` (zero net force). Brake: `−brakeTorque·clamp(ω/1 rad/s, −1, 1)` (low-speed ramp, no chatter). No body reaction couple in P2. Detached wheel (all `hubLinkBeams` broken): drive torque 0.
- **Parking clamp** (amended P2): engaged when the horizontal COM speed < 0.3 m/s and brake/handbrake ≥ 0.1 on a wheel that has that brake. Per engaged wheel: (1) **brake-pad hold** — a stiction spring on the wheel angle accumulated since engagement, `τ = −0.02·(I/dt²)·θ`, with service + hold torque capped at the wheel's available brake torque (θ re-based at the cap: slips, no wind-up); (2) per in-contact tyre node, the viscous term `0.25·m/dt·v_t` plus a **contact anchor** spring `0.05·m/dt²` toward the touchdown point, together capped at `μN·(1 − tanhR(|v_t|/0.3))` (anchor dragged at the cap, re-armed if > 5 cm away). Capped forces/torques only, never a position constraint.

## Vehicle messages — FROZEN (P2, additive to protocol)

`spawnVehicle{objectId, vehicle: VehicleDef, transform, transmission?}` (worker compiles; snapshot ranges = merged canonical order), `setTransmission{objectId, mode: auto|manual}`, `recover{objectId, pos?}` (current deformed shape rigidly set upright, heading kept, velocities zeroed, damage kept; `reset` stays the full repair). **gearSelect**: auto mode −1 R, 0 N, ≥1 Drive (worker picks 1..n); manual mode = exact gear. Until implemented the worker answers `error` (unknown command).

## Vehicle telemetry — FROZEN (P2)

`src/protocol/telemetry.ts` (`VehicleTelemetry` = P1 `Telemetry` 0..25 + 26..31; no spares remain). 0 speed m/s (COM·forward, signed), 1 rpm, 2 gear, 3–7 applied throttle/brake/steer/clutch/handbrake, 8–11 wheel slip m/s (mean tangential ground velocity of in-contact tyre nodes), 12–15 wheel load N, 16–18 COM, 19–21 COM velocity, 22 engine torque N·m, 23 **damage 0..1** (fraction of beams broken or plastically deformed; replaces the P1 "plastic work J" placeholder meaning), 24 airborne, 25 wheelsDetached bitmask, **26–29 wheel ω rad/s**, **30 drive torque N·m (total at driven wheels)**, **31 wheelContact bitmask**. Corner order FL, FR, RL, RR (bit 1,2,4,8) from `CompiledWheel.corner`. Slip ratio has no slot: `estimateSlipRatio(ω, radius, speed)`. `readVehicleTelemetry()` decodes allocation-free.

## Input actions — FROZEN (P2)

`src/input/actions.ts`: pure `createInputMapper({tuning?, transmission?, gearCount?})` → `handleKeyEvent({type, code, repeat})`, `setGamepad(GamepadLike|null)` (per frame), `update(dtS, speedMs) → ActionState` (reused object), `drainCommands() → InputCommand[]`, `setTransmission`, `setGearCount`, `releaseAll`. Commands: `shiftUp shiftDown recover repair cameraCycle toggleBeamView pause slowMo`. Bindings: WASD/arrows, Space handbrake, Shift/E up, Ctrl/Q down, R F C B P T; gamepad standard mapping RT/LT pedals, left-stick X steer, A handbrake, RB/LB shift, Y recover, X camera, Back beam view, Start pause, D-pad up repair / down slow-mo. Steering: `limit(v) = max(0.25, 1/(1+(v/20)²))`, outward slew `rate/(1+v/15)` (keyboard 2.5/s, gamepad 6/s), return 4/s; stick deadzone 0.12 + exponent 1.6. Auto mode arcade reverse (brake at standstill → R, pedals swapped). Defaults in `DEFAULT_INPUT_TUNING`.

## TerrainData — pending (freezes end of P3)

`src/render/terrain/data.ts` pure function output (heights f32, splat u8, spacing/origin) — shared by sim collision and render mesh.

## BindingSet — pending (freezes end of P4)

Flexbody vertex→node-triad binding format produced by the binder, consumed by flexskin.

## ReplayFile — pending (freezes end of P7)

Tick-indexed input log + keyframes + build hash (refuse cross-build playback).
