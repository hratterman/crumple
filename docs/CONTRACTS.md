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
  - Main→worker: `init{seed, gravity, snapshotHz (default 120), debugStrains, capacity?}`, `ground{mode:'plane', y, materialId}` (`mode:'heightfield'` superseded by P3 `groundHeightfield`, see Terrain protocol), `spawn{objectId, rig: RigDef, transform{pos, quat[x,y,z,w]}}`, `despawn`, `input{objectId, actions: Partial<ActionState>}` (merge), `reset{objectId, transform}` (full repair), `timescale{value}`, `returnBuffer{buffer}` (transferred). Reserved: `setBubble`, `keyframeRequest`, `replaySeek`.
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

Nodes and beams in RigDef declaration order everywhere (arena, snapshots, GPU bindings; never sorted/compacted, broken beams stay with active 0). Objects by ascending objectId (stepping, arena allocation, snapshots). Fixed per-step phase order: commands → per object: beams → ground contacts → other forces → integrate (P2 amendment: vehicle pre-step and steering hydros run before beams, see VehicleDef; P4 amendment: static-collider contacts run after ground contacts, as the last force pass). Events in discovery order. Cross-object contact pairs sorted (lower object id, then node index). Full text in `src/sim/types.ts`.

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

## P2 handling amendments (additive; handling harness `src/sim/vehicle/handling.ts`)

Measured by `src/sim/vehicle/handling.test.ts` (`node tools/handling-report.mjs` prints the table).

- **Ground friction law** (`collision/ground.ts`): implicit (backward-Euler) Coulomb. The ground pass is the last force pass before integration; per node, `F_req = −(m·v_t/dt + F_t)` (F_t = tangential part of the accumulated force + m·g) is applied clamped to the cone `μ·N`. Inside the cone the node sticks, outside it slides along F_req. The P1 `μ·tanh(v/0.3)` with a `0.5·m/dt·|v_t|` cap needed ~4 m/s of sliding to carry 2 kN on a tread node (the launch wheelspin). `ApplyGroundContacts` takes optional trailing `gx, gy, gz` (gravity, for the tangential part of m·g); the engine passes them.
- **Soft-layer contact** (`RigNodeDef.contactSpring?` N/m, `RigGroupDefaults.contactSpring`, `CompiledRig.nodeContactK`, `SimState.contactK`): > 0 selects penalty stiffness `min(contactSpring, 0.2·m/dt²)`, with damping `2·0.08·sqrt(k·m)·min(1, depth/radius)` (zero at touchdown). 0 keeps the rigid-contact law. `groundNormalForce` reproduces both laws.
- **Tread nodes** (`RigNodeDef.tread?`, `RIG_NODE_FLAG_TREAD` = `NODE_FLAG_TREAD` = 1<<2; `SimState.treadAxX/Y/Z`, `treadF`): the ground stick's cone on a tread node is `sqrt((μN)² − treadF²)`. The vehicle's lateral tread brush writes `treadF` (its force on the node) every tick, before the ground pass.
- **WheelDef** (optional): `tireContactSpring` (tread nodes' contactSpring), `rollingResistance` (C_rr; torque `−C_rr·load·rollRadius·clamp(ω/ROLL_RES_OMEGA_EPS)`, `ROLL_RES_OMEGA_EPS` = 0.1 rad/s so it is Coulomb-like for a parked car), `treadBrushStiffness` / `treadBrushDamping` (> 0 marks the tyre nodes `tread` and enables the brush), `rimHoopTension` / `treadHoopTension` (0..1, hoop tension below). `WHEEL_DEFAULTS` are all 0 (P1 behaviour). `WHEEL_TUNING_205_55R16` uses them (see its doc: C_rr 0.008, rim hoop 1, tread hoop 0.5, tireMass 9.4, μ 1.1). `CompiledWheel` adds `rollingResistance`, `brushK`, `brushC`, `rimHoop` / `treadHoop` (fraction ÷ 2·sin(π/rays)) and `attachNodes` (rig-local attach node indices). `WheelRuntime` adds `rollRadius`, `treadLoad`, `treadNormal`, `treadBrush` and `attachNodes` (global).
- **Tread brush** (`wheels.ts applyTreadBrush`, lateral only), per in-contact tread node:
  - `u = v_hub·â` (â = axle in the ground plane), `δ += u·dt` (reset off-ground), `F = −k·δ − c·u`.
  - F is capped at `μN·(|u|+0.5)/(|(u, u_x)|+0.5)`, the lateral share of the rigid-wheel slip velocity (combined slip); `u_x = max(0, |slipRatio| − 0.12)·|v|` (a locked or spinning wheel; normal drive/brake slip keeps the full lateral share).
  - The contact wrench goes on the rigid wheel: net force half to each hub; the overturning moment as a lateral force pair between `attachNodes` (upright top) and the hubs (the ball-joint path); the aligning moment as a hub couple.
  - Each tread node also gets a lateral damper `0.1·m/dt` relative to the hub.
  - Why: node stick through the carcass gave ~130 N/deg cornering stiffness, capped by the ω·dt budget.
- **Vehicle MINIMASS**: tread nodes (group `wheelTire`) are raised only to `TREAD_OMEGA_DT_LIMIT` = 0.49; everything else stays at 0.35. `validateVehicle.stability` judges per group.
- **Rolling radius / slip ratio**: `WheelRuntime.rollRadius` = mean chord between consecutive in-contact tread nodes × rays / 2π (whole-ring perimeter / 2π when there is no contact pair), low-passed with τ = 50 ms. `slipRatio = (ω·rollRadius − v_x)/max(|v_x|, 0.5)`; the unloaded radius read +0.09 when free rolling.
- **Traction control**: `DrivetrainDef.tractionControl?` (target driven-wheel slip ratio, 0 = off) → `CompiledDrivetrain.tcSlip`. Throttle is cut by `0.5`/(m/s) of excess of the fastest driven wheel over the undriven wheels' mean × (1 + tcSlip). The denominator is floored at 5 m/s, there is no cut below 2.5 × idle rpm (the clutch slips instead), and attack/release are 20/150 ms.
- **Hoop tension** (`wheels.ts applyHoopTension`): each rim / tread ring segment gets tension `T = f·m·ω̂²·r/(2·sin(π/rays))` (m = mean endpoint mass, r = rimRadius / tireRingRadius, ω̂ = min(|ω|, `HOOP_OMEGA_MAX` = 220 rad/s)), whose resultant on the regular polygon is `f·m·ω²·r` toward the axle. Internal forces only (no net wheel force or torque; a flat contact patch gets none). Why: the budget-limited spokes and sidewalls let the rim balloon ~7 cm and the tread ~5 cm at 200 km/h (car 7.5 cm higher), and above ~205 km/h the tread fell into a standing-wave state (rolling radius −10 %, free fronts −4 % → +5 % slip) that drove a ±0.1 rad/s yaw limit cycle. Its geometric stiffness adds `√f·ω̂/(√2·sin(π/rays))·dt` to ω·dt in quadrature (sedan at the cap: tread 0.451 → 0.498, rim 0.347 → 0.459; wheels.test.ts).
- **Per-tick vehicle pre-step** (amends the order above): estimate ω, then `stepDrivetrain`, then per wheel `applyWheelTorques` (+ rolling resistance), `applyTreadBrush` and `applyHoopTension`, then the parking clamp (its node anchor/viscous part is skipped on brush wheels; the pad hold remains), then aero.
- **Sedan chassis** (`defs/sedan.ts`, not a contract but the harness reference): per axle the lower-arm pivots and the tie-rod / toe-link pivot of both sides form a rigid subframe of fixed `K_SUBFRAME` beams (pivot masses fixed outside the CG solve, sized for the beams); the link pivots sit `LINK_REACH` = 0.35 m fore/aft of the hub; rear hub links ×2 (`REAR_LINK_FACTOR`). Engine 350 N·m flat 3500–6500 rpm (238 kW), auto upshift 6900 rpm, TC 0.14.
- **Top-speed check** (`handling.ts runTopSpeed`): full throttle at 200 / 210 km/h held in the gear with the most wheel force (manual box) must accelerate, plus a 10 s full-throttle straight from 195 km/h (must pass 200 km/h without weave). A full run from rest is > 60 s of sim.

## Vehicle messages — FROZEN (P2, additive to protocol)

`spawnVehicle{objectId, vehicle: VehicleDef, transform, transmission?}` (worker compiles; snapshot ranges = merged canonical order), `setTransmission{objectId, mode: auto|manual}`, `recover{objectId, pos?}` (current deformed shape rigidly set upright, heading kept, velocities zeroed, damage kept; `reset` stays the full repair). **gearSelect**: auto mode −1 R, 0 N, ≥1 Drive (worker picks 1..n); manual mode = exact gear. Until implemented the worker answers `error` (unknown command).

## Vehicle telemetry — FROZEN (P2)

`src/protocol/telemetry.ts` (`VehicleTelemetry` = P1 `Telemetry` 0..25 + 26..31; no spares remain). 0 speed m/s (COM·forward, signed), 1 rpm, 2 gear, 3–7 applied throttle/brake/steer/clutch/handbrake, 8–11 wheel slip m/s (mean tangential ground velocity of in-contact tyre nodes), 12–15 wheel load N, 16–18 COM, 19–21 COM velocity, 22 engine torque N·m, 23 **damage 0..1** (fraction of beams broken or plastically deformed; replaces the P1 "plastic work J" placeholder meaning), 24 airborne, 25 wheelsDetached bitmask, **26–29 wheel ω rad/s**, **30 drive torque N·m (total at driven wheels)**, **31 wheelContact bitmask**. Corner order FL, FR, RL, RR (bit 1,2,4,8) from `CompiledWheel.corner`. Slip ratio has no slot: `estimateSlipRatio(ω, radius, speed)`. `readVehicleTelemetry()` decodes allocation-free.

## Input actions — FROZEN (P2)

`src/input/actions.ts`: pure `createInputMapper({tuning?, transmission?, gearCount?})` → `handleKeyEvent({type, code, repeat})`, `setGamepad(GamepadLike|null)` (per frame), `update(dtS, speedMs) → ActionState` (reused object), `drainCommands() → InputCommand[]`, `setTransmission`, `setGearCount`, `releaseAll`. Commands: `shiftUp shiftDown recover repair cameraCycle toggleBeamView pause slowMo`. Bindings: WASD/arrows, Space handbrake, Shift/E up, Ctrl/Q down, R F C B P T; gamepad standard mapping RT/LT pedals, left-stick X steer, A handbrake, RB/LB shift, Y recover, X camera, Back beam view, Start pause, D-pad up repair / down slow-mo. Steering: `limit(v) = max(0.25, 1/(1+(v/20)²))`, outward slew `rate/(1+v/15)` (keyboard 2.5/s, gamepad 6/s), return 4/s; stick deadzone 0.12 + exponent 1.6. Auto mode arcade reverse (brake at standstill → R, pedals swapped). Defaults in `DEFAULT_INPUT_TUNING`.

## Boundary amendment — FROZEN (P3)

`src/world/` is a new PURE shared layer (like `src/core`): no three, no DOM, no imports from `src/sim`, `src/render`, `src/ui`, `src/game`, `src/app`; it may import `src/core` and `import type` from `src/protocol`. Both `src/sim` (worker) and main-thread code may import any `src/world` module. `src/protocol` may `import type` from `src/world/types.ts`. This supersedes PLAN's `render/terrain/data.ts`: the generator lives in `src/world/terrain.ts` (sim may not import render).

## P3 work split (file ownership)

- **A** world generator: `src/world/terrain.ts` (`generateTerrain`, `hashTerrain`), `src/world/roads.ts` (`sampleRoad`, `projectToRoad`), tests. Owns layout validation (`WorldLayoutError`).
- **B** terrain render: `src/render/terrain/**` (`createTerrainRenderer`).
- **C** lighting/post/quality: `src/render/lighting.ts`, `src/render/post.ts`, `src/render/material.ts` (`patchMaterial`), `src/app/quality.ts`.
- **D** heightfield collision: `src/world/sampler.ts` (`createTerrainSampler`), worker/engine handling of `groundHeightfield` + `terrainReady`, `SimClient.groundHeightfield(layout, hash)`.
- **E** road ribbons: `src/render/roads/**` (`createRoadRenderer`).
- Shared contract files (`src/world/types.ts`, `src/world/layout.ts`, `src/render/types.ts`) change only via this doc.

## WorldLayout — FROZEN (P3)

`src/world/types.ts` (full rules in doc comments); the map itself is `DEFAULT_LAYOUT` in `src/world/layout.ts` (data, hand-designed control points, ASCII sketch in its header; `WORLD_LAYOUTS` registry by id).
- Coordinates: metres, Y up, map square of `size` centred on the origin, north = −Z. Yaw about +Y, 0 faces −Z (vehicle frame). Rotations in layout data are unit direction vectors, never angles.
- `WorldLayout{id, name, version, seed, size, terrain: TerrainParams, waterLevel, zones, pads, roads, junctions, spawnPoints, colliders (P5), props (P5)}`. Bump `version` on any change that alters generated terrain.
- **Zones** (`ZoneShape` circle/ellipse/rect/polygon + soft `blend` → smoothstep mask) apply in a fixed kind order: plains (fbm) → hills (fbm + lift) → mountains (MAX over `MountainPeak` bumps `height·(1−u²)²`, plus ridged detail scaled by mask × macro/peak) → lake (`waterLevel − depth·(1−r²)`, dry shore ≥ waterLevel + shoreLift in the blend band) → town/arena flatten. Then edge rise, `pads` (flatten, height null = mean), roads, clamp, paint.
- **Roads** `RoadDef{id, name, kind: highway|country|mountain|dirt|street|arena, closed, points: [x, y|null, z][], width, lanes (per direction), shoulder, bank? (max cross-slope), material, markings: highway|center|edge|none}`. y null = follow pre-road terrain (disc average). Centreline = `core/spline` centripetal Catmull-Rom. Per-kind tuning in `ROAD_KIND_DEFAULTS` (priority dirt < street < country < mountain < arena < highway, smoothRadius, maxGrade, bankFullRadius, blend, surface ribbon|splat). Carving: verge-level cross-section `y + bank·clamp(d, ±w/2)` out to the shoulder edge, smoothstep blend back to terrain; higher priority carves last. Bank sign: + = right side higher; κ + = turning right; right vector `(−tz, 0, tx)`.
- **Junctions** `{id, pos, roads[]}`: every listed road passes within 1 m of pos. Roads resolve by priority DESC; a road meeting a resolved one has its y eased to that road's surface over `JUNCTION_EASE_M` (40 m). Roads meet ONLY at junctions (overpass-free; A tests no other centreline approach).
- **Spawns**: on-road `{road: {id, s, d, reverse?}}` or free `{pos, yaw}`, resolved into `TerrainData.spawns`.
- P5 placeholders: `PadDef`, `PropPlacement`. (`ColliderDef` was a placeholder here; P4 replaced it, see "Static colliders". `version` also bumps on collider changes.)

## TerrainData — FROZEN (P3)

`src/world/types.ts`. `generateTerrain(layout): TerrainData` is PURE and deterministic (seeded `core/rng`/`core/noise` only; only `+ − × ÷ sqrt floor abs min max` and simplex-noise; fixed iteration order) and validates the layout.
- Grid: sample (col, row) at `x = originX + col·spacing`, `z = originZ + row·spacing`; row-major `row·cols + col`; `cols = rows = size/spacing + 1`. Default 1408 m @ 1 m → 1409² ≈ 1.99 M samples, 22 × 22 chunks of `TERRAIN_CHUNK_CELLS` = 64.
- `heights` Float32Array (7.9 MB); `splat` Uint8Array ×4 (7.9 MB): **R paved, G dirt, B rock, A gravel, grass = 255 − (R+G+B+A)** (sum ≤ 255 guaranteed: 5 sets in one RGBA8 texture, exact partition of unity under filtering; concrete = paved set tinted via the material map); `material` Uint8Array MaterialId per sample (2 MB, nearest lookup). ≈ 18 MB per side.
- Also `layoutId, layoutVersion, seed, minHeight, maxHeight, waterLevel`, `roads: RoadProfile[]` (layout order) and `spawns: ResolvedSpawn[]`, `hash` = `hashTerrain()` (FNV-1a 32 word-wise over dims, heights, material, splat, road stations).
- **RoadProfile** = resolved road: stations every `ROAD_STATION_SPACING` 2 m, `ROAD_STATION_STRIDE` 7 f64 `[x, y, z, tx, tz, bank, curvature]` (`RoadStation` offsets), `length`, `stationCount`, width/lanes/shoulder/material/markings/surface. Ribbons, AI and spawns consume profiles, never re-derive from RoadDef. Helpers `sampleRoad(profile, s, out)` (linear between stations, wraps closed) and `projectToRoad(profile, x, z, out, hintS?)` → `{s, d, dist, y}`; allocation-free.
- **TerrainSampler** (`createTerrainSampler(terrain)`, `src/world/sampler.ts`) is structurally identical to sim's FROZEN `HeightSampler` plus `splatAt`/`contains`: bilinear `heightAt`; `normalAt` = bilinear blend of central-difference vertex normals, renormalized (C0-continuous); `materialAt` nearest; edge-clamped outside the grid; allocation-free, sim numerics. The same object drives collision, cameras and ribbon conforming.

## Terrain protocol — FROZEN (P3, additive to protocol)

- Main→worker `groundHeightfield{layout: WorldLayout, terrainHash}`: the worker regenerates terrain itself (KB of JSON instead of 18 MB of arrays; collision == visual by construction), compares `hashTerrain` with `terrainHash` (0 = skip), installs its own terrain either way, and answers worker→main `terrainReady{layoutId, terrainHash, matched, generateMs}`; a mismatch also posts `error`. Send before spawning (spawns queued behind it apply after). The P1 `ground{mode:'plane'}` is unchanged; the reserved `ground{mode:'heightfield'}` variant stays `unimplemented` (superseded).
- **Game boot (P3, `src/main.ts`):** `groundHeightfield` is the worker's FIRST ground command (never a plane first: switching ground types de-inlines the sampler). Main sends `terrainHash` 0 so the worker's generation overlaps main's (main's render copy is generated in a helper worker, `src/app/terrainWorker.ts`, arrays transferred), then compares `terrainReady.terrainHash` with its own hash and logs an error on mismatch. Vehicles spawn only after `terrainReady`.

## Render API — FROZEN (P3)

`src/render/types.ts` (full spec in doc comments).
- `RenderContext{renderer, scene, camera, quality: QualityPreset, width, height, sampler}`. Renderer: no MSAA, sRGB output, `NoToneMapping`, shadows on.
- Frame order: sim/vehicles → camera → `lighting.update(camera)` → terrain/roads `update(camera)` → `quality.frame(dt)` → `post.render(dt)` (the only draw).
- `QualityPreset` (`QUALITY_PRESETS` low/medium/high/ultra, default high): `pixelRatioCap, shadowMapSize, csmCascades, csmFar, aoEnabled, aoSamples, bloom, smaa, terrainLodBias, vegetationDensity (P5), particleBudget (P5), adaptiveResolution{enabled, targetFps, minScale}`. `createQualityController(ctx, {lighting, post, others})` owns `ctx.quality` and adaptive scale.
- `createLightingStack(ctx, opts) → Promise<{sun, sunDirection, csm, environment, update(camera), setQuality, dispose}>`: kiara_1_dawn HDRI via PMREM, matched sun, CSM (`sun` is a descriptor, not in the scene, while CSM is active).
- `createPostStack(ctx) → {composer, render(dt), setSize, setQuality, setDepthOfField? (P7), dispose}`: RenderPass → N8AOPostPass (`gammaCorrection` false) → EffectPass(SMAA, Bloom, [DoF], ACES), HalfFloat buffers.
- `createTerrainRenderer(ctx, terrain, materials, {lighting, patchMaterial}) → {object, update(camera), setQuality, stats, dispose}`: 64-cell chunks, LOD every 2^k sample at `TERRAIN_LOD_DISTANCES` × lodBias, skirts, splat texture + `TERRAIN_TILE_M`, triplanar rock/steep, CSM receiver.
- `createRoadRenderer(ctx, terrain, sampler, materials, {lighting, patchMaterial}) → {object, update, setQuality, dispose}`: ribbons from `RoadProfile`s with surface 'ribbon', vertices on the carved terrain + `RIBBON_LIFT_M` 0.03 (+ polygonOffset), UV = (lateral d m, arc s m) with procedural markings; dirt trails are splat only.

## patchMaterial — FROZEN (P3)

`patchMaterial(material, {csm?, flexbody?, damage?}) → {color, depth, distance}`; assign `mesh.material`, `mesh.customDepthMaterial`, `mesh.customDistanceMaterial`. **Order (`PATCH_ORDER`): CSM first, then flexbody, then damage.** CSM: `csm.setupMaterial(color)` runs first because it overwrites `onBeforeCompile`; patchMaterial captures that hook and composes `prior hook → features in order`; CSM never touches depth/distance. Flexbody (P4 `ShaderPatch`) applies to color AND depth (RGBADepthPacking) AND distance, so shadows deform with the body. Damage (P4) applies to color after flexbody. `customProgramCacheKey` = prior key + feature keys in order; patching the same material twice throws. Every shadow-receiving lit material (terrain, roads, vehicles, props) must be patched with `csm`.

## P4 contracts — flexbody vehicle, damage, static colliders

Contract files (change only via this doc): `src/render/vehicle/types.ts` (visual defs, BindingSet, node texture, skin/material/wheel/damage/assembly signatures; full spec in its doc comments), `src/sim/collision/types.ts` (compiled colliders, broadphase, `ApplyColliderContacts`), `src/world/types.ts` (`ColliderDef`), `src/world/layout.ts` (arena colliders), `src/protocol/*` (additions below).

### VehicleVisualDef / PanelDef (pure data per vehicle)
- `VehicleVisualDef{vehicle (= VehicleDef.name), panels: PanelDef[], paint: PaintDef, wheels: WheelVisualDef, plate?}`.
- `PanelDef{id, kind: body|hood|trunk|door|fender|bumper|roof|glass|light|trim|interior|grille|mirror, material: MaterialSlot, surface: SurfaceSpec, bind: NodeSelector, detach: DetachSpec|null, glass?: GlassSpec, lights?, damageWeight?, castShadow?}`.
- **Surface schema** (what A1 emits): `LoftSurface{type:'loft', sections: Vec3[][] (rig-local rest, equal point counts), closedU?, resolution (max edge m), window?{u0,u1,v0,v1} on the arc-normalized master, inset? (shut line, default 2 mm per side), thickness?, flip?, mirrorX?}` — centripetal Catmull-Rom (`core/spline`) along each section (u) and across sections (v, the rail family); panels are windows cut from shared master lofts so shut lines match. `MeshSurface{type:'mesh', position, index, normal?, uv?}` for small explicit parts. UVs are arc length in metres. `tessellateVehicle(def) → PanelGeometry[]` (rest space, outward normals, separate vertices per panel, bit-equal duplicate positions at seams).
- **Selectors**: `NodeSelector` = node ids or `*` globs against `CompiledRig.nodeIds`; `BeamSelector` = `{pairs}` | `{between: [A, B]}` (node ids, never beam indices: sim retuning shifts indices). A selector matching nothing is a `BindError`.
- **Panels bind only to their own nodes** (`bind`); a panel never spans a joint that can tear.
- **DetachSpec** `{attach: 'boundary' | BeamSelector, minBrokenFraction, mode: 'follow'|'hide'}`. `'boundary'` = every beam with exactly one endpoint in the bind set, minus `support` beams and never-breaking beams. Detached ⇔ broken fraction ≥ minBrokenFraction (snapshot bitset), sticky until the repair epoch changes. `follow`: the panel's nodes are a physical sub-rig and it keeps skinning to them (hood, bumpers); `hide`: hidden + debris FX (mirrors/trim).
- **GlassSpec** `{laminated, beams, crackStrain, shatterStrain, crackImpulse, shatterImpulse, shatterBrokenFraction}`: crack by strain (max |L/L0−1| over `beams`) or impulse; shatter by strain, impulse or broken fraction; laminated (windscreen) never disappears, tempered panes hide + particle burst.
- `PaintDef{color sRGB hex, metallic, roughness, clearcoat, clearcoatRoughness, flake{density, scale, intensity}|null, pearl?}`; `WheelVisualDef{rim{style, spokes, spokeWidth, dish, lip, finish, boltCount}, tire{tread, sidewallText|null, bulge}, brake{discRadius, caliperColor}, rear?}`.

### Sedan rig additions for P4 (A5 implements in `src/sim/vehicle/defs/sedan.ts`; A1 binds to these ids)
- **Hood sub-rig** (physical, so it buckles, pops its latch and can tear off): 12 body nodes `hood_{r}{s}`, r = 0..3 front → rear, s ∈ {L, C, R}, group `hood`, ≈ 1 kg each (12 kg total, taken from the structure mass solve so the car stays 1450 kg). Rest positions: x = −0.6 / 0 / +0.6; z_r = [−2.00, −1.64, −1.28, −0.92]; y_r = [0.72, 0.84, 0.92, 0.96] at L/R and +0.02 at C (crown; clears the shock towers by ≥ 4 cm). Beams: in-plane grid + X-braced quads (yield like the bumper class so it creases); **hinges** `hood_3L–s5_cw_L`, `hood_3L–s4_fd_L` (mirror R) — high break; **latch** `hood_0C–s2_rt` (+ `hood_0L/R–s2_fd_L/R`) — breaks in ≳ 40 km/h frontals; `support` (compression-only) rests from rows 1–2 L/R to the `s2..s4_fd` fender tops and `hood_1C–s2_rt`. Appended after all existing body nodes/beams (structure indices unchanged).
- **Bumpers** need no new nodes: station 0 (`s0_*`) and station 13 (`s13_*`) are rigid bulkheads whose only links are to stations 1 / 12, so `bind: ['s0_*']`, `detach: {attach: 'boundary', minBrokenFraction: 1, mode: 'follow'}` tears the bumper off physically.
- Doors, fenders, roof, trunk lid, quarters skin to the existing cage/bay nodes (`detach: null` in P4). Glass panes skin to their frame nodes (`s5_cw*`, `s6..s8_bt*`, `s6..s8_rf*`, `s9_dk*`); their `beams` are the sedan's `glass`-class links (`bt–rf`, `cw–rf`, `rf–dk` across consecutive stations, excluding same-side pillars — use `{pairs}`).
- The handling harness must stay green with the additions (A5).

### BindingSet — pending FREEZE (end of P4)
`bindPanels(compiled, def, geoms) → BindingSet{vehicle, nodeCount, rigHash, panels: BindingPanel[], stats}` (A2, pure, deterministic). Per panel, per vertex: `restPosition`, `restNormal`, `restTangent|null`, `uv`, `index`, **`triad` Uint16 (iR, iX, iY object-local)**, **`coef` Float32 (a, b, c, d0)**, `frameNormal` (rest normal in the triad's rest Gram–Schmidt frame), `frameTangent|null`, `damageWeight` (the damage attribute slot); plus `nodes`, `bindNodes`, rest bounds, resolved `detach.attachBeams` / `glass.beams` (object-local beam indices), `lights`, `castShadow`.
- **Reconstruction (shader == `evalFlexVertex` CPU mirror):** `e1 = X−R, e2 = Y−R, n̂ = cross(e1,e2)/max(|cross|, 1e-4 m²)` (only the cross product is normalized), `P = R + a·e1 + b·e2 + c·n̂`; clamp: `if !(|P−R| ≤ 2·d0 + 0.15 m) P = R` (also catches NaN; collapsed vertices degenerate their triangles). Normals/tangents: GS frame `f1 = e1/|e1|, f2 = normalize(e2 − (e2·f1)f1), f3 = f1×f2`, `N = normalize(F·frameNormal)`.
- **Degeneracy:** accept a triad iff angle ∈ [25°, 155°], edges ∈ [0.04, 1.6] m, edge ratio ≤ 6, |c| ≤ 0.3 m, |a|,|b| ≤ 3; score `|c| + 0.5|P−R| + 0.2·max(0,|a|+|b|−1)`, ties lexicographic. Repair = widen the candidate set 8 → 16 → whole bind set, else `BindError` (never bind outside the panel's set).
- **Seams:** bit-equal rest positions within a panel (quantum 1e-5 m) share one triad + coefficients; panels never share vertices.
- **Node texture** (one per vehicle, A2): RGBA32F, width 64, Nearest, height 2·rows (rows = ⌈nodeCount/64⌉), texel of node i = (i & 63, i >> 6 [+ rows for block B]), `texelFetch` only. Block A = skin-space xyz (world − anchor, anchor = frame-origin node) + w = flags (`NODE_TEX_FLAG_BROKEN` 1 = a beam at this node is broken, `NODE_TEX_FLAG_DETACHED` 2); block B = (strain, scuff, glass crack, 0). Written every frame from `SimClient.interpolate` (A block by the skin, B block by damage), one upload per frame.
- **Shader patch** (`flexbody`, key `flex1`, color + depth + distance via `patchMaterial`, order CSM → flexbody → damage): attributes `flexTriad` (float vec3, exact integers), `flexCoef` vec4, `flexNormal`, `flexTangent` (USE_TANGENT), `flexDamage`; uniforms `uFlexNodes`, `uFlexRows`; color target exports `vFlexRest` (rest position, for non-swimming noise) and `vFlexDamage` (triad-blended block B × damageWeight, w = broken edge) under `#define FLEXBODY`. Per-panel bounding spheres are recomputed from the panel's nodes every frame (culling + shadows correct for flying panels).
- **Wheels** are not panels: rigid frame from hubs + rim phase, tyre radial squash interpolated between tyre-ring rays (never per-node triads: a 12-ray ring would facet), as a `flexbody`-slot patch with key `wheel1` so shadows deform too.

### Damage data flow (main-side; one additive protocol section)
- **Broken state:** new always-present snapshot section, a **broken-beam bitset** (bit g = global snapshot beam g broken), authoritative for node BROKEN flags, panel detach and glass broken fractions. WHY a section rather than events alone: the beamBreak ring holds 256 per snapshot (a big crash or glass shatter can overflow it), and P7 replay seeks restore states for which no events exist. Cost ⌈beamCapacity/32⌉ words (16 KB at default capacity), packed from `active` while writing the snapshot.
- **Repair epoch** per object (`OBJ_REPAIR_EPOCH`, the former reserved word 6): +1 per `reset`; a change clears all damage visuals (in-flight pre-repair snapshots cannot re-damage the body).
- **beamBreak events** → immediate FX + early detach/shatter check (bitset confirms). **impact** → scuff deposit (falloff over 0.35 m, full at 300 N·s) and glass crack/shatter by impulse. **skid** away from tyre nodes → light scrape scuff.
- **Plastic strain: derived on main, no protocol change.** Per snapshot: `e_b = |L/L0 − 1|` for every intact body beam (L0 = `CompiledRig.beamRestLen`), node strain = max over incident beams, min over the last 3 snapshots (drops elastic transients < ~25 ms), ratcheted through a 1 % deadzone to full at 8 % (`DAMAGE_DEFAULTS`). WHY: yield in this sim is a lasting rest-length change, so it shows directly as current-vs-original length; ~2 k beams × 120 Hz is < 0.1 ms on main vs a per-beam f32 section.

### Static colliders
- **ColliderDef** lives in `src/world/types.ts` (pure layout data: render must draw exactly what the sim collides with and may not import `src/sim`; the worker already receives the layout): `{id, kind: box|cylinder|sphere|plane|ramp, pos: [x, y|null, z], quat [x,y,z,w], size, material, breakable?{anchorForce} (reserved P5), visual?}`. Size per kind: box half extents; cylinder `[r, halfHeight, 0]` axis +Y; sphere `[r]`; plane `[hx, 0, hz]` one-sided (solid −Y, 0.5 m slab); ramp `[hx, hy, hz]` wedge rising from y = −hy at z = +hz to +hy at z = −hz (identity quat: driving forward climbs it). `y: null` sits on the terrain (+hy / +r), yaw-only quat. `resolveColliders(colliders, heightAt) → ResolvedCollider[]` (`src/world/colliders.ts`, pure, both sides).
- **Kernel** (`src/sim/collision/types.ts`): `compileColliders(resolved) → ColliderWorld` (SoA + XZ grid CSR, cell 8 m) and `applyColliderContacts(state, first, count, world, materials, dt, objectId, events, gx, gy, gz)`. Same law as rigid ground contact (penalty `min(2e6, 0.2·m/dt²)` — higher cap than ground's 2.5e5 so walls/poles are not pulled through — two-sided ζ 0.65, ≥ 0 clamp, implicit backward-Euler Coulomb on accumulated force + m·g with μ = node × material friction, impact/skid events with the ground thresholds). Stateless inside-solid rule: least-penetration face skipping faces with v·n > 0 (never ejected out of a thin wall's far side). Phase order: **beams → ground → colliders → integrate** (collider pass is last; ORs `NODE_FLAG_IN_CONTACT`).
- **Protocol:** layout colliders install with `groundHeightfield` (no new message); additive `setColliders{colliders}` replaces an EXTRA set appended after them (tests, set-ups, plane-ground demo); invalid → `error`, set unchanged.
- **Arena (DEFAULT_LAYOUT v3):** `crashWall` concrete box 20 × 2 × 1.2 m at (360, ·, 265) facing the arena spawn (134 m run-up north); `pole1..5` steel r 0.15 m × 6 m at x 300, z 276–324 every 12 m; `ramp` 5 × 9 m, 1.4 m lip at (410, ·, 290) climbing north; `jersey1..8` 3.0 × 0.81 × 0.6 m concrete along z 385, x 282–307. Layout version 3 (colliders are not in `hashTerrain`, so `WorldLayout.version` now also bumps on collider changes).

### Crash tuning targets (A5's headless crash harness `src/sim/vehicle/crash.ts` + `crash.test.ts` asserts them)
Set-up: plane ground y = 0 (concrete), rigid collider barrier, sedan at rest pose settled 0.5 s, then every node given the test velocity (wheel ring nodes pre-spun to rolling), no throttle/brake, neutral; 2.0 s simulated after first contact. Measured along the vehicle frame (CompiledVehicle.frameNodes) from node ids:
- `crush` = rest − final distance between the crash-can tips (mean of `s1_rl_*`, `s1_rh_*`) and the B-pillar floor (mean of `s7_fl_*`, `s7_sl_*`); also report the max dynamic value.
- `intrusion` = rest − final distance between the firewall ring (`s5_fl_*`, `s5_sl_*`, `s5_hp_*`, `s5_cw_*`) and the same B-pillar refs.
- `doorIntrusion` (side pole) = rest − final width between `s6_dm_R` and `s6_dm_L` (+ `s6_sl_*` reported).
- `rebound` = peak COM speed away from the barrier after the contact force first drops to 0.

| Test | Target |
|---|---|
| 50 km/h full frontal, rigid wall | crush 35–60 cm; cabin intrusion < 8 cm; rebound 1–4 m/s; no NaN, no beam explosion; no wheel detaches |
| 30 km/h full frontal | crush 15–30 cm; intrusion < 3 cm; no wheel detaches, bumper stays on |
| 10 km/h full frontal | permanent crush ≤ 3 cm; mostly elastic: no broken beams, ≤ 5 % of body beams plastically deformed |
| 30 km/h side pole (r 0.15 m at the front door, `s6` station, car moving sideways) | door intrusion 20–35 cm; no node pulled through the pole (all nodes stay on the impact side of the pole axis) |
| 64 km/h 40 % offset frontal | struck-side front wheel MAY detach (allowed above ~60 km/h offset); intrusion < 15 cm |
| 100 km/h full frontal (acceptance) | no NaN/explosion; hood latch broken; front bumper detached or hanging; glass beams of the windscreen broken (shatter visuals) |

"No explosion" = every node finite; after 1 s no node faster than the initial speed; total KE at 2 s < 5 % of initial; no node farther than 3 m from its rest neighbours except nodes of detached sub-rigs (bumper stations, hood, wheels). Max collider penetration of any node < 5 cm at 50 km/h. The P2 handling harness stays green throughout.

### Protocol additions (P4, additive; SNAPSHOT_VERSION stays 1)
- `layout.ts`: section order `[header][objects][impacts][beamBreaks][skids][nodes][strains?][broken]`; `HDR_BROKEN_OFFSET_BYTE` 104 (0 = absent), `SNAPSHOT_FLAG_BROKEN_BEAMS` = 1<<1, `brokenSectionBytes(beamCapacity)`, `SnapshotLayout.brokenOffset`; `OBJ_REPAIR_EPOCH` = word 6 (was `OBJ_RESERVED0`).
- `codec.ts`: writer `writeBrokenBeams(objectIndex, active, srcStart)`, `setBeamBroken(g, broken)`, `setRepairEpoch(objectIndex, epoch)`; `addObject` zeroes the object's bits and epoch (stale pooled buffers read "intact"); reader `hasBrokenBeams`, `isBeamBroken(g)`, `readObjectBroken(i, out) → count`, `objectRepairEpoch(i)`.
- `messages.ts`: `setColliders{colliders: ColliderDef[]}` (until A5 implements it the worker answers `error`, unknown command).

## P4 work split (file ownership)

- **A1 body surface generator:** `src/render/vehicle/loft.ts` (`tessellateVehicle`), `src/render/vehicle/defs/sedan.ts` (`SEDAN_VISUAL: VehicleVisualDef` — every panel, paint, wheel visual, lamp panels, simple interior), tests (`loft.test.ts`, `defs/sedan.test.ts`: tessellates, no NaN, outward normals, shut gaps, every selector resolves against `compileVehicle(SEDAN)`).
- **A2 binder + flexskin + assembly:** `src/render/vehicle/binder.ts` (`bindPanels`, `evalFlexVertex`), `src/render/vehicle/flexskin.ts` (`createFlexSkin`, node texture, `flex1` patch), `src/render/vehicle/index.ts` (`createVehicleVisual`), integration in `src/main.ts` and `src/app/**` except `simClient.ts` (body mesh on by default, B cycles beam/node debug views), tests (binder round trip, rigid-motion invariance, seam welding, degeneracy repair, shader/CPU parity on a headless-compiled GLSL string).
- **A3 materials + wheels:** `src/render/vehicle/materials.ts` (`createVehicleMaterials`: paint clearcoat + flake, transmission glass, chrome, rubber, trim, lamps with `setLights`, interior, plate), `src/render/vehicle/textures.ts` (procedural flake/normal/sidewall-text/lens textures), `src/render/vehicle/wheels.ts` (`createWheelVisuals`, `wheel1` patch), tests.
- **A4 damage visuals:** `src/render/vehicle/damage.ts` (`createVehicleDamage`, strain ratchet, bitset → flags/detach/shatter, `dmg1` patch), `src/render/vehicle/shatter.ts` (minimal pooled glass-cube burst + debris until P5 FX), additive `src/app/simClient.ts` accessors (`brokenBeams(objectId, out) → count`, `repairEpoch(objectId)`, `setColliders(colliders)`), tests.
- **A5 sim colliders + crash tuning:** `src/sim/collision/colliders.ts` (`compileColliders`, `applyColliderContacts`), `src/world/colliders.ts` (`resolveColliders`), engine/worker integration in `src/sim/engine.ts` + `src/sim/worker.ts` (layout colliders on `groundHeightfield`, `setColliders`, collider pass, `writeBrokenBeams` + repair epoch in `writeSnapshot`), `src/sim/vehicle/defs/sedan.ts` (hood sub-rig FIRST — A1/A2 bind to it — then crash tuning), `src/sim/vehicle/crash.ts` + `crash.test.ts` (+ optional `tools/crash-report.mjs`), `src/render/world/colliders.ts` (`createColliderRenderer(ctx, resolved, {lighting, patchMaterial})`: wall, jersey profile, poles, ramp; wired into `main.ts` by A2).
- Shared contract files (`src/render/vehicle/types.ts`, `src/sim/collision/types.ts`, `src/world/types.ts`, `src/world/layout.ts`, `src/protocol/*`) change only via this doc.

## ReplayFile — pending (freezes end of P7)

Tick-indexed input log + keyframes + build hash (refuse cross-build playback).
