/**
 * The bundle's own markup, before the user has answered the bar.
 *
 * permission.json enumerates the softn.* scripting API, and the bar withholds
 * every capability in it until Allow. Markup was never in that list: an
 * `<Image src="https://…">` renders a raw `<img src>` and the browser fetches
 * it on first paint, and an inline `backgroundImage: url(https://…)` is the
 * same request with no element of its own. Neither goes near `softn.net.fetch`,
 * so the `net` grant never saw them.
 *
 * Under the modal this was unreachable by accident — the app did not exist
 * until Allow. Measured against the running gateway before this was fixed:
 * a bundle with an `<Image>` and an inline background made 2 offsite requests
 * with the consent bar still on screen, to two different hosts, one of which
 * its own permission.json did not list.
 *
 * What must not change: a relative, `data:` or `blob:` source is not egress.
 * `asset()` hands bundle files out as `blob:`, so gating those would break
 * every bundle's own images for nothing.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

/**
 * Stands in for `<Image>`, `<Avatar>`, `<Sprite>` and the rest: a registered
 * component that takes a `src` prop and puts it straight on an `<img>`. The
 * real ones live in @softn/components, which core does not depend on — and the
 * withholding is not theirs anyway, it is the renderer's, which is the whole
 * point of testing it here.
 */
function StubImage(props: SoftNProps): React.ReactElement {
  return React.createElement('img', {
    src: props.src as string | undefined,
    alt: 'stub',
    style: props.style as React.CSSProperties | undefined,
  });
}

function html(
  source: string,
  consentPending: boolean,
  state: Record<string, unknown> = {}
): string {
  const registry = new ComponentRegistry();
  registry.register('Image', StubImage);
  const doc = parse(source);
  const context = {
    state,
    setState: () => {},
    data: {},
    functions: {},
    computed: {},
    consentPending,
  } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context, registry))
  );
}

const REMOTE = 'https://attacker.example/beacon?d=1';

describe('a remote source in the markup while consent is pending', () => {
  it('does not reach a raw <img>', () => {
    expect(html(`<img src="${REMOTE}"/>`, true)).not.toContain('attacker.example');
  });

  it('does not reach a registered component that renders one', () => {
    expect(html(`<Image src="${REMOTE}" />`, true)).not.toContain('attacker.example');
  });

  it('does not reach an inline background-image', () => {
    const out = html(`<div style={{ backgroundImage: "url(${REMOTE})" }}>x</div>`, true);
    expect(out).not.toContain('attacker.example');
  });

  it('does not reach an inline background-image on a component either', () => {
    const out = html(`<Image style={{ backgroundImage: "url(${REMOTE})" }} />`, true);
    expect(out).not.toContain('attacker.example');
  });

  it('is not fooled by a protocol-relative URL', () => {
    // `//attacker.example/x` has no scheme, so every scheme check passes it —
    // and the browser resolves it against the page's own https.
    expect(html('<img src="//attacker.example/x"/>', true)).not.toContain('attacker.example');
    expect(html('<Image src="//attacker.example/x" />', true)).not.toContain('attacker.example');
  });

  it('is not fooled by backslashes standing in for the slashes', () => {
    // The URL parser folds `\` to `/` for an http(s) base, so `\\host/x` is
    // `//host/x` spelled to miss a leading-`//` test. Delivered through state
    // rather than as a literal, because the .ui parser reads `\\` in an
    // attribute as one escaped backslash — and a single leading backslash
    // really is just a path on this origin.
    expect(html('<img src={u}/>', true, { u: '\\\\attacker.example/x' })).not.toContain(
      'attacker.example'
    );
    expect(html('<img src={u}/>', true, { u: '/\\attacker.example/x' })).not.toContain(
      'attacker.example'
    );
  });

  it('is not fooled by a second candidate in a srcset', () => {
    // srcset is a list. Judging the whole string judges the first URL, and the
    // browser fetches whichever one it prefers.
    const out = html(`<img srcset="local.png 1x, ${REMOTE} 2x"/>`, true);
    expect(out).not.toContain('attacker.example');
  });

  it('leaves a bundle-relative and a blob: source alone', () => {
    // asset() answers with blob:, and a relative path is this origin. Neither
    // is egress, and neither needs a capability.
    expect(html('<img src="assets/logo.png"/>', true)).toContain('assets/logo.png');
    expect(html('<Image src="blob:http://localhost/abc" />', true)).toContain('blob:');
    expect(html('<img src="data:image/png;base64,iVBORw0KGgo="/>', true)).toContain('data:image');
  });

  it('leaves an inline style with no url() untouched', () => {
    expect(html('<div style={{ color: "red" }}>x</div>', true)).toContain('color:red');
  });
});

describe('the same markup once the user has allowed', () => {
  it('loads the raw <img>, the component and the inline background', () => {
    expect(html(`<img src="${REMOTE}"/>`, false)).toContain('attacker.example');
    expect(html(`<Image src="${REMOTE}" />`, false)).toContain('attacker.example');
    expect(html(`<div style={{ backgroundImage: "url(${REMOTE})" }}>x</div>`, false)).toContain(
      'attacker.example'
    );
  });

  it('still refuses a scheme that executes — the two checks are separate', () => {
    expect(html('<a href="javascript:alert(1)">x</a>', false)).not.toContain('javascript:');
  });
});

describe('a host that never says whether consent is pending', () => {
  it('renders exactly as it always did', () => {
    // The builder's preview, studio, and every test written before the bar
    // build a context with no `consentPending` at all. Defaulting it closed
    // would break all of them.
    const registry = new ComponentRegistry();
    const context = {
      state: {},
      setState: () => {},
      data: {},
      functions: {},
      computed: {},
    } as unknown as SoftNRenderContext;
    const out = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderDocument(parse(`<img src="${REMOTE}"/>`), context, registry)
      )
    );
    expect(out).toContain('attacker.example');
  });
});
