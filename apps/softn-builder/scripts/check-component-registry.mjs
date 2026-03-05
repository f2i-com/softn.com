import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const componentsRegistryPath = path.resolve(root, '../../packages/@softn/components/src/registry.ts');
const builderRegistryPath = path.resolve(root, 'src/utils/componentRegistry.ts');

function extractBuiltinNames(source) {
  const sectionMatch = source.match(/export const builtinComponents = \{([\s\S]*?)\n\};/);
  if (!sectionMatch) return [];
  const section = sectionMatch[1];
  const names = [...section.matchAll(/^\s{2}([A-Za-z0-9_]+),\s*$/gm)].map((m) => m[1]);
  return [...new Set(names)].sort();
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
