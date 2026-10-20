import React from 'react';
import { Icon } from '../common/Icon';
import type { ValidationError } from '../../types/studio';
import { PAGE_PARSE } from '../../lib/pageDiagnostics';
import { isSyntaxError, LOGIC_SYNTAX } from '../../lib/logicCheck';

/** What stopped the app from being drawn: its logic did not compile, its page did not parse, or something failed as it ran. */
export type PreviewErrorKind = 'logic' | 'parse' | 'run';

export function previewErrorKind(error: Error): PreviewErrorKind {
  if (isSyntaxError(`${error.name} ${error.message}`)) return 'logic';
  if (error.name === 'SoftNParseError') return 'parse';
  return 'run';
}

const TITLES: Record<PreviewErrorKind, string> = {
  logic: 'The logic does not compile.',
  parse: 'This page does not parse.',
  run: 'The app stopped with an error.',
};

/** A problem's place, as the problem list shows it. */
const where = (problem: ValidationError) => `${problem.file}${problem.line ? `:${problem.line}` : ''}`;

/**
 * The preview's own panel for an app the renderer could not draw, in place of
 * the renderer's, which titled every failure "Parse Error" (a function that
 * did not compile among them) and quoted the engine, which names no file: the
 * logic it compiles is the app's files joined. The check has placed what it
 * found (lib/pageDiagnostics.ts, lib/logicCheck.ts), so the panel says where,
 * as the problem list does, with the engine's own words below.
 */
export function PreviewError({ error, problems, page }: { error: Error; problems: ValidationError[]; page: string | null }): React.ReactElement {
  const kind = previewErrorKind(error);
  const placed = problems.filter((problem) => problem.level === 'error' && problem.type === (kind === 'parse' ? PAGE_PARSE : LOGIC_SYNTAX));
  const said = 'format' in error && typeof (error as { format?: unknown }).format === 'function'
    ? (error as unknown as { format: () => string }).format()
    : error.message;
  return (
    <div className="st-state-panel" role="alert" data-preview-error={kind}>
      <h3 className="st-state-title">
        <span className="st-state-mark"><Icon name="alert-circle" size={16} /></span>
        {TITLES[kind]}
      </h3>
      {kind !== 'run' && placed.length > 0 ? (
        <ul className="st-preview-error-places">
          {placed.map((problem, i) => (
            <li key={`${where(problem)}:${i}`}>
              <code>{where(problem)}</code> {problem.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="st-state-message">
          {page && kind === 'parse' ? <><code>{page}</code>: </> : null}
          {said}
        </p>
      )}
      <p className="st-state-note">
        {kind === 'run'
          ? 'Restart the preview once it is fixed, or ask the AI to fix it.'
          : 'Run and Publish wait until it is fixed. Fix the file named above, or ask the AI to.'}
      </p>
      {kind !== 'run' && placed.length > 0 && (
        <details>
          <summary>What the {kind === 'logic' ? 'engine' : 'parser'} said</summary>
          <pre className="st-preview-error-said">{said}</pre>
        </details>
      )}
    </div>
  );
}
