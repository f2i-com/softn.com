/**
 * The Studio benchmark: what the editor does with a whole project on every
 * edit, measured on fixed fixtures. Run with `npm run bench` from
 * apps/softn-studio (it is not part of `npm test`: the main vitest config
 * includes only test/**). Prints a table and a JSON block; with
 * SOFTN_BENCH_OUT=<path> it also writes the JSON there.
 *
 * Measured per fixture:
 *   validateProject     — the validator App runs after every file change
 *   buildBundle(0/6)    — the archive, stored and deflated
 *   collectProjectRecord — one autosave's record, and its structured-clone
 *                          cost (what the IndexedDB put pays) and size
 *   buildSystemPromptWithRecord — the system prompt for an AI turn
 *
 * Each measure runs a few warm-ups and then N timed iterations; the median
 * and p95 are reported. The fixtures are deterministic; the timings are
 * this machine's.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { buildFixture, FIXTURES } from './fixtures';
import { validateProject } from '../src/lib/validator';
import { buildBundle } from '../src/lib/exportBundle';
import { beginNewProjectSession, collectProjectRecord } from '../src/lib/projectSession';
import { buildSystemPromptWithRecord } from '../src/lib/agentOrchestrator';
import { inferBlueprintFromFiles } from '../src/lib/studioProject';
import { useVFSStore, useWorkspaceStore } from '../src/stores';
import { PROJECT_SCHEMA_VERSION } from '../src/lib/persistence';

const ITERATIONS = Number(process.env.SOFTN_BENCH_ITERATIONS ?? 15);
const WARMUP = 3;

interface Timing {
  medianMs: number;
  p95Ms: number;
  minMs: number;
}

function time(fn: () => void): Timing {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return { medianMs: round(at(0.5)), p95Ms: round(at(0.95)), minMs: round(samples[0]) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface FixtureResult {
  fixture: string;
  files: number;
  textFiles: number;
  binaryFiles: number;
  bytes: number;
  measures: Record<string, Timing & Record<string, number>>;
}

function recordBytes(record: NonNullable<ReturnType<typeof collectProjectRecord>>): number {
  let bytes = 0;
  for (const f of record.files) bytes += typeof f.content === 'string' ? new TextEncoder().encode(f.content).length : f.content.length;
  const rest = { ...record, files: record.files.map((f) => ({ ...f, content: '' })) };
  return bytes + new TextEncoder().encode(JSON.stringify(rest)).length;
}

describe('Studio whole-project work per edit', () => {
  it('measures the fixed fixtures', () => {
    const results: FixtureResult[] = [];
    for (const spec of FIXTURES) {
      const fixture = buildFixture(spec);
      beginNewProjectSession();
      useVFSStore.getState().hydrateFiles([...fixture.files.values()].map((f) => ({ path: f.path, content: f.content })));
      const files = useVFSStore.getState().files;
      const blueprint = inferBlueprintFromFiles(`Bench ${spec.name}`, files);
      useWorkspaceStore.getState().setProjectName(`Bench ${spec.name}`);
      useWorkspaceStore.getState().setBlueprint(blueprint);

      const measures: FixtureResult['measures'] = {};
      const report = validateProject(files, blueprint);
      const count = (level: string) => report.filter((e) => e.level === level).length;
      measures.validateProject = { ...time(() => validateProject(files, blueprint)), errors: count('error'), warnings: count('warning'), infos: count('info') };
      measures['buildBundle(level 0)'] = { ...time(() => buildBundle(files, 0)), archiveBytes: buildBundle(files, 0).length };
      measures['buildBundle(level 6)'] = { ...time(() => buildBundle(files, 6)), archiveBytes: buildBundle(files, 6).length };
      const record = collectProjectRecord(1)!;
      if (record.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new Error('unexpected record schema');
      measures.collectProjectRecord = { ...time(() => collectProjectRecord(1)), recordBytes: recordBytes(record) };
      measures['structuredClone(record)'] = { ...time(() => structuredClone(record)), recordBytes: recordBytes(record) };
      const prompt = buildSystemPromptWithRecord();
      measures.buildSystemPromptWithRecord = { ...time(() => buildSystemPromptWithRecord()), systemChars: prompt.system.length, suppliedFiles: prompt.supplied.size };

      results.push({ fixture: spec.name, files: files.size, textFiles: fixture.textFiles, binaryFiles: fixture.binaryFiles, bytes: fixture.bytes, measures });
    }

    // The brief's line: a single measure over this on the medium fixture is
    // grounds for a fix. Reported so the results say whether one was due.
    const thresholdMs = 50;
    const medium = results.find((r) => r.fixture === 'medium');
    const overThreshold = medium ? Object.entries(medium.measures).filter(([, m]) => m.medianMs > thresholdMs).map(([name]) => name) : [];

    const output = {
      benchmark: 'apps/softn-studio/bench/studio.bench.ts',
      ranAt: new Date().toISOString(),
      iterations: ITERATIONS,
      warmup: WARMUP,
      thresholdMs,
      mediumMeasuresOverThreshold: overThreshold,
      machine: {
        os: `${os.version()} ${os.release()}`,
        platform: `${process.platform} ${process.arch}`,
        cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
        cores: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 1e9),
        node: process.version,
      },
      results,
    };

    const rows: string[] = [];
    const header = ['fixture', 'measure', 'median ms', 'p95 ms', 'min ms', 'detail'];
    rows.push(header.join(' | '));
    for (const r of results) {
      for (const [name, m] of Object.entries(r.measures)) {
        const { medianMs, p95Ms, minMs, ...detail } = m;
        rows.push([`${r.fixture} (${r.files} files, ${Math.round(r.bytes / 1024)} KB)`, name, medianMs.toFixed(2), p95Ms.toFixed(2), minMs.toFixed(2), JSON.stringify(detail)].join(' | '));
      }
    }
    const json = JSON.stringify(output, null, 2);
    // Straight to stdout: vitest keeps a passing test's console output to itself.
    process.stdout.write(`\n${rows.join('\n')}\n\n${json}\n`);
    const out = process.env.SOFTN_BENCH_OUT;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, json + '\n');
    }
  }, 600_000);
});
