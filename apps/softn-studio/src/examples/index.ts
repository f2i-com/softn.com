import { useAIStore, useVFSStore, useWorkspaceStore } from '../stores';
import { generateTaskGraph, inferBlueprintFromFiles, inferBriefFromBlueprint } from '../lib/studioProject';
import { resetProjectSessionForImport } from '../lib/projectSession';
import { READING_LIST } from './readingList';

/**
 * A bundled example: a complete project a first visit can open without a
 * provider key, a file to import or a network fetch. The dashboard used to
 * offer only "Start with AI" — which needs a key — and "Import bundle" —
 * which needs a bundle — so a novice with neither had nothing to press
 * that ended in a runnable, exportable project. The example is labelled as
 * one, in its name and in the chat, so it is not mistaken for the person's
 * own work.
 */
export interface ExampleProject {
  id: string;
  /** The project name the workspace takes; says "example" so the label survives into the recent list. */
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
}

export const EXAMPLES: readonly ExampleProject[] = [READING_LIST];

export const DEFAULT_EXAMPLE: ExampleProject = READING_LIST;

/**
 * Put an example into the stores as a new project, the way an import is
 * put there: one transaction of creates, then the blueprint inferred from
 * the files, so the pages panel, the validator and the actions see the
 * same project an imported bundle would give them. The caller owns the
 * workspace-claim and the checkpoint that precede replacing a project.
 */
export function openExampleInStores(example: ExampleProject = DEFAULT_EXAMPLE): string {
  const projectId = resetProjectSessionForImport();
  useVFSStore.getState().batchCreateFiles(example.files, 'user');

  const ws = useWorkspaceStore.getState();
  ws.setProjectName(example.name);
  const blueprint = inferBlueprintFromFiles(example.name, useVFSStore.getState().getSnapshot());
  ws.setBrief(inferBriefFromBlueprint(blueprint));
  ws.setBlueprint(blueprint);
  ws.setBlueprintApproved(true);
  ws.setTaskGraph(generateTaskGraph(blueprint));
  ws.setActivePage(blueprint.pages[0]?.id ?? null);
  ws.setLeftPanel('files');
  ws.setMode('design');
  ws.addConsoleOutput(`Opened the example "${example.name}" (${example.files.length} files). It is a copy: change it freely.`);
  useAIStore.getState().addMessage({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `This is the bundled example "${example.name}": ${example.description} Preview is the canvas; Run opens it in the runtime; Export bundle downloads it as a .softn file. Add a provider key in Settings to edit it with AI.`,
    timestamp: Date.now(),
  });
  return projectId;
}
