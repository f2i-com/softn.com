// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalFocus } from './useModalFocus';

let root: Root;
let host: HTMLDivElement;
const bubbled = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  bubbled.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  function Harness() {
    const ref = useModalFocus(true, () => {});
    return React.createElement('div', { ref, role: 'dialog', 'aria-modal': true, tabIndex: -1 },
      React.createElement('button', { id: 'cancel' }, 'Cancel'),
      React.createElement('input', { id: 'name', type: 'text' }),
      React.createElement('input', { id: 'count', type: 'number' }),
      React.createElement('input', { id: 'radio', type: 'radio' }),
      React.createElement('input', { id: 'readonly', readOnly: true, value: 'Read only' }),
      React.createElement('textarea', { id: 'notes' }),
      React.createElement('select', { id: 'collection' }, React.createElement('option', null, 'Orders')),
      React.createElement('div', { contentEditable: true, suppressContentEditableWarning: true },
        React.createElement('span', { id: 'editable' }, 'Editable text')),
      React.createElement('div', { id: 'notice', tabIndex: -1 }, 'Validation notice'));
  }
  act(() => root.render(React.createElement(Harness)));
  document.addEventListener('keydown', bubbled);
});
afterEach(() => { document.removeEventListener('keydown', bubbled); act(() => root.unmount()); host.remove(); });

function key(id: string, name: string, init: KeyboardEventInit = {}) {
  const target = host.querySelector<HTMLElement>(`#${id}`)!;
  target.focus();
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

describe('modal deletion keys', () => {
  it.each(['cancel', 'radio', 'readonly', 'notice'])('blocks browser navigation and canvas deletion from %s', (id) => {
    expect(key(id, 'Backspace').defaultPrevented).toBe(true);
    expect(key(id, 'Delete').defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it.each(['name', 'count', 'notes', 'collection', 'editable'])('preserves text or selection editing in %s', (id) => {
    expect(key(id, 'Backspace').defaultPrevented).toBe(false);
    expect(key(id, 'Delete').defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(2);
  });

  it('leaves input-method composition and modified shortcuts alone', () => {
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key('cancel', 'Backspace', init).defaultPrevented).toBe(false);
    }
    expect(bubbled).toHaveBeenCalledTimes(5);
  });

  it('does not claim a deletion key dispatched outside this dialog', () => {
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
  });
});
