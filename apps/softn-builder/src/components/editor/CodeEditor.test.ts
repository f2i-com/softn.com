// @vitest-environment jsdom
/**
 * The Builder's code editor is SoftN's own: a real text field the Source and
 * Logic views type into, coloured for the file it holds, following the value
 * it is given (opening a project replaces the logic the dock was created with)
 * and handing every edit back.
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CodeEditor, highlightLanguage } from './CodeEditor';

// The editor is a chunk of its own, fetched the first time one is drawn; it is here before the tests draw one.
beforeAll(async () => {
  await import('@softn/components/editors');
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('the code editor', () => {
  it('colours a page as markup and logic as its own language', () => {
    expect(highlightLanguage('xml')).toBe('html');
    expect(highlightLanguage('softn')).toBe('html');
    expect(highlightLanguage('javascript')).toBe('javascript');
    expect(highlightLanguage('python')).toBe('python');
    expect(highlightLanguage('cobol')).toBe('plain');
    expect(highlightLanguage(undefined)).toBe('plain');
  });

  it('shows the value it is given, follows a new one, and hands edits back', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    // The editor is fetched the first time one is drawn.
    await act(async () => root.render(React.createElement(CodeEditor, { value: 'let count = 0', onChange, language: 'javascript' })));
    const field = host.querySelector('textarea')!;
    expect(field.value).toBe('let count = 0');
    expect(host.querySelector('.bl-code-editor')).not.toBeNull();
    expect(field.getAttribute('aria-label')).toBe('Logic');

    act(() => root.render(React.createElement(CodeEditor, { value: 'let title = ""', onChange, language: 'javascript' })));
    expect(field.value).toBe('let title = ""');

    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(field, 'let title = "Hi"');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith('let title = "Hi"');
    act(() => root.unmount());
    host.remove();
  });

  it('can be read only, and names a page\'s source for a screen reader', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(React.createElement(CodeEditor, { value: '<App />', language: 'xml', readOnly: true })));
    const field = host.querySelector('textarea')!;
    expect(field.readOnly).toBe(true);
    expect(field.getAttribute('aria-label')).toBe('Page source');
    act(() => root.unmount());
  });
});
