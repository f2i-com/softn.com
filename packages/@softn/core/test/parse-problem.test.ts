/**
 * Where a page does not parse, at the line of the file it is in.
 *
 * The renderer is handed the composed page: imports inlined, inline logic taken
 * out and put at the end. The parser's line in that is one the author can find
 * in no file, so a host that means to say where has to be told by the composer,
 * which knows the pages it read.
 */
import { describe, expect, it } from 'vitest';
import { composeBundleSource } from '../src/bundle/source-composer';

const compose = (files: Record<string, string>, main = 'ui/main.ui') =>
  composeBundleSource(new Map(Object.entries(files)), main);

describe('composeBundleSource', () => {
  it('says nothing of a page that parses', () => {
    expect(compose({ 'ui/main.ui': '<App><Text>fine</Text></App>' })).not.toHaveProperty('parseProblem');
  });

  it('says nothing of a page the parser only warns about', () => {
    const page = `<data><collection name="tasks" as="items" /></data>
<div>drawn</div>
<data><collection name="todos" as="items" /></data>`;
    expect(compose({ 'ui/main.ui': page })).not.toHaveProperty('parseProblem');
  });

  it('names the main page and its line', () => {
    expect(compose({ 'ui/main.ui': '<App><Text>{a</Text></App>' }).parseProblem).toBe(
      'ui/main.ui, line 1, column 7: Unclosed tag: <Text>'
    );
  });

  it('gives the line of the file, with logic above the mistake taken out of the composed page', () => {
    const page = `<logic>
let a = 1;
let b = 2;
</logic>
<div>
  <p>{1 +}</p>
</div>`;
    const { source, parseProblem } = compose({ 'ui/main.ui': page });
    expect(source.split('\n').findIndex((line) => line.includes('{1 +}'))).toBeLessThan(5);
    expect(parseProblem).toMatch(/^ui\/main\.ui, line 6, column \d+: /);
  });

  it('names the imported page the mistake is in, at its own line', () => {
    const composed = compose({
      'ui/main.ui': `<import Header from="./header.ui" />
<div>
  <p>first</p>
  <p>second</p>
  <Header />
</div>`,
      'ui/header.ui': `<header>
  <h1>Title</h1>
  <p>{1 +}</p>
</header>`,
    });
    expect(composed.parseProblem).toMatch(/^ui\/header\.ui, line 3, column \d+: /);
  });
});
