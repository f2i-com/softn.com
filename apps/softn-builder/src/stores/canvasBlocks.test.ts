/**
 * Control-flow blocks are edited on the canvas, not only read from source.
 *
 * Since BLD-03 a block has been a node of the visual model with its branch
 * as children, but nothing on the canvas could make, fill or extend one:
 * the canvas asked the component registry whether an element takes
 * children, the registry has no entry for `#if`, and so a block showed a
 * notice and its branch could not be dropped into. These tests pin the
 * store operations behind the new surfaces — wrap an element in a block,
 * add an alternate branch, drop into a branch, unwrap — through what
 * generateSource writes for them, and that undo restores the structure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import { useHistoryStore } from './historyStore';
import { parseSource } from '../utils/sourceParser';
import { generateSource } from '../utils/sourceGenerator';
import { canDropInto, defaultBlock } from '../utils/blocks';

const SOURCE = `<App>
  <Stack>
    <Text>Hello</Text>
    <Button>Go</Button>
  </Stack>
</App>
`;

function canvas() {
  return useCanvasStore.getState();
}

function source(): string {
  return generateSource(canvas().elements, canvas().rootId, '');
}

function find(type: string, text?: string): string {
  const match = [...canvas().elements.values()].find(
    (el) => el.componentType === type && (text === undefined || el.props.children === text)
  );
  if (!match) throw new Error(`no ${type} element`);
  return match.id;
}

/** Push the current canvas, as every editing surface does before it mutates. */
function checkpoint(): void {
  useHistoryStore.getState().push(canvas().elements, canvas().rootId);
}

function undo(): void {
  const entry = useHistoryStore.getState().undo({
    elements: canvas().elements,
    rootId: canvas().rootId,
    timestamp: Date.now(),
  });
  expect(entry).toBeTruthy();
  canvas().loadState(entry!.elements, entry!.rootId);
}

beforeEach(() => {
  canvas().reset();
  useHistoryStore.getState().clear();
  const parsed = parseSource(SOURCE);
  canvas().loadState(new Map(parsed.elements), parsed.rootId);
});

describe('wrapping an element in a block', () => {
  it('puts an #if around it, in its place, and writes it back as a block', () => {
    const text = find('Text', 'Hello');
    const blockId = canvas().wrapElement(text, 'if');
    expect(blockId).toBeTruthy();
    expect(canvas().elements.get(blockId!)?.block).toEqual({ kind: 'if', condition: 'true' });
    expect(source()).toBe(`<App>
  <Stack>
    #if (true)
      <Text>Hello</Text>
    #end
    <Button>Go</Button>
  </Stack>
</App>`);
  });

  it('puts an #each around it with a placeholder loop header', () => {
    canvas().wrapElement(find('Button'), 'each');
    expect(source()).toContain('#each (item in items)\n      <Button>Go</Button>\n    #end');
  });

  it('is undone as one step, structure and all', () => {
    const before = source();
    checkpoint();
    canvas().wrapElement(find('Text', 'Hello'), 'if');
    expect(source()).not.toBe(before);
    undo();
    expect(source()).toBe(before);
    expect([...canvas().elements.values()].some((el) => el.block)).toBe(false);
  });

  it('refuses the root and a continuation branch', () => {
    expect(canvas().wrapElement(canvas().rootId, 'if')).toBeNull();
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const elseId = canvas().addBlockBranch(ifId, 'else')!;
    expect(canvas().wrapElement(elseId, 'if')).toBeNull();
  });
});

describe('the condition of a block', () => {
  it('is edited on the block and printed in its header', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    canvas().updateElement(ifId, { block: { kind: 'if', condition: 'items.length > 0' } });
    expect(source()).toContain('#if (items.length > 0)');
    const parsed = parseSource(source());
    const block = [...parsed.elements.values()].find((el) => el.componentType === '#if');
    expect(block?.block?.condition).toBe('items.length > 0');
  });
});

describe('alternate branches', () => {
  it('adds an #else to an #if and an #empty to an #each, once each', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    expect(canvas().addBlockBranch(ifId, 'else')).toBeTruthy();
    expect(canvas().addBlockBranch(ifId, 'else')).toBeNull();
    expect(canvas().addBlockBranch(ifId, 'empty')).toBeNull();

    const eachId = canvas().wrapElement(find('Button'), 'each')!;
    expect(canvas().addBlockBranch(eachId, 'empty')).toBeTruthy();
    expect(canvas().addBlockBranch(eachId, 'empty')).toBeNull();
    expect(canvas().addBlockBranch(eachId, 'else')).toBeNull();

    expect(source()).toBe(`<App>
  <Stack>
    #if (true)
      <Text>Hello</Text>
    #else
    #end
    #each (item in items)
      <Button>Go</Button>
    #empty
    #end
  </Stack>
</App>`);
  });

  it('keeps an #elseif before the #else however they were added', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    canvas().addBlockBranch(ifId, 'else');
    const elseifId = canvas().addBlockBranch(ifId, 'elseif')!;
    canvas().updateElement(elseifId, { block: { kind: 'elseif', condition: 'other' } });
    const out = source();
    expect(out.indexOf('#elseif (other)')).toBeLessThan(out.indexOf('#else\n'));
    expect((out.match(/#end/g) ?? []).length).toBe(1);
  });

  it('are filled by dropping into them, and removed with their contents', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const elseId = canvas().addBlockBranch(ifId, 'else')!;
    canvas().addElement('Text', elseId);
    canvas().updateElementProps(canvas().selectedIds[0], { children: 'Otherwise' });
    expect(source()).toContain('#else\n      <Text>Otherwise</Text>\n    #end');

    checkpoint();
    canvas().deleteElement(elseId);
    expect(source()).not.toContain('#else');
    expect(source()).not.toContain('Otherwise');
    undo();
    expect(source()).toContain('#else\n      <Text>Otherwise</Text>\n    #end');
  });
});

describe('dropping into a block', () => {
  it('is allowed for components and blocks, never for a continuation', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const block = canvas().elements.get(ifId)!;
    expect(canDropInto(block, 'Button')).toBe(true);
    expect(canDropInto(block, '#each')).toBe(true);
    expect(canDropInto(block, '#else')).toBe(false);
    expect(canDropInto(block, '#empty')).toBe(false);
    // A registered leaf (Image takes no children) is still a leaf.
    const imageId = canvas().addElement('Image', find('Stack'));
    expect(canDropInto(canvas().elements.get(imageId)!, 'Button')).toBe(false);
  });

  it('adds a palette block with a header, so it prints as a valid block', () => {
    expect(defaultBlock('#if')).toEqual({ kind: 'if', condition: 'true' });
    expect(defaultBlock('Text')).toBeUndefined();
    const stack = find('Stack');
    const eachId = canvas().addElement('#each', stack, 0);
    canvas().addElement('Text', eachId);
    expect(source()).toContain('#each (item in items)\n      <Text />\n    #end');
    expect(parseSource(source()).fidelity.lossless).toBe(true);
  });

  it('moves an existing element into a branch', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    canvas().moveElement(find('Button'), ifId, 1);
    expect(source()).toContain('#if (true)\n      <Text>Hello</Text>\n      <Button>Go</Button>\n    #end');
  });
});

describe('unwrapping a block', () => {
  it('keeps the main branch in the block’s place and drops the alternates', () => {
    const before = source();
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const elseId = canvas().addBlockBranch(ifId, 'else')!;
    canvas().addElement('Text', elseId);
    canvas().unwrapBlock(ifId);
    expect(source()).toBe(before);
    expect(canvas().elements.has(ifId)).toBe(false);
    expect(canvas().elements.has(elseId)).toBe(false);
  });

  it('does nothing to a continuation branch', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const elseId = canvas().addBlockBranch(ifId, 'else')!;
    const before = source();
    canvas().unwrapBlock(elseId);
    expect(source()).toBe(before);
  });
});

describe('copying a block', () => {
  it('duplicates and pastes the block with its own header, not a shared one', () => {
    const ifId = canvas().wrapElement(find('Text', 'Hello'), 'if')!;
    const copyId = canvas().duplicateElement(ifId)!;
    canvas().updateElement(copyId, { block: { kind: 'if', condition: 'second' } });
    expect(canvas().elements.get(ifId)?.block?.condition).toBe('true');
    expect(canvas().elements.get(copyId)?.block?.condition).toBe('second');

    canvas().selectElement(ifId);
    canvas().copySelected();
    canvas().paste(find('Stack'));
    const pasted = canvas().elements.get(canvas().selectedIds[0])!;
    expect(pasted.block).toEqual({ kind: 'if', condition: 'true' });
    expect(pasted.block).not.toBe(canvas().elements.get(ifId)!.block);
  });
});
