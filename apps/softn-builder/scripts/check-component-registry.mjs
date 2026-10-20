/**
 * The palette offers exactly the components the library registers.
 *
 * The library's side is `packages/@softn/components/component-manifest.json`,
 * generated from the component sources (its `registered` map says what each
 * registry entry registers) and held current by that package's own test.
 * This script used to re-parse the library's registry source with regular
 * expressions; the manifest is the same fact, already extracted. Builder's
 * side is still read from `componentRegistry.ts` by pattern, because this
 * runs before the TypeScript build (`npm run build` runs `check:components`
 * first); the prop-level checks, which need the registry evaluated, live in
 * `src/utils/componentRegistry.manifest.test.ts`.
 *
 * It also checks that `src/utils/componentProps.generated.ts`, the props'
 * defaults and choices the registry takes from the manifest, was made from
 * the manifest as it is now.
 */
import fs from 'node:fs';
import path from 'node:path';
import { componentPropsPath, renderComponentProps } from './generate-component-props.mjs';

const root = process.cwd();
const manifestPath = path.resolve(root, '../../packages/@softn/components/component-manifest.json');
const builderRegistryPath = path.resolve(root, 'src/utils/componentRegistry.ts');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (fs.readFileSync(componentPropsPath, 'utf8').replace(/\r\n/g, '\n') !== renderComponentProps(manifest)) {
  console.error('[component-registry] src/utils/componentProps.generated.ts is stale: run `npm run generate:component-props -w @softn/builder`.');
  process.exit(1);
}
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
