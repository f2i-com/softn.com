/**
 * A Python app that asks for torch.
 *
 * The composer refuses an `import torch` the manifest does not declare with
 * `"config": { "python": { "packages": ["torch"] } }`, and reads that from the
 * `manifest.json` among the files it is given. The Builder holds the choice
 * as a project setting, writes it into the exported manifest, reads it back
 * on open and on restore, and gives the preview the manifest export would
 * write — so a declared app previews, and an undeclared one is refused there
 * with the same message it would get from the runtime.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readBundleEntries } from '@softn/core';
import { useProjectStore } from '../stores/projectStore';
import { useFilesStore } from '../stores/filesStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSchemaStore } from '../stores/schemaStore';
import { buildProjectBundle } from './buildProjectBundle';
import { loadBundle } from './bundleLoader';
import { captureSession, commitProjectSnapshot, prepareProjectSnapshot, prepareSessionSnapshot } from './openProject';
import { previewSourceFor, undeclaredPythonPackage } from './previewSource';

const TORCH_PY = 'import torch\n\nloss = 0.0\n\n\ndef train():\n    global loss\n    loss = float(torch.tensor([1.0]).sum())\n';

function newPythonProject(): void {
  useCanvasStore.getState().reset();
  useSchemaStore.getState().reset();
  useProjectStore.getState().reset('python');
  useFilesStore.getState().reset('python');
  const files = useFilesStore.getState();
  files.updateLogicFile('main_logic', TORCH_PY);
  const main = files.uiFiles.get('main_ui')!;
  useCanvasStore.getState().loadState(main.elements, main.rootId);
}

function preview() {
  const project = useProjectStore.getState();
  const files = useFilesStore.getState();
  const canvas = useCanvasStore.getState();
  return previewSourceFor({
    elements: canvas.elements,
    rootId: canvas.rootId,
    logicSource: project.logicSource,
    collections: project.collections,
    activeFileId: files.activeFileId,
    uiFiles: files.uiFiles,
    logicFiles: files.logicFiles,
    nodes: files.nodes,
    retainedSource: project.source,
    pythonPackages: project.pythonPackages,
  });
}

async function exportedManifest(): Promise<Record<string, unknown>> {
  const entries = readBundleEntries(await buildProjectBundle());
  return JSON.parse(new TextDecoder().decode(entries.get('manifest.json')!));
}

describe('torch in a Python project', () => {
  beforeEach(newPythonProject);

  it('is refused in the preview until it is declared, and the refusal names what to enable', () => {
    const refused = preview();
    expect(refused.error).toContain('imports torch');
    expect(undeclaredPythonPackage(refused.error)).toBe('torch');

    useProjectStore.getState().setPythonPackages(['torch']);
    const shown = preview();
    expect(shown.error).toBeNull();
    expect(shown.composition?.python?.packages).toEqual(['torch']);
  });

  it('is written to the exported manifest, and removed again when turned off', async () => {
    useProjectStore.getState().setPythonPackages(['torch']);
    expect((await exportedManifest()).config).toMatchObject({ python: { packages: ['torch'] } });

    useProjectStore.getState().setPythonPackages([]);
    const config = (await exportedManifest()).config as Record<string, unknown>;
    expect(config).not.toHaveProperty('python');
  });

  it('round-trips through export and open, and through a saved session', async () => {
    useProjectStore.getState().setPythonPackages(['torch']);
    const bundle = await buildProjectBundle();

    newPythonProject();
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(bundle)));
    expect(useProjectStore.getState().pythonPackages).toEqual(['torch']);
    expect(preview().error).toBeNull();

    const session = JSON.stringify(captureSession('design'));
    newPythonProject();
    commitProjectSnapshot(prepareSessionSnapshot(session));
    expect(useProjectStore.getState().pythonPackages).toEqual(['torch']);

    // Turned off after opening, the retained manifest's declaration goes too.
    useProjectStore.getState().setPythonPackages([]);
    expect((await exportedManifest()).config).not.toHaveProperty('python');
  });

  it('keeps the declaration a session from before the setting existed only had in its manifest', async () => {
    useProjectStore.getState().setPythonPackages(['torch']);
    commitProjectSnapshot(prepareProjectSnapshot(await loadBundle(await buildProjectBundle())));
    const old = captureSession('design');
    delete (old.project as { pythonPackages?: string[] }).pythonPackages;
    newPythonProject();
    commitProjectSnapshot(prepareSessionSnapshot(JSON.stringify(old)));
    expect(useProjectStore.getState().pythonPackages).toEqual(['torch']);
  });
});

describe('the refusal the preview offers to fix', () => {
  it('names only a package the runtime offers', () => {
    expect(undeclaredPythonPackage('logic/main.py imports torch, which an app asks for in manifest.json: …')).toBe('torch');
    expect(undeclaredPythonPackage('logic/main.py imports numpy, which an app asks for in manifest.json: …')).toBeNull();
    expect(undeclaredPythonPackage(null)).toBeNull();
  });
});
