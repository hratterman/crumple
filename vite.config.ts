import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

function shortGitRev(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base: '/crumple/',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // three's core is one module (build/three.core.js) that cannot be split further; it is
    // its own long-cached chunk (~545 kB), so the warning threshold sits just above it.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Vendor code changes only on a dependency bump: separate chunks stay cached across deploys
        // and download in parallel with the app chunk (modulepreload).
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/, priority: 3 },
            { name: 'vendor', test: /node_modules[\\/](three[\\/]examples|postprocessing|n8ao)[\\/]/, priority: 2 },
          ],
        },
      },
    },
  },
  define: {
    __BUILD_HASH__: JSON.stringify(shortGitRev()),
  },
});
