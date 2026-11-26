/**
 * `softn.ai.getCapabilities` asks whether the page has WebGL without keeping
 * a context to do it.
 *
 * Each call made a canvas and a WebGL context and kept both. A browser keeps
 * some sixteen contexts live and, past that, takes the oldest from the page:
 * an app that asked twenty times could lose the scene it was drawing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from '../src/runtime/ai-manager';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the capability report', () => {
  it('makes one context, lets it go, and answers the same every time', async () => {
    const loseContext = vi.fn();
    const made: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      made.push(kind);
      return { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null) } as never;
    } as never);
    const answers = [];
    for (let i = 0; i < 20; i++) answers.push(await detectCapabilities());
    expect(answers.every((answer) => answer.webgl === true)).toBe(true);
    expect(made).toEqual(['webgl2']);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });
});
