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
- **layout.ts**: `[header 128 B][objects][impacts][beamBreaks][skids][nodes][strains?]`, every section 16-byte aligned; all offsets are exported consts and also stored in the header. Magic `'CRMP'` (u32 0x504D5243), `SNAPSHOT_VERSION` 1. Object record 160 B: id, flags (bit0 sleeping), nodeOffset, nodeCount, beamOffset, beamCount (element indices), 2 reserved words, 32 f32 telemetry (zeros in P1; named slots in `Telemetry`, spare from 26). Nodes f32 xyz × nodeTotal. Strains (only with header flag bit0) f32 × beamTotal = signed force/breakF in [-1, 1], tension positive, NaN broken.
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

Nodes and beams in RigDef declaration order everywhere (arena, snapshots, GPU bindings; never sorted/compacted, broken beams stay with active 0). Objects by ascending objectId (stepping, arena allocation, snapshots). Fixed per-step phase order: commands → per object: beams → ground contacts → other forces → integrate. Events in discovery order. Cross-object contact pairs sorted (lower object id, then node index). Full text in `src/sim/types.ts`.

## VehicleDef — pending (freezes end of P2)

Vehicle schema (chassis rig, wheels, drivetrain, telemetry fields, action enum).

## TerrainData — pending (freezes end of P3)

`src/render/terrain/data.ts` pure function output (heights f32, splat u8, spacing/origin) — shared by sim collision and render mesh.

## BindingSet — pending (freezes end of P4)

Flexbody vertex→node-triad binding format produced by the binder, consumed by flexskin.

## ReplayFile — pending (freezes end of P7)

Tick-indexed input log + keyframes + build hash (refuse cross-build playback).
