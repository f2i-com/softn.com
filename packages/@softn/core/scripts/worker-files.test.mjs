import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyWorkerFiles, moduleReferences, workerFiles } from './worker-files.mjs';

function dist(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-worker-files-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('softn-worker-files-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('names the relative files a module imports, statically or by a literal import(), and the files it names with URL()', () => {
  const text = [
    'import{a}from"../chunk-A.js";',
    'export * from "./chunk-B.js";',
    'import "../side.js";',
    'const later=()=>import("../lazy.js");',
    'const glue=new URL("zipp_wasm_bg.wasm", import.meta.url);',
    'import React from "react";',
    'const variable=new URL(path, import.meta.url);',
  ].join('\n');
  assert.deepEqual(moduleReferences(text).sort(), ['../chunk-A.js', '../lazy.js', '../side.js', './chunk-B.js', 'zipp_wasm_bg.wasm'].sort());
});

test('takes what the workers reach, the model files, torch and the licences, and nothing else', (t) => {
  const root = dist(t, {
    'runtime/script-worker.js': 'import{a}from"../chunk-A.js";const p=()=>import("../python-adapter.js");',
    'runtime/sandbox-worker.js': 'import"../chunk-A.js";',
    'runtime/model-worker.js': 'const k=new URL("./models/kernels.wasm", import.meta.url);',
    'runtime/models/kernels.wasm': 'k',
    'runtime/models/gguf_wasm_bg.wasm': 'g',
    'runtime/models/ZIPP-gpu-lab-LICENSE.txt': 'licence',
    'chunk-A.js': 'const glue=new URL("zipp_wasm_bg.wasm", import.meta.url);export const a=1;',
    'python-adapter.js': 'export {};',
    'zipp_torch.wasm': 'torch',
    'zipp-licenses.txt': 'licences',
    // What no worker reaches.
    'zipp_wasm_bg.wasm': 'engine',
    'index.js': 'import"./chunk-A.js";',
    'index.d.ts': 'export {};',
    'chunk-A.js.map': '{}',
    'host-js/index.js': 'export {};',
    'core-runtime/runtime/script-worker.js': 'an old mirror',
  });
  assert.deepEqual(workerFiles(root), [
    'chunk-A.js',
    'python-adapter.js',
    'runtime/model-worker.js',
    'runtime/models/ZIPP-gpu-lab-LICENSE.txt',
    'runtime/models/gguf_wasm_bg.wasm',
    'runtime/models/kernels.wasm',
    'runtime/sandbox-worker.js',
    'runtime/script-worker.js',
    'zipp-licenses.txt',
    'zipp_torch.wasm',
  ]);
  const out = path.join(root, 'copy');
  copyWorkerFiles(root, out);
  assert.equal(fs.readFileSync(path.join(out, 'chunk-A.js'), 'utf8'), fs.readFileSync(path.join(root, 'chunk-A.js'), 'utf8'));
  assert.equal(fs.existsSync(path.join(out, 'zipp_wasm_bg.wasm')), false);
  assert.equal(fs.existsSync(path.join(out, 'index.d.ts')), false);
});
