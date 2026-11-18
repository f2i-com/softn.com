import { addFormLogicBackend, isRecord, parseManifest } from '@softn/editor-shared/formlogicBackend';
import { createTableMigration, type HostedTableColumn } from '@softn/editor-shared/hostedDatabase';
import type { VFSFile } from '../types/studio';

export const fieldKinds = ['string', 'number', 'integer', 'boolean', 'date', 'email', 'url'] as const;
export type DatabaseTarget = 'local' | 'formlogic';

/** Only decode/read project text used by the designer. Retain every path for collision checks. */
export function databaseFiles(files: Map<string, VFSFile>) {
  const sources: Record<string, string> = Object.create(null);
  for (const [path, file] of files) {
    if ((path === 'manifest.json' || /^server\//i.test(path) || /\.xdb$/i.test(path)) && typeof file.content !== 'string') {
      throw new Error(`Restore ${path} as a text file before editing this database.`);
    }
    sources[path] = typeof file.content === 'string' ? file.content : '';
  }
  if (!Object.hasOwn(sources, 'manifest.json')) throw new Error('Create an app with a manifest.json before designing its database.');
  return sources;
}

function identifier(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(value) || ['constructor','prototype','__proto__'].includes(value.toLowerCase())) {
    throw new Error(`Use a letter followed by letters, numbers or underscores for the ${label}.`);
  }
  return value;
}

export function designDatabase(files: Record<string, string>, target: unknown, rawName: unknown, rawFields: unknown) {
  const name = identifier(rawName, 'database name');
  if (!Array.isArray(rawFields) || rawFields.length > 100) throw new Error('Supply a list of up to 100 fields.');
  const used = new Set<string>();
  const fields = rawFields.map(item => {
    if (!isRecord(item)) throw new Error('Each field needs a name and type.');
    const key = identifier(item.name, 'field name');
    if (used.has(key.toLowerCase())) throw new Error(`The field ${key} is repeated.`);
    used.add(key.toLowerCase());
    const type = fieldKinds.find(kind => kind === item.type);
    if (!type) throw new Error(`Choose a supported type for ${key}.`);
    if (item.required !== undefined && typeof item.required !== 'boolean') throw new Error('required must be a boolean.');
    return { name: key, type, required: item.required === true };
  });
  const manifest = parseManifest(files['manifest.json']);
  if (target === 'formlogic') {
    const prepared = addFormLogicBackend(manifest, Object.keys(files));
    const project = { ...files, ...prepared.files, 'manifest.json': JSON.stringify(prepared.manifest) };
    const storageTypes: Record<typeof fieldKinds[number], HostedTableColumn['type']> = {
      string: 'TEXT', date: 'TEXT', email: 'TEXT', url: 'TEXT', integer: 'INTEGER', number: 'REAL', boolean: 'BOOLEAN',
    };
    const migration = createTableMigration(project, { name, columns: fields.map(f => ({ ...f, type: storageTypes[f.type] })) });
    return { path: migration.path, changes: { ...prepared.files, [migration.path]: migration.sql, 'manifest.json': migration.manifest } };
  }
  if (target !== 'local') throw new Error('Choose local or formlogic storage.');
  const path = `xdb/${name}.xdb`;
  if ('files' in manifest && !isRecord(manifest.files)) throw new Error('Check the files object in manifest.json.');
  const groups = isRecord(manifest.files) ? manifest.files : {};
  const listed = groups.xdb ?? [];
  if (!Array.isArray(listed) || !listed.every(p => typeof p === 'string')) throw new Error('manifest.files.xdb must be a list of paths.');
  // Existing collections may be stored under a different filename. Never seed the same collection twice.
  for (const [other, text] of Object.entries(files)) {
    if (!/\.xdb$/i.test(other)) continue;
    let collection;
    try { collection = JSON.parse(text); } catch { throw new Error(`Check the seed file ${other} before creating another collection.`); }
    if ([other.split('/').pop()?.slice(0, -4), collection?.collection, collection?.schema?.alias].some(v => typeof v === 'string' && v.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A collection named ${name} already exists in ${other}.`);
    }
  }
  if (listed.some(p => p.replace(/^\.\//,'').toLowerCase() === path.toLowerCase())) throw new Error(`The manifest already declares ${path}. Restore its seed file.`);
  const schema = { alias: name, fields: fields.map(f => ({ ...f, id: `field_${f.name}`, type: f.type === 'integer' ? 'number' : f.type })) };
  return { path, changes: {
    [path]: JSON.stringify({ collection: name, schema, records: [] }, null, 2) + '\n',
    'manifest.json': JSON.stringify({ ...manifest, files: { ...groups, xdb: [...listed, path] } }, null, 2) + '\n',
  } };
}
