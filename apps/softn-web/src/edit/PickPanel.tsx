/**
 * The simple changes offered for an element picked on the running app: its
 * words, and its attributes that are plain values. Each is made as a change
 * to the source (./sourceEdits), shown in the editor above and handed to the
 * app like anything typed there. What cannot be written so that it reads back
 * as asked is not written, and the person is told to change it in the source.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fieldsOf, firstValue, type Field } from './pickFields';
import type { Picked } from './pick';
import type { EditSession } from './session';
import { readElement, withAttribute, withText, type PlainValue } from './sourceEdits';

interface PickPanelProps {
  session: EditSession;
  selection: Picked;
  /** How many times the picked place is drawn on the app now, and in how many places of the page it is put. */
  drawn: { times: number; places: number };
  /** Show its lines in the editor. */
  onShow: () => void;
  onDone: () => void;
  /** Counts the picks made from the keyboard: each puts the keyboard in the form's first field. */
  takeFocus?: number;
}

const REFUSED = 'That cannot be written here so that it reads as you typed it. Change it in the source above.';

/** An id for an element of the editor's own that nothing outside it can know beforehand. */
function unguessable(): string {
  const parts = new Uint32Array(4);
  crypto.getRandomValues(parts);
  return Array.from(parts, (part) => part.toString(36)).join('');
}

/**
 * A field for words or a number: what is typed is kept here, and written to
 * the source as it is typed. `onWrite` answers true when it was written, or
 * what to say when it was not (false for the usual sentence).
 */
function TextField({ label, value, number, list, onWrite }: { label: string; value: string; number?: boolean; list?: readonly string[]; onWrite: (text: string) => boolean | string }): React.ReactElement {
  const [typed, setTyped] = useState(value);
  const [refused, setRefused] = useState('');
  const [focused, setFocused] = useState(false);
  // What the source says, when it is changed from elsewhere (typed above, undone).
  useEffect(() => {
    if (!focused) setTyped(value);
  }, [value, focused]);
  // The list an input offers is found by id in the whole document, where an
  // app's own elements are too, and come first. A name an app could write on
  // an element of its own (`softn-edit-list-variant`) would let it choose
  // what the editor suggests. So the id is one it cannot know.
  const [listName] = useState(unguessable);
  const listId = list ? `softn-edit-list-${listName}` : undefined;
  return (
    <label className="softn-edit-field">
      <span>{label}</span>
      <input
        type={number ? 'number' : 'text'}
        value={typed}
        list={listId}
        spellCheck={false}
        aria-invalid={refused !== '' || undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setRefused('');
        }}
        onChange={(event) => {
          setTyped(event.target.value);
          const wrote = onWrite(event.target.value);
          setRefused(wrote === true ? '' : wrote || REFUSED);
        }}
      />
      {list && (
        <datalist id={listId}>
          {list.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {refused && <span className="softn-edit-field-note" role="alert">{refused}</span>}
    </label>
  );
}

export function PickPanel({ session, selection, drawn, onShow, onDone, takeFocus = 0 }: PickPanelProps): React.ReactElement {
  const [adding, setAdding] = useState('');
  const text = session.files.get(selection.file);
  const element = text !== undefined ? readElement(text, selection.nameStart) : null;
  const sectionRef = useRef<HTMLElement>(null);
  // Picked from the keyboard: the keyboard goes on to what can be changed.
  useEffect(() => {
    if (takeFocus === 0) return;
    const section = sectionRef.current;
    // Its first field; its first button where it has no field to change.
    (section?.querySelector<HTMLElement>('.softn-edit-fields input, .softn-edit-fields select') ?? section?.querySelector<HTMLElement>('button'))?.focus();
  }, [takeFocus]);

  if (text === undefined || !element) {
    return (
      <section ref={sectionRef} className="softn-edit-pick" aria-label="The picked element">
        <header className="softn-edit-pick-head">
          <strong>{`<${selection.tag}>`}</strong>
          <button type="button" className="softn-edit-btn" onClick={onDone}>
            Done
          </button>
        </header>
        <p className="softn-edit-pick-note">Its lines cannot be read as they are typed now. Mend them above, or pick it again.</p>
      </section>
    );
  }

  const line = text.slice(0, element.start).split('\n').length;
  const { written, more } = fieldsOf(element);

  /** Write a change to the source; false when it cannot be written as asked. */
  const write = (next: string | null, typing: boolean): boolean => {
    if (next === null) return false;
    if (typing) session.type(selection.file, next);
    else session.change(selection.file, next);
    return true;
  };
  const set = (name: string, value: PlainValue | undefined, typing = false): boolean => write(withAttribute(text, element, name, value), typing);

  const notes: string[] = [];
  if (element.repeated || drawn.times > Math.max(1, drawn.places)) {
    notes.push(`This is drawn once for each item of a list${drawn.times > 1 ? ` (${drawn.times} now)` : ''}. It is written once, so a change here changes every one.`);
  }
  if (drawn.places > 1) notes.push(`${selection.file} is put in ${drawn.places} places of the page. A change here changes each.`);
  if (selection.component) notes.push(`<${selection.tag}> is a component: what it draws is its own, and what is offered here is what the page writes on it.`);
  if (session.holding() && session.running().get(selection.file) !== text) notes.push('What you typed is not showing yet, so the app still shows it as it was.');

  const field = (item: Field): React.ReactElement => {
    const remove = (
      <button type="button" className="softn-edit-field-remove" aria-label={`Take ${item.name} off`} title={`Take ${item.name} off the element`} onClick={() => set(item.name, undefined)}>
        ×
      </button>
    );
    if (item.kind === 'b') {
      return (
        <div key={item.name} className="softn-edit-field-row">
          <label className="softn-edit-field softn-edit-field--check">
            <input type="checkbox" checked={item.value === true} onChange={(event) => set(item.name, event.target.checked)} />
            <span>{item.name}</span>
          </label>
          {remove}
        </div>
      );
    }
    if (item.kind === 'choice' && !item.open) {
      const options = item.options ?? [];
      const current = typeof item.value === 'string' ? item.value : String(item.value ?? '');
      return (
        <div key={item.name} className="softn-edit-field-row">
          <label className="softn-edit-field">
            <span>{item.name}</span>
            <select value={current} onChange={(event) => set(item.name, event.target.value)}>
              {!options.includes(current) && <option value={current}>{current}</option>}
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          {remove}
        </div>
      );
    }
    return (
      <div key={item.name} className="softn-edit-field-row">
        <TextField
          label={item.name}
          value={String(item.value ?? '')}
          number={item.kind === 'n'}
          list={item.kind === 'choice' ? item.options : undefined}
          onWrite={(typed) => {
            if (item.kind !== 'n') return set(item.name, typed, true);
            // A number field hands over nothing for what is not one: said as that, not as a problem with the source.
            if (typed.trim() === '') return `Type a number, or take ${item.name} off with the × beside it.`;
            const number = Number(typed);
            return Number.isFinite(number) ? set(item.name, number, true) : 'That is not a number.';
          }}
        />
        {remove}
      </div>
    );
  };

  return (
    <section ref={sectionRef} className="softn-edit-pick" aria-label="The picked element">
      <header className="softn-edit-pick-head">
        <strong>{`<${element.tag}>`}</strong>
        <button type="button" className="softn-edit-pick-where" onClick={onShow} title="Show its lines in the editor">
          {selection.file}, line {line}
        </button>
        <button type="button" className="softn-edit-btn" onClick={onDone}>
          Done
        </button>
      </header>
      {notes.map((note) => (
        <p key={note} className="softn-edit-pick-note">
          {note}
        </p>
      ))}
      <div className="softn-edit-fields">
        {element.text ? (
          <TextField key={`text@${selection.nameStart}`} label="Words" value={element.text.value} onWrite={(typed) => write(withText(text, element, typed), true)} />
        ) : (
          !element.selfClosing && (
            <p className="softn-edit-pick-note softn-edit-pick-note--wide">
              {element.keptLines
                ? 'Its text keeps its line breaks and spaces as they are written, which a field of one line would lose. It is changed in the source above.'
                : 'What is inside it is more than words (other elements, or values the app works out), so it is changed in the source above.'}
            </p>
          )
        )}
        {written.map(field)}
        {more.length > 0 && (
          <label className="softn-edit-field softn-edit-field--add">
            <span>Add</span>
            <select
              value={adding}
              onChange={(event) => {
                const chosen = more.find((item) => item.name === event.target.value);
                setAdding('');
                if (chosen) set(chosen.name, firstValue(chosen));
              }}
            >
              <option value="">An attribute…</option>
              {more.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {element.wired.length > 0 && (
        <p className="softn-edit-pick-note">Also written on it, and worked out by the app: {element.wired.join(', ')}. Those are changed in the source above.</p>
      )}
      {element.twice.length > 0 && (
        <p className="softn-edit-pick-note">
          Written on it twice: {element.twice.join(', ')}. The page reads the first of each, which is the one offered here. Take the second out in the source above.
        </p>
      )}
    </section>
  );
}
