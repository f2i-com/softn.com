import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const defaultSchema = new URL('../content/softn-docs.schema.json', import.meta.url);
const schemaKeys = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format', 'enum', 'const', 'oneOf']);

/** Dependency-free validator for every JSON Schema keyword used by this kit. */
export function validateSchema(value, schema, root = schema, path = '$') {
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!schemaKeys.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/')) throw new Error('Only local $defs references are supported');
    const target = root.$defs?.[schema.$ref.slice(8)];
    if (!target) throw new Error(`Missing schema reference: ${schema.$ref}`);
    return validateSchema(value, target, root, path);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(s => validateSchema(value, s, root, path).length === 0);
    if (matches.length !== 1) errors.push(`${path}: does not match exactly one allowed content shape`);
    return errors;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum value ${JSON.stringify(value)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual)) return [...errors, `${path}: expected ${types.join(' or ')}, got ${actual}`];
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength && length < schema.minLength) errors.push(`${path}: string is too short`);
    if (schema.maxLength && length > schema.maxLength) errors.push(`${path}: string is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid format`);
    if (schema.format === 'uri') { try { new URL(value); } catch { errors.push(`${path}: invalid absolute URI`); } }
    if (schema.format === 'date') {
      const date = new Date(value + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) errors.push(`${path}: invalid date`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: not enough items`);
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, root, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(child, schema.properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown property`);
    }
  }
  return errors;
}

function webUrl(value, label, errors) {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) errors.push(`${label}: only credential-free HTTP(S) URLs are allowed`);
  } catch { errors.push(`${label}: invalid URL`); }
}

/** Schema validation plus semantic checks for links, navigation and safe routes. */
export function validateDocument(doc, schema) {
  const errors = validateSchema(doc, schema);
  if (errors.length) throw new Error(`Documentation validation failed:\n${errors.join('\n')}`);
  const unique = (items, field, label) => {
    const values = items.map(x => x[field]);
    if (new Set(values).size !== values.length) errors.push(`${label}: duplicate ${field}`);
  };
  unique(doc.pages, 'id', 'pages'); unique(doc.pages, 'slug', 'pages');
  unique(doc.pages, 'title', 'pages'); unique(doc.sources, 'id', 'sources');
  unique(doc.navigation, 'id', 'navigation');
  for (const field of ['title','description']) {
    const v = doc.pages.map(x => x.seo[field]);
    if (new Set(v).size !== v.length) errors.push(`SEO: duplicate ${field}`);
  }
  const pageIds = new Set(doc.pages.map(x => x.id));
  const sourceIds = new Set(doc.sources.map(x => x.id));
  const groups = new Map(doc.navigation.map(x => [x.id,x]));
  const requirePage = (id, where) => { if (!pageIds.has(id)) errors.push(`${where}: unknown page ${id}`); };
  if (doc.pages.filter(x => x.slug === '').length !== 1) errors.push('Exactly one documentation index page with an empty slug is required');
  const allNav = doc.navigation.flatMap(g => g.pageIds);
  if (allNav.length !== doc.pages.length || new Set(allNav).size !== doc.pages.length) errors.push('Navigation must contain every page exactly once');
  for (const group of doc.navigation) for (const id of group.pageIds) {
    requirePage(id, 'navigation');
    const page = doc.pages.find(x => x.id === id);
    if (page && page.groupId !== group.id) errors.push(`${id}: groupId does not match navigation`);
  }
  for (const page of doc.pages) {
    if (!groups.has(page.groupId)) errors.push(`${page.id}: unknown group`);
    if (page.slug === 'search-index') errors.push(`${page.id}: reserved slug`);
    unique(page.sections, 'id', page.id + ' sections');
    for (const id of page.sourceIds) if (!sourceIds.has(id)) errors.push(`${page.id}: unknown source ${id}`);
    for (const id of page.relatedPageIds) { requirePage(id,page.id); if (id === page.id) errors.push(`${page.id}: self-related page`); }
    for (const section of page.sections) for (const block of section.blocks) {
      if (block.type === 'cards') block.pageIds.forEach(id => requirePage(id,page.id));
      if (block.type === 'table' && block.rows.some(row => row.length !== block.columns.length)) errors.push(`${page.id}: table width mismatch`);
      if (block.type === 'links') block.items.forEach(item => webUrl(item.href,`${page.id} link`,errors));
    }
  }
  webUrl(doc.site.origin,'site.origin',errors);
  const origin = new URL(doc.site.origin);
  if (origin.origin !== doc.site.origin) errors.push('site.origin must be an origin without a trailing slash, path, query or fragment');
  webUrl(doc.site.repositoryHref,'repositoryHref',errors);
  doc.sources.forEach(source => webUrl(source.url,source.id,errors));
  doc.review.repositories.forEach(repo => webUrl(repo.url,'review repository',errors));
  requirePage(doc.landing.cta.pageId,'landing CTA');
  const landingIds = doc.landing.cards.map(x => x.pageId);
  if (new Set(landingIds).size !== landingIds.length) errors.push('Landing cards must reference unique pages');
  landingIds.forEach(id => requirePage(id,'landing card'));
  if (errors.length) throw new Error(`Documentation validation failed:\n${errors.join('\n')}`);
  return doc;
}

export async function loadDocument(input = new URL('../content/softn-docs.json', import.meta.url)) {
  const [text, schemaText] = await Promise.all([readFile(input,'utf8'), readFile(defaultSchema,'utf8')]);
  return validateDocument(JSON.parse(text), JSON.parse(schemaText));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const doc = await loadDocument(process.argv[2] ? resolve(process.argv[2]) : undefined);
    console.log(`Validated ${doc.pages.length} pages, ${doc.sources.length} sources and ${doc.navigation.length} navigation groups.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
