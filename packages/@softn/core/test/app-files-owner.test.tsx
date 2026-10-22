/**
 * The files a person picks in an app's components (a FileChooser's) are held
 * for the app and let go when it closes. They were registered with no owner
 * and kept for the life of the page: every file picked in an app closed long
 * ago, in SoftN Web, where apps open and close in one page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { useAppScope } from '../src/loader/app-scope';
import { getDefaultRegistry } from '../src/renderer/registry';
import { getFileByRef, registerFileRef } from '../src/runtime/file-registry';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const picked: string[] = [];

function PickProbe() {
  const { filesOwner } = useAppScope();
  // What a FileChooser does with a file the person picks.
  if (picked.length === 0) picked.push(registerFileRef(new File(['hello'], 'note.txt'), filesOwner));
  return <output>{picked[0]}</output>;
}

beforeEach(() => {
  picked.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getDefaultRegistry().register('PickProbe', PickProbe);
});

afterEach(() => {
  container.remove();
});

describe('the files picked in an app', () => {
  it('are held while it is open and let go when it closes', async () => {
    await act(async () => {
      root.render(<SoftNRenderer source="<PickProbe />" appId="files-owner" scriptExecutionMode="main" />);
    });
    for (let attempt = 0; attempt < 200 && !container.querySelector('output'); attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(picked).toHaveLength(1);
    expect(getFileByRef(picked[0])?.name).toBe('note.txt');

    await act(async () => root.unmount());
    expect(getFileByRef(picked[0])).toBeUndefined();
  });
});
