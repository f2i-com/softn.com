/**
 * An edit to a page that leaves its `<data>` block as it was keeps the
 * records on screen. A host that edits an app while it runs hands the
 * renderer a new document with every change, and the data hook took a new
 * document for a new source of records: it let the records go and read them
 * again, so the page was drawn with none for a moment, each row was made
 * again, and whatever the person had typed into one was gone.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useDataBlock } from '../src/loader/xdb-bindings';
import { parse } from '../src/parser';
import { getXDB } from '../src/runtime/xdb';
import type { SoftNDocument } from '../src/parser/ast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe('the records a page reads, across an edit of the page', () => {
  it('stay while the data block is the same, wherever it now stands', async () => {
    const appId = 'render-data-block-edit';
    const xdb = getXDB(appId);
    await xdb.isReady;
    xdb.create('items', { label: 'a' });
    xdb.create('items', { label: 'b' });
    const drawn: string[] = [];
    function Probe({ document }: { document: SoftNDocument }) {
      const { data } = useDataBlock(document, appId);
      drawn.push(String(data.items?.length ?? 'none'));
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<Probe document={parse('<data><collection name="items" as="items" /></data>\n<div>one</div>')} />));
    await settle();
    expect(drawn.at(-1)).toBe('2');

    drawn.length = 0;
    // The markup changed, and the data block moved down a line.
    await act(async () =>
      root.render(<Probe document={parse('<h1>Notes</h1>\n<data><collection name="items" as="items" /></data>\n<div>two, edited</div>')} />)
    );
    await settle();
    expect(drawn).not.toContain('none');
    expect(drawn.at(-1)).toBe('2');

    // A data block that does change is read again, as it always was.
    drawn.length = 0;
    await act(async () => root.render(<Probe document={parse('<data><collection name="items" as="things" /></data>\n<div>three</div>')} />));
    await settle();
    expect(drawn.at(-1)).toBe('none');
    act(() => root.unmount());
  });
});
