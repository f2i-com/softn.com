import React from 'react';

/**
 * A deliberately small highlighter for a bundle's pages (`.ui`, `.html`),
 * its `.logic` and its `.py` source.
 *
 * It exists to make one point visually — that the marks belonging to SoftN
 * itself (`#each`, `@click`, `:bind`, the braces around an expression, the
 * `<logic>` block) are a different kind of thing from the markup around them —
 * so it only needs enough resolution to separate those from tags, attributes,
 * strings and prose. Anything a real editor would do beyond that is out of
 * scope; that is the editors' job, in Studio and Builder.
 */

/**
 * `quotes` marks the rule that reads strings and names the characters that
 * open one; `oneLine` says its strings end with their line. `highlight` uses
 * the two to avoid looking for the same missing closing quote twice.
 */
type Rule = { cls: string; re: RegExp; quotes?: string; oneLine?: boolean };

// In logic, a tag only counts when the name is capitalised or is the `logic`
// block — otherwise every `a<b` in a `.logic` file would open an element.
const LOGIC_TAG: Rule = { cls: 'tok-tag', re: /<\/?(?:[A-Z][\w.]*|logic|script|style)\b/y };

// Order is the whole design here: the first rule that matches at a position
// wins, so the specific marks have to be tried before the general ones.
// Every regex uses the sticky `/y` flag so tokenization indexes directly into
// `source` in O(N) without O(N²) `rest.slice(...)` allocations.
const RULES: Rule[] = [
  { cls: 'tok-com', re: /\/\/[^\n]*/y },
  { cls: 'tok-str', re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/y, quotes: '"\'`' },
  // SoftN's control-flow directives.
  { cls: 'tok-mark', re: /#(?:if|else|each|empty|end)\b/y },
  LOGIC_TAG,
  { cls: 'tok-tag', re: /\/?>/y },
  // Event handlers and two-way bindings.
  { cls: 'tok-mark', re: /[@:][A-Za-z_][\w-]*/y },
  { cls: 'tok-mark', re: /[{}]/y },
  {
    cls: 'tok-mark',
    re: /\b(?:let|const|var|function|return|if|else|for|while|await|async|new|class|import|export|from|typeof|of|in|try|catch|throw)\b/y,
  },
  { cls: 'tok-num', re: /\b(?:true|false|null|undefined|\d+(?:\.\d+)?)\b/y },
  // An attribute name, recognised by the `=` that follows it.
  { cls: 'tok-attr', re: /[A-Za-z_][\w-]*(?=\s*=)/y },
  { cls: 'tok-punc', re: /[=(),;[\]]/y },
  // Anything else: identifiers, whitespace, operators, prose inside elements.
  { cls: 'tok-expr', re: /(?:[^\s<>{}"'`@:#=(),;[\]/]+|\s+|.)/y },
];

/**
 * Python logic (a `.py` file). Kept apart from the rules above rather than
 * merged into them: in Python `#` opens a comment, and in markup it opens
 * `#each`, so no single list can be right about both.
 */
const PYTHON_RULES: Rule[] = [
  { cls: 'tok-com', re: /#[^\n]*/y },
  { cls: 'tok-str', re: /(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/y, quotes: '"\'', oneLine: true },
  {
    cls: 'tok-mark',
    re: /\b(?:def|global|nonlocal|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|with|class|lambda|pass|break|continue|try|except|finally|raise|yield|del|assert)\b/y,
  },
  { cls: 'tok-num', re: /\b(?:True|False|None|\d+(?:\.\d+)?)\b/y },
  { cls: 'tok-punc', re: /[=(),:[\]]/y },
  { cls: 'tok-expr', re: /(?:[^\s#"'=(),:[\]]+|\s+|.)/y },
];

/**
 * A page: `.ui` or `.html`. The SoftN marks are read as in the rules above,
 * and a lowercase name is an element too, as the parser reads it (`<div>`,
 * `<section>`, `<input>`), as are a comment and the doctype. A tag name has
 * to end where a tag's name ends — at a space, `>`, `/` or the end — so a
 * `<script>` block's `i<n;` is still a comparison. Each of the new rules
 * consumes what it opens to the end of the file when it does not close, so
 * no stretch is read twice.
 */
const MARKUP_RULES: Rule[] = [
  { cls: 'tok-com', re: /<!--[\s\S]*?(?:-->|$)/y },
  { cls: 'tok-tag', re: /<![A-Za-z][^>]*>?/y },
  ...RULES.map((rule) => (rule === LOGIC_TAG ? { cls: 'tok-tag', re: /<\/?[A-Za-z][\w.:-]*(?=[\s/>]|$)/y } : rule)),
];

const JSON_RULES: Rule[] = [
  { cls: 'tok-attr', re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, quotes: '"' },
  { cls: 'tok-str', re: /"(?:[^"\\]|\\.)*"/y, quotes: '"' },
  { cls: 'tok-num', re: /(?:\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y },
  { cls: 'tok-punc', re: /[{}[\]:,]/y },
  { cls: 'tok-expr', re: /(?:\s+|[^\s"{}[\]:,]+|.)/y },
];

const PHP_RULES: Rule[] = [
  { cls: 'tok-com', re: /(?:\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*)/y },
  { cls: 'tok-tag', re: /(?:<\?(?:php)?|\?>)/iy },
  { cls: 'tok-str', re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/y, quotes: '"\'' },
  { cls: 'tok-attr', re: /\$[A-Za-z_]\w*/y },
  {
    cls: 'tok-mark',
    re: /\b(?:declare|strict_types|namespace|use|class|interface|trait|function|fn|return|if|elseif|else|foreach|for|while|switch|case|match|try|catch|finally|throw|new|echo|print|exit|require|require_once|include|public|private|protected|static|readonly|const|array|as)\b/y,
  },
  { cls: 'tok-num', re: /\b(?:true|false|null|\d+(?:\.\d+)?)\b/iy },
  { cls: 'tok-punc', re: /(?:->|=>|::|[=(){}[\],;.])/y },
  { cls: 'tok-expr', re: /(?:[^\s/"'#$=(){}[\],;.<>?]+|\s+|.)/y },
];

const RUST_RULES: Rule[] = [
  { cls: 'tok-com', re: /(?:\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/y },
  { cls: 'tok-attr', re: /#!?\[[^\]]*\]/y },
  { cls: 'tok-str', re: /b?"(?:[^"\\]|\\.)*"/y, quotes: '"' },
  {
    cls: 'tok-mark',
    re: /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/y,
  },
  {
    cls: 'tok-tag',
    re: /\b(?:bool|char|str|String|Vec|Option|Result|Box|Arc|Rc|HashMap|BTreeMap|i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|Some|None|Ok|Err)\b/y,
  },
  { cls: 'tok-num', re: /\b(?:true|false|0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[uif](?:8|16|32|64|128|size))?)\b/y },
  { cls: 'tok-punc', re: /(?:->|=>|::|[=(){}[\],;.:])/y },
  { cls: 'tok-expr', re: /(?:[^\s/"'#=(){}[\],;.:]+|\s+|.)/y },
];

const SQL_RULES: Rule[] = [
  { cls: 'tok-com', re: /(?:--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/y },
  { cls: 'tok-str', re: /(?:'(?:[^'\\]|''|\\.)*'|"(?:[^"\\]|\\.)*")/y, quotes: '"\'' },
  {
    cls: 'tok-mark',
    re: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|TRIGGER|IF|NOT|EXISTS|PRIMARY|KEY|FOREIGN|REFERENCES|AUTOINCREMENT|UNIQUE|DEFAULT|CHECK|CONSTRAINT|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|ASC|DESC|LIMIT|OFFSET|HAVING|UNION|ALL|AS|AND|OR|IN|IS|LIKE|GLOB|BETWEEN|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|PRAGMA|WITH|RETURNING|CONFLICT|DO|NOTHING|REPLACE)\b/iy,
  },
  { cls: 'tok-tag', re: /\b(?:INTEGER|INT|TEXT|REAL|BLOB|NUMERIC|BOOLEAN|VARCHAR|CHAR|DATETIME|TIMESTAMP|DATE|JSON)\b/iy },
  { cls: 'tok-num', re: /\b(?:NULL|TRUE|FALSE|\d+(?:\.\d+)?)\b/iy },
  { cls: 'tok-punc', re: /[=(),;.*<>!+-]/y },
  { cls: 'tok-expr', re: /(?:[^\s/"'-=(),;.*<>!+]+|\s+|.)/y },
];

const CSS_RULES: Rule[] = [
  { cls: 'tok-com', re: /\/\*[\s\S]*?(?:\*\/|$)/y },
  { cls: 'tok-str', re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/y, quotes: '"\'' },
  { cls: 'tok-mark', re: /@[a-zA-Z-]+/y },
  { cls: 'tok-attr', re: /[a-zA-Z_-][\w-]*(?=\s*:)/y },
  { cls: 'tok-num', re: /(?:#[0-9a-fA-F]{3,8}\b|-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|%|ms|s|deg|fr)?\b)/y },
  { cls: 'tok-punc', re: /[{}():;,]/y },
  { cls: 'tok-expr', re: /(?:[^\s/"'@{}:;,()]+|\s+|.)/y },
];

const SHELL_RULES: Rule[] = [
  { cls: 'tok-com', re: /#[^\n]*/y },
  { cls: 'tok-str', re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/y, quotes: '"\'' },
  { cls: 'tok-attr', re: /(?:\[[^\]]+\]|[A-Za-z_][\w.-]*(?=\s*[=:]))/y },
  { cls: 'tok-num', re: /\b(?:true|false|yes|no|on|off|\d+(?:\.\d+)?)\b/iy },
  { cls: 'tok-punc', re: /[=:,[\]{}]/y },
  { cls: 'tok-expr', re: /(?:[^\s#"'=:,[\]{}]+|\s+|.)/y },
];

/** Which rules a source is read with. */
export type HighlightLanguage = 'softn' | 'markup' | 'python' | 'json' | 'php' | 'rust' | 'sql' | 'css' | 'shell';

/**
 * A file's highlighting language from its name — covering UI pages, logic,
 * PHP, Rust, Python, SQL, CSS, JSON, TOML/YAML/shell configs, and JS/TS.
 */
export function languageOf(path: string): HighlightLanguage {
  if (/\.py$/i.test(path)) return 'python';
  if (/\.(?:json|xdb)$/i.test(path)) return 'json';
  if (/\.(?:php|phtml)$/i.test(path)) return 'php';
  if (/\.rs$/i.test(path)) return 'rust';
  if (/\.sql$/i.test(path)) return 'sql';
  if (/\.(?:css|scss|less)$/i.test(path)) return 'css';
  if (/\.(?:toml|ya?ml|ini|conf|cfg|env|sh|bash|zsh)$/i.test(path) || /(?:^|\/)(?:\.htaccess|Dockerfile|Makefile)$/i.test(path)) return 'shell';
  if (/\.(?:ui|html?|svg|xml)$/i.test(path)) return 'markup';
  return 'softn';
}

const BACKSLASH = 92;
const LINE_FEED = 10;

/**
 * Where a string opened at `open` stops being read without having closed:
 * the end of the source, the end of its line when strings are kept to one,
 * or a backslash with nothing after it to escape (a line break, or the end).
 * This follows the string rules above character for character. Answers
 * `open` itself for a string that does close.
 *
 * No string the same quote opens between `open` and that point closes
 * either. A quote in that stretch is an escaped one, or the string would
 * have closed at it, and what follows an escape is read from there exactly
 * as it was read from `open`.
 */
function unclosedUntil(source: string, open: number, oneLine: boolean): number {
  const quote = source.charCodeAt(open);
  let i = open + 1;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    if (ch === quote) return open;
    if (oneLine && ch === LINE_FEED) return i;
    if (ch === BACKSLASH) {
      const next = source.charCodeAt(i + 1);
      // `\\.` in the rules: any one character but a line terminator.
      if (i + 1 >= source.length || next === LINE_FEED || next === 13 || next === 0x2028 || next === 0x2029) return i;
      i += 2;
    } else {
      i += 1;
    }
  }
  return source.length;
}

export function highlight(source: string, language: HighlightLanguage = 'softn'): React.ReactElement[] {
  const rules =
    language === 'python'
      ? PYTHON_RULES
      : language === 'json'
        ? JSON_RULES
        : language === 'php'
          ? PHP_RULES
          : language === 'rust'
            ? RUST_RULES
            : language === 'sql'
              ? SQL_RULES
              : language === 'css'
                ? CSS_RULES
                : language === 'shell'
                  ? SHELL_RULES
                  : language === 'markup'
                    ? MARKUP_RULES
                    : RULES;
  const out: React.ReactElement[] = [];
  const len = source.length;
  let pos = 0;
  // By quote character: no string it opens before this index closes. The
  // source is a publisher's, and a file of quotes that never close — every
  // one of them escaped — was otherwise read to its end from each of them:
  // 256 KB of that, which the directory will send, held the tab for many
  // seconds each time the pane was drawn.
  const unclosed = new Map<string, number>();
  let key = 0;
  // Runs of the same class are merged so a paragraph of prose is one span
  // rather than one span per word.
  let pendingCls = '';
  let pending = '';

  const flush = () => {
    if (!pending) return;
    out.push(
      <span key={key++} className={pendingCls}>
        {pending}
      </span>
    );
    pending = '';
  };

  while (pos < len) {
    let matched = false;
    const ch = source[pos];
    for (const rule of rules) {
      const opensString = rule.quotes !== undefined && rule.quotes.includes(ch);
      if (opensString && pos < (unclosed.get(ch) ?? 0)) continue;
      rule.re.lastIndex = pos;
      const m = rule.re.exec(source);
      if (!m || m[0].length === 0) {
        if (opensString) unclosed.set(ch, unclosedUntil(source, pos, rule.oneLine === true));
        continue;
      }
      if (rule.cls !== pendingCls) {
        flush();
        pendingCls = rule.cls;
      }
      pending += m[0];
      pos += m[0].length;
      matched = true;
      break;
    }
    // The last rule matches any single character, so this is unreachable; it is
    // here so a future rule edit cannot turn a typo into a hung tab.
    if (!matched) {
      if (pendingCls !== 'tok-expr') {
        flush();
        pendingCls = 'tok-expr';
      }
      pending += ch;
      pos += 1;
    }
  }

  flush();
  return out;
}

/**
 * `label` makes the block a named, focusable region. A `<pre>` that scrolls
 * sideways — which this one does at phone widths, 483px of markup in a 278px
 * box — is focusable on its own in Chromium and Firefox but not in Safari,
 * where the code then cannot be reached by keyboard at all. Saying it out loud
 * also gives a screen reader something to announce when focus lands there,
 * which an anonymous scroll container does not.
 */
export function Code({
  source,
  className,
  label,
  language = 'softn',
}: {
  source: string;
  className?: string;
  label?: string;
  language?: HighlightLanguage;
}): React.ReactElement {
  const highlighted = React.useMemo(() => highlight(source, language), [source, language]);
  return (
    <pre
      className={className}
      tabIndex={label ? 0 : undefined}
      role={label ? 'region' : undefined}
      aria-label={label}
    >
      <code>{highlighted}</code>
    </pre>
  );
}
