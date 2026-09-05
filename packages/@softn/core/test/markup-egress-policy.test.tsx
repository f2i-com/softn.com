/**
 * The bundle's own markup, after the user has answered the bar.
 *
 * markup-egress.test.tsx pins what happens while consent is pending: nothing
 * remote goes out. This pins what happens afterwards, which used to be
 * "anything": a bundle that declared no `net` at all, or scoped itself to one
 * host, could still beacon state to any host from an `<img src>` or an inline
 * `background-image`, because the markup sinks checked consent and nothing
 * else. Now they ask the same evaluator `softn.net.fetch` asks.
 *
 * What must not change: a relative, `data:` or `blob:` source is not egress;
 * a link is navigation the user chooses, not a fetch the render performs; and
 * a host that publishes no permission config — a preview outside any bundle —
 * is not enforcing.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';
import type { EgressConfig } from '../src/runtime/egress-policy';

function StubImage(props: SoftNProps): React.ReactElement {
  return React.createElement('img', {
    src: props.src as string | undefined,
    srcSet: props.srcSet as string | undefined,
    alt: 'stub',
    style: props.style as React.CSSProperties | undefined,
  });
}

function html(source: string, egress: EgressConfig | null): string {
  const registry = new ComponentRegistry();
  registry.register('Image', StubImage);
  const doc = parse(source);
  const context = {
    state: {},
    setState: () => {},
    data: {},
    functions: {},
    computed: {},
    consentPending: egress?.consentPending === true,
    egress,
  } as unknown as SoftNRenderContext;
  return renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderDocument(doc, context, registry))
  );
}

const CDN = 'https://cdn.example/x.png';
const OTHER = 'https://other.example/x.png';

const declaredNothing: EgressConfig = { permissions: {} };
const netAnywhere: EgressConfig = { permissions: { net: { enabled: true } } };
const netScoped: EgressConfig = {
  permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'] } },
};

describe('a bundle that declared no net, once consent is answered', () => {
  it('does not get a remote image', () => {
    expect(html(`<img src="${CDN}"/>`, declaredNothing)).not.toContain('cdn.example');
    expect(html(`<Image src="${CDN}" />`, declaredNothing)).not.toContain('cdn.example');
  });

  it('does not get a remote inline background', () => {
    const out = html(`<div style={{ backgroundImage: "url(${CDN})" }}>x</div>`, declaredNothing);
    expect(out).not.toContain('cdn.example');
  });

  it('keeps its own images', () => {
    expect(html(`<img src="blob:local/logo.png"/>`, declaredNothing)).toContain('blob:local/logo.png');
    expect(html(`<img src="images/logo.png"/>`, declaredNothing)).toContain('images/logo.png');
    expect(html(`<img src="data:image/png;base64,AAAA"/>`, declaredNothing)).toContain('data:image/png');
  });

  it('keeps a link to the author\'s site', () => {
    expect(html(`<a href="https://author.example/">site</a>`, declaredNothing)).toContain(
      'https://author.example/'
    );
  });
});

describe('a bundle scoped to one host', () => {
  it('reaches that host and no other', () => {
    expect(html(`<img src="${CDN}"/>`, netScoped)).toContain('cdn.example');
    expect(html(`<img src="${OTHER}"/>`, netScoped)).not.toContain('other.example');
    expect(html(`<Image src="${OTHER}" />`, netScoped)).not.toContain('other.example');
  });

  it('is held to the list for inline styles too', () => {
    expect(html(`<div style={{ backgroundImage: "url(${CDN})" }}>x</div>`, netScoped)).toContain(
      'cdn.example'
    );
    expect(html(`<div style={{ backgroundImage: "url(${OTHER})" }}>x</div>`, netScoped)).not.toContain(
      'other.example'
    );
  });

  it('loses a srcset with one candidate off the list', () => {
    const ok = `a.png 1x, ${CDN} 2x`;
    const bad = `a.png 1x, ${OTHER} 2x`;
    expect(html(`<Image srcSet="${ok}" />`, netScoped)).toContain('cdn.example');
    expect(html(`<Image srcSet="${bad}" />`, netScoped)).not.toContain('other.example');
  });

  it('is held to https unless it asked for http', () => {
    expect(html(`<img src="http://cdn.example/x.png"/>`, netScoped)).not.toContain('cdn.example');
    const withHttp: EgressConfig = {
      permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'], allow_http: true } },
    };
    expect(html(`<img src="http://cdn.example/x.png"/>`, withHttp)).toContain('cdn.example');
  });
});

describe('a bundle granted net with no host list', () => {
  it('reaches any https host, as fetch may', () => {
    expect(html(`<img src="${CDN}"/>`, netAnywhere)).toContain('cdn.example');
    expect(html(`<img src="${OTHER}"/>`, netAnywhere)).toContain('other.example');
  });
});

describe('a host that publishes no permission config', () => {
  it('is not enforcing, so a preview outside any bundle still shows remote images', () => {
    expect(html(`<img src="${CDN}"/>`, null)).toContain('cdn.example');
  });
});
