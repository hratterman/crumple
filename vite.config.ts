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
    // Budget: no chunk over 500 kB (three = core + renderer chunks, P5 world layer lazy-loaded).
    chunkSizeWarningLimit: 500,
    rolldownOptions: {
      output: {
        // Vendor code changes only on a dependency bump: separate chunks stay cached across deploys
        // and download in parallel with the app chunk (modulepreload).
        codeSplitting: {
          groups: [
            // three's core (math, scene graph, materials) and its WebGL renderer are two modules: two chunks.
            { name: 'three-core', test: /node_modules[\\/]three[\\/]build[\\/]three\.core\.js/, priority: 4 },
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/, priority: 3 },
            { name: 'vendor', test: /node_modules[\\/](three[\\/]examples|postprocessing|n8ao)[\\/]/, priority: 2 },
            // P7: the replay recorder / playback, its UI and the camera rigs (static imports, own chunk).
            { name: 'replay', test: /src[\\/](app[\\/]replay|ui[\\/]replay|render[\\/]cameras)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  define: {
    __BUILD_HASH__: JSON.stringify(shortGitRev()),
  },
});
