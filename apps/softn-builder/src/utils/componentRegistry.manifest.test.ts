/**
 * Builder's component registry is editorial: which props an author sees in
 * the property panel, in what control, with what default, and the icon,
 * category and description of each component. What it must not do is
 * disagree with the components themselves. `component-manifest.json` in
 * @softn/components is generated from the component sources (every
 * exported component, its props interface, every enum's options, what each
 * registry entry registers) and has its own staleness test; this test
 * holds the Builder registry to it.
 *
 * The registry drifted before this test existed (props the component does
 * not take, options it does not accept, defaults outside the enum). Those
 * are recorded in `componentRegistry.drift.json` so the panel keeps
 * offering what it offered until each is fixed on purpose: the test fails
 * on any NEW disagreement, and asks for a re-baseline when one is fixed so
 * the file always says what is still wrong. Regenerate with
 * `npm run generate:component-drift -w @softn/builder`. A prop's default and
 * choices are not baselined: they are the components' own, and the checks at
 * the end fail on any that is not.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { componentRegistry } from './componentRegistry';
import { EDITORIAL_PROPS, PROP_TYPE_FOR_KIND } from './componentRegistryContract';
import { componentPropsPath, renderComponentProps } from '../../scripts/generate-component-props.mjs';
import { shownValue, writtenValue } from './propValues';

type ManifestType = { kind: string; options?: string[]; literals?: string[]; text?: string };
type ManifestMember = { name: string; optional: boolean; type: ManifestType; default?: unknown; defaultUnknown?: boolean; doc?: string };
type ManifestComponent = { name: string; source: string; props: { interface: string; members: ManifestMember[] } | null };
type Manifest = { components: ManifestComponent[]; registered: Record<string, string[]> };

const manifestPath = fileURLToPath(new URL('../../../../packages/@softn/components/component-manifest.json', import.meta.url));
const driftPath = fileURLToPath(new URL('./componentRegistry.drift.json', import.meta.url));
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const byName = new Map(manifest.components.map((c) => [c.name, c]));
const registered = new Set(Object.values(manifest.registered).flat());

/** Every way the registry disagrees with the manifest today, one line each, sorted. */
function disagreements(): string[] {
  const out: string[] = [];
  const builder = new Set(componentRegistry.map((c) => c.name));
  for (const name of builder) if (!registered.has(name)) out.push(`${name}: not a registered component`);
  for (const name of registered) if (!builder.has(name)) out.push(`${name}: registered but not offered by the palette`);

  for (const meta of componentRegistry) {
    const members = new Map((byName.get(meta.name)?.props?.members ?? []).map((m) => [m.name, m]));
    for (const prop of meta.propSchema) {
      const member = members.get(prop.name);
      if (!member) {
        if (!EDITORIAL_PROPS.has(prop.name)) out.push(`${meta.name}.${prop.name}: prop the component does not declare`);
        continue;
      }
      const allowed = PROP_TYPE_FOR_KIND[member.type.kind];
      if (allowed && !allowed.includes(prop.type)) out.push(`${meta.name}.${prop.name}: ${prop.type} control for a ${member.type.kind} prop`);
      if (member.type.kind === 'enum') {
        const accepted = new Set(member.type.options ?? []);
        if (prop.type === 'select') {
          const extra = (prop.options ?? []).filter((o) => !accepted.has(o));
          if (extra.length) out.push(`${meta.name}.${prop.name}: offers ${extra.join(', ')}; component accepts ${[...accepted].join(', ')}`);
        }
        if (typeof prop.default === 'string' && !accepted.has(prop.default)) out.push(`${meta.name}.${prop.name}: default "${prop.default}" is not an accepted option`);
      }
    }
    for (const [name, value] of Object.entries(meta.defaultProps)) {
      const member = members.get(name);
      if (!member) {
        if (!EDITORIAL_PROPS.has(name)) out.push(`${meta.name}.${name}: default for a prop the component does not declare`);
        continue;
      }
      const kind = member.type.kind;
      if (kind === 'boolean' && typeof value !== 'boolean') out.push(`${meta.name}.${name}: default ${JSON.stringify(value)} for a boolean`);
      if (kind === 'number' && typeof value !== 'number') out.push(`${meta.name}.${name}: default ${JSON.stringify(value)} for a number`);
      if (kind === 'enum' && typeof value === 'string' && !(member.type.options ?? []).includes(value)) out.push(`${meta.name}.${name}: default ${JSON.stringify(value)} is not an option`);
    }
  }
  return [...new Set(out)].sort();
}

describe('the Builder component registry against component-manifest.json', () => {
  const current = disagreements();
  if (process.env.SOFTN_WRITE_DRIFT_BASELINE) writeFileSync(driftPath, JSON.stringify(current, null, 2) + '\n');
  const baseline: string[] = JSON.parse(readFileSync(driftPath, 'utf8'));
  const known = new Set(baseline);
  const still = new Set(current);

  it('names every registered component and nothing else', () => {
    const names = current.filter((line) => /: (not a registered component|registered but not offered)/.test(line));
    expect(names).toEqual([]);
  });

  it('has drifted no further than componentRegistry.drift.json records', () => {
    const fresh = current.filter((line) => !known.has(line));
    expect(fresh, 'new disagreements with the component sources; fix the registry entry, not the baseline').toEqual([]);
  });

  it('records only disagreements that still exist (re-baseline after a fix)', () => {
    const stale = baseline.filter((line) => !still.has(line));
    expect(stale, 'fixed: run `npm run generate:component-drift -w @softn/builder` so the baseline says what is still wrong').toEqual([]);
  });
});

/**
 * The panel shows a prop a page has not written as its default and writes
 * nothing when the default is chosen, so a default that is not the
 * component's own is a prop that cannot be set: the registry said a chart's
 * `interactive` was on, and it could never be turned on; that a Card's
 * `dividers` were off, and they could never be turned off; that a Stack's gap
 * was `md`, and "Default (md)" gave none. Defaults and choices come from the
 * components (componentProps.generated.ts). These checks are not baselined:
 * a disagreement fails.
 */
describe('the defaults and choices the property panel offers', () => {
  it('come from a componentProps.generated.ts made from the current manifest (run `npm run generate:component-props -w @softn/builder`)', () => {
    expect(readFileSync(componentPropsPath, 'utf8').replace(/\r\n/g, '\n')).toBe(renderComponentProps(manifest));
  });

  it('are each component’s own default for every prop the manifest can read one of', () => {
    const wrong: string[] = [];
    for (const meta of componentRegistry) {
      const members = new Map((byName.get(meta.name)?.props?.members ?? []).map((m) => [m.name, m]));
      for (const prop of meta.propSchema) {
        const member = members.get(prop.name);
        if (!member || member.defaultUnknown) continue;
        if (JSON.stringify(prop.default) !== JSON.stringify(member.default)) {
          wrong.push(`${meta.name}.${prop.name}: panel says ${JSON.stringify(prop.default)}, component ${JSON.stringify(member.default)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('offer every choice a component’s type names, and no other where its type takes no other', () => {
    const wrong: string[] = [];
    for (const meta of componentRegistry) {
      const members = new Map((byName.get(meta.name)?.props?.members ?? []).map((m) => [m.name, m]));
      for (const prop of meta.propSchema) {
        const type = members.get(prop.name)?.type;
        const named = type?.kind === 'enum' ? type.options : type?.literals;
        if (prop.type !== 'select' || !named) continue;
        const offered = prop.options ?? [];
        const missing = named.filter((option) => !offered.includes(option));
        if (missing.length) wrong.push(`${meta.name}.${prop.name}: does not offer ${missing.join(', ')}`);
        if (members.get(prop.name)!.type.kind === 'enum' && offered.length !== named.length) wrong.push(`${meta.name}.${prop.name}: offers more than ${named.join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('let every yes-or-no prop be turned away from its default, and back', () => {
    const stuck: string[] = [];
    for (const meta of componentRegistry) {
      for (const prop of meta.propSchema) {
        if (prop.type !== 'boolean') continue;
        const unset = { value: undefined, isExpression: false };
        const shown = shownValue(prop, unset);
        const turned = writtenValue(prop, unset, !shown);
        const back = turned && writtenValue(prop, turned, shown);
        // Away from the default is written; back to it is written as nothing.
        if (!turned || turned.value === undefined || !back || back.value !== undefined) stuck.push(`${meta.name}.${prop.name}`);
      }
    }
    expect(stuck).toEqual([]);
  });

  it('are the components’ own where the panel was wrong before', () => {
    const prop = (component: string, name: string) => componentRegistry.find((c) => c.name === component)!.propSchema.find((p) => p.name === name)!;
    expect(prop('LineChart', 'interactive').default).toBe(false);
    expect(prop('BarChart', 'interactive').default).toBe(false);
    expect(prop('Card', 'dividers').default).toBe(true);
    expect(prop('Stack', 'gap').default).toBe('none');
    expect(prop('Box', 'padding').default).toBe('none');
    // An open type's own list keeps the values it takes beyond the ones it names.
    expect(prop('App', 'theme').options).toEqual(['light', 'dark', 'system']);
  });
});
