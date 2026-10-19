#!/usr/bin/env node
// Prints the SEDAN handling table (src/sim/vehicle/handling.test.ts runs every
// harness scenario and logs the report after its assertions).
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'src/sim/vehicle/handling.test.ts', '--reporter=verbose', '--silent=false'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const at = out.indexOf('SEDAN handling report');
if (at < 0) {
  process.stdout.write(out);
  process.exit(r.status ?? 1);
}
const lines = out.slice(at).split('\n');
const end = lines.findIndex((l, i) => i > 0 && !l.startsWith('  '));
process.stdout.write(`${lines.slice(0, end < 0 ? undefined : end).join('\n')}\n`);
const pass = out.match(/Tests\s+.*$/m);
if (pass) process.stdout.write(`${pass[0]}\n`);
process.exit(r.status ?? 0);
