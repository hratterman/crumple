# CRUMPLE — agent conventions

BeamNG-style soft-body driving sandbox for the browser: node-and-beam physics in a worker, three.js rendering on main. Bespoke engine — no physics/game/UI frameworks.

**Read `docs/PLAN.md` first.** It is the master plan: design, phase map, status, and the standing rule to commit and push after every work unit. `docs/CONTRACTS.md` lists the frozen seams.

Commands: `npm run dev` | `build` (tsc + vite build) | `typecheck` | `test` (vitest) | `e2e` (playwright) | `bench` (node tools/bench-beams.mjs).

## Architecture map

- `src/core/` — pure shared utilities (math, rng, events, spline, noise)
- `src/world/` — pure world layer shared by sim and render (map layout, terrain generation, road sampling)
- `src/protocol/` — the FROZEN worker⇄main seam (messages, buffer layout, codec)
- `src/sim/` — physics, runs in the worker only
- `src/render/` — three.js scene, terrain, vehicle visuals, FX, cameras
- `src/game/` — modes, challenges, traffic, scoring
- `src/input/` — keyboard/gamepad/touch → action mapping
- `src/ui/` — HUD, menus (hand-rolled DOM/SVG)
- `src/audio/` — synthesized WebAudio
- `src/app/` — boot, loop, quality, settings, save
- `src/assets/` — asset manifest + procedural fallbacks
- `tools/` — bench + asset-fetch scripts (node)
- `tests/e2e/` — playwright specs; unit tests co-located as `src/**/*.test.ts`

## HARD BOUNDARIES

- `src/sim/**` must NEVER import three or anything from `src/render`, `src/ui`, `src/game`, `src/app`.
- `src/render`, `src/ui`, `src/game` must never import `src/sim` internals.
- The two sides communicate ONLY via `src/protocol` + `src/core`.
- `src/core` and `src/protocol` are pure (no three, no DOM) so they run in worker, main, and node tests.

## NUMERICS CONTRACT (sim hot loops)

- Only `+ - * / sqrt` (IEEE-exact). NO `Math.sin/cos/pow/hypot/random` inside stepping code — use lookup tables/polynomials; precompute trig outside the loop.
- Randomness only via seeded RNG from `src/core/rng`.
- Fixed iteration order everywhere (determinism).
- Zero allocation in hot loops: SoA typed arrays, preallocated.

- **Sampler inlining:** `src/world/sampler.ts` `normalAt` must stay under V8's 460-byte bytecode inlining limit (currently ~448 bytes). Over it, the 2 kHz contact pass stops inlining the call, boxes x/z as HeapNumbers and allocates on every query. Re-check the size after ANY edit: `node --print-bytecode --print-bytecode-filter=normalAt` (see the INLINING note in that file); the same applies to `heightAt` / `materialAt`.

## PHYSICS BUDGETS

- Fixed dt = 1/2000 s.
- Player rigs ≤ 3500 beams; traffic rigs ≤ 1500 beams.
- Validator enforces per-node stability `sqrt(sum k_b / m_node) * dt ≤ 0.5` by auto-raising node mass (never soften k).

## Units / coordinates

SI units (m, s, kg, N). Y-up, right-handed (three.js default).

## Testing

- Vitest, co-located `src/**/*.test.ts`.
- E2E via playwright; SwiftShader flags already in config — never run `playwright install`.
- The determinism state-hash test is the primary regression net — never break it.

## Style

TypeScript strict, named exports, no UI frameworks, comments only for non-obvious constraints.
