import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LANGUAGE_LABEL, languageForPath } from '@softn/components/highlight';
import { Icon } from '../common/Icon';
import { CodeView } from './CodeView';
import { useAIStore } from '../../stores/aiStore';
import { useEditStore } from '../../stores/editStore';
import { useVFSStore } from '../../stores/vfsStore';
import { beginHandEdit, confirmLeaveDraft, handEditRefusal, reloadHandEdit, saveHandEdit, type HandSave } from '../../lib/handEdit';
import '../../styles/code.css';

type Refused = Extract<HandSave, { ok: false }>;

/**
 * A project file in the code view: its source to read, or, once Edit is
 * pressed, an editor of it. The draft is the store's (stores/editStore.ts),
 * so it is this file's editor that shows whenever the draft is of this file,
 * whatever redrew the canvas in between.
 */
export function CodeFile({ path, source }: { path: string; source: string | null }): React.ReactElement | null {
  const editing = useEditStore((s) => s.draft?.path === path);
  const file = useVFSStore((s) => s.files.get(path));
  // After the editor closes, the keyboard goes back to Edit, where it came from.
  const [returned, setReturned] = useState(false);
  useEffect(() => setReturned(false), [path]);
  if (editing) return <FileEditor path={path} onClose={() => setReturned(true)} />;
  if (source === null) return null;
  return (
    <CodeView
      path={path}
      source={source}
      edit={{ begin: () => { setReturned(false); beginHandEdit(path); }, refusal: handEditRefusal(path, file), takeFocus: returned }}
    />
  );
}

/**
 * The editor: the file's text in a plain text box in the mono face, with Save
 * and Cancel. No editor library, and no line numbers or colours while
 * editing; the code view has both again the moment the editor closes.
 *
 * The keyboard is not held. Tab types two spaces, as it has to in an editor
 * of indented text, and the ways out do not need it: Shift+Tab steps back to
 * Save and Cancel, Ctrl+S (or ⌘S) saves, Escape cancels. Cancel asks before it
 * discards anything.
 *
 * Every refusal of a save is said in an alert, with what can be done about
 * it; nothing is written until a save is accepted (lib/handEdit.ts).
 */
export function FileEditor({ path, onClose }: { path: string; onClose(): void }): React.ReactElement | null {
  const draft = useEditStore((s) => s.draft);
  const change = useEditStore((s) => s.change);
  const running = useAIStore((s) => s.agentState === 'building');
  const [refused, setRefused] = useState<Refused | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const whyId = useId();
  const name = path.split('/').pop() ?? path;
  const unsaved = draft !== null && draft.text !== draft.baseText;

  useEffect(() => {
    area.current?.focus();
  }, []);

  // A refusal for a run that was working says nothing once the run has stopped.
  useEffect(() => {
    if (!running) setRefused((current) => (current?.kind === 'running' ? null : current));
  }, [running]);

  const save = useCallback((options?: { evenIfNotJson?: boolean }) => {
    const outcome = saveHandEdit(options);
    if (outcome.ok) onClose();
    else setRefused(outcome);
  }, [onClose]);

  const cancel = useCallback(() => {
    if (confirmLeaveDraft()) onClose();
    else area.current?.focus();
  }, [onClose]);

  if (!draft || draft.path !== path) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Two spaces where the caret is (or in place of what is selected), through the
      // browser's own editing where it has it, so that Ctrl+Z takes them back.
      event.preventDefault();
      const box = event.currentTarget;
      if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, '  ')) {
        const { selectionStart: start, selectionEnd: end, value } = box;
        change(`${value.slice(0, start)}  ${value.slice(end)}`);
        requestAnimationFrame(() => box.setSelectionRange(start + 2, start + 2));
      }
    }
  };

  const dismiss = () => {
    setRefused(null);
    area.current?.focus();
  };

  return (
    <div className="st-codeview st-fileedit" data-language={languageForPath(path)}>
      <div className="st-codeview-bar">
        <span className="st-codeview-lang">{LANGUAGE_LABEL[languageForPath(path)]}</span>
        <span className="st-codeview-meta" role="status">
          Editing {path}{unsaved ? ', not saved' : ''}
          {running && <span id={whyId}> · The AI is working: save when the run stops. What you type is kept.</span>}
        </span>
        <button type="button" className="st-btn st-btn-sm st-btn-ghost" onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          onClick={() => save()}
          disabled={running}
          aria-describedby={running ? whyId : undefined}
          title="Save (Ctrl+S)"
        >
          <Icon name="save" size={14} />
          <span>Save</span>
        </button>
      </div>
      {refused && (
        <div className="st-fileedit-refused" role="alert">
          <p>{refused.message}</p>
          <div className="st-fileedit-choices">
            {refused.kind === 'changed' && (
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => {
                  if (reloadHandEdit()) dismiss();
                }}
              >
                Reload the file
              </button>
            )}
            {refused.kind === 'not-json' && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => save({ evenIfNotJson: true })}>
                Save it as it is
              </button>
            )}
            <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={dismiss}>
              Keep editing
            </button>
          </div>
        </div>
      )}
      <textarea
        ref={area}
        className="st-fileedit-area"
        aria-label={`Edit ${path}`}
        value={draft.text}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        data-file={name}
      />
    </div>
  );
}
