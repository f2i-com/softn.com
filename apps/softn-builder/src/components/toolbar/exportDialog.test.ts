// @vitest-environment jsdom
/**
 * The export dialog is a dialog.
 *
 * Its overlay was a div with a click handler: no role, no name, no
 * aria-modal, Tab walked out of it into the toolbar behind, Escape was
 * handled by a window listener in App.tsx, and closing left focus on the
 * body rather than on the button that opened it. Pinned here in jsdom:
 * the semantics, Tab wrapping from the last control to the first (and
 * Shift+Tab the other way), Escape closing exactly once, and focus going
 * back to the trigger on close.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExportDialog } from './ExportDialog';
import { useProjectStore } from '../../stores/projectStore';
import { useSchemaStore } from '../../stores/schemaStore';
import { useFilesStore } from '../../stores/filesStore';
import * as bundle from '../../utils/buildProjectBundle';
import type { SaveOutcome } from '../../utils/saveProject';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root;

function render(isOpen: boolean, onClose: () => void): void {
  act(() => {
    root.render(React.createElement(ExportDialog, { isOpen, onClose }));
  });
}

function key(target: Element, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useSchemaStore.getState().reset();
  trigger = document.createElement('button');
  trigger.textContent = 'Export';
  document.body.appendChild(trigger);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  trigger.focus();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  trigger.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the export dialog', () => {
  it('has dialog semantics and a name', () => {
    render(true, () => {});
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Export, run or publish');
    for (const id of ['export-app-name', 'export-app-version', 'export-app-description']) {
      expect(container.querySelector(`label[for="${id}"]`), id).not.toBeNull();
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('moves focus in on open, wraps Tab at both ends, and never lets it leave', () => {
    render(true, () => {});
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')).filter(
      (el) => el.style.display !== 'none'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).not.toBe(last);

    last.focus();
    const tab = key(last, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const shiftTab = key(first, 'Tab', true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Trigger stays out of reach behind the dialog.
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes once on Escape, before any window-level handler sees it', () => {
    const onClose = vi.fn();
    const windowSaw = vi.fn();
    window.addEventListener('keydown', windowSaw);
    try {
      render(true, onClose);
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
      key(dialog, 'Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(windowSaw).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowSaw);
    }
  });

  it('gives focus back to the trigger when it closes', () => {
    render(true, () => {});
    expect(document.activeElement).not.toBe(trigger);
    render(false, () => {});
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows invalid collection data without crashing or offering a broken export', () => {
    vi.spyOn(bundle, 'gatherCollections').mockImplementation(() => {
      throw new Error('Collection "tasks" contains duplicate field "title".');
    });
    render(true, () => {});
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('duplicate field "title"');
    for (const label of ['Open in runtime…', 'Publish…', 'Export .softn']) {
      expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === label)?.disabled).toBe(true);
    }
    expect(container.textContent).not.toContain('Checking…');
  });

  it('names a page that imports or links a file the project no longer has', async () => {
    // The check read the bundle as the directory would, which does not ask
    // whether a page's `<import … from>` or `<logic src>` leads anywhere.
    // A page left importing a deleted file was "Ready", and the app that
    // ran said "Unknown component" where the file had been used.
    vi.useFakeTimers();
    const files = useFilesStore.getState();
    files.reset();
    files.createFile('ui', 'Other.ui', 'ui');
    files.updateUIFileSource('main_ui', '<import Banner from="./Hero.ui" />\n<import Other from="./Other.ui" />\n<logic src="../logic/main.logic" />\n<App>\n  <Banner />\n  <Other />\n</App>');
    const other = [...useFilesStore.getState().uiFiles.values()].find((file) => file.path === 'ui/Other.ui')!;
    files.updateUIFileSource(other.id, '<logic src="../logic/gone.logic" />\n<App>\n  <Text>Other</Text>\n</App>');

    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const report = container.querySelector('[data-report="references"]')!;
    expect(report, container.textContent ?? '').not.toBeNull();
    const lines = [...report.querySelectorAll('span')].map((line) => line.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('ui/main.ui imports Banner from ./Hero.ui');
    expect(lines[0]).toContain('ui/Hero.ui');
    expect(lines[1]).toContain('ui/Other.ui links ../logic/gone.logic');
    // The page that is there, and the logic that is, are not named.
    expect(report.textContent).not.toContain('./Other.ui');
    expect(report.textContent).not.toContain('main.logic');
    // It can still be exported: the directory does not refuse it, and the file is the person's.
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Export .softn')?.disabled).toBe(false);
  });

  it('names the files of an opened bundle the Builder does not show, server logic first', async () => {
    // Kept as they came and written back by the export, with nothing in the
    // editor to say they were there: a template edited and exported shipped
    // server code nobody had seen, which a host runs.
    vi.useFakeTimers();
    useFilesStore.getState().reset();
    const store = useProjectStore.getState();
    store.setSource({
      ...store.source,
      manifest: { name: 'Template', version: '1.0.0', main: 'ui/main.ui', files: { server: ['api/handlers.logic'] } },
      extraEntries: new Map([
        ['api/handlers.logic', new Uint8Array([1])],
        ['server/admin.logic', new Uint8Array([1])],
        ['hidden/payload.js', new Uint8Array([1])],
      ]),
    });
    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const lines = [...container.querySelectorAll('[data-report="unseen"] > span')].map((line) => line.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Server logic the Builder does not show');
    expect(lines[0]).toContain('api/handlers.logic, server/admin.logic');
    expect(lines[1]).toContain('Files the Builder does not show');
    expect(lines[1]).toContain('hidden/payload.js');
  });

  it('says nothing of references in a project that has none dangling', async () => {
    vi.useFakeTimers();
    useFilesStore.getState().reset();
    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.textContent).toContain('Ready:');
    expect(container.querySelector('[data-report="references"]')).toBeNull();
    expect(container.querySelector('[data-report="pages"]')).toBeNull();
    expect(container.querySelector('[data-report="unseen"]')).toBeNull();
  });

  it('names a page that does not parse, and what the parser warns of in one that does', async () => {
    // The check reads the archive and its manifest and no page. A page with
    // a tag left open was "Ready", and the app made from it stopped where it
    // started. And the parser's one warning, for a second <data> block that
    // gives a name already taken to another collection, was said nowhere.
    vi.useFakeTimers();
    const files = useFilesStore.getState();
    files.reset();
    const broken = files.createFile('ui', 'broken.ui', 'ui');
    files.updateUIFileSource(broken, '<App>\n  <Text>Hello</Text>\n  <Card>\n</App>\n');
    files.updateUIFileSource(
      'main_ui',
      '<data>\n  <collection name="tasks" as="items" />\n</data>\n<App>\n  <Text>Hi</Text>\n</App>\n<data>\n  <collection name="people" as="items" />\n</data>\n'
    );

    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const lines = [...container.querySelectorAll('[data-report="pages"] > span')].map((line) => line.textContent ?? '');
    expect(lines).toHaveLength(2);
    // The page that will not run first, then the warning.
    expect(lines[0]).toMatch(/^✕ ui\/broken\.ui does not parse, and the app will stop there\. Line \d+: /);
    expect(lines[1]).toBe('△ ui/main.ui, line 8: <collection name="people" as="items"> is not declared, because this page already reads "tasks" as items.');
    // Neither stops the export: the file is the person's, and writing it is how a project with no file is saved.
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Export .softn')?.disabled).toBe(false);
  });

  it('reports failed preflight checks and retries when the project details change', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = vi.spyOn(bundle, 'buildProjectBundle').mockRejectedValueOnce(new Error('The entry file is missing.'));
    render(true, () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The entry file is missing.');
    expect(container.textContent).not.toContain('Checking…');

    act(() => useProjectStore.getState().setName('Recovered app'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Checking…');
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(build).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Checking…');
  });
});

describe('the Export button of the dialog', () => {
  // It built the bundle and wrote it by its own hand, and whatever the app
  // knew of where the project is kept played no part: "Bundle exported",
  // and "Unsaved" as before. It asks the app to export, by a save's rule
  // (utils/saveProject.ts), and says what that came to.

  type Saved = Extract<SaveOutcome, { kind: 'saved' }>;
  const saved = (more: Partial<Saved> = {}): Saved => ({
    kind: 'saved', projectId: 'p', revision: 1, handle: null, stale: false, projectChanged: false, sessionStored: true, ...more,
  });

  async function exported(outcome: SaveOutcome): Promise<{ asked: number; closed: number }> {
    vi.useFakeTimers();
    useFilesStore.getState().reset();
    let asked = 0;
    let closed = 0;
    const exportProject = async () => {
      asked += 1;
      return outcome;
    };
    act(() => root.render(React.createElement(ExportDialog, { isOpen: true, onClose: () => { closed += 1; }, exportProject })));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === 'Export .softn')!;
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(20);
    });
    return { asked, closed };
  }

  it('says the project is saved in what it wrote, where the project had no file of its own', async () => {
    const { asked } = await exported(saved());
    expect(asked).toBe(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Exported untitled-app.softn. Your project is saved in it.');
  });

  it('says it is a copy, and that the file the project is kept in has not been saved, where it has one', async () => {
    await exported(saved({ copy: { of: 'tasks.softn', unsaved: true } }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Exported a copy. tasks.softn has not been saved since your last changes.');
  });

  it('stays as it was when the place to write it was not chosen', async () => {
    const { closed } = await exported({ kind: 'cancelled' });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(closed).toBe(0);
    // And can be asked again.
    expect(Array.from(container.querySelectorAll('button')).some((candidate) => candidate.textContent?.trim() === 'Export .softn')).toBe(true);
  });

  it('says why when it could not be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await exported({ kind: 'failed', error: new Error('The disk is full.') });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The disk is full.');
  });
});

describe('the hosts the network may reach', () => {
  // The field showed the declared list joined again on every keystroke, so a
  // space or a comma typed after a host was gone at once: "a.com b.com"
  // typed came out "a.comb.com", one host that is nobody's.

  function openWithNet(): HTMLInputElement {
    const project = useProjectStore.getState();
    project.setPermissions({ ...project.permissions, capabilities: ['net'] });
    render(true, () => {});
    return container.querySelector<HTMLInputElement>('input[data-setting="net-hosts"]')!;
  }

  /** Type `text` into `input` a character at a time, as a person does. */
  function type(input: HTMLInputElement, text: string): void {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const ch of text) {
      act(() => {
        setValue.call(input, input.value + ch);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }

  const hosts = () => useProjectStore.getState().permissions.allowedHosts;

  it('keeps the spaces and commas typed between hosts, and declares each host', () => {
    const input = openWithNet();
    expect(input.getAttribute('aria-label')).toBe('Hosts the app may reach');
    input.focus();
    type(input, 'a.com b.com');
    expect(input.value).toBe('a.com b.com');
    expect(hosts()).toEqual(['a.com', 'b.com']);

    act(() => input.blur());
    expect(input.value).toBe('a.com, b.com');
  });

  it('keeps a trailing comma while the next host is still to come', () => {
    const input = openWithNet();
    input.focus();
    type(input, 'x.org,');
    expect(input.value).toBe('x.org,');
    expect(hosts()).toEqual(['x.org']);
    type(input, ' y.org');
    expect(input.value).toBe('x.org, y.org');
    expect(hosts()).toEqual(['x.org', 'y.org']);
  });

  it('takes a list pasted whole, and says the declared list once the field is left', () => {
    const input = openWithNet();
    input.focus();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'api.example.com,  cdn.example.com localhost');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(hosts()).toEqual(['api.example.com', 'cdn.example.com', 'localhost']);
    act(() => input.blur());
    expect(input.value).toBe('api.example.com, cdn.example.com, localhost');
  });

  it('shows a list changed elsewhere, not what was typed before it', () => {
    const input = openWithNet();
    input.focus();
    type(input, 'a.com ');
    const project = useProjectStore.getState();
    act(() => project.setPermissions({ ...project.permissions, allowedHosts: ['other.org'] }));
    expect(input.value).toBe('other.org');
  });

  it('says that with none listed the app reaches no host on this computer or its network', () => {
    const input = openWithNet();
    const note = document.getElementById(input.getAttribute('aria-describedby')!);
    expect(note?.textContent).toMatch(/not this computer or its local network/);
  });

  it('names each collection’s storage policy', () => {
    useSchemaStore.getState().addEntity({ x: 0, y: 0 });
    const name = useSchemaStore.getState().entities[0].name;
    const project = useProjectStore.getState();
    project.setPermissions({ ...project.permissions, capabilities: ['storage'] });
    render(true, () => {});
    const select = container.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe(`Storage policy for ${name}`);
  });
});

describe('what the app may use, for an app with only an older manifest block', () => {
  it('says the boxes ticked are what that block grants, and only then', async () => {
    const { readBundleDeclaration } = await import('../../utils/permissions');
    const project = useProjectStore.getState();
    project.setPermissions(readBundleDeclaration(undefined, { permissions: { network: true } }));
    render(true, () => {});
    const net = [...container.querySelectorAll('label')].find((label) => label.textContent?.startsWith('Network'))?.querySelector('input');
    expect(net?.checked).toBe(true);
    expect(container.querySelector('[data-permission-source="manifest"]')?.textContent).toMatch(/older permissions block in its manifest/);
    act(() => useProjectStore.getState().setPermissions(readBundleDeclaration(JSON.stringify({ permissions: { net: { enabled: true } } }), { permissions: { network: true } })));
    expect(container.querySelector('[data-permission-source="manifest"]')).toBeNull();
  });
});
