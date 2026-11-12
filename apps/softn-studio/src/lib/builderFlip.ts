/**
 * Studio's side of going to the Builder and coming back.
 *
 * "Open in Builder" hands the open project to the visual editor so that a
 * person can change by hand what is quicker done by hand, and "Back to
 * Studio" there brings those changes into this same project. The bundle
 * goes the way Run's does (lib/flipHandoff.ts); what is Studio's own is here.
 *
 * Going. The project is saved first, so the Builder is given what storage
 * holds and a reload on the way back finds it. A draft typed into a file and
 * not saved is asked about, and a run that is working is asked about and
 * stopped, as Home asks (lib/leaveRun.ts): this tab is leaving, and a write
 * made after the bundle was built would be a change the Builder never saw.
 * Then this tab goes to the Builder. It is not opened beside Studio in
 * another tab, as Run is: two editors open on one project is how a project
 * comes to be changed in two places at once.
 *
 * Coming back. The Builder says which files of its bundle are changed and
 * which are gone, and sends back Studio's own digest of each as it was
 * handed over. A file Studio still holds as it sent it takes the Builder's
 * version. One that was changed here in the meantime (another tab, a run
 * left working there) is not written over: the person is asked, once, about
 * all such files together. Everything brought in is one transaction by the
 * person, so it is one step in History, with a name that says where it came
 * from, and Undo last takes the whole visit back. Nothing changed is no
 * step. Files the Builder does not name are not touched: Studio's own notes
 * under builder/ never left, and neither did the plan or the chat.
 *
 * The hand-off record is removed once the project is saved with the
 * changes in it, so a reload before that takes it again, and taking it
 * twice changes nothing: what is already here as the Builder has it is
 * skipped.
 */

import { readBundleEntries } from '@softn/core';
import { isHostedEditor } from '@softn/editor-shared/hostedEditor';
import { sha256Hex } from '@softn/bundle-format/crypto';
import { create } from 'zustand';
import { useAIStore, useVFSStore, useWorkspaceStore } from '../stores';
import type { VFSChangeRecord } from '../stores/vfsStore';
import type { VFSFile } from '../types/studio';
import { stopAgentRun } from './agent/runAgent';
import { buildBundle, planBundle } from './exportBundle';
import { describeFlipFailure, flipFrom, flipUrl, noteFlipTaken, readFlip, removeFlip, sameOriginTarget, stageFlip, type FileDigests, type FlipBack } from './flipHandoff';
import { confirmLeaveDraft } from './handEdit';
import { TO_BUILDER, leaveRunQuestion } from './leaveRun';
import { canonicalKey, resolveProjectPath } from './paths';
import { isTextEntry } from './projectImport';
import { hasProjectContent, saveForRun, type OpenOutcome } from './projectSession';
import { BUILDER_URL } from './siteUrls';

const encoder = new TextEncoder();
const bytesOf = (content: VFSFile['content']): Uint8Array => (typeof content === 'string' ? encoder.encode(content) : content);

/**
 * Whether this Studio has a Builder to flip to: one on this origin, which is
 * the only place it can see what is staged here. Not inside FormLogic, whose
 * editor is Studio alone in a frame, and not where the two run on separate
 * ports in development.
 */
export function builderOffered(): boolean {
  return !isHostedEditor() && sameOriginTarget(BUILDER_URL);
}

/** Leaving for the Builder, and coming to its address: one place, so a test can stand in for it. */
export const flipNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};

// --- Going -----------------------------------------------------------------------

export type BuilderVisit =
  | { ok: true; url: string }
  /** The person would rather stay: nothing was stopped, saved or staged. */
  | { ok: false; stayed: true }
  | { ok: false; stayed: false; message: string };

export interface VisitDeps {
  confirm?: (question: string) => boolean;
  save?: typeof saveForRun;
  stage?: typeof stageFlip;
}

const STAYED: BuilderVisit = { ok: false, stayed: true };
const refused = (message: string): BuilderVisit => ({ ok: false, stayed: false, message });

/** Resolves once no run is working: a stopped run settles a moment after it is told to stop. */
function runSettled(timeoutMs = 4000): Promise<void> {
  if (useAIStore.getState().agentState !== 'building') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = useAIStore.subscribe((state) => {
      if (state.agentState !== 'building') done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

/** Each file that goes in the bundle, by its path there, as Studio holds it now. */
async function sentDigests(files: Map<string, VFSFile>): Promise<FileDigests> {
  const sent: FileDigests = {};
  for (const [path, source] of planBundle(files).sources) {
    const file = files.get(source);
    if (file) sent[path] = await sha256Hex(bytesOf(file.content));
  }
  return sent;
}

/**
 * Save the project and stage it for the Builder. Resolves with the address
 * to go to, or with why not. Nothing here leaves the page.
 */
export async function prepareBuilderVisit(deps: VisitDeps = {}): Promise<BuilderVisit> {
  const workspace = useWorkspaceStore.getState();
  const { projectId } = workspace;
  const name = workspace.projectName.trim() || 'Untitled app';
  if (!projectId || useVFSStore.getState().files.size === 0) return refused('There are no files to open in the Builder yet.');
  if (!builderOffered()) return refused('The Builder is not beside this Studio, so it cannot be given the project. Export bundle and open the file in the Builder instead.');
  // A file being edited by hand, with changes not saved, is not in the project yet: asked about first.
  if (!confirmLeaveDraft()) return STAYED;
  if (useAIStore.getState().agentState === 'building') {
    if (!(deps.confirm ?? ((question: string) => window.confirm(question)))(leaveRunQuestion(workspace.projectName, TO_BUILDER))) return STAYED;
    stopAgentRun();
    await runSettled();
  }
  const saved = await (deps.save ?? saveForRun)();
  if (saved.failed) return refused(`${name} could not be saved to this browser, so it was not opened in the Builder: ${saved.failed.message}`);
  if (saved.conflicts.length > 0) {
    const many = saved.conflicts.length > 1;
    return refused(`${saved.conflicts.join(', ')} ${many ? 'were' : 'was'} changed in another tab as well as in this one, and this tab’s version is not saved. Choose which to keep in the save bar, then open the Builder.`);
  }
  // Another project took this one's place while it was being saved: that one was not asked about.
  if (useWorkspaceStore.getState().projectId !== projectId) return STAYED;
  const files = useVFSStore.getState().files;
  let bytes: Uint8Array;
  try {
    bytes = buildBundle(files);
  } catch (err) {
    return refused(`The project could not be made into a bundle for the Builder: ${err instanceof Error ? err.message : String(err)}`);
  }
  const id = await (deps.stage ?? stageFlip)(bytes, name, 'builder', { kind: 'open', projectId, sent: await sentDigests(files) });
  if (!id) return refused('This browser could not hold the project for the Builder. Export bundle and open the file there instead.');
  return { ok: true, url: flipUrl(BUILDER_URL, 'builder', { id }) };
}

// --- Coming back -----------------------------------------------------------------

/** What Studio was opened with by the Builder: the project, and the id of its changes when it has any. */
export interface BuilderReturn {
  projectId: string | null;
  id: string | null;
}

/** The Builder's return in this address, or null when the page was not opened by one. */
export function readBuilderReturn(search: string): BuilderReturn | null {
  return flipFrom(search, 'studio');
}

export interface ReturnPlan {
  /** What can be brought in: each file is as Studio sent it, or is new to it. */
  records: VFSChangeRecord[];
  /** Files Studio changed while the Builder had the project, each with what the Builder would do to it. */
  conflicts: Array<{ path: string; record: VFSChangeRecord }>;
  /** Files Studio already holds as the Builder has them. */
  same: string[];
  /** Files that are not brought in, each with why. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * What the Builder's return does to the project as it stands. Each file it
 * names is held against the digest Studio sent it with: only a file that is
 * still that one is replaced or deleted without asking.
 */
export async function planReturn(files: Map<string, VFSFile>, flip: FlipBack, entries: ReadonlyMap<string, Uint8Array>): Promise<ReturnPlan> {
  const plan: ReturnPlan = { records: [], conflicts: [], same: [], skipped: [] };
  // Studio's spelling of each path: on a disk that folds case the Builder's `Pages/home.html` is Studio's `pages/home.html`.
  const spelled = new Map<string, string>();
  for (const path of files.keys()) if (!spelled.has(canonicalKey(path))) spelled.set(canonicalKey(path), path);
  const decoder = new TextDecoder();
  const seen = new Set<string>();

  for (const path of [...flip.changed, ...flip.deleted]) {
    const deleting = !flip.changed.includes(path);
    const verdict = resolveProjectPath(path);
    if (!verdict.ok) {
      plan.skipped.push({ path, reason: verdict.reason });
      continue;
    }
    if (seen.has(verdict.key)) continue;
    seen.add(verdict.key);
    if (verdict.private) {
      plan.skipped.push({ path, reason: 'builder/ holds Studio’s own notes on the project' });
      continue;
    }
    const own = spelled.get(verdict.key);
    const current = own === undefined ? undefined : files.get(own);
    const now = current ? await sha256Hex(bytesOf(current.content)) : null;
    const sent = flip.sent[path] ?? null;

    if (deleting) {
      if (!current || own === undefined) plan.same.push(path);
      else if (now === sent) plan.records.push({ op: 'delete', path: own });
      else plan.conflicts.push({ path: own, record: { op: 'delete', path: own } });
      continue;
    }

    const bytes = entries.get(path);
    if (!bytes) {
      plan.skipped.push({ path, reason: 'it is not in what the Builder handed over' });
      continue;
    }
    // Text or bytes by the rule an import goes by, so the file is held as it would be had the bundle been opened here.
    const content = isTextEntry(verdict.path, bytes) ? decoder.decode(bytes) : bytes;
    if (now !== null && now === (await sha256Hex(bytesOf(content)))) {
      plan.same.push(path);
      continue;
    }
    const record: VFSChangeRecord = current && own !== undefined ? { op: 'update', path: own, content } : { op: 'create', path: verdict.path, content };
    // As Studio sent it (or a file it never had): the Builder's. Anything else was changed here since.
    if (now === sent) plan.records.push(record);
    else plan.conflicts.push({ path: own ?? verdict.path, record });
  }
  return plan;
}

/** What the person is asked about files that changed in both places. */
export function changedMeanwhileQuestion(paths: readonly string[]): string {
  const one = paths.length === 1;
  const what = one ? `${paths[0]} was changed` : `${paths.length} files were changed`;
  const list = one ? '' : ` ${paths.slice(0, 6).join(', ')}${paths.length > 6 ? `, and ${paths.length - 6} more` : ''}.`;
  return `${what} in Studio while this project was open in the Builder.${list}\n\nUse the Builder’s version${one ? '' : 's'}? Undo last in History puts Studio’s back. Press Cancel to keep Studio’s version${one ? '' : 's'}; the rest of the Builder’s changes still come in.`;
}

/** The History step's name: "Edited in the Builder: 3 files changed". */
export function returnStepName(count: number): string {
  return `Edited in the Builder: ${count} file${count === 1 ? '' : 's'} changed`;
}

export type ReturnOutcome =
  /** Brought in as one step. `kept`: files left as Studio has them, at the person's word. `saved`: storage holds them. */
  | { kind: 'applied'; step: string; paths: string[]; kept: string[]; skipped: ReturnPlan['skipped']; saved: boolean }
  /** Nothing to bring in. `kept`: every file that differed was left as Studio has it. */
  | { kind: 'nothing'; kept: string[] }
  /** The project is gone from Studio: what the Builder had was opened as a new one. */
  | { kind: 'imported'; name: string }
  | { kind: 'failed'; message: string };

export interface ReturnDeps {
  /** Open the project the return is of, when the stores hold another or none. */
  openProject(projectId: string): Promise<OpenOutcome>;
  /** Open a bundle as a new project: for work that comes back to a project deleted in the meantime. */
  importBundle?(bytes: Uint8Array, name: string): Promise<OpenOutcome>;
  confirm?: (question: string) => boolean;
  save?: typeof saveForRun;
}

/**
 * Take what the Builder sent back into the project it is of. The stores
 * hold that project when this resolves, unless it could not be opened.
 */
export async function takeBuilderReturn(back: BuilderReturn, deps: ReturnDeps): Promise<ReturnOutcome> {
  const read = back.id ? await readFlip(back.id, 'studio') : null;
  const record = read?.ok ? read.record : null;
  const flip = record && record.flip.kind === 'return' ? record.flip : null;
  const projectId = flip?.projectId ?? back.projectId;
  if (!projectId) return { kind: 'failed', message: describeFlipFailure(read && !read.ok ? read.reason : 'no-id', 'studio') };

  if (useWorkspaceStore.getState().projectId !== projectId || !hasProjectContent()) {
    const opened = await deps.openProject(projectId);
    if (!opened.ok) {
      // Deleted here while it was open there. The work is not thrown away with it.
      if (record && back.id && deps.importBundle) {
        const imported = await deps.importBundle(record.bytes, record.name);
        if (!imported.ok) return { kind: 'failed', message: `The project this came from is no longer in Studio, and what the Builder had could not be opened either: ${imported.message}` };
        await removeFlip(back.id);
        noteFlipTaken(projectId, back.id);
        return { kind: 'imported', name: record.name };
      }
      return { kind: 'failed', message: `The project the Builder had is no longer in Studio. ${opened.message}` };
    }
  }

  if (!back.id) return { kind: 'nothing', kept: [] };
  if (!read?.ok) return { kind: 'failed', message: describeFlipFailure(read?.reason ?? 'no-id', 'studio') };
  if (!flip || !record) return { kind: 'failed', message: describeFlipFailure('corrupt', 'studio') };

  let entries: Map<string, Uint8Array>;
  try {
    entries = readBundleEntries(record.bytes);
  } catch (err) {
    return { kind: 'failed', message: `What the Builder handed over could not be read: ${err instanceof Error ? err.message : String(err)} Open the Builder again and choose Back to Studio: your changes are still there.` };
  }
  const plan = await planReturn(useVFSStore.getState().files, flip, entries);
  let records = plan.records;
  let kept: string[] = [];
  if (plan.conflicts.length > 0) {
    const paths = plan.conflicts.map((conflict) => conflict.path);
    if ((deps.confirm ?? ((question: string) => window.confirm(question)))(changedMeanwhileQuestion(paths))) records = [...records, ...plan.conflicts.map((conflict) => conflict.record)];
    else kept = paths;
  }
  const done = async () => {
    await removeFlip(back.id!);
    noteFlipTaken(projectId, back.id!);
  };
  if (records.length === 0) {
    await done();
    return { kind: 'nothing', kept };
  }

  const step = returnStepName(records.length);
  try {
    // One transaction by the person, under the name History shows for it.
    useVFSStore.getState().applyTransaction(records, 'user', undefined, step);
  } catch (err) {
    return { kind: 'failed', message: `The Builder’s changes could not be brought in, and nothing was changed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const paths = records.map((entry) => entry.path);
  const workspace = useWorkspaceStore.getState();
  workspace.setDirty(true);
  workspace.addConsoleOutput(`[You] ${step}: ${paths.join(', ')}`);
  for (const { path, reason } of plan.skipped) workspace.addConsoleOutput(`${path} was not brought in from the Builder: ${reason}.`);
  // Kept until the project is saved with them in it: a reload before that takes the return again.
  const saved = await (deps.save ?? saveForRun)();
  if (!saved.failed) await done();
  return { kind: 'applied', step, paths, kept, skipped: plan.skipped, saved: !saved.failed };
}

/** What a return came to, in a sentence for the person. */
export function describeReturn(outcome: ReturnOutcome): string {
  const left = (kept: string[]) => (kept.length === 0 ? '' : ` ${kept.join(', ')} ${kept.length === 1 ? 'was' : 'were'} left as Studio has ${kept.length === 1 ? 'it' : 'them'}.`);
  switch (outcome.kind) {
    case 'applied':
      return `Back from the Builder: ${outcome.paths.length} file${outcome.paths.length === 1 ? '' : 's'} changed. It is one step in History, and Undo last takes the whole visit back.${left(outcome.kept)}`;
    case 'nothing':
      return outcome.kept.length > 0 ? `Back from the Builder.${left(outcome.kept)}` : 'Back from the Builder. Nothing was changed there.';
    case 'imported':
      return `The project the Builder had is no longer in Studio, so what it had was opened as a new project: ${outcome.name}.`;
    case 'failed':
      return outcome.message;
  }
}

// --- Said in the bar ---------------------------------------------------------------

/** What the last return came to, for the project's bar to say until it is dismissed. */
export const useBuilderReturnNotice = create<{ notice: { text: string; failed: boolean } | null; say(outcome: ReturnOutcome): void; dismiss(): void }>((set) => ({
  notice: null,
  say: (outcome) => set({ notice: { text: describeReturn(outcome), failed: outcome.kind === 'failed' } }),
  dismiss: () => set({ notice: null }),
}));
