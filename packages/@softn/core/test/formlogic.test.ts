/**
 * FormLogic Integration Tests
 *
 * With the WASM engine, jsToFormLogic/formLogicToJS are no longer needed —
 * the WASM adapter returns plain JS values directly. These tests verify
 * the SoftNScriptRuntime API with the WASM backend.
 */

import { describe, it, expect } from 'vitest';
import {
  createScriptRuntime,
  createMockXDBModule,
  createMockNavModule,
  createConsoleModule,
  type FormLogicContext,
} from '../src/runtime/formlogic';
import type { ScriptBlock } from '../src/parser/ast';

describe('FormLogic Bridge', () => {
  describe('SoftNScriptRuntime', () => {
    it('should load script state, functions, and computed values', async () => {
      const script: ScriptBlock = {
        type: 'ScriptBlock',
        code: `
          let counter = 0;
          let name = "test";

          function increment() {
            counter = counter + 1;
          }
        `,
        loc: { line: 1, column: 0, start: 0, end: 200 },
      };

      const contextState: Record<string, unknown> = {};
      const context: FormLogicContext = {
        state: contextState,
        setState: (path: string, value: unknown) => {
          contextState[path] = value;
        },
        data: {},
        xdb: createMockXDBModule(),
        nav: createMockNavModule(),
        console: createConsoleModule(),
      };

      const runtime = createScriptRuntime(context);
      const result = await runtime.loadScript(script);

      expect(result.state.counter).toBe(0);
      expect(result.state.name).toBe('test');
      expect(typeof result.functions.increment).toBe('function');
      expect(typeof result.syncFunctions.increment).toBe('function');

      // After calling function, state should update
      await result.functions.increment();
      expect(contextState.counter).toBe(1);
    });
  });
});
