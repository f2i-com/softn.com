/**
 * The agent's system prompt: who it is and how it works, how to build a
 * SoftN app (guide.ts), and the component and guide indexes generated from
 * the sources of truth (knowledge/). The brief and the project as it stands —
 * its manifest and its file TREE — open the conversation instead (see
 * buildProjectContext), so the system prompt is a stable, cacheable prefix.
 * File contents are in neither: the
 * agent reads what it needs with read_file, which is what makes an edit to
 * a long file safe (it edits what it read, not a truncated copy).
 *
 * The prompt is deterministic for a given project: no timestamps, no ids.
 */

import { useVFSStore } from '../../stores/vfsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { projectLogicLanguage, projectPythonPackages } from '../studioProject';
import { describeTree } from './executeTool';
import { buildGuide } from './guide';
import { componentIndexText, docIndexText } from './knowledge';
import { textProtocolGuide } from './tools';
import type { ToolProtocol } from './types';

const WORKFLOW = `You are the SoftN Studio agent. You build and change SoftN apps in the person's project by calling tools, one step at a time, until what they asked for works. The person watches each step in a timeline and sees the app's preview update as you write.

## How you work
1. **Understand.** Read the request and the brief. For a change to an existing app, read the files involved first (read_file); use search_files to find where something is.
2. **Plan.** For anything beyond a one-line change, call update_plan with 3–8 short items, and update it as you finish each one.
3. **Build in small steps.** Create new files with write_file. Change existing files with edit_file — exact old_string → new_string, with enough context to be unique. Only rewrite a whole existing file with write_file when most of it changes (and only after reading it whole).
4. **Check.** Studio runs check_app automatically after each step that changes files and appends the report to that step's result: read it. Fix every error before moving on. Use inspect_preview to see what a page shows, and run_app_function to test behaviour (e.g. add an item, then read the state).
5. **Look things up rather than guess.** lookup_components gives a component's exact props and events; read_docs gives the published guides. The component list below is complete: do not invent components or props.
6. **Finish.** When the request is done and the check is clean, call finish with a short summary of what you built or changed. If something could not be done, say so in the summary.

## Rules
- Paths are relative to the project root (\`ui/main.ui\`, \`logic/main.logic\`). Never write under \`builder/\` (private editor state).
- You can only write text files. Reference images and other binary assets that already exist by path.
- Keep manifest.json true whenever you add, rename or remove a file (see the guide below).
- Ask the person (ask_user) only when you cannot proceed sensibly without their decision; otherwise decide and say what you decided in the summary.
- Keep your own messages short: a sentence before a group of steps is enough. The timeline already shows every step.
- Do not delete files you did not create unless the request needs it; deleting more than a few files asks the person first.`;

/**
 * The system prompt for a run on `protocol`: how the agent works, the SoftN
 * guide for the project's language, and the component and guide indexes.
 * Nothing in it changes while the project keeps its language and style — not
 * the file tree, not the brief, not a check — so it is the same bytes on every
 * request of a run and of every later run, and a provider's prompt cache
 * (Anthropic's cache_control, OpenAI's automatic prefix cache, a local
 * server's KV cache) serves it rather than reading it again. What does change
 * is in {@link buildProjectContext}, sent as the run's first message.
 */
export function buildAgentSystemPrompt(protocol: ToolProtocol): string {
  const ws = useWorkspaceStore.getState();
  const files = useVFSStore.getState().files;
  const python = projectLogicLanguage(files, ws.brief) === 'python';
  const torch = python && projectPythonPackages(files, ws.brief).includes('torch');
  return [
    WORKFLOW,
    buildGuide({ python, torch, style: ws.brief?.style || 'clean' }),
    `## Components\nEvery component SoftN registers, by group. Use lookup_components for exact props and events.\n${componentIndexText()}`,
    `## Guides (read_docs)\n${docIndexText(python)}`,
    protocol === 'text' ? textProtocolGuide() : '',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/**
 * The project as the run finds it — the brief, the blueprint, what kind of
 * run this is, manifest.json and the file tree — as the text of the run's
 * first message. Kept out of the system prompt because it changes from run
 * to run; within a run it is written once and never rewritten, so it is part
 * of the cached prefix too.
 */
export function buildProjectContext(kind: 'build' | 'edit' = 'edit'): string {
  const ws = useWorkspaceStore.getState();
  const files = useVFSStore.getState().files;

  const brief = ws.brief
    ? `## The brief
- App name: ${ws.brief.appName}
- Description: ${ws.brief.description}
- Target: ${ws.brief.target}
- Style: ${ws.brief.style}
- Pages: ${ws.brief.pages.join(', ') || 'none specified'}
- Collections: ${ws.brief.collections.join(', ') || 'none specified'}
- Auth: ${ws.brief.authNeeded ? 'required' : 'not required'}`
    : '## No brief yet\nWork from the person\'s messages.';

  const blueprint = ws.blueprint
    ? `## Blueprint
- App: ${ws.blueprint.appName}
- Pages: ${ws.blueprint.pages.map((p) => `${p.name} (${p.route || '/'})`).join(', ')}
- Collections: ${ws.blueprint.collections.map((c) => `${c.name} [${c.fields.map((f) => f.name).join(', ')}]`).join('; ') || 'none'}
- Navigation: ${ws.blueprint.navigation.type}
- Style: ${ws.blueprint.style}`
    : '';

  const manifestFile = files.get('manifest.json');
  const manifest =
    manifestFile && typeof manifestFile.content === 'string' && manifestFile.content.length < 4000
      ? `## manifest.json now\n\`\`\`json\n${manifestFile.content}\n\`\`\``
      : '';

  const build =
    kind === 'build'
      ? `## This run
The project was just scaffolded from the brief: the files below are a starting point, not the app. Build the app the brief describes — real pages, logic and sample data, polished and working — replacing placeholder content. Start with update_plan.`
      : '';

  return [
    '# The project at the start of this run',
    brief,
    blueprint,
    build,
    manifest,
    `## Project files (list_files shows them now)\n${describeTree(files)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
