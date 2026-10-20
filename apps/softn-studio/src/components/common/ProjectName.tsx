import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { PROJECT_NAME_LIMIT, renameProject } from '../../lib/projectSession';

/**
 * A name being changed: Enter keeps it, Escape leaves it as it was.
 * `onRename` answers why a name is not taken, or null; until one is taken
 * the field stays open and says why. In a bar, leaving the field keeps a
 * changed name (`commitOnBlur`); in a list, where it has its own Save and
 * Cancel, leaving it does nothing.
 */
export function RenameField({
  name,
  label,
  onRename,
  onClose,
  commitOnBlur = false,
  actions = false,
  inputClassName,
}: {
  name: string;
  label: string;
  onRename: (next: string) => string | null | Promise<string | null>;
  onClose: () => void;
  commitOnBlur?: boolean;
  actions?: boolean;
  inputClassName?: string;
}): React.ReactElement {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (busy) return;
    if (value === name) {
      onClose();
      return;
    }
    setBusy(true);
    const refused = await onRename(value);
    setBusy(false);
    if (refused) setError(refused);
    else onClose();
  };

  return (
    <span className="st-rename">
      <span className="st-rename-row">
        <input
          ref={inputRef}
          className={inputClassName ?? 'st-rename-input'}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          value={value}
          maxLength={PROJECT_NAME_LIMIT + 20}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            // Not the Enter that confirms an input method's candidate.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          onBlur={() => {
            if (!commitOnBlur || busy) return;
            // A name that would be refused is left, as Escape leaves it, rather than kept open behind the person.
            if (value.trim() && value !== name) void submit();
            else onClose();
          }}
        />
        {actions && (
          <>
            <button type="button" className="st-btn st-btn-sm" onClick={() => void submit()} disabled={busy}>
              Save name
            </button>
            <button type="button" className="st-btn st-btn-sm st-btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </span>
      {error && (
        <span role="alert" className="st-rename-error">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * The open project's name in a header, and the way to rename it there. A
 * hosted editor's project is named by its host, so there it is only shown.
 */
export function ProjectNameControl({
  name,
  fallback,
  hosted,
  textClassName,
  textStyle,
}: {
  name: string;
  fallback: string;
  hosted: boolean;
  textClassName?: string;
  textStyle?: React.CSSProperties;
}): React.ReactElement {
  const [renaming, setRenaming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);
  // A rename kept with Enter or left with Escape takes the field away with the focus in it, and
  // the focus fell to the page. It goes back to the name's button, unless the field closed
  // because the focus went somewhere else (a click away keeps the name and the click).
  useEffect(() => {
    if (renaming || !closed.current) return;
    closed.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) buttonRef.current?.focus();
  }, [renaming]);
  const shown = name || fallback;
  const text = (
    <span className={textClassName} style={textStyle}>
      {shown}
    </span>
  );
  if (hosted) return text;
  if (renaming) {
    return (
      <RenameField
        name={name}
        label="Project name"
        commitOnBlur
        onRename={renameProject}
        onClose={() => {
          closed.current = true;
          setRenaming(false);
        }}
      />
    );
  }
  return (
    <button ref={buttonRef} type="button" className="st-project-name-btn" aria-label={`Rename ${shown}`} title="Rename the project" onClick={() => setRenaming(true)}>
      {text}
      <Icon name="edit" size={13} />
    </button>
  );
}
