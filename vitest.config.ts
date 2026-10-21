import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e/ holds Playwright specs — vitest must not collect them.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    // R-CORE: the solver kernel for every engine a test creates (CRUMPLE_KERNEL, default simd).
    setupFiles: ['src/sim/wasm/vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'sim',
          include: ['src/sim/**/*.test.ts'],
          // The physics suite steps real rigs at 2 kHz: many cases run thousands of steps without a
          // per-test timeout and take 2–4 s on a loaded 4-core box (wheels, runtime, sedan,
          // determinism), too close to the 5 s default. Heavier cases keep their own explicit budget.
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.ts'],
          // Layout v6 (2560 m map): suites that generate the default world in beforeAll (routes,
          // vegetation, terrain) need ~10 s of CPU, a minute or more on a loaded box.
          hookTimeout: 240_000,
          exclude: [...configDefaults.exclude, 'tests/e2e/**', 'src/sim/**'],
        },
      },
    ],
  },
});
