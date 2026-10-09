/**
 * The pages people are given to learn from can be edited in Design.
 *
 * A file the visual model cannot write back is edited as source only. That
 * was the right refusal and the wrong outcome: every example in the
 * repository begins with a comment saying what it is, and the model had no
 * place for a comment, so the canvas refused each of them. The same for a
 * sentence with a key or a bold word in it. Measured over the 78 distinct
 * pages of the shipped examples and demos, 15 could be edited in Design.
 *
 * The model keeps both now, and what a file holds outside its template is
 * left as it stands. This holds the repository's own example pages to it:
 * each is read into the model without a reason against it, and written back
 * from the model, untouched, it is the same page to the engine with the same
 * comments (which is what "lossless" asserts), and its head and tail are the
 * same text.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { parseSource } from './sourceParser';
import { frameSource, writeBack } from './sourceFrame';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

function pagesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...pagesUnder(path));
    else if (name.endsWith('.ui')) found.push(path);
  }
  return found;
}

const pages = [
  ...pagesUnder(join(repo, 'examples')),
  ...pagesUnder(join(repo, 'docs', 'examples')),
  ...pagesUnder(join(here, '__fixtures__')),
].map((path) => [relative(repo, path).replace(/\\/g, '/'), path] as const);

describe('the example pages of the repository', () => {
  it('are found', () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
  });

  it.each(pages)('%s is held by the visual model', (_name, path) => {
    // Line endings as the repository stores them, whatever the checkout wrote.
    const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const parsed = parseSource(source);
    expect(parsed.fidelity).toEqual({ lossless: true, reasons: [] });

    const doc = parse(source);
    const written = writeBack(source, doc, parsed.elements, parsed.rootId);
    const frame = frameSource(source, doc)!;
    expect(written.startsWith(frame.prefix)).toBe(true);
    expect(written.endsWith(frame.tail)).toBe(true);
    // Written a second time from what was written, nothing moves.
    const again = parseSource(written);
    expect(again.fidelity).toEqual({ lossless: true, reasons: [] });
    expect(writeBack(written, parse(written), again.elements, again.rootId)).toBe(written);
  });
});
