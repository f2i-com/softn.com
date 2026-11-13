/**
 * The agent's reference material is generated from the component manifest
 * and the published docs (scripts/generate-agent-knowledge.mjs). These tests
 * fail when the checked-in modules no longer match their sources — a new
 * component, a changed prop, an edited guide — so the agent is never taught
 * from a stale copy. Regenerate with `npm run generate:knowledge -w @softn/studio`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script, without type declarations.
import { buildKnowledge, DOCS_PATH, MANIFEST_PATH, OUT_DIR } from '../scripts/generate-agent-knowledge.mjs';
import { COMPONENT_INDEX, DOC_INDEX, componentIndexText, docIndexText, lookupComponents, readDocs } from '../src/lib/agent/knowledge';
import { executeTool } from '../src/lib/agent/executeTool';
import { buildAgentSystemPrompt } from '../src/lib/agent/prompt';
import { estimateTokens } from '../src/lib/agent/runAgent';
import { AGENT_TOOLS } from '../src/lib/agent/tools';
import { browserEnvironment } from '../src/lib/agent/appCheck';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { components: Array<{ name: string; props?: { members: Array<{ name: string; type: { kind: string; options?: string[] } }> } }>; registered: Record<string, string[]> };

describe('the generated knowledge', () => {
  it('matches its sources exactly (regenerate when this fails)', () => {
    const expected = buildKnowledge(readFileSync(MANIFEST_PATH, 'utf8'), readFileSync(DOCS_PATH, 'utf8')) as Record<string, string>;
    for (const [name, text] of Object.entries(expected)) {
      expect(readFileSync(join(OUT_DIR, name), 'utf8'), `${name} is stale: run npm run generate:knowledge -w @softn/studio`).toBe(text);
    }
  });

  it('indexes every component in the manifest, and marks exactly the registered ones', () => {
    const registered = new Set(Object.values(manifest.registered).flat());
    expect(COMPONENT_INDEX.map((c) => c.name).sort()).toEqual(manifest.components.map((c) => c.name).sort());
    for (const entry of COMPONENT_INDEX) expect(entry.registered).toBe(registered.has(entry.name));
    const text = componentIndexText();
    for (const name of registered) expect(text).toContain(`- ${name}:`);
  });

  // The renderer writes back for `:bind` alone: any other `:name` property only shows a value
  // (@softn/core, renderer/render.tsx). Checkbox's line said "bind with :bind or :checked", and
  // a box written with :checked cannot be ticked.
  it('calls no `:` property but :bind a way to bind', async () => {
    for (const entry of COMPONENT_INDEX) {
      const others = [...entry.purpose.matchAll(/:([a-zA-Z][\w-]*)/g)].map((m) => m[1]).filter((name) => name !== 'bind');
      expect(others, `${entry.name}: ${entry.purpose}`).toEqual([]);
    }
    const purpose = (name: string) => COMPONENT_INDEX.find((c) => c.name === name)!.purpose;
    expect(purpose('Checkbox')).toContain(':bind={name} holds true or false');
    expect(purpose('Checkbox')).toContain('checked={x} only shows x');
    expect(purpose('Switch')).toContain(':bind={name} holds true or false');
    expect((await lookupComponents(['Checkbox'])).text).not.toContain(':checked');
  });

  it('lookup_components answers every component with its props, enums and events', async () => {
    for (const component of manifest.components) {
      const { ok, text } = await lookupComponents([component.name]);
      expect(ok).toBe(true);
      expect(text).toContain(`## ${component.name} — `);
      for (const member of component.props?.members ?? []) {
        if (['className', 'style', 'id'].includes(member.name)) continue;
        // An event is named for one and takes a function; Switch's onColor is a colour, and a prop.
        if (/^on[A-Z]/.test(member.name) && member.type.kind === 'function') {
          expect(text).toContain(`@${member.name.charAt(2).toLowerCase()}${member.name.slice(3)}`);
        } else {
          expect(text).toContain(`- ${member.name}`);
        }
        for (const option of member.type.options ?? []) expect(text).toContain(JSON.stringify(option));
      }
    }
    const miss = await lookupComponents(['Buton']);
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain('Not components: Buton');
  });

  it('spells out the named types props take, from the component source (a real model spent 15 steps guessing BarChart\'s)', async () => {
    const { text } = await lookupComponents(['BarChart', 'LineChart', 'Select']);
    expect(text).toContain('- BarChartSeries = { name: string; data: BarDataPoint[]; color?: string }');
    expect(text).toContain('- BarDataPoint = { label: string; value: number; color?: string }');
    expect(text).toMatch(/- DataPoint = \{ x: number \| string; y: number/);
    expect(text).toMatch(/- SelectOption = \{ value: string \| number; label: string/);
    // Markup inside a {…} value does not parse, so a node-typed field is shown as a string.
    const tabs = (await lookupComponents(['Tabs', 'Accordion'])).text;
    expect(tabs).toContain('- AccordionItem = { key: string; header: string; content: string; disabled?: boolean }');
    expect(tabs.split('Types the props use:').slice(1).join('')).not.toMatch(/ReactNode/);
  });

  // A type was kept only if it fitted in 400 characters, with its comments taken out, and only
  // from the component's own file. So for a 3D scene the model was told `objects?: Scene3DObject[]`
  // and nothing of what an object, a light, a hit or the effects are.
  it('spells out every type a prop or an event names, whole and with each field’s comment, from whichever file declares it', async () => {
    const { text } = await lookupComponents(['Scene3D']);
    const types = text.slice(text.indexOf('Types the props use:'), text.indexOf('Events (write'));
    // An object is far longer than a line: a field to a line, each with what its comment says.
    expect(types).toContain('- Scene3DObject = {');
    expect(types).toMatch(/\n {4}id: string/);
    expect(types).toMatch(/\n {4}animate\?: \{[^\n]*\} — [^\n]*radians per frame/);
    expect(types).toMatch(/\n {4}instances\?: number\[\]/);
    expect(types).toContain('- Scene3DLight = {');
    // What a click hands its handler, which the manifest knows only as "a function".
    expect(types).toContain('- Scene3DHit = ');
    expect(text).toMatch(/- @click\(\w+: Scene3DHit\)/);
    // The effects are declared in a file of their own and handed on by the scene's.
    expect(types).toContain('- Scene3DEffects = ');
    expect(types).toContain('- ModelAppearance = ');
  });

  it('reads the types from the sources by these rules', () => {
    const sources: Record<string, string> = {
      'src/demo/Stage.tsx': `
        import { type Glow, type Hidden as Shown } from './glow';
        export type { Glow } from './glow';
        export * from './shapes';
        /** One thing on the stage. */
        export interface Prop {
          /** Unique on the stage */
          id: string;
          // not a doc comment
          kind: Shape;
          /** Where it stands, in metres */
          at?: { x: number; y: number };
          ${Array.from({ length: 40 }, (_, i) => `/** Setting ${i} */\n          setting${i}?: number;`).join('\n          ')}
          inner?: Inner;
        }
        interface Inner { deep?: Deeper }
        interface Deeper { deeper?: Deepest }
        interface Deepest { never: true }
        export interface Touch { propId: string; glow: Glow }
        export interface StageProps {
          props?: Prop[];
          shown?: Shown;
          onTouch?: (touch: Touch) => void;
          onPress?: (event: React.MouseEvent<HTMLDivElement>) => void;
          onDone?: () => void;
        }
        export function Stage(_: StageProps) { return null; }`,
      'src/demo/glow.ts': `
        /** How a thing glows. */
        export interface Glow {
          /** From 0 to 1 */
          strength?: number;
        }
        export type Hidden = 'yes' | 'no';`,
      'src/demo/shapes.ts': `export type Shape = 'box' | 'ball';`,
    };
    const fn = { kind: 'function' };
    const stage = {
      components: [
        {
          name: 'Stack',
          source: 'src/demo/Stage.tsx',
          props: {
            interface: 'StageProps',
            members: [
              { name: 'props', optional: true, type: { kind: 'array', text: 'Prop[]' } },
              { name: 'shown', optional: true, type: { kind: 'other', text: 'Shown' } },
              { name: 'onTouch', optional: true, type: fn },
              { name: 'onPress', optional: true, type: fn },
              { name: 'onDone', optional: true, type: fn },
            ],
          },
        },
      ],
      registered: { essentials: ['Stack'] },
    };
    const built = buildKnowledge(JSON.stringify(stage), JSON.stringify({ pages: [] }), (path: string) => sources[path] ?? null) as Record<string, string>;
    const reference = (JSON.parse(built['components.generated.ts'].slice(built['components.generated.ts'].indexOf('= {') + 2).replace(/;\s*$/, '')) as Record<string, string>).Stack;

    // Longer than a line: every field, in order, none cut off, each with its doc comment and no other.
    expect(reference).toContain('- Prop = {\n    // One thing on the stage.\n    id: string — Unique on the stage\n    kind: Shape\n    at?: { x: number; y: number } — Where it stands, in metres\n    setting0?: number — Setting 0');
    expect(reference).toContain('    setting39?: number — Setting 39\n    inner?: Inner\n  }');
    expect(reference).not.toContain('not a doc comment');
    // A type an event hands over, and what that names in another file, with its comments under it.
    expect(reference).toContain('- Touch = { propId: string; glow: Glow }');
    expect(reference).toContain('- Glow = { strength?: number }\n  How a thing glows.\n  - strength: From 0 to 1');
    // Brought in under another name, and through `export *`.
    expect(reference).toContain("- Shown = 'yes' | 'no'");
    expect(reference).toContain("- Shape = 'box' | 'ball'");
    // Followed three deep from a prop and no further.
    expect(reference).toContain('- Inner = { deep?: Deeper }');
    expect(reference).toContain('- Deeper = { deeper?: Deepest }');
    expect(reference).not.toContain('- Deepest');
    // The props' own interface is not one of the types, and an event says what it hands over.
    expect(reference).not.toContain('- StageProps');
    expect(reference).toContain('- @touch(touch: Touch)');
    expect(reference).toContain('- @press(event)');
    expect(reference).toMatch(/- @done\n/);
  });

  it('read_docs serves every guide and section by slug', async () => {
    const docs = JSON.parse(readFileSync(DOCS_PATH, 'utf8')) as { pages: Array<{ id: string; sections: Array<{ id: string; title: string }> }> };
    expect(DOC_INDEX.map((d) => d.slug)).toEqual(docs.pages.map((p) => p.id));
    for (const page of docs.pages) {
      const whole = await readDocs(page.id);
      expect(whole.ok).toBe(true);
      const section = await readDocs(`${page.id}#${page.sections[0].id}`);
      expect(section.ok).toBe(true);
      expect(section.text).toContain(page.sections[0].title);
    }
    expect((await readDocs('nope')).ok).toBe(false);
    expect(docIndexText(false)).not.toMatch(/python|torch/i);
  });

  it('the tools reach the knowledge', async () => {
    const ctx = { seen: new Map(), env: browserEnvironment, blueprint: null, newTransactionId: () => 't' };
    const components = await executeTool({ id: '1', name: 'lookup_components', input: { names: ['Table', 'tabs'] } }, ctx);
    expect(components.isError).toBe(false);
    expect(components.content).toContain('## Table — ');
    expect(components.content).toContain('## Tabs — ');
    const docs = await executeTool({ id: '2', name: 'read_docs', input: { topic: 'xdb-data' } }, ctx);
    expect(docs.isError).toBe(false);
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['lookup_components', 'read_docs']));
  });
});

describe('the system prompt', () => {
  it('stays compact: the guide and indexes are in it, file contents and the full reference are not', () => {
    const system = buildAgentSystemPrompt('anthropic');
    expect(system).toContain('# How to build a SoftN app');
    expect(system).toContain('## Components');
    expect(system).toContain('- Stack:');
    expect(system).toContain('## Guides (read_docs)');
    expect(system).not.toContain('Props (? = optional)');
    // The budget the prompt is designed to: well under a fifth of a small context window.
    expect(estimateTokens(system)).toBeLessThan(14_000);
    const text = buildAgentSystemPrompt('text');
    expect(text).toContain('## Calling tools (text protocol)');
  });
});
