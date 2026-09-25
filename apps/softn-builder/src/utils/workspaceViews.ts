/**
 * Which workspace views make sense for the file that is open.
 *
 * One list, read by the toolbar to offer the views and by the app to leave a
 * view the file cannot have. A logic file used to allow Design alone, so
 * checking what an edit to it did meant switching back to a UI file first;
 * the preview runs the app the logic belongs to, so it is offered too. Code
 * is the source view of a UI file, and an asset has neither.
 */

export type WorkspaceView = 'design' | 'data' | 'preview' | 'code';

const ALL_VIEWS: readonly WorkspaceView[] = ['design', 'data', 'preview', 'code'];
const LOGIC_VIEWS: readonly WorkspaceView[] = ['design', 'preview'];
const DESIGN_ONLY: readonly WorkspaceView[] = ['design'];

export function viewsFor(fileType: 'ui' | 'logic' | 'asset' | null | undefined): readonly WorkspaceView[] {
  if (fileType === 'logic') return LOGIC_VIEWS;
  if (fileType === 'asset') return DESIGN_ONLY;
  return ALL_VIEWS;
}
