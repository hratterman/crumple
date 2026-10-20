/**
 * Optional data dump for the realism plots (harness only): when the
 * REALISM_OUT environment variable names a directory, `dumpJson` writes
 * `<dir>/<name>.json` (node only; a no-op in browsers / without the var).
 */
const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export const REALISM_OUT = ENV.REALISM_OUT ?? '';

export async function dumpJson(name: string, data: unknown): Promise<void> {
  if (!REALISM_OUT) return;
  const mod = 'node:fs';
  const fs = (await import(/* @vite-ignore */ mod)) as { writeFileSync(p: string, d: string): void };
  fs.writeFileSync(`${REALISM_OUT}/${name}.json`, JSON.stringify(data));
}

export function envFlag(name: string): string {
  return ENV[name] ?? '';
}
