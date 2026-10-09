/**
 * Builder writes back the newer loop and parameter forms as it read them.
 *
 * The engine reads `#each ([key, value] in Object.entries(totals))`, an
 * arrow that takes its argument apart, a worked-out key, and control flow
 * inside `#empty`. Builder keeps a file as a visual model and regenerates
 * the source from it on an edit, so each of these has to come through that
 * model unchanged: a pattern printed as the names it binds would be a
 * different loop, and an `#if` lost from an `#empty` branch a different page.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@softn/core';
import { generateSource } from './sourceGenerator';
import { parseSource } from './sourceParser';

/** `source` through the visual model and out again. */
function regenerated(source: string): string {
  const parsed = parseSource(source);
  return generateSource(parsed.elements, parsed.rootId, '');
}

/** The engine's reading of a source, without positions. */
function read(source: string): unknown {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return JSON.parse(JSON.stringify(doc.template, (key, value) => (key === 'loc' ? undefined : value)));
}

const page = (body: string) => `<App>\n${body}\n</App>`;

describe('a loop whose variable takes the item apart', () => {
  it.each([
    ['a pair', '#each ([key, value] in Object.entries(totals))\n<Text>{key}: {value}</Text>\n#end'],
    ['a record', '#each ({ id, title } in tasks) key={id}\n<Text>{title}</Text>\n#end'],
    ['a record with an index', '#each ({ id, owner: { name } }, i in tasks)\n<Text>{i} {name}</Text>\n#end'],
    ['a rest', '#each ([first, ...others] in rows)\n<Text>{first} {others.length}</Text>\n#end'],
  ])('%s comes back the loop it was', (_name, body) => {
    const source = page(body);
    const out = regenerated(source);
    expect(read(out)).toEqual(read(source));
    // And once more changes nothing.
    expect(regenerated(out)).toBe(out);
  });

  it('is written with its brackets', () => {
    expect(regenerated(page('#each ([key, value] in Object.entries(totals))\n<Text>{key}</Text>\n#end'))).toContain(
      '#each ([key, value] in Object.entries(totals))'
    );
    expect(regenerated(page('#each ({id,title:heading} in tasks)\n<Text>{heading}</Text>\n#end'))).toContain(
      '#each ({ id, title: heading } in tasks)'
    );
  });
});

describe('control flow inside #empty', () => {
  it('is kept as control flow', () => {
    const source = page(
      '#each (task in tasks)\n<Text>{task.title}</Text>\n#empty\n#if (loading)\n<Spinner />\n#else\n<Text>Nothing yet</Text>\n#end\n#end'
    );
    const out = regenerated(source);
    expect(read(out)).toEqual(read(source));
    expect(out).toContain('#if (loading)');
    expect(regenerated(out)).toBe(out);
  });
});

describe('an arrow that takes its argument apart, and a worked-out key', () => {
  it.each([
    ['<Text>{Object.entries(totals).map(([name, total]) => name + ": " + total).join(", ")}</Text>'],
    ['<Text>{tasks.reduce((sum, { minutes = 0 }) => sum + minutes, 0)}</Text>'],
    ['<Button @click={({ id }, ...rest) => open(id, rest.length)}>Open</Button>'],
    ['<Button @click={() => filters = { ...filters, [field]: !filters[field] }}>Toggle</Button>'],
    ['<Select options={Object.entries(labels).map(([value, label]) => ({ value, label }))} />'],
  ])('%s', (line) => {
    const source = page(line);
    const out = regenerated(source);
    expect(read(out)).toEqual(read(source));
    expect(regenerated(out)).toBe(out);
  });
});
