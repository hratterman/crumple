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
- P5 placeholders: `PadDef`, `ColliderDef` (obb/cylinder/sphere + quat), `PropPlacement`.

## TerrainData — FROZEN (P3)

`src/world/types.ts`. `generateTerrain(layout): TerrainData` is PURE and deterministic (seeded `core/rng`/`core/noise` only; only `+ − × ÷ sqrt floor abs min max` and simplex-noise; fixed iteration order) and validates the layout.
- Grid: sample (col, row) at `x = originX + col·spacing`, `z = originZ + row·spacing`; row-major `row·cols + col`; `cols = rows = size/spacing + 1`. Default 1408 m @ 1 m → 1409² ≈ 1.99 M samples, 22 × 22 chunks of `TERRAIN_CHUNK_CELLS` = 64.
- `heights` Float32Array (7.9 MB); `splat` Uint8Array ×4 (7.9 MB): **R paved, G dirt, B rock, A gravel, grass = 255 − (R+G+B+A)** (sum ≤ 255 guaranteed: 5 sets in one RGBA8 texture, exact partition of unity under filtering; concrete = paved set tinted via the material map); `material` Uint8Array MaterialId per sample (2 MB, nearest lookup). ≈ 18 MB per side.
- Also `layoutId, layoutVersion, seed, minHeight, maxHeight, waterLevel`, `roads: RoadProfile[]` (layout order) and `spawns: ResolvedSpawn[]`, `hash` = `hashTerrain()` (FNV-1a 32 word-wise over dims, heights, material, splat, road stations).
- **RoadProfile** = resolved road: stations every `ROAD_STATION_SPACING` 2 m, `ROAD_STATION_STRIDE` 7 f64 `[x, y, z, tx, tz, bank, curvature]` (`RoadStation` offsets), `length`, `stationCount`, width/lanes/shoulder/material/markings/surface. Ribbons, AI and spawns consume profiles, never re-derive from RoadDef. Helpers `sampleRoad(profile, s, out)` (linear between stations, wraps closed) and `projectToRoad(profile, x, z, out, hintS?)` → `{s, d, dist, y}`; allocation-free.
- **TerrainSampler** (`createTerrainSampler(terrain)`, `src/world/sampler.ts`) is structurally identical to sim's FROZEN `HeightSampler` plus `splatAt`/`contains`: bilinear `heightAt`; `normalAt` = bilinear blend of central-difference vertex normals, renormalized (C0-continuous); `materialAt` nearest; edge-clamped outside the grid; allocation-free, sim numerics. The same object drives collision, cameras and ribbon conforming.

## Terrain protocol — FROZEN (P3, additive to protocol)

- Main→worker `groundHeightfield{layout: WorldLayout, terrainHash}`: the worker regenerates terrain itself (KB of JSON instead of 18 MB of arrays; collision == visual by construction), compares `hashTerrain` with `terrainHash` (0 = skip), installs its own terrain either way, and answers worker→main `terrainReady{layoutId, terrainHash, matched, generateMs}`; a mismatch also posts `error`. Send before spawning (spawns queued behind it apply after). The P1 `ground{mode:'plane'}` is unchanged; the reserved `ground{mode:'heightfield'}` variant stays `unimplemented` (superseded).

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

## BindingSet — pending (freezes end of P4)

Flexbody vertex→node-triad binding format produced by the binder, consumed by flexskin.

## ReplayFile — pending (freezes end of P7)

Tick-indexed input log + keyframes + build hash (refuse cross-build playback).
