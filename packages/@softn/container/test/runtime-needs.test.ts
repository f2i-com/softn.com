/**
 * What an app will ask the runtime for, read from its files: for a host that installs an app
 * before the network goes. The rules are the ones the container applies page by page when it
 * runs the app; these hold the two to the same answers.
 */
import { describe, it, expect, vi } from 'vitest';
import { containerRuntimeNeeds, engineFileFor, glueFileFor, preloadContainerFeatures } from '../src/index';

const page = (body: string, head = '') => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;

describe('what an app needs of the runtime, from its files', () => {
  it('the lite engine and nothing more, for a page of plain script', async () => {
    const needs = await containerRuntimeNeeds({ 'index.html': page('<p id="out"></p><script>document.title = "x";</script>') });
    expect(needs).toEqual({ tiers: ['lite'], three: false, models: false, extensions: [] });
  });

  it('every tier a page of the app starts on, each once', async () => {
    const needs = await containerRuntimeNeeds({
      'index.html': page('<a href="./prices.html">Prices</a><script>document.title = "home";</script>'),
      // Formats a number: the full engine, for this page alone.
      'prices.html': page('<script>document.title = (1234.5).toLocaleString("en-US");</script>'),
      'about.html': page('<script>document.title = "about";</script>'),
    });
    expect([...needs.tiers].sort()).toEqual(['javascript', 'lite']);
  });

  it('the TypeScript engine for an app with TypeScript, and the Python one for a page that runs Python', async () => {
    expect(
      (await containerRuntimeNeeds({ 'index.html': page('<script type="module" src="./app.ts"></script>'), 'app.ts': 'const n: number = 1; document.title = String(n);' })).tiers
    ).toEqual(['typescript']);
    expect(
      (await containerRuntimeNeeds({ 'index.html': page('<script type="text/python">print("hello")</script>') })).tiers
    ).toEqual(['python']);
  });

  it('the page’s side of a 3D scene when a script imports three, and the model loader when there is a model', async () => {
    const scene = 'import * as THREE from "three";\nnew THREE.Scene();';
    const drawn = await containerRuntimeNeeds({ 'index.html': page('<canvas id="gl"></canvas><script type="module" src="./scene.js"></script>'), 'scene.js': scene });
    expect(drawn).toMatchObject({ three: true, models: false });
    const withModel = await containerRuntimeNeeds({
      'index.html': page('<canvas id="gl"></canvas><script type="module" src="./scene.js"></script>'),
      'scene.js': scene,
      'models/rover.glb': new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    });
    expect(withModel).toMatchObject({ three: true, models: true });
    // A word in a sentence is not an import.
    const prose = await containerRuntimeNeeds({ 'index.html': page('<p>One, two, three.</p><script>var three = 3;</script>') });
    expect(prose.three).toBe(false);
    // An import in a page's own script counts, and so does one written with import().
    expect((await containerRuntimeNeeds({ 'index.html': page('<script type="module">import { Scene } from "three";</script>') })).three).toBe(true);
    expect((await containerRuntimeNeeds({ 'index.html': page('<script type="module">const T = await import("three");</script>') })).three).toBe(true);
  });

  it('the built-in elements a page or a script names', async () => {
    const needs = await containerRuntimeNeeds({
      'index.html': page('<softn-chart type="bar"></softn-chart><script src="./grid.js"></script>'),
      'grid.js': 'document.body.appendChild(document.createElement("softn-datagrid"));',
    });
    expect(needs.extensions).toEqual(['softn-chart', 'softn-datagrid']);
    expect((await containerRuntimeNeeds({ 'index.html': page('<softn-chart></softn-chart>') })).extensions).toEqual(['softn-chart']);
  });

  it('reads an archive as it reads a folder of files, and leaves a picture closed', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const picture = new Uint8Array(64 * 1024).fill(7);
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Zipped', version: '1.0.0', engine: 2, main: 'index.html' })),
      'index.html': strToU8(page('<img src="./big.png" alt=""><script>new Intl.NumberFormat("en").format(1);</script>')),
      'big.png': picture,
    });
    expect(await containerRuntimeNeeds(archive)).toEqual({ tiers: ['javascript'], three: false, models: false, extensions: [] });
    expect(await containerRuntimeNeeds(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength))).toMatchObject({ tiers: ['javascript'] });
  });
});

describe('the files of the runtime folder, by tier', () => {
  it('names each tier’s engine and the bindings that go with it', () => {
    expect(engineFileFor('lite')).toBe('zipp-javascript-lite.wasm');
    expect(engineFileFor('typescript')).toBe('zipp-typescript.wasm');
    expect(engineFileFor('python')).toBe('zipp-python-base.wasm');
    expect(glueFileFor('lite', null)).toBe('zipp-javascript-lite.glue.js');
    expect(glueFileFor('typescript', null)).toBe('zipp-typescript.glue.js');
  });
});

describe('loading what the container fetches on first use', () => {
  it('asks the host for its Three.js, and loads nothing an app does not need', async () => {
    const hostThree = vi.fn(async () => ({ REVISION: 'host' }));
    expect(await preloadContainerFeatures({ three: false, models: false, extensions: [] }, { hostThree })).toEqual([]);
    expect(hostThree).not.toHaveBeenCalled();
    expect(await preloadContainerFeatures({ three: true, models: false, extensions: ['softn-chart'] }, { hostThree })).toEqual([]);
    expect(hostThree).toHaveBeenCalledTimes(1);
  });

  it('names what did not arrive, and still loads the rest', async () => {
    const hostThree = vi.fn(async () => {
      throw new Error('offline');
    });
    const missing = await preloadContainerFeatures({ three: true, models: false, extensions: ['softn-datagrid'] }, { hostThree });
    expect(missing).toEqual(['Three.js']);
  });
});
