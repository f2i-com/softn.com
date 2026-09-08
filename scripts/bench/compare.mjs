#!/usr/bin/env node
/**
 * Put two measurements from measure.mjs side by side.
 *
 *   node scripts/bench/compare.mjs <before> <after> [--out file.md]
 *
 * `before` and `after` are labels under scripts/bench/results/ or paths to
 * directories holding a summary.json. For every host and scenario the two
 * have in common, one table per pass (cold, warm) lists the medians and
 * nearest-rank p90s of both, the difference, and — beneath each table — the
 * rows where the later measurement is worse, so a regression is a line in
 * the output rather than something to notice in a column of numbers. The
 * `softn:` phase marks are compared only where both measurements have them;
 * marks one side alone made are listed, not compared.
 *
 * "Worse" means a higher median where lower is better (everything here:
 * bytes, requests, milliseconds, long tasks, errors) by more than noise —
 * 5 % and an absolute floor of 1 KB, 5 ms or one request. A count of runs
 * (ready, 3D module URL requested, 3D code inside loaded JS) is shown as
 * x/N and judged on its own line. The environment blocks are printed first
 * so a reader can see whether the two are comparable at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
if (positional.length !== 2) {
  console.error('usage: node scripts/bench/compare.mjs <before> <after> [--out file.md]');
  process.exit(2);
}

function load(ref) {
  const dir = fs.existsSync(path.join(ref, 'summary.json')) ? ref : path.join(here, 'results', ref);
  const file = path.join(dir, 'summary.json');
  if (!fs.existsSync(file)) throw new Error(`${ref}: no summary.json at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const before = load(positional[0]);
const after = load(positional[1]);

// Lower is better for every row; the tuple is [key, label, kind] where kind
// picks the formatter and the noise floor.
const ROWS = [
  ['requests', 'page requests', 'count'],
  ['bytes', 'page bytes on the wire', 'bytes'],
  ['contentBytes', 'page bytes loaded (content-length, cached or not)', 'bytes'],
  ['jsBytes', 'JS bytes on the wire', 'bytes'],
  ['wasmBytes', 'wasm bytes on the wire', 'bytes'],
  ['cssBytes', 'CSS bytes on the wire', 'bytes'],
  ['requestsUntilReady', 'page requests until ready', 'count'],
  ['bytesUntilReady', 'page bytes until ready', 'bytes'],
  ['serviceWorkerRequests', 'service worker requests', 'count'],
  ['serviceWorkerBytes', 'service worker bytes on the wire', 'bytes'],
  ['serviceWorkerContentBytes', 'service worker bytes loaded (content-length)', 'bytes'],
  ['workerRequests', 'dedicated worker requests', 'count'],
  ['longTasks', 'long tasks', 'count'],
  ['longTaskMs', 'long task total (ms)', 'ms'],
  ['longTaskMaxMs', 'longest task (ms)', 'ms'],
  ['readyMs', 'app ready (ms)', 'ms'],
  ['firstPaintMs', 'first paint (ms)', 'ms'],
  ['firstContentfulPaintMs', 'first contentful paint (ms)', 'ms'],
  ['responseEndMs', 'document responseEnd (ms)', 'ms'],
  ['domContentLoadedMs', 'DOMContentLoaded (ms)', 'ms'],
  ['loadEventEndMs', 'load event end (ms)', 'ms'],
  ['webglContextAtMs', 'first WebGL context (ms)', 'ms'],
  ['firstDrawAtMs', 'first GL draw (ms)', 'ms'],
  ['scriptMs', 'script time (ms)', 'ms'],
  ['taskMs', 'main-thread task time (ms)', 'ms'],
  ['jsHeapUsedMb', 'JS heap used (MB)', 'mb'],
  ['uncaughtErrors', 'uncaught errors', 'count'],
];

const FLOOR = { count: 1, bytes: 1024, ms: 5, mb: 0.5 };

const fmt = (kind, n) => {
  if (n === null || n === undefined) return '—';
  if (kind === 'bytes') return `${(n / 1024).toFixed(1)} KB`;
  if (kind === 'mb') return n.toFixed(1);
  if (kind === 'ms') return String(Math.round(n));
  return String(Math.round(n * 10) / 10);
};

const delta = (kind, a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return '—';
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  if (kind === 'bytes') return `${sign}${(d / 1024).toFixed(1)} KB`;
  if (kind === 'mb') return `${sign}${d.toFixed(1)}`;
  if (kind === 'ms') return `${sign}${Math.round(d)}`;
  return `${sign}${Math.round(d * 10) / 10}`;
};

/** A later median that is higher by more than noise. */
function worse(kind, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const d = b - a;
  if (d < FLOOR[kind]) return false;
  return a === 0 ? true : d / a > 0.05;
}

const lines = [];
const push = (...l) => lines.push(...l);

push(`# ${before.label} → ${after.label}`, '');

for (const [hostName, afterHost] of Object.entries(after.hosts)) {
  const beforeHost = before.hosts[hostName];
  push(`## Host: ${hostName}`, '');
  if (!beforeHost) {
    push(`_${before.label} has no measurement of this host._`, '');
    continue;
  }
  const envRow = (label, env) =>
    `| ${label} | ${env.git.revision}${env.git.dirty ? ' (dirty)' : ''} | ${env.package} | ${env.browser} | ${env.cpu} | ${env.os} | ${env.node} | ${env.options.runs} |`;
  push(
    '| measurement | git | package | browser | CPU | OS | Node | runs |',
    '|---|---|---|---|---|---|---|---:|',
    envRow(before.label, beforeHost.environment),
    envRow(after.label, afterHost.environment),
    ''
  );
  for (const [scenarioName, afterScenario] of Object.entries(afterHost.scenarios)) {
    const beforeScenario = beforeHost.scenarios[scenarioName];
    push(`### ${scenarioName} — ${afterScenario.title}`, '');
    if (!beforeScenario) {
      push(`_${before.label} has no measurement of this scenario._`, '');
      continue;
    }
    for (const pass of ['cold', 'warm']) {
      const a = beforeScenario[pass];
      const b = afterScenario[pass];
      push(`#### ${pass}`, '');
      const flags = [
        ['ready', 'ready'],
        ['heavyFeatureRequested', '3D module URL requested'],
        ['heavyCodeLoaded', '3D code inside loaded JS'],
        ['serviceWorkerControlled', 'service worker controlling'],
      ];
      push(`| runs | ${before.label} | ${after.label} |`, '|---|---:|---:|');
      for (const [key, label] of flags) {
        push(`| ${label} | ${a[key]}/${a.runs} | ${b[key]}/${b.runs} |`);
      }
      push('');
      push(
        `| metric | ${before.label} median | ${after.label} median | Δ median | ${before.label} p90 | ${after.label} p90 | Δ p90 |`,
        '|---|---:|---:|---:|---:|---:|---:|'
      );
      const regressions = [];
      for (const [key, label, kind] of ROWS) {
        const ma = a.metrics[key];
        const mb = b.metrics[key];
        if (!ma && !mb) continue;
        push(
          `| ${label} | ${fmt(kind, ma?.median)} | ${fmt(kind, mb?.median)} | ${delta(kind, ma?.median, mb?.median)} | ${fmt(kind, ma?.p90)} | ${fmt(kind, mb?.p90)} | ${delta(kind, ma?.p90, mb?.p90)} |`
        );
        if (worse(kind, ma?.median, mb?.median)) {
          regressions.push(
            `${label}: ${fmt(kind, ma.median)} → ${fmt(kind, mb.median)} (${delta(kind, ma.median, mb.median)})`
          );
        }
      }
      push('');
      const markNames = Object.keys(a.marks)
        .filter((m) => m in b.marks)
        .sort();
      if (markNames.length) {
        push(
          `| phase (softn: marks, ms) | ${before.label} median | ${after.label} median | Δ median | ${before.label} p90 | ${after.label} p90 | Δ p90 |`,
          '|---|---:|---:|---:|---:|---:|---:|'
        );
        for (const m of markNames) {
          const ma = a.marks[m];
          const mb = b.marks[m];
          push(
            `| ${m} | ${fmt('ms', ma.median)} | ${fmt('ms', mb.median)} | ${delta('ms', ma.median, mb.median)} | ${fmt('ms', ma.p90)} | ${fmt('ms', mb.p90)} | ${delta('ms', ma.p90, mb.p90)} |`
          );
          if (worse('ms', ma.median, mb.median)) {
            regressions.push(
              `${m}: ${fmt('ms', ma.median)} → ${fmt('ms', mb.median)} ms (${delta('ms', ma.median, mb.median)})`
            );
          }
        }
        push('');
      }
      const onlyAfter = Object.keys(b.marks)
        .filter((m) => !(m in a.marks))
        .sort();
      const onlyBefore = Object.keys(a.marks)
        .filter((m) => !(m in b.marks))
        .sort();
      if (onlyAfter.length) {
        push(
          `Phases measured only in ${after.label}: ${onlyAfter
            .map(
              (m) => `${m} ${fmt('ms', b.marks[m].median)} ms (p90 ${fmt('ms', b.marks[m].p90)})`
            )
            .join('; ')}.`,
          ''
        );
      }
      if (onlyBefore.length) {
        push(`Phases measured only in ${before.label}: ${onlyBefore.join(', ')}.`, '');
      }
      const points = Object.keys(b.markPoints ?? {}).sort();
      if (points.length) {
        push(
          `Points in time in ${after.label} (ms from navigation, median): ${points
            .map((m) => `${m} ${fmt('ms', b.markPoints[m].median)}`)
            .join('; ')}.`,
          ''
        );
      }
      if (b.heavyUrls?.length) {
        push(
          `3D module URLs requested in ${after.label}: ${b.heavyUrls.map((u) => `\`${u}\``).join(', ')}.`,
          ''
        );
      }
      const heavy = Object.entries(b.heavyCode ?? {});
      if (heavy.length) {
        push(
          `Scripts carrying 3D code in ${after.label}: ${heavy
            .map(([feature, urls]) => `${feature} in ${urls.map((u) => `\`${u}\``).join(', ')}`)
            .join('; ')}.`,
          ''
        );
      }
      if (a.heavyFeatureRequested < b.heavyFeatureRequested) {
        regressions.push(
          `3D module URL requested in ${b.heavyFeatureRequested}/${b.runs} runs, was ${a.heavyFeatureRequested}/${a.runs}` +
            (afterScenario.expectsHeavy
              ? ' — expected: this scenario asks for a scene, and the 3D code is now a separate chunk it has to request'
              : '')
        );
      }
      if (a.ready > b.ready)
        regressions.push(`ready in ${b.ready}/${b.runs} runs, was ${a.ready}/${a.runs}`);
      push(
        regressions.length
          ? `**Worse in ${after.label} (${pass}):** ${regressions.join('; ')}.`
          : `**Nothing worse in ${after.label} (${pass}) beyond noise.**`,
        ''
      );
    }
  }
}

const text = lines.join('\n');
if (outFile) {
  fs.writeFileSync(outFile, text);
  console.log(`Wrote ${outFile}`);
} else {
  process.stdout.write(text);
}
