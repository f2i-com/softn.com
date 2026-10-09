import { useAIStore, useVFSStore, useWorkspaceStore } from '../stores';
import type { ProjectImportEntry } from './projectImport';
import { resetProjectSessionForImport } from './projectSession';
import { generateTaskGraph, inferBlueprintFromFiles, inferBriefFromBlueprint, projectLogicLanguage } from './studioProject';

/**
 * Put a decoded import into the stores as a new project: one transaction of
 * creates, then the brief and the plan inferred from the files, and the chat
 * open on a message that says what was imported. The caller owns the
 * workspace claim and the checkpoint that precede replacing a project, and
 * calls this only once the whole import has been decoded, so a file that
 * cannot be read leaves the project that was open as it was.
 */
export function openImportedInStores(fileName: string, batch: ProjectImportEntry[]): string {
  const projectId = resetProjectSessionForImport();
  useVFSStore.getState().batchCreateFiles(batch, 'user');

  const importedProjectName = fileName.replace(/\.(softn|zip|json)$/i, '');
  const importedWorkspace = useWorkspaceStore.getState();
  const importedVFS = useVFSStore.getState();
  importedWorkspace.setProjectName(importedProjectName);
  const importedSnapshot = importedVFS.getSnapshot();
  const inferredBlueprint = inferBlueprintFromFiles(importedProjectName, importedSnapshot);
  const inferredBrief = inferBriefFromBlueprint(inferredBlueprint, projectLogicLanguage(importedSnapshot));
  importedWorkspace.setBrief(inferredBrief);
  importedWorkspace.setBlueprint(inferredBlueprint);
  importedWorkspace.setBlueprintApproved(true);
  importedWorkspace.setTaskGraph(generateTaskGraph(inferredBlueprint));
  importedWorkspace.setActivePage(inferredBlueprint.pages[0]?.id ?? null);
  // Open AI first so imported bundles are ready for AI-guided editing. setLeftPanel toggles a
  // panel that is already open, and the session reset above has just left the AI panel open:
  // called without looking, it closed the chat on every import, with the message below in it.
  const shown = useWorkspaceStore.getState();
  if (shown.leftPanel !== 'ai' || !shown.leftPanelExpanded) shown.setLeftPanel('ai');
  importedWorkspace.setMode('design');
  // Log to console output for user visibility
  importedWorkspace.addConsoleOutput(`Imported ${batch.length} file(s) from ${fileName}`);
  for (const entry of batch.slice(0, 10)) {
    importedWorkspace.addConsoleOutput(`  + ${entry.path}`);
  }
  if (batch.length > 10) {
    importedWorkspace.addConsoleOutput(`  ... and ${batch.length - 10} more`);
  }
  useAIStore.getState().addMessage({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `Imported \`${fileName}\` and mapped ${inferredBlueprint.pages.length} page(s). Ask me to restyle screens, reorganize flows, improve data bindings, or prepare the bundle for export.`,
    timestamp: Date.now(),
  });
  return projectId;
}
