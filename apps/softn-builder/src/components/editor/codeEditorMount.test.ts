// @vitest-environment jsdom
/**
 * A value that changes while Monaco is still loading reaches the editor.
 * Opening a project replaces the logic the dock was created with; the editor
 * used to mount with the first value, show the previous project's logic, and
 * write it back over the opened file on the first keystroke.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

let mountHandler: ((editor: unknown, monaco: unknown) => void) | undefined;
let createdWith: string | undefined;

vi.mock('./monacoSetup', () => ({}));
vi.mock('@monaco-editor/react', () => ({
  default: (props: { value: string; onMount: (editor: unknown, monaco: unknown) => void }) => {
    // The real component creates its editor once, from the value it first saw.
    createdWith ??= props.value;
    mountHandler = props.onMount;
    return null;
  },
}));

import { CodeEditor } from './CodeEditor';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('the code editor', () => {
  it('shows the latest value when Monaco finishes loading after it changed', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(React.createElement(CodeEditor, { value: 'let count = 0' })));
    act(() => root.render(React.createElement(CodeEditor, { value: 'let title = ""' })));

    let shown = createdWith!;
    const editor = {
      getValue: () => shown,
      setValue: (next: string) => { shown = next; },
      updateOptions: () => {},
    };
    act(() => mountHandler!(editor, { languages: { register: () => {}, setMonarchTokensProvider: () => {} } }));
    expect(shown).toBe('let title = ""');
    act(() => root.unmount());
  });
});
