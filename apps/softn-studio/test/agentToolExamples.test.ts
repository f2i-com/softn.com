/**
 * The examples a tool's description gives are ones the tool can answer.
 *
 * A model copies the example it is shown. read_docs showed
 * "language-support#state": a guide that has no such section, so the copy
 * came back as an error, and a guide about Python logic, which a JavaScript
 * project's prompt is careful never to mention (logicLanguage.test.tsx) and
 * whose index does not list it.
 */

import { describe, expect, it } from 'vitest';
import { docIndexText, readDocs } from '../src/lib/agent/knowledge';
import { AGENT_TOOLS } from '../src/lib/agent/tools';

/** Every quoted guide slug, with or without a section, in a description. */
function topicsIn(description: string): string[] {
  return [...description.matchAll(/"([a-z][a-z0-9-]*(?:#[a-z0-9-]+)?)"/g)].map((match) => match[1]);
}

describe('the read_docs tool', () => {
  const spec = AGENT_TOOLS.find((tool) => tool.name === 'read_docs')!;

  it('gives as examples a guide and a section it can read, from the guides every project is offered', async () => {
    const topics = topicsIn(spec.description);
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.some((topic) => topic.includes('#'))).toBe(true);
    for (const topic of topics) {
      const answer = await readDocs(topic);
      expect(answer.ok, `${topic}: ${answer.text.slice(0, 120)}`).toBe(true);
      // The index of a JavaScript project leaves the Python guides out.
      expect(docIndexText(false)).toContain(`- ${topic.split('#')[0]}:`);
    }
  });
});
