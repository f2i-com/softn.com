/**
 * Two ways the publish page published what the visitor no longer meant to.
 *
 * - Start over, pressed while a batch was uploading, cleared the rows and
 *   left the loop running over the batch it had captured: every bundle still
 *   to go was published anyway, with nothing on screen to say so. It now
 *   stops after the upload in flight, and the rows say which went live.
 * - "Publish another" only dropped the success screen. The form behind it
 *   still held the last file, its fields and the app it remixed, so one more
 *   press published the same bundle a second time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strToU8, zipSync } from 'fflate';
import type { AppDetail, Published, PublishFields } from '../src/lib/api';

const { getApp, publish } = vi.hoisted(() => ({ getApp: vi.fn(), publish: vi.fn() }));
vi.mock('../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api')),
  getApp,
  publish,
}));

import { PublishPage } from '../src/pages/PublishPage';
import { useRoute } from '../src/lib/router';
import { stashDroppedBundles, takeDroppedBundles } from '../src/lib/dropped';
import { savedKeys } from '../src/lib/keyStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATEGORIES = [{ id: 'games', name: 'Games', emoji: '🎮', description: '', apps: 1, suggested: false, status: 'approved' }];

function bundleFile(name: string): File {
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ name, version: '1.0.0', description: `${name} does things`, main: 'ui/main.ui' }), true),
    'ui/main.ui': strToU8('<App/>', true),
  });
  return new File([bytes as BlobPart], `${name.toLowerCase()}.softn`, { type: 'application/zip' });
}

function published(slug: string): Published {
  return {
    app: { slug, name: slug, category: 'games', urls: { page: `/app/${slug}`, run: `/play/${slug}` } } as unknown as Published['app'],
    editKey: slug.charCodeAt(0).toString(16).padStart(2, '0').repeat(20),
    page: `/app/${slug}`,
  };
}

/** The page as the app mounts it: with the route the address bar has. */
function Harness(): React.ReactElement {
  const route = useRoute();
  return <PublishPage route={route} categories={CATEGORIES} onCategories={() => {}} categoriesError={null} onRetryCategories={() => {}} />;
}

let container: HTMLElement;
let root: Root;

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(path = '/publish'): void {
  window.history.replaceState({}, '', path);
  act(() => root.render(<Harness />));
}

const pick = (files: File[]) => {
  const input = container.querySelector<HTMLInputElement>('.dropzone input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const button = (text: string | RegExp) =>
  [...container.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')].find((b) => (typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? '')));
const statuses = () => [...container.querySelectorAll('.batch-item .batch-status')].map((s) => s.textContent);

beforeEach(() => {
  localStorage.clear();
  takeDroppedBundles();
  getApp.mockReset();
  getApp.mockRejectedValue(new Error('not in this test'));
  publish.mockReset();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  // jsdom's File has no arrayBuffer(); FileReader does the job.
  Object.defineProperty(File.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: File) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (File.prototype as unknown as { arrayBuffer?: unknown }).arrayBuffer;
  window.history.replaceState({}, '', '/');
});

describe('a batch stopped part way', () => {
  async function startBatch(): Promise<Array<(r: Published) => void>> {
    const finishers: Array<(r: Published) => void> = [];
    publish.mockImplementation(() => new Promise<Published>((resolve) => finishers.push(resolve)));
    mount();
    pick([bundleFile('One'), bundleFile('Two'), bundleFile('Three')]);
    await settle();
    expect(statuses()).toEqual(['ready', 'ready', 'ready']);
    choose(container.querySelector<HTMLSelectElement>('.batch-list ~ form select')!, 'games');
    await act(async () => {
      (button('Publish 3 apps') as HTMLButtonElement).click();
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['publishing…', 'ready', 'ready']);
    return finishers;
  }

  it('publishes nothing after Start over but the upload already in flight, and says which went live', async () => {
    const finishers = await startBatch();
    const stop = button('Stop after this upload') as HTMLButtonElement;
    expect(stop).toBeDefined();
    act(() => stop.click());
    expect(button('Stopping after this upload…')?.hasAttribute('disabled')).toBe(true);

    await act(async () => finishers[0](published('one')));
    await settle();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['live', 'not published', 'not published']);
    expect(container.querySelector('h1')?.textContent).toBe('1 app is live.');
    const rows = [...container.querySelectorAll('.batch-item')];
    expect(rows[0].textContent).toContain('/app/one');
    expect(rows[0].textContent).toContain(published('one').editKey);
    expect(rows[1].textContent).toContain('stopped before its turn');
    // The key of the one that went live is kept, as for any other.
    expect(Object.keys(savedKeys())).toEqual(['one']);

    // Only now does the button start over.
    act(() => (button('Publish more') as HTMLButtonElement).click());
    expect(container.querySelector('.batch-list')).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('runs to the end when nobody stops it', async () => {
    const finishers = await startBatch();
    await act(async () => finishers[0](published('one')));
    await settle();
    await act(async () => finishers[1](published('two')));
    await settle();
    await act(async () => finishers[2](published('three')));
    await settle();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(statuses()).toEqual(['live', 'live', 'live']);
  });

  it('does not let a drop on the page replace the rows a publish is reporting into', async () => {
    const finishers = await startBatch();
    act(() => {
      stashDroppedBundles([bundleFile('Late')]);
    });
    await settle();
    expect(container.querySelectorAll('.batch-item').length).toBe(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/not taken/);
    await act(async () => finishers[0](published('one')));
    await settle();
    expect(statuses()).toEqual(['live', 'publishing…', 'ready']);
  });
});

describe('Publish another', () => {
  it('starts from an empty form, so one more press does not publish the same bundle again', async () => {
    publish.mockResolvedValue(published('alpha'));
    getApp.mockImplementation(async (slug: string) => {
      if (slug !== 'parent') throw new Error('not in this test');
      return { slug: 'parent', name: 'Parent', category: 'games', tags: ['retro'], urls: { page: '/app/parent' } } as unknown as AppDetail;
    });
    mount('/publish?remix=parent');
    await settle();
    expect(container.textContent).toContain('Remix of');

    pick([bundleFile('Alpha')]);
    await settle();
    const nameField = () => container.querySelector<HTMLInputElement>('input[placeholder="What it is called"]')!;
    expect(nameField().value).toBe('Alpha');
    const submit = () => container.querySelector<HTMLButtonElement>('form.publish-form button[type="submit"]')!;
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await settle();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0][0] as PublishFields).parent).toBe('parent');
    expect(container.querySelector('h1')?.textContent).toBe('alpha is live.');
    // The category is named, not given by its id.
    expect(container.querySelector('.band-sub')?.textContent).toContain('under Games,');

    await act(async () => (button('Publish another') as HTMLAnchorElement).click());
    await settle();
    expect(window.location.pathname + window.location.search).toBe('/publish');
    expect(container.querySelector('h1')?.textContent).toBe('Put an app in the directory');
    expect(nameField().value).toBe('');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    expect(container.querySelector<HTMLSelectElement>('form.publish-form select')?.value).toBe('');
    expect(container.querySelector('.dropzone')?.textContent).toContain('Drop .softn files here');
    expect(container.textContent).not.toContain('Remix of');
    expect(submit().disabled).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
