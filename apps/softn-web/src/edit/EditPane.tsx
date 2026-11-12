/**
 * The editor for a running app: its source beside it, changed while it runs.
 *
 * Fetched when a person presses Edit on the bar over an app, and not before.
 * It is the runtime's own: drawn outside the app's box, opened by the person
 * and by nothing else, and what it knows of the app's elements is kept in the
 * runtime's memory, not on the page (core's edit marks). What it does is in
 * ./session (the files, and handing changes to the app) and ./pick (from an
 * element to the lines that drew it); this is what a person sees of them.
 *
 * Beside the app on a wide screen, where the edge between the two can be
 * dragged; a sheet over the lower part of the screen on a narrow one, folded
 * to its bar and back with "App" and "Editor".
 */

import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CodeEditorProps } from '@softn/components/editors';
import { handoffUrl, stageBundleHandoff } from '@softn/bundle-format/handoff';
import { createEditMarks } from '@softn/core/edit';
import type { OpenTab } from '../lib/openBundle';
import { downloadBundle } from './bundle';
import type { EditHost } from './host';
import { drawnNow, outlineOf, pickAt, tracePage, type Picked, type TracedPage } from './pick';
import { PickOverlay } from './pickOverlay';
import { PickPanel } from './PickPanel';
import { editorPlace, editorWidth, noteEditorPlace, noteEditorWidth } from './place';
import { EditSession, type FileEntry } from './session';
import { isComponentTag } from './pickFields';
import { elementAtCaret, movedPlace, readElement } from './sourceEdits';
import './EditPane.css';

interface EditPaneProps {
  tabId: string;
  /** The tab as it is drawn now: the pane is drawn again when it changes. */
  tab: OpenTab;
  host: EditHost;
  /** Its app is the one on screen. Kept, and not drawn, while it is not. */
  shown: boolean;
}

/** An element picked on the app: where it is in the text as typed, and in the text that is running. */
interface Selection extends Picked {
  /** Where its name begins in the running text, which is where the app's elements are traced to. */
  shownStart: number;
}

const GROUPS: Array<{ kind: FileEntry['kind']; label: string }> = [
  { kind: 'page', label: 'Pages' },
  { kind: 'logic', label: 'Logic' },
  { kind: 'style', label: 'Styles' },
  { kind: 'data', label: 'Data' },
  // What the app is: its manifest, and what it asks permission for.
  { kind: 'app', label: 'App' },
  { kind: 'other', label: 'Other text' },
  { kind: 'picture', label: 'Pictures and other files' },
];

const NEW_PAGE = '<div>\n  <h1>New page</h1>\n</div>\n';

/** The editor is no narrower than this, and leaves the app at least this much, in pixels. */
const GRIP_NARROWEST = 320;
const GRIP_APP_LEFT = 280;

// The code editor is @softn/components' own, the one the Builder's code view
// is: a real textarea over a highlighted copy of its text, coloured by the
// scanners Studio's code view reads a file with. Fetched as the feature it
// is, the one chunk an app that draws a <CodeEditor> fetches too: what a file
// is highlighted as is asked of that chunk, not of a second one.
const CodeFile = lazy(() =>
  import('@softn/components/editors').then((editors) => ({
    default: function CodeFile({ file, ...props }: { file: string } & Omit<CodeEditorProps, 'language' | 'aria-label' | 'ariaLabel'>): React.ReactElement {
      const language = editors.languageForPath(file);
      return <editors.CodeEditor {...props} language={language as CodeEditorProps['language']} aria-label={`${file}, ${editors.LANGUAGE_LABEL[language]}`} />;
    },
  }))
);

const never = (): (() => void) => () => {};

function useNarrow(): boolean {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const heard = () => setNarrow(media.matches);
    media.addEventListener('change', heard);
    return () => media.removeEventListener('change', heard);
  }, []);
  return narrow;
}

/** The start of line `line` (from 1) of `text`. */
function lineStart(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next === -1) return at;
    at = next + 1;
  }
  return at;
}

export default function EditPane({ tabId, tab, host, shown }: EditPaneProps): React.ReactElement {
  const [session, setSession] = useState<EditSession | null>(null);
  const [failed, setFailed] = useState(false);
  const marks = useMemo(() => createEditMarks(), []);
  const narrow = useNarrow();
  /** On a narrow screen: the sheet is up (`editor`) or folded to its bar (`app`). */
  const [sheet, setSheet] = useState<'editor' | 'app'>('editor');
  const [width, setWidth] = useState<number | null>(editorWidth);
  const [file, setFile] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drawn, setDrawn] = useState<{ times: number; places: number }>({ times: 0, places: 0 });
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<{ name: string; problem: string } | null>(null);
  /** The publish page's address, where the browser kept its window from opening: offered as a link to press. */
  const [publishLink, setPublishLink] = useState('');
  /** Counts the picks made from the keyboard, each of which puts the keyboard in the picked element's form. */
  const [keyboardPicks, setKeyboardPicks] = useState(0);

  const rootRef = useRef<HTMLElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<PickOverlay | null>(null);
  /** The stretch of the file to select and bring into view once it is drawn. */
  const jumpRef = useRef<{ file: string; start: number; end: number; focus: boolean } | null>(null);
  const [, drawAgain] = useState(0);
  /** Show `file`, with a stretch of it selected and in view. */
  const jumpTo = useCallback((to: { file: string; start: number; end: number; focus: boolean }): void => {
    jumpRef.current = to;
    setFile(to.file);
    // The file may be the one showing already: drawn again all the same, for the selection to be made.
    drawAgain((n) => n + 1);
  }, []);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // ── The session ────────────────────────────────────────────────

  useEffect(() => {
    let wanted = true;
    let opened: EditSession | null = null;
    void EditSession.open(host, tabId).then((made) => {
      if (!wanted) {
        void made?.close();
        return;
      }
      opened = made;
      if (made) setSession(made);
      else setFailed(true);
    });
    return () => {
      wanted = false;
      void opened?.close();
      setSession(null);
      // The renderer stops noting what drew what: the app is as any other.
      if (host.tab(tabId)?.editMarks) host.patch(tabId, { editMarks: undefined });
    };
  }, [host, tabId]);

  /** Counts every change to the session: what is drawn from it is drawn again. */
  const version = useSyncExternalStore(session?.subscribe ?? never, () => session?.version ?? 0);

  // The renderer is handed the marks while the editor is open, and again
  // when the app has been opened afresh in this tab.
  const running = Boolean(tab.source);
  useEffect(() => {
    if (session && running && tab.editMarks !== marks) host.patch(tabId, { editMarks: marks });
  }, [session, running, tab.editMarks, marks, host, tabId]);

  // The file showing: where the editor was left for this app, or its main page.
  const origin = tab.appId;
  useEffect(() => {
    if (!session || file !== null) return;
    const left = origin ? editorPlace(origin) : {};
    const start = left.file && session.files.has(left.file) ? left.file : (session.mainPage() ?? session.entries().find((entry) => entry.text)?.path ?? null);
    if (start === null) return;
    setFile(start);
    if (left.file === start && typeof left.caret === 'number') jumpRef.current = { file: start, start: left.caret, end: left.caret, focus: false };
  }, [session, file, origin]);

  // A file that is no longer among them (taken out, or discarded with the rest).
  useEffect(() => {
    if (session && file !== null && !session.files.has(file)) setFile(session.mainPage());
  }, [session, version, file]);

  const text = session && file !== null ? session.files.get(file) : undefined;

  // ── From an element to its lines, and back ─────────────────────

  const appBox = useCallback((): HTMLElement | null => {
    for (const host of Array.from(document.querySelectorAll<HTMLElement>('[data-softn-tab]'))) {
      if (host.dataset.softnTab === tabId) return host.querySelector<HTMLElement>('.softn-runner-app');
    }
    return null;
  }, [tabId]);

  /** The page on screen, traced; made when it is first asked for, and again when what is running changes. */
  const tracedRef = useRef<{ of: unknown; page: string | undefined; source: string; traced: TracedPage | null } | null>(null);
  const traced = useCallback((): TracedPage | null => {
    const now = tabRef.current;
    if (!session || !now.source) return null;
    const of = session.running();
    const kept = tracedRef.current;
    if (kept && kept.of === of && kept.page === now.shownPage && kept.source === now.source) return kept.traced;
    const made = tracePage(of, now.shownPage, now.shownPage ? undefined : now.source);
    tracedRef.current = { of, page: now.shownPage, source: now.source, traced: made };
    return made;
  }, [session]);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Put away, by its × or by Edit on the bar, while another tab's changes
  // wait on a choice: it stays, says why, and puts the keyboard on the first
  // of the two answers. Closing then would drop what was typed since.
  const takeRef = useRef<HTMLButtonElement>(null);
  const [asked, setAsked] = useState(0);
  const mayClose = useCallback((): boolean => {
    if (!sessionRef.current?.remind()) return true;
    setNotice('');
    setSheet('editor');
    setAsked((count) => count + 1);
    return false;
  }, []);
  useEffect(() => host.guardClose(mayClose), [host, mayClose]);
  useEffect(() => {
    if (asked > 0) takeRef.current?.focus();
  }, [asked]);

  const pick = useCallback(
    (target: Element) => {
      const editing = sessionRef.current;
      if (!editing) return;
      const result = pickAt(marks, traced(), target);
      if (!result) return;
      if ('refused' in result) {
        setNotice(result.refused);
        return;
      }
      const { picked } = result;
      // The place is in the text that is running; what is typed may be ahead of it.
      const shownText = editing.running().get(picked.file);
      const typedText = editing.files.get(picked.file);
      const typedStart = shownText !== undefined && typedText !== undefined ? movedPlace(shownText, typedText, picked.nameStart) : null;
      const element = typedStart !== null && typedText !== undefined ? readElement(typedText, typedStart) : null;
      if (typedStart === null || !element) {
        setNotice(
          shownText !== undefined && shownText === typedText
            ? `This element cannot be changed from here: its lines in ${picked.file} are written in a way this form cannot read. Change it in the file.`
            : 'Mend the change that is not showing yet, then pick again: this element has moved in what you typed.'
        );
        return;
      }
      setNotice('');
      setSelection({ ...picked, nameStart: typedStart, shownStart: picked.nameStart });
      jumpTo({ file: picked.file, start: element.start, end: element.openEnd, focus: false });
      setPicking(false);
      setSheet('editor');
    },
    [marks, traced, jumpTo]
  );

  /**
   * Pick from the keyboard: the element whose lines the caret is in, in the
   * file showing. The same form opens as for a press on the app, with the
   * keyboard in its first field. A press on the app needs a pointer; this
   * does not.
   */
  const pickAtCaret = (): void => {
    const field = codeRef.current?.querySelector('textarea');
    const typedText = session && file !== null ? session.files.get(file) : undefined;
    if (!session || file === null || typedText === undefined || !field) return;
    const element = /\.(ui|softn|html?)$/i.test(file) ? elementAtCaret(typedText, field.selectionStart) : null;
    if (!element) {
      setNotice('Pick from the keyboard takes the element the caret is in. Put the caret inside an element of a page in the editor, then press Pick again.');
      return;
    }
    // Where it is in the text that is running, which is where the app's elements are traced to; nowhere, when it is not showing yet.
    const shownText = session.running().get(file);
    const shownStart = shownText === undefined ? null : movedPlace(typedText, shownText, element.nameStart);
    setNotice('');
    setSelection({ file, nameStart: element.nameStart, tag: element.tag, component: isComponentTag(element.tag), shownStart: shownStart ?? -1 });
    jumpTo({ file, start: element.start, end: element.openEnd, focus: false });
    setPicking(false);
    setKeyboardPicks((count) => count + 1);
  };

  useEffect(() => {
    const mount = rootRef.current;
    if (!session || !mount) return;
    const overlay = new PickOverlay({ mount, box: appBox, outlineFor: (target) => outlineOf(marks, target), onPick: pick });
    overlayRef.current = overlay;
    return () => {
      overlayRef.current = null;
      overlay.destroy();
    };
  }, [session, appBox, marks, pick]);

  // Picking is over the app, so on a narrow screen the sheet folds away for it.
  useEffect(() => {
    overlayRef.current?.setPicking(picking && shown);
  }, [picking, shown, session]);

  // What is typed moves the picked element along with it, or takes it.
  const typedRef = useRef<{ file: string; text: string } | null>(null);
  useEffect(() => {
    if (!session || !selection) {
      typedRef.current = null;
      return;
    }
    const typed = session.files.get(selection.file);
    const before = typedRef.current;
    typedRef.current = typed === undefined ? null : { file: selection.file, text: typed };
    if (typed === undefined) {
      setSelection(null);
      return;
    }
    let next = selection;
    if (before && before.file === selection.file && before.text !== typed) {
      const moved = movedPlace(before.text, typed, selection.nameStart);
      if (moved === null || !readElement(typed, moved)) {
        setSelection(null);
        return;
      }
      if (moved !== selection.nameStart) next = { ...next, nameStart: moved };
    }
    // Once what is typed is what runs, the two places are one.
    if (session.running().get(selection.file) === typed && next.shownStart !== next.nameStart) next = { ...next, shownStart: next.nameStart };
    if (next !== selection) setSelection(next);
  }, [session, version, selection]);

  // The outline follows what the picked place is drawing, as the app draws again.
  useEffect(() => {
    if (!session || !selection) {
      overlayRef.current?.setSelection([], '');
      setDrawn({ times: 0, places: 0 });
      return;
    }
    const look = (): void => {
      const now = drawnNow(marks, traced(), appBox(), { file: selection.file, nameStart: selection.shownStart });
      overlayRef.current?.setSelection(now.elements, `<${selection.tag}>`);
      setDrawn((was) => (was.times === now.times && was.places === now.places ? was : { times: now.times, places: now.places }));
    };
    look();
    const again = setInterval(look, 300);
    return () => clearInterval(again);
  }, [session, selection, marks, traced, appBox]);

  // ── The code editor: where the caret is put, and what is remembered ──

  useLayoutEffect(() => {
    const jump = jumpRef.current;
    const field = codeRef.current?.querySelector('textarea');
    if (!jump || jump.file !== file || !field || text === undefined) return;
    jumpRef.current = null;
    const start = Math.min(jump.start, text.length);
    const end = Math.min(jump.end, text.length);
    if (jump.focus) field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
    const scroller = codeRef.current?.querySelector<HTMLElement>('[data-softn-code-scroller]');
    const lines = codeRef.current?.querySelector<HTMLElement>('[data-softn-code-highlight]');
    if (!scroller || !lines) return;
    const lineHeight = parseFloat(getComputedStyle(lines).lineHeight) || 20;
    const first = text.slice(0, start).split('\n').length;
    const last = text.slice(0, end).split('\n').length;
    scroller.scrollTop = Math.max(0, (first - 3) * lineHeight);
    // From the start of its lines: a selection that ends far along a long
    // line would otherwise leave the tag's own start out of view.
    scroller.scrollLeft = 0;
    requestAnimationFrame(() => {
      scroller.scrollLeft = 0;
    });
    // The lines are marked for a moment, in the editor's own layer under the text.
    const band = document.createElement('div');
    band.className = 'softn-edit-band';
    band.style.top = `calc(0.75rem + ${(first - 1) * lineHeight}px)`;
    band.style.height = `${(last - first + 1) * lineHeight}px`;
    lines.parentElement?.insertBefore(band, lines);
    setTimeout(() => band.remove(), 1600);
  });

  const leave = useCallback(() => {
    const field = codeRef.current?.querySelector('textarea');
    const app = tabRef.current.appId;
    if (app && file !== null) noteEditorPlace(app, { file, caret: field?.selectionStart ?? 0 });
  }, [file]);
  useEffect(() => {
    leave();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [leave]);

  // What is typed is kept as the page is hidden or left, without waiting for
  // the pause after the last key: a phone that puts the browser away may
  // never give the page another turn.
  useEffect(() => {
    if (!session) return;
    const save = (): void => {
      if (document.visibilityState === 'hidden') void session.save();
    };
    const leaving = (): void => void session.save();
    window.addEventListener('pagehide', leaving);
    document.addEventListener('visibilitychange', save);
    return () => {
      window.removeEventListener('pagehide', leaving);
      document.removeEventListener('visibilitychange', save);
    };
  }, [session]);

  const undoOrRedo = (redo: boolean): void => {
    if (!session || file === null) return;
    const before = session.files.get(file) ?? '';
    if (!(redo ? session.redo(file) : session.undo(file))) return;
    const after = session.files.get(file) ?? '';
    // The caret goes to the end of what came back.
    let tail = 0;
    while (tail < Math.min(before.length, after.length) && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
    jumpTo({ file, start: after.length - tail, end: after.length - tail, focus: true });
  };

  const onCodeKey = (event: React.KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    // The editor's own steps back, which know the changes made from the app too.
    event.preventDefault();
    event.stopPropagation();
    undoOrRedo(key === 'y' || event.shiftKey);
  };

  // ── What the person asks for by name ───────────────────────────

  // The menu is put away by Escape and by a press anywhere else. Escape hands
  // the keyboard back to the button that opened it.
  useEffect(() => {
    if (!menu) return;
    const away = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        setMenu(false);
        moreRef.current?.focus();
      } else if (!(event.target instanceof Element && event.target.closest('.softn-edit-menu'))) {
        setMenu(false);
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', away);
    };
  }, [menu]);

  // Opened, the menu takes the keyboard: its first item, then the arrow keys.
  const menuItems = (): HTMLElement[] => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  useEffect(() => {
    if (menu) menuItems()[0]?.focus();
  }, [menu]);
  const onMenuKey = (event: React.KeyboardEvent): void => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let to: number;
    if (event.key === 'ArrowDown') to = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') to = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = items.length - 1;
    else {
      // Tab leaves it, as it leaves any menu: put away, not left open behind the keyboard.
      if (event.key === 'Tab') setMenu(false);
      return;
    }
    event.preventDefault();
    items[to]?.focus();
  };

  const download = async (): Promise<void> => {
    let bytes: Uint8Array | null | undefined;
    try {
      bytes = await session?.bundle();
    } catch (problem) {
      // A file of the app that cannot be read: said, in its own sentence.
      setNotice(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    if (!bytes) return;
    downloadBundle(bytes, tab.name);
    setNotice(session?.holding() ? 'Downloaded the version that is running. The change that is not showing yet is not in it.' : '');
  };

  /**
   * Hand the app to the site's publish page, in a window of its own. The
   * runtime itself never goes there: every app open in it would be closed.
   *
   * A browser lets a page open a window while a press is being answered and
   * not after, and making the bundle takes longer than that. So the window
   * is opened now, empty, and given its address once the app is ready. Where
   * the browser keeps even that from opening, the address is offered as a
   * link, which the person's own press opens.
   */
  const publish = (): void => {
    if (!session) return;
    setPublishLink('');
    let opened: Window | null = null;
    try {
      opened = window.open('', '_blank');
    } catch {
      opened = null;
    }
    void (async () => {
      try {
        const bytes = await session.bundle();
        const staged = bytes ? await stageBundleHandoff(bytes, tab.name, 'runtime', 'publish') : null;
        if (!staged) {
          opened?.close();
          setNotice('This browser could not hand the app to the publish page. Download it, and choose the file there.');
          return;
        }
        const address = handoffUrl('/', 'publish', staged.id);
        if (opened && !opened.closed) {
          // The publish page is not handed a way back into the runtime.
          opened.opener = null;
          opened.location.replace(address);
          setNotice('');
        } else {
          setPublishLink(address);
          setNotice('Your browser kept the publish page from opening. The app is ready for it:');
        }
      } catch (problem) {
        opened?.close();
        setNotice(problem instanceof Error ? problem.message : String(problem));
      }
    })();
  };

  const discard = (): void => {
    if (!session) return;
    const what = session.whose() === 'theirs' ? 'what you have typed' : 'every change you have made to this app here';
    if (!window.confirm(`Discard ${what}? The app goes back to how it was opened.`)) return;
    setSelection(null);
    void session.discard();
  };

  const addFile = (): void => {
    if (!session || !adding) return;
    const name = adding.name.trim().replace(/\\/g, '/');
    const problem = session.add(name, /\.(ui|softn|html?)$/i.test(name) ? NEW_PAGE : '');
    if (problem) {
      setAdding({ name: adding.name, problem });
      return;
    }
    setAdding(null);
    // The keyboard goes on into the file that was added.
    jumpTo({ file: name, start: 0, end: 0, focus: true });
  };
  /** The form is put away with nothing added: the keyboard goes back to the button the form came from. */
  const cancelAdding = (): void => {
    setAdding(null);
    moreRef.current?.focus();
  };

  const showProblem = (): void => {
    const status = session?.status;
    if (!session || !status?.line) return;
    const where = status.file && session.files.has(status.file) ? status.file : file;
    const words = where !== null ? session.files.get(where) : undefined;
    if (where === null || words === undefined) return;
    const start = lineStart(words, status.line);
    const end = words.indexOf('\n', start);
    jumpTo({ file: where, start, end: end === -1 ? words.length : end, focus: true });
    setSheet('editor');
  };

  // ── The edge between app and editor ────────────────────────────

  const resize = (next: number | null): void => {
    const clamped = next === null ? null : Math.max(GRIP_NARROWEST, Math.min(next, window.innerWidth - GRIP_APP_LEFT));
    setWidth(clamped);
    noteEditorWidth(clamped);
  };
  const onGrip = (event: React.PointerEvent<HTMLDivElement>): void => {
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => resize(window.innerWidth - moved.clientX);
    const done = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  };
  const onGripKey = (event: React.KeyboardEvent): void => {
    const now = rootRef.current?.getBoundingClientRect().width ?? 480;
    let to: number;
    if (event.key === 'ArrowLeft') to = now + 32;
    else if (event.key === 'ArrowRight') to = now - 32;
    else if (event.key === 'Home') to = GRIP_NARROWEST;
    else if (event.key === 'End') to = window.innerWidth - GRIP_APP_LEFT;
    else return;
    event.preventDefault();
    resize(to);
  };
  // How wide the editor is, for whoever cannot see the edge: read from the
  // page where no width has been chosen yet.
  const [measured, setMeasured] = useState(480);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(() => {
      const now = Math.round(root.getBoundingClientRect().width);
      if (now > 0) setMeasured(now);
    });
    watch.observe(root);
    return () => watch.disconnect();
  }, []);

  // ── Drawn ──────────────────────────────────────────────────────

  const entries = session?.entries() ?? [];
  const status = session?.status ?? { kind: 'busy' as const, text: failed ? '' : 'Opening the editor…' };
  const whose = !session
    ? ''
    : session.whose() === 'theirs'
      ? 'This app is someone else’s, and stays as it is. Your first change makes your own copy of it, in your library, and that is what you edit.'
      : session.copied
        ? `You are editing your own copy, “${session.copied}”. The app you opened is as it was.`
        : session.runningChanges()
          ? 'This is running with your changes, not as it was opened. The app as it was opened is kept until you discard them.'
          : 'This app is yours. What you change here is kept with it in your library.';
  const folded = narrow && (sheet === 'app' || picking);
  const style = !narrow && width !== null ? ({ '--softn-edit-width': `${width}px` } as React.CSSProperties) : undefined;

  return (
    <aside
      ref={rootRef}
      className="softn-edit"
      // The runtime's own: an app listening on its window is told nothing of a press in here (core's appHears).
      data-softn-host=""
      aria-label={`Editor for ${tab.name}`}
      data-folded={folded ? '' : undefined}
      hidden={!shown}
      style={style}
    >
      {!narrow && (
        <div
          className="softn-edit-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="The width of the editor. Drag the edge, or use the arrow keys."
          aria-valuenow={Math.round(width ?? measured)}
          aria-valuemin={GRIP_NARROWEST}
          aria-valuemax={Math.max(GRIP_NARROWEST, window.innerWidth - GRIP_APP_LEFT)}
          aria-valuetext={`${Math.round(width ?? measured)} pixels wide`}
          tabIndex={0}
          onPointerDown={onGrip}
          onKeyDown={onGripKey}
          onDoubleClick={() => resize(null)}
        />
      )}
      <div className="softn-edit-bar">
        {narrow ? (
          <span className="softn-edit-flip" role="group" aria-label="Show the app or the editor">
            <button type="button" className="softn-edit-btn" aria-pressed={folded} onClick={() => setSheet('app')}>
              App
            </button>
            <button type="button" className="softn-edit-btn" aria-pressed={!folded} onClick={() => { setPicking(false); setSheet('editor'); }}>
              Editor
            </button>
          </span>
        ) : (
          <strong className="softn-edit-title">Edit</strong>
        )}
        <span className="softn-edit-actions">
          <button
            type="button"
            className="softn-edit-btn"
            aria-pressed={picking}
            disabled={!session}
            // Pressed with a pointer, the next press on the app picks. Pressed
            // from the keyboard (a click that no pointer made), it picks the
            // element the caret is in: a press on the app is not something a
            // keyboard can make.
            onClick={(event) => {
              if (event.detail === 0 && !picking) pickAtCaret();
              else setPicking((on) => !on);
            }}
            title="Press an element of the app to see the lines that drew it, and change it. From the keyboard: put the caret in an element in the editor, then press Pick."
          >
            Pick
          </button>
          <button type="button" className="softn-edit-btn" disabled={!session || file === null || !session.canUndo(file)} onClick={() => undoOrRedo(false)} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="softn-edit-btn" disabled={!session || file === null || !session.canRedo(file)} onClick={() => undoOrRedo(true)} title="Redo (Ctrl+Y)">
            Redo
          </button>
          {/* On a narrow screen Restart is in the menu beside it: the bar has room for what is pressed most. */}
          {!narrow && (
            <button type="button" className="softn-edit-btn" disabled={!session} onClick={() => void session?.restart()} title="Start the app again from nothing, with the version it has">
              Restart
            </button>
          )}
          <span className="softn-edit-menu">
            <button ref={moreRef} type="button" className="softn-edit-btn" aria-haspopup="menu" aria-expanded={menu} aria-label="More" disabled={!session} onClick={() => setMenu((open) => !open)}>
              ⋯
            </button>
            {menu && (
              <div
                ref={menuRef}
                className="softn-edit-menu-list"
                role="menu"
                aria-label="More for the editor"
                onKeyDown={onMenuKey}
                onClick={() => {
                  setMenu(false);
                  // Back to the button that opened it, unless what was chosen takes the keyboard itself (the new file's name).
                  moreRef.current?.focus();
                }}
              >
                {narrow && (
                  <button type="button" role="menuitem" className="softn-edit-menu-item" onClick={() => void session?.restart()}>
                    Restart the app
                  </button>
                )}
                <button type="button" role="menuitem" className="softn-edit-menu-item" onClick={() => void download()}>
                  {session?.runningChanges() ? 'Download the edited app' : 'Download the app'}
                </button>
                <button type="button" role="menuitem" className="softn-edit-menu-item" onClick={publish}>
                  Publish it
                </button>
                <button type="button" role="menuitem" className="softn-edit-menu-item" onClick={() => setAdding({ name: 'ui/new.ui', problem: '' })}>
                  Add a file
                </button>
                <button type="button" role="menuitem" className="softn-edit-menu-item" disabled={!session?.runningChanges() && !session?.holding()} onClick={discard}>
                  Discard my changes
                </button>
                <p className="softn-edit-menu-note">For bigger work, download it and open the file in Studio or the Builder.</p>
              </div>
            )}
          </span>
          <button type="button" className="softn-edit-btn softn-edit-close" onClick={() => mayClose() && host.close()} aria-label="Close the editor" title="Put the editor away. The app stays as you edited it.">
            ×
          </button>
        </span>
      </div>
      {failed ? (
        <p className="softn-edit-whose">This app cannot be edited here: its files are no longer at hand. Open it again from your library.</p>
      ) : (
        <>
          <p className="softn-edit-whose">{whose}</p>
          {session?.earlier() && (
            // Changes the person made to this app when it was theirs alone.
            // It has since been opened from the directory or by a link, which
            // is opened as published: they are kept, and offered, not laid.
            <p className="softn-edit-whose softn-edit-whose--offer">
              <span>You changed this app here before, when it was yours alone. Those changes are kept, and are not in what is running: this is the app as it was published.</span>
              <button type="button" className="softn-edit-btn" onClick={() => void session.bringEarlier()}>
                {session.whose() === 'theirs' ? 'Bring my changes into a copy' : 'Bring my changes into this copy'}
              </button>
            </p>
          )}
          {picking && <p className="softn-edit-hint">Press an element of the app. Press Pick again, or Escape, to stop.</p>}
          <div className="softn-edit-body">
            <nav className="softn-edit-files" aria-label="The app’s files">
              {GROUPS.map((group) => {
                const members = entries.filter((entry) => entry.kind === group.kind);
                if (members.length === 0) return null;
                return (
                  <div key={group.kind} className="softn-edit-group">
                    <span className="softn-edit-group-name">{group.label}</span>
                    {members.map((entry) =>
                      entry.text ? (
                        <span key={entry.path} className="softn-edit-file-row">
                          <button
                            type="button"
                            className="softn-edit-file"
                            aria-current={entry.path === file ? 'true' : undefined}
                            title={entry.path}
                            onClick={() => setFile(entry.path)}
                          >
                            <span className="softn-edit-file-name">{entry.path}</span>
                            {(entry.held || entry.changed) && (
                              // The dot is for the eye; the words beside it, drawn off screen, are what is read out with the file's name.
                              <>
                                <span className={entry.held ? 'softn-edit-dot softn-edit-dot--held' : 'softn-edit-dot'} title={entry.held ? 'Changed, and not showing yet' : 'Changed'} aria-hidden="true" />
                                <span className="softn-edit-sr">{entry.held ? ', changed, not showing yet' : ', changed'}</span>
                              </>
                            )}
                          </button>
                          {session?.added(entry.path) && (
                            <button type="button" className="softn-edit-file-remove" aria-label={`Remove ${entry.path}`} title="Remove this file, which you added" onClick={() => session.remove(entry.path)}>
                              ×
                            </button>
                          )}
                        </span>
                      ) : (
                        <span key={entry.path} className="softn-edit-file softn-edit-file--named" title={entry.path}>
                          <span className="softn-edit-file-name">{entry.path}</span>
                        </span>
                      )
                    )}
                  </div>
                );
              })}
            </nav>
            <label className="softn-edit-files-select">
              <span>File</span>
              <select value={file ?? ''} onChange={(event) => setFile(event.target.value)}>
                {GROUPS.filter((group) => group.kind !== 'picture').map((group) => {
                  const members = entries.filter((entry) => entry.kind === group.kind);
                  return members.length === 0 ? null : (
                    <optgroup key={group.kind} label={group.label}>
                      {members.map((entry) => (
                        <option key={entry.path} value={entry.path}>
                          {entry.path}
                          {entry.held ? ' (not showing yet)' : entry.changed ? ' (changed)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
            <div className="softn-edit-main">
              {adding && (
                <form
                  className="softn-edit-add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addFile();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.stopPropagation();
                    cancelAdding();
                  }}
                >
                  <label>
                    <span>New file</span>
                    <input autoFocus value={adding.name} onChange={(event) => setAdding({ name: event.target.value, problem: '' })} spellCheck={false} />
                  </label>
                  <button type="submit" className="softn-edit-btn">
                    Add
                  </button>
                  <button type="button" className="softn-edit-btn" onClick={cancelAdding}>
                    Cancel
                  </button>
                  {adding.problem && <span className="softn-edit-add-problem" role="alert">{adding.problem}</span>}
                </form>
              )}
              <div className="softn-edit-code" ref={codeRef} onKeyDownCapture={onCodeKey}>
                {session && file !== null && text !== undefined && session.tooLarge(file) ? (
                  // A file this long is shown as plain text and not edited
                  // here: the editor draws the whole file again on every key,
                  // and past this size it falls behind typing (session.ts has
                  // what was measured).
                  <>
                    <p className="softn-edit-large">
                      {file} is too long to edit here (about {(text.length / 1_000_000).toFixed(1)} million characters). It is shown as it is. To change it, download the app and open it in Studio or the Builder.
                    </p>
                    <textarea key={file} className="softn-edit-plain" readOnly value={text} spellCheck={false} aria-label={`${file}, shown and not edited`} />
                  </>
                ) : session && file !== null && text !== undefined ? (
                  <Suspense fallback={null}>
                    <CodeFile
                      key={file}
                      file={file}
                      className="softn-edit-codebox"
                      value={text}
                      onChange={(next) => session.type(file, next)}
                      tabSize={2}
                      minHeight="100%"
                      maxHeight="100%"
                      placeholder=""
                      style={{ height: '100%', border: 0, borderRadius: 0, boxShadow: 'none' }}
                    />
                    {/* Once the editor is there, what was waiting to be selected in it is. */}
                    <Drawn key={`drawn ${file}`} then={drawAgain} />
                  </Suspense>
                ) : null}
              </div>
              {session && selection && (
                <PickPanel
                  session={session}
                  selection={selection}
                  drawn={drawn}
                  onShow={() => {
                    const words = session.files.get(selection.file);
                    const element = words !== undefined ? readElement(words, selection.nameStart) : null;
                    if (!element) return;
                    jumpTo({ file: selection.file, start: element.start, end: element.openEnd, focus: false });
                  }}
                  onDone={() => setSelection(null)}
                  takeFocus={keyboardPicks}
                />
              )}
            </div>
          </div>
        </>
      )}
      <div className={`softn-edit-status softn-edit-status--${status.kind}`}>
        <span role="status" aria-live="polite">
          {notice || status.text}
        </span>
        {notice && publishLink && (
          // The browser kept the publish page's window from opening: the person's own press opens it.
          <a className="softn-edit-btn" href={publishLink} target="_blank" rel="noopener noreferrer" onClick={() => { setPublishLink(''); setNotice(''); }}>
            Open the publish page
          </a>
        )}
        {!notice && status.kind === 'held' && status.line !== undefined && (
          <button type="button" className="softn-edit-btn" onClick={showProblem}>
            Show line {status.line}
          </button>
        )}
        {!notice && status.choose === 'tabs' && session && (
          // Another tab changed this app. Nothing was written over it: the person says whose changes stand.
          <>
            <button ref={takeRef} type="button" className="softn-edit-btn" onClick={() => void session.takeTheirs()}>
              Take those changes
            </button>
            <button type="button" className="softn-edit-btn" onClick={() => void session.keepMine()}>
              Keep mine
            </button>
          </>
        )}
      </div>
      <KeyWatch active={picking && shown} onEscape={() => setPicking(false)} />
    </aside>
  );
}

/** Tells its parent that what is beside it has been drawn: the code editor arrives a moment after the pane. */
function Drawn({ then }: { then: React.Dispatch<React.SetStateAction<number>> }): null {
  useEffect(() => {
    then((n) => n + 1);
  }, [then]);
  return null;
}

/**
 * Escape, anywhere in the window, while something of the editor's is waiting
 * on it. The key is the editor's then, and is handed to nothing else: not to
 * the app's focused field, and not to an app listening on its window, which
 * would learn from it that a pick was being made. Its release is kept back
 * too, though the pick has ended by then.
 */
function KeyWatch({ active, onEscape }: { active: boolean; onEscape: () => void }): null {
  useEffect(() => {
    if (!active) return;
    const heard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const released = (up: KeyboardEvent): void => {
        if (up.key !== 'Escape') return;
        up.stopImmediatePropagation();
        window.removeEventListener('keyup', released, true);
      };
      window.addEventListener('keyup', released, true);
      onEscape();
    };
    window.addEventListener('keydown', heard, true);
    return () => window.removeEventListener('keydown', heard, true);
  }, [active, onEscape]);
  return null;
}
