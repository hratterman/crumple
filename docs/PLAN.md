# CRUMPLE: master plan

The source of truth for every agent working on this repo. Read this, `CLAUDE.md` and `docs/CONTRACTS.md` before writing code.

## Goal

A BeamNG.drive-style **soft-body** driving sandbox that runs in the browser and holds up in every facet: graphics, models, textures, physics and realism. Vehicles are node-and-beam spring networks that flex, crumple plastically and tear apart. That simulation is the heart; everything else exists to make it look and feel spectacular.

Scope: **5 vehicles** (sedan, sports coupe, pickup, box truck, derby beater), a **~2 km² multi-zone map** (highway loop, mountain road, dirt trail, lake, crash-test arena), **soft-body AI traffic**, **deterministic replay** with free cam and slow-mo, **stunt challenges** (time trials + ghost, smash scoring, jump ratings), and deploys to **GitHub Pages** (`hratterman.github.io/crumple/`) on every push to `main`.

Assets: all geometry is procedural (required for deformation skinning). CC0 PBR textures (ambientCG: Asphalt025C, Grass004, Ground037, Rock035, Gravel023) and HDRIs (Poly Haven: kiara_1_dawn, venice_sunset) are committed under `public/assets/`. Procedural fallbacks in `src/assets/procedural.ts` keep every path working without them.

## Standing rules (crash-proofing)

The dev container can be reclaimed at any time, and uncommitted work dies with it. One full phase was lost this way.

- **Commit and push after every work unit** once typecheck and its tests pass. Never hold a phase's worth of work locally.
- **Before pushing:** `git fetch origin main` (the clone is shallow; this keeps the push a thin pack).
- **Never run parallel git network operations** (the session proxy caps this repo at 2 concurrent).
- Keep orchestration in short runs (half a phase at most) so a dead run loses little.
- This file, not anything outside the repo, is the plan. Update the status table when a unit lands.

## Status

| Phase | State |
|---|---|
| P0 Foundation | ✅ done: scaffold, CI, Pages, fetch-assets, bench (31.6 M beam-updates/s/core; f64 faster than f32 on V8), `src/core` (102 tests), real CC0 assets |
| P1 Sim core + protocol | ✅ done: frozen protocol, beam kernel (plasticity/breaking), ground contact, rig compiler, worker at real-time 2 kHz, soft-cube wireframe demo (172 tests) |
| P2 Drivable wireframe car | ⏳ in progress |
| P3–P9 | not started |

## Pinned stack

- Runtime: `three@0.185.1` (pinned: `postprocessing`'s peer range caps at `<0.186`; upgrade both together), `postprocessing@6.39.2`, `n8ao@2.0.0`, `simplex-noise@4.0.3`, `lil-gui@0.21.0` (debug only).
- Dev: TypeScript 5.x strict, `vite@^8.1` (Rolldown), `vitest@^4.1`, `@playwright/test@~1.56` (matches preinstalled Chromium rev 1194 at `/opt/pw-browsers`; never run `playwright install` locally).
- three r185 gotchas: `BufferAttribute.updateRange` is removed, so use `addUpdateRange()`. `RGBELoader` defaults to `HalfFloatType`. PMREM and shadow-bias behavior changed around r180–r181, so tune on r185 rather than from old recipes.
- Vite workers: `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, with the URL literal inline and static options; `worker.format: 'es'`; `base: '/crumple/'`.
- Headless WebGL2: `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader --no-sandbox` (already in `playwright.config.ts`).

## Physics (`src/sim/`, worker only, never imports three)

- **Model:** point-mass nodes and spring-damper beams; semi-implicit Euler; fixed **dt = 1/2000 s** (same as Rigs of Rods). f64 SoA typed arrays internally (measured faster), f32 in snapshots. Zero allocation in hot loops, seeded RNG, fixed iteration order.
- **Defaults (Rigs of Rods reference values):** spring 9e6 N/m, damp 12e3. **Deform and break thresholds are forces in N:** deform 4e5 (plastic rest-length ratchet + strength loss), break 1e6 (deactivate + event). Node friction μ: tire 2.0, chassis 0.5. A node with mass ≤ 0 is pinned (invMass 0).
- **Beam types:** normal, bounded/progressive, support (compression only), hydro (rest length driven by steering), shock (preloaded suspension).
- **Stability is per NODE:** `sqrt(Σ k_b / m_node)·dt ≤ 0.5` (≤ 0.35 for structure, leaving headroom for contacts). Also `(Σ d_b / m_node)·dt ≤ 1` and `d_b ≤ 2·sqrt(k_b·μ_reduced)`. Enforce by **raising node mass** (MINIMASS), never by softening k.
- **Hot-loop numerics:** only `+ − × ÷ sqrt`. No `Math.sin/cos/pow/hypot/tanh/random` while stepping; use tables, polynomials, or the rational tanh `x(27+x²)/(27+9x²)`. Replays become cross-browser deterministic as a result. Inputs are recorded in-worker as `(tick, action, value)`.
- **Collision:**
  - **Heightfield:** bilinear height for penetration depth, but a C0-continuous smoothed normal for force direction (raw bilinear normals cause 2 kHz chatter). Penalty stiffness is clamped per node to stay in the stability envelope. Friction is slip-regularized Coulomb, `μ·tanh(v_slip/0.3)`, with per-material μ from the splatmap.
  - **Static primitives** (OBB/cylinder/sphere) with a grid broadphase.
  - **Node-vs-node spheres** across objects via a spatial hash. Rebuild every 8–16 steps with velocity-fattened AABBs, and sort pairs canonically. Exterior contact radius is about 0.6× node spacing, plus collision-only mid-panel nodes against gap interlock.
  - **Water:** depth-proportional buoyancy and drag.
- **Wheels (RoR `wheels2` structure, fully soft-body):** 2 hub nodes, a stiff rim ring and a soft tire ring, 10–14 rays.
  - Drive/brake torque is a tangential force `τ/(N·r)` per ring node, **with the equal-and-opposite reaction on the hub nodes**.
  - The parking clamp is a capped viscous force (cap μN) below 0.3 m/s, never a position constraint.
  - Steering uses hydro beams on a knuckle sub-rig.
- **Drivetrain:** torque curve (lookup table + lerp), engine inertia, rev limiter, auto-clutch, auto and manual gearbox, final drive, open/locked diff, brake bias. Torque is cut to a detached wheel.
- **Scheduling:** awake vs ghost, with no reduced-rate tier.
  - Inside the player's bubble, everything runs at 2000 Hz.
  - Outside it, AI cars become kinematic spline followers and props sleep.
  - A governor drops awake traffic under sustained overrun.
- **Budgets:** player ≤ 3,500 beams, traffic ≤ 1,500, total awake ≤ ~10 M beam-updates/s.
- **Protocol (`src/protocol/`, frozen at end of P1):**
  - A 3-buffer transferable pool; the worker skips a snapshot rather than block.
  - 120 Hz snapshots: node positions f32, per-object telemetry, event rings for impacts, beam breaks and skids.
  - The main thread interpolates between the last two snapshots.
  - Commands: init, ground, spawn/despawn, input, reset, timescale. Reserved now: setBubble, keyframeRequest, replaySeek.
- **Canonical ordering (frozen):** nodes and beams in RigDef declaration order, objects by ascending id, events in discovery order. GPU bindings and determinism both depend on it.

## Vehicle visuals and deformation (`src/render/vehicle/`)

- **Bodies:** procedurally lofted from cross-section splines into separate panels (hood, fenders, doors, roof, bumpers), plus glass, lights, trim, a simple interior, and wheels/tires.
- **Flexbody skinning (RoR triad):**
  - Each vertex is placed at `P = R + a(X−R) + b(Y−R) + c·n̂`, with `n̂ = normalize((X−R)×(Y−R))`.
  - Positions are evaluated in the vertex shader from a node-position DataTexture (`texelFetch`, NearestFilter).
  - Normals and tangents are rotated by a **Gram-Schmidt orthonormalized** triad frame.
- **Robustness:** reject degenerate triads at bake time; panels bind only to their own nodes; seam vertices are duplicated with identical triads; clamp `1/|cross|` and max displacement at runtime.
- **One `patchMaterial()`** composes CSM, skinning and damage into the color material AND the depth/shadow materials. Otherwise shadows are cast by the undeformed body.
- **Damage:** v1 is a per-vertex plastic-strain attribute (darken, roughen, perturb normals). Panels detach when their attachment beams break. Glass shows a crack overlay, then shatters. A UV scuff atlas is later polish.

## Rendering (`src/render/`)

- **Post pipeline:** `RenderPass → N8AOPostPass → EffectPass(SMAA, Bloom, DoF in photo/slow-mo, ACES)`.
  - HalfFloat framebuffer; set `renderer.toneMapping = NoToneMapping`.
  - Set n8ao `gammaCorrection` explicitly.
  - SMAA, not MSAA.
- **Lighting:** the kiara_1_dawn HDRI via PMREM, a matched sun, and CSM from `three/examples/jsm/csm/CSM.js`. Time of day is golden hour.
- **Materials:** paint is MeshPhysical clearcoat with a procedural flake normal; glass uses transmission.
- **Terrain:**
  - `render/terrain/data.ts` is a **pure function** (seed → heights f32, splat u8, spacing/origin) used by BOTH sim collision and the render mesh.
  - Ridged fbm with zone masks; roads are carved before meshing.
  - Chunked LOD with skirts and triplanar splat across the 5 PBR sets.
  - Road ribbons carry crisp markings; trees are instanced with impostors, plus wind grass, rocks and water.
- **FX:** pooled particles (smoke, dust, sparks, glass, debris) and skidmarks, all driven by protocol events; headlights.
- **Debug beam view:** LineSegments colored by strain (compression blue, tension red).

## Game systems

- **Cameras:** chase, orbit, hood, free, and a crash cam with auto slow-mo. Timescale 0.05–1.
- **Input:** keyboard, gamepad and touch. R recovers the car upright; F does a full repair.
- **HUD:**
  - SVG gauges and a live damage schematic.
  - Menus, a showroom turntable, and settings with quality presets and adaptive resolution.
  - Photo mode.
- **Audio** is fully synthesized: engine harmonics plus intake/exhaust noise, tire squeal ∝ slip, crunch ∝ impulse, glass, wind and shift blips.
- **Replay:**
  - Recorded in the worker as an input log plus keyframes every ~2 s; scrubbing re-simulates deterministically.
  - Each replay carries a build hash.
  - Ghosts are quantized pose tracks (~1 KB/s).
- **Challenges:** trigger volumes, time trials with a ghost, smash scoring (Σ plastic work), jump ratings, and localStorage bests.
- **AI traffic:** route splines, target speed, pure-pursuit steering and obstacle braking. Respawns when wrecked or far away.

## Phase map

Each phase lands unit by unit. The exit state is always runnable, with screenshots reviewed before the phase-exit commit.

- **P1 Sim core + protocol freeze:** contracts → kernels/engine/worker → ground collision → rig compiler → SimClient + beam debug view + soft-cube drop demo. Exit: a soft cube drops, deforms and settles, visible as a strain-colored wireframe.
- **P2 Drivable wireframe car:** rig validator + sedan chassis, wheels2 + parking clamp, drivetrain + input actions, chase cam + minimal HUD, and a **headless handling harness** (static sag, drop, straight-line hold at 30 m/s, step-steer, braking distance). Freezes VehicleDef.
- **P3 Terrain + graphics stack:** terrain data, LOD mesh + triplanar splat, a stack spike (CSM + N8AO + SMAA + patched materials at 60 fps), adaptive quality, heightfield collision, road ribbons. Freezes TerrainData.
- **P4 Flexbody vehicle:** body loft, binder + flexskin (with depth/shadow patch), paint/glass/trim, damage FX. Freezes BindingSet.
- **P5 World + FX:** static colliders + arena layout, soft props, particles/skidmarks, vegetation, water.
- **P6 Fleet + traffic:** 4 more vehicles tuned via the harness, AI driver, awake/ghost scheduler, inter-vehicle contact, showroom.
- **P7 Replay + cameras:** recorder + scrub, replay UI + photo mode, crash director, ghosts. Freezes ReplayFile.
- **P8 Challenges + HUD + audio.**
- **P9 Hardening + ship:** perf/governor, zero steady-state GC, e2e expansion, README, tuning pass, asset recompression (114 MB today).

## Risks

1. **Tire/handling tuning:** emergent grip is the hardest part. Mitigated by the P2 harness, live tuning and RoR priors. Never fall back to raycast wheels.
2. **Physics budget:** bench gate, validator budgets, awake/ghost scheduling, governor.
3. **Graphics stack integration:** proven in the P3 spike before content depends on it.
4. **Flexbody artifacts:** degenerate triads, seams and undeformed shadows (see Robustness above).
5. **Inter-vehicle contact gap interlock:** contact radii plus mid-panel nodes; a coarse hull only if playtests demand it.

## Acceptance bar

- A 100 km/h wall hit gives progressive crumple, a buckled hood, cracked then shattered glass, a torn-off bumper and wheels that can detach, and the replay scrubs in slow-mo with a free camera.
- Drifts leave smoke and skidmarks. The box truck tips over. The beater folds.
- Golden-hour HDRI lighting with clearcoat reflections and CSM shadows of the deformed body, at 60 fps at 1080p on mid-range hardware.
- Traffic, challenges, a production-grade HUD, and the beam-stress debug view all work.
