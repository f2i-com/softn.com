#!/usr/bin/env node
/**
 * Find elements whose style is a base object with a state spread over it,
 * where the state sets a longhand of a shorthand the base has set.
 *
 *     const card = { border: '1px solid grey' };
 *     const picked = { borderColor: 'black' };
 *     <div style={{ ...card, ...(isPicked ? picked : {}) }} />
 *
 * When the state ends, React takes `borderColor` away by setting it to
 * nothing, which clears the colour `border` had set: the card that is no
 * longer picked keeps a border in the colour of its text, as though it
 * still were, and the console has an error each time. Builder drew a
 * collection's card, a palette item that had been dragged, a sample-records
 * tab, a relationship's kind and the empty canvas this way.
 *
 * The components package holds the same rule for the two shapes it writes
 * (packages/@softn/components/scripts/style-shorthand-audit.mjs: an empty
 * longhand inside one object, and `a ? one : other` between two named
 * objects). Builder's own components spread a state over a base, which
 * neither of those reads, so this reads that shape: `...(cond ? state : {})`
 * and `...(cond && state)` after the base, where base and state are object
 * literals declared in the same file, by name (`cardStyle`) or as members
 * of one (`styles.card`). A longhand the base sets too is no conflict: it
 * goes back to the base's value, not to nothing.
 *
 * Write the base with longhands only (`borderWidth`, `borderStyle`,
 * `borderColor`), so that a state changes a value the base has.
 *
 *     node scripts/style-state-audit.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shorthands a state is seen to undo, and the longhands each sets. */
const SHORTHANDS = {
  border: ['borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderColor', 'borderWidth', 'borderStyle'],
  borderTop: ['borderTopColor', 'borderTopWidth', 'borderTopStyle'],
  borderRight: ['borderRightColor', 'borderRightWidth', 'borderRightStyle'],
  borderBottom: ['borderBottomColor', 'borderBottomWidth', 'borderBottomStyle'],
  borderLeft: ['borderLeftColor', 'borderLeftWidth', 'borderLeftStyle'],
  outline: ['outlineColor', 'outlineWidth', 'outlineStyle'],
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  font: ['fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'lineHeight'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  gap: ['columnGap', 'rowGap'],
  overflow: ['overflowX', 'overflowY'],
  transition: ['transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay'],
};

const SHORTHANDS_OF = new Map();
for (const [shorthand, longhands] of Object.entries(SHORTHANDS)) {
  for (const longhand of longhands) SHORTHANDS_OF.set(longhand, [...(SHORTHANDS_OF.get(longhand) ?? []), shorthand]);
}

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(name) && !name.includes('.test.') && !name.endsWith('.d.ts')) yield full;
  }
}

function propertyName(property) {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

/**
 * Every conflict under `srcDir`, as `{ file, line, longhand, shorthand, text }`.
 */
export function findStateSpreadConflicts(srcDir = join(packageRoot, 'src')) {
  const conflicts = [];
  for (const file of sourceFiles(srcDir)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const relativePath = relative(packageRoot, file).split(sep).join('/');

    // Object literals declared by name anywhere in the file.
    const declared = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let initializer = node.initializer;
        while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
          initializer = initializer.expression;
        }
        if (ts.isObjectLiteralExpression(initializer)) declared.set(node.name.text, initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    /** The object literal an expression names: `cardStyle`, or `styles.card`. */
    const literalOf = (expression) => {
      let node = expression;
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
      if (ts.isObjectLiteralExpression(node)) return node;
      if (ts.isIdentifier(node)) return declared.get(node.text);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const holder = declared.get(node.expression.text);
        const member = holder?.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property) === node.name.text);
        let initializer = member?.initializer;
        while (initializer && (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
        return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
      }
      return undefined;
    };

    /** Every key an object literal sets, its own and those of the declared objects it spreads whole. */
    const keysOf = (literal, seen = new Set()) => {
      const keys = new Set();
      if (!literal || seen.has(literal)) return keys;
      seen.add(literal);
      for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const key of keysOf(literalOf(property.expression), seen)) keys.add(key);
          continue;
        }
        const key = propertyName(property);
        if (key) keys.add(key);
      }
      return keys;
    };

    /** The objects a spread puts in only some of the time: `cond ? a : {}`, `cond ? a : b`, `cond && a`. */
    const statesOf = (expression) => {
      let node = expression;
      while (ts.isParenthesizedExpression(node)) node = node.expression;
      if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
      // `cond && state` spreads nothing at all when the guard fails.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [node.right, null];
      return null;
    };

    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        // What every drawing of the element sets, in the order written.
        const always = new Set();
        for (const property of node.properties) {
          if (!ts.isSpreadAssignment(property)) {
            const key = propertyName(property);
            if (key) always.add(key);
            continue;
          }
          const states = statesOf(property.expression);
          if (!states) {
            for (const key of keysOf(literalOf(property.expression))) always.add(key);
            continue;
          }
          const sets = states.map((state) => (state ? keysOf(literalOf(state)) : new Set()));
          sets.forEach((keys, index) => {
            for (const longhand of keys) {
              // Set whatever the state: it changes value and is never taken away.
              if (always.has(longhand) || sets.every((other) => other.has(longhand))) continue;
              const shorthand = (SHORTHANDS_OF.get(longhand) ?? []).find(
                (candidate) => always.has(candidate) || sets.some((other, at) => at !== index && other.has(candidate))
              );
              if (!shorthand) continue;
              conflicts.push({
                file: relativePath,
                line: source.getLineAndCharacterOfPosition(property.getStart()).line + 1,
                longhand,
                shorthand,
                text: property.getText().replace(/\s+/g, ' ').slice(0, 120),
              });
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return conflicts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const conflicts = findStateSpreadConflicts(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const c of conflicts) console.log(`${c.file}:${c.line}  ${c.longhand} is taken away from ${c.shorthand} when the state ends\n    ${c.text}`);
  console.log(conflicts.length === 0 ? 'no state takes a longhand away from a shorthand' : `${conflicts.length} conflict(s)`);
  process.exit(conflicts.length === 0 ? 0 : 1);
}
