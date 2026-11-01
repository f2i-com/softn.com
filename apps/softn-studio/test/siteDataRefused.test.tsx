// @vitest-environment jsdom
/**
 * Studio with the browser refusing site data.
 *
 * Firefox's `new BroadcastChannel()` throws then, and it was called in an
 * effect with nothing around it: the throw took React's whole tree with it, and
 * the page was blank with nothing said. Only Firefox's constructor throws, so a
 * browser test on Chromium would not see it; the throw is stood in for here,
 * and Firefox itself was checked by hand.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBoundary } from '../src/components/common/AppBoundary';
import { startProjectAutosave } from '../src/lib/projectSession';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the autosave', () => {
  it('starts without the channel to the other tabs', () => {
    vi.stubGlobal('BroadcastChannel', class {
      constructor() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      }
    });
    const autosave = startProjectAutosave({ live: true });
    expect(() => autosave.stop()).not.toThrow();
  });
});

describe('the page', () => {
  it('says that Studio stopped, with a way back, rather than going blank', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = (): React.ReactElement => {
      throw new Error('a part of Studio could not be drawn');
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    act(() => root.render(<AppBoundary><Broken /></AppBoundary>));
    expect(element.textContent).toContain('Studio stopped');
    expect(element.textContent).toContain('a part of Studio could not be drawn');
    expect(element.querySelector('button')?.textContent).toBe('Reload Studio');
    act(() => root.unmount());
    element.remove();
  });
});
