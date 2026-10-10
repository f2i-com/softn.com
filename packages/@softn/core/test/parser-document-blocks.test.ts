/**
 * A page that writes `<style>` or `<data>` more than once.
 *
 * Both are declarations of the document: the stylesheet it is drawn with and
 * the collections it reads. A document has one of each, and the parser kept
 * the last block it met — so a page with two `<style>` blocks was drawn with
 * the second's rules alone, and one with two `<data>` blocks read only the
 * second's collections, and in neither case was anything said. Written twice,
 * each is now what an author meant by writing it twice: the blocks together,
 * in the order they are written.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';

const declared = (source: string) =>
  parse(source).data?.collections.map(({ name, as, sort, limit }) => ({ name, as, sort, limit }));

describe('several style blocks in one page', () => {
  it('are one stylesheet, in the order written', () => {
    const doc = parse(
      '<style>\n.first { color: red; }\n</style>\n<App><Text class="first second">hi</Text></App>\n<style>\n.second { color: blue; }\n</style>'
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.style?.content).toBe('.first { color: red; }\n.second { color: blue; }');
    // Declarations, not markup: neither block is left among the elements.
    expect(doc.template).toHaveLength(1);
  });

  it('keep their order when there are more than two', () => {
    const doc = parse('<style>.a{}</style><style>.b{}</style><App /><style>.c{}</style>');
    expect(doc.style?.content).toBe('.a{}\n.b{}\n.c{}');
  });

  it('are not added to by a block with nothing in it', () => {
    expect(parse('<style>.a{}</style><App /><style>\n</style>').style?.content).toBe('.a{}');
    expect(parse('<style></style><App /><style>.b{}</style>').style?.content).toBe('.b{}');
  });

  it('are where the first one is', () => {
    // One node stands for the stylesheet, at the place the page first wrote it.
    const doc = parse('<App />\n<style>.a{}</style>\n<style>.b{}</style>');
    expect(doc.style?.loc.line).toBe(2);
  });

  it('one block is read as it always was', () => {
    expect(parse('<App />\n<style>\n  .only { margin: 0; }\n</style>').style?.content).toBe('.only { margin: 0; }');
    expect(parse('<App />').style).toBeUndefined();
  });
});

describe('several data blocks in one page', () => {
  it('are one set of declarations, in the order written', () => {
    const source = [
      '<data>',
      '  <collection name="todos" as="todos" sort="createdAt:desc" />',
      '</data>',
      '<App />',
      '<data>',
      '  <collection name="tags" />',
      '  <collection name="people" as="team" limit={5} />',
      '</data>',
    ].join('\n');
    expect(parse(source).diagnostics ?? []).toEqual([]);
    expect(declared(source)).toEqual([
      { name: 'todos', as: 'todos', sort: 'createdAt:desc', limit: undefined },
      { name: 'tags', as: 'tags', sort: undefined, limit: undefined },
      { name: 'people', as: 'team', sort: undefined, limit: 5 },
    ]);
  });

  it('do not repeat a collection the page has already declared by that name', () => {
    const source =
      '<data><collection name="todos" /><collection name="tags" /></data>\n<App />\n<data><collection name="todos" as="todos" limit={3} /><collection name="notes" /></data>';
    expect(parse(source).diagnostics ?? []).toEqual([]);
    // The first declaration stands, with what it said: no limit.
    expect(declared(source)).toEqual([
      { name: 'todos', as: 'todos', sort: undefined, limit: undefined },
      { name: 'tags', as: 'tags', sort: undefined, limit: undefined },
      { name: 'notes', as: 'notes', sort: undefined, limit: undefined },
    ]);
  });

  it('keep the first collection a name was given, and say which was left out', () => {
    // A name is read as one collection. Two blocks giving it to two would
    // leave the page reading whichever came last, which is how the second
    // block came to replace the first in the first place.
    const doc = parse(
      '<data><collection name="tasks" as="items" /></data>\n<App />\n<data>\n  <collection name="todos" as="items" />\n</data>'
    );
    expect(doc.data?.collections.map(({ name, as }) => `${name} as ${as}`)).toEqual(['tasks as items']);
    expect(doc.diagnostics).toEqual([
      {
        severity: 'warning',
        message:
          '<collection name="todos" as="items"> is not declared, because this page already reads "tasks" as items.',
        loc: expect.objectContaining({ line: 4 }),
      },
    ]);
  });

  it('one block is read as it always was, a name written twice in it included', () => {
    // Inside one block nothing is taken out: what a repeated name reads is
    // decided where the collections are fetched, as it has been.
    expect(declared('<data><collection name="a" as="x" /><collection name="b" as="x" /></data><App />')).toEqual([
      { name: 'a', as: 'x', sort: undefined, limit: undefined },
      { name: 'b', as: 'x', sort: undefined, limit: undefined },
    ]);
    expect(parse('<App />').data).toBeUndefined();
  });
});
