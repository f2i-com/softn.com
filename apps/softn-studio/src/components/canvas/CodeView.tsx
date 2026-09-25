import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LANGUAGE_LABEL, languageForPath, tokenizeLines, type CodeLanguage } from '@softn/components/highlight';
import { Icon } from '../common/Icon';
import '../../styles/code.css';

/** Past this size the source is shown as plain text: highlighting it would stall the tab for little gain. */
const HIGHLIGHT_LIMIT = 400_000;

interface CodeViewProps {
  source: string;
  /** The file's path; its extension picks the language. */
  path: string;
  /** Overrides the language the path implies. */
  language?: CodeLanguage;
}

/**
 * A file's source, read-only, with line numbers and syntax colours.
 *
 * Every token is a React text node — the tokenizer returns strings, never
 * markup — so whatever the file contains is shown as text. Line numbers are
 * drawn by a CSS counter, so selecting and copying the code copies the code
 * only. Studio is AI-first: changes are asked for in the chat, and this view
 * is for reading what was written.
 */
export function CodeView({ source, path, language }: CodeViewProps): React.ReactElement {
  const lang = language ?? languageForPath(path);
  const lines = useMemo(
    () => tokenizeLines(source, source.length > HIGHLIGHT_LIMIT ? 'plain' : lang),
    [source, lang],
  );
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);
  useEffect(() => setCopied('idle'), [source]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied('idle'), 1800);
  };

  const name = path.split('/').pop() ?? path;
  // Wide enough for the largest line number, so the code column never shifts.
  const gutter = `${String(lines.length).length + 1}ch`;

  return (
    <div className="st-codeview" data-language={lang}>
      <div className="st-codeview-bar">
        <span className="st-codeview-lang">{LANGUAGE_LABEL[lang]}</span>
        <span className="st-codeview-meta">
          {lines.length.toLocaleString()} line{lines.length === 1 ? '' : 's'}
          {source.length > HIGHLIGHT_LIMIT ? ', too large to colour' : ''}
        </span>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-ghost st-codeview-copy"
          onClick={() => void copy()}
          aria-label={`Copy the source of ${name}`}
        >
          <Icon name={copied === 'copied' ? 'check' : 'copy'} size={14} />
          <span aria-live="polite">{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</span>
        </button>
      </div>
      <pre
        className="st-codeview-body"
        tabIndex={0}
        aria-label={`Source of ${name}`}
        style={{ '--st-gutter': gutter } as React.CSSProperties}
      >
        <code>
          {lines.map((line, index) => (
            <span className="st-code-line" key={index}>
              {line.map((token, t) =>
                token.kind === 'plain' ? (
                  <React.Fragment key={t}>{token.text}</React.Fragment>
                ) : (
                  <span key={t} className={`tk-${token.kind}`}>{token.text}</span>
                ),
              )}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
