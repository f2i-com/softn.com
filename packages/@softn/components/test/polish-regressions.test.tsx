import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichTextEditor } from '../src/editors/RichTextEditor';
import { Slider } from '../src/form/Slider';
import { SmartCards } from '../src/smart/SmartCards';
import { SmartGrid } from '../src/smart/SmartGrid';
import { SmartList } from '../src/smart/SmartList';
import { Tooltip } from '../src/utility/Tooltip';
import { click, mount } from './dom';

function pointerEvent(type: string, pointerId: number, clientX: number, button = 0): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event as PointerEvent;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Slider value settlement', () => {
  it('anchors steps to min like a native range input', () => {
    const onChange = vi.fn();
    const { container } = mount(
      <Slider value={1} min={1} max={9} step={2} ariaLabel="Volume" onChange={onChange} />
    );
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;

    expect(slider.getAttribute('aria-label')).toBe('Volume');
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('reports the final pointer value even when a controlled parent has not rerendered', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container } = mount(
      <Slider value={0} min={0} max={100} step={10} onChange={onChange} onChangeEnd={onChangeEnd} />
    );
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    const track = slider.parentElement as HTMLDivElement;
    track.getBoundingClientRect = () => ({
      left: 0,
      right: 100,
      width: 100,
      top: 0,
      bottom: 10,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      slider.dispatchEvent(pointerEvent('pointerdown', 1, 20));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(slider);
    act(() => {
      document.dispatchEvent(pointerEvent('pointermove', 1, 80));
      document.dispatchEvent(pointerEvent('pointerup', 1, 80));
    });

    expect(onChangeEnd).toHaveBeenCalledWith(80);
  });

  it('ignores secondary pointers and ends cleanly when the active pointer is cancelled', () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    const { container } = mount(
      <Slider value={0} min={0} max={100} step={10} onChange={onChange} onChangeEnd={onChangeEnd} />
    );
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    const track = slider.parentElement as HTMLDivElement;
    track.getBoundingClientRect = () => ({
      left: 0,
      right: 100,
      width: 100,
      top: 0,
      bottom: 10,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    track.setPointerCapture = setPointerCapture;
    track.hasPointerCapture = () => true;
    track.releasePointerCapture = releasePointerCapture;

    act(() => {
      slider.dispatchEvent(pointerEvent('pointerdown', 11, 20));
    });
    expect(setPointerCapture).toHaveBeenCalledWith(11);
    expect(onChange).toHaveBeenLastCalledWith(20);

    act(() => {
      slider.dispatchEvent(pointerEvent('pointerdown', 22, 90));
      document.dispatchEvent(pointerEvent('pointermove', 22, 90));
      document.dispatchEvent(pointerEvent('pointerup', 22, 90));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(pointerEvent('pointermove', 11, 60));
      document.dispatchEvent(pointerEvent('pointercancel', 11, 60));
    });
    expect(onChange).toHaveBeenLastCalledWith(60);
    expect(onChangeEnd).toHaveBeenCalledOnce();
    expect(onChangeEnd).toHaveBeenCalledWith(60);
    expect(releasePointerCapture).toHaveBeenCalledWith(11);

    act(() => {
      document.dispatchEvent(pointerEvent('pointermove', 11, 100));
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('releases an active pointer on unmount without committing a cancelled drag', () => {
    const onChangeEnd = vi.fn();
    const view = mount(<Slider value={0} min={0} max={100} onChangeEnd={onChangeEnd} />);
    const slider = view.container.querySelector<HTMLElement>('[role="slider"]')!;
    const track = slider.parentElement as HTMLDivElement;
    track.getBoundingClientRect = () => ({
      left: 0,
      right: 100,
      width: 100,
      top: 0,
      bottom: 10,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    track.setPointerCapture = vi.fn();
    track.hasPointerCapture = () => true;
    const releasePointerCapture = vi.fn();
    track.releasePointerCapture = releasePointerCapture;

    act(() => slider.dispatchEvent(pointerEvent('pointerdown', 31, 50)));
    view.unmount();

    expect(releasePointerCapture).toHaveBeenCalledWith(31);
    expect(onChangeEnd).not.toHaveBeenCalled();
  });
});

describe('RichTextEditor input boundary', () => {
  it('treats formatting-only initial markup as empty and exposes textbox semantics', () => {
    const { container } = mount(
      <RichTextEditor defaultValue="<p><br></p>" ariaLabel="Article body" showToolbar={false} />
    );
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;

    expect(editor.getAttribute('aria-label')).toBe('Article body');
    expect(editor.getAttribute('aria-multiline')).toBe('true');
    expect(container.textContent).toContain('Start writing...');
  });

  it('sanitizes pasted markup before updating the DOM or notifying the caller', () => {
    const onChange = vi.fn();
    const { container } = mount(<RichTextEditor onChange={onChange} showToolbar={false} />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!;
    editor.innerHTML = '<p onclick="alert(1)">Safe text</p><script>alert(2)</script>';

    act(() => {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    const emitted = onChange.mock.lastCall?.[0] as string;
    expect(emitted).toContain('Safe text');
    expect(emitted).not.toMatch(/onclick|script|alert\(2\)/i);
    expect(editor.innerHTML).toBe(emitted);
  });
});

describe('keyboard access to smart collections', () => {
  const rows = [{ id: 'one', name: 'One' }];

  it('activates SmartCards and SmartList items with the keyboard', () => {
    const onCardSelect = vi.fn();
    const onListSelect = vi.fn();
    const cards = mount(<SmartCards data={rows} onSelect={onCardSelect} />);
    const list = mount(<SmartList data={rows} onSelect={onListSelect} />);

    const card = cards.container.querySelector<HTMLElement>('[role="button"]')!;
    const listItem = list.container.querySelector<HTMLElement>('[role="button"]')!;
    act(() => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      listItem.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(onCardSelect).toHaveBeenCalledWith(rows[0]);
    expect(onListSelect).toHaveBeenCalledWith(rows[0]);
  });

  it('does not advertise disabled SmartCards selection', () => {
    const onSelect = vi.fn();
    const { container } = mount(<SmartCards data={rows} selectable={false} onSelect={onSelect} />);
    const card =
      container.querySelector('.softn-cards-grid-r0 > div') ??
      container.querySelector('[class^="softn-cards-grid-"] > div');

    expect(card?.getAttribute('role')).toBeNull();
    click(card);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('gives separate SmartCards instances isolated responsive selectors', () => {
    const { container } = mount(
      <>
        <SmartCards data={rows} columns={{ sm: 1, md: 2, lg: 3 }} />
        <SmartCards data={rows} columns={{ sm: 2, md: 3, lg: 4 }} />
      </>
    );
    const grids = container.querySelectorAll<HTMLElement>('[class^="softn-cards-grid-"]');

    expect(grids).toHaveLength(2);
    expect(grids[0].className).not.toBe(grids[1].className);
  });

  it('sorts and selects SmartGrid rows from the keyboard', () => {
    const onSelect = vi.fn();
    const { container } = mount(
      <SmartGrid data={rows} columns="name" sortable onSelect={onSelect} />
    );
    const header = container.querySelector<HTMLElement>('th')!;
    const row = container.querySelector<HTMLElement>('tbody tr')!;

    act(() => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(onSelect).toHaveBeenCalledWith(rows[0]);
  });
});

describe('Tooltip trigger semantics', () => {
  it('associates visible content and leaves interactive clicks open', () => {
    const inside = vi.fn();
    const { container } = mount(
      <Tooltip trigger="click" interactive content={<button onClick={inside}>Inside</button>}>
        <button>Help</button>
      </Tooltip>
    );
    const trigger = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Help'
    )!;

    click(trigger);
    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');

    click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Inside'
      )
    );
    expect(inside).toHaveBeenCalledOnce();
    expect(tooltip.getAttribute('aria-hidden')).toBe('false');
  });

  it('cancels delayed opening when disabled', () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    const view = mount(
      <Tooltip trigger="hover" showDelay={100} content="Details" onOpenChange={onOpenChange}>
        <button>Help</button>
      </Tooltip>
    );
    const trigger = view.container.querySelector('button')!;

    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
    });
    view.rerender(
      <Tooltip
        disabled
        trigger="hover"
        showDelay={100}
        content="Details"
        onOpenChange={onOpenChange}
      >
        <button>Help</button>
      </Tooltip>
    );
    act(() => vi.advanceTimersByTime(200));

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="tooltip"]')?.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });
});
