/**
 * The preview is offered while a logic file is open.
 *
 * Opening a logic file forced the workspace back to Design, so the only way
 * to see what an edit to it did was to switch to a UI file first. The
 * preview runs the app the logic belongs to — its entry file — so it is
 * offered, and it runs the logic as it is being edited.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { pageInHand, viewsFor } from './workspaceViews';
import { previewSourceFor } from './previewSource';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { useCanvasStore } from '../stores/canvasStore';

describe('the views a file allows', () => {
  it('offers the preview, and not the source view, for a logic file', () => {
    expect(viewsFor('logic')).toContain('preview');
    expect(viewsFor('logic')).not.toContain('code');
  });

  it('keeps an asset to Design and a UI file to everything', () => {
    expect(viewsFor('asset')).toEqual(['design']);
    expect(viewsFor('ui')).toEqual(['design', 'data', 'preview', 'code']);
  });
});

describe('where Undo and Redo step the page the canvas holds', () => {
  it('is Design, with the page open or a file that is no page open while the panels hold the page', () => {
    expect(pageInHand('design', 'ui', true)).toBe(true);
    // With main.logic open, the Hierarchy and Properties still hold the page: Undo was off.
    expect(pageInHand('design', 'logic', true)).toBe(true);
    expect(pageInHand('design', 'asset', true)).toBe(true);
    // A canvas that holds no page's tree is nothing to step.
    expect(pageInHand('design', 'logic', false)).toBe(false);
    // Elsewhere the page is not on the screen.
    expect(pageInHand('data', 'ui', true)).toBe(false);
    expect(pageInHand('preview', 'logic', true)).toBe(false);
    expect(pageInHand('code', 'ui', true)).toBe(false);
  });
});

describe('the preview while a logic file is open', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useFilesStore.getState().reset();
    useCanvasStore.getState().reset();
  });

  it('shows the entry file running the logic as edited', () => {
    const files = useFilesStore.getState();
    files.openFile('main_logic');
    files.updateLogicFile('main_logic', 'let count = 99\n');

    const state = useFilesStore.getState();
    const project = useProjectStore.getState();
    const canvas = useCanvasStore.getState();
    const preview = previewSourceFor({
      elements: canvas.elements,
      rootId: canvas.rootId,
      logicSource: project.logicSource,
      collections: project.collections,
      activeFileId: state.activeFileId,
      uiFiles: state.uiFiles,
      logicFiles: state.logicFiles,
      nodes: state.nodes,
      retainedSource: project.source,
    });

    expect(preview.error).toBeNull();
    expect(preview.activeFilePath).toBe('ui/main.ui');
    expect(preview.info).toMatch(/entry file/);
    expect(preview.source).toContain('let count = 99');
  });
});
