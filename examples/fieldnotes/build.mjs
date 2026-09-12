// Rebuild the public example from editable source and fictional seed records.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
const root = new URL('./', import.meta.url);
const stamp = '2026-09-12T09:00:00.000Z';
const tasks = [
  ['Sketch the welcome screen', 'Design', false],
  ['Make the task form', 'Build', false],
  ['Test on a smaller screen', 'Review', false],
  ['Connect the dashboard', 'Build', true],
  ['Find a little inspiration', 'Design', true],
];
const files = {
  'manifest.json': JSON.stringify({ id: 'softn-fieldnotes-example', name: 'Fieldnotes', version: '1.0.0', description: 'A small working example: form → collection → dashboard.', main: 'ui/main.ui', files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'], xdb: ['xdb/tasks.xdb'], assets: [] }, config: { theme: { mode: 'system' } } }),
  'permission.json': JSON.stringify({ permissions: {} }),
  'ui/main.ui': await readFile(new URL('ui/main.ui', root), 'utf8'),
  'logic/main.logic': await readFile(new URL('logic/main.logic', root), 'utf8'),
  'xdb/tasks.xdb': JSON.stringify({ collection: 'tasks', schema: { alias: 'tasks', fields: [{ name: 'title', type: 'string', required: true }, { name: 'lane', type: 'string' }, { name: 'done', type: 'boolean' }] }, records: tasks.map(([title, lane, done], i) => ({ id: `fieldnotes-task-${i + 1}`, collection: 'tasks', data: { title, lane, done }, created_at: stamp, updated_at: stamp })) }),
  'README.md': await readFile(new URL('README.md', root), 'utf8'),
};
const output = new URL('../../apps/softn-site/public/examples/', root);
await mkdir(output, { recursive: true });
await writeFile(new URL('Fieldnotes.softn', output), zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { level: 9, mtime: new Date(stamp) }));
console.log('Built apps/softn-site/public/examples/Fieldnotes.softn');
