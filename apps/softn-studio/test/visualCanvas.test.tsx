/** @vitest-environment jsdom */

import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StablePreviewSurface } from '../src/components/canvas/VisualCanvas';

describe('StablePreviewSurface', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('keeps one mounted preview child while expansion styling changes', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const root = createRoot(container);
    const Preview = () => {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <button data-testid="renderer">Runtime state</button>;
    };
    const render = (expanded: boolean) => (
      <StablePreviewSurface
        expanded={expanded}
        isMobile={false}
        label="Main"
        frameStyle={{ width: 800 }}
        chrome={<span>Chrome</span>}
        onClose={() => {}}
      >
        <Preview />
      </StablePreviewSurface>
    );

    act(() => root.render(render(false)));
    const originalRenderer = container.querySelector('[data-testid="renderer"]');
    expect(mounted).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[data-softn-preview-content="true"]')).toHaveLength(1);

    const focusOrigin = document.createElement('button');
    document.body.appendChild(focusOrigin);
    focusOrigin.focus();
    act(() => root.render(render(true)));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const closeButton = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Close expanded preview"]'
    )!;
    expect(document.activeElement).toBe(closeButton);
    expect(container.querySelector('[data-testid="renderer"]')).toBe(originalRenderer);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();

    act(() =>
      closeButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      )
    );
    expect(document.activeElement).toBe(originalRenderer);
    act(() =>
      originalRenderer!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(document.activeElement).toBe(closeButton);

    act(() => root.render(render(false)));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="renderer"]')).toBe(originalRenderer);
    expect(document.activeElement).toBe(focusOrigin);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(unmounted).toHaveBeenCalledOnce();
    focusOrigin.remove();
  });
});
