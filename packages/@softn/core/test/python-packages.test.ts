/**
 * Python packages an app declares in `manifest.json`: `config.python.packages`.
 *
 * torch is the one package the runtime offers. It is opt-in, so the composer
 * holds a Python app to its declaration — an `import torch` the manifest does
 * not declare is refused with the line to add, before anything compiles — and
 * the inspector refuses a declaration naming a package the runtime does not
 * have. A declared package reaches the runtime through `python.packages`, and
 * the engine the repository vendors provides torch once the package installed
 * beside it (wasm-zipp-torch/) is added, which the runtime does on demand
 * (python-torch-on-demand.test.ts).
 */

import { readFileSync } from 'node:fs';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { composeBundleSource, pythonModuleName, reservedPythonModuleReason } from '../src/bundle/source-composer';
import { inspectEntries, readPythonPackages } from '../src/bundle/inspect';
import { configureZippTorchSource, ensureZippTorch, zippPythonPackages } from '../src/runtime/zipp-wasm-loader';

const MAIN_UI = '<logic src="../logic/main.py" />\n<Text>{loss}</Text>';

function bundle(manifest: object, main: string): Map<string, string> {
  return new Map([
    ['manifest.json', JSON.stringify(manifest)],
    ['ui/main.ui', MAIN_UI],
    ['logic/main.py', main],
  ]);
}

const TORCH = { name: 'Trainer', version: '1.0.0', main: 'ui/main.ui', config: { python: { packages: ['torch'] } } };
const PLAIN = { name: 'Trainer', version: '1.0.0', main: 'ui/main.ui' };

describe('config.python.packages', () => {
  it('passes a declared package to the runtime with the project', () => {
    const composed = composeBundleSource(bundle(TORCH, 'import torch\nloss = 0.0\n'), 'ui/main.ui');
    expect(composed.python?.packages).toEqual(['torch']);
  });

  it('declares nothing when the manifest says nothing', () => {
    const composed = composeBundleSource(bundle(PLAIN, 'loss = 0.0\n'), 'ui/main.ui');
    expect(composed.python?.packages).toEqual([]);
  });

  it('refuses an import of torch the manifest does not declare, naming the line to add', () => {
    for (const statement of ['import torch', 'import torch.nn as nn', 'from torch import nn', 'import math, torch', '    import torch']) {
      const code = statement.startsWith(' ') ? `def f():\n${statement}\n    return 1\n` : `${statement}\nloss = 0.0\n`;
      expect(() => composeBundleSource(bundle(PLAIN, code), 'ui/main.ui'), statement).toThrow(
        'logic/main.py imports torch, which an app asks for in manifest.json: "config": { "python": { "packages": ["torch"] } }'
      );
    }
  });

  it('does not mistake a name that only contains torch for an import of it', () => {
    for (const code of ['import torchvision_like_name\n', '# import torch later\nx = 1\n', 'torch_count = 1\n', 'import mytorch\n']) {
      expect(() => composeBundleSource(bundle(PLAIN, code), 'ui/main.ui'), code).not.toThrow();
    }
  });

  it('refuses a package the runtime does not offer, in the composer and the inspector alike', () => {
    const misspelt = { ...PLAIN, config: { python: { packages: ['pytorch'] } } };
    expect(() => composeBundleSource(bundle(misspelt, 'loss = 0.0\n'), 'ui/main.ui')).toThrow(
      'manifest.json config.python.packages names "pytorch"; the runtime offers torch.'
    );

    const entries = new Map([...bundle(misspelt, 'loss = 0.0\n')].map(([path, text]) => [path, strToU8(text)]));
    expect(inspectEntries(entries).problem).toBe('manifest.json config.python.packages names "pytorch"; the runtime offers torch.');
    const declared = new Map([...bundle(TORCH, 'import torch\n')].map(([path, text]) => [path, strToU8(text)]));
    expect(inspectEntries(declared).pythonPackages).toEqual(['torch']);
  });

  it('reads only a list of names, and each name once', () => {
    expect(readPythonPackages({ config: { python: { packages: ['torch', 'torch'] } } })).toEqual({ packages: ['torch'], problems: [] });
    expect(readPythonPackages({ config: { python: { packages: 'torch' } } }).problems).toEqual([
      'manifest.json config.python.packages must be a list of package names, such as ["torch"].',
    ]);
    expect(readPythonPackages({ config: { python: ['torch'] } }).problems).toEqual([
      'manifest.json config.python must be an object, such as { "packages": ["torch"] }.',
    ]);
    expect(readPythonPackages({})).toEqual({ packages: [], problems: [] });
  });

  it('reserves torch as a module name, so an app file cannot shadow the package', () => {
    expect(reservedPythonModuleReason('torch')).toBe('it is the torch package the runtime provides');
    expect(() => pythonModuleName('logic/torch.py')).toThrow(/reserved module name torch\.py/);
  });

  it('is provided by the engine the repository vendors, with the package installed beside it added', async () => {
    // web-python-base: no torch built in.
    expect(await zippPythonPackages()).not.toContain('torch');
    configureZippTorchSource(readFileSync('wasm-zipp-torch/zipp_torch.wasm'));
    await ensureZippTorch();
    expect(await zippPythonPackages()).toContain('torch');
  });
});
