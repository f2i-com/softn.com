/**
 * Egress through CSS a component writes for itself.
 *
 * The renderer scrubs a remote `url()` out of `props.style`, and that object
 * is the only inline CSS it knows about. The layout components take
 * `background` as a prop of their own and copied it verbatim into the style
 * they build, so `<Box background="url(https://attacker/x)">` painted — and
 * so fetched — with no `net` grant. SmartCards did the same with a record's
 * image field, checked for scheme alone. These pin the decision at the point
 * the value becomes CSS: refused without `net`, through with it, and a plain
 * colour untouched either way.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { CapabilityProvider, type CapabilityState } from '@softn/core';
import { Box } from '../src/layout/Box';
import { Content } from '../src/layout/Content';
import { Header } from '../src/layout/Header';
import { Section } from '../src/layout/Section';
import { Sidebar } from '../src/layout/Sidebar';
import { PanView } from '../src/animation/PanView';
import { SmartCards } from '../src/smart/SmartCards';
import { byText, mount } from './dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

const NO_NET: CapabilityState = { consentPending: false, permissions: {} };
const NET: CapabilityState = { consentPending: false, permissions: { net: { enabled: true } } };

const REMOTE = 'url(https://attacker.example/x)';

const layouts: Array<[string, (background: string) => React.ReactElement]> = [
  ['Box', (background) => <Box background={background}>x</Box>],
  ['Content', (background) => <Content background={background}>x</Content>],
  ['Header', (background) => <Header background={background} title="x" />],
  ['Section', (background) => <Section background={background}>x</Section>],
  ['Sidebar', (background) => <Sidebar background={background}>x</Sidebar>],
  [
    'PanView',
    (background) => (
      <PanView background={background} contentWidth={10} contentHeight={10}>
        x
      </PanView>
    ),
  ],
];

describe.each(layouts)('%s background', (_name, render) => {
  it('drops a remote url() when the bundle has no net grant', () => {
    const { container } = mount(
      <CapabilityProvider value={NO_NET}>{render(REMOTE)}</CapabilityProvider>
    );
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('paints a remote url() once net is granted', () => {
    const { container } = mount(<CapabilityProvider value={NET}>{render(REMOTE)}</CapabilityProvider>);
    expect(container.innerHTML).toContain('attacker.example');
  });

  it('passes a colour through untouched', () => {
    const { container } = mount(<CapabilityProvider value={NO_NET}>{render('red')}</CapabilityProvider>);
    expect(container.querySelector<HTMLElement>('[style]')?.style.background).toBe('red');
  });

  it('is not enforced where the host publishes no policy', () => {
    const { container } = mount(render(REMOTE));
    expect(container.innerHTML).toContain('attacker.example');
  });
});

describe('SmartCards image field', () => {
  const rows = [{ id: '1', name: 'Ada Lovelace', avatar: 'https://cdn.example/a.png' }];

  it('falls back to initials when the bundle has no net grant', () => {
    const { container } = mount(
      <CapabilityProvider value={NO_NET}>
        <SmartCards data={rows} image="avatar" />
      </CapabilityProvider>
    );
    expect(container.innerHTML).not.toContain('cdn.example');
    expect(byText(container, 'AL')).toBeDefined();
  });

  it('shows the image once net is granted', () => {
    // jsdom drops the `url() center/cover` shorthand from the style
    // attribute, so the image itself is not observable; the initials the card
    // draws in its place are.
    const { container } = mount(
      <CapabilityProvider value={NET}>
        <SmartCards data={rows} image="avatar" />
      </CapabilityProvider>
    );
    expect(byText(container, 'AL')).toBeUndefined();
  });
});
