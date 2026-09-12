import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  ApiError,
  addVersion,
  forgetKey,
  getApp,
  publish,
  rememberKey,
  savedKey,
  savedKeys,
  savedKeysUnreadable,
  setThumbnail,
  suggestCategory,
  unpublish,
  updateListing,
  type AppCard,
  type AppDetail,
  type Category,
  type KeyImportResult,
  type KeyStoreResult,
  type Published,
} from '../lib/api';
import { copyText } from '../lib/share';
import { formatBytes, formatDate } from '../lib/format';
import { navigate, type Route } from '../lib/router';
import { Thumb } from '../components/directory/AppCard';
import { CategoriesNotice } from '../components/directory/Controls';
import type { Inspection } from '../lib/inspectBundle';
import { describeHandoffFailure, handoffIdFrom, takeBundleHandoff } from '../lib/handoff';
import { bundleFiles, onDroppedBundles, takeDroppedBundles } from '../lib/dropped';
import { createSelectionController, isSettled, pendingCount, type SelectOptions, type SelectionController, type SelectionItem, type SelectionState } from '../lib/selection';
import { exportKeyBackup, importKeyBackup } from '../lib/keyBackup';

const AUTHOR_KEY = 'softn.site.author';

/**
 * One bundle of several dropped together, and what became of it. `info` is
 * null only for a file that could not be read at all. `reading` is a
 * skipped row being read again at the visitor's request.
 */
interface BatchItem {
  file: File;
  info: Inspection | null;
  status: 'pending' | 'reading' | 'publishing' | 'done' | 'failed' | 'skipped';
  result?: Published;
  error?: string;
  /** For a skipped row: whether the read failed (worth trying again) or the inspector refused the file (not). */
  cause?: 'read' | 'inspection';
  /** Whether the edit key could be kept in this browser. */
  kept?: KeyStoreResult;
}

/**
 * The chosen bundle(s) as one versioned object — see lib/selection.ts for
 * why the File and its inspection are never two states. One controller per
 * mounted page; React reads its snapshot.
 */
function useSelection(): [SelectionState, SelectionController] {
  const ref = useRef<SelectionController | null>(null);
  if (!ref.current) ref.current = createSelectionController();
  const controller = ref.current;
  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  return [state, controller];
}

/** The one item of a single-file selection, or null while there is none or a batch is chosen. */
function singleItem(state: SelectionState): SelectionItem | null {
  return state.mode === 'single' ? state.items[0] : null;
}

/**
 * What the directory will refuse and what will make the listing worse,
 * while the file is still the author's to fix. Errors keep the submit
 * button off; warnings only say so.
 */
function PrepublishReport({ info, extra = [] }: { info: Inspection | null; extra?: string[] }): React.ReactElement | null {
  if (!info) return null;
  const lines = [...info.report, ...extra.map((text) => ({ level: 'warn' as const, text }))];
  if (lines.length === 0) return null;
  const errors = lines.filter((l) => l.level === 'error').length;
  const notes = lines.length - errors;
  return (
    <section className="prepublish" aria-label="Pre-publish report">
      <p className="prepublish-head">
        {errors > 0 ? `${errors} thing${errors === 1 ? '' : 's'} the directory will refuse` : 'Before you publish'}
        {notes > 0 && ` · ${notes} ${notes === 1 ? 'note' : 'notes'}`}
      </p>
      <ul className="prepublish-list">
        {lines.map((line, i) => (
          <li key={i} className={`prepublish-${line.level}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A screenshot resized to fit the card, as a PNG (or JPEG when it came in as one). */
async function fitImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const maxW = 1280;
  const maxH = 800;
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.9));
}

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.retryAfter) return `${err.message} Try again in about ${Math.ceil(err.retryAfter / 60)} minutes.`;
  return err instanceof Error ? err.message : String(err);
}

/** Hand the visitor a file of their keys. A download, not a share URL: the keys never go in an address. */
async function downloadKeyBackup(passphrase: string): Promise<void> {
  const blob = new Blob([await exportKeyBackup(passphrase)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `softn-edit-keys-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What to say about a key after trying to keep it. 'stored' is the quiet
 * case; the other two are the ones the visitor has to act on now, because
 * this page is the last time the key is shown.
 */
function KeyKeptNotice({ kept }: { kept: KeyStoreResult }): React.ReactElement | null {
  if (kept === 'stored') return null;
  return (
    <p className="form-error" role="alert">
      {kept === 'blocked'
        ? 'This browser did not let the site keep the key. It is not stored anywhere else: copy it now, or download the backup, before leaving this page.'
        : 'The keys already kept in this browser could not be read, so this one was not added to them. Copy it now, or download the backup, before leaving this page.'}
    </p>
  );
}

/**
 * The backup download, with the one choice that decides what the file
 * exposes. Without a passphrase the file is the keys in plain text, and the
 * copy under the field says so; with one it is sealed in this browser (see
 * lib/keyBackup.ts) and opens only with that passphrase, which the site
 * never sees and cannot recover.
 */
export function KeyBackupDownload({ label = 'Download backup' }: { label?: string }): React.ReactElement {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  return (
    <div className="key-backup">
      <label className="field">
        <span className="field-label">Passphrase for the backup file (optional)</span>
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" aria-describedby={hintId} />
        <span className="muted" id={hintId}>
          {passphrase === ''
            ? 'Without one, the file holds the keys as plain text: anyone who can read it can update or unpublish these apps. With one, it is encrypted in this browser and opens only with the passphrase.'
            : 'The file is encrypted with this passphrase and opens only with it. It cannot be recovered or reset, so keep the passphrase somewhere too.'}
        </span>
      </label>
      <button
        type="button"
        className="cta"
        onClick={() => {
          setError(null);
          downloadKeyBackup(passphrase).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        {label}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What an import did, in a sentence. */
function describeImport(result: KeyImportResult): string {
  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`${result.added.length} ${result.added.length === 1 ? 'key' : 'keys'} restored`);
  if (result.unchanged.length > 0) parts.push(`${result.unchanged.length} already here`);
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} kept as they were (the file held a different key for ${result.conflicts.join(', ')})`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} not a key: ${result.rejected.join(', ')}`);
  if (result.stored === 'blocked') parts.push('this browser did not let the site store them');
  if (result.stored === 'unreadable') parts.push('the keys already here could not be read, so nothing was changed');
  return parts.length > 0 ? `${parts.join('; ')}.` : 'The file held no keys.';
}

/**
 * A backup file coming back in. Reports what it did, entry by entry; never
 * wipes what is held. An encrypted file asks for its passphrase first, and
 * a passphrase that does not open it leaves the keys here as they were.
 */
export function KeyImport({ onImported }: { onImported?: () => void }): React.ReactElement {
  const [report, setReport] = useState<string | null>(null);
  /** An encrypted file waiting for its passphrase: its text, held until it opens or is given up on. */
  const [sealed, setSealed] = useState<{ name: string; text: string } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const finish = (result: KeyImportResult) => {
    setReport(describeImport(result));
    if (result.added.length > 0 && result.stored === 'stored') onImported?.();
  };
  const take = async (file: File | undefined) => {
    if (!file) return;
    setReport(null);
    setRefused(null);
    const text = await file.text();
    const outcome = await importKeyBackup(text);
    if (outcome.kind === 'needs-passphrase') {
      setSealed({ name: file.name, text });
      setPassphrase('');
      return;
    }
    setSealed(null);
    if (outcome.kind === 'refused') setReport(outcome.message);
    else finish(outcome.result);
  };
  const unlock = async () => {
    if (!sealed || passphrase === '') return;
    const outcome = await importKeyBackup(sealed.text, passphrase);
    if (outcome.kind === 'needs-passphrase') return;
    if (outcome.kind === 'refused') {
      setRefused(outcome.message);
      return;
    }
    setSealed(null);
    setPassphrase('');
    setRefused(null);
    finish(outcome.result);
  };
  return (
    <div className="key-import">
      <label className="field">
        <span className="field-label">Restore keys from a backup file</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {report && (
          <span className="muted" role="status">
            {report}
          </span>
        )}
      </label>
      {sealed && (
        <div className="field">
          <label className="field">
            <span className="field-label">{sealed.name} is encrypted. Its passphrase:</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
              aria-invalid={refused ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void unlock();
                }
              }}
            />
          </label>
          {refused && (
            <p className="form-error" role="alert">
              {refused}
            </p>
          )}
          <div className="app-actions">
            <button type="button" className="cta" disabled={passphrase === ''} onClick={() => void unlock()}>
              Open the backup
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setSealed(null);
                setPassphrase('');
                setRefused(null);
              }}
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A drop target for one .softn or several, showing the chosen item as far as its inspection has got. */
function BundleDrop({ item, onFiles }: { item: SelectionItem | null; onFiles: (files: File[]) => void }): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const file = item?.file ?? null;
  const info = item?.info ?? null;
  return (
    <div
      className={`dropzone ${dragging ? 'over' : ''} ${file ? 'has-file' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        // The page-wide drop must not take these too.
        e.stopPropagation();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".softn,application/zip,application/octet-stream"
        multiple
        hidden
        aria-label="Bundle files"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
        }}
      />
      {file && item ? (
        <div className="dropzone-file">
          {info?.iconDataUrl && <img className="dropzone-icon" src={info.iconDataUrl} alt="" />}
          <div>
            <strong>{file.name}</strong> · {formatBytes(file.size)}
            {item.status === 'inspecting' && (
              <div className="muted" role="status">
                Reading…
              </div>
            )}
            {item.status === 'ready' && info && (
              <div className="muted">
                {info.name} v{info.version} · {info.files} files · entry {info.main}
                {info.execution === 'worker' && ' · off-main-thread'}
              </div>
            )}
            {item.status === 'rejected' && (
              <div className="form-error" role="alert">
                {item.error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <svg className="dropzone-glyph" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4m0 0-4 4m4-4 4 4" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <strong>Drop .softn files here</strong> or click to choose — one, or a folder at once
        </>
      )}
    </div>
  );
}

/**
 * One app this browser holds a key for, as the lookup found it. `missing`
 * is the directory saying 404 — the app is gone or was never here;
 * `unavailable` is everything else: a network failure, a 429, a 500, an
 * answer that was not JSON. The two are kept apart because only the first
 * says anything about the app, and neither says anything about the key.
 */
export type OwnedApp =
  | { slug: string; state: 'loaded'; app: AppDetail }
  | { slug: string; state: 'missing'; error: string }
  | { slug: string; state: 'unavailable'; error: string };

/** Look every slug up, classifying each outcome. Never throws, never forgets. */
export async function lookupOwnedApps(slugs: string[], signal?: AbortSignal, lookup: typeof getApp = getApp): Promise<OwnedApp[]> {
  return Promise.all(
    slugs.map(async (slug): Promise<OwnedApp> => {
      try {
        return { slug, state: 'loaded', app: await lookup(slug, signal) };
      } catch (err) {
        const error = errorText(err);
        if (err instanceof ApiError && err.status === 404) return { slug, state: 'missing', error };
        return { slug, state: 'unavailable', error };
      }
    }),
  );
}

/**
 * The apps this browser holds edit keys for.
 *
 * This is a read-only listing, and it treats the keys that way. An earlier
 * version turned every failed lookup into "not found" and forgot the key
 * for every slug the lookups did not return — so a 500, a rate limit or a
 * dropped connection while the page loaded deleted the only proof of
 * ownership of every app in the list, silently. Now a lookup that fails
 * keeps its row, says why and offers a retry; a confirmed 404 keeps its
 * row too, with the key it holds and a button to forget it on purpose.
 */
export function YourApps({ lookup }: { lookup?: typeof getApp } = {}): React.ReactElement | null {
  const [apps, setApps] = useState<OwnedApp[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [keys, setKeys] = useState<Record<string, string>>(() => savedKeys());
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unreadable = savedKeysUnreadable();
  const slugs = Object.keys(keys);
  const slugList = slugs.join(',');
  useEffect(() => {
    if (slugs.length === 0) return undefined;
    const ac = new AbortController();
    setApps(null);
    void lookupOwnedApps(slugs, ac.signal, lookup).then((list) => {
      if (ac.signal.aborted) return;
      setApps(list);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugList, attempt]);

  if (unreadable) {
    return (
      <section className="yours">
        <h2 className="section-title">Your apps</h2>
        <p className="form-error">
          The edit keys kept in this browser could not be read. Nothing here will touch them; if you have a backup, import it on the update page of the app it is for.
        </p>
      </section>
    );
  }
  if (slugs.length === 0) return null;

  const forget = (slug: string) => {
    const result = forgetKey(slug);
    setConfirmForget(null);
    if (result === 'stored') {
      setNotice(`The key for ${slug} is forgotten. It is not shown again; if you kept a copy, the update page still takes it.`);
      setKeys(savedKeys());
    } else setNotice(`The key for ${slug} could not be removed: this browser is not letting the site change its storage.`);
  };

  const failed = apps?.filter((a) => a.state === 'unavailable').length ?? 0;
  return (
    <section className="yours">
      <h2 className="section-title">
        Your apps <span className="section-count">edit keys kept in this browser</span>
      </h2>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {apps === null ? (
        <p className="muted">Checking…</p>
      ) : (
        <>
          {failed > 0 && (
            <p className="form-error" role="status">
              {failed === 1 ? 'One app could not be checked' : `${failed} apps could not be checked`} just now. The keys are kept.{' '}
              <button type="button" className="link-btn" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </p>
          )}
          <ul className="yours-list">
            {apps.map((entry) => {
              const key = keys[entry.slug];
              if (entry.state === 'loaded') {
                const a = entry.app;
                return (
                  <li key={a.slug} className="yours-item">
                    <a className="yours-thumb" href={a.urls.page} aria-label={a.name}>
                      <Thumb app={a} />
                    </a>
                    <div className="yours-body">
                      <a className="yours-name" href={a.urls.page}>
                        {a.name}
                      </a>
                      <span className="muted">
                        v{a.version} · {a.runs} runs · updated {formatDate(a.updatedAt)}
                      </span>
                    </div>
                    <a className="cta" href={`/publish?update=${encodeURIComponent(a.slug)}`}>
                      Update
                    </a>
                  </li>
                );
              }
              return (
                <li key={entry.slug} className={`yours-item is-${entry.state}`}>
                  <span className="yours-thumb" aria-hidden="true" />
                  <div className="yours-body">
                    <span className="yours-name">{entry.slug}</span>
                    <span className="muted">
                      {entry.state === 'missing' ? 'Not in the directory any more: it was unpublished or removed.' : `Could not be checked: ${entry.error}`}
                    </span>
                    {confirmForget === entry.slug ? (
                      <span className="muted">
                        Forget its key? It cannot be recovered from this browser afterwards.{' '}
                        <button type="button" className="link-btn" onClick={() => forget(entry.slug)}>
                          Yes, forget it
                        </button>{' '}
                        <button type="button" className="link-btn" onClick={() => setConfirmForget(null)}>
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <span className="muted">
                        Key <code className="batch-key">{key}</code>{' '}
                        {entry.state === 'missing' && (
                          <button type="button" className="link-btn" onClick={() => setConfirmForget(entry.slug)}>
                            Forget this key
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {entry.state === 'unavailable' && (
                    <a className="cta" href={`/publish?update=${encodeURIComponent(entry.slug)}`}>
                      Update
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <KeyBackupDownload label="Download a backup of these keys" />
        </>
      )}
    </section>
  );
}

interface CategoriesStatus {
  /** Why the categories request failed, when it did; the page still renders. */
  categoriesError: string | null;
  onRetryCategories: () => void;
}

export function PublishPage({ route, categories, onCategories, categoriesError, onRetryCategories }: { route: Route; categories: Category[]; onCategories: (c: Category[]) => void } & CategoriesStatus): React.ReactElement {
  const updateOf = route.query.get('update') ?? '';
  if (updateOf) return <UpdatePage slug={updateOf} categories={categories} categoriesError={categoriesError} onRetryCategories={onRetryCategories} />;
  return <NewAppPage route={route} categories={categories} onCategories={onCategories} categoriesError={categoriesError} onRetryCategories={onRetryCategories} />;
}

function NewAppPage({ route, categories, onCategories, categoriesError, onRetryCategories }: { route: Route; categories: Category[]; onCategories: (c: Category[]) => void } & CategoriesStatus): React.ReactElement {
  const remixOf = route.query.get('remix') ?? '';
  const [parent, setParent] = useState<AppCard | null>(null);
  const [parentSlug, setParentSlug] = useState(remixOf);
  const [selection, selector] = useSelection();
  const single = singleItem(selection);
  const info = single?.info ?? null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem(AUTHOR_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [website, setWebsite] = useState('');
  const [thumb, setThumb] = useState<{ blob: Blob; url: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [newCat, setNewCat] = useState({ name: '', emoji: '', description: '' });
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Published | null>(null);
  const [keyKept, setKeyKept] = useState<KeyStoreResult>('stored');
  const [copied, setCopied] = useState(false);
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [adminKey, setAdminKey] = useState('');

  useEffect(() => {
    document.title = 'Publish an app — SoftN';
  }, []);

  useEffect(() => {
    if (!remixOf) return undefined;
    const ac = new AbortController();
    getApp(remixOf, ac.signal)
      .then((p) => {
        setParent(p);
        setParentSlug(p.slug);
        if (!category) setCategory(p.category);
        if (!tags) setTags(p.tags.join(', '));
      })
      .catch(() => setParent(null));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remixOf]);

  // One file is the form below; several are a batch, each named and described
  // from its manifest and all filed under one category. A file that is not a
  // bundle is left out; a bundle the directory would refuse is listed as
  // skipped, with the reason. The controller owns the reads: the limits are
  // checked before a byte is read, a few files are inspected at a time, and
  // a result for a choice the visitor has since replaced is dropped — so the
  // form's name and the zone's metadata can only ever be this selection's.
  const takeFiles = useCallback(
    async (files: File[], options?: SelectOptions) => {
      const bundles = bundleFiles(files);
      if (bundles.length === 0) {
        setError('None of those is a .softn bundle.');
        return;
      }
      setBatch(null);
      setResult(null);
      setError(null);
      const outcome = await selector.select(bundles, options);
      if (outcome.outcome === 'rejected') {
        setError(outcome.reason);
        return;
      }
      if (outcome.outcome !== 'settled') return;
      const chosen = singleItem(selector.state());
      if (chosen?.status === 'ready' && chosen.info) {
        const i = chosen.info;
        setName((n) => n || i.name);
        setDescription((d) => d || i.description);
      }
    },
    [selector],
  );

  // A batch becomes rows to publish once every file has been read. The rows
  // then belong to the publishing flow — they take on publishing/done/failed —
  // so they are derived once per selection generation, never re-derived under
  // a publish in progress.
  const batchGeneration = useRef(0);
  useEffect(() => {
    if (selection.mode !== 'batch' || !isSettled(selection) || batchGeneration.current === selection.generation) return;
    batchGeneration.current = selection.generation;
    setBatch(selection.items.map((it) => ({ file: it.file, info: it.info, status: it.status === 'ready' ? 'pending' : 'skipped', error: it.error, cause: it.cause })));
  }, [selection]);

  // Bundles dropped on another page of the site were stashed for this one;
  // a drop beside the zone while this page is up is stashed the same way.
  useEffect(() => {
    const take = () => {
      const dropped = takeDroppedBundles();
      if (dropped.length > 0) void takeFiles(dropped);
    };
    take();
    return onDroppedBundles(take);
  }, [takeFiles]);

  // Opened by Builder or Studio with a bundle staged for this page: take it
  // as if it had been dropped here. A stale or missing hand-off falls back
  // to the ordinary upload, with a line saying why. The hand-off reserves
  // its place in the selection before its bytes arrive: if the visitor
  // chooses a file while the claim is in flight, the hand-off is the older
  // choice and is discarded, along with its failure message.
  useEffect(() => {
    const { opened, id } = handoffIdFrom();
    if (!opened) return;
    const ticket = selector.reserve();
    // The address is a one-shot instruction: once acted on, a reload of this
    // page is an ordinary publish page, not a second claim of the same id.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('from');
      url.searchParams.delete('handoff');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch {
      /* the address bar stays as it is */
    }
    void takeBundleHandoff(id).then((result) => {
      if (ticket !== selector.generation()) return;
      if (!result.ok) {
        setError(describeHandoffFailure(result.reason));
        return;
      }
      const handoff = result.handoff;
      void takeFiles([new File([handoff.bytes as BlobPart], `${handoff.name || 'app'}.softn`, { type: 'application/zip' })], { ticket, digest: handoff.digest });
    });
  }, [selector, takeFiles]);

  const takeThumb = async (f: File) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      setError('A thumbnail is a PNG, JPEG, WebP or GIF.');
      return;
    }
    const blob = await fitImage(f);
    if (thumb) URL.revokeObjectURL(thumb.url);
    setThumb({ blob, url: URL.createObjectURL(blob) });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The file and the metadata the visitor has been looking at are one
    // item; only a fully inspected one is sent.
    const chosen = singleItem(selector.state());
    if (!chosen || chosen.status !== 'ready' || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem(AUTHOR_KEY, author.trim());
      } catch {
        /* storage blocked */
      }
      const r = await publish({
        bundle: chosen.file,
        name: name.trim(),
        description: description.trim(),
        author: author.trim(),
        category,
        tags,
        notes: notes.trim(),
        parent: parentSlug || undefined,
        thumbnail: thumb?.blob ?? null,
        website,
      });
      // Publishing succeeded whatever happens to the key here: the two are
      // reported apart, and a key storage could not keep is the visitor's to
      // copy before leaving.
      setKeyKept(r.editKey ? rememberKey(r.app.slug, r.editKey) : 'stored');
      setResult(r);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const setItem = (index: number, patch: Partial<BatchItem>) =>
    setBatch((items) => (items ? items.map((it, i) => (i === index ? { ...it, ...patch } : it)) : items));

  // Read one skipped row again. The controller reads the file and drops
  // the result if the selection has moved on; this does the same for the
  // row — a "Start over" (or a new batch) between the click and the read
  // finishing means the row it was for no longer exists, and the batch
  // that exists now is not touched. The other rows are never rewritten:
  // only this index is patched, from the controller's item for it.
  const retryRow = async (index: number) => {
    const gen = selector.generation();
    setItem(index, { status: 'reading', error: undefined, cause: undefined });
    await selector.retry(index);
    if (selector.generation() !== gen) return;
    const it = selector.state().items[index];
    if (!it || it.status === 'inspecting') return;
    setItem(index, { info: it.info, status: it.status === 'ready' ? 'pending' : 'skipped', error: it.error, cause: it.cause });
  };

  // In order, one request each, so a refusal names the file it was for. The
  // hourly limit ends the batch with what is left marked, not silently lost.
  const publishBatch = async () => {
    if (!batch || busy) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(AUTHOR_KEY, author.trim());
    } catch {
      /* storage blocked */
    }
    let stoppedAt: string | null = null;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (item.status !== 'pending' || !item.info) continue;
      if (stoppedAt) {
        setItem(i, { status: 'failed', error: stoppedAt });
        continue;
      }
      setItem(i, { status: 'publishing' });
      try {
        const r = await publish({
          bundle: item.file,
          name: item.info.name,
          description: item.info.description,
          author: author.trim(),
          category,
          tags,
          adminKey: adminKey || undefined,
          website,
        });
        const kept = r.editKey ? rememberKey(r.app.slug, r.editKey) : 'stored';
        setItem(i, { status: 'done', result: r, kept });
      } catch (err) {
        const text = errorText(err);
        setItem(i, { status: 'failed', error: text });
        if (err instanceof ApiError && err.status === 429) {
          stoppedAt = `Not tried: ${text} The site owner's admin key, from data/config.json, is not held to the limit.`;
        }
      }
    }
    setBusy(false);
    window.scrollTo({ top: 0 });
  };

  const suggest = async () => {
    setSuggestError(null);
    try {
      const c = await suggestCategory(newCat.name, newCat.description, newCat.emoji);
      onCategories(categories.some((x) => x.id === c.id) ? categories : [...categories, c]);
      setCategory(c.id);
      setSuggesting(false);
      setNewCat({ name: '', emoji: '', description: '' });
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    }
  };

  if (batch) {
    const ready = batch.filter((b) => b.status === 'pending').length;
    const reading = batch.filter((b) => b.status === 'reading').length;
    const done = batch.filter((b) => b.status === 'done').length;
    const failed = batch.filter((b) => b.status === 'failed').length;
    const finished = ready === 0 && reading === 0 && !busy;
    const startOver = () => {
      selector.clear();
      setBatch(null);
      setError(null);
    };
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="eyebrow">{finished ? 'Published' : 'Publish'}</p>
          <h1 className="page-title">
            {finished
              ? `${done} ${done === 1 ? 'app is' : 'apps are'} live.`
              : `${batch.length} bundles, one go`}
          </h1>
          <p className="band-sub">
            {finished
              ? failed > 0
                ? `${failed} ${failed === 1 ? 'was' : 'were'} not published; each row says why.`
                : batch.some((b) => b.kept && b.kept !== 'stored')
                  ? 'Each one has its own page and its own edit key. This browser would not keep the keys: copy them from the rows, or download the backup, before leaving.'
                  : 'Each one has its own page and its own edit key, kept in this browser.'
              : 'Each is named and described from its manifest. They all go under the category you pick; you can change any listing afterwards with its edit key.'}
          </p>
          <ul className="batch-list">
            {batch.map((item, i) => (
              <li key={`${item.file.name}-${i}`} className={`batch-item is-${item.status}`}>
                {item.info?.iconDataUrl ? <img className="dropzone-icon" src={item.info.iconDataUrl} alt="" /> : <span className="dropzone-icon" aria-hidden="true" />}
                <div className="batch-main">
                  <strong>{item.status === 'skipped' || !item.info ? item.file.name : item.info.name}</strong>
                  {item.status !== 'skipped' && item.info && (
                    <span className="muted">
                      {' '}
                      v{item.info.version} · {formatBytes(item.file.size)}
                    </span>
                  )}
                  {item.status === 'skipped' && (
                    <div className="form-error">
                      {item.error}
                      {item.cause === 'read' && (
                        <>
                          {' '}
                          <button type="button" className="link-btn" disabled={busy} onClick={() => void retryRow(i)}>
                            Try again
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {item.status === 'failed' && (
                    <div className="form-error" role="alert">
                      {item.error}
                    </div>
                  )}
                  {item.status === 'done' && item.result && (
                    <div className="muted">
                      <a href={item.result.app.urls.page}>{window.location.origin + item.result.app.urls.page}</a>
                      {item.result.editKey && (
                        <>
                          {' '}
                          · edit key <code className="batch-key">{item.result.editKey}</code>
                          {item.kept && item.kept !== 'stored' && <strong className="form-error"> — not kept in this browser; copy it now</strong>}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <span className="batch-status">
                  {item.status === 'pending' && 'ready'}
                  {item.status === 'reading' && 'reading…'}
                  {item.status === 'publishing' && 'publishing…'}
                  {item.status === 'done' && 'live'}
                  {item.status === 'failed' && 'not published'}
                  {item.status === 'skipped' && 'skipped'}
                </span>
              </li>
            ))}
          </ul>
          {!finished && (
            <form
              className="publish-form"
              onSubmit={(e) => {
                e.preventDefault();
                void publishBatch();
              }}
            >
              <div className="field-row">
                <label className="field">
                  <span className="field-label">Your name</span>
                  <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={40} placeholder="Shown as the author of each" />
                </label>
                <label className="field">
                  <span className="field-label">Category for all of them</span>
                  <select value={category} onChange={(e) => setCategory(e.target.value)} required>
                    <option value="" disabled>
                      Pick one…
                    </option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.emoji} {c.name}
                        {c.suggested ? ' (suggested)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span className="field-label">Tags (optional)</span>
                <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Applied to each — up to eight, comma separated" />
              </label>
              <label className="field">
                <span className="field-label">Site owner? Your admin key (optional)</span>
                <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="off" placeholder="From data/config.json on the server" aria-describedby="admin-key-hint" />
                <span className="muted" id="admin-key-hint">
                  Visitors may publish ten apps an hour. The admin key is not held to that, so a whole folder goes in at once.
                </span>
              </label>
              <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="comment-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="publish-foot">
                <p className="muted">By publishing you make each bundle public: anyone can run it, read it and remix it.</p>
                <button type="submit" className="cta cta-primary" disabled={ready === 0 || !category || busy}>
                  {busy ? 'Publishing…' : `Publish ${ready} ${ready === 1 ? 'app' : 'apps'}`}
                </button>
              </div>
            </form>
          )}
          <div className="app-actions">
            {finished && (
              <a className="cta cta-primary" href="/apps">
                See the directory
              </a>
            )}
            <button type="button" className="cta" onClick={startOver}>
              {finished ? 'Publish more' : 'Start over'}
            </button>
          </div>
          {finished && done > 0 && <KeyBackupDownload label="Download key backup" />}
        </div>
      </main>
    );
  }

  if (result) {
    const app = result.app;
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="eyebrow">Published</p>
          <h1 className="page-title">{app.name} is live.</h1>
          <p className="band-sub">
            It is in the directory under {app.category}, at <a href={app.urls.page}>{window.location.origin + app.urls.page}</a>.
          </p>
          <div className="app-actions">
            <a className="cta cta-primary" href={app.urls.page}>
              Open its page
            </a>
            <a className="cta" href={app.urls.run}>
              Run it
            </a>
            <a className="cta" href="/publish" onClick={() => setResult(null)}>
              Publish another
            </a>
          </div>
          {result.editKey && (
            <section className="keybox">
              <h2 className="side-title">Your edit key</h2>
              <p>
                This is the only way to update the listing or publish a new version — there are no accounts, so nothing else
                proves the app is yours.{' '}
                {keyKept === 'stored'
                  ? 'It has been kept in this browser, and it is not shown again after this page, so copy it somewhere safe too: browser storage is not a backup.'
                  : 'It is not shown again after this page.'}
              </p>
              <KeyKeptNotice kept={keyKept} />
              <div className="keybox-row">
                <code className="keybox-key">{result.editKey}</code>
                <button
                  type="button"
                  className="cta"
                  onClick={async () => {
                    setCopied(await copyText(result.editKey ?? ''));
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <KeyBackupDownload />
              <p className="muted">
                Update from here: <a href={`/publish?update=${app.slug}`}>the update page</a>. Or from a script:{' '}
                <code>curl -F bundle=@app.softn -H &quot;X-Edit-Key: …&quot; {window.location.origin}/api/apps/{app.slug}/versions</code>
              </p>
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="publish">
      <div className="wrap wrap-narrow">
        <p className="eyebrow">{parent ? 'Publish a remix' : 'Publish'}</p>
        <h1 className="page-title">{parent ? `Your take on ${parent.name}` : 'Put an app in the directory'}</h1>
        <p className="band-sub">
          A <code>.softn</code> bundle from <a href="/studio/">Studio</a>, <a href="/builder/">Builder</a> or your own editor — or several at
          once. No account: you get an edit key when it is published, and that key is what lets you update it.
        </p>
        <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} what="so there is none to choose yet" />

        <form className="publish-form" onSubmit={submit}>
          <BundleDrop item={single} onFiles={(files) => void takeFiles(files)} />
          {selection.mode === 'batch' && !isSettled(selection) && (
            <p className="muted" role="status">
              Reading {selection.items.length} bundles… {selection.items.length - pendingCount(selection)} of {selection.items.length} read.
            </p>
          )}
          <PrepublishReport info={info} extra={info && !info.problem && !thumb ? ['No screenshot yet: the card will show the icon, or an initial. A screenshot is what most visitors decide on.'] : []} />

          {info && !info.problem && (
            <div className="capabilities-preview">
              <span className="muted">Its page will say:</span>
              <span className="badge badge-safe">
                <span className="badge-dot" aria-hidden="true" />
                Sandboxed
              </span>
              {info.capabilities.length === 0 ? <span className="badge">No capabilities</span> : info.capabilities.map((c) => <span key={c} className="badge">{c}</span>)}
              {!info.capabilities.includes('net') && <span className="badge">No general network access</span>}
            </div>
          )}

          {parentSlug && (
            <div className="field field-remix">
              <span className="field-label">Remix of</span>
              <span>
                {parent ? <a href={parent.urls.page}>{parent.name}</a> : parentSlug}{' '}
                <button type="button" className="link-btn" onClick={() => setParentSlug('')}>
                  not a remix
                </button>
              </span>
            </div>
          )}

          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="What it is called" required />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} rows={3} placeholder="One or two sentences. What does it do, who is it for?" />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Your name</span>
              <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={40} placeholder="Shown as the author" />
            </label>
            <label className="field">
              <span className="field-label">Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} required>
                <option value="" disabled>
                  Pick one…
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                    {c.suggested ? ' (suggested)' : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="link-btn" onClick={() => setSuggesting((s) => !s)}>
                {suggesting ? 'Never mind' : 'None of these fit? Suggest a category'}
              </button>
            </label>
          </div>
          {suggesting && (
            <div className="suggest">
              <div className="field-row">
                <label className="field">
                  <span className="field-label">New category</span>
                  <input type="text" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} maxLength={32} placeholder="e.g. Music toys" />
                </label>
                <label className="field field-emoji">
                  <span className="field-label">Emoji</span>
                  <input type="text" value={newCat.emoji} onChange={(e) => setNewCat({ ...newCat, emoji: e.target.value })} maxLength={4} placeholder="🎵" />
                </label>
              </div>
              <label className="field">
                <span className="field-label">What belongs in it</span>
                <input type="text" value={newCat.description} onChange={(e) => setNewCat({ ...newCat, description: e.target.value })} maxLength={120} placeholder="A line so others file the right apps here" />
              </label>
              <p className="muted">Suggested categories can be used straight away and are marked as suggested until the site owner approves them.</p>
              {suggestError && (
                <p className="form-error" role="alert">
                  {suggestError}
                </p>
              )}
              <button type="button" className="cta" onClick={suggest} disabled={newCat.name.trim().length < 2}>
                Add it
              </button>
            </div>
          )}
          <label className="field">
            <span className="field-label">Tags</span>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="arcade, two-player, retro — up to eight, comma separated" />
          </label>
          <label className="field">
            <span className="field-label">Screenshot (optional, but the card looks far better with one)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-describedby="screenshot-hint"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void takeThumb(f);
              }}
            />
            <span className="muted" id="screenshot-hint">
              Without one, the card shows the bundle&rsquo;s icon. Resized in your browser before upload; 16:10 fills the frame.
            </span>
            {thumb && (
              <span className="thumb-preview">
                <img src={thumb.url} alt="Thumbnail preview" />
              </span>
            )}
          </label>
          <label className="field">
            <span className="field-label">Notes for this version (optional)</span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} placeholder="What changed, what to try first" />
          </label>
          <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="comment-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="publish-foot">
            <p className="muted">
              By publishing you make the bundle public: anyone can run it, read it and remix it. Apache-2.0-style openness is the
              point.
            </p>
            <button type="submit" className="cta cta-primary" disabled={single?.status !== 'ready' || !category || busy}>
              {busy ? 'Publishing…' : parentSlug ? 'Publish remix' : 'Publish'}
            </button>
          </div>
        </form>

        <YourApps />

        <section className="publish-api">
          <h2 className="section-title">Or publish from a script</h2>
          <p className="muted">
            The same thing, over HTTP. A build step, a bot, or a model with a tool can put an app in the directory with one request:
          </p>
          <pre className="source-code source-plain">
            <code>{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : ''}/api/apps \\
  -F bundle=@my-app.softn \\
  -F category=games -F author="A robot" -F "tags=arcade,ai-made"

# or JSON: { "bundleBase64": "...", "category": "games", "author": "A robot" }
# The reply carries the page URL and the edit key. Full route list: ${typeof window !== 'undefined' ? window.location.origin : ''}/api`}</code>
          </pre>
        </section>
      </div>
    </main>
  );
}

/**
 * The other half of publishing: with the edit key, change the listing, push
 * a new version, replace the screenshot, or take the app down.
 */
function UpdatePage({ slug, categories, categoriesError, onRetryCategories }: { slug: string; categories: Category[] } & CategoriesStatus): React.ReactElement {
  const [app, setApp] = useState<AppDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [key, setKey] = useState(() => savedKey(slug) ?? '');
  const [remember, setRemember] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [selection, selector] = useSelection();
  const single = singleItem(selection);
  const [notes, setNotes] = useState('');
  const [thumb, setThumb] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** The saved key was refused: offer to forget it, rather than doing so unasked. */
  const [refusedSavedKey, setRefusedSavedKey] = useState(false);

  useEffect(() => {
    document.title = `Update ${slug} — SoftN`;
    const ac = new AbortController();
    getApp(slug, ac.signal)
      .then((a) => {
        setApp(a);
        setName(a.name);
        setDescription(a.description);
        setAuthor(a.author);
        setCategory(a.category);
        setTags(a.tags.join(', '));
        document.title = `Update ${a.name} — SoftN`;
      })
      .catch((e) => {
        if (!ac.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [slug]);

  const keyOk = /^[0-9a-f]{40}$/i.test(key.trim());
  const withKey = async (label: string, fn: (k: string) => Promise<void>) => {
    if (!keyOk || busy) return;
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      await fn(key.trim());
      if (remember) {
        const kept = rememberKey(slug, key.trim());
        if (kept !== 'stored') setDone((d) => `${d ?? ''} The key could not be kept in this browser; keep your own copy.`.trim());
      }
      setRefusedSavedKey(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // The key was refused this once. That is not proof the saved one is
        // wrong — a server misconfiguration answers the same way — and the
        // saved one is the only copy this browser has. Say so; the forgetting
        // is the visitor's to do.
        setError('That edit key does not open this app.');
        setRefusedSavedKey(key.trim() === (savedKey(slug) ?? ''));
      } else setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  // The same versioned selection as the publish form: the file shown and
  // the file sent are one item, and a slower earlier read cannot overwrite
  // a later choice.
  const takeFile = async (f: File) => {
    setError(null);
    const outcome = await selector.select([f]);
    if (outcome.outcome === 'rejected') setError(outcome.reason);
  };
  const takeThumb = async (f: File) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      setError('A thumbnail is a PNG, JPEG, WebP or GIF.');
      return;
    }
    const blob = await fitImage(f);
    if (thumb) URL.revokeObjectURL(thumb.url);
    setThumb({ blob, url: URL.createObjectURL(blob) });
  };

  if (loadError) {
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <div className="empty" role="alert">
            <p className="eyebrow">Not here</p>
            <h1 className="page-title">Could not load that app.</h1>
            <p className="muted">{loadError}</p>
            <p>
              <a className="cta cta-primary" href="/apps">
                Browse the directory
              </a>
            </p>
          </div>
        </div>
      </main>
    );
  }
  if (!app) {
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }
  if (app.source === 'seed') {
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="eyebrow">Update</p>
          <h1 className="page-title">{app.name} ships with the site.</h1>
          <p className="band-sub">
            The demos that ship with the site have no edit key; they are updated with the site. If you want your own version,{' '}
            <a href={app.urls.remix ?? app.urls.page}>remix it</a> — it will credit where it came from.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="publish">
      <div className="wrap wrap-narrow">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/apps">Apps</a>
          <span aria-hidden="true">›</span>
          <a href={app.urls.page}>{app.name}</a>
          <span aria-hidden="true">›</span>
          <span>Update</span>
        </nav>
        <p className="eyebrow">Update</p>
        <h1 className="page-title">{app.name}</h1>
        <p className="band-sub">
          v{app.version} · published {formatDate(app.createdAt)} · {app.runs} runs. Everything here needs the edit key publishing handed out.
        </p>
        <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} what="so the listing cannot be moved to another yet" />

        <section className="update-section">
          {/* Two controls, two labels: a label inside a label gives the key
              field the checkbox's words as part of its name. */}
          <div className="field">
            <label className="field">
              <span className="field-label">Edit key</span>
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="40 characters, from when you published"
                spellCheck={false}
                autoComplete="off"
                className={key && !keyOk ? 'invalid' : ''}
                aria-invalid={key && !keyOk ? true : undefined}
                aria-describedby={key && !keyOk ? 'edit-key-error' : undefined}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep it in this browser
            </label>
          </div>
          {key && !keyOk && (
            <p className="form-error" id="edit-key-error">
              An edit key is 40 hex characters.
            </p>
          )}
          {refusedSavedKey && (
            <p className="muted">
              The key kept in this browser for this app was refused. If you are sure it is wrong,{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  if (forgetKey(slug) === 'stored') {
                    setKey('');
                    setRefusedSavedKey(false);
                    setDone('The saved key is forgotten.');
                  }
                }}
              >
                forget it
              </button>
              ; otherwise leave it, in case the directory was the problem.
            </p>
          )}
          <KeyImport onImported={() => setKey(savedKey(slug) ?? key)} />
        </section>

        {done && (
          <div className="notice notice-ok" role="status">
            {done}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <section className="update-section">
          <h2 className="section-title">The listing</h2>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={600} rows={3} />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Author</span>
              <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={40} />
            </label>
            <label className="field">
              <span className="field-label">Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field-label">Tags</span>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <button
            type="button"
            className="cta cta-primary"
            disabled={!keyOk || busy !== null}
            onClick={() =>
              withKey('listing', async (k) => {
                const a = await updateListing(slug, k, { name: name.trim(), description: description.trim(), author: author.trim(), category, tags });
                setApp(a);
                setDone('The listing is updated.');
              })
            }
          >
            {busy === 'listing' ? 'Saving…' : 'Save the listing'}
          </button>
        </section>

        <section className="update-section">
          <h2 className="section-title">
            A new version <span className="section-count">v{app.version + 1}</span>
          </h2>
          <BundleDrop item={single} onFiles={(files) => void takeFile(files[0])} />
          <label className="field">
            <span className="field-label">What changed</span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} placeholder="Shown under the version on the app page" />
          </label>
          <button
            type="button"
            className="cta cta-primary"
            disabled={!keyOk || single?.status !== 'ready' || busy !== null}
            onClick={() =>
              withKey('version', async (k) => {
                const chosen = singleItem(selector.state());
                if (!chosen || chosen.status !== 'ready') return;
                const a = await addVersion(slug, k, chosen.file, notes.trim());
                setApp(a);
                selector.clear();
                setNotes('');
                setDone(`v${a.version} is live. Anyone opening the app now gets it.`);
              })
            }
          >
            {busy === 'version' ? 'Uploading…' : 'Publish the new version'}
          </button>
          {app.versions.length > 0 && (
            <ul className="side-list versions-list">
              {app.versions.map((v) => (
                <li key={v.version}>
                  <a href={`${v.bundle}&download=1`} download={`${app.slug}-v${v.version}.softn`}>
                    v{v.version}
                  </a>{' '}
                  <span className="muted">
                    {formatDate(v.createdAt)} · {formatBytes(v.size)}
                  </span>
                  {v.notes && <div className="side-note">{v.notes}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="update-section">
          <h2 className="section-title">The picture</h2>
          <div className="update-thumb-row">
            <div className="update-thumb">
              <Thumb app={app} />
            </div>
            <div>
              <label className="field">
                <span className="field-label">Replace the screenshot</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void takeThumb(f);
                  }}
                />
                {thumb && (
                  <span className="thumb-preview">
                    <img src={thumb.url} alt="New thumbnail" />
                  </span>
                )}
              </label>
              <button
                type="button"
                className="cta cta-primary"
                disabled={!keyOk || !thumb || busy !== null}
                onClick={() =>
                  withKey('thumb', async (k) => {
                    if (!thumb) return;
                    const a = await setThumbnail(slug, k, thumb.blob);
                    setApp((prev) => (prev ? { ...prev, ...a, thumbnail: `${a.thumbnail}?t=${Date.now()}` } : prev));
                    setThumb(null);
                    setDone('The screenshot is replaced.');
                  })
                }
              >
                {busy === 'thumb' ? 'Uploading…' : 'Use this picture'}
              </button>
            </div>
          </div>
        </section>

        <section className="update-section update-danger">
          <h2 className="section-title">Take it down</h2>
          <p className="muted">
            Unpublishing hides the app from the directory and its page. The bundle stays on the server so a remix keeps its parent; the
            site owner can remove it for good.
          </p>
          {!confirmRemove ? (
            <button type="button" className="cta" disabled={!keyOk || busy !== null} onClick={() => setConfirmRemove(true)}>
              Unpublish {app.name}
            </button>
          ) : (
            <div className="app-actions">
              <button
                type="button"
                className="cta cta-danger"
                disabled={busy !== null}
                onClick={() =>
                  withKey('remove', async (k) => {
                    await unpublish(slug, k);
                    forgetKey(slug);
                    navigate('/apps');
                  })
                }
              >
                {busy === 'remove' ? 'Removing…' : 'Yes, unpublish it'}
              </button>
              <button type="button" className="cta" onClick={() => setConfirmRemove(false)}>
                Keep it
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
