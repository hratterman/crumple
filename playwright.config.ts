import { defineConfig } from '@playwright/test';

/** E2E_PORT: run the dev server on another port (parallel agents / worktrees; default 5173). */
const PORT = Number(process.env.E2E_PORT) || 5173;

export default defineConfig({
  testDir: 'tests/e2e',
  // *.slow.spec.ts are full-scene SwiftShader renders that take minutes;
  // opt in with E2E_SLOW=1 instead of running them on every push.
  testIgnore: process.env.E2E_SLOW ? [] : ['**/*.slow.spec.ts'],
  // SwiftShader (software WebGL) is slow — keep timeouts generous.
  timeout: 60_000,
  // One browser at a time: each spec software-renders a full scene (and the
  // game generates the island twice); two in parallel on a 4-core runner
  // push single specs past the 60 s budget.
  workers: 1,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      // Required for headless WebGL2 on Chromium 141: ANGLE on SwiftShader.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader-webgl',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/crumple/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
