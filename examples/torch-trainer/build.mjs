// Build TorchTrainer.softn from the editable source beside this file.
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';

const root = new URL('./', import.meta.url);
const stamp = '2026-09-25T09:00:00.000Z';
const files = {
  'manifest.json': JSON.stringify(
    {
      id: 'softn-torch-trainer-example',
      name: 'Torch Trainer',
      version: '1.0.0',
      description: 'A one-neuron network learns y = 2x + 1, in Python with torch.',
      main: 'ui/main.ui',
      files: { ui: ['ui/main.ui'], logic: ['logic/main.py'], xdb: [], assets: [] },
      // torch is opt-in: an app that imports it declares it here.
      config: { python: { packages: ['torch'] } },
    },
    null,
    2
  ),
  'permission.json': JSON.stringify({ permissions: {} }),
  'ui/main.ui': await readFile(new URL('ui/main.ui', root), 'utf8'),
  'logic/main.py': await readFile(new URL('logic/main.py', root), 'utf8'),
  'README.md': await readFile(new URL('README.md', root), 'utf8'),
};
const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { level: 9, mtime: new Date(stamp) });
await writeFile(new URL('TorchTrainer.softn', root), zipped);
console.log('Built examples/torch-trainer/TorchTrainer.softn');
