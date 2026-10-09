/**
 * A child that fails where it began is stepped over.
 *
 * Inside an element the parser recovers from a failure by skipping to the
 * next place a child can start: a tag, a block, `{` or text. Text and `{`
 * are also places a child can fail without having consumed anything, and
 * then the recovery point is the token that has just failed. It was read
 * again, failed again, and so on until memory ran out: one text token whose
 * node could not be made took the tab, the editor's preview or the test run
 * with it. (What made a text node fail was `&#99999999;`, which no longer
 * does; nothing else is known to, and this holds the loop itself.)
 */
import { describe, expect, it, vi } from 'vitest';

/** How often the stand-in fails before it gives in, so a parser that retries is seen to, not waited for. */
const STUBBORN = 50;
let failures = 0;

vi.mock('../src/parser/ast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/parser/ast')>();
  return {
    ...actual,
    createTextNode: (content: string, loc: Parameters<typeof actual.createTextNode>[1]) => {
      if (content.includes('boom') && failures < STUBBORN) {
        failures++;
        throw new Error('no node for this text');
      }
      return actual.createTextNode(content, loc);
    },
  };
});

const { parse } = await import('../src/parser/parser');

describe('a child that cannot be read', () => {
  it.each([
    ['in an element', '<Stack>boom<Text>after</Text></Stack>'],
    ['in a block in an element', '<Stack>#if (ok)\n  boom\n#end<Text>after</Text></Stack>'],
    ['in a loop in an element', '<Stack>#each (n in 3)\n  boom\n#empty\n  none\n#end<Text>after</Text></Stack>'],
  ])('%s is given up on and the rest is read', (_where, source) => {
    failures = 0;
    const doc = parse(source);
    // Once where it failed; inside a block once more, when the element takes
    // up again at the token the block stopped on. Never a third time.
    expect(failures).toBeLessThanOrEqual(2);
    expect(new Set((doc.diagnostics ?? []).map((d) => d.message))).toEqual(new Set(['no node for this text']));
    expect(doc.diagnostics).toHaveLength(failures);
    // What follows the failure is still in the tree.
    expect(JSON.stringify(doc.template)).toContain('"content":"after"');
  });
});
