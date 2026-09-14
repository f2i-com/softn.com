/**
 * Colours belong to the theme (src/theme), where the ThemeProvider publishes
 * them as custom properties both themes can set. A hex literal inside a
 * component is a colour the dark theme cannot reach. The baseline records
 * how many each file has today; this test lets that number fall and never
 * rise, and admits no new file with any.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { baselinePath, countHexLiterals } from '../scripts/hex-literal-baseline.mjs';

describe('hex colour literals outside src/theme', () => {
  const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = countHexLiterals();

  it('do not appear in a file that had none', () => {
    const newcomers = Object.keys(current).filter((file) => !(file in baseline));
    expect(newcomers, 'new files with hex literals; use theme tokens instead').toEqual([]);
  });

  it('do not increase in any file', () => {
    const grew = Object.entries(current)
      .filter(([file, n]) => file in baseline && n > baseline[file])
      .map(([file, n]) => `${file}: ${baseline[file]} -> ${n}`);
    expect(grew, 'files that gained hex literals; use theme tokens instead').toEqual([]);
  });

  it('are recorded at their current count once they fall', () => {
    const fell = Object.entries(baseline)
      .filter(([file, n]) => (current[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} -> ${current[file] ?? 0}`);
    expect(fell, 'the count went down: run `npm run generate:hex-baseline -w @softn/components` to ratchet the baseline').toEqual([]);
  });
});
