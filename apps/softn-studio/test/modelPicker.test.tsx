/** @vitest-environment jsdom */
/**
 * The model picker says why its list is empty.
 *
 * Models whose ids name another capability are left out of the list. When
 * that was every model the provider listed, the picker fell to the message
 * for a search that found nothing: No model matches “”, with a button to use
 * “” as typed, though nothing had been searched for and nothing typed.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/components/ai/ModelPicker';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const HIDDEN = [{ id: 'local-embed-small' }, { id: 'speech-tts-1' }];

describe('the model picker', () => {
  it('says every listed model was left out as not for chat, and how to choose one anyway', () => {
    const onChange = vi.fn();
    act(() => root.render(<ModelPicker label="Model" models={HIDDEN} value="" onChange={onChange} />));
    const empty = container.querySelector('.st-model-empty')!;
    expect(empty.textContent).toMatch(/^Both models this provider lists look like embedding, speech, image or moderation models, so neither is offered\./);
    expect(container.textContent).not.toMatch(/No model matches/);
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Use “” as typed');
    // The way out it names is there: showing them all lists them.
    const showAll = container.querySelector<HTMLInputElement>('.st-check input')!;
    act(() => showAll.click());
    expect([...container.querySelectorAll('.st-model-name')].map((n) => n.textContent)).toEqual(['local-embed-small', 'speech-tts-1']);
  });

  it('still says a search found nothing, in the words of the search', () => {
    act(() => root.render(<ModelPicker label="Model" models={[{ id: 'chat-one' }, ...HIDDEN]} value="" onChange={() => {}} />));
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.st-model-empty')!.textContent).toMatch(/^No model matches “zzz”\./);
  });
});
