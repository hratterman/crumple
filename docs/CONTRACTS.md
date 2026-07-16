# Contracts

Frozen contracts are load-bearing for parallel agents: once FROZEN, changes require updating every consumer in the same change and a note here.

## Repo layout — FROZEN

Directory map as documented in `CLAUDE.md` (src/core, src/protocol, src/sim, src/render, src/game, src/input, src/ui, src/audio, src/app, src/assets, tools/, tests/e2e). Hard boundaries apply (see CLAUDE.md).

## npm scripts — FROZEN

`dev`, `build`, `preview`, `typecheck`, `test`, `test:watch`, `e2e`, `bench`, `fetch-assets` as defined in `package.json`. CI and tooling key off these names.

## Asset manifest path — FROZEN

`src/assets/manifest.ts` — pinned asset IDs/paths with procedural fallbacks. No build/test path may hard-require downloaded files.

## protocol/ — pending (freezes end of P1)

Worker⇄main seam: transferable ArrayBuffer pool (3 buffers, explicit ownership), 120 Hz snapshots (node positions f32, telemetry, event ring), commands (input, spawn/despawn reserved from day one, reset, timescale, mode). All offsets published as constants in `src/protocol/layout.ts`.

## RigDef — pending (freezes end of P1)

Node/beam rig definition types + canonical node-ordering rule in `src/sim/rig/types.ts`.

## VehicleDef — pending (freezes end of P2)

Vehicle schema (chassis rig, wheels, drivetrain, telemetry fields, action enum).

## TerrainData — pending (freezes end of P3)

`src/render/terrain/data.ts` pure function output (heights f32, splat u8, spacing/origin) — shared by sim collision and render mesh.

## BindingSet — pending (freezes end of P4)

Flexbody vertex→node-triad binding format produced by the binder, consumed by flexskin.

## ReplayFile — pending (freezes end of P7)

Tick-indexed input log + keyframes + build hash (refuse cross-build playback).
