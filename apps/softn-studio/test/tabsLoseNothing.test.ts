/** @vitest-environment jsdom */
/**
 * One project open in two or three tabs, each doing what a person does in
 * it (editing, creating and deleting files, one of them binary, renaming the
 * project, talking in the chat, spending tokens, saving, pressing "Keep this
 * tab's version") in an order drawn from a seed, each tab hearing of the
 * others' saves as they are made. Now and then the store refuses a save, and
 * in some orders the chat is already at the most it keeps.
 *
 * What must hold once they have all gone quiet, whatever the order:
 *
 *   - they do go quiet: the tabs do not set each other off for good;
 *   - a tab that says "Saved" holds what storage holds, and a part it holds
 *     that storage does not is one its conflict names;
 *   - nothing any tab wrote is gone without a word: it is in storage, or it
 *     is still in the tab that wrote it and that tab says it is not saved, or
 *     it was written over by a tab that had it (an edit made on top of it, a
 *     deletion of it, or the person choosing the other version of it);
 *   - every chat message said in any tab is in storage and in every tab, and
 *     what the tabs spent adds up.
 *
 * Each tab is its own copy of the modules, as a page loads them, over the one
 * (fake) IndexedDB and the one BroadcastChannel.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDB } from '@softn/test-utils/fake-indexeddb';
import { loadProjectRecord, saveProjectRecord, type ProjectRecord } from '../src/lib/persistence';

type Session = typeof import('../src/lib/projectSession');
type Stores = typeof import('../src/stores');
interface Tab {
  session: Session;
  stores: Stores;
  autosave: import('../src/lib/projectSession').AutosaveController | null;
}

const TEXT_PATHS = ['ui/main.ui', 'ui/about.ui', 'ui/extra.ui'];
const BINARY_PATH = 'assets/logo.png';
const PATHS = [...TEXT_PATHS, BINARY_PATH];
const STEPS = 28;

const tabs: Tab[] = [];

/**
 * IndexedDB runs one read-write transaction on a store at a time, whichever
 * tab began it: a save's look at the stored copy and its write are one such
 * transaction, which is what makes a save safe against another tab's. The
 * fake runs transactions at once, so two saves could both look before either
 * wrote. Here they take turns, as in a browser.
 */
let storeBusy: Promise<unknown> = Promise.resolve();
/** Saves the store is still to refuse, as a full disk does: nothing of such a save is written. */
let refusals = 0;
const FULL = { ok: false as const, reason: 'quota' as const, message: 'This project is larger than the browser will store.' };
const saveInTurn: typeof saveProjectRecord = (record, lastSeen, reconcile) => {
  const result = storeBusy.then(() => {
    if (refusals === 0) return saveProjectRecord(record, lastSeen, reconcile);
    refusals -= 1;
    // Refused outright, or after the tab has worked out its merge with the stored copy.
    if (!reconcile || refusals % 2 === 0) return FULL;
    return saveProjectRecord(record, lastSeen, (stored) => {
      reconcile(stored);
      return FULL;
    });
  });
  storeBusy = result.catch(() => undefined);
  return result;
};

beforeAll(async () => {
  for (let i = 0; i < 3; i++) {
    vi.resetModules();
    tabs.push({ session: await import('../src/lib/projectSession'), stores: await import('../src/stores'), autosave: null });
  }
});

afterEach(() => {
  for (const tab of tabs) {
    tab.autosave?.stop();
    tab.autosave = null;
  }
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

/** mulberry32: the same order for the same seed. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A file's content as something to compare and to print; undefined for no file. */
const shown = (content: string | Uint8Array | undefined): string | undefined =>
  content === undefined ? undefined : typeof content === 'string' ? content : `bytes ${Array.from(content).join(' ')}`;

const held = (tab: Tab, path: string) => shown(tab.stores.useVFSStore.getState().files.get(path)?.content);
const storedFile = (record: ProjectRecord, path: string) => shown(record.files.find((file) => file.path === path)?.content);
const nameOf = (tab: Tab) => tab.stores.useWorkspaceStore.getState().projectName;

interface Write {
  tab: number;
  /** What was written: a file's new content, or a project name. */
  value: string;
  path?: string;
}

async function scenario(seed: number): Promise<void> {
  const random = seeded(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const open = tabs.slice(0, 2 + (seed % 2));
  const steps: string[] = [];
  const said = (line: string) => steps.push(line);
  let serial = 0;

  for (const tab of tabs) {
    tab.autosave?.stop();
    tab.autosave = null;
  }
  installFakeIndexedDB();
  localStorage.clear();
  refusals = 0;
  const first = open[0];
  const projectId = first.session.beginNewProjectSession();
  first.stores.useWorkspaceStore.getState().setProjectName('Notes');
  // One order in five begins with a chat four short of the 200 messages it keeps.
  if (seed % 5 === 0) {
    for (let n = 1; n <= 196; n++) first.stores.useAIStore.getState().addMessage({ id: `earlier ${n}`, role: 'user', content: `Earlier ${n}`, timestamp: n });
  }
  for (const path of TEXT_PATHS.slice(0, 2)) first.stores.useVFSStore.getState().createFile(path, `${path} as made`);
  first.stores.useVFSStore.getState().createFile(BINARY_PATH, new Uint8Array([0, 0]));
  for (const tab of open) {
    if (tab !== first) tab.session.applyProjectRecord((await loadProjectRecord(projectId))!);
    // Saves only when asked, or when told of another tab's save.
    tab.autosave = tab.session.startProjectAutosave({ debounceMs: 60_000, maxWaitMs: 60_000, live: true, save: saveInTurn });
    if (tab === first) expect(await tab.autosave.flush()).toEqual({ ok: true });
  }

  const writes: Write[] = [];
  /** `path\ncontent` of file versions, and names, that a tab wrote over while holding them. */
  const writtenOver = new Set<string>();
  const messages: string[] = [];
  let spent = 0;

  for (let step = 0; step < STEPS; step++) {
    const t = Math.floor(random() * open.length);
    const tab = open[t];
    const vfs = tab.stores.useVFSStore.getState();
    const roll = random();
    if (roll < 0.3) {
      const path = pick(PATHS);
      const before = held(tab, path);
      const content = path === BINARY_PATH ? new Uint8Array([seed % 251, ++serial]) : `${path} from tab ${t}, change ${++serial}`;
      if (before === undefined) vfs.createFile(path, content);
      else vfs.updateFile(path, content);
      if (before !== undefined) writtenOver.add(`${path}\n${before}`);
      writes.push({ tab: t, path, value: shown(content)! });
      said(`tab ${t} writes ${path}: ${shown(content)}`);
    } else if (roll < 0.38) {
      const path = pick(PATHS);
      const before = held(tab, path);
      if (before === undefined) continue;
      vfs.deleteFile(path);
      writtenOver.add(`${path}\n${before}`);
      said(`tab ${t} deletes ${path}`);
    } else if (roll < 0.46) {
      const name = `Notes, named in tab ${t}, ${++serial}`;
      writtenOver.add(nameOf(tab));
      expect(tab.session.renameProject(name)).toBeNull();
      writes.push({ tab: t, value: name });
      said(`tab ${t} renames to ${name}`);
    } else if (roll < 0.54) {
      const id = `message ${++serial} of tab ${t}`;
      tab.stores.useAIStore.getState().addMessage({ id, role: 'user', content: id, timestamp: Date.now() });
      messages.push(id);
      said(`tab ${t} says ${id}`);
    } else if (roll < 0.6) {
      const tokens = 1 + Math.floor(random() * 500);
      tab.stores.useAIStore.setState({ tokensUsed: tab.stores.useAIStore.getState().tokensUsed + tokens });
      spent += tokens;
      said(`tab ${t} spends ${tokens}`);
    } else if (roll < 0.78) {
      await tab.autosave!.flush();
      said(`tab ${t} saves`);
    } else if (roll < 0.86) {
      void tab.autosave!.flush();
      said(`tab ${t} starts a save`);
    } else if (roll < 0.9) {
      await sleep(Math.floor(random() * 8));
      said('a moment passes');
    } else if (roll < 0.94) {
      refusals += 1;
      said('the store will refuse a save');
    } else {
      const status = tab.session.getSaveStatus();
      if (status.state !== 'failed' || !status.parts) continue;
      const conflicted = (await tab.session.saveForRun()).conflicts;
      const before = (await loadProjectRecord(projectId))!;
      await tab.session.keepThisTabsVersion();
      const after = (await loadProjectRecord(projectId))!;
      // The person chose this tab's version over the stored one they were shown.
      for (const path of conflicted) {
        const was = storedFile(before, path);
        if (was !== undefined && storedFile(after, path) === held(tab, path)) writtenOver.add(`${path}\n${was}`);
      }
      if (after.workspace.projectName === nameOf(tab)) writtenOver.add(before.workspace.projectName);
      said(`tab ${t} keeps its version of ${status.parts}`);
    }
    if (process.env.STUDIO_TABS_TRACE) {
      for (const [n, each] of open.entries()) {
        const status = each.session.getSaveStatus();
        said(`    tab ${n} r${each.session.currentRevision()} ${status.state}${status.state === 'failed' ? ` ${status.parts}` : ''}: ${PATHS.map((path) => held(each, path) ?? '-').join(' | ')}`);
      }
    }
  }

  // Until they have gone quiet: every tab has saved, every tab has taken in the last save
  // (its revision is then the stored one: each write is numbered above the one before), and
  // storage has not been written for a while. A slow machine gets seconds to get there.
  let quietFor = 0;
  let lastRevision = -1;
  for (let round = 0; quietFor < 4; round++) {
    if (round === 250) throw new Error(`seed ${seed}: the tabs did not go quiet\n${steps.join('\n')}`);
    await Promise.all(open.map((tab) => tab.autosave!.flush()));
    await sleep(20);
    const revision = (await loadProjectRecord(projectId))!.revision;
    const level = open.every((tab) => tab.session.currentRevision() === revision);
    quietFor = revision === lastRevision && level ? quietFor + 1 : 0;
    lastRevision = revision;
  }

  const stored = (await loadProjectRecord(projectId))!;
  const problems: string[] = [];
  const conflicts: string[][] = [];
  for (const [t, tab] of open.entries()) {
    const status = tab.session.getSaveStatus();
    const fileConflicts = (await tab.session.saveForRun()).conflicts;
    conflicts.push(fileConflicts);
    const words = status.state === 'failed' ? `${status.reason}: ${status.parts ?? status.message}` : status.state;
    if (status.state !== 'saved' && !(status.state === 'failed' && status.reason === 'conflict')) problems.push(`tab ${t} ends ${words}`);
    for (const path of PATHS) {
      if (held(tab, path) === storedFile(stored, path) || fileConflicts.includes(path)) continue;
      problems.push(`tab ${t} (${words}) holds ${path} as ${held(tab, path)}, storage holds ${storedFile(stored, path)}, and no conflict names it`);
    }
    if (nameOf(tab) !== stored.workspace.projectName && !(status.state === 'failed' && status.parts?.includes('name'))) {
      problems.push(`tab ${t} (${words}) is named ${nameOf(tab)}, storage says ${stored.workspace.projectName}, and no conflict names it`);
    }
    const here = new Set(tab.stores.useAIStore.getState().messages.map((message) => message.id));
    for (const id of messages) if (!here.has(id)) problems.push(`tab ${t} does not hold “${id}”`);
    if (tab.stores.useAIStore.getState().tokensUsed !== spent) problems.push(`tab ${t} counts ${tab.stores.useAIStore.getState().tokensUsed} tokens spent, of ${spent}`);
  }
  const storedMessages = new Set(stored.session.messages.map((message) => message.id));
  for (const id of messages) if (!storedMessages.has(id)) problems.push(`storage does not hold “${id}”`);
  if (stored.session.tokensUsed !== spent) problems.push(`storage counts ${stored.session.tokensUsed} tokens spent, of ${spent}`);

  for (const write of writes) {
    const tab = open[write.tab];
    if (write.path === undefined) {
      const status = tab.session.getSaveStatus();
      const kept = nameOf(tab) === write.value && status.state === 'failed' && Boolean(status.parts?.includes('name'));
      if (stored.workspace.projectName !== write.value && !kept && !writtenOver.has(write.value)) problems.push(`the name “${write.value}” is gone`);
      continue;
    }
    const kept = held(tab, write.path) === write.value && conflicts[write.tab].includes(write.path);
    if (storedFile(stored, write.path) !== write.value && !kept && !writtenOver.has(`${write.path}\n${write.value}`)) {
      problems.push(`what tab ${write.tab} wrote to ${write.path} (${write.value}) is gone: storage holds ${storedFile(stored, write.path)}, the tab holds ${held(tab, write.path)}`);
    }
  }

  if (problems.length > 0) throw new Error(`seed ${seed}:\n${problems.join('\n')}\n\nwhat happened:\n${steps.join('\n')}`);
}

describe('tabs on one project, in any order', () => {
  // To look at one order, or to try many more: STUDIO_TABS_SEED=27 or STUDIO_TABS_SEED=41-400,
  // with STUDIO_TABS_TRACE=1 for what each tab held after every step.
  const asked = /^(\d+)(?:-(\d+))?$/.exec(process.env.STUDIO_TABS_SEED ?? '');
  if (asked) {
    const from = Number(asked[1]);
    const to = Number(asked[2] ?? asked[1]);
    it(`lose nothing and go quiet (seeds ${from} to ${to})`, async () => {
      const failures: string[] = [];
      for (let seed = from; seed <= to; seed++) await scenario(seed).catch((error: Error) => failures.push(error.message));
      if (failures.length > 0) throw new Error(failures.join('\n\n'));
    }, 600_000);
    return;
  }
  // In fours, so that a failure names a small range of seeds and the others still run.
  for (let from = 1; from <= 37; from += 4) {
    it(`lose nothing and go quiet (seeds ${from} to ${from + 3})`, async () => {
      for (let seed = from; seed < from + 4; seed++) await scenario(seed);
    }, 60_000);
  }
});
