import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const componentsRegistryPath = path.resolve(root, '../../packages/@softn/components/src/registry.ts');
const builderRegistryPath = path.resolve(root, 'src/utils/componentRegistry.ts');

/**
 * Names inside an object literal body: `  Name,` lines, `{ A, B, C }` on one
 * line, and `...spreadName` spreads. Spreads are resolved by looking the
 * spread identifier up among the `export const <name> = {...}` objects of the
 * file that exports it (the registry composes the per-feature entry objects
 * under src/entries/, so the check follows those imports).
 */
function objectBody(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\};?\\s*$`, 'm'));
  return match ? match[1] : null;
}

function importSourceFor(source, identifier) {
  const match = source.match(new RegExp(`import \\{[^}]*\\b${identifier}\\b[^}]*\\} from '([^']+)'`));
  return match ? match[1] : null;
}

function extractObjectNames(source, name, filePath, seen = new Set()) {
  const body = objectBody(source, name);
  if (body === null) return [];
  const names = [];
  const withoutComments = body.replace(/\/\/.*$/gm, '');
  for (const entry of withoutComments.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const spread = token.match(/^\.\.\.([A-Za-z0-9_]+)$/);
    if (spread) {
      const identifier = spread[1];
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      const importPath = importSourceFor(source, identifier);
      const resolvedPath = importPath
        ? path.resolve(path.dirname(filePath), importPath.endsWith('.ts') ? importPath : `${importPath}.ts`)
        : filePath;
      const resolvedSource = resolvedPath === filePath ? source : fs.readFileSync(resolvedPath, 'utf8');
      names.push(...extractObjectNames(resolvedSource, identifier, resolvedPath, seen));
      continue;
    }
    const plain = token.match(/^([A-Za-z0-9_]+)(?:\s*:\s*[A-Za-z0-9_.]+)?$/);
    if (plain) names.push(plain[1]);
  }
  return names;
}

function extractBuiltinNames(source) {
  return [...new Set(extractObjectNames(source, 'builtinComponents', componentsRegistryPath))].sort();
}

function extractBuilderNames(source) {
  const names = [...source.matchAll(/comp\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

const componentsSource = fs.readFileSync(componentsRegistryPath, 'utf8');
const builderSource = fs.readFileSync(builderRegistryPath, 'utf8');

const builtinNames = extractBuiltinNames(componentsSource);
const builderNames = extractBuilderNames(builderSource);

const missingInBuilder = builtinNames.filter((name) => !builderNames.includes(name));
const extraInBuilder = builderNames.filter((name) => !builtinNames.includes(name));

if (missingInBuilder.length === 0 && extraInBuilder.length === 0) {
  console.log(`[component-registry] OK (${builderNames.length} components covered)`);
  process.exit(0);
}

console.error('[component-registry] MISMATCH DETECTED');
if (missingInBuilder.length > 0) {
  console.error('Missing in builder metadata:', missingInBuilder.join(', '));
}
if (extraInBuilder.length > 0) {
  console.error('Unknown in builder metadata:', extraInBuilder.join(', '));
}

process.exit(1);
