/**
 * The chat's entry points into the agent, and what the single-shot turn left
 * that is still used.
 *
 * A turn used to be one request: a system prompt carrying every file's
 * contents up to a budget, a reply of <softn-file> blocks, up to three rounds
 * of <softn-read>, and one changeset. It is now an agent run (lib/agent/): the
 * model calls tools — read, search, edit, write, check, test — in a loop until
 * the request is done, and each write is its own undoable step. The prompt's
 * language guide moved to lib/agent/guide.ts, corrected against the parser and
 * the renderer, and is re-exported here where the tests have always found it.
 */

import { useVFSStore } from '../stores/vfsStore';
import type { VFSFile } from '../types/studio';
import type { SuppliedFiles, TurnBase } from './changeset';
import { isPrivatePath, resolveProjectPath } from './paths';
import { buildAgentSystemPrompt } from './agent/prompt';
import { discardAgentRuns, startAgentRun } from './agent/runAgent';

// The write checks live with the changeset that uses them; they are still
// reachable from here, where they were first written.
export { checkWrite, describeRefusal } from './changeset';
export type { SuppliedFile, SuppliedFiles, TurnBase, WriteRefusal } from './changeset';
export { JAVASCRIPT_APP_EXAMPLE, PYTHON_APP_EXAMPLE, PYTHON_TORCH_SECTION, PYTHON_TORCH_UNDECLARED } from './agent/guide';

// ---------------------------------------------------------------------------
// The single-shot reply format, still parsed: a model that falls back to it is
// understood (the agent's text protocol reads <softn-file> as write_file).
// ---------------------------------------------------------------------------

interface FileOp {
  /** The path as the reply wrote it; the changeset resolves and judges it. */
  path: string;
  content: string;
}

interface DeleteOp {
  path: string;
}

interface ReadOp {
  path: string;
}

export interface ParsedResponse {
  text: string;
  files: FileOp[];
  deletes: DeleteOp[];
  /** Files the model asks to see in full before it edits them. */
  reads: ReadOp[];
}

/**
 * Parse AI response text for file operation blocks.
 *
 * Supported formats:
 *   <softn-file path="pages/home.html">…content…</softn-file>
 *   <softn-delete path="old/file.html" />
 *   <softn-read path="logic/app.logic" />
 *
 * File and delete paths are kept as written: a path that is not a project
 * path is a refused record on the changeset, reported by name, not a block
 * that silently vanished. Read paths are resolved here, since a read is
 * answered from the VFS or not at all.
 */
export function parseAIResponse(raw: string): ParsedResponse {
  const files: FileOp[] = [];
  const deletes: DeleteOp[] = [];
  const reads: ReadOp[] = [];

  // Extract file blocks
  const fileRegex = /<softn-file\s+path="([^"]+)">([\s\S]*?)<\/softn-file>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(raw)) !== null) {
    const path = match[1].trim();
    if (!path) continue;
    const content = match[2].replace(/^\n/, '').replace(/\n$/, '');
    if (content.length === 0) continue; // skip empty files
    files.push({ path, content });
  }

  // Extract delete directives
  const deleteRegex = /<softn-delete\s+path="([^"]+)"\s*\/>/g;
  while ((match = deleteRegex.exec(raw)) !== null) {
    const path = match[1].trim();
    if (!path) continue;
    deletes.push({ path });
  }

  // Extract read requests
  const readRegex = /<softn-read\s+path="([^"]+)"\s*\/>/g;
  while ((match = readRegex.exec(raw)) !== null) {
    const verdict = resolveProjectPath(match[1].trim());
    if (!verdict.ok || verdict.private) continue;
    const path = verdict.path;
    if (!reads.some((r) => r.path === path)) reads.push({ path });
  }

  // Build the user-facing text by stripping the blocks
  let text = raw
    .replace(fileRegex, '')
    .replace(deleteRegex, '')
    .replace(readRegex, '')
    .trim();

  // Clean up excessive blank lines left after stripping
  text = text.replace(/\n{3,}/g, '\n\n');

  return { text, files, deletes, reads };
}

// ---------------------------------------------------------------------------
// A budgeted view of file contents (kept for callers that show files inline)
// ---------------------------------------------------------------------------

const MAX_CHARS_PER_FILE = 6000;
const CONTEXT_CHAR_BUDGET = 80000;

/**
 * The project's text files for the prompt, within a per-file and an overall
 * character budget, and an exact record of what went in. A file over the
 * per-file cap is shown truncated and labelled so; one past the overall
 * budget is listed by name and size but not shown. The limits are not
 * relaxed here: a file the model needs whole is asked for with
 * `<softn-read>`, and supplied complete in the next round.
 */
export function buildFileContents(
  files: Map<string, VFSFile>,
  maxPerFile: number = MAX_CHARS_PER_FILE,
  budget: number = CONTEXT_CHAR_BUDGET,
  complete: ReadonlySet<string> = new Set(),
): { text: string; supplied: SuppliedFiles } {
  const parts: string[] = [];
  const supplied: SuppliedFiles = new Map();
  const notShown: string[] = [];
  const binary: string[] = [];
  let totalLen = 0;

  for (const [path, file] of files) {
    // Skip builder/ internals — the AI can see the blueprint directly
    if (isPrivatePath(path)) continue;
    // Bytes are not shown, but they are named: a model that cannot see an
    // image, a font or a sound at all writes markup that pretends it is not
    // there, or asks for it with a read that can only fail.
    if (typeof file.content !== 'string') {
      binary.push(`${path} (${file.content.byteLength} bytes)`);
      continue;
    }

    const total = file.content.length;
    // A file asked for whole is whole, whatever the caps; that is the point of asking.
    const wantWhole = complete.has(path);
    if (!wantWhole && totalLen > budget) {
      notShown.push(`${path} (${total} characters)`);
      continue;
    }
    const isComplete = wantWhole || total <= maxPerFile;
    const shown = isComplete ? total : maxPerFile;
    const content = isComplete ? file.content : file.content.slice(0, maxPerFile);
    const label = isComplete
      ? `--- ${path} (complete, ${total} characters) ---`
      : `--- ${path} (TRUNCATED: first ${maxPerFile} of ${total} characters; not editable as a whole — request it with <softn-read path="${path}" />) ---`;
    parts.push(`${label}\n${content}${isComplete ? '' : '\n... (truncated)'}`);
    supplied.set(path, { path, complete: isComplete, version: file.version, shown, total });
    totalLen += content.length;
  }

  if (notShown.length > 0) {
    parts.push(`--- Files not shown (over the context budget; request one with <softn-read path="…" />) ---\n${notShown.join('\n')}`);
  }
  if (binary.length > 0) {
    parts.push(`--- Binary files (present in the project, not shown: their bytes are not text and cannot be read or written as a file block; reference them by path) ---\n${binary.join('\n')}`);
  }

  return { text: parts.length > 0 ? parts.join('\n\n') : '(no text files)', supplied };
}


/**
 * The system prompt an agent run starts with, and the version of every
 * project file at this moment. Nothing is "supplied" up front any more: the
 * agent reads files with read_file, and the run's own record of what it read
 * is what its writes are judged against.
 */
export function buildSystemPromptWithRecord(): { system: string } & TurnBase {
  const versions = new Map<string, number>();
  for (const [path, file] of useVFSStore.getState().files) versions.set(path, file.version);
  return { system: buildAgentSystemPrompt('anthropic'), supplied: new Map(), versions };
}

/** Start an agent run for the chat's latest message. */
export async function runAgentTurn(options: { kind?: 'build' | 'edit' } = {}): Promise<void> {
  await startAgentRun(options);
}

/** Abandon any run: the project is changing under the chat. */
export function abortAgentTurn(): void {
  discardAgentRuns();
}
