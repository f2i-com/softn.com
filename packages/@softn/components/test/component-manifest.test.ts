/**
 * component-manifest.json is generated from the component sources and
 * committed; it is what an editor's palette and property panel can be built
 * from. It must describe the tree it sits in, and every name the registry
 * entries register must be a component it describes.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildManifest, manifestPath, propKindsPath, renderPropKinds } from '../scripts/generate-manifest.mjs';

type Manifest = ReturnType<typeof buildManifest>;

describe('component-manifest.json', () => {
  const committed: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fresh = buildManifest();

  it('matches the component sources (run `npm run generate:manifest -w @softn/components` after changing props)', () => {
    expect(committed).toEqual(fresh);
  });

  it('and so does src/prop-kinds.generated.ts, which the renderer reads number and boolean props by', () => {
    expect(readFileSync(propKindsPath, 'utf8').replace(/\r\n/g, '\n')).toBe(renderPropKinds(fresh));
  });

  it('describes every component the registry entries register', () => {
    const described = new Set(fresh.components.map((c) => c.name));
    const unknown = Object.entries(fresh.registered).flatMap(([entry, names]) =>
      names.filter((name) => !described.has(name)).map((name) => `${entry}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it('records the props interface of every registered component', () => {
    const registered = new Set(Object.values(fresh.registered).flat());
    const withoutProps = fresh.components.filter((c) => registered.has(c.name) && c.props === null).map((c) => c.name);
    // Components that take no props at all are allowed to say so.
    expect(withoutProps).toEqual([]);
  });
});

/**
 * An editor shows a prop a page has not written as what the component does
 * without it, and writes nothing when that is chosen. Builder's panel used to
 * take that from a table of its own, which said Card's dividers were off and
 * a chart's interactive on: the one could never be turned off, the other never
 * on. Each member's `default` is read from the component instead.
 */
describe('the defaults the manifest records', () => {
  const fresh = buildManifest();
  const member = (component: string, prop: string) => {
    const found = fresh.components.find((c) => c.name === component)?.props?.members.find((m) => m.name === prop);
    if (!found) throw new Error(`${component}.${prop} is not in the manifest`);
    return found;
  };

  it('are the literals the components destructure their props with', () => {
    expect(member('Card', 'dividers').default).toBe(true);
    expect(member('LineChart', 'interactive').default).toBe(false);
    expect(member('BarChart', 'interactive').default).toBe(false);
    expect(member('Stack', 'gap').default).toBe('none');
    expect(member('Box', 'padding').default).toBe('none');
    expect(member('Split', 'gutterSize').default).toBe(4);
  });

  it('follow the props into the function a component hands them to, and the constants it names', () => {
    // Avatar passes its props whole to AvatarFace, which destructures them.
    expect(member('Avatar', 'size').default).toBe('md');
    expect(member('ColorPicker', 'defaultValue').default).toMatch(/^#[0-9a-f]{6}$/i);
    expect(member('Accordion', 'defaultOpenKeys').default).toEqual([]);
    // `'id' as keyof T` is 'id'.
    expect(member('DataGrid', 'keyField').default).toBe('id');
  });

  it('take a fallback in the body as the default, and say when the default is worked out', () => {
    // `defaultChecked ?? false`
    expect(member('Checkbox', 'defaultChecked').default).toBe(false);
    // `loop !== undefined ? loop : texts.length > 1`, `audio ?? (mode === 'video' && …)`
    expect(member('Typewriter', 'loop')).toMatchObject({ defaultUnknown: true });
    expect(member('Camera', 'audio')).toMatchObject({ defaultUnknown: true });
    expect(member('Typewriter', 'loop').default).toBeUndefined();
  });

  it('give a controlled prop the component holds itself while it is not given no default', () => {
    // `open !== undefined ? open : internalOpen`
    const open = member('Popover', 'open');
    expect(open.default).toBeUndefined();
    expect(open.defaultUnknown).toBeUndefined();
  });

  it('are of the kind the prop is declared as', () => {
    const wrong: string[] = [];
    for (const component of fresh.components) {
      for (const m of component.props?.members ?? []) {
        if (!('default' in m)) continue;
        const kind = m.type.kind;
        const value = m.default;
        if (kind === 'boolean' && typeof value !== 'boolean') wrong.push(`${component.name}.${m.name}`);
        if (kind === 'number' && typeof value !== 'number') wrong.push(`${component.name}.${m.name}`);
        if (kind === 'enum' && !(m.type.options ?? []).includes(value as string)) wrong.push(`${component.name}.${m.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('name the choices of a union that takes other values too, and keep its text', () => {
    expect(member('Stack', 'gap').type).toEqual({ kind: 'other', text: "'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | string", literals: ['none', 'xs', 'sm', 'md', 'lg', 'xl'] });
    // A type alias the file declares as a union of strings is the enum it names.
    expect(member('AnimatedBox', 'animation').type).toEqual({ kind: 'enum', options: ['fadeIn', 'fadeUp', 'fadeDown', 'fadeLeft', 'fadeRight', 'scaleIn', 'slideUp', 'slideDown', 'bounceIn'] });
  });
});
