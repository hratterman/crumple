import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e/ holds Playwright specs — vitest must not collect them.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
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
          exclude: [...configDefaults.exclude, 'tests/e2e/**', 'src/sim/**'],
        },
      },
    ],
  },
});
