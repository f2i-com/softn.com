import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getApp, publish, suggestCategory, type AppCard, type Category, type Published } from '../../lib/api';
import { rememberKey, type KeyStoreResult } from '../../lib/keyStore';
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
import { KeyBackupDownload, KeyKeptNotice } from './keys';
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
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [website, setWebsite] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [newCat, setNewCat] = useState({ name: '', emoji: '', description: '' });
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { thumb, take: takeThumb } = useThumbnail(setError);
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
  const filledRef = useRef({ name: '', description: '' });
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
        filledRef.current = { name: i.name, description: i.description };
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
      working(false);
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
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <p className="eyebrow">Published</p>
          <h1 className="page-title">{app.name} is live.</h1>
          <p className="band-sub">
            It is in the directory under {filedUnder ? filedUnder.name : app.category}, at <a href={app.urls.page}>{window.location.origin + app.urls.page}</a>.
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
          A <code>.softn</code> bundle from <a href={STUDIO_HREF}>Studio</a>, <a href={BUILDER_HREF}>Builder</a> or your own editor — or several at
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
      </div>
    </main>
  );
}
