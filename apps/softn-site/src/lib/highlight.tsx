import React from 'react';

/**
 * A deliberately small highlighter for `.ui` and `.logic` source.
 *
 * It exists to make one point visually — that the marks belonging to SoftN
 * itself (`#each`, `@click`, `:bind`, the braces around an expression, the
 * `<logic>` block) are a different kind of thing from the markup around them —
 * so it only needs enough resolution to separate those from tags, attributes,
 * strings and prose. Anything a real editor would do beyond that is out of
 * scope; the builder ships Monaco for that.
 */

type Rule = { cls: string; re: RegExp };

// Order is the whole design here: the first rule that matches at a position
// wins, so the specific marks have to be tried before the general ones.
const RULES: Rule[] = [
  { cls: 'tok-com', re: /^\/\/[^\n]*/ },
  { cls: 'tok-str', re: /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`(?:[^`\\]|\\.)*`/ },
  // SoftN's control-flow directives.
  { cls: 'tok-mark', re: /^#(?:if|else|each|empty|end)\b/ },
  // A tag only counts when the name is capitalised or is the `logic` block —
  // otherwise every `a < b` in a `.logic` file would open an element.
  { cls: 'tok-tag', re: /^<\/?(?:[A-Z][\w.]*|logic|script|style)\b/ },
  { cls: 'tok-tag', re: /^\/?>/ },
  // Event handlers and two-way bindings.
  { cls: 'tok-mark', re: /^[@:][A-Za-z_][\w-]*/ },
  { cls: 'tok-mark', re: /^[{}]/ },
  {
    cls: 'tok-mark',
    re: /^\b(?:let|const|var|function|return|if|else|for|while|await|async|new|class|import|export|from|typeof|of|in|try|catch|throw)\b/,
  },
  { cls: 'tok-num', re: /^\b(?:true|false|null|undefined|\d+(?:\.\d+)?)\b/ },
  // An attribute name, recognised by the `=` that follows it.
  { cls: 'tok-attr', re: /^[A-Za-z_][\w-]*(?=\s*=)/ },
  { cls: 'tok-punc', re: /^[=(),;[\]]/ },
  // Anything else: identifiers, whitespace, operators, prose inside elements.
  { cls: 'tok-expr', re: /^[^\s<>{}"'`@:#=(),;[\]/]+|^\s+|^./ },
];

export function highlight(source: string): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  let rest = source;
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

  while (rest.length > 0) {
    let matched = false;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (!m || m[0].length === 0) continue;
      if (rule.cls !== pendingCls) {
        flush();
        pendingCls = rule.cls;
      }
      pending += m[0];
      rest = rest.slice(m[0].length);
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
      pending += rest[0];
      rest = rest.slice(1);
    }
  }

  flush();
  return out;
}

export function Code({ source, className }: { source: string; className?: string }): React.ReactElement {
  return (
    <pre className={className}>
      <code>{highlight(source)}</code>
    </pre>
  );
}
