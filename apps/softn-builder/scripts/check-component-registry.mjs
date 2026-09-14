/**
 * The palette offers exactly the components the library registers.
 *
 * The library's side is `packages/@softn/components/component-manifest.json`,
 * generated from the component sources (its `registered` map says what each
 * registry entry registers) and held current by that package's own test.
 * This script used to re-parse the library's registry source with regular
 * expressions; the manifest is the same fact, already extracted. Builder's
 * side is still read from `componentRegistry.ts` by pattern, because this
 * runs before the TypeScript build (`prebuild`, `check:components`); the
 * prop-level checks, which need the registry evaluated, live in
 * `src/utils/componentRegistry.manifest.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.resolve(root, '../../packages/@softn/components/component-manifest.json');
const builderRegistryPath = path.resolve(root, 'src/utils/componentRegistry.ts');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const registeredNames = [...new Set(Object.values(manifest.registered).flat())].sort();

const builderSource = fs.readFileSync(builderRegistryPath, 'utf8');
const builderNames = [...new Set([...builderSource.matchAll(/comp\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort();

const missingInBuilder = registeredNames.filter((name) => !builderNames.includes(name));
const extraInBuilder = builderNames.filter((name) => !registeredNames.includes(name));

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
console.error('Regenerate the manifest with `npm run generate:manifest -w @softn/components` if the library changed; otherwise update src/utils/componentRegistry.ts.');
process.exit(1);
