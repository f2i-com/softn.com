/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsPanel } from '../src/components/panels/SettingsPanel';
import { useAIStore } from '../src/stores/aiStore';
import { persistGlobalSettings } from '../src/lib/projectSession';
import { loadGlobalSettings } from '../src/lib/persistence';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useAIStore.setState({ maxIterations: 15, tokenBudget: 50_000, requestTimeoutMs: 120_000, maxOutputTokens: 16_384,
    providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: 'test-only', modelId: 'test' }], activeProviderId: 'local',
    modelProfile: { architect: '', builder: '', repair: '', vision: '' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SettingsPanel />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.clear(); });

function change(input: HTMLInputElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('editing AI limits', () => {
  it.each([
    ['studio-max-iterations', 'maxIterations', '25', 25],
    ['studio-token-budget', 'tokenBudget', '25000', 25_000],
    ['studio-request-timeout', 'requestTimeoutMs', '30', 30_000],
    ['studio-max-output-tokens', 'maxOutputTokens', '8192', 8_192],
  ] as const)('lets a person replace %s one digit at a time, committing on blur', (id, key, text, expected) => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(container.querySelector(`label[for="${id}"]`)).toBeTruthy();
    const original = useAIStore.getState()[key];
    act(() => input.focus());
    change(input, '');
    expect(input.value).toBe('');
    for (let end = 1; end <= text.length; end++) {
      change(input, text.slice(0, end));
      expect(input.value).toBe(text.slice(0, end));
      expect(useAIStore.getState()[key]).toBe(original);
    }
    act(() => input.blur());
    expect(useAIStore.getState()[key]).toBe(expected);
    expect(persistGlobalSettings()).toEqual({ ok: true });
    expect(loadGlobalSettings()?.[key]).toBe(expected);
    expect(loadGlobalSettings()?.providers[0].apiKey).toBe('test-only');
  });

  it('restores an empty field on blur and cancels an edit with Escape', () => {
    const input = container.querySelector<HTMLInputElement>('#studio-token-budget')!;
    act(() => input.focus());
    change(input, '');
    act(() => input.blur());
    expect(input.value).toBe('50000');
    act(() => input.focus());
    change(input, '123');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(input.value).toBe('50000');
    act(() => input.blur());
    expect(useAIStore.getState().tokenBudget).toBe(50_000);
  });

  it('normalizes a completed decimal on Enter and caps an out-of-range value on blur', () => {
    const input = container.querySelector<HTMLInputElement>('#studio-max-iterations')!;
    act(() => input.focus());
    change(input, '22.8');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(input.value).toBe('22');
    expect(useAIStore.getState().maxIterations).toBe(22);
    act(() => input.focus());
    change(input, '999');
    act(() => input.blur());
    expect(input.value).toBe('100');
  });

  it('keeps nonfinite and fractional store updates from invalidating saved providers', () => {
    for (const value of [NaN, Infinity, -Infinity, -10, 1.5, 99_999_999.5]) {
      act(() => { useAIStore.getState().setMaxIterations(value); useAIStore.getState().setTokenBudget(value); });
      const { maxIterations, tokenBudget } = useAIStore.getState();
      expect(Number.isInteger(maxIterations)).toBe(true);
      expect(maxIterations).toBeGreaterThanOrEqual(1);
      expect(maxIterations).toBeLessThanOrEqual(100);
      expect(Number.isInteger(tokenBudget)).toBe(true);
      expect(tokenBudget).toBeGreaterThanOrEqual(1000);
      expect(tokenBudget).toBeLessThanOrEqual(1_000_000);
      persistGlobalSettings();
      expect(loadGlobalSettings()?.providers[0].apiKey).toBe('test-only');
    }
  });
});
