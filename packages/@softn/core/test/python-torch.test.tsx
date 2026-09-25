/**
 * A Python app that trains a model with torch, on the engine it will run on.
 *
 * The engine Softn ships is ZIPP's `web-python-base`, which has no torch
 * built in; ZIPP publishes torch as a package (`zipp_torch.wasm`), and the
 * runtime adds it — once per page — when an app declares it. A Softn app then
 * reaches it the way it reaches any module: `import torch` in a `.py` file.
 * What is pinned here is that a declaring app gets the package added and
 * trains through the same `SoftNScriptRuntime` and per-entry budget every
 * Python app gets — torch's modules compile on their first import, which is
 * by far the most expensive thing an app's top level can do, and that must
 * fit inside one entry — and that tensors stay inside Python while the plain
 * numbers an app keeps as state are mirrored as usual.
 *
 * There is no server here to fetch the package from, so it is supplied as
 * the installed bytes, as a host that holds them would
 * (`configureZippTorchSource`); a browser fetches the same file from beside
 * core's chunk. `python-torch-on-demand.test.ts` pins when it is loaded.
 *
 * Declaring torch in `manifest.json` is the composer's business and is pinned
 * in `python-packages.test.ts`; this file drives the runtime directly.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configureZippTorchSource, zippPythonPackages } from '../src/runtime/zipp-wasm-loader';
import { pythonPackages } from '../wasm-zipp/zipp_wasm.js';
import {
  createConsoleModule,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type ScriptContext,
} from '../src/runtime/script-runtime';
import type { ScriptBlock } from '../src/parser/ast';

const EMPTY_LOGIC: ScriptBlock = {
  type: 'ScriptBlock',
  code: '',
  loc: { line: 1, column: 0, start: 0, end: 0 },
};

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

const TRAINER = `import torch
import torch.nn as nn

torch.manual_seed(0)
xs = torch.tensor([[0.0], [1.0], [2.0], [3.0]])
ys = xs * 2.0 + 1.0
model = nn.Linear(1, 1)
optimizer = torch.optim.SGD(model.parameters(), lr=0.05)

loss = 0.0
steps = 0

def train(n):
    global loss, steps
    for _ in range(n):
        optimizer.zero_grad()
        current = ((model(xs) - ys) ** 2).mean()
        current.backward()
        optimizer.step()
        loss = float(current)
        steps = steps + 1
    return loss

def predict(value):
    with torch.no_grad():
        return float(model(torch.tensor([[float(value)]]))[0][0])
`;

configureZippTorchSource(readFileSync('wasm-zipp-torch/zipp_torch.wasm'));

describe('torch in a Python app', () => {
  it('runs on an engine without torch built in, until an app declares it', async () => {
    const report = JSON.parse(pythonPackages()) as { torchBuiltIn: boolean; installed: unknown[] };
    expect(report.torchBuiltIn).toBe(false);
    expect(report.installed).toEqual([]);
    expect(await zippPythonPackages()).not.toContain('torch');
  });

  it('gets the package added, imports torch, trains, and mirrors the numbers it keeps as state', async () => {
    const runtime = createScriptRuntime(makeContext(), undefined, 'python-torch-test', undefined, undefined, {
      mode: 'main',
      pythonProject: { files: { trainer: TRAINER }, modules: ['trainer'], packages: ['torch'] },
    });
    const loaded = await runtime.loadScript(EMPTY_LOGIC);

    // Tensors, the model and the optimizer are objects nothing could mirror;
    // the plain numbers are state like any other.
    expect(loaded.state).toEqual({ loss: 0, steps: 0 });
    const first = (await loaded.functions.train(1)) as number;
    const later = (await loaded.functions.train(200)) as number;
    expect(later).toBeLessThan(first);
    expect(later).toBeLessThan(0.05);
    // y = 2x + 1, learned: 2*10 + 1.
    expect(loaded.syncFunctions.predict(10)).toBeCloseTo(21, 0);
    runtime.cleanup();
    // Added to the engine, not built into it.
    const report = JSON.parse(pythonPackages()) as { torchBuiltIn: boolean; installed: { name: string }[] };
    expect(report.torchBuiltIn).toBe(false);
    expect(report.installed.map((entry) => entry.name)).toEqual(['torch']);
  }, 60_000);
});
