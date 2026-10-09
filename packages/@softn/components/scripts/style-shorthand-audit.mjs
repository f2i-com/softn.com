#!/usr/bin/env node
/**
 * Find style objects in which a longhand that may be empty follows the
 * shorthand that sets it.
 *
 * React writes a style value that is undefined, null, false or '' as
 * `style[name] = ''`. When that name is a longhand of a shorthand written
 * earlier in the same object, the empty assignment clears what the shorthand
 * set:
 *
 *     { padding: '1.5rem', paddingTop }          // paddingTop is undefined
 *     { gap: '1rem', columnGap: undefined }
 *     { border: '1px solid', borderTop: first ? undefined : 'none' }
 *
 * The first drew every padded Stack with nothing above its content, the
 * second meant a Grid never had a gap, and neither shows in jsdom or in
 * server rendering, which skip an undefined value instead of clearing it;
 * only a browser does what React asks. So the rule is held statically:
 * test/style-shorthands.test.ts runs this over src/ and fails on any hit.
 * Write the key only when it has a value:
 *
 *     ...(paddingTop ? { paddingTop } : {})
 *
 * A spread earlier in the object counts when it names an object literal
 * declared in the same file (`...sizeStyles[size]`), whose own keys are then
 * known.
 *
 *     node scripts/style-shorthand-audit.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A shorthand and the longhands it sets, as React spells them. */
const SHORTHANDS = {
  gap: ['columnGap', 'rowGap'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock', 'paddingInlineStart', 'paddingInlineEnd', 'paddingBlockStart', 'paddingBlockEnd'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginInline', 'marginBlock', 'marginInlineStart', 'marginInlineEnd', 'marginBlockStart', 'marginBlockEnd'],
  border: ['borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderColor', 'borderWidth', 'borderStyle', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'],
  borderTop: ['borderTopColor', 'borderTopWidth', 'borderTopStyle'],
  borderRight: ['borderRightColor', 'borderRightWidth', 'borderRightStyle'],
  borderBottom: ['borderBottomColor', 'borderBottomWidth', 'borderBottomStyle'],
  borderLeft: ['borderLeftColor', 'borderLeftWidth', 'borderLeftStyle'],
  borderColor: ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'],
  borderWidth: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
  borderStyle: ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'],
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'backgroundAttachment'],
  overflow: ['overflowX', 'overflowY'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  flexFlow: ['flexDirection', 'flexWrap'],
  font: ['fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'lineHeight', 'fontVariant'],
  inset: ['top', 'right', 'bottom', 'left'],
  outline: ['outlineColor', 'outlineWidth', 'outlineStyle'],
  transition: ['transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay'],
  animation: ['animationName', 'animationDuration', 'animationTimingFunction', 'animationDelay', 'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState'],
  gridTemplate: ['gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas'],
  gridArea: ['gridRow', 'gridColumn', 'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd'],
  gridColumn: ['gridColumnStart', 'gridColumnEnd'],
  gridRow: ['gridRowStart', 'gridRowEnd'],
  placeItems: ['alignItems', 'justifyItems'],
  placeContent: ['alignContent', 'justifyContent'],
  textDecoration: ['textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'textDecorationThickness'],
  listStyle: ['listStyleType', 'listStylePosition', 'listStyleImage'],
};

const SHORTHANDS_OF = new Map();
for (const [shorthand, longhands] of Object.entries(SHORTHANDS)) {
  for (const longhand of longhands) {
    if (!SHORTHANDS_OF.has(longhand)) SHORTHANDS_OF.set(longhand, []);
    SHORTHANDS_OF.get(longhand).push(shorthand);
  }
}

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(name) && !name.includes('.test.') && !name.endsWith('.d.ts')) yield full;
  }
}

/**
 * The names a file's components take as optional props with no default:
 * `function Stack({ paddingTop }: StackProps)` where the interface says
 * `paddingTop?: string`. Used bare in a style object, such a name is
 * undefined whenever the prop is not passed.
 */
function optionalProps(source) {
  const interfaces = new Map();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const optional = new Set();
      for (const member of statement.members) {
        if (ts.isPropertySignature(member) && member.questionToken && member.name && ts.isIdentifier(member.name)) optional.add(member.name.text);
      }
      interfaces.set(statement.name.text, optional);
    }
  }
  const names = new Set();
  const visit = (node) => {
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name) && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
      const optional = interfaces.get(node.type.typeName.text);
      if (optional) {
        for (const element of node.name.elements) {
          if (!element.initializer && !element.dotDotDotToken && ts.isIdentifier(element.name)) {
            const prop = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            if (optional.has(prop)) names.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Whether an initializer is certain to be empty for some input: undefined, null, false or ''. */
function canBeEmpty(node, optional = new Set()) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return canBeEmpty(node.expression, optional);
  if (ts.isIdentifier(node)) return node.text === 'undefined' || optional.has(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === '';
  if (ts.isConditionalExpression(node)) return canBeEmpty(node.whenTrue, optional) || canBeEmpty(node.whenFalse, optional);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    // `cond && value` is false when the guard fails.
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return true;
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return canBeEmpty(node.right, optional);
  }
  return false;
}

function propertyName(property) {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

/** The keys an object literal sets itself, and those of object literals nested one level in it. */
function keysOf(literal) {
  const own = new Set();
  const nested = new Set();
  for (const property of literal.properties) {
    const name = propertyName(property);
    if (name) own.add(name);
    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
      for (const inner of property.initializer.properties) {
        const innerName = propertyName(inner);
        if (innerName) nested.add(innerName);
      }
    }
  }
  return { own, nested };
}

/**
 * Every conflict under `srcDir`, as `{ file, line, longhand, shorthand, text }`.
 */
export function findShorthandConflicts(srcDir = join(packageRoot, 'src')) {
  const conflicts = [];
  for (const file of sourceFiles(srcDir)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const relativePath = relative(packageRoot, file).split(sep).join('/');
    const optional = optionalProps(source);

    // Object literals declared by name anywhere in the file, for spreads.
    const declared = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        declared.set(node.name.text, keysOf(node.initializer));
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const shorthandsSeen = new Set();
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) {
            // `...base` brings base's keys; `...sizes[size]` those of its members.
            let target = property.expression;
            let member = false;
            if (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) {
              target = target.expression;
              member = true;
            }
            const keys = ts.isIdentifier(target) ? declared.get(target.text) : undefined;
            if (keys) for (const key of member ? keys.nested : keys.own) if (Object.hasOwn(SHORTHANDS, key)) shorthandsSeen.add(key);
            continue;
          }
          const name = propertyName(property);
          if (!name) continue;
          const setBefore = (SHORTHANDS_OF.get(name) ?? []).filter((shorthand) => shorthandsSeen.has(shorthand));
          // `{ padding, paddingTop }` is `paddingTop: paddingTop`.
          const empty = ts.isShorthandPropertyAssignment(property) ? optional.has(name) : ts.isPropertyAssignment(property) && canBeEmpty(property.initializer, optional);
          if (setBefore.length > 0 && empty) {
            conflicts.push({
              file: relativePath,
              line: source.getLineAndCharacterOfPosition(property.getStart()).line + 1,
              longhand: name,
              shorthand: setBefore[0],
              text: property.getText().replace(/\s+/g, ' ').slice(0, 120),
            });
          }
          if (Object.hasOwn(SHORTHANDS, name)) shorthandsSeen.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return conflicts;
}

/**
 * Every place under `srcDir` where an element is drawn with one of two
 * style objects and only one of them sets a longhand of a shorthand the
 * other has, as `{ file, line, longhand, shorthand, text }`.
 *
 *     const button = { border: '1px solid grey' };
 *     const active = { ...button, borderColor: 'blue' };
 *     <button style={isActive ? active : button}>
 *
 * Going from `active` back to `button`, React takes `borderColor` away by
 * setting it to nothing, which clears the colour the shorthand set: the
 * element is left with a border in the colour of its text. The page of a
 * Pagination that had just been left was drawn so, and a SmartForm field
 * whose error had been put right. The same empty assignment as the rule
 * above, made between two drawings instead of within one, so it is held
 * the same way: both objects set the longhand, or neither does.
 *
 * Two names in a conditional, each an object literal declared in the same
 * file, are what is recognised; a spread of another such object counts.
 */
export function findStateConflicts(srcDir = join(packageRoot, 'src')) {
  const conflicts = [];
  for (const file of sourceFiles(srcDir)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const relativePath = relative(packageRoot, file).split(sep).join('/');

    const literals = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        literals.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    /** Every key the object has, its own and those of the declared objects it spreads. */
    const allKeys = (name, seen = new Set()) => {
      const keys = new Set();
      if (seen.has(name)) return keys;
      seen.add(name);
      for (const property of literals.get(name).properties) {
        if (ts.isSpreadAssignment(property)) {
          if (ts.isIdentifier(property.expression) && literals.has(property.expression.text)) {
            for (const key of allKeys(property.expression.text, seen)) keys.add(key);
          }
          continue;
        }
        const key = propertyName(property);
        if (key) keys.add(key);
      }
      return keys;
    };

    const visit = (node) => {
      if (ts.isConditionalExpression(node) && ts.isIdentifier(node.whenTrue) && ts.isIdentifier(node.whenFalse)) {
        const [one, other] = [node.whenTrue.text, node.whenFalse.text];
        if (literals.has(one) && literals.has(other)) {
          for (const [has, lacks] of [[one, other], [other, one]]) {
            const lacking = allKeys(lacks);
            for (const longhand of allKeys(has)) {
              if (lacking.has(longhand)) continue;
              const shorthand = (SHORTHANDS_OF.get(longhand) ?? []).find((candidate) => lacking.has(candidate));
              if (!shorthand) continue;
              conflicts.push({
                file: relativePath,
                line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                longhand,
                shorthand,
                text: `${node.getText().replace(/\s+/g, ' ').slice(0, 100)}: only ${has} sets ${longhand}`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return conflicts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const conflicts = findShorthandConflicts();
  for (const c of conflicts) console.log(`${c.file}:${c.line}  ${c.longhand} may be empty after ${c.shorthand}\n    ${c.text}`);
  const between = findStateConflicts();
  for (const c of between) console.log(`${c.file}:${c.line}  ${c.longhand} is taken away from ${c.shorthand} between two states\n    ${c.text}`);
  const total = conflicts.length + between.length;
  console.log(total === 0 ? 'no longhand can clear a shorthand' : `${total} conflict(s)`);
  process.exit(total === 0 ? 0 : 1);
}
