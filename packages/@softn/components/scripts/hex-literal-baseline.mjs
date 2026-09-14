#!/usr/bin/env node
/**
 * Count the hex colour literals in each component source outside src/theme,
 * and write the counts to test/hex-literal-baseline.json.
 *
 * A colour written as `#6366f1` in a component ignores the theme: the dark
 * theme, and any custom one, cannot reach it. The theme module is where
 * colours belong (as tokens the ThemeProvider publishes as custom
 * properties), so the baseline is a ratchet: test/hex-literals.test.ts fails
 * when a file gains a literal or a new file brings any, and asks for this
 * script to be re-run when a file loses some, so the count only goes down.
 *
 *     npm run generate:hex-baseline -w @softn/components
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const baselinePath = join(packageRoot, 'test', 'hex-literal-baseline.json');

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'theme') continue;
      yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(name) && !name.includes('.test.')) {
      yield full;
    }
  }
}

/** `{ 'src/form/Button.tsx': 31, … }` for every file with at least one literal. */
export function countHexLiterals() {
  const counts = {};
  for (const file of sourceFiles(join(packageRoot, 'src'))) {
    const n = (readFileSync(file, 'utf8').match(HEX) ?? []).length;
    if (n > 0) counts[relative(packageRoot, file).split(sep).join('/')] = n;
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const counts = countHexLiterals();
  writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`wrote ${relative(process.cwd(), baselinePath)}: ${total} literals in ${Object.keys(counts).length} files`);
}
