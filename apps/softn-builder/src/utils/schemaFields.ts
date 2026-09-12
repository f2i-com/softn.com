import type { SchemaField } from '../types/builder';

/** Field IDs belong to the editor, not the record schema; external apps may omit them. */
export function ensureFieldIds(fields: SchemaField[]): SchemaField[] {
  const reserved = new Set(fields.map(field => field.id).filter(id => typeof id === 'string' && id.trim()));
  const used = new Set<string>();
  return fields.map((field, index) => {
    let id = field.id;
    if (typeof id !== 'string' || !id.trim() || used.has(id)) {
      id = `field_${index + 1}`;
      while (reserved.has(id) || used.has(id)) id += '_';
    }
    used.add(id);
    return id === field.id ? field : { ...field, id };
  });
}
