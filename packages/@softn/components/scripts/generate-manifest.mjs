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
 * type's text otherwise, with the string literals it names as `literals` when
 * it takes others too (`'sm' | 'md' | string`). Each member's `default` is
 * the literal the component gives it when a page writes nothing (from its
 * destructuring, its `defaultProps`, or `name ?? literal` in its body); a
 * member with neither `default` nor `defaultUnknown` has none, and
 * `defaultUnknown` marks one the component works out in a way not read here.
 * It also records which names each registry entry registers
 * (`minimalComponents`, `chartComponents`, …).
 *
 * The manifest is the machine-readable description Builder's palette and
 * property panel can be generated from instead of hand-maintaining a second
 * copy of every component's props. From it comes src/prop-kinds.generated.ts
 * too: the props each registered component declares as numbers and booleans,
 * which the renderer gives what a page wrote as text or a number in their
 * place (see prop-kinds.ts). Both are committed so a change to a component's
 * props shows in review; test/component-manifest.test.ts fails when either is
 * stale:
 *
 *     npm run generate:manifest -w @softn/components
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = join(packageRoot, 'component-manifest.json');
export const propKindsPath = join(packageRoot, 'src', 'prop-kinds.generated.ts');

const SKIP_DIRS = new Set(['utils', 'entries', 'theme']);
const ENTRY_FILES = ['minimal', 'charts', 'animation', 'editors', 'scene3d', 'smart', 'media', 'pickers', 'games'];

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

/** The string literals a union names among its other members: the choices of `'sm' | 'md' | string`. */
function stringLiterals(type) {
  const options = [];
  for (const member of type.types) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) options.push(member.literal.text);
  }
  return options;
}

/**
 * Reduce a type node to what an editor can act on. A type alias this file
 * declares as a union of string literals is the enum it names. A union that
 * names string literals beside other types (`'sm' | 'md' | string`), or an
 * alias of one, stays `other` with its text and carries the literals as
 * `literals`: the choices it offers, though it takes more than those.
 */
export function describeType(type, source, aliases = new Map()) {
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
  const aliased = ts.isTypeReferenceNode(type) && !type.typeArguments && ts.isIdentifier(type.typeName) ? aliases.get(type.typeName.text) : undefined;
  // An alias of string literals alone is the enum it names.
  if (aliased && ts.isUnionTypeNode(aliased) && literalUnion(aliased)) return { kind: 'enum', options: literalUnion(aliased) };
  const union = ts.isUnionTypeNode(type) ? type : aliased && ts.isUnionTypeNode(aliased) ? aliased : null;
  const literals = union ? stringLiterals(union) : [];
  return literals.length > 0 ? { kind: 'other', text, literals } : { kind: 'other', text };
}

/** A value written as a literal in the source, or NOT_LITERAL. */
const NOT_LITERAL = Symbol('not a literal');

/**
 * The value `node` is when it is written as a literal: a string, a number,
 * true or false, null, a list or record of those, or a constant this file
 * declares as one. `undefined` is undefined. Anything else is NOT_LITERAL.
 */
function literalValue(node, consts, depth = 0) {
  if (!node || depth > 8) return NOT_LITERAL;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const element of node.elements) {
      const value = literalValue(element, consts, depth + 1);
      if (value === NOT_LITERAL || value === undefined) return NOT_LITERAL;
      out.push(value);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) return NOT_LITERAL;
      const value = literalValue(property.initializer, consts, depth + 1);
      if (value === NOT_LITERAL || value === undefined) return NOT_LITERAL;
      out[property.name.text] = value;
    }
    return out;
  }
  // Object.freeze([...]) and the like hold the literal they are given.
  if (ts.isCallExpression(node) && node.expression.getText() === 'Object.freeze' && node.arguments.length === 1) return literalValue(node.arguments[0], consts, depth + 1);
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return undefined;
    if (consts.has(node.text)) return literalValue(consts.get(node.text), consts, depth + 1);
  }
  return NOT_LITERAL;
}

/** The name a binding element reads from its object: `a`, `a: b`, `'aria-label': c`. */
function boundName(element) {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

/**
 * Where a component reads its props with their defaults: the object pattern
 * of its parameter, one it destructures its parameter into, or the pattern
 * of a function of the same file typed with its props, which it hands them
 * to whole (`<AvatarFace {...props} />`). Null when there is none of those.
 */
function propsPattern(fn, ifaceName, functions) {
  const first = fn.parameters[0];
  if (!first) return null;
  if (ts.isObjectBindingPattern(first.name)) return { pattern: first.name, body: fn.body };
  if (!ts.isIdentifier(first.name)) return null;
  const param = first.name.text;
  for (const statement of fn.body?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer) && declaration.initializer.text === param) {
        return { pattern: declaration.name, body: fn.body };
      }
    }
  }
  for (const other of functions) {
    const own = other.parameters[0];
    if (other === fn || !own || !ts.isObjectBindingPattern(own.name) || !own.type || !ts.isTypeReferenceNode(own.type)) continue;
    if (own.type.typeName.getText() === ifaceName) return { pattern: own.name, body: other.body };
  }
  return null;
}

/**
 * What the body of a component does with a prop it read without a default:
 * `size ?? 'md'` is a default of 'md'; `audio ?? (mode === 'video')` and
 * `loop !== undefined ? loop : texts.length > 1` are one it works out, which
 * is not known here. `open !== undefined ? open : internalOpen` is a prop the
 * component holds itself while it is not given, and no default.
 */
function fallbackOf(body, local, consts) {
  if (!body) return { none: true };
  const found = [];
  let unknown = false;
  const isLocal = (node) => {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression;
    return node && ts.isIdentifier(node) && node.text === local;
  };
  const take = (node) => {
    const value = literalValue(node, consts);
    if (value === NOT_LITERAL) unknown = true;
    else if (value !== undefined && value !== null && value !== '') found.push(value);
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && isLocal(node.left)) take(node.right);
    if (ts.isConditionalExpression(node) && ts.isBinaryExpression(node.condition) && isLocal(node.condition.left) && node.condition.right.getText() === 'undefined') {
      const op = node.condition.operatorToken.kind;
      const given = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const otherwise = given ? node.whenFalse : node.whenTrue;
      const kept = given ? node.whenTrue : node.whenFalse;
      // Its own state while it is not given: no default.
      if (isLocal(kept) && !(ts.isIdentifier(otherwise) && !consts.has(otherwise.text))) take(otherwise);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (unknown || new Set(found.map((value) => JSON.stringify(value))).size > 1) return { unknown: true };
  return found.length === 1 || found.length > 1 ? { value: found[0] } : { none: true };
}

/**
 * Each prop's default as the component gives it: from its destructuring
 * (`({ size = 'md' })`), from its `Name.defaultProps`, or from a fallback in
 * its body (`size ?? 'md'`). A prop with `{ value }` has that literal as its
 * default, one with `{ none: true }` has none (the component does without
 * it), and one with `{ unknown: true }` has one this cannot read.
 */
function defaultsOf(fn, iface, file) {
  const out = new Map();
  const found = propsPattern(fn, iface.name.text, file.functions);
  const read = new Map();
  let rest = false;
  if (found) {
    for (const element of found.pattern.elements) {
      if (element.dotDotDotToken) rest = true;
      else read.set(boundName(element), element);
    }
  }
  for (const member of iface.members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText();
    const element = read.get(name);
    let state;
    if (!found) state = { unknown: true };
    else if (!element) state = rest ? { unknown: true } : { none: true };
    else if (element.initializer) {
      const value = literalValue(element.initializer, file.consts);
      state = value === NOT_LITERAL ? { unknown: true } : value === undefined ? { none: true } : { value };
    } else if (ts.isIdentifier(element.name)) state = fallbackOf(found.body, element.name.text, file.consts);
    else state = { unknown: true };
    out.set(name, state);
  }
  const given = file.defaultProps.get(fn.name.text);
  for (const property of given?.properties ?? []) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = literalValue(property.initializer, file.consts);
    out.set(boundName({ name: property.name }), value === NOT_LITERAL ? { unknown: true } : value === undefined ? { none: true } : { value });
  }
  return out;
}

function propsOf(iface, source, file, defaults) {
  const members = [];
  for (const member of iface.members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(source);
    const entry = { name, optional: Boolean(member.questionToken), type: describeType(member.type, source, file.aliases) };
    const state = defaults?.get(name) ?? { unknown: true };
    if ('value' in state) entry.default = state.value;
    else if (state.unknown) entry.defaultUnknown = true;
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
  /** What the file declares that a prop's type or default may name. */
  const declared = { functions: [], consts: new Map(), aliases: new Map(), defaultProps: new Map() };
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
    if (ts.isTypeAliasDeclaration(statement)) declared.aliases.set(statement.name.text, statement.type);
    if (ts.isFunctionDeclaration(statement)) declared.functions.push(statement);
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) declared.consts.set(declaration.name.text, declaration.initializer);
      }
    }
    // Name.defaultProps = { … }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'defaultProps' && ts.isIdentifier(left.expression) && ts.isObjectLiteralExpression(right)) {
        declared.defaultProps.set(left.expression.text, right);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && /^[A-Z]/.test(statement.name.text)) {
      names.push({ name: statement.name.text, doc: docOf(statement), fn: statement });
    }
  }
  const relativePath = relative(packageRoot, file).split(sep).join('/');
  return names.map(({ name, doc, fn }) => {
    const iface = interfaces.get(`${name}Props`);
    const entry = { name, source: relativePath };
    if (doc) entry.doc = doc;
    entry.props = iface ? propsOf(iface, source, declared, defaultsOf(fn, iface, declared)) : null;
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

/** A union of number literals (`2 | 3 | 4 | 5 | 6`) as its numbers; null for any other type. */
function numberChoices(type) {
  return type.kind === 'other' && /^-?\d+(?:\.\d+)?(?: \| -?\d+(?:\.\d+)?)+$/.test(type.text) ? type.text.split(' | ').map(Number) : null;
}

/**
 * src/prop-kinds.generated.ts: for each registered component, the props it
 * declares as numbers, number choices and booleans, written
 * `Name:numbers:booleans` and joined by `;`, a choice as `name=2|3|4`.
 * Compact, since every host that draws a page carries it.
 */
export function renderPropKinds(manifest = buildManifest()) {
  const registered = new Set(Object.values(manifest.registered).flat());
  const entries = [];
  for (const component of manifest.components) {
    if (!registered.has(component.name)) continue;
    const numbers = [];
    const booleans = [];
    for (const member of component.props?.members ?? []) {
      const choices = numberChoices(member.type);
      if (member.type.kind === 'number') numbers.push(member.name);
      else if (choices) numbers.push(`${member.name}=${choices.join('|')}`);
      else if (member.type.kind === 'boolean') booleans.push(member.name);
    }
    if (numbers.length > 0 || booleans.length > 0) entries.push(`${component.name}:${numbers.join(',')}:${booleans.join(',')}`);
  }
  return [
    "// Generated by scripts/generate-manifest.mjs from the components' props; do not edit.",
    '// Regenerate with `npm run generate:manifest -w @softn/components`. Read by prop-kinds.ts.',
    '',
    '/** Each registered component\'s number and boolean props: `Name:numbers:booleans`, joined by `;`. */',
    `export const WRITTEN_PROP_KINDS =\n  '${entries.join(';')}';`,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendered = renderManifest();
  writeFileSync(manifestPath, rendered);
  const manifest = JSON.parse(rendered);
  console.log(`wrote ${relative(process.cwd(), manifestPath)}: ${manifest.components.length} components`);
  writeFileSync(propKindsPath, renderPropKinds(manifest));
  console.log(`wrote ${relative(process.cwd(), propKindsPath)}`);
}
