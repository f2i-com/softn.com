/** Composition Enter confirms IME text; sanitized markup events must retain that boolean. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../src/parser';
import { ComponentRegistry, renderDocument } from '../src/renderer';
import { markupValue } from '../src/renderer/host-values';
import { extractEventProps } from '../src/runtime/event-props';
import type { SoftNProps, SoftNRenderContext } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('safe keyboard composition state', () => {
  it.each([true, false])('retains the native boolean %s without a native event or DOM reference', (isComposing) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing });
    const props = extractEventProps(event);
    expect(props.isComposing).toBe(isComposing);
    expect(Object.hasOwn(props, 'isComposing')).toBe(true);
    expect(props).not.toHaveProperty('nativeEvent');
    expect(props).not.toHaveProperty('target');
    expect(props).not.toHaveProperty('view');
  });

  it.each([
    ['missing', undefined], ['null', null], ['number', 1], ['text', 'true'],
    ['object', {}], ['boxed boolean', new Boolean(true)], ['function', () => true], ['window', window],
  ])('normalizes a non-boolean %s to false instead of carrying the value', (_name, value) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(event, 'isComposing', { value });
    expect(extractEventProps(event).isComposing).toBe(false);
  });

  it.each([true, false])('reads React nativeEvent composition %s without exposing the wrapper', (isComposing) => {
    // React's synthetic events have a class prototype. Plain records intentionally pass through.
    class ReactKeyboardEvent {
      nativeEvent = new KeyboardEvent('keydown', { key: 'Enter', isComposing });
      isComposing = !isComposing;
    }
    const record = markupValue(new ReactKeyboardEvent()) as Record<string, unknown>;
    expect(record.isComposing).toBe(isComposing);
    expect(record.nativeEvent).toBeUndefined();
    expect(record.view).toBeUndefined();
  });
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** The phone/OTP and chat arrows used by Coffee; their guards must survive the host boundary. */
const authArrow = '(event) => authSubmitKey({key:event.key,isComposing:event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)})';
const chatArrow = '(event) => vcChatKey({key:event.key,shiftKey:event.shiftKey,isComposing:event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)})';

type KeyRecord = { key?: string; isComposing?: boolean; shiftKey?: boolean };

async function mount(stage: 'phone' | 'otp' | 'chat') {
  const submit = vi.fn();
  const registry = new ComponentRegistry();
  registry.register('Input', (props: SoftNProps) => React.createElement('input', {
    id: 'field', onKeyDown: props.onKeyDown as React.KeyboardEventHandler<HTMLInputElement>,
  }));
  const context: SoftNRenderContext = {
    state: {}, setState: () => {}, data: {}, props: {}, computed: {}, asyncFunctions: {},
    functions: {
      authSubmitKey: (value: unknown) => {
        const event = value as KeyRecord;
        if (event.key === 'Enter' && !event.isComposing) submit(stage === 'phone' ? 'send-code' : 'verify-code');
      },
      vcChatKey: (value: unknown) => {
        const event = value as KeyRecord;
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) submit('send-message');
      },
    },
  };
  const source = stage === 'chat' ? `<Input onKeyDown={${chatArrow}} />`
    : `<input id="field" type="${stage === 'phone' ? 'tel' : 'text'}" onKeyDown={${authArrow}} />`;
  const document = parse(source);
  expect(document.diagnostics ?? []).toEqual([]);
  container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(renderDocument(document, context, registry) as React.ReactElement));
  return { submit, field: container.querySelector('input')! };
}

describe('composition state across real React markup callbacks', () => {
  for (const stage of ['phone', 'otp', 'chat'] as const) {
    it.each([true, false])(`${stage}: composing=%s preserves the Enter guard`, async (isComposing) => {
      const { submit, field } = await mount(stage);
      await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, isComposing,
      })));
      expect(submit).toHaveBeenCalledTimes(isComposing ? 0 : 1);
    });
  }

  it('keeps Shift+Enter and other keys from submitting chat', async () => {
    const { submit, field } = await mount('chat');
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true, isComposing: false }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, isComposing: false }));
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
