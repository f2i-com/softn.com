/**
 * The workloads scripts/bench/measure.mjs opens, and how each becomes a bundle.
 *
 * A scenario is a folder under fixtures/ (manifest, permission declaration,
 * .ui and .logic files) plus whatever binary assets are generated at run time
 * — the GLB comes from glb.mjs rather than a committed model, so a diff of the
 * fixture is a diff of everything the measurement saw. The bundle is zipped
 * when the harness starts and served from a temp dir, never written into an
 * app's public/ folder.
 *
 * `ready` is evaluated inside the page, on every DOM mutation, and its first
 * true is the "app up" timestamp. `window.__softnBench.text()` is the page's
 * visible text gathered without the layout innerText would force, so the
 * observer costs nothing it is measuring; a scenario's fixture puts a
 * sentence in the document that only exists once the runtime has rendered it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { makeGlb } from './glb.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, 'fixtures');

const text = (needle) =>
  `(window.__softnBench ? window.__softnBench.text() : '').includes(${JSON.stringify(needle)})`;

export const SCENARIOS = {
  minimal: {
    title: 'Minimal text and form',
    description: 'A heading, a paragraph, an input and a button. No 3D.',
    fixture: 'minimal',
    generated: {},
    ready: text('Bench minimal is ready'),
    // What the acceptance criteria in the handoff say about the request list:
    // a minimal app must pull in nothing from the 3D stack.
    expectsHeavy: false,
  },
  'scene-glb': {
    title: 'Scene3D with one bundled GLB',
    description: 'One Scene3D, one bundled glTF binary, no effects, no orbit controls.',
    fixture: 'scene-glb',
    generated: { 'assets/models/tetra.glb': () => makeGlb() },
    ready: `!!document.querySelector('canvas') && ${text('Bench scene is ready')}`,
    expectsHeavy: true,
  },
  'scene-effects': {
    title: 'Scene3D with bloom',
    description: 'The scene-glb fixture with bloom on, so the post-processing path is exercised.',
    fixture: 'scene-effects',
    generated: { 'assets/models/tetra.glb': () => makeGlb() },
    ready: `!!document.querySelector('canvas') && ${text('Bench scene is ready')}`,
    expectsHeavy: true,
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Zip a scenario. Returns the archive and the entry list so a report can say
 * exactly what the runtime was handed.
 */
export function buildBundle(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario "${name}". Known: ${SCENARIO_NAMES.join(', ')}`);
  const dir = path.join(FIXTURES_DIR, scenario.fixture);
  const files = {};
  for (const rel of walk(dir)) files[rel] = new Uint8Array(fs.readFileSync(path.join(dir, rel)));
  for (const [rel, make] of Object.entries(scenario.generated)) files[rel] = make();
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  // The manifest lists what it ships; a fixture that forgets an asset would
  // otherwise measure a missing-file path and call it a model load.
  for (const listed of [...manifest.files.ui, ...manifest.files.logic, ...manifest.files.assets]) {
    if (!files[listed])
      throw new Error(`${name}: manifest lists ${listed} but the fixture has no such file`);
  }
  const bytes = zipSync(files, { level: 6 });
  return {
    name,
    manifest,
    bytes,
    entries: Object.entries(files).map(([entryPath, data]) => ({
      path: entryPath,
      bytes: data.length,
    })),
  };
}
