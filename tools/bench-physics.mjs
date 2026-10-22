#!/usr/bin/env node
/**
 * R-CORE physics bench: whole-step cost per scene × kernel (js / wasm / simd).
 *   node tools/bench-physics.mjs [--scenes sedan,truck,traffic] [--kernels js,wasm,simd] [--seconds 1] [--rounds 3]
 * Bundles tools/physbench/bench.ts with rolldown (a devDependency of vite) into
 * a temp dir and runs it in this node. Prints one line per scene and a JSON
 * dump of every window.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'crumple-bench-'));
execFileSync(join(root, 'node_modules/.bin/rolldown'), ['tools/physbench/bench.ts', '--format', 'esm', '--platform', 'node', '-d', dir, '--entry-file-names', 'bench.mjs'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const out = join(dir, 'bench.mjs');
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
