/**
 * Copying and deleting a selection that holds an element and what is
 * inside it.
 *
 * Select all selects every element, the Card and the Text inside the Card
 * alike. Copy took each selected element as something to paste, with its
 * contents, so the Text was pasted twice: inside the copy of its Card, and
 * again beside it on its own. Delete removed the Card and everything in it
 * and took only the Card out of the selection, which went on saying one
 * element was selected and showed none.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { parseSource } from '../utils/sourceParser';
import { generateSource } from '../utils/sourceGenerator';
import { useCanvasStore } from './canvasStore';

function canvas() {
  return useCanvasStore.getState();
}

function source(): string {
  return generateSource(canvas().elements, canvas().rootId!, '');
}

beforeEach(() => {
  canvas().reset();
  const parsed = parseSource('<App>\n  <Card>\n    <Text>Inside</Text>\n  </Card>\n  <Text>Beside</Text>\n</App>');
  canvas().loadState(parsed.elements, parsed.rootId);
});

describe('everything selected', () => {
  const selectAll = () => canvas().selectMultiple([...canvas().elements.keys()].filter((id) => id !== canvas().rootId));

  it('is pasted once', () => {
    selectAll();
    canvas().copySelected();
    canvas().paste(null);
    expect(source()).toBe(
      [
        '<App>',
        '  <Card>',
        '    <Text>Inside</Text>',
        '  </Card>',
        '  <Text>Beside</Text>',
        '  <Card>',
        '    <Text>Inside</Text>',
        '  </Card>',
        '  <Text>Beside</Text>',
        '</App>',
      ].join('\n')
    );
  });

  it('deleted, leaves nothing selected', () => {
    selectAll();
    for (const id of canvas().selectedIds) canvas().deleteElement(id);
    expect(source()).toBe('<App />');
    expect(canvas().selectedIds).toEqual([]);
  });
});

describe('an element deleted with something inside it selected', () => {
  it('takes that out of the selection too', () => {
    const card = [...canvas().elements.values()].find((el) => el.componentType === 'Card')!;
    const inside = [...canvas().elements.values()].find((el) => el.props.children === 'Inside')!;
    canvas().selectMultiple([inside.id]);
    canvas().deleteElement(card.id);
    expect(canvas().selectedIds).toEqual([]);
  });
});
