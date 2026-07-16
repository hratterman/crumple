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
  },
  define: {
    __BUILD_HASH__: JSON.stringify(shortGitRev()),
  },
});
