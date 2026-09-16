/**
 * `softn.net.fetch` when the host, not the browser, makes the request.
 *
 * Some hosts never give an app the network: they route what it asks for
 * through something of their own and the app never holds a URL the browser
 * would act on. Until now the only way to arrange that was to rewrite
 * `softn.net.fetch` inside the guest, which works only while the guest is
 * JavaScript and only while the host is willing to edit the author's source.
 * `ScriptRuntimeOptions.netFetchHandler` is the same substitution made on the
 * host's side of the VM.
 *
 * Two things are load-bearing and both are checked here:
 * - the browser's `fetch` is not reached, ever, when a handler is set;
 * - the handler is reached even though `permission.json` grants nothing,
 *   because supplying one MOVES the capability. A host that routed
 *   `net.fetch` through its own backend and still had it permission-checked
 *   would have every request denied — which is exactly what happens on the
 *   line below when the handler is absent.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoftNRenderer } from '../src/loader/SoftNRenderer';
import type { ScriptBlock } from '../src/parser/ast';
import {
  createConsoleModule,
  createHostCallExecutor,
  createMockNavModule,
  createMockXDBModule,
  createScriptRuntime,
  type NetFetchHandler,
  type ScriptContext,
} from '../src/runtime/script-runtime';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeContext(): ScriptContext {
  const state: Record<string, unknown> = {};
  return {
    state,
    setState: (path, value) => {
      state[path] = value;
    },
    data: {},
    xdb: createMockXDBModule(),
    nav: createMockNavModule(),
    console: createConsoleModule(),
  };
}

/** A handler that records what it was asked for and answers a fixed response. */
function recordingHandler() {
  const seen: Array<{ url: string; options: Record<string, unknown> }> = [];
  const handler: NetFetchHandler = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } };
  };
  return { seen, handler };
}

/** A `fetch` that fails the test the moment anything reaches it. */
function forbidFetch() {
  const fetchSpy = vi.fn(async () => {
    throw new Error('the browser fetch must not be reached');
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Nothing is granted: the shape a hosted app is actually run with. */
const NOTHING_GRANTED = { permissions: {} };

const call = (url: string, optionsJson?: string) => ({
  id: 1,
  kind: 'net.fetch',
  args: optionsJson === undefined ? [url] : [url, optionsJson],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a host-supplied net.fetch handler', () => {
  it('answers the host call instead of the browser, with nothing granted', async () => {
    const fetchSpy = forbidFetch();
    const { seen, handler } = recordingHandler();
    const executor = createHostCallExecutor(makeContext(), undefined, 'net-handler-test', undefined, undefined, {
      permissionConfig: NOTHING_GRANTED,
      netFetchHandler: handler,
    });

    const answer = await executor.executeHostCall(
      call('https://api.test/data', JSON.stringify({ method: 'POST', body: 'a=1' }))
    );

    expect(answer).toEqual({
      ok: true,
      status: 200,
      body: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    });
    // The script's options object arrives parsed, as the browser path sees it.
    expect(seen).toEqual([{ url: 'https://api.test/data', options: { method: 'POST', body: 'a=1' } }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    executor.cleanup();
  });

  it('is what the absence of the handler proves: the same call is refused', async () => {
    const fetchSpy = forbidFetch();
    const executor = createHostCallExecutor(makeContext(), undefined, 'net-denied-test', undefined, undefined, {
      permissionConfig: NOTHING_GRANTED,
    });

    // Unchanged behaviour: no handler, no grant, no request. If the handler
    // path were permission-checked too, this is the answer it would give.
    await expect(executor.executeHostCall(call('https://api.test/data', '{}'))).rejects.toThrow(
      /permission\.json/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    executor.cleanup();
  });

  it('takes a call with no options at all', async () => {
    forbidFetch();
    const { seen, handler } = recordingHandler();
    const executor = createHostCallExecutor(makeContext(), undefined, 'net-bare-test', undefined, undefined, {
      permissionConfig: NOTHING_GRANTED,
      netFetchHandler: handler,
    });

    await executor.executeHostCall(call('https://api.test/bare'));
    await executor.executeHostCall(call('https://api.test/empty', ''));
    expect(seen.map((s) => s.options)).toEqual([{}, {}]);
    executor.cleanup();
  });

  it('reaches a script that called softn.net.fetch, answer and all', async () => {
    const fetchSpy = forbidFetch();
    const { seen, handler } = recordingHandler();
    const script: ScriptBlock = {
      type: 'ScriptBlock',
      code: `
        let answer = '';
        function load() {
          softn.net.fetch('https://api.test/data', { method: 'GET' }, function (response) {
            answer = response.status + ' ' + response.body;
          });
        }
        function readAnswer() { return answer; }
      `,
      loc: { line: 1, column: 0, start: 0, end: 0 },
    };
    const runtime = createScriptRuntime(makeContext(), undefined, 'net-script-test', undefined, undefined, {
      permissionConfig: NOTHING_GRANTED,
      netFetchHandler: handler,
    });

    const result = await runtime.loadScript(script);
    await result.functions.load();

    expect(seen).toEqual([{ url: 'https://api.test/data', options: { method: 'GET' } }]);
    expect(result.syncFunctions.readAnswer()).toBe('200 {"ok":true}');
    expect(fetchSpy).not.toHaveBeenCalled();
    runtime.cleanup();
  });
});

describe('the renderer hands its host’s handler to the runtime', () => {
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => {
        current.unmount();
      });
      root = null;
    }
  });

  it('routes a rendered app’s network call through the prop, not the browser', async () => {
    const fetchSpy = forbidFetch();
    const { seen, handler } = recordingHandler();
    const container = document.createElement('div');
    document.body.appendChild(container);
    // `_init()` is the renderer's own convention for one-time setup: it calls
    // it after the script loads, so this is the app asking for the network the
    // way a real one does.
    const source = `<logic>
function _init() {
  softn.net.fetch('https://api.test/probe', { method: 'GET' }, function () {});
}
</logic>
<div>probe</div>`;

    await act(async () => {
      root = createRoot(container);
      root.render(
        <SoftNRenderer
          source={source}
          appId="NetFetchHandlerRenderer"
          scriptExecutionMode="main"
          permissionConfig={NOTHING_GRANTED}
          netFetchHandler={handler}
        />
      );
    });
    // The host call is drained after the script loads, so let the queue run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(seen.map((s) => s.url)).toEqual(['https://api.test/probe']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
