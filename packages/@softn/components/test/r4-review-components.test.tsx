/**
 * Audit round 4 (2026-11-27): a review of round 3's changes to the form,
 * data, feedback, navigation and display components.
 *
 * Each test marked as a regression failed on the round 3 code (0e839a1f).
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from './dom';
import { Tabs } from '../src/navigation/Tabs';
import { Accordion } from '../src/utility/Accordion';

const mounted: Mounted[] = [];
function draw(element: React.ReactElement): Mounted {
  const view = mount(element);
  mounted.push(view);
  return view;
}
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  document.body.innerHTML = '';
});

const references = (element: Element, attribute: string): Array<HTMLElement | null> =>
  (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));

describe('ids built from keys that end in half of an emoji', () => {
  // A key cut from a name by length (`name.slice(0, 7)`) can end in the
  // first half of a surrogate pair. Round 3 escaped keys with
  // `encodeURIComponent`, which throws "URI malformed" on such text, so the
  // whole Tabs or Accordion was drawn as the error box. Regression.
  const cut = 'Notes \uD83D';

  it('draw the tabs, each tied to its panel', () => {
    const { container } = draw(
      <Tabs
        tabs={[
          { key: cut, label: 'Notes', content: 'Written down' },
          { key: 'Plan', label: 'Plan', content: 'Pro' },
        ]}
      />
    );
    const tab = container.querySelector('[role="tab"]')!;
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toBe('Written down');
    expect(references(tab, 'aria-controls')).toEqual([panel]);
    expect(references(panel, 'aria-labelledby')).toEqual([tab]);
  });

  it('draw the accordion, each header tied to its panel', () => {
    const { container } = draw(<Accordion items={[{ key: cut, header: 'Notes', content: 'Written down' }]} defaultOpenKeys={[cut]} />);
    const button = container.querySelector('button')!;
    const region = container.querySelector('[role="region"]')!;
    expect(region.textContent).toBe('Written down');
    expect(references(button, 'aria-controls')).toEqual([region]);
    expect(references(region, 'aria-labelledby')).toEqual([button]);
  });

  it('keep two keys that differ only by an escape apart (guard)', () => {
    const { container } = draw(
      <Tabs
        tabs={[
          { key: 'a b', label: 'One', content: 'first' },
          { key: 'a%20b', label: 'Two', content: 'second' },
        ]}
      />
    );
    const ids = Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).not.toMatch(/\s/);
  });
});
