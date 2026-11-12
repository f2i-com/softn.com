/**
 * The props the runtime's editor offers for a picked component
 * (src/edit/componentProps.generated.ts) are what @softn/components'
 * manifest says they are: the file is generated from it, and a component
 * whose props change without the file being made again fails here.
 *
 * Compared as values, not as bytes: the file's line endings are the
 * checkout's.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainProps } from '../scripts/generate-edit-props.mjs';
import { COMPONENT_PROPS } from '../src/edit/componentProps.generated';

const manifest: unknown = JSON.parse(readFileSync(new URL('../../../packages/@softn/components/component-manifest.json', import.meta.url), 'utf8'));

describe('the editor’s table of component props', () => {
  it('is what the component manifest gives; regenerate with `node apps/softn-web/scripts/generate-edit-props.mjs`', () => {
    expect(COMPONENT_PROPS).toEqual(plainProps(manifest));
  });

  it('holds plain values only: no handler, no children, no style', () => {
    expect(Object.keys(COMPONENT_PROPS).length).toBeGreaterThan(90);
    for (const [component, props] of Object.entries(COMPONENT_PROPS)) {
      for (const [name, kind] of Object.entries(props)) {
        expect(name, component).not.toMatch(/^on[A-Z]|^(children|style|className)$/);
        if (typeof kind === 'string') expect(['s', 'n', 'b'], `${component}.${name}`).toContain(kind);
        else expect(kind.length, `${component}.${name}`).toBeGreaterThan(0);
      }
    }
    expect(COMPONENT_PROPS.Button).toMatchObject({ disabled: 'b', variant: expect.arrayContaining(['primary', 'danger']) });
    expect(COMPONENT_PROPS.App.theme).toEqual(['light', 'dark', '*']);
  });
});
