/**
 * An app drawn by SoftNRenderer that a test hands newer versions of, by its
 * props as an editor's preview does or through a LiveApp, and asks what
 * became of each.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SoftNRenderer, type SoftNRendererProps } from '../../src/loader/SoftNRenderer';
import type { AppUpdateResult } from '../../src/runtime/live-app';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LivePage {
  container: HTMLElement;
  /** What the renderer answered, in order (`onUpdate`). */
  results: AppUpdateResult[];
  /** Draw again with these props over the ones it has. */
  set(props: Partial<SoftNRendererProps>): Promise<void>;
  /** The text of the first element matching `selector`, or null. */
  text(selector: string): string | null;
  click(selector: string): Promise<void>;
  /** Wait until `selector` reads `text`; fails with what it read instead. */
  reads(selector: string, text: string): Promise<void>;
  /** The next answer not handed out yet, waited for if it has not come. */
  answer(): Promise<AppUpdateResult>;
  settle(ms?: number): Promise<void>;
  unmount(): Promise<void>;
}

export async function drawLivePage(props: SoftNRendererProps): Promise<LivePage> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const results: AppUpdateResult[] = [];
  let heard = 0;
  let current: SoftNRendererProps = { failureNotices: true, ...props, onUpdate: (result) => results.push(result) };
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<SoftNRenderer {...current} />);
  });
  const settle = async (ms = 20) => {
    await act(async () => {
      await sleep(ms);
    });
  };
  const page: LivePage = {
    container,
    results,
    set: async (next) => {
      current = { ...current, ...next };
      await act(async () => {
        root!.render(<SoftNRenderer {...current} />);
      });
    },
    text: (selector) => container.querySelector(selector)?.textContent ?? null,
    click: async (selector) => {
      const element = container.querySelector(selector);
      if (!element) throw new Error(`nothing matches ${selector}`);
      await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await sleep(15);
      });
    },
    reads: async (selector, text) => {
      for (let i = 0; i < 200; i++) {
        if (page.text(selector) === text) return;
        await settle(15);
      }
      throw new Error(
        `${selector} reads ${JSON.stringify(page.text(selector))}, not ${JSON.stringify(text)}; the page is ${container.innerHTML.slice(0, 600)}`
      );
    },
    answer: async () => {
      // The first answer not handed out yet: it may have come while the
      // props were being set.
      for (let i = 0; i < 200; i++) {
        if (results.length > heard) return results[heard++];
        await settle(15);
      }
      throw new Error(`the renderer answered nothing; the page is ${container.innerHTML.slice(0, 600)}`);
    },
    settle,
    unmount: async () => {
      const mounted = root;
      root = null;
      if (mounted) await act(async () => mounted.unmount());
      container.remove();
    },
  };
  return page;
}
