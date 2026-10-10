/**
 * What `<import Name from="./x.ui" />` does to a page.
 *
 * An imported page is an include. Where its name is written, its markup is
 * put — as text, in the importing page's scope — and its `<logic>` joins the
 * page's one logic block. It is not a component: it has no properties, no
 * events and no children, and whatever is written on its tag is dropped.
 * Real apps are built on exactly this. A sidebar kept in its own file reads
 * the page's `sidebarCollapsed` and calls the page's `navigate(...)` with
 * nothing passed to it.
 *
 * What these tests hold is the edge of that: the two ways an import is
 * written, a use the composer used not to find and one it should not have
 * (inside a comment), saying so when something written on a tag is dropped,
 * and the three things a whole page carries that belong to the document and
 * not inside another page's markup — an `<App>` root, a `<data>` block and
 * a `<style>` block.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { composeBundleSource } from '../src/bundle/source-composer';
import { parse } from '../src/parser';
import type { TemplateNode } from '../src/parser';

const bundle = (files: Record<string, string>) => new Map<string, string>(Object.entries(files));

/** Compose `ui/main.ui` of a bundle and return the markup it became. */
const compose = (files: Record<string, string>): string =>
  composeBundleSource(bundle(files), 'ui/main.ui').source;

/** Every element's tag in a parsed template, in document order, blocks included. */
function tagsIn(nodes: TemplateNode[]): string[] {
  const tags: string[] = [];
  const visit = (list: TemplateNode[] | undefined): void => {
    for (const node of list ?? []) {
      if (node.type === 'Element') {
        tags.push(node.tag);
        visit(node.children);
      } else if (node.type === 'IfBlock') {
        visit(node.consequent);
        if (Array.isArray(node.alternate)) visit(node.alternate);
        else if (node.alternate) visit([node.alternate]);
      } else if (node.type === 'EachBlock') {
        visit(node.body);
        visit(node.emptyFallback);
      }
    }
  };
  visit(nodes);
  return tags;
}

let warn: MockInstance<typeof console.warn>;
/** What the composer said, one string for each console.warn. */
const warnings = (): string[] => warn.mock.calls.map((call) => call.map(String).join(' '));

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('how an import is written', () => {
  // The parser reads `from="./x.ui"` and `from "./x.ui"` as the same import.
  // The composer looked for the first only, so a page written the second way
  // parsed without complaint and then drew "Unknown component" for every
  // page it had imported: the bundler's own worked example was written so.
  it.each([
    ['from="./card.ui"'],
    ["from='./card.ui'"],
    ['from "./card.ui"'],
    ["from './card.ui'"],
    ['from = "./card.ui"'],
  ])('%s is the same import', (from) => {
    const source = compose({
      'ui/main.ui': `<import Card ${from} />\n<App>\n  <Card />\n</App>`,
      'ui/card.ui': '<Text>card</Text>',
    });
    // The import line goes, with its line ending, and the page stands where
    // its name was.
    expect(source).toBe('<App>\n  <Text>card</Text>\n</App>');
    expect(warnings()).toEqual([]);
  });

  it('leaves no import behind for the parser, whichever way each was written', () => {
    const source = compose({
      'ui/main.ui':
        '<import Top from="./top.ui" />\n<import Bottom from "./bottom.ui" />\n<App><Top /><Bottom /></App>',
      'ui/top.ui': '<Text>top</Text>',
      'ui/bottom.ui': '<Text>bottom</Text>',
    });
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.imports).toEqual([]);
    expect(tagsIn(doc.template)).toEqual(['App', 'Text', 'Text']);
  });

  it('is held to the bundle whichever way it is written', () => {
    // Without the `=` the line was not read as an import at all, so a path
    // that climbs out of the bundle was never looked at.
    for (const from of ['from="../../secret.ui"', 'from "../../secret.ui"']) {
      expect(() =>
        compose({ 'ui/main.ui': `<import Secret ${from} /><Secret />`, 'secret.ui': '<Text>no</Text>' })
      ).toThrow(/Unsafe import path/);
    }
  });
});

describe('where an imported page is used', () => {
  const row = { 'ui/row.ui': '<Text>{item.title}</Text>' };

  it('is found when an attribute holds an arrow function', () => {
    // The use was looked for with a pattern that stopped at the first `>`,
    // and the `>` of `=>` is one. The tag was never replaced, so the page
    // drew "Unknown component: <Row>" once for every item in the list.
    const source = compose({
      'ui/main.ui':
        '<import Row from="./row.ui" />\n#each (item in items)\n  <Row item={item} @pick={() => pick(item.id)} />\n#end',
      ...row,
    });
    expect(source).toBe('#each (item in items)\n  <Text>{item.title}</Text>\n#end');
  });

  it('is found in its paired form when an attribute holds an arrow function', () => {
    // This one was replaced before, by accident: the pattern took the arrow's
    // `>` for the end of the opening tag and ran on to the closing tag anyway.
    const source = compose({
      'ui/main.ui':
        '<import Row from="./row.ui" />\n<App>\n  <Row @pick={(id) => pick(id)}>\n    <Text>never shown</Text>\n  </Row>\n</App>',
      ...row,
    });
    expect(source).toBe('<App>\n  <Text>{item.title}</Text>\n</App>');
  });

  it('does not take the page up to a later closing tag with it', () => {
    // The same accident, where it did harm: a self-closing use with an arrow
    // function was read as an opening tag ending at the arrow, and everything
    // from there to the next `</Row>` — other elements included — was
    // replaced by one copy of the page.
    const source = compose({
      'ui/main.ui':
        '<import Row from="./row.ui" />\n<Row @pick={() => pick(1)} />\n<Text>between</Text>\n<Row></Row>',
      ...row,
    });
    expect(source).toBe('<Text>{item.title}</Text>\n<Text>between</Text>\n<Text>{item.title}</Text>');
  });

  it('ends where the tag ends, not at a > inside a quoted value or an expression', () => {
    // A comparison, a quoted "/>" and a template literal each hold a `>` that
    // is not the end of the tag.
    const source = compose({
      'ui/main.ui':
        '<import Row from="./row.ui" />\n<Row label="a > b" hint={n > 1 ? "/>" : `${n}>`} style={{ x: { y: 1 } }} /><Text>after</Text>',
      ...row,
    });
    expect(source).toBe('<Text>{item.title}</Text><Text>after</Text>');
  });

  it('is found across lines, with a comment among its attributes', () => {
    const source = compose({
      'ui/main.ui':
        '<import Row from="./row.ui" />\n<Row\n  // which item\n  item={item}\n  @pick={() => pick(item.id)}\n/>',
      ...row,
    });
    expect(source).toBe('<Text>{item.title}</Text>');
  });

  it('is not taken for a longer name that begins the same way', () => {
    const source = compose({
      'ui/main.ui': '<import Row from="./row.ui" />\n<RowHeader @sort={() => sort()} />\n<Row />',
      ...row,
    });
    expect(source).toBe('<RowHeader @sort={() => sort()} />\n<Text>{item.title}</Text>');
    expect(warnings()).toEqual([]);
  });

  it('is not found in words that only begin like one', () => {
    // `<Row is …` in a comment is not a tag: it runs into the next `<` before
    // any `>`. The pattern did not mind what it crossed, so it took everything
    // from there to the next `/>` — the element after the comment included.
    const source = compose({
      'ui/main.ui': '<import Row from="./row.ui" />\n// a <Row is one line of the list\n<Divider />\n<Row />',
      ...row,
    });
    expect(source).toBe('// a <Row is one line of the list\n<Divider />\n<Text>{item.title}</Text>');
    expect(warnings()).toEqual([]);
  });

  it('leaves an opening tag that is never closed as it was written', () => {
    const source = compose({
      'ui/main.ui': '<import Row from="./row.ui" />\n<Row @pick={() => pick()}>\n<Text>unclosed</Text>',
      ...row,
    });
    expect(source).toBe('<Row @pick={() => pick()}>\n<Text>unclosed</Text>');
  });
});

describe('an imported name written inside a comment', () => {
  // A comment is not markup, and a use inside one was replaced all the same:
  // the name was looked for in the text, wherever it stood. Commenting a use
  // out did not take it out. Where the page that replaced it had a comment
  // of its own, that comment's `-->` ended the author's, and the rest of the
  // "commented out" page was drawn; behind `//`, every line of it after the
  // first was.
  const row = { 'ui/row.ui': '<!-- one line of the list -->\n<Text>{item.title}</Text>\n<Divider />' };

  it('is left as it is written, in each kind of comment', () => {
    const main = [
      '<!-- <Row /> stood here -->',
      '// and <Row item={item} /> here',
      '<App>',
      '  {/* <Row /> */}',
      '  <Box // <Row /> is not placed in a tag either',
      '    gap=md',
      '  />',
      '  <!--',
      '    <Row>',
      '      <Text>the paired form</Text>',
      '    </Row>',
      '  -->',
      '</App>',
    ].join('\n');
    const source = compose({ 'ui/main.ui': `<import Row from="./row.ui" />\n${main}`, ...row });
    expect(source).toBe(main);
    expect(warnings()).toEqual([]);
  });

  it('does not stop the uses beside it from being placed', () => {
    const source = compose({
      'ui/main.ui': [
        '<import Row from="./row.ui" />',
        '<App>',
        '  <!-- <Row /> --><Row />',
        '  <Text>see http://example.com/<Row /></Text>',
        '  // the list',
        '  <Row></Row>',
        '</App>',
      ].join('\n'),
      'ui/row.ui': '<Text>{item.title}</Text>',
    });
    expect(source).toBe(
      [
        '<App>',
        '  <!-- <Row /> --><Text>{item.title}</Text>',
        '  <Text>see http://example.com/<Text>{item.title}</Text></Text>',
        '  // the list',
        '  <Text>{item.title}</Text>',
        '</App>',
      ].join('\n')
    );
  });

  it('is left in the comments of a page placed earlier, too', () => {
    // Uses are looked for over the page as it stands so far, so a comment
    // brought in with one imported page is in front of the next import.
    const source = compose({
      'ui/main.ui': '<import Table from="./table.ui" />\n<import Row from="./row.ui" />\n<App><Table /></App>',
      'ui/table.ui': '<Stack>\n  <!-- each <Row /> is a todo -->\n  <Row />\n</Stack>',
      'ui/row.ui': '<Text>{item.title}</Text>',
    });
    expect(source).toBe('<App><Stack>\n  <!-- each <Row /> is a todo -->\n  <Text>{item.title}</Text>\n</Stack></App>');
  });
});

describe('attributes and children on an imported page', () => {
  // They are dropped: the language has no properties or events for an
  // imported page. Dropping them silently is how a page came to pass
  // `title="My Todos"` to a header that could never read it, so each use
  // that carries something is named once, with what was ignored and what the
  // imported page reads instead.
  it('says what was ignored, once for each use', () => {
    const source = compose({
      'ui/main.ui': [
        '<import Header from="./header.ui" />',
        '<import Row from="./row.ui" />',
        '<App>',
        '  <Header title="My Todos" />',
        '  #each (item in items)',
        '    <Row item={item} @toggle={() => toggle(item.id)} @delete={() => remove(item.id)} />',
        '  #end',
        '</App>',
      ].join('\n'),
      'ui/header.ui': '<Heading>{title}</Heading>',
      'ui/row.ui': '<Text>{item.title}</Text>',
    });
    expect(source).toContain('<Heading>{title}</Heading>');
    expect(source).toContain('<Text>{item.title}</Text>');
    expect(warnings()).toEqual([
      "[SoftN] ui/main.ui: <Header> is an imported page, so its attributes (title) are ignored. It is placed here as written and reads this page's state instead.",
      "[SoftN] ui/main.ui: <Row> is an imported page, so its attributes (item, @toggle, @delete) are ignored. It is placed here as written and reads this page's state instead.",
    ]);
  });

  it('names children, and attributes and children together', () => {
    compose({
      'ui/main.ui':
        '<import Panel from="./panel.ui" />\n<Panel><Text>inside</Text></Panel>\n<Panel tone="quiet" :open={open}>inside</Panel>',
      'ui/panel.ui': '<Card />',
    });
    expect(warnings()).toEqual([
      "[SoftN] ui/main.ui: <Panel> is an imported page, so its children are ignored. It is placed here as written and reads this page's state instead.",
      "[SoftN] ui/main.ui: <Panel> is an imported page, so its attributes (tone, :open) and children are ignored. It is placed here as written and reads this page's state instead.",
    ]);
  });

  it('says nothing about a use that carries nothing', () => {
    const source = compose({
      'ui/main.ui': '<import Panel from="./panel.ui" />\n<Panel />\n<Panel/>\n<Panel></Panel>\n<Panel>\n</Panel>',
      'ui/panel.ui': '<Card />',
    });
    expect(source).toBe('<Card />\n<Card />\n<Card />\n<Card />');
    expect(warnings()).toEqual([]);
  });

  it('names the page the use is written in, not the app’s main page', () => {
    compose({
      'ui/main.ui': '<import Home from="./pages/home.ui" />\n<App><Home /></App>',
      'ui/pages/home.ui': '<import Row from="../row.ui" />\n<Stack><Row dense /></Stack>',
      'ui/row.ui': '<Text>row</Text>',
    });
    expect(warnings()).toEqual([
      "[SoftN] ui/pages/home.ui: <Row> is an imported page, so its attributes (dense) are ignored. It is placed here as written and reads this page's state instead.",
    ]);
  });
});

describe('an imported page with an App root', () => {
  // A page that runs on its own is written inside `<App>`. Imported into
  // another page it is that page's content, not a second app inside the
  // first, so the wrapper is taken off as the page is placed. What the
  // wrapper said about the app — its theme, its style — belongs to the page
  // that is the app, and goes with it.
  it('contributes what is inside its App', () => {
    const source = compose({
      'ui/main.ui': '<import Home from="./pages/home.ui" />\n<App theme="light">\n  <Home />\n</App>',
      'ui/pages/home.ui': '<App theme="dark" style={{ padding: 0 }}>\n  <Heading>Home</Heading>\n  <Text>{greeting}</Text>\n</App>',
    });
    expect(source).toBe('<App theme="light">\n  <Heading>Home</Heading>\n  <Text>{greeting}</Text>\n</App>');
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(tagsIn(doc.template)).toEqual(['App', 'Heading', 'Text']);
    // Taking the wrapper off is what an import means; nothing was ignored
    // that the author wrote on the use.
    expect(warnings()).toEqual([]);
  });

  it('keeps the comments written beside the App', () => {
    // Only the wrapper is taken off.
    const source = compose({
      'ui/main.ui': '<import Home from="./home.ui" />\n<App>\n<Home />\n</App>',
      'ui/home.ui':
        '// home.ui - the first page\n<!-- shown at / -->\n<App>\n  <Heading class="title">Home</Heading>\n</App>\n<!-- the end -->\n',
    });
    expect(source).toBe('<App>\n<!-- shown at / -->\n<Heading class="title">Home</Heading>\n<!-- the end -->\n</App>');
  });

  it('contributes nothing for an App with nothing in it', () => {
    expect(
      compose({
        'ui/main.ui': '<import Blank from="./blank.ui" />\n<App><Blank /></App>',
        'ui/blank.ui': '<App theme="dark" />',
      })
    ).toBe('<App></App>');
  });

  it('takes the wrapper off at every level of a page that imports a page', () => {
    const source = compose({
      'ui/main.ui': '<import Home from="./home.ui" />\n<App><Home /></App>',
      'ui/home.ui': '<import Card from="./card.ui" />\n<App><Stack><Card /></Stack></App>',
      'ui/card.ui': '<App><Text>card</Text></App>',
    });
    expect(source).toBe('<App><Stack><Text>card</Text></Stack></App>');
  });

  it('leaves the main page’s own App alone', () => {
    const main = '<App theme="dark">\n  <Text>only page</Text>\n</App>';
    expect(compose({ 'ui/main.ui': main })).toBe(main);
  });

  it.each([
    ['two roots', '<App><Text>a</Text></App>\n<Text>b</Text>'],
    ['two Apps', '<App><Text>a</Text></App>\n<App><Text>b</Text></App>'],
    ['an App inside a block', '#if (ready)\n<App><Text>a</Text></App>\n#end'],
    ['an App inside another element', '<Stack><App><Text>a</Text></App></Stack>'],
    ['a longer name', '<AppShell><Text>a</Text></AppShell>'],
    ['words beside the App', 'Loading\n<App><Text>a</Text></App>'],
  ])('leaves a page with %s as it was written', (_what, page) => {
    // Only a page that is one App and nothing else is unwrapped. Anything
    // else is placed as written, as it always was.
    expect(
      compose({
        'ui/main.ui': '<import Page from="./page.ui" />\n<Page />',
        'ui/page.ui': page,
      })
    ).toBe(page);
  });
});

describe('a data block in an imported page', () => {
  // `<data>` declares the collections a page reads, and only at the top of a
  // document: the parser reads `<data>` inside an element as an element. An
  // imported page's block used to be pasted in with the rest of it, so its
  // collections were never declared — the page read nothing — and two stray
  // elements named `data` and `collection` were drawn where it stood.
  it('becomes declarations of the document', () => {
    const source = compose({
      'ui/main.ui': '<import List from="./list.ui" />\n<App>\n  <List />\n</App>',
      'ui/list.ui': [
        '<data>',
        '  <collection name="todos" as="todos" sort="createdAt:desc" limit={20} />',
        '</data>',
        '#each (todo in todos)',
        '  <Text>{todo.data.text}</Text>',
        '#end',
      ].join('\n'),
    });
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections.map(({ name, as, sort, limit }) => ({ name, as, sort, limit }))).toEqual([
      { name: 'todos', as: 'todos', sort: 'createdAt:desc', limit: 20 },
    ]);
    expect(tagsIn(doc.template)).toEqual(['App', 'Text']);
    expect(warnings()).toEqual([]);
  });

  it('joins the main page’s block and does not repeat what it already declares', () => {
    // The parser keeps one `<data>` block for a document — a second replaces
    // the first — so there must be exactly one, holding everything.
    const source = compose({
      'ui/main.ui': [
        '<import List from="./list.ui" />',
        '<import People from="./people.ui" />',
        '<data>',
        '  <collection name="todos" as="todos" />',
        '  <collection name="tags" />',
        '</data>',
        '<App><List /><People /></App>',
      ].join('\n'),
      'ui/list.ui':
        '<data>\n  <collection name="todos" as="todos" />\n  <collection name="tags" as="tags" />\n  <collection name="todos" as="open" filter={{ completed: false, note: "a > b" }} />\n</data>\n<Text>{count(open)}</Text>',
      'ui/people.ui': '<data><collection name="people" /><collection name="tags" /></data><Text>{count(people)}</Text>',
    });
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(source.match(/<data[\s>]/g)).toHaveLength(1);
    expect(doc.data?.collections.map(({ name, as }) => `${name} as ${as}`)).toEqual([
      'todos as todos',
      'tags as tags',
      'todos as open',
      'people as people',
    ]);
    expect(doc.data?.collections[2].filter).toMatchObject({ type: 'ObjectExpression' });
    expect(tagsIn(doc.template)).toEqual(['App', 'Text', 'Text']);
  });

  it('is declared once for a page that is used twice, or not used at all', () => {
    // Like its logic, a page's declarations join the document because the
    // page was imported, not each time its name is written.
    const list = '<data><collection name="todos" /></data><Text>{count(todos)}</Text>';
    for (const uses of ['<List /><List />', '']) {
      const doc = parse(
        compose({ 'ui/main.ui': `<import List from="./list.ui" />\n<App>${uses}</App>`, 'ui/list.ui': list })
      );
      expect(doc.data?.collections.map((c) => c.name)).toEqual(['todos']);
    }
  });

  it('comes through a page that imports a page, and from under an App root', () => {
    const doc = parse(
      compose({
        'ui/main.ui': '<import Home from="./home.ui" />\n<App><Home /></App>',
        'ui/home.ui':
          '<import List from="./list.ui" />\n<data><collection name="notes" /></data>\n<App>\n  <List />\n</App>',
        'ui/list.ui': '<data><collection name="todos" /></data>\n<Text>{count(todos)}</Text>',
      })
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections.map((c) => c.name).sort()).toEqual(['notes', 'todos']);
    expect(tagsIn(doc.template)).toEqual(['App', 'Text']);
  });

  it('keeps the page’s own name for a collection when an imported page gives it to another', () => {
    // Two declarations of one name would leave the page reading whichever
    // was read last. The page that is the app decides, and the other is
    // named rather than dropped in silence.
    const doc = parse(
      compose({
        'ui/main.ui':
          '<import List from="./list.ui" />\n<data><collection name="tasks" as="items" /></data>\n<App><List /></App>',
        'ui/list.ui': '<data><collection name="todos" as="items" /></data>\n<Text>{count(items)}</Text>',
      })
    );
    expect(doc.data?.collections.map(({ name, as }) => `${name} as ${as}`)).toEqual(['tasks as items']);
    expect(warnings()).toEqual([
      '[SoftN] ui/list.ui: <collection name="todos" as="items"> is not declared, because this app already reads "tasks" as items.',
    ]);
  });

  it('reads every data block of the main page as the page’s own', () => {
    // A page's blocks are one set of declarations. A name the first block
    // gave away is taken, though the imported page's declarations are
    // written into the last.
    const source = compose({
      'ui/main.ui': [
        '<import List from="./list.ui" />',
        '<data><collection name="tasks" as="items" /></data>',
        '<App><List /></App>',
        '<data>',
        '  <collection name="tags" />',
        '</data>',
      ].join('\n'),
      'ui/list.ui':
        '<data><collection name="todos" as="items" /><collection name="tags" /><collection name="notes" /></data>\n<Text>{count(items)}</Text>',
    });
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections.map(({ name, as }) => `${name} as ${as}`)).toEqual([
      'tasks as items',
      'tags as tags',
      'notes as notes',
    ]);
    expect(warnings()).toEqual([
      '[SoftN] ui/list.ui: <collection name="todos" as="items"> is not declared, because this app already reads "tasks" as items.',
    ]);
  });

  it('leaves out a declaration the parser would refuse, so it cannot take the page’s block with it', () => {
    // A collection with no name fails the whole `<data>` block it is in.
    // Inside the main page's block that would undeclare the page's own
    // collections because of a file it imported.
    const doc = parse(
      compose({
        'ui/main.ui':
          '<import List from="./list.ui" />\n<data><collection name="tasks" /></data>\n<App><List /></App>',
        'ui/list.ui': '<data><collection as="items" /><collection name="todos" /></data>\n<Text>list</Text>',
      })
    );
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.data?.collections.map((c) => c.name)).toEqual(['tasks', 'todos']);
    expect(warnings()).toEqual([
      '[SoftN] ui/list.ui: a <collection> in its <data> block has no usable name and is not declared.',
    ]);
  });

  it('leaves a <data> element inside the page’s markup where it is', () => {
    // Only a block at the top of the imported page is a declaration; the
    // parser reads one inside an element as an element, in any page.
    const page = '<Stack>\n  <data value="42">forty-two</data>\n</Stack>';
    expect(
      compose({ 'ui/main.ui': '<import Page from="./page.ui" />\n<Page />', 'ui/page.ui': page })
    ).toBe(page);
  });
});

describe('a style block in an imported page', () => {
  // `<style>` is a declaration of the document, like `<data>`: read as one
  // at the top of a page and nowhere else. Pasted in with the page it stood
  // inside an element, where the parser reads it as an element named
  // `style` with nothing in it — so the rules were lost, and the renderer,
  // which refuses to draw a `style` element, drew "Unknown component:
  // <style>" in their place. Once for each use: a row placed by `#each`
  // drew the box under every row.
  const header = '<header class="header">{title}</header>\n<style>\n.header > h1 { color: red; }\n</style>\n';

  it('joins the document’s one style block, after the page’s own rules', () => {
    const source = compose({
      'ui/main.ui':
        '<import Header from="./header.ui" />\n<App>\n  <Header />\n</App>\n<style>\n.app { color: black; }\n</style>',
      'ui/header.ui': header,
    });
    expect(source).toBe(
      '<App>\n  <header class="header">{title}</header>\n</App>\n<style>\n.app { color: black; }\n.header > h1 { color: red; }\n</style>'
    );
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.style?.content).toBe('.app { color: black; }\n.header > h1 { color: red; }');
    expect(tagsIn(doc.template)).toEqual(['App', 'header']);
    expect(warnings()).toEqual([]);
  });

  it('becomes the document’s style block when the main page has none', () => {
    const source = compose({
      'ui/main.ui': '<import Header from="./header.ui" />\n<App>\n  <Header />\n</App>',
      'ui/header.ui': header,
    });
    expect(source).toBe(
      '<App>\n  <header class="header">{title}</header>\n</App>\n<style>\n.header > h1 { color: red; }\n</style>'
    );
    expect(parse(source).style?.content).toBe('.header > h1 { color: red; }');
  });

  it('joins once, however often the page is used', () => {
    // Like its logic and its collections, a page's rules join the document
    // because the page was imported, not each time its name is written.
    const row = '<Text class="row">{item.title}</Text>\n<style>.row { padding: 4px; }</style>';
    for (const uses of ['#each (item in items)\n<Row />\n#end\n<Row />', '']) {
      const source = compose({ 'ui/main.ui': `<import Row from="./row.ui" />\n<App>${uses}</App>`, 'ui/row.ui': row });
      expect(source.match(/\.row \{ padding: 4px; \}/g)).toHaveLength(1);
      const doc = parse(source);
      expect(doc.style?.content).toBe('.row { padding: 4px; }');
      expect(tagsIn(doc.template)).not.toContain('style');
    }
  });

  it('comes in the order of the imports, a page before the pages it imports', () => {
    // Where two rules are a match for each other the later one is applied,
    // so the order is one an author can know: the main page's own rules,
    // then each imported page's as the imports are written, a page's own
    // before those of a page it imports in turn.
    const source = compose({
      'ui/main.ui': [
        '<style>.main { order: 0; }</style>',
        '<import Home from="./home.ui" />',
        '<import Footer from="./footer.ui" />',
        '<App><Home /><Footer /></App>',
      ].join('\n'),
      'ui/home.ui':
        '<import Card from="./card.ui" />\n<Stack class="home"><Card /></Stack>\n<style>.home { order: 1; }</style>',
      'ui/card.ui': '<style>.card { order: 2; }</style>\n<Text class="card">card</Text>',
      'ui/footer.ui': '<Text class="footer">footer</Text>\n<style>.footer { order: 3; }</style>',
    });
    const doc = parse(source);
    expect(doc.diagnostics ?? []).toEqual([]);
    expect(doc.style?.content).toBe(
      '.main { order: 0; }\n.home { order: 1; }\n.card { order: 2; }\n.footer { order: 3; }'
    );
    expect(tagsIn(doc.template)).toEqual(['App', 'Stack', 'Text', 'Text']);
  });

  it('is taken from beside an App root, and from a page with several blocks', () => {
    const source = compose({
      'ui/main.ui': '<import Home from="./home.ui" />\n<App>\n<Home />\n</App>',
      'ui/home.ui':
        '<style>\n.home > .title { color: red; }\n</style>\n<App>\n  <Heading class="title">Home</Heading>\n</App>\n<style scoped>.home { margin: 0; }</style>\n',
    });
    expect(source).toBe(
      '<App>\n<Heading class="title">Home</Heading>\n</App>\n<style>\n.home > .title { color: red; }\n.home { margin: 0; }\n</style>'
    );
  });

  it('adds nothing for a block with nothing in it', () => {
    const main = '<import Blank from="./blank.ui" />\n<App><Blank /></App>';
    expect(compose({ 'ui/main.ui': main, 'ui/blank.ui': '<style>\n</style>\n<Text>blank</Text>' })).toBe(
      '<App><Text>blank</Text></App>'
    );
  });

  it('leaves a <style> written inside the page’s own markup where it is', () => {
    // Only a block at the top of the imported page is its style block. One
    // inside an element is an element in any page, the page on its own
    // included, and moving it would hide that from its author.
    const page = '<Stack>\n  <style>.inner { color: red; }</style>\n</Stack>';
    expect(
      compose({ 'ui/main.ui': '<import Page from="./page.ui" />\n<Page />', 'ui/page.ui': page })
    ).toBe(page);
  });
});

describe('what did not change', () => {
  it('a fragment is placed exactly as real apps write one', () => {
    // The shape of a real app's sidebar: comment lines, an `if=` on the
    // root, the page's state and functions read directly. Byte for byte
    // what the composer has always produced. (This fixture once ended in a
    // `<style>` block and expected it left in place. No shipped app's
    // imported page has one, and left in place it was drawn as an unknown
    // component: see "a style block in an imported page" above.)
    const source = compose({
      'ui/main.ui': [
        '// main.ui - the app',
        '<logic src="../logic/main.logic" />',
        '',
        '// Import components',
        '<import Sidebar from="./components/Sidebar.ui" />',
        '',
        '<data>',
        '  <collection name="clients" as="clients" />',
        '</data>',
        '',
        '<App theme={theme}>',
        '  <Sidebar />',
        '  <Text>{count(clients)}</Text>',
        '</App>',
      ].join('\n'),
      'ui/components/Sidebar.ui': [
        '// Sidebar.ui - Navigation sidebar component',
        '',
        '// Expanded Sidebar',
        '<Box',
        '  if={!sidebarCollapsed}',
        '  style={{ background: getSidebarBg(), borderRight: "1px solid " + getBorderColor() }}',
        '>',
        '  // Logo Header',
        '  <NavItem icon=dashboard label="Dashboard" active={currentPage === "dashboard"} @click={navigate("dashboard")} />',
        '</Box>',
        '',
      ].join('\n'),
      'logic/main.logic': 'let sidebarCollapsed = false;',
    });
    expect(source).toBe(
      [
        '// main.ui - the app',
        '',
        '',
        '// Import components',
        '',
        '<data>',
        '  <collection name="clients" as="clients" />',
        '</data>',
        '',
        '<App theme={theme}>',
        '  <Box',
        '  if={!sidebarCollapsed}',
        '  style={{ background: getSidebarBg(), borderRight: "1px solid " + getBorderColor() }}',
        '>',
        '  // Logo Header',
        '  <NavItem icon=dashboard label="Dashboard" active={currentPage === "dashboard"} @click={navigate("dashboard")} />',
        '</Box>',
        '  <Text>{count(clients)}</Text>',
        '</App>',
        '<logic>',
        'let sidebarCollapsed = false;',
        '</logic>',
      ].join('\n')
    );
    expect(warnings()).toEqual([]);
  });

  it('a name the main page imports is resolved inside a page placed before it', () => {
    // A table page that writes `<PotDisplay />` without importing it works
    // because the main page imports both, the table first. Uses are replaced
    // over the page as it stands so far, in the order of the imports.
    const source = compose({
      'ui/main.ui':
        '<import Table from="./table.ui" />\n<import PotDisplay from="./pot.ui" />\n<App><Table /></App>',
      'ui/table.ui': '<Stack><PotDisplay /></Stack>',
      'ui/pot.ui': '<Text>{pot}</Text>',
    });
    expect(source).toBe('<App><Stack><Text>{pot}</Text></Stack></App>');
  });

  it('the logic of an imported page still joins the page’s one block, before the page’s own', () => {
    const composed = composeBundleSource(
      bundle({
        'ui/main.ui': '<import Panel from="./panel.ui" />\n<logic>let main = panel + 1;</logic>\n<Panel />',
        'ui/panel.ui': '<logic>let panel = 1;</logic>\n<Text>{panel}</Text>',
      }),
      'ui/main.ui'
    );
    expect(composed.source).toBe('\n<Text>{panel}</Text>\n<logic>\nlet panel = 1;\nlet main = panel + 1;\n</logic>');
    expect(composed.languages).toEqual(['javascript']);
  });

  it('a circular import is skipped and said', () => {
    const source = compose({
      'ui/main.ui': '<import A from="./A.ui" /><A />',
      'ui/A.ui': '<import B from="./B.ui" /><div>A<B /></div>',
      'ui/B.ui': '<import A from="./A.ui" /><div>B<A /></div>',
    });
    // B's use of A is left as written: there is nothing to put there.
    expect(source).toBe('<div>A<div>B<A /></div></div>');
    expect(warn.mock.calls).toEqual([['[SoftN] Skipping circular UI import:', 'ui/A.ui']]);
  });

  it('an import whose file is missing is said, and its use is left as written', () => {
    const source = compose({
      'ui/main.ui': '<import Gone from="./gone.ui" />\n<App><Gone title="x" /></App>',
    });
    expect(source).toBe('<App><Gone title="x" /></App>');
    expect(warn.mock.calls).toEqual([['[SoftN] Imported UI file not found:', 'ui/gone.ui']]);
  });

  it('an import that would leave the bundle is still refused', () => {
    expect(() =>
      compose({ 'ui/main.ui': '<import Secret from="../../secret.ui" /><Secret />', 'secret.ui': '<Text>no</Text>' })
    ).toThrow(/Unsafe import path/);
  });
});
