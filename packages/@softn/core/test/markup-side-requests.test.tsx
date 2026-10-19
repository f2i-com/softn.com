/**
 * Requests and names markup reached the page with, past the checks.
 *
 * `<a ping="/a https://evil.example/p">` was judged as one URL, its first, and
 * the browser beaconed every one in the list on a click. `attributionsrc`
 * reports to its URL and was not known as a URL at all; SVG's `xml:base`
 * moves where every relative reference below it resolves. An element's
 * `id` is a global of the page's window, and `<div id="__TAURI__">` took the
 * page for the desktop runtime. And a component's style objects other than
 * `style` — `tooltipStyle`, `overlayStyle`, spread onto an element of its
 * own — were not looked at.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '../src/parser';
import { renderDocument, ComponentRegistry } from '../src/renderer';
import type { SoftNProps, SoftNRenderContext } from '../src/types';
import type { EgressConfig } from '../src/runtime/egress-policy';

function Overlay(props: SoftNProps): React.ReactElement {
  return React.createElement('span', { className: 'overlay', style: props.overlayStyle as React.CSSProperties }, 'x');
}

function html(source: string, egress: EgressConfig | null = { consentPending: true, permissions: {} }): string {
  const registry = new ComponentRegistry();
  registry.register('Overlay', Overlay);
  const context = {
    state: {},
    setState: () => {},
    data: {},
    functions: {},
    computed: {},
    consentPending: egress?.consentPending === true,
    egress,
  } as unknown as SoftNRenderContext;
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(React.createElement(React.Fragment, null, renderDocument(parse(source), context, registry)));
  } finally {
    quiet.mockRestore();
  }
}

describe('what markup asks the browser to fetch by itself', () => {
  it('drops ping, attributionsrc and xml:base', () => {
    const out = html(
      '<div><a href="#top" ping="/a https://evil.example/p">x</a><img src="a.png" attributionsrc="https://evil.example/r" /><svg xmlBase="https://evil.example/"><use href="#i" /></svg></div>'
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('href="#top"');
  });

  it('drops a host-reserved id or name', () => {
    const out = html('<div><div id="__TAURI__">t</div><form name="__softnSpike"></form><p id="intro">kept</p></div>');
    expect(out).not.toContain('__TAURI__');
    expect(out).not.toContain('__softnSpike');
    expect(out).toContain('id="intro"');
  });

  it('judges a component’s other style objects as it judges style', () => {
    const out = html('<Overlay overlayStyle={{ backgroundImage: "url(https://evil.example/o.png)", color: "red" }} />');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('color:red');
    const allowed = html('<Overlay overlayStyle={{ backgroundImage: "url(https://cdn.example/o.png)" }} />', {
      permissions: { net: { enabled: true, allowed_hosts: ['cdn.example'] } },
    });
    expect(allowed).toContain('cdn.example/o.png');
  });
});
