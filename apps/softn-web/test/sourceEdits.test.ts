/**
 * An element changed where it is written (src/edit/sourceEdits.ts): its
 * words and its plain attributes, as changes to the page's text that read
 * back, through the runtime's own parser, as exactly what was asked. What
 * cannot be written so is refused, and the text is left alone.
 */

import { describe, expect, it } from 'vitest';
import { parse, type ElementNode } from '@softn/core';
import { fieldsOf, firstValue, isComponentTag } from '../src/edit/pickFields';
import { elementAtCaret, movedPlace, readElement, withAttribute, withText, type ElementSource } from '../src/edit/sourceEdits';

const PAGE = [
  '<div class="page">',
  '  <h1 id="title" class="big">Tasks</h1>',
  '  <p>Open {count} of {total}</p>',
  '  <Button variant="primary" size={2} disabled @click={() => save(1 > 0)} :bind={x}>Save</Button>',
  '  #each (task in tasks)',
  '    <li class="row" title={task.name}>one</li>',
  '  #end',
  '  <span each={tags} as="tag">tag</span>',
  '  <img src="a.png" alt="A">',
  '  <em></em>',
  '</div>',
  '',
].join('\n');

/** The element whose opening tag begins with `open`, read where it is written. */
function at(text: string, open: string): ElementSource {
  const start = text.indexOf(open);
  expect(start, open).toBeGreaterThan(-1);
  const element = readElement(text, start + 1);
  expect(element, open).not.toBeNull();
  return element!;
}

/** The first element of a page with this tag, as the parser reads the page. */
function parsed(text: string, tag: string): ElementNode {
  const find = (nodes: readonly unknown[]): ElementNode | undefined => {
    for (const node of nodes as Array<{ type: string; tag?: string; children?: unknown[]; body?: unknown[]; consequent?: unknown[] }>) {
      if (node.type === 'Element' && node.tag === tag) return node as unknown as ElementNode;
      const inside = find(node.children ?? node.body ?? node.consequent ?? []);
      if (inside) return inside;
    }
    return undefined;
  };
  return find(parse(text).template)!;
}

const words = (node: ElementNode): string => (node.children[0] as { content: string }).content.trim();

describe('an element read where it is written', () => {
  it('says where its tag is, what is written on it, and what it says', () => {
    const title = at(PAGE, '<h1');
    expect(title.tag).toBe('h1');
    expect(PAGE.slice(title.start, title.openEnd)).toBe('<h1 id="title" class="big">');
    expect(title.attributes.map(({ name, value }) => [name, value])).toEqual([
      ['id', 'title'],
      ['class', 'big'],
    ]);
    expect(title.text?.value).toBe('Tasks');
    expect(PAGE.slice(title.text!.start, title.text!.end)).toBe('Tasks');
    expect(title.repeated).toBe(false);
  });

  it('tells plain values from ones the app works out, and lists handlers and bindings as written', () => {
    const button = at(PAGE, '<Button');
    expect(button.attributes.map(({ name, value }) => [name, value])).toEqual([
      ['variant', 'primary'],
      ['size', 2],
      ['disabled', true],
    ]);
    // The `>` inside the handler is not the end of the tag.
    expect(PAGE.slice(button.start, button.openEnd)).toBe('<Button variant="primary" size={2} disabled @click={() => save(1 > 0)} :bind={x}>');
    expect(button.wired).toEqual(['@click', ':bind']);
    const row = at(PAGE, '<li');
    expect(row.attributes).toMatchObject([{ name: 'class', value: 'row' }, { name: 'title', value: undefined }]);
  });

  it('knows what is drawn once for each item, and what has more than words inside', () => {
    expect(at(PAGE, '<li').repeated).toBe(true);
    expect(at(PAGE, '<span').repeated).toBe(true);
    expect(at(PAGE, '<p>').text).toBeUndefined();
    expect(at(PAGE, '<div').text).toBeUndefined();
    expect(at(PAGE, '<img').text).toBeUndefined();
    expect(at(PAGE, '<em>').text?.value).toBe('');
  });

  it('reads nothing where no element begins', () => {
    expect(readElement(PAGE, 0)).toBeNull();
    expect(readElement(PAGE, PAGE.indexOf('Tasks'))).toBeNull();
    // A tag that never ends is not read.
    expect(readElement('<div class="a', 1)).toBeNull();
  });
});

describe('an element’s words, changed', () => {
  it('writes them where they were, and the page reads them back', () => {
    const next = withText(PAGE, at(PAGE, '<h1'), 'My tasks')!;
    expect(next).toBe(PAGE.replace('>Tasks<', '>My tasks<'));
    expect(words(parsed(next, 'h1'))).toBe('My tasks');
  });

  it('escapes what the page would read as markup, a value, a block or an entity', () => {
    for (const asked of ['a < b', 'cost {price}', '#if nothing', 'Tom & Jerry', 'back\\slash', '5 > 3 & 2 < 4', '&amp; as typed', '100%', '“quoted”', '// not a comment', 'a  lot   of   space']) {
      const next = withText(PAGE, at(PAGE, '<h1'), asked);
      expect(next, asked).not.toBeNull();
      expect(words(parsed(next!, 'h1')), asked).toBe(asked.replace(/\s+/g, ' '));
      // And nothing else on the page moved: the same elements, the same other words.
      expect(words(parsed(next!, 'Button'))).toBe('Save');
      expect(next!.replace(/<h1[^]*?<\/h1>/, '')).toBe(PAGE.replace(/<h1[^]*?<\/h1>/, ''));
    }
  });

  it('fills an element that had none, and empties one', () => {
    const filled = withText(PAGE, at(PAGE, '<em>'), 'new')!;
    expect(filled).toContain('<em>new</em>');
    const emptied = withText(PAGE, at(PAGE, '<h1'), '')!;
    expect(parsed(emptied, 'h1').children).toEqual([]);
  });

  it('is refused for an element with more than words inside', () => {
    expect(withText(PAGE, at(PAGE, '<p>'), 'x')).toBeNull();
    expect(withText(PAGE, at(PAGE, '<img'), 'x')).toBeNull();
  });
});

describe('an element’s attributes, changed', () => {
  const value = (text: string, tag: string, name: string): unknown => {
    const prop = parsed(text, tag).props.find((candidate) => candidate.name === name);
    if (!prop) return undefined;
    return prop.value.type === 'expression' ? (prop.value.value as { value?: unknown }).value : prop.value.value;
  };

  it('writes words, numbers and yes or no as a page writes them', () => {
    const button = at(PAGE, '<Button');
    const variant = withAttribute(PAGE, button, 'variant', 'danger')!;
    expect(variant).toContain('<Button variant="danger" size={2} disabled');
    const size = withAttribute(PAGE, button, 'size', 3)!;
    expect(size).toContain('size={3}');
    expect(value(size, 'Button', 'size')).toBe(3);
    const enabled = withAttribute(PAGE, button, 'disabled', false)!;
    expect(enabled).toContain('disabled={false}');
    expect(value(enabled, 'Button', 'disabled')).toBe(false);
  });

  it('adds one that was not written, after the tag’s name, and takes one off', () => {
    const title = at(PAGE, '<h1');
    const added = withAttribute(PAGE, title, 'title', 'All of them')!;
    expect(added).toContain('<h1 title="All of them" id="title" class="big">Tasks</h1>');
    const removed = withAttribute(PAGE, title, 'class', undefined)!;
    expect(removed).toContain('<h1 id="title">Tasks</h1>');
    expect(withAttribute(PAGE, title, 'hidden', true)).toContain('<h1 hidden id="title"');
    // Taking off what is not there changes nothing.
    expect(withAttribute(PAGE, title, 'lang', undefined)).toBe(PAGE);
  });

  it('takes an attribute on a line of its own with its line', () => {
    const spread = '<Card\n  title="One"\n  shadow="lg"\n>\n  x\n</Card>\n';
    const next = withAttribute(spread, at(spread, '<Card'), 'title', undefined)!;
    expect(next).toBe('<Card\n  shadow="lg"\n>\n  x\n</Card>\n');
  });

  it('writes any words so that they read back as typed, on an HTML element and on a component', () => {
    for (const asked of ['say "hi"', 'a & b', 'C:\\temp\\', 'x < y > z', '{not a value}', "it's", '100% & more "quoted" \\', '&quot; as typed', 'two\nlines']) {
      for (const [tag, open] of [['h1', '<h1'], ['Button', '<Button']] as const) {
        const next = withAttribute(PAGE, at(PAGE, open), 'title', asked);
        expect(next, `${tag}: ${asked}`).not.toBeNull();
        expect(value(next!, tag, 'title'), `${tag}: ${asked}`).toBe(asked.replace(/\n/g, ' '));
        expect(words(parsed(next!, tag))).toBe(tag === 'h1' ? 'Tasks' : 'Save');
      }
    }
  });

  it('leaves what the app works out alone, and refuses a name that is not one', () => {
    const row = at(PAGE, '<li');
    const next = withAttribute(PAGE, row, 'class', 'row done')!;
    expect(next).toContain('<li class="row done" title={task.name}>one</li>');
    expect(withAttribute(PAGE, row, 'on click', 'x')).toBeNull();
    expect(withAttribute(PAGE, row, '@click', 'x')).toBeNull();
    expect(withAttribute(PAGE, row, 'data-count', Number.NaN)).toBeNull();
  });
});

describe('the fields offered for a picked element', () => {
  it('are a component’s plain props, as the component manifest has them', () => {
    const button = at(PAGE, '<Button');
    expect(isComponentTag('Button')).toBe(true);
    expect(isComponentTag('button')).toBe(false);
    expect(isComponentTag('DIV')).toBe(false);
    const { written, more } = fieldsOf(button);
    expect(written.map((field) => [field.name, field.kind, field.value])).toEqual([
      ['variant', 'choice', 'primary'],
      ['size', 'choice', 2],
      ['disabled', 'b', true],
    ]);
    expect(written[0].options).toContain('danger');
    const offered = more.map((field) => field.name);
    expect(offered).toEqual(expect.arrayContaining(['loading', 'fullWidth', 'type']));
    expect(offered).not.toContain('variant');
    expect(offered).not.toContain('onClick');
    expect(offered).not.toContain('children');
    expect(firstValue(more.find((field) => field.name === 'loading')!)).toBe(true);
  });

  it('are, for an HTML element, what is written on it and the few a person most often adds', () => {
    const image = at(PAGE, '<img');
    const { written, more } = fieldsOf(image);
    expect(written.map((field) => field.name)).toEqual(['src', 'alt']);
    expect(more.map((field) => field.name)).toEqual(['class', 'id', 'title', 'width', 'height']);
    // An attribute whose value the app works out is no field.
    expect(fieldsOf(at(PAGE, '<li')).written.map((field) => field.name)).toEqual(['class']);
  });
});

describe('a place in a text that was changed', () => {
  it('stays where the change was after it, moves along where it was before, and is lost where the change took it', () => {
    const before = 'abc <h1>x</h1> def';
    const place = before.indexOf('h1');
    expect(movedPlace(before, 'abc <h1>longer</h1> def', place)).toBe(place);
    expect(movedPlace(before, 'abcdefg <h1>x</h1> def', place)).toBe(place + 4);
    expect(movedPlace(before, 'a <h1>x</h1> def', place)).toBe(place - 2);
    expect(movedPlace(before, 'abc  def', place)).toBeNull();
    expect(movedPlace(before, before, place)).toBe(place);
  });
});

describe('text whose line breaks are kept', () => {
  const POEM = '<div>\n  <pre class="poem">Roses are red\n  Violets are blue\n    Indented line</pre>\n</div>\n';

  it('has no Words field: a field of one line would write a <pre> back as one line', () => {
    const pre = at(POEM, '<pre');
    // Not offered as words, and said why; and nothing asked of it is written.
    expect(pre.text).toBeUndefined();
    expect(pre.keptLines).toBe(true);
    expect(withText(POEM, pre, 'Roses are red Violets are blue Indented line!')).toBeNull();
    // Its attributes are changed as any element's are, and its lines stay as they are written.
    const next = withAttribute(POEM, pre, 'class', 'verse')!;
    expect(next).toBe(POEM.replace('class="poem"', 'class="verse"'));
  });

  it('is so for a <textarea>, for what is inside a <pre>, and for one line of either', () => {
    const page = '<div>\n  <textarea>line one\n  line two</textarea>\n  <pre><code>a\n  b</code></pre>\n  <pre>one   line</pre>\n  <p>\n    Two\n    lines\n  </p>\n</div>\n';
    for (const open of ['<textarea', '<code', '<pre>one']) {
      const element = at(page, open);
      expect(element.text, open).toBeUndefined();
      expect(element.keptLines, open).toBe(true);
    }
    // Words a page draws on one line, however they are written, are words still.
    const p = at(page, '<p>');
    expect(p.keptLines).toBe(false);
    expect(p.text?.value).toBe('Two lines');
    expect(words(parsed(withText(page, p, 'Three')!, 'p'))).toBe('Three');
  });
});

describe('anything a person can type, written where it reads back as typed or not at all', () => {
  const read = (node: ElementNode): unknown => (node.children.length === 1 && node.children[0].type === 'Text' ? (node.children[0] as { content: string }).content : JSON.stringify(node.children));
  const onOneLine = (text: string): string => text.replace(/[ \t\r\n\f]+/g, ' ').trim();

  it('as an element’s words', () => {
    const page = '<div>\n  <h1 id="t">Tasks</h1>\n  <p>after</p>\n</div>\n';
    const h1 = at(page, '<h1');
    const asked = [
      'see http://example.com now', 'a } b', 'a {{ b }} c', '</h1><script>x</script>', '<!-- x', 'x -->', '/* x', 'x */ y', '@click', ':bind={x}',
      'a\\', 'a\\\\b', '\\{x}', '&lt;b&gt;', '&#60;b&#62;', '&nbsp;', 'a &amp b', '#', '# heading', 'a #each b', '`tick`', 'it\'s "quoted"', '${x}', '$',
      '%>', '<%= x %>', 'a' + String.fromCharCode(0xa0) + 'b', ' lead and trail ', '\ttab', 'a\nb', 'a\r\nb', '' + String.fromCharCode(0x200d) + 'zero-width', '' + String.fromCharCode(0x2028) + 'line sep', 'x // y', '//', '///', '/ / x',
      'end', '#end', '#else', 'a\\#b', '\\', '\\\\', '{', '}', '<', '>', '&', '&&', '&amp;amp;', '&#x26;', '&copy;', '&notanentity;', '&#0;', '&#xD800;',
      '\0', '\u0001',
    ];
    const wrong: unknown[] = [];
    let written = 0;
    for (const value of asked) {
      const next = withText(page, h1, value);
      if (next === null) continue;
      written++;
      const now = read(parsed(next, 'h1'));
      // As a page draws words: runs of spaces and line breaks are one space, and nothing else is lost.
      if (onOneLine(String(now)) !== onOneLine(value)) wrong.push({ asked: value, read: now });
      // And the element after it is the element it was.
      if (read(parsed(next, 'p')) !== 'after') wrong.push({ asked: value, neighbour: next });
    }
    expect(wrong).toEqual([]);
    // Refusing everything would pass the check above: nearly all of these are writable.
    expect(written).toBeGreaterThan(asked.length - 6);
  });

  it('as an attribute’s value, on an HTML element and on a component', () => {
    const page = '<div>\n  <h1 id="t" class="a">Tasks</h1>\n  <Button variant="primary">Go</Button>\n  <p>after</p>\n</div>\n';
    const asked = [
      '', ' ', ' lead', 'trail ', 'a  b', '\t', '{x}', '{{x}}', '${x}', '`', "'", '"', '\\', '\\"', '&quot;', '&amp;quot;', '&#92;', '&#34;', '&', '&x', '<', '>',
      '/>', '//', '/* */', 'a\rb', 'a\tb', '' + String.fromCharCode(0x2028) + '', '\0', 'true', 'false', '0', '1e3', 'null', 'javascript:alert(1)', '日本語', '😀',
    ];
    const wrong: unknown[] = [];
    let written = 0;
    for (const open of ['<h1', '<Button']) {
      const element = at(page, open);
      for (const value of asked) {
        const next = withAttribute(page, element, 'title', value);
        if (next === null) continue;
        written++;
        const prop = parsed(next, open.slice(1)).props.find((candidate) => candidate.name === 'title');
        const now = prop ? (prop.value.type === 'expression' ? (prop.value.value as { value?: unknown }).value : prop.value.value) : undefined;
        if (now !== value.replace(/[\r\n]+/g, ' ')) wrong.push({ open, asked: value, read: now });
        if (read(parsed(next, 'p')) !== 'after') wrong.push({ open, asked: value, neighbour: next });
      }
    }
    expect(wrong).toEqual([]);
    expect(written).toBeGreaterThan(asked.length * 2 - 8);
  });
});

describe('an attribute written twice on an element', () => {
  it('is listed as that, not as something the app works out, and the one the page reads is the one changed', () => {
    const page = '<div>\n  <h1 class="a" class="b" id="x" @click={go}>T</h1>\n</div>\n';
    const h1 = at(page, '<h1');
    expect(h1.twice).toEqual(['class']);
    expect(h1.wired).toEqual(['@click']);
    expect(h1.attributes.map(({ name, value }) => [name, value])).toEqual([
      ['class', 'a'],
      ['id', 'x'],
    ]);
    const next = withAttribute(page, h1, 'class', 'c');
    // Refused, or written over the first, which is the one the page reads: never over the second.
    if (next !== null) {
      expect(next).toContain('class="c" class="b"');
      expect(parsed(next, 'h1').props.find((prop) => prop.name === 'class')?.value.value).toBe('c');
    }
    expect(at(PAGE, '<h1').twice).toEqual([]);
  });
});

describe('the element the caret is in, for picking from the keyboard', () => {
  const page = ['<div class="page">', '  <h1 id="title">Tasks</h1>', '  <ul>', '    <li class="row">one <b>bold</b> two</li>', '  </ul>', '  <img src="a.png" alt="A">', '</div>', '<p>after</p>', ''].join('\n');
  const caretIn = (find: string, offset = 0): string | null => {
    const element = elementAtCaret(page, page.indexOf(find) + offset);
    return element ? page.slice(element.start, element.openEnd) : null;
  };

  it('is the innermost element whose lines hold the caret: in its tag, its words or its closing tag', () => {
    expect(caretIn('id="title"')).toBe('<h1 id="title">');
    expect(caretIn('Tasks', 2)).toBe('<h1 id="title">');
    expect(caretIn('</h1>', 3)).toBe('<h1 id="title">');
    expect(caretIn('bold')).toBe('<b>');
    expect(caretIn('one ')).toBe('<li class="row">');
    expect(caretIn(' two')).toBe('<li class="row">');
    expect(caretIn('<ul>', 1)).toBe('<ul>');
    expect(caretIn('alt=')).toBe('<img src="a.png" alt="A">');
    // Between two elements, it is the one around both.
    expect(caretIn('  <ul>')).toBe('<div class="page">');
    expect(caretIn('after')).toBe('<p>');
  });

  it('does not take the closing tag of a later element for that of one left unclosed', () => {
    const loose = ['<div class="page">', '  <h1>Title</h1>', '  <ul>', '    <li>one', '    <li>two</li>', '  </ul>', '  <p>first', '  <section><b>x</b></section>', '  <p>second</p>', '  <img src="a.png">', '  after image', '  <div><div>inner</div> tail</div>', '</div>', ''].join('\n');
    const where = (marker: string, offset = 0): string => {
      const found = elementAtCaret(loose, loose.indexOf(marker) + offset);
      return found ? `<${found.tag}> at line ${loose.slice(0, found.start).split('\n').length}` : 'none';
    };
    expect({
      inTitle: where('Title', 2),
      inOne: where('one', 1),
      inTwo: where('two', 1),
      inFirst: where('first', 2),
      // On the line after the section, which closed the first <p>: in neither <p>, but in the page around them.
      betweenSectionAndSecondP: where('  <p>second', 0),
      inB: where('<b>x', 4),
      afterImage: where('after image', 3),
      inTail: where(' tail', 2),
      inInner: where('inner', 2),
      atStartOfFile: where('<div class="page">', 0),
    }).toEqual({
      inTitle: '<h1> at line 2',
      inOne: '<li> at line 4',
      inTwo: '<li> at line 5',
      inFirst: '<p> at line 7',
      betweenSectionAndSecondP: '<div> at line 1',
      inB: '<b> at line 8',
      afterImage: '<div> at line 1',
      inTail: '<div> at line 12',
      inInner: '<div> at line 12',
      atStartOfFile: '<div> at line 1',
    });
  });

  it('is none where the caret is in no element', () => {
    expect(elementAtCaret(page, page.length)).toBeNull();
    // After the last element's closing tag, and in a file that has none.
    expect(elementAtCaret(page, page.lastIndexOf('</p>') + 4)).toBeNull();
    expect(elementAtCaret('let count = 0\n', 4)).toBeNull();
  });
});
