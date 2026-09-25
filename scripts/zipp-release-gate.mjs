#!/usr/bin/env node
/**
 * The release gate's ZIPP decision: which ZIPP release a SoftN release ships,
 * frozen once for every job of the run.
 *
 *   node scripts/zipp-release-gate.mjs [--allow-older-zipp]
 *
 * Every commit builds against the release its apps/softn-host-rust/Cargo.toml
 * zipp-vm tag declares, so a new ZIPP release never changes a commit's CI.
 * A SoftN release is where "latest" is asked: it ships only when ZIPP's latest
 * release is that tag, so the browser engine and the Rust host of a tag are
 * the newest ZIPP and the same one. allow-older-zipp (ALLOW_OLDER_ZIPP=true)
 * ships the declared release anyway when it is not the latest (usually older;
 * newer when the tag is a pre-release, which `latest` never names), provided
 * it is published with the bundles an install takes (web-python-base, web and
 * web-torch); the release notes say so.
 *
 * Writes to GITHUB_OUTPUT: zipp-release (the declared tag), zipp-sums-sha256
 * (the digest of that release's SHA256SUMS, which every later install must
 * see), zipp-latest and zipp-older-allowed (true when the declared release is
 * not the latest); and a line to GITHUB_STEP_SUMMARY. Node built-ins only, so
 * the gate needs no npm ci.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARGO_TOML, ZippReleaseError, compareReleases, declaredRelease, resolveRelease, sha256 } from '../packages/@softn/core/scripts/fetch-zipp-release.mjs';

/** The frozen ZIPP release for this run, as GitHub step outputs. Refuses with ZippReleaseError. */
export async function zippReleaseGate({ cargoToml = CARGO_TOML, allowOlder = false, fetch: fetchImpl = globalThis.fetch } = {}) {
  const declared = declaredRelease(cargoToml);
  const latest = await resolveRelease({ latest: true, fetch: fetchImpl });
  let sums = latest.sums;
  const order = compareReleases(declared, latest.release);
  if (order !== 0) {
    if (!allowOlder) {
      throw new ZippReleaseError(
        order < 0
          ? `ZIPP ${latest.release} is published; bump apps/softn-host-rust/Cargo.toml zipp-vm tag and Cargo.lock, or release with allow-older-zipp`
          : `apps/softn-host-rust/Cargo.toml declares ZIPP ${declared}, but ZIPP's latest release is ${latest.release}; release once ${declared} is the latest, or release with allow-older-zipp`,
      );
    }
    // Not the latest: that tag's own SHA256SUMS, which must list the bundles an install takes.
    sums = (await resolveRelease({ tag: declared, fetch: fetchImpl })).sums;
  }
  return {
    'zipp-release': declared,
    'zipp-sums-sha256': sha256(sums),
    'zipp-latest': latest.release,
    'zipp-older-allowed': String(order !== 0),
  };
}

/** `key=value` lines, the GITHUB_OUTPUT format for single-line values. */
export const outputLines = (outputs) => Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join('');

export function summaryLine(outputs) {
  const older = outputs['zipp-older-allowed'] === 'true' ? `, not the latest release ${outputs['zipp-latest']} (allow-older-zipp)` : ', the latest release';
  return `ZIPP release: ${outputs['zipp-release']}${older}; SHA256SUMS sha256 ${outputs['zipp-sums-sha256']}\n`;
}

async function main(args, env = process.env) {
  if (args.some((a) => a !== '--allow-older-zipp')) throw new ZippReleaseError('Usage: node scripts/zipp-release-gate.mjs [--allow-older-zipp]');
  const allowOlder = args.includes('--allow-older-zipp') || /^(1|true)$/i.test(env.ALLOW_OLDER_ZIPP ?? '');
  const outputs = await zippReleaseGate({ allowOlder });
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputLines(outputs));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryLine(outputs));
  process.stdout.write(summaryLine(outputs));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    if (!(error instanceof ZippReleaseError)) throw error;
    console.error(`zipp-release-gate: ${error.message}`);
    process.exitCode = 1;
  });
}
