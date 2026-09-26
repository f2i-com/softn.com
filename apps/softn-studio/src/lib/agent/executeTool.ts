/**
 * Running one tool call against the project.
 *
 * Every write goes through the rules the single-shot changeset applied to a
 * reply's file blocks, adapted to tools: a path must be a project path and
 * not private editor state or another spelling of an existing file; an
 * existing file may be replaced only after it was read whole in this run, and
 * edited only after it was read at all, and neither if it changed since (the
 * person may be editing too); a `.py` file must have a name Python can import;
 * bytes are not written from text. Each write is its own VFS transaction, so
 * every step can be undone on its own and the run reverted as a whole.
 */

import { classifyAsset, pythonModuleName } from '@softn/core';
import type { Blueprint, VFSFile } from '../../types/studio';
import { useVFSStore, type VFSChangeRecord } from '../../stores/vfsStore';
import { checkWrite, type SuppliedFiles } from '../changeset';
import { appliedMigrationRefusal } from './appliedMigrations';
import { findAlias, isPrivatePath, resolveProjectPath } from '../paths';
import { formatCheckReport, type AgentEnvironment, type RunFunctionRequest } from './appCheck';
import { lineDiff, type LineDiff } from './diff';
import { lookupComponents, readDocs } from './knowledge';
import type { AgentToolCall, CheckReport, PlanItem } from './types';

export interface ToolContext {
  /** What the model has read in this run, and at which version: the "seen" rule. */
  seen: SuppliedFiles;
  env: AgentEnvironment;
  blueprint: Blueprint | null;
  /** A fresh transaction id for a write. */
  newTransactionId(): string;
}

export type ToolControl =
  | { kind: 'plan'; items: PlanItem[] }
  | { kind: 'ask'; question: string }
  | { kind: 'finish'; summary: string };

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** The path or subject, for the timeline row. */
  subject: string;
  changed?: boolean;
  transactionId?: string;
  diff?: LineDiff[];
  check?: CheckReport;
  control?: ToolControl;
}

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 40_000;

const fail = (subject: string, content: string): ToolOutcome => ({ content, isError: true, subject });

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function kindOf(path: string): string {
  if (/\.ui$/i.test(path)) return 'page';
  if (/\.(logic|py)$/i.test(path)) return 'logic';
  if (/\.xdb$/i.test(path)) return 'data';
  if (path === 'manifest.json' || path === 'permission.json' || /\.json$/i.test(path)) return 'config';
  if (/\.(html?|css|js|ts|tsx|md|txt)$/i.test(path)) return 'text';
  return classifyAsset(path).binary ? 'asset' : 'text';
}

function sizeOf(file: VFSFile): string {
  const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content).length : file.content.byteLength;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

/** The file tree the prompt and list_files show. */
export function describeTree(files: Map<string, VFSFile>, prefix = ''): string {
  const paths = [...files.keys()].filter((p) => !isPrivatePath(p) && p.startsWith(prefix)).sort();
  if (paths.length === 0) return prefix ? `(no files under ${prefix})` : '(no files yet)';
  return paths
    .map((p) => {
      const file = files.get(p)!;
      const lines = typeof file.content === 'string' ? `, ${lineCount(file.content)} lines` : '';
      return `${p}  (${kindOf(p)}, ${sizeOf(file)}${lines})`;
    })
    .join('\n');
}

/** Resolve a path the model wants to write, or say why it may not. */
function resolveWritable(raw: string | undefined, files: Map<string, VFSFile>, text: boolean): { ok: true; path: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: 'A path is required.' };
  const verdict = resolveProjectPath(raw.trim());
  if (!verdict.ok) return { ok: false, reason: `${raw} is not a project path: ${verdict.reason}.` };
  if (verdict.private) return { ok: false, reason: `${verdict.path} is private editor state (builder/), which you do not write.` };
  const alias = findAlias(verdict.path, files.keys());
  if (alias !== null) return { ok: false, reason: `${raw} is the same file as the project's ${alias} on a case-insensitive disk. Use ${alias}.` };
  if (text && classifyAsset(verdict.path).binary) {
    return { ok: false, reason: `${verdict.path} is a binary format (${classifyAsset(verdict.path).mime}); files are written as text, so a binary asset cannot be written. Reference assets that exist, or use an SVG or text format.` };
  }
  if (/\.py$/i.test(verdict.path)) {
    try {
      pythonModuleName(verdict.path);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, path: verdict.path };
}

/** Resolve a path the model wants to read or act on; it must exist. */
function resolveExisting(raw: string | undefined, files: Map<string, VFSFile>): { ok: true; path: string; file: VFSFile } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: 'A path is required.' };
  const verdict = resolveProjectPath(raw.trim().replace(/^\.\//, ''));
  if (!verdict.ok) return { ok: false, reason: `${raw} is not a project path: ${verdict.reason}.` };
  if (verdict.private) return { ok: false, reason: `${verdict.path} is private editor state, not part of the app.` };
  const file = files.get(verdict.path);
  if (!file) {
    const alias = findAlias(verdict.path, files.keys());
    if (alias) return { ok: false, reason: `There is no ${verdict.path}; did you mean ${alias}?` };
    const near = [...files.keys()].filter((p) => !isPrivatePath(p) && p.split('/').pop() === verdict.path.split('/').pop());
    return { ok: false, reason: `There is no file ${verdict.path}.${near.length > 0 ? ` Files with that name: ${near.join(', ')}.` : ' Use list_files to see the project.'}` };
  }
  return { ok: true, path: verdict.path, file };
}

/** Why a write the "seen" rule refuses is refused, in words for the model. */
function describeSeenRefusal(path: string, refusal: NonNullable<ReturnType<typeof checkWrite>>, tool: string): string {
  switch (refusal.kind) {
    case 'unseen':
      return `${path} exists and you have not read it in this run. Call read_file on it first${tool === 'write_file' ? ', or use edit_file for a change' : ''}.`;
    case 'partial':
      return `You have read only part of ${path}. write_file replaces the whole file, so read it whole first (read_file without a line range), or change it with edit_file.`;
    case 'stale':
      return `${path} changed since you read it (v${refusal.suppliedVersion} → v${refusal.currentVersion}) — the person may have edited it. Read it again before changing it.`;
  }
}

/** Commit records as one transaction and refresh what the model is taken to have seen. */
function commit(records: VFSChangeRecord[], ctx: ToolContext, seenAfter: Array<{ path: string; whole: boolean }>): string {
  const id = ctx.newTransactionId();
  const vfs = useVFSStore.getState();
  vfs.applyTransaction(records, 'ai', id);
  const files = useVFSStore.getState().files;
  for (const record of records) if (record.op === 'delete') ctx.seen.delete(record.path);
  for (const { path, whole } of seenAfter) {
    const file = files.get(path);
    if (!file || typeof file.content !== 'string') continue;
    const previous = ctx.seen.get(path);
    const complete = whole || (previous?.complete ?? false);
    ctx.seen.set(path, { path, complete, version: file.version, shown: complete ? file.content.length : previous?.shown ?? 0, total: file.content.length });
  }
  return id;
}

/** The closest lines of `content` to the first line of a failed `old_string`, numbered. */
function nearestLines(content: string, oldString: string): string {
  const lines = content.split('\n');
  const needle = oldString.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!needle || lines.length === 0) return '';
  const grams = (s: string) => {
    const set = new Map<string, number>();
    const t = s.toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 1; i++) set.set(t.slice(i, i + 2), (set.get(t.slice(i, i + 2)) ?? 0) + 1);
    return set;
  };
  const target = grams(needle);
  const targetSize = [...target.values()].reduce((a, b) => a + b, 0) || 1;
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    const g = grams(line.trim());
    let common = 0;
    for (const [k, n] of g) common += Math.min(n, target.get(k) ?? 0);
    const size = [...g.values()].reduce((a, b) => a + b, 0) || 1;
    const score = (2 * common) / (size + targetSize);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  if (best < 0 || bestScore < 0.3) return '';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + 3);
  return lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(4)}| ${l}`).join('\n');
}

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join('\n');
}

export async function executeTool(call: AgentToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const input = call.input;
  if (call.parseError) return fail(call.name, call.parseError);
  const files = useVFSStore.getState().files;

  switch (call.name) {
    case 'list_files': {
      const prefix = str(input, 'prefix') ?? '';
      return { content: describeTree(files, prefix), isError: false, subject: prefix || 'project' };
    }

    case 'read_file': {
      const found = resolveExisting(str(input, 'path'), files);
      if (!found.ok) return fail(str(input, 'path') ?? '', found.reason);
      const { path, file } = found;
      if (typeof file.content !== 'string') {
        return { content: `${path} is a binary file (${classifyAsset(path).mime}, ${sizeOf(file)}). Its bytes are not text; reference it by path.`, isError: false, subject: path };
      }
      const lines = file.content.split('\n');
      const total = lines.length;
      const startRaw = Number(input.start_line);
      const endRaw = Number(input.end_line);
      let start = Number.isFinite(startRaw) && startRaw >= 1 ? Math.floor(startRaw) : 1;
      let end = Number.isFinite(endRaw) && endRaw >= 1 ? Math.floor(endRaw) : total;
      if (start > total) return fail(path, `${path} has ${total} line(s); start_line ${start} is past the end.`);
      end = Math.min(end, total, start + MAX_READ_LINES - 1);
      start = Math.min(start, end);
      let slice = lines.slice(start - 1, end);
      let text = numbered(slice, start);
      if (text.length > MAX_READ_CHARS) {
        // Very long lines: cut by characters, and say where.
        let chars = 0;
        let n = 0;
        while (n < slice.length && chars + slice[n].length < MAX_READ_CHARS) chars += slice[n++].length + 1;
        slice = slice.slice(0, Math.max(1, n));
        end = start + slice.length - 1;
        text = numbered(slice, start);
      }
      const whole = start === 1 && end === total;
      const previous = ctx.seen.get(path);
      const stillCurrent = previous?.version === file.version;
      ctx.seen.set(path, {
        path,
        complete: whole || (stillCurrent && previous.complete),
        version: file.version,
        shown: whole ? file.content.length : slice.join('\n').length,
        total: file.content.length,
      });
      const header = whole ? `${path} (${total} lines, complete)` : `${path} lines ${start}–${end} of ${total}${end < total ? ` — read on with start_line ${end + 1}` : ''}`;
      return { content: `${header}\n${text}`, isError: false, subject: path };
    }

    case 'search_files': {
      const pattern = str(input, 'pattern');
      if (!pattern) return fail('search', 'A pattern is required.');
      const useRegex = input.regex !== false;
      let re: RegExp;
      try {
        re = new RegExp(useRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (err) {
        return fail(pattern, `The pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}. Pass regex: false to search for plain text.`);
      }
      const prefix = str(input, 'path_prefix') ?? '';
      const hits: string[] = [];
      let more = 0;
      for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (isPrivatePath(path) || !path.startsWith(prefix) || typeof file.content !== 'string') continue;
        file.content.split('\n').forEach((line, index) => {
          if (!re.test(line)) return;
          if (hits.length < 50) hits.push(`${path}:${index + 1}: ${line.trim().slice(0, 200)}`);
          else more++;
        });
      }
      return { content: hits.length === 0 ? `No matches for ${pattern}.` : `${hits.join('\n')}${more > 0 ? `\n… ${more} more match(es)` : ''}`, isError: false, subject: pattern };
    }

    case 'write_file': {
      const content = typeof input.content === 'string' ? input.content : undefined;
      const target = resolveWritable(str(input, 'path'), files, true);
      if (!target.ok) return fail(str(input, 'path') ?? '', target.reason);
      if (content === undefined) return fail(target.path, 'content is required: the whole file as a string.');
      const current = files.get(target.path);
      if (current && typeof current.content !== 'string') return fail(target.path, `${target.path} is a binary file and cannot be replaced with text.`);
      const applied = appliedMigrationRefusal(target.path, 'replace', content);
      if (applied) return fail(target.path, applied);
      const refusal = checkWrite(target.path, ctx.seen, current, 'replace');
      if (refusal) return fail(target.path, describeSeenRefusal(target.path, refusal, 'write_file'));
      const before = current && typeof current.content === 'string' ? current.content : null;
      if (before === content) return { content: `${target.path} already has exactly this content; nothing changed.`, isError: false, subject: target.path };
      const transactionId = commit([{ op: current ? 'update' : 'create', path: target.path, content }], ctx, [{ path: target.path, whole: true }]);
      const diff = lineDiff(target.path, before, content);
      return {
        content: `${current ? 'Replaced' : 'Created'} ${target.path} (${lineCount(content)} lines, +${diff.added} −${diff.removed}).`,
        isError: false,
        subject: target.path,
        changed: true,
        transactionId,
        diff: [diff],
      };
    }

    case 'edit_file': {
      const found = resolveExisting(str(input, 'path'), files);
      if (!found.ok) return fail(str(input, 'path') ?? '', found.reason);
      const { path, file } = found;
      if (typeof file.content !== 'string') return fail(path, `${path} is a binary file; it cannot be edited as text.`);
      const applied = appliedMigrationRefusal(path, 'edit');
      if (applied) return fail(path, applied);
      const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
      const newString = typeof input.new_string === 'string' ? input.new_string : undefined;
      if (oldString === undefined || newString === undefined) return fail(path, 'old_string and new_string are both required.');
      if (oldString.length === 0) return fail(path, 'old_string is empty. To add to a file, include the neighbouring lines in old_string; to create a file, use write_file.');
      if (oldString === newString) return fail(path, 'old_string and new_string are the same; nothing would change.');
      const refusal = checkWrite(path, ctx.seen, file, 'edit');
      if (refusal) return fail(path, describeSeenRefusal(path, refusal, 'edit_file'));

      const content = file.content;
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
        const whitespaceOnly = squash(content).includes(squash(oldString));
        const near = nearestLines(content, oldString);
        return fail(
          path,
          `old_string was not found in ${path}.${whitespaceOnly ? ' It matches if whitespace is ignored: check the indentation and line breaks, which must be exact.' : ''}${near ? `\nThe closest lines are:\n${near}` : ''}\nRead the file again if you are unsure of its current text.`,
        );
      }
      const replaceAll = input.replace_all === true;
      if (count > 1 && !replaceAll) {
        const at: number[] = [];
        let index = content.indexOf(oldString);
        while (index !== -1 && at.length < 10) {
          at.push(content.slice(0, index).split('\n').length);
          index = content.indexOf(oldString, index + 1);
        }
        return fail(path, `old_string matches ${count} places in ${path} (lines ${at.join(', ')}). Include more surrounding lines to make it unique, or pass replace_all: true to change every one.`);
      }
      const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
      const transactionId = commit([{ op: 'update', path, content: next }], ctx, [{ path, whole: false }]);
      const diff = lineDiff(path, content, next);
      return {
        content: `Edited ${path}: replaced ${replaceAll ? `${count} occurrence(s)` : '1 occurrence'} (+${diff.added} −${diff.removed} lines; now ${lineCount(next)} lines).`,
        isError: false,
        subject: path,
        changed: true,
        transactionId,
        diff: [diff],
      };
    }

    case 'delete_file': {
      const found = resolveExisting(str(input, 'path'), files);
      if (!found.ok) return fail(str(input, 'path') ?? '', found.reason);
      const applied = appliedMigrationRefusal(found.path, 'delete');
      if (applied) return fail(found.path, applied);
      // A delete decided on content that has since changed is decided on old content.
      const read = ctx.seen.get(found.path);
      if (read && read.version !== found.file.version) {
        return fail(found.path, describeSeenRefusal(found.path, { kind: 'stale', suppliedVersion: read.version, currentVersion: found.file.version }, 'delete_file'));
      }
      const before = typeof found.file.content === 'string' ? found.file.content : null;
      const transactionId = commit([{ op: 'delete', path: found.path }], ctx, []);
      return {
        content: `Deleted ${found.path}.`,
        isError: false,
        subject: found.path,
        changed: true,
        transactionId,
        diff: before !== null ? [lineDiff(found.path, before, null)] : undefined,
      };
    }

    case 'rename_file': {
      const from = resolveExisting(str(input, 'from'), files);
      if (!from.ok) return fail(str(input, 'from') ?? '', from.reason);
      const applied = appliedMigrationRefusal(from.path, 'rename');
      if (applied) return fail(from.path, applied);
      const to = resolveWritable(str(input, 'to'), files, false);
      if (!to.ok) return fail(str(input, 'to') ?? '', to.reason);
      if (to.path === from.path) return fail(from.path, 'from and to are the same path.');
      if (files.has(to.path)) return fail(to.path, `${to.path} already exists. Delete it first, or choose another name.`);
      const transactionId = commit(
        [
          { op: 'delete', path: from.path },
          { op: 'create', path: to.path, content: from.file.content },
        ],
        ctx,
        [{ path: to.path, whole: ctx.seen.get(from.path)?.complete ?? false }],
      );
      return {
        content: `Renamed ${from.path} to ${to.path}. Update references to the old path (imports, <logic src>, manifest.json).`,
        isError: false,
        subject: `${from.path} → ${to.path}`,
        changed: true,
        transactionId,
      };
    }

    case 'check_app': {
      const report = await ctx.env.checkApp(files, { page: str(input, 'page'), blueprint: ctx.blueprint });
      return { content: formatCheckReport(report), isError: false, subject: report.page ?? 'app', check: report };
    }

    case 'inspect_preview': {
      const result = await ctx.env.inspectPreview(files, str(input, 'page'));
      return { content: result.text, isError: !result.ok, subject: str(input, 'page') ?? 'main page' };
    }

    case 'run_app_function': {
      const name = str(input, 'name');
      if (!name) return fail('function', 'name is required: the function to call.');
      const args = Array.isArray(input.args) ? input.args : [];
      const setup = Array.isArray(input.setup_calls)
        ? (input.setup_calls.filter((c) => c && typeof c === 'object' && !Array.isArray(c)) as NonNullable<RunFunctionRequest['setup_calls']>)
        : [];
      const result = await ctx.env.runFunction(files, { name, args, setup_calls: setup, page: str(input, 'page') });
      return { content: result.text, isError: !result.ok, subject: `${name}()` };
    }

    case 'lookup_components': {
      const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : typeof input.names === 'string' ? [input.names] : [];
      if (names.length === 0) return fail('components', 'names is required: a list of component names, e.g. ["Button", "Table"].');
      const result = await lookupComponents(names);
      return { content: result.text, isError: !result.ok, subject: names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '') };
    }

    case 'read_docs': {
      const topic = str(input, 'topic');
      if (!topic) return fail('docs', 'topic is required: a page slug from the docs index, optionally with #section.');
      const result = await readDocs(topic);
      return { content: result.text, isError: !result.ok, subject: topic };
    }

    case 'update_plan': {
      const raw = Array.isArray(input.items) ? input.items : [];
      const items: PlanItem[] = raw
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i) => ({
          text: String(i.text ?? '').slice(0, 140),
          status: (i.status === 'done' || i.status === 'active' ? i.status : 'pending') as PlanItem['status'],
        }))
        .filter((i) => i.text.trim().length > 0)
        .slice(0, 12);
      if (items.length === 0) return fail('plan', 'items is required: [{ "text": "…", "status": "pending" | "active" | "done" }].');
      return { content: `Plan updated (${items.filter((i) => i.status === 'done').length}/${items.length} done).`, isError: false, subject: `${items.filter((i) => i.status === 'done').length}/${items.length} done`, control: { kind: 'plan', items } };
    }

    case 'ask_user': {
      const question = str(input, 'question')?.trim();
      if (!question) return fail('question', 'question is required.');
      return { content: '', isError: false, subject: question.slice(0, 80), control: { kind: 'ask', question } };
    }

    case 'finish': {
      const summary = str(input, 'summary')?.trim() || 'Done.';
      return { content: 'Finished.', isError: false, subject: '', control: { kind: 'finish', summary } };
    }

    default:
      return fail(call.name, `There is no tool called ${call.name}. The tools are: list_files, read_file, search_files, write_file, edit_file, delete_file, rename_file, check_app, inspect_preview, run_app_function, lookup_components, read_docs, update_plan, ask_user, finish.`);
  }
}
