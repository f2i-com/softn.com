#!/usr/bin/env node
/**
 * Generate component-manifest.json from the component sources.
 *
 * For every component this package exports (an `export function Name` in a
 * PascalCase name under src/, outside utils, entries and theme) the manifest
 * records where it lives and the members of its `NameProps` interface: name,
 * whether it is optional, its doc comment, and its type reduced to what an
 * editor can act on — a list of options for a union of string literals, the
 * primitive kinds, `node` for React content, `function` for handlers, or the
 * type's text otherwise. It also records which names each registry entry
 * registers (`minimalComponents`, `chartComponents`, …).
 *
 * The manifest is the machine-readable description Builder's palette and
 * property panel can be generated from instead of hand-maintaining a second
 * copy of every component's props. It is committed so a change to a
 * component's props shows in review; test/component-manifest.test.ts fails
 * when it is stale:
 *
 *     npm run generate:manifest -w @softn/components
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = join(packageRoot, 'component-manifest.json');

const SKIP_DIRS = new Set(['utils', 'entries', 'theme']);
const ENTRY_FILES = ['minimal', 'charts', 'animation', 'editors', 'scene3d', 'smart', 'media'];

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* sourceFiles(full);
    } else if (name.endsWith('.tsx') && !name.includes('.test.')) {
      yield full;
    }
  }
}

function isExported(node) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function docOf(node) {
  const docs = node.jsDoc;
  if (!docs || docs.length === 0) return undefined;
  const text = ts.getTextOfJSDocComment(docs[docs.length - 1].comment);
  return text ? text.replace(/\s+/g, ' ').trim() : undefined;
}

function literalUnion(type) {
  const options = [];
  for (const member of type.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) options.push(member.literal.text);
    else if (member.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)) continue;
    else return null;
  }
  return options.length > 0 ? options : null;
}

/** Reduce a type node to what an editor can act on. */
export function describeType(type, source) {
  if (!type) return { kind: 'unknown' };
  switch (type.kind) {
    case ts.SyntaxKind.BooleanKeyword: return { kind: 'boolean' };
    case ts.SyntaxKind.NumberKeyword: return { kind: 'number' };
    case ts.SyntaxKind.StringKeyword: return { kind: 'string' };
    default: break;
  }
  if (ts.isFunctionTypeNode(type)) return { kind: 'function' };
  if (ts.isUnionTypeNode(type)) {
    const options = literalUnion(type);
    if (options) return { kind: 'enum', options };
  }
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return { kind: 'enum', options: [type.literal.text] };
  const text = type.getText(source).replace(/\s+/g, ' ');
  if (/^React\.ReactNode$|^ReactNode$/.test(text)) return { kind: 'node' };
  if (ts.isArrayTypeNode(type)) return { kind: 'array', text };
  return { kind: 'other', text };
}

function propsOf(iface, source) {
  const members = [];
  for (const member of iface.members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
    const entry = { name, optional: Boolean(member.questionToken), type: describeType(member.type, source) };
    const doc = docOf(member);
    if (doc) entry.doc = doc;
    members.push(entry);
  }
  const extendsNames = [];
  for (const clause of iface.heritageClauses ?? []) {
    for (const type of clause.types) extendsNames.push(type.getText(source).replace(/\s+/g, ' '));
  }
  const props = { interface: iface.name.text, members };
  if (extendsNames.length) props.extends = extendsNames;
  return props;
}

function componentsIn(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const interfaces = new Map();
  const names = [];
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && /^[A-Z]/.test(statement.name.text)) {
      names.push({ name: statement.name.text, doc: docOf(statement) });
    }
  }
  const relativePath = relative(packageRoot, file).split(sep).join('/');
  return names.map(({ name, doc }) => {
    const iface = interfaces.get(`${name}Props`);
    const entry = { name, source: relativePath };
    if (doc) entry.doc = doc;
    entry.props = iface ? propsOf(iface, source) : null;
    return entry;
  });
}

function registeredNames() {
  const registered = {};
  for (const entry of ENTRY_FILES) {
    const file = join(packageRoot, 'src', 'entries', `${entry}.ts`);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = [];
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('Components')) continue;
        if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
        for (const property of declaration.initializer.properties) {
          if (ts.isShorthandPropertyAssignment(property)) names.push(property.name.text);
          else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) names.push(property.name.text);
        }
      }
    }
    registered[entry] = names;
  }
  return registered;
}

export function buildManifest() {
  const components = [];
  for (const file of sourceFiles(join(packageRoot, 'src'))) components.push(...componentsIn(file));
  components.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return {
    $comment: 'Generated by scripts/generate-manifest.mjs from the component sources; do not edit. Regenerate with `npm run generate:manifest -w @softn/components`.',
    components,
    registered: registeredNames(),
  };
}

export function renderManifest(manifest = buildManifest()) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendered = renderManifest();
  writeFileSync(manifestPath, rendered);
  const manifest = JSON.parse(rendered);
  console.log(`wrote ${relative(process.cwd(), manifestPath)}: ${manifest.components.length} components`);
}
