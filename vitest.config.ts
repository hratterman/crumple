import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e/ holds Playwright specs — vitest must not collect them.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
