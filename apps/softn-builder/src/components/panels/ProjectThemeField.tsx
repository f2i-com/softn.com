/**
 * The project's theme: light, dark, or whichever a visitor's device asks for.
 *
 * The setting was kept, written into an exported bundle and read by Preview,
 * and nothing in the editor could change it: a project was light unless the
 * bundle it was opened from said otherwise. It is offered among the page's
 * properties, beside the page's own `theme`, and with nothing selected,
 * where the panel had nothing to show.
 *
 * A page can pin a theme of its own over the project's, so the sentence
 * under the choice says which of the two the page is drawn in, as the App
 * component decides it (utils/drawnTheme.ts, themeSentence).
 */

import React from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useProjectStore } from '../../stores/projectStore';
import { themeSentence, useSystemSide } from '../../utils/drawnTheme';

const MODES = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'System' },
] as const;

const styles: Record<string, React.CSSProperties> = {
  group: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 4,
    padding: 3,
    borderRadius: 'var(--bl-radius)',
    background: 'var(--ink)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--line)',
  },
  choice: {
    padding: '6px 8px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 'var(--bl-radius-sm)',
    background: 'transparent',
    color: 'var(--dim)',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
  },
  // The one in force: the ink, not an accent, as a pressed toggle is elsewhere.
  chosen: {
    background: 'var(--ink-2)',
    borderColor: 'var(--line-strong)',
    color: 'var(--paper)',
  },
  note: {
    marginTop: 8,
    fontSize: 11.5,
    lineHeight: 1.5,
    color: 'var(--dim)',
  },
};

export function ProjectThemeField(): React.ReactElement {
  const themeMode = useProjectStore((state) => state.themeMode);
  const setThemeMode = useProjectStore((state) => state.setThemeMode);
  // The page's own `theme`, as it is written: the word, or an expression.
  const pageTheme = useCanvasStore((state) => {
    const page = state.elements.get(state.rootId);
    if (!page || page.props.theme === undefined) return undefined;
    return (page.expressionProps ?? []).includes('theme') ? `{${String(page.props.theme)}}` : String(page.props.theme);
  });
  const system = useSystemSide(themeMode === 'system');
  const written =
    pageTheme === undefined
      ? undefined
      : pageTheme.startsWith('{') && pageTheme.endsWith('}')
        ? { value: pageTheme.slice(1, -1), isExpression: true }
        : { value: pageTheme, isExpression: false };

  // The arrows move the choice, as they do in any group where one is picked.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = MODES.findIndex((entry) => entry.mode === themeMode);
    const next = MODES[(at + step + MODES.length) % MODES.length];
    setThemeMode(next.mode);
    event.currentTarget.querySelector<HTMLElement>(`[data-theme-mode="${next.mode}"]`)?.focus();
  };

  return (
    <div data-project-theme="">
      <div role="radiogroup" aria-label="Project theme" style={styles.group} onKeyDown={onKeyDown}>
        {MODES.map(({ mode, label }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={themeMode === mode}
            tabIndex={themeMode === mode ? 0 : -1}
            data-theme-mode={mode}
            style={{ ...styles.choice, ...(themeMode === mode ? styles.chosen : {}) }}
            onClick={() => setThemeMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.note} data-theme-outcome="">
        {themeSentence(themeMode, written, system)}
      </div>
    </div>
  );
}
