/**
 * The code view's tokenizer. Every case checks two things: the tokens join
 * back to the source exactly (nothing dropped, duplicated or escaped), and the
 * pieces that matter got the right kind.
 */
import { describe, expect, it } from 'vitest';
import { languageForPath, tokenize, tokenizeLines, type CodeLanguage, type Token, type TokenKind } from '../src/editors/highlight';

function scan(source: string, language: CodeLanguage): Token[] {
  const tokens = tokenize(source, language);
  expect(tokens.map((t) => t.text).join('')).toBe(source);
  return tokens;
}

/** The kind of the token that is exactly `text`, or contains it when `contains`. */
function kindOf(tokens: Token[], text: string, contains = false): TokenKind | undefined {
  return tokens.find((t) => (contains ? t.text.includes(text) : t.text === text))?.kind;
}

describe('the language comes from the file name', () => {
  it.each([
    ['logic/main.logic', 'javascript'],
    ['logic/util.js', 'javascript'],
    ['logic/main.py', 'python'],
    ['data/books.xdb', 'json'],
    ['manifest.json', 'json'],
    ['ui/main.ui', 'softn'],
    ['README.md', 'markdown'],
    ['notes.txt', 'plain'],
    ['src/app.ts', 'typescript'],
    ['styles/site.css', 'css'],
    ['public/index.html', 'html'],
    ['db/schema.sql', 'sql'],
  ])('%s is %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });
});

describe('JavaScript', () => {
  it('keeps a template literal whole, with ${} expressions scanned as code, nested templates included', () => {
    const source = 'const s = `a ${ x ? `in ${ "}" } ner` : \'`\' } b`; let y = 1;';
    const tokens = scan(source, 'javascript');
    // The keyword after the template is still a keyword: the template ended where it should.
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['const', 'let']);
    expect(kindOf(tokens, '"}"')).toBe('string');
    expect(kindOf(tokens, "'`'")).toBe('string');
    expect(tokens.filter((t) => t.text === '${').every((t) => t.kind === 'mark')).toBe(true);
    expect(kindOf(tokens, ' b`')).toBe('string');
  });

  it('tells a regular expression from a division', () => {
    const regex = scan('const re = /"[/]\\//g; return /x/.test(s);', 'javascript');
    expect(kindOf(regex, '/"[/]\\//g')).toBe('regex');
    expect(kindOf(regex, '/x/')).toBe('regex');
    // No string opened by the quote inside the regex.
    expect(regex.some((t) => t.kind === 'string')).toBe(false);

    const division = scan('const half = total / 2 / count; const r = (a) / b;', 'javascript');
    expect(division.some((t) => t.kind === 'regex')).toBe(false);
  });

  it('does not colour keywords or comments inside strings', () => {
    const tokens = scan('const a = "return // not a comment # nor this"; // real', 'javascript');
    expect(kindOf(tokens, '"return // not a comment # nor this"')).toBe('string');
    expect(kindOf(tokens, '// real')).toBe('comment');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['const']);
  });

  it('reads block comments, numbers, literals, calls and properties', () => {
    const tokens = scan('/* a\n b */ let n = 0x1F + 1.5e3; if (ok === true) go(n.value);', 'javascript');
    expect(kindOf(tokens, '/* a\n b */')).toBe('comment');
    expect(kindOf(tokens, '0x1F')).toBe('number');
    expect(kindOf(tokens, '1.5e3')).toBe('number');
    expect(kindOf(tokens, 'true')).toBe('literal');
    expect(kindOf(tokens, 'go')).toBe('function');
    expect(kindOf(tokens, 'value')).toBe('property');
  });

  it('does not treat a word used as a property as a keyword', () => {
    const tokens = scan('config.default = item.new;', 'javascript');
    expect(tokens.some((t) => t.kind === 'keyword')).toBe(false);
  });
});

describe('Python', () => {
  it('reads triple-quoted strings across lines, quotes and hashes inside them', () => {
    const source = 'def f():\n    """Say "hi" # not a comment\n    and \'more\'"""\n    return 1  # real\n';
    const tokens = scan(source, 'python');
    expect(kindOf(tokens, '"""Say "hi" # not a comment\n    and \'more\'"""')).toBe('string');
    expect(kindOf(tokens, '# real')).toBe('comment');
    expect(kindOf(tokens, 'f')).toBe('function');
  });

  it('does not start a comment at a # inside a string', () => {
    const tokens = scan("colour = '#2563eb'  # brand\nurl = \"a#b\"", 'python');
    expect(kindOf(tokens, "'#2563eb'")).toBe('string');
    expect(kindOf(tokens, '"a#b"')).toBe('string');
    expect(tokens.filter((t) => t.kind === 'comment').map((t) => t.text)).toEqual(['# brand']);
  });

  it('scans f-string expressions as code, with nested quotes and escaped braces', () => {
    const tokens = scan('label = f"{count} of {d[\'total\']} {{literal}} {len(xs)!r}"', 'python');
    expect(tokens.filter((t) => t.text === '{' && t.kind === 'mark')).toHaveLength(3);
    expect(kindOf(tokens, "'total'")).toBe('string');
    expect(kindOf(tokens, 'len')).toBe('function');
    expect(kindOf(tokens, '{{literal}}', true)).toBe('string');
  });

  it('knows string prefixes and decorators', () => {
    const tokens = scan('@app.route\ndef view():\n    return rb"\\d+" + b\'x\' + r\'\\n\'\n', 'python');
    expect(kindOf(tokens, '@app.route')).toBe('decorator');
    expect(kindOf(tokens, 'rb"\\d+"')).toBe('string');
    expect(kindOf(tokens, "b'x'")).toBe('string');
    expect(kindOf(tokens, "r'\\n'")).toBe('string');
  });

  it('treats an @ that is not at the start of a line as an operator', () => {
    const tokens = scan('c = a @ b', 'python');
    expect(tokens.some((t) => t.kind === 'decorator')).toBe(false);
  });

  it('reads keywords, literals and a class name', () => {
    const tokens = scan('class Shelf:\n    if x is None and not y: pass', 'python');
    expect(kindOf(tokens, 'class')).toBe('keyword');
    expect(kindOf(tokens, 'Shelf')).toBe('function');
    expect(kindOf(tokens, 'None')).toBe('literal');
    expect(kindOf(tokens, 'not')).toBe('keyword');
  });
});

describe('JSON', () => {
  it('tells keys from string values and reads numbers and literals', () => {
    const tokens = scan('{ "name": "Reading list", "count": -12.5e2, "ok": true, "none": null }', 'json');
    expect(kindOf(tokens, '"name"')).toBe('property');
    expect(kindOf(tokens, '"Reading list"')).toBe('string');
    expect(kindOf(tokens, '-12.5e2')).toBe('number');
    expect(kindOf(tokens, 'true')).toBe('literal');
    expect(kindOf(tokens, 'null')).toBe('literal');
  });
});

describe('SoftN markup', () => {
  const source = [
    '<import HomePage from="./pages/home.ui" />',
    '<App title={appName}>',
    '  #each (item in pages)',
    '    <Button variant={page === item.id ? "primary" : "ghost"} @click={() => go(item.id)}>{item.label}</Button>',
    '  #end',
    '  <Text>C# is a language; so is {lang}</Text>',
    '  <!-- a comment -->',
    '</App>',
    '<style>',
    '  .brand { color: #2563eb; }',
    '</style>',
  ].join('\n');

  it('marks tags, attributes, events, directives and expression braces', () => {
    const tokens = scan(source, 'softn');
    expect(kindOf(tokens, 'import')).toBe('tag');
    expect(kindOf(tokens, 'Button')).toBe('tag');
    expect(kindOf(tokens, 'variant')).toBe('attr');
    expect(kindOf(tokens, '@click')).toBe('mark');
    expect(kindOf(tokens, '#each')).toBe('mark');
    expect(kindOf(tokens, '#end')).toBe('mark');
    expect(kindOf(tokens, 'in')).toBe('keyword');
    expect(kindOf(tokens, '"./pages/home.ui"')).toBe('string');
    expect(kindOf(tokens, '"primary"')).toBe('string');
    expect(kindOf(tokens, 'go')).toBe('function');
    expect(kindOf(tokens, '<!-- a comment -->')).toBe('comment');
  });

  it('does not take a # in text or in a stylesheet for a directive', () => {
    const tokens = scan(source, 'softn');
    expect(tokens.filter((t) => t.kind === 'mark' && t.text.startsWith('#')).map((t) => t.text)).toEqual(['#each', '#end']);
    // The stylesheet is left as it is, braces and all.
    expect(tokens.some((t) => t.text.includes('.brand { color: #2563eb; }'))).toBe(true);
  });

  it('reads @event and :bind attributes as the language', () => {
    const tokens = scan('<Input :value={name} @input={(e) => set(e)} />', 'softn');
    expect(kindOf(tokens, ':value')).toBe('mark');
    expect(kindOf(tokens, '@input')).toBe('mark');
  });
});

describe('escaping', () => {
  it('keeps markup inside a string as text: the tokens are strings, never HTML', () => {
    const source = 'const html = "<script>alert(1)</script>";\nconst t = `<img src=x onerror=alert(1)>`;';
    const tokens = scan(source, 'javascript');
    expect(kindOf(tokens, '"<script>alert(1)</script>"')).toBe('string');
    expect(tokens.some((t) => t.text.includes('&lt;'))).toBe(false);
  });
});

describe('lines', () => {
  it('cuts tokens at newlines and keeps empty lines', () => {
    const lines = tokenizeLines('a = """one\ntwo"""\n\nb = 1', 'python');
    expect(lines).toHaveLength(4);
    expect(lines[1].map((t) => t.text).join('')).toBe('two"""');
    expect(lines[1][0].kind).toBe('string');
    expect(lines[2]).toEqual([]);
  });

  it('scans a large file in linear time', () => {
    const source = 'const value = compute(item.id, "text", 42); // note\n'.repeat(20_000);
    const started = performance.now();
    const lines = tokenizeLines(source, 'javascript');
    expect(lines.length).toBe(20_001);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('TypeScript', () => {
  it('reads JavaScript plus type keywords, primitive types and decorators', () => {
    const tokens = scan(
      '@Component()\nexport interface Row { readonly id: string; count?: number }\ntype Id = keyof Row;\nconst x = y as unknown satisfies object;',
      'typescript',
    );
    expect(kindOf(tokens, '@Component')).toBe('decorator');
    expect(kindOf(tokens, 'interface')).toBe('keyword');
    expect(kindOf(tokens, 'readonly')).toBe('keyword');
    expect(kindOf(tokens, 'string')).toBe('type');
    expect(kindOf(tokens, 'number')).toBe('type');
    expect(kindOf(tokens, 'keyof')).toBe('keyword');
    expect(kindOf(tokens, 'as')).toBe('keyword');
    expect(kindOf(tokens, 'satisfies')).toBe('keyword');
  });

  it('does not colour a type keyword used as an object key, and leaves JavaScript alone', () => {
    const ts = scan('const o = { type: 1, readonly: true };', 'typescript');
    expect(ts.some((t) => t.kind === 'keyword' && (t.text === 'type' || t.text === 'readonly'))).toBe(false);
    const js = scan('const type = interface_;', 'javascript');
    expect(js.some((t) => t.kind === 'keyword' && t.text === 'type')).toBe(false);
  });

  it('keeps the JavaScript template and regex handling', () => {
    const tokens = scan('const r: RegExp = /`/g; const t = `a${`b`}c`;', 'typescript');
    expect(kindOf(tokens, '/`/g')).toBe('regex');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['const', 'const']);
  });
});

describe('CSS', () => {
  const source = [
    '@import url("theme.css");',
    ':root { --brand: #2563eb; }',
    '.card > a:hover, #main [data-x="1"] {',
    '  color: var(--brand) !important;',
    '  margin: -0.5rem 10px 0 1.5e1%;',
    '  &:focus-visible { outline: 2px solid red; }',
    '}',
    '@media (max-width: 600px) { .card { display: none } }',
    '/* done */',
  ].join('\n');

  it('tells selectors, properties and values apart', () => {
    const tokens = scan(source, 'css');
    expect(kindOf(tokens, '@import')).toBe('keyword');
    expect(kindOf(tokens, '"theme.css"')).toBe('string');
    expect(kindOf(tokens, ':root')).toBe('tag');
    expect(kindOf(tokens, '--brand')).toBe('property');
    expect(kindOf(tokens, '#2563eb')).toBe('number');
    expect(kindOf(tokens, '.card')).toBe('tag');
    expect(kindOf(tokens, ':hover')).toBe('tag');
    expect(kindOf(tokens, '#main')).toBe('tag');
    expect(kindOf(tokens, '[data-x="1"]')).toBe('attr');
    expect(kindOf(tokens, 'color')).toBe('property');
    expect(kindOf(tokens, 'var')).toBe('function');
    expect(kindOf(tokens, '!important')).toBe('keyword');
    expect(kindOf(tokens, '-0.5rem')).toBe('number');
    expect(kindOf(tokens, '1.5e1%')).toBe('number');
    expect(kindOf(tokens, ':focus-visible')).toBe('tag');
    expect(kindOf(tokens, 'outline')).toBe('property');
    expect(kindOf(tokens, '@media')).toBe('keyword');
    expect(kindOf(tokens, '600px')).toBe('number');
    expect(kindOf(tokens, 'display')).toBe('property');
    expect(kindOf(tokens, '/* done */')).toBe('comment');
  });
});

describe('HTML', () => {
  it('reads tags, attributes, entities, comments and the doctype, with style and script scanned in their own language', () => {
    const source = [
      '<!DOCTYPE html>',
      '<p class="lead" hidden>A &amp; B &#169; {not an expression}</p>',
      '<!-- note -->',
      '<style>p { color: red; }</style>',
      '<script>const n = 1 / 2;</script>',
    ].join('\n');
    const tokens = scan(source, 'html');
    expect(kindOf(tokens, '<!DOCTYPE html>')).toBe('keyword');
    expect(kindOf(tokens, 'p')).toBe('tag');
    expect(kindOf(tokens, 'class')).toBe('attr');
    expect(kindOf(tokens, 'hidden')).toBe('attr');
    expect(kindOf(tokens, '"lead"')).toBe('string');
    expect(kindOf(tokens, '&amp;')).toBe('literal');
    expect(kindOf(tokens, '&#169;')).toBe('literal');
    expect(tokens.some((t) => t.kind === 'mark')).toBe(false);
    expect(kindOf(tokens, '<!-- note -->')).toBe('comment');
    expect(kindOf(tokens, 'color')).toBe('property');
    expect(kindOf(tokens, 'const')).toBe('keyword');
    expect(tokens.some((t) => t.kind === 'regex')).toBe(false);
  });
});

describe('SQL', () => {
  it('reads keywords in any case, doubled-quote strings, comments, parameters and functions', () => {
    const source = "select id, COUNT(*) from books -- all\nWHERE title = 'It''s' AND n > :min /* x */ and deleted IS NULL;";
    const tokens = scan(source, 'sql');
    expect(kindOf(tokens, 'select')).toBe('keyword');
    expect(kindOf(tokens, 'WHERE')).toBe('keyword');
    expect(kindOf(tokens, 'COUNT')).toBe('function');
    expect(kindOf(tokens, "'It''s'")).toBe('string');
    expect(kindOf(tokens, '-- all')).toBe('comment');
    expect(kindOf(tokens, '/* x */')).toBe('comment');
    expect(kindOf(tokens, ':min')).toBe('mark');
    expect(kindOf(tokens, 'NULL')).toBe('literal');
    expect(kindOf(tokens, 'books')).toBeUndefined(); // merged into the surrounding plain text
  });
});

describe('Markdown', () => {
  it('reads headings, lists, quotes, code spans, emphasis and links a line at a time', () => {
    const source = [
      '# Title',
      '',
      '- item with `code` and **bold** and a [link](https://x.test)',
      '> quoted _words_',
      '1. snake_case_name stays plain',
      '---',
    ].join('\n');
    const tokens = scan(source, 'markdown');
    expect(kindOf(tokens, '# Title')).toBe('keyword');
    expect(kindOf(tokens, '- ')).toBe('punct');
    expect(kindOf(tokens, '`code`')).toBe('string');
    expect(kindOf(tokens, '**bold**')).toBe('mark');
    expect(kindOf(tokens, '[link](https://x.test)')).toBe('function');
    expect(kindOf(tokens, '> ')).toBe('comment');
    expect(kindOf(tokens, '_words_')).toBe('mark');
    expect(tokens.some((t) => t.text.includes('_case_') && t.kind === 'mark')).toBe(false);
    expect(kindOf(tokens, '---')).toBe('punct');
  });

  it('scans a fenced block in the language it names, and leaves an unnamed one as a string', () => {
    const source = '```js\nconst a = "```";\n```\n\n~~~\n# not a heading\n~~~\ntext';
    const tokens = scan(source, 'markdown');
    expect(kindOf(tokens, '```js')).toBe('mark');
    expect(kindOf(tokens, 'const')).toBe('keyword');
    expect(kindOf(tokens, '"```"')).toBe('string');
    expect(kindOf(tokens, '# not a heading\n')).toBe('string');
    expect(tokens.filter((t) => t.kind === 'mark').map((t) => t.text)).toEqual(['```js', '```', '~~~', '~~~']);
  });

  it('keeps an unclosed fence to the end of the text', () => {
    scan('```py\nx = 1\n', 'markdown');
  });
});

describe('every language', () => {
  const samples = [
    'const a = `x${ {b: "}"} }y` / 2; /* ',
    "def f(x): return f'{x!r:>{w}}' # \"\"\"",
    '{"a": [1, -2.5e3, true, null], "b": "\\"q\\""}',
    '<a href="x" {y} @click={() => z}>t</a',
    'a { b: c; d: url(e) } @media x { f { g: 1px } }',
    "SELECT 'unterminated",
    '```\nunterminated **bold [x](',
    '',
    '\n\n',
    '\t\t\\',
  ];
  const languages: CodeLanguage[] = ['javascript', 'typescript', 'python', 'json', 'html', 'css', 'sql', 'markdown', 'softn', 'plain'];

  it.each(languages)('%s gives back every character of any input, well-formed or not', (language) => {
    for (const sample of samples) scan(sample, language);
  });

  it('reads an unknown language as plain text', () => {
    expect(tokenize('a < b', 'cobol' as CodeLanguage)).toEqual([{ kind: 'plain', text: 'a < b' }]);
  });
});
