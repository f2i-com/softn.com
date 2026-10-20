/**
 * A tap before the script has loaded is answered once it has.
 *
 * The page is drawn as soon as it is parsed; its script's functions arrive
 * when the script has loaded, and again when it reloads (Allow rebuilds the
 * runtime). A click in between found no function and did nothing, which on a
 * slow device is the first tap after opening an app. The renderer now hands
 * the page a stand-in for each function the script declares, which waits for
 * the script and calls the real one (runtime/declared-functions.ts).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import { declaredFunctionNames, standInFunctions } from '../src/runtime/declared-functions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the functions a script declares', () => {
  it('are read from its text, in the forms a person writes them', () => {
    const js = [
      'let count = 0',
      'function bump() { count++ }',
      'async function save(x) {}',
      'const reset = () => { count = 0 }',
      'let shout = async (a, b) => a',
      'var twice = x => x * 2',
      'const old = function () {}',
      'const notAFunction = 3',
      'helper(function inner() {})',
    ].join('\n');
    expect(declaredFunctionNames(js)).toEqual(['bump', 'save', 'inner', 'reset', 'shout', 'twice', 'old']);
    expect(declaredFunctionNames('count = 0\ndef bump():\n    pass\n  async def save(x):\n    pass\n')).toEqual(['bump', 'save']);
  });

  it('stand in until the script arrives, and then call it', async () => {
    let arrive: (functions: Record<string, (...args: unknown[]) => unknown>) => void = () => {};
    const standIns = standInFunctions(['bump', 'gone'], new Promise((resolve) => { arrive = resolve; }));
    const calls: unknown[][] = [];
    const answered = standIns.bump(1, 'two');
    const missing = standIns.gone();
    arrive({ bump: (...args: unknown[]) => (calls.push(args), 'done') });
    await expect(answered).resolves.toBe('done');
    await expect(missing).resolves.toBeUndefined();
    expect(calls).toEqual([[1, 'two']]);
  });
});

describe('a tap before the script has loaded', () => {
  let root: Root | null = null;
  let container: HTMLElement;

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container?.remove();
  });

  it('is answered once it has', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const source = `<logic>
let taps = 0
function bump() { taps = taps + 1 }
</logic>
<div>
  <span id="out">{taps}</span>
  <button id="bump" @click={() => bump()}>Bump</button>
</div>`;
    act(() => {
      root = createRoot(container);
      root.render(<SoftNRenderer source={source} scriptExecutionMode="main" />);
    });
    // The page is up and the script is still loading: tap now.
    const button = container.querySelector('#bump') as HTMLElement | null;
    expect(button).not.toBeNull();
    expect(container.querySelector('#out')?.textContent ?? '').toBe('');
    act(() => button!.click());
    for (let i = 0; i < 150 && container.querySelector('#out')?.textContent !== '1'; i++) {
      await act(async () => {
        await sleep(20);
      });
    }
    expect(container.querySelector('#out')?.textContent).toBe('1');
  });
});
