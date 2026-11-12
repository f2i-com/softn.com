/**
 * An open app handed a changed set of its files.
 *
 * The tab holds the app's text files (`OpenTab.textFiles`) and the running
 * app as something to update (`OpenTab.live`, core's LiveApp). A host that
 * edits an app while it runs changes a file, calls `updateOpenApp` with the
 * whole set, and hears what happened: the page was drawn again where the app
 * stood, the logic was started again and why, the change has a problem and
 * the last version that worked is still showing, or the app has to be opened
 * afresh because what it is, or what it asks for, changed.
 */

import type { AppRevision, AppUpdateResult } from '@softn/core';
import { createImportResolver, processBundle, type BundleManifest, type DisposableImportResolver } from '@softn/runtime-shell/bundleProcessor';
import type { OpenTab } from './openBundle';

/** What of a tab a newer version of its files replaces. */
export type RevisedTabFields = Pick<
  OpenTab,
  'source' | 'logicBasePath' | 'preIncludedLogicPaths' | 'python' | 'parseProblem' | 'textFiles' | 'importResolver'
>;

export type OpenAppUpdate =
  | AppUpdateResult
  /** The manifest or the permissions file changed: the bundle is opened afresh, and the person is asked again. */
  | { outcome: 'reopen'; changed: []; reason: string };

/** The parts of a manifest that change nothing about how the app runs. */
const COSMETIC = new Set(['name', 'description', 'version', 'author', 'pages', 'icon']);

function runsBy(text: string | undefined): string {
  if (text === undefined) return '';
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(manifest).sort()) if (!COSMETIC.has(key)) kept[key] = manifest[key];
    return JSON.stringify(kept);
  } catch {
    return text;
  }
}

/**
 * What handing `files` to the tab's app would take: nothing the running app
 * can absorb (`reopen`), or the version to hand it.
 */
export function planOpenAppUpdate(
  tab: Pick<OpenTab, 'textFiles' | 'permissionConfig'>,
  files: ReadonlyMap<string, string>
): { reopen: string } | { problem: string } | { revision: AppRevision; fields: RevisedTabFields; resolver: DisposableImportResolver } {
  const had = tab.textFiles;
  if (runsBy(had?.get('manifest.json')) !== runsBy(files.get('manifest.json'))) {
    return { reopen: 'Its manifest changed, so it has to be opened again.' };
  }
  if ((had?.get('permission.json') ?? '') !== (files.get('permission.json') ?? '')) {
    return { reopen: 'What it asks permission for changed, so it has to be opened again and allowed again.' };
  }
  let manifest: Pick<BundleManifest, 'main'> & Partial<BundleManifest>;
  try {
    manifest = JSON.parse(files.get('manifest.json') ?? '') as typeof manifest;
  } catch {
    return { problem: 'Its manifest.json is not valid JSON.' };
  }
  try {
    const composed = processBundle(files, manifest);
    const text = new Map(files);
    const resolver = createImportResolver(text, tab.permissionConfig ?? null);
    const fields: RevisedTabFields = {
      source: composed.source,
      logicBasePath: composed.logicBasePath,
      preIncludedLogicPaths: composed.preIncludedLogicPaths,
      python: composed.python,
      parseProblem: composed.parseProblem,
      textFiles: text,
      importResolver: resolver,
    };
    return {
      revision: {
        source: composed.source,
        importResolver: resolver,
        logicBasePath: composed.logicBasePath,
        preIncludedLogicPaths: composed.preIncludedLogicPaths,
        python: composed.python,
        parseProblem: composed.parseProblem,
      },
      fields,
      resolver,
    };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Hand the tab's running app `files`. `apply` is given the tab's new fields
 * once the app is showing them, for the host to keep (its links between
 * pages and a later Allow read the files from the tab).
 */
export async function updateOpenApp(
  tab: Pick<OpenTab, 'textFiles' | 'permissionConfig' | 'live' | 'importResolver'>,
  files: ReadonlyMap<string, string>,
  apply: (fields: RevisedTabFields) => void
): Promise<OpenAppUpdate> {
  const plan = planOpenAppUpdate(tab, files);
  if ('reopen' in plan) return { outcome: 'reopen', changed: [], reason: plan.reopen };
  if ('problem' in plan) return { outcome: 'kept', changed: [], problem: plan.problem };
  if (!tab.live) {
    plan.resolver.dispose();
    return { outcome: 'reopen', changed: [], reason: 'This app is not open to be changed where it stands.' };
  }
  const result = await tab.live.update(plan.revision);
  if (result.outcome === 'kept') {
    // The last version that worked is still running, on the resolver it had.
    plan.resolver.dispose();
    return result;
  }
  const superseded = tab.importResolver;
  apply(plan.fields);
  if (superseded !== plan.resolver) superseded?.dispose();
  return result;
}
