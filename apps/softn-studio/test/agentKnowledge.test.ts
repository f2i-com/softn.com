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

  it('lookup_components answers every component with its props, enums and events', async () => {
    for (const component of manifest.components) {
      const { ok, text } = await lookupComponents([component.name]);
      expect(ok).toBe(true);
      expect(text).toContain(`## ${component.name} — `);
      for (const member of component.props?.members ?? []) {
        if (['className', 'style', 'id'].includes(member.name)) continue;
        if (/^on[A-Z]/.test(member.name)) expect(text).toContain(`@${member.name.charAt(2).toLowerCase()}${member.name.slice(3)}`);
        else expect(text).toContain(`- ${member.name}`);
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
    expect(text).toMatch(/- SelectOption = \{ value: string; label: string/);
    // Markup inside a {…} value does not parse, so a node-typed field is shown as a string.
    const tabs = (await lookupComponents(['Tabs', 'Accordion'])).text;
    expect(tabs).toContain('- AccordionItem = { key: string; header: string; content: string; disabled?: boolean }');
    expect(tabs.split('Types the props use:').slice(1).join('')).not.toMatch(/ReactNode/);
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
