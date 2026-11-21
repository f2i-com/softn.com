import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getApp, getCategories, isPublicServerHostingAllowed, publish, suggestCategory, type AppCard, type Category, type HostingMode, type Published } from '../../lib/api';
import { rememberKey, savedKeys, type KeyStoreResult } from '../../lib/keyStore';
import { copyText } from '../../lib/share';
import { formatBytes } from '../../lib/format';
import { BUILDER_HREF, STUDIO_HREF } from '../../lib/appUrls';
import { navigate, type Route } from '../../lib/router';
import { CategoriesNotice } from '../directory/Controls';
import type { Inspection } from '../../lib/inspectBundle';
import { describeHandoffFailure, handoffIdFrom, takeBundleHandoff } from '../../lib/handoff';
import { bundleFiles } from '../../lib/dropped';
import { isSettled, pendingCount, type SelectOptions } from '../../lib/selection';
import { BundleDrop } from './BundleDrop';
import { KeyBackupDownload, KeyKeptNotice, PushWithGit } from './keys';
import { YourApps } from './YourApps';
import { AUTHOR_KEY, PrepublishReport, errorText, singleItem, useDroppedBundles, useSelection, useThumbnail, type CategoriesStatus } from './shared';

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

/** What a row the visitor stopped the batch before says. */
const STOPPED = 'Not published: the batch was stopped before its turn.';

/** Match the directory's slug rule closely enough to spot an app this browser already owns. */
function slugifyName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve manifest category / subcategory hints against the directory's live
 * hierarchy. Accepts ids, slugs, names, or `parent/sub` paths.
 */
function resolveManifestCategory(
  categories: Category[],
  rawCategory?: string,
  rawSubcategory?: string,
): { category: string; subcategory: string } | null {
  if (!rawCategory && !rawSubcategory) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  let catHint = rawCategory ? norm(rawCategory) : '';
  let subHint = rawSubcategory ? norm(rawSubcategory) : '';
  if (catHint.includes('/') && !subHint) {
    const [p, s] = catHint.split('/', 2);
    catHint = norm(p);
    subHint = norm(s);
  }
  const matchSub = (parent: Category, hint: string): string => {
    if (!hint || !parent.subcategories?.length) return '';
    const found = parent.subcategories.find(
      (s) => norm(s.slug) === hint || norm(s.id) === hint || norm(s.name) === hint,
    );
    return found ? found.slug : '';
  };
  if (catHint) {
    const direct = categories.find(
      (c) => norm(c.id) === catHint || (c.slug && norm(c.slug) === catHint) || norm(c.name) === catHint,
    );
    if (direct) {
      return { category: direct.id, subcategory: matchSub(direct, subHint) };
    }
    // Check if the manifest gave a subcategory name/slug directly.
    for (const parent of categories) {
      const sub = matchSub(parent, catHint);
      if (sub) return { category: parent.id, subcategory: sub };
    }
  }
  if (subHint) {
    for (const parent of categories) {
      const sub = matchSub(parent, subHint);
      if (sub) return { category: parent.id, subcategory: sub };
    }
  }
  return null;
}

export function NewAppPage({
  route,
  categories,
  onCategories,
  onPublishAnother,
  categoriesError,
  onRetryCategories,
}: { route: Route; categories: Category[]; onCategories: (c: Category[]) => void; onPublishAnother: () => void } & CategoriesStatus): React.ReactElement {
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
  const [subcategory, setSubcategory] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [hosting, setHosting] = useState<HostingMode>('browser');
  const [backendUrl, setBackendUrl] = useState('');
  const [withholdBackend, setWithholdBackend] = useState(false);
  const [website, setWebsite] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestAsSub, setSuggestAsSub] = useState(false);
  const [newCat, setNewCat] = useState({ name: '', emoji: '', description: '' });
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { thumb, take: takeThumb, clear: clearThumb } = useThumbnail(setError);
  const [result, setResult] = useState<Published | null>(null);
  const [keyKept, setKeyKept] = useState<KeyStoreResult>('stored');
  const [copied, setCopied] = useState(false);
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [adminKey, setAdminKey] = useState('');
  /**
   * The batch publish under way, if any. Start over used to clear the rows
   * and leave the loop running over the batch it had captured, so every
   * bundle still to go was published anyway, with no row left to say so.
   * Now it asks the run to stop: the upload in flight finishes, the rest
   * are marked as not published, and the rows say which went live.
   */
  const batchRun = useRef<{ stopped: boolean } | null>(null);
  const [stopping, setStopping] = useState(false);
  /** `busy`, for the drop handlers, which outlive a render: a publish in flight is not to have its selection replaced. */
  const busyRef = useRef(false);
  /** What the last bundle chosen filled the form with (see takeFiles). */
  const filledRef = useRef({ name: '', description: '', author: '', tags: '', category: '', subcategory: '' });
  /** Whether the visitor manually picked a hosting mode, so auto-defaults do not overwrite it. */
  const hostingTouchedRef = useRef(false);
  /** Latest categories list for callbacks that outlive a render. */
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const working = (on: boolean) => {
    busyRef.current = on;
    setBusy(on);
  };

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
        if (!subcategory && p.subcategory) setSubcategory(p.subcategory);
        if (!tags) setTags(p.tags.join(', '));
      })
      .catch(() => setParent(null));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remixOf]);

  // If categories finish loading after a bundle with a manifest category was dropped,
  // apply that manifest category while the visitor hasn't picked one yet.
  useEffect(() => {
    if (!info || category || categories.length === 0) return;
    const resolved = resolveManifestCategory(categories, info.manifestCategory, info.manifestSubcategory);
    if (resolved) {
      setCategory(resolved.category);
      if (resolved.subcategory) setSubcategory(resolved.subcategory);
      filledRef.current.category = resolved.category;
      filledRef.current.subcategory = resolved.subcategory;
    }
  }, [categories, info, category]);

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
      // A drop on the page while bundles are uploading would replace the
      // rows the upload is reporting into.
      if (busyRef.current) {
        setError('Those were not taken: bundles are being published. Drop them again once this is done.');
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
        // A field still holding what the last bundle filled in is the new
        // one's; one the visitor wrote is theirs. Filled only when empty, a
        // second bundle chosen (Snake, then Tetris) was published under the
        // first one's name and description.
        const filled = filledRef.current;
        setName((n) => (n === '' || n === filled.name ? i.name : n));
        setDescription((d) => (d === '' || d === filled.description ? i.description : d));
        const nextAuthor = i.manifestAuthor ?? '';
        if (nextAuthor) {
          setAuthor((a) => (a === '' || a === filled.author ? nextAuthor : a));
        }
        const nextTags = i.manifestTags?.length ? i.manifestTags.join(', ') : '';
        if (nextTags) {
          setTags((t) => (t === '' || t === filled.tags ? nextTags : t));
        }
        const resolved = resolveManifestCategory(categoriesRef.current, i.manifestCategory, i.manifestSubcategory);
        if (resolved) {
          setCategory((c) => (c === '' || c === filled.category ? resolved.category : c));
          setSubcategory((s) => (s === '' || s === filled.subcategory ? resolved.subcategory : s));
        }
        if (!hostingTouchedRef.current) {
          setHosting(i.backendRuntime && isPublicServerHostingAllowed() ? 'hybrid' : 'browser');
        }
        filledRef.current = {
          name: i.name,
          description: i.description,
          author: nextAuthor,
          tags: nextTags,
          category: resolved?.category ?? '',
          subcategory: resolved?.subcategory ?? '',
        };
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

  // Bundles dropped on another page of the site, or beside the zone.
  const takeDropped = useCallback(
    (dropped: File[]) => {
      void takeFiles(dropped);
    },
    [takeFiles],
  );
  useDroppedBundles(takeDropped);

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The file and the metadata the visitor has been looking at are one
    // item; only a fully inspected one is sent.
    const chosen = singleItem(selector.state());
    if (!chosen || chosen.status !== 'ready' || busy) return;
    working(true);
    setError(null);
    try {
      try {
        localStorage.setItem(AUTHOR_KEY, author.trim());
      } catch {
        /* storage blocked */
      }
      const allowPublicHosting = isPublicServerHostingAllowed();
      const effectiveHosting: HostingMode = allowPublicHosting ? hosting : 'browser';
      const r = await publish({
        bundle: chosen.file,
        name: name.trim(),
        description: description.trim(),
        author: author.trim(),
        category,
        subcategory: subcategory || undefined,
        tags,
        notes: notes.trim(),
        parent: parentSlug || undefined,
        thumbnail: thumb?.blob ?? null,
        hosting: effectiveHosting,
        backendUrl: allowPublicHosting ? backendUrl.trim() || undefined : undefined,
        withholdBackend: allowPublicHosting && effectiveHosting === 'server' && withholdBackend,
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
      working(false);
    }
  };

  const setItem = (index: number, patch: Partial<BatchItem>) =>
    setBatch((items) => (items ? items.map((it, i) => (i === index ? { ...it, ...patch } : it)) : items));

  const removeBatchRow = (index: number) => {
    if (busy) return;
    setBatch((items) => {
      if (!items) return items;
      const next = items.filter((_, i) => i !== index);
      if (next.length === 0) {
        selector.clear();
        return null;
      }
      return next;
    });
  };

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
  // hourly limit ends the batch with what is left marked, not silently lost,
  // and so does the visitor stopping it.
  const publishBatch = async () => {
    if (!batch || busy) return;
    const run = { stopped: false };
    batchRun.current = run;
    working(true);
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
      if (run.stopped && !stoppedAt) stoppedAt = STOPPED;
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
          subcategory: subcategory || undefined,
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
    batchRun.current = null;
    working(false);
    setStopping(false);
    window.scrollTo({ top: 0 });
  };

  const suggest = async () => {
    setSuggestError(null);
    const parentId = suggestAsSub && category ? category : undefined;
    try {
      const c = await suggestCategory(newCat.name, newCat.description, newCat.emoji, parentId);
      let refreshed: Category[] | null = null;
      try {
        refreshed = await getCategories();
      } catch {
        refreshed = null;
      }
      if (refreshed && refreshed.length > 0) {
        onCategories(refreshed);
      } else if (parentId) {
        const subSlug = c.slug || c.id.split('/').pop() || c.id;
        onCategories(
          categories.map((cat) =>
            cat.id === parentId
              ? {
                  ...cat,
                  subcategories: [
                    ...(cat.subcategories ?? []),
                    {
                      id: c.id,
                      slug: subSlug,
                      parent: parentId,
                      name: c.name,
                      description: c.description,
                      emoji: c.emoji,
                      status: c.status,
                      suggested: c.suggested,
                      apps: c.apps,
                    },
                  ],
                }
              : cat,
          ),
        );
      } else {
        onCategories(categories.some((x) => x.id === c.id) ? categories : [...categories, c]);
      }
      if (parentId) {
        setCategory(parentId);
        setSubcategory(c.slug || c.id.split('/').pop() || '');
      } else {
        setCategory(c.id);
        setSubcategory('');
      }
      setSuggesting(false);
      setSuggestAsSub(false);
      setNewCat({ name: '', emoji: '', description: '' });
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedCategory = categories.find((c) => c.id === category) ?? null;
  const selectedSubcategories = selectedCategory?.subcategories ?? [];
  const selectedSubcategory = selectedSubcategories.find((s) => s.slug === subcategory) ?? null;

  if (batch) {
    const ready = batch.filter((b) => b.status === 'pending').length;
    const reading = batch.filter((b) => b.status === 'reading').length;
    const publishing = batch.filter((b) => b.status === 'publishing').length;
    const done = batch.filter((b) => b.status === 'done').length;
    const failed = batch.filter((b) => b.status === 'failed').length;
    const publishableTotal = ready + publishing + done + failed;
    const completedCount = done + failed;
    const finished = ready === 0 && reading === 0 && !busy;
    const startOver = () => {
      // While bundles are going up this stops the batch rather than clearing
      // it: the rows stay, to say which went live and to show their keys.
      if (busy) {
        if (batchRun.current) batchRun.current.stopped = true;
        setStopping(true);
        return;
      }
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
          {busy && publishableTotal > 0 && (
            <div className="batch-progress" role="status" aria-live="polite">
              <div className="batch-progress-head">
                <span>
                  Publishing {Math.min(completedCount + 1, publishableTotal)} of {publishableTotal}…
                </span>
                <span className="muted">
                  {done} live{failed > 0 ? ` · ${failed} failed` : ''}
                </span>
              </div>
              <div className="batch-progress-track">
                <div
                  className="batch-progress-fill"
                  style={{ width: `${Math.round(((completedCount + (publishing > 0 ? 0.4 : 0)) / publishableTotal) * 100)}%` }}
                />
              </div>
            </div>
          )}
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
                {!busy && !finished && (item.status === 'pending' || item.status === 'skipped') && (
                  <button
                    type="button"
                    className="batch-remove"
                    aria-label={`Remove ${item.info?.name || item.file.name}`}
                    title="Remove from batch"
                    onClick={() => removeBatchRow(i)}
                  >
                    ×
                  </button>
                )}
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
                  <select
                    value={category}
                    onChange={(e) => {
                      setCategory(e.target.value);
                      setSubcategory('');
                    }}
                    required
                  >
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
              {selectedSubcategories.length > 0 && (
                <label className="field">
                  <span className="field-label">Subcategory (optional)</span>
                  <select value={subcategory} onChange={(e) => setSubcategory(e.target.value)}>
                    <option value="">None (top-level in {selectedCategory?.name})</option>
                    {selectedSubcategories.map((sub) => (
                      <option key={sub.slug} value={sub.slug}>
                        {sub.emoji} {sub.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
            <button type="button" className="cta" onClick={startOver} disabled={stopping}>
              {finished ? 'Publish more' : stopping ? 'Stopping after this upload…' : busy ? 'Stop after this upload' : 'Start over'}
            </button>
          </div>
          {finished && done > 0 && <KeyBackupDownload label="Download key backup" />}
        </div>
      </main>
    );
  }

  if (result) {
    const app = result.app;
    const filedUnder = categories.find((c) => c.id === app.category);
    const filedSub = filedUnder?.subcategories?.find((s) => s.slug === app.subcategory);
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="eyebrow">Published</p>
          <h1 className="page-title">{app.name} is live.</h1>
          <p className="band-sub">
            It is in the directory under {filedUnder ? filedUnder.name : app.category}
            {filedSub ? ` / ${filedSub.name}` : ''}, at <a href={app.urls.page}>{window.location.origin + app.urls.page}</a>.
          </p>
          {result.warning && <p className="form-error">{result.warning}</p>}
          <div className="app-actions">
            <a className="cta cta-primary" href={app.urls.page}>
              Open its page
            </a>
            <a className="cta" href={app.urls.run}>
              Run it
            </a>
            {/* A fresh form: the last one's file, fields and remix were still
                in it, and one more press published the same bundle again. */}
            <a
              className="cta"
              href="/publish"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate('/publish');
                onPublishAnother();
              }}
            >
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
              <PushWithGit slug={app.slug} />
            </section>
          )}
        </div>
      </main>
    );
  }

  // Detect if the visitor already holds an edit key for an app with this slug,
  // so we can offer a 1-click jump to push v2+ instead of making a duplicate.
  const ownedKeys = savedKeys();
  const candidateSlug = slugifyName(name || info?.name || '');
  const matchingOwnedSlug = !parentSlug && candidateSlug && ownedKeys[candidateSlug] ? candidateSlug : null;

  // Quick-pick category pills (up to 8 primary/populated categories).
  const quickCategories = categories.slice(0, 8);
  const allowPublicHosting = isPublicServerHostingAllowed();
  const hasBackend = Boolean(info?.backendRuntime);
  const effectiveHosting: HostingMode = allowPublicHosting ? hosting : 'browser';

  const hostingControls = allowPublicHosting ? (
    <>
      <label className="field">
        <span className="field-label">
          Hosting mode
          {hasBackend && info?.backendRuntime && (
            <span className="publish-inline-badge">{info.backendRuntime.toUpperCase()} backend detected</span>
          )}
        </span>
        <select
          value={hosting}
          onChange={(e) => {
            hostingTouchedRef.current = true;
            setHosting(e.target.value as HostingMode);
          }}
        >
          <option value="browser">Browser sandbox only — visitors download the .softn and run it locally</option>
          <option value="hybrid">Hosted on SoftN (ZIPP safe-sandbox) + local browser option</option>
          <option value="server">Hosted on SoftN server only (ZIPP safe-sandbox)</option>
        </select>
        <span className="muted">
          Browser sandbox runs everything in the visitor&rsquo;s browser with zero server compute. Hosted modes run embedded backends (PHP, JS/TS, Rust, Python + SQLite) on SoftN strictly inside ZIPP safe-sandbox.
        </span>
      </label>
      {hosting !== 'browser' && (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Custom backend URL (optional)</span>
            <input
              type="text"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              maxLength={300}
              placeholder="Leave blank to host on SoftN (/api/apps/<slug>/backend)"
            />
          </label>
          {hosting === 'server' && (
            <label className="check" style={{ alignSelf: 'end', paddingBottom: '0.5rem' }}>
              <input type="checkbox" checked={withholdBackend} onChange={(e) => setWithholdBackend(e.target.checked)} /> Withhold backend files from client download
            </label>
          )}
        </div>
      )}
    </>
  ) : null;

  // The form at the left, where the page starts; the apps this browser can
  // update and the way to publish from a script beside it once there is room,
  // and under it on a phone. They were all one 820px column in the middle of
  // the window, with "Your apps" a screen and a half below the heading.
  return (
    <main className="publish">
      <div className="wrap publish-layout">
        <div className="publish-main">
        {/* "Publish" over "Put an app in the directory" said the page's name twice; a remix's line says something the title does not. */}
        {parent && <p className="eyebrow">Publish a remix</p>}
        <h1 className="page-title">{parent ? `Your take on ${parent.name}` : 'Put an app in the directory'}</h1>
        <p className="band-sub">
          Drop a <code>.softn</code> bundle (or a whole folder) below — or publish directly from inside{' '}
          <a href={STUDIO_HREF}>AI Studio</a> and <a href={BUILDER_HREF}>Builder</a> without leaving the editor. No account needed: you get an edit key when it goes live.
        </p>

        {!single && !parent && (
          <div className="publish-create-strip" aria-label="Build and publish directly from an editor">
            <a className="publish-create-card" href={STUDIO_HREF}>
              <span className="publish-create-title">Build in AI Studio →</span>
              <span className="muted">Describe an app with AI, preview it live, and click Publish right inside Studio.</span>
            </a>
            <a className="publish-create-card" href={BUILDER_HREF}>
              <span className="publish-create-title">Build in Visual Builder →</span>
              <span className="muted">Compose pages and XDB tables visually, then publish straight to the directory.</span>
            </a>
          </div>
        )}

        <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} what="so there is none to choose yet" />

        <form className="publish-form" onSubmit={submit}>
          <BundleDrop item={single} onFiles={(files) => void takeFiles(files)} />
          {selection.mode === 'batch' && !isSettled(selection) && (
            <p className="muted" role="status">
              Reading {selection.items.length} bundles… {selection.items.length - pendingCount(selection)} of {selection.items.length} read.
            </p>
          )}
          <PrepublishReport info={info} />

          {matchingOwnedSlug && (
            <div className="publish-owned-notice" role="status">
              <span>
                You already have an edit key for <strong>{matchingOwnedSlug}</strong> in this browser.
              </span>
              <a className="link-btn" href={`/publish?update=${encodeURIComponent(matchingOwnedSlug)}`}>
                Push a new version to {matchingOwnedSlug} instead →
              </a>
            </div>
          )}

          {info && !info.problem && (
            <section className="publish-preview" aria-label="Live directory card preview">
              <div className="publish-preview-thumb">
                {thumb ? (
                  <img src={thumb.url} alt="" />
                ) : info.iconDataUrl ? (
                  <img className="publish-preview-icon" src={info.iconDataUrl} alt="" />
                ) : (
                  <span className="publish-preview-letter" aria-hidden="true">
                    {((name || info.name).trim().charAt(0) || '?').toUpperCase()}
                  </span>
                )}
              </div>
              <div className="publish-preview-body">
                <div className="publish-preview-top">
                  <strong className="publish-preview-name">{name.trim() || info.name}</strong>
                  <span className="muted publish-preview-ver">v{info.version}</span>
                </div>
                <p className="publish-preview-desc">
                  {description.trim() || info.description || 'Add a short description so visitors know what this app does.'}
                </p>
                <div className="publish-preview-meta">
                  <span className="badge badge-safe">
                    <span className="badge-dot" aria-hidden="true" />
                    Sandboxed
                  </span>
                  {selectedCategory && (
                    <span className="badge">
                      {selectedCategory.emoji} {selectedCategory.name}
                      {selectedSubcategory ? ` · ${selectedSubcategory.name}` : ''}
                    </span>
                  )}
                  <span className="badge">
                    {effectiveHosting === 'browser' ? 'Browser sandbox' : effectiveHosting === 'hybrid' ? 'Hosted + local' : 'Hosted on SoftN'}
                  </span>
                  {info.capabilities.length === 0 ? (
                    <span className="badge">No capabilities</span>
                  ) : (
                    info.capabilities.map((c) => (
                      <span key={c} className="badge">
                        {c}
                      </span>
                    ))
                  )}
                  {!info.capabilities.includes('net') && <span className="badge">No general network access</span>}
                  {author.trim() && <span className="muted">by {author.trim()}</span>}
                </div>
              </div>
            </section>
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
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setSubcategory('');
                }}
                required
              >
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
          {quickCategories.length > 0 && (
            <div className="publish-quick-cats" role="group" aria-label="Quick-pick category">
              {quickCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`pill ${category === c.id ? 'on' : ''}`}
                  aria-pressed={category === c.id}
                  onClick={() => {
                    setCategory(c.id);
                    setSubcategory('');
                  }}
                >
                  {c.emoji ? `${c.emoji} ` : ''}
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {selectedSubcategories.length > 0 && (
            <div className="field">
              <label className="field">
                <span className="field-label">Subcategory (optional)</span>
                <select value={subcategory} onChange={(e) => setSubcategory(e.target.value)}>
                  <option value="">None (top-level in {selectedCategory?.name})</option>
                  {selectedSubcategories.map((sub) => (
                    <option key={sub.slug} value={sub.slug}>
                      {sub.emoji} {sub.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="publish-quick-cats publish-quick-subs" role="group" aria-label="Quick-pick subcategory">
                {selectedSubcategories.map((sub) => (
                  <button
                    key={sub.slug}
                    type="button"
                    className={`pill pill-sub ${subcategory === sub.slug ? 'on' : ''}`}
                    aria-pressed={subcategory === sub.slug}
                    onClick={() => setSubcategory(subcategory === sub.slug ? '' : sub.slug)}
                  >
                    {sub.emoji ? `${sub.emoji} ` : ''}
                    {sub.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {suggesting && (
            <div className="suggest">
              {selectedCategory && (
                <label className="check">
                  <input type="checkbox" checked={suggestAsSub} onChange={(e) => setSuggestAsSub(e.target.checked)} />
                  <span>
                    Create as a subcategory under {selectedCategory.emoji} {selectedCategory.name}
                  </span>
                </label>
              )}
              <div className="field-row">
                <label className="field">
                  <span className="field-label">{suggestAsSub && selectedCategory ? 'New subcategory' : 'New category'}</span>
                  <input type="text" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} maxLength={32} placeholder={suggestAsSub ? 'e.g. Strategy' : 'e.g. Music toys'} />
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

          {allowPublicHosting && hasBackend && hostingControls}

          <details
            className="publish-more"
            open={showMore}
            onToggle={(e) => setShowMore(e.currentTarget.open)}
          >
            <summary className="publish-more-summary">
              <span>Optional details</span>
              <span className="muted">Tags, custom screenshot{allowPublicHosting && !hasBackend ? ', hosting mode' : ''} &amp; release notes</span>
            </summary>
            <div className="publish-more-body">
              <label className="field">
                <span className="field-label">Tags</span>
                <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="arcade, two-player, retro — up to eight, comma separated" />
              </label>
              <label className="field">
                <span className="field-label">Custom screenshot (optional)</span>
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
                  Leave blank and SoftN automatically captures a screenshot from your live app — or upload your own 16:10 image.
                </span>
                {thumb && (
                  <span className="thumb-preview">
                    <img src={thumb.url} alt="Thumbnail preview" />
                    <button type="button" className="link-btn" onClick={clearThumb}>
                      Remove custom screenshot
                    </button>
                  </span>
                )}
              </label>
              {!hasBackend && hostingControls}
              <label className="field">
                <span className="field-label">Notes for this version (optional)</span>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} placeholder="What changed, what to try first" />
              </label>
            </div>
          </details>

          <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="comment-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="publish-foot">
            <p className="muted">
              Published apps are public, downloaded to each visitor&rsquo;s browser, and always run locally inside the SoftN browser sandbox.
            </p>
            <button type="submit" className="cta cta-primary" disabled={single?.status !== 'ready' || !category || busy}>
              {busy ? 'Publishing…' : parentSlug ? 'Publish remix' : 'Publish'}
            </button>
          </div>
        </form>
        </div>

        <aside className="publish-side" aria-label="Your apps and publishing from a script">
        <YourApps />

        <section className="publish-api">
          <h2 className="section-title">Or publish from a script</h2>
          <p className="muted">
            The same thing, over HTTP. A build step, a bot, or a model with a tool can put an app in the directory with one request:
          </p>
          {/* It scrolls sideways on every width (the route list's URL is longer
              than the column), so it has to take focus to be scrolled by key. */}
          <pre className="source-code source-plain" tabIndex={0} role="region" aria-label="Publishing with curl">
            <code>{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : ''}/api/apps \\
  -F bundle=@my-app.softn \\
  -F category=games -F author="A robot" -F "tags=arcade,ai-made"

# or JSON: { "bundleBase64": "...", "category": "games", "author": "A robot" }
# The reply carries the page URL and the edit key. Full route list: ${typeof window !== 'undefined' ? window.location.origin : ''}/api`}</code>
          </pre>
        </section>
        </aside>
      </div>
    </main>
  );
}
