# CRUMPLE — agent conventions

BeamNG-style soft-body driving sandbox for the browser: node-and-beam physics in a worker, three.js rendering on main. Bespoke engine — no physics/game/UI frameworks.

Commands: `npm run dev` | `build` (tsc + vite build) | `typecheck` | `test` (vitest) | `e2e` (playwright) | `bench` (node tools/bench-beams.mjs).

## Architecture map

- `src/core/` — pure shared utilities (math, rng, events, spline, noise)
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
