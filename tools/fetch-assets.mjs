#!/usr/bin/env node
// CRUMPLE asset fetcher — CC0 PBR textures (ambientCG) + HDRIs (Poly Haven).
// Plain node, no npm deps: node:https (manual redirect following), node:crypto,
// and the system `unzip` binary (present on ubuntu GitHub runners).
//
// The dev sandbox blocks both hosts, so this runs in CI
// (.github/workflows/fetch-assets.yml) which commits the results back to main.
// Use `node tools/fetch-assets.mjs --dry-run` to print the plan without network.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = path.join(ROOT, 'public', 'assets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');
const CREDITS_PATH = path.join(ROOT, 'CREDITS.md');
const LICENSE = 'CC0-1.0';
const USER_AGENT = 'crumple-fetch-assets/1.0 (+https://github.com/hratterman/crumple)';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 120_000;

// ---- pinned sources (verified in the plan; do not guess new IDs) ------------

const TEXTURES = [
  { id: 'Asphalt025C', slug: 'asphalt' }, // plain "Asphalt025" does not exist
  { id: 'Grass004', slug: 'grass' },
  { id: 'Ground037', slug: 'dirt' },
  { id: 'Rock035', slug: 'rock' },
  { id: 'Gravel023', slug: 'gravel' },
];
const ambientcgUrl = (id) => `https://ambientcg.com/get?file=${id}_2K-JPG.zip`;

// zip member suffix -> our canonical filename; ao is optional in some sets
const TEXTURE_MAPS = [
  { suffix: '_Color.jpg', out: 'color.jpg', optional: false },
  { suffix: '_NormalGL.jpg', out: 'normal.jpg', optional: false },
  { suffix: '_Roughness.jpg', out: 'rough.jpg', optional: false },
  { suffix: '_AmbientOcclusion.jpg', out: 'ao.jpg', optional: true },
];

const HDRIS = [
  { id: 'kiara_1_dawn', file: 'kiara_1_dawn_2k.hdr' },
  { id: 'venice_sunset', file: 'venice_sunset_2k.hdr' },
];
const polyhavenUrl = (file) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${file}`;

// ---- small helpers ----------------------------------------------------------

const log = (...args) => console.log('[fetch-assets]', ...args);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function fileSha256(absPath) {
  return sha256(readFileSync(absPath));
}

function relToRoot(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function fetchBuffer(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(location, url).href;
        log(`  redirect -> ${next}`);
        resolve(fetchBuffer(next, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

function assertZipMagic(buf, url) {
  // 'PK\x03\x04' — local file header of a non-empty zip
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error(`response from ${url} is not a zip (bad magic; got ${buf.subarray(0, 4).toString('hex')})`);
  }
}

function assertHdrMagic(buf, url) {
  const head = buf.subarray(0, 10).toString('latin1');
  if (!head.startsWith('#?')) {
    throw new Error(`response from ${url} is not a Radiance .hdr (header: ${JSON.stringify(head)})`);
  }
}

function loadExistingManifest() {
  if (!existsSync(MANIFEST_PATH)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    return new Map((parsed.files ?? []).map((f) => [f.path, f]));
  } catch {
    log('warning: existing manifest.json is unreadable; refetching everything');
    return new Map();
  }
}

// A target is up to date when the file exists and matches the recorded sha256.
function isUpToDate(absPath, recorded) {
  if (!recorded) return false;
  if (!existsSync(absPath)) return false;
  return fileSha256(absPath) === recorded.sha256;
}

function entryFor(absPath, source) {
  return {
    path: relToRoot(absPath),
    sha256: fileSha256(absPath),
    bytes: statSync(absPath).size,
    source,
    license: LICENSE,
  };
}

// ---- jobs -------------------------------------------------------------------

function textureJobs() {
  return TEXTURES.map(({ id, slug }) => {
    const url = ambientcgUrl(id);
    const dir = path.join(ASSETS_DIR, 'textures', slug);
    return {
      kind: 'texture',
      id,
      slug,
      url,
      dir,
      outputs: TEXTURE_MAPS.map((m) => ({ ...m, abs: path.join(dir, m.out) })),
    };
  });
}

function hdriJobs() {
  return HDRIS.map(({ id, file }) => {
    const url = polyhavenUrl(file);
    return {
      kind: 'hdri',
      id,
      url,
      outputs: [{ out: file, optional: false, abs: path.join(ASSETS_DIR, 'hdri', file) }],
    };
  });
}

// Required outputs must exist and hash-match; optional outputs must match iff
// previously recorded (a set legitimately without AO stays up to date).
function jobUpToDate(job, recordedByPath) {
  return job.outputs.every((o) => {
    const recorded = recordedByPath.get(relToRoot(o.abs));
    if (o.optional && !recorded && !existsSync(o.abs)) return true;
    return isUpToDate(o.abs, recorded);
  });
}

async function runTextureJob(job, entries) {
  log(`downloading ${job.url}`);
  const zip = await fetchBuffer(job.url);
  assertZipMagic(zip, job.url);
  log(`  ${(zip.length / 1024 / 1024).toFixed(1)} MB zip ok`);

  const tmp = mkdtempSync(path.join(tmpdir(), `crumple-${job.slug}-`));
  try {
    const zipPath = path.join(tmp, `${job.id}.zip`);
    writeFileSync(zipPath, zip);
    const extractDir = path.join(tmp, 'x');
    mkdirSync(extractDir);
    execFileSync('unzip', ['-o', '-q', '-j', zipPath, '-d', extractDir], { stdio: 'inherit' });

    const members = readdirSync(extractDir);
    mkdirSync(job.dir, { recursive: true });
    for (const o of job.outputs) {
      const member = members.find((m) => m.endsWith(o.suffix));
      if (!member) {
        if (o.optional) {
          log(`  note: ${job.id} has no ${o.suffix} member (optional, skipping)`);
          continue;
        }
        throw new Error(`${job.id}: required member *${o.suffix} missing from zip (members: ${members.join(', ')})`);
      }
      copyFileSync(path.join(extractDir, member), o.abs);
      entries.push(entryFor(o.abs, job.url));
      log(`  wrote ${relToRoot(o.abs)} (from ${member})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runHdriJob(job, entries) {
  log(`downloading ${job.url}`);
  const buf = await fetchBuffer(job.url);
  assertHdrMagic(buf, job.url);
  const target = job.outputs[0];
  mkdirSync(path.dirname(target.abs), { recursive: true });
  writeFileSync(target.abs, buf);
  entries.push(entryFor(target.abs, job.url));
  log(`  wrote ${relToRoot(target.abs)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

// ---- credits / manifest -----------------------------------------------------

function creditsMarkdown() {
  const rows = TEXTURES.map(
    ({ id, slug }) => `| ${slug} | [${id}](https://ambientcg.com/view?id=${id}) |`,
  ).join('\n');
  const hdrs = HDRIS.map(
    ({ id }) => `- [${id}](https://polyhaven.com/a/${id})`,
  ).join('\n');
  return `# Asset credits

All bundled textures and HDRIs are licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
(public-domain dedication). Fetched by \`tools/fetch-assets.mjs\`; see
\`public/assets/manifest.json\` for exact files and checksums.

## PBR textures — ambientCG

Texture sets from [ambientCG](https://ambientcg.com) by Lennart Demes.

| In-game material | ambientCG asset |
| ---------------- | --------------- |
${rows}

## HDR environments — Poly Haven

HDRIs by Greg Zaal, from [Poly Haven](https://polyhaven.com).

${hdrs}
`;
}

function writeIfChanged(absPath, content, label) {
  if (existsSync(absPath) && readFileSync(absPath, 'utf8') === content) {
    log(`${label} unchanged`);
    return false;
  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  log(`wrote ${relToRoot(absPath)}`);
  return true;
}

// ---- main -------------------------------------------------------------------

function printPlan(jobs, recordedByPath) {
  log('dry run — download plan (no network):');
  for (const job of jobs) {
    const state = jobUpToDate(job, recordedByPath) ? 'UP-TO-DATE (would skip)' : 'FETCH';
    console.log(`  [${state}] ${job.url}`);
    for (const o of job.outputs) {
      console.log(`      -> ${relToRoot(o.abs)}${o.optional ? ' (optional)' : ''}`);
    }
  }
  console.log(`  manifest: ${relToRoot(MANIFEST_PATH)}`);
  console.log(`  credits:  ${relToRoot(CREDITS_PATH)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const unknown = args.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`usage: node tools/fetch-assets.mjs [--dry-run]\nunknown argument(s): ${unknown.join(' ')}`);
    process.exit(1);
  }

  const recordedByPath = loadExistingManifest();
  const jobs = [...textureJobs(), ...hdriJobs()];

  if (dryRun) {
    printPlan(jobs, recordedByPath);
    return;
  }

  const entries = [];
  let fetched = 0;
  for (const job of jobs) {
    if (jobUpToDate(job, recordedByPath)) {
      log(`up to date: ${job.id} (skipping download)`);
      for (const o of job.outputs) {
        const recorded = recordedByPath.get(relToRoot(o.abs));
        if (recorded) entries.push(recorded);
      }
      continue;
    }
    if (job.kind === 'texture') await runTextureJob(job, entries);
    else await runHdriJob(job, entries);
    fetched++;
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Keep the manifest byte-stable when nothing changed (idempotent CI commits).
  const oldFilesJson = existsSync(MANIFEST_PATH)
    ? JSON.stringify(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).files ?? [])
    : null;
  if (oldFilesJson !== JSON.stringify(entries)) {
    const manifest = { generated: new Date().toISOString(), files: entries };
    mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`wrote ${relToRoot(MANIFEST_PATH)} (${entries.length} files)`);
  } else {
    log('manifest unchanged');
  }

  writeIfChanged(CREDITS_PATH, creditsMarkdown(), 'CREDITS.md');

  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  log(`done: ${entries.length} files tracked, ${fetched} source(s) fetched, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
}

main().catch((err) => {
  console.error('[fetch-assets] FAILED:', err.message ?? err);
  process.exit(1);
});
