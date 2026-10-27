/**
 * A comment posted here is followed by the page as the server now has it.
 * Put on top of the page held, it made page 1 twenty-one long while the
 * pages stayed as they were, and page 2 began with the comment page 1 had
 * shown last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Comment } from '../src/lib/api';

const { getComments, postComment } = vi.hoisted(() => ({ getComments: vi.fn(), postComment: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getComments,
  postComment,
}));

import { Comments } from '../src/components/directory/Comments';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const comment = (n: number): Comment => ({ id: n, name: `c${n}`, body: `comment ${n}`, created: '2026-01-01T00:00:00Z' }) as unknown as Comment;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('Comments', () => {
  it('reads the page again after a post, as the server pages it', async () => {
    // Newest first, twenty a page, as the directory API answers.
    let all = Array.from({ length: 40 }, (_, i) => comment(40 - i));
    getComments.mockImplementation(async (_slug: string, page: number) => ({
      items: all.slice((page - 1) * 20, page * 20),
      pages: Math.ceil(all.length / 20),
      total: all.length,
    }));
    postComment.mockImplementation(async () => {
      const c = comment(41);
      all = [c, ...all];
      return c;
    });
    act(() => root.render(<Comments slug="snake" />));
    await settle();
    expect(container.querySelectorAll('.comments li, .comment').length).toBeGreaterThan(0);
    const textarea = container.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(textarea, 'a new one');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>('form.comment-form')!.requestSubmit();
    });
    await settle();
    expect(getComments).toHaveBeenLastCalledWith('snake', 1, expect.anything());
    const shown = container.textContent ?? '';
    expect(shown).toContain('comment 41');
    // Twenty on page 1: the one that moved to page 2 is not shown here too.
    expect(shown).not.toContain('comment 21');
    expect(shown).toContain('comment 22');
  });
});
