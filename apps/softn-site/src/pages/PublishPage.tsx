import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  addVersion,
  forgetKey,
  getApp,
  publish,
  rememberKey,
  savedKey,
  savedKeys,
  setThumbnail,
  suggestCategory,
  unpublish,
  updateListing,
  type AppCard,
  type AppDetail,
  type Category,
  type Published,
} from '../lib/api';
import { copyText } from '../lib/share';
import { formatBytes, formatDate } from '../lib/format';
import { navigate, type Route } from '../lib/router';
import { Thumb } from '../components/directory/AppCard';
import { CategoriesNotice } from '../components/directory/Controls';
import { inspectBundle, type Inspection } from '../lib/inspectBundle';
import { openedForHandoff, takeBundleHandoff } from '../lib/handoff';
import { bundleFiles, onDroppedBundles, takeDroppedBundles } from '../lib/dropped';

const AUTHOR_KEY = 'softn.site.author';

/** One bundle of several dropped together, and what became of it. */
interface BatchItem {
  file: File;
  info: Inspection;
  status: 'pending' | 'publishing' | 'done' | 'failed' | 'skipped';
  result?: Published;
  error?: string;
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

/** A drop target for one .softn or several, with the inspection it triggers. */
function BundleDrop({ file, info, onFiles }: { file: File | null; info: Inspection | null; onFiles: (files: File[]) => void }): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
        }}
      />
      {file ? (
        <div className="dropzone-file">
          {info?.iconDataUrl && <img className="dropzone-icon" src={info.iconDataUrl} alt="" />}
          <div>
            <strong>{file.name}</strong> · {formatBytes(file.size)}
            {info && !info.problem && (
              <div className="muted">
                {info.name} v{info.version} · {info.files} files · entry {info.main}
                {info.execution === 'worker' && ' · off-main-thread'}
              </div>
            )}
            {info?.problem && <div className="form-error">{info.problem}</div>}
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

/** The apps this browser holds edit keys for. */
function YourApps(): React.ReactElement | null {
  const [apps, setApps] = useState<AppCard[] | null>(null);
  const keys = savedKeys();
  const slugs = Object.keys(keys);
  useEffect(() => {
    if (slugs.length === 0) return undefined;
    const ac = new AbortController();
    Promise.all(slugs.map((s) => getApp(s, ac.signal).catch(() => null)))
      .then((list) => {
        if (ac.signal.aborted) return;
        const found = list.filter((a): a is AppDetail => a !== null);
        // A key for an app that no longer exists is not worth keeping.
        for (const s of slugs) if (!found.some((a) => a.slug === s)) forgetKey(s);
        setApps(found);
      })
      .catch(() => setApps([]));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs.join(',')]);
  if (slugs.length === 0) return null;
  return (
    <section className="yours">
      <h2 className="section-title">
        Your apps <span className="section-count">edit keys kept in this browser</span>
      </h2>
      {apps === null ? (
        <p className="muted">Checking…</p>
      ) : (
        <ul className="yours-list">
          {apps.map((a) => (
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
          ))}
        </ul>
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
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspection | null>(null);
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

  const takeFile = useCallback(async (f: File) => {
    setFile(f);
    setError(null);
    setResult(null);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const i = inspectBundle(bytes);
    setInfo(i);
    if (!i.problem) {
      setName((n) => n || i.name);
      setDescription((d) => d || i.description);
    }
  }, []);

  // One file is the form below; several are a batch, each named and described
  // from its manifest and all filed under one category. A file that is not a
  // bundle is left out; a bundle the directory would refuse is listed as
  // skipped, with the reason.
  const takeFiles = useCallback(
    async (files: File[]) => {
      const bundles = bundleFiles(files);
      if (bundles.length === 0) {
        setError('None of those is a .softn bundle.');
        return;
      }
      if (bundles.length === 1) {
        setBatch(null);
        await takeFile(bundles[0]);
        return;
      }
      setFile(null);
      setInfo(null);
      setResult(null);
      setError(null);
      const items: BatchItem[] = await Promise.all(
        bundles.map(async (f) => {
          const info = inspectBundle(new Uint8Array(await f.arrayBuffer()));
          return { file: f, info, status: info.problem ? 'skipped' : 'pending' } as BatchItem;
        }),
      );
      setBatch(items);
    },
    [takeFile],
  );

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
  // to the ordinary upload, with a line saying why.
  useEffect(() => {
    if (!openedForHandoff()) return;
    void takeBundleHandoff().then((handoff) => {
      if (!handoff) {
        setError('Nothing was handed over from Builder or Studio. Choose the bundle file instead.');
        return;
      }
      void takeFile(new File([handoff.bytes as BlobPart], `${handoff.name || 'app'}.softn`, { type: 'application/zip' }));
    });
  }, [takeFile]);

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
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem(AUTHOR_KEY, author.trim());
      } catch {
        /* storage blocked */
      }
      const r = await publish({
        bundle: file,
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
      if (r.editKey) rememberKey(r.app.slug, r.editKey);
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
      if (item.status !== 'pending') continue;
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
        if (r.editKey) rememberKey(r.app.slug, r.editKey);
        setItem(i, { status: 'done', result: r });
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
    const done = batch.filter((b) => b.status === 'done').length;
    const failed = batch.filter((b) => b.status === 'failed').length;
    const finished = ready === 0 && !busy;
    const startOver = () => {
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
                : 'Each one has its own page and its own edit key, kept in this browser.'
              : 'Each is named and described from its manifest. They all go under the category you pick; you can change any listing afterwards with its edit key.'}
          </p>
          <ul className="batch-list">
            {batch.map((item, i) => (
              <li key={`${item.file.name}-${i}`} className={`batch-item is-${item.status}`}>
                {item.info.iconDataUrl ? <img className="dropzone-icon" src={item.info.iconDataUrl} alt="" /> : <span className="dropzone-icon" aria-hidden="true" />}
                <div className="batch-main">
                  <strong>{item.info.problem ? item.file.name : item.info.name}</strong>
                  {!item.info.problem && (
                    <span className="muted">
                      {' '}
                      v{item.info.version} · {formatBytes(item.file.size)}
                    </span>
                  )}
                  {item.status === 'skipped' && <div className="form-error">{item.info.problem}</div>}
                  {item.status === 'failed' && <div className="form-error">{item.error}</div>}
                  {item.status === 'done' && item.result && (
                    <div className="muted">
                      <a href={item.result.app.urls.page}>{window.location.origin + item.result.app.urls.page}</a>
                      {item.result.editKey && (
                        <>
                          {' '}
                          · edit key <code className="batch-key">{item.result.editKey}</code>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <span className="batch-status">
                  {item.status === 'pending' && 'ready'}
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
                <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="off" placeholder="From data/config.json on the server" />
                <span className="muted">Visitors may publish ten apps an hour. The admin key is not held to that, so a whole folder goes in at once.</span>
              </label>
              <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} className="comment-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              {error && <p className="form-error">{error}</p>}
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
                proves the app is yours. It has been kept in this browser, and it is not shown again after this page, so copy it
                somewhere safe too.
              </p>
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
          <BundleDrop file={file} info={info} onFiles={(files) => void takeFiles(files)} />
          <PrepublishReport info={info} />
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
              {suggestError && <p className="form-error">{suggestError}</p>}
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
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void takeThumb(f);
              }}
            />
            <span className="muted">Without one, the card shows the bundle&rsquo;s icon. Resized in your browser before upload; 16:10 fills the frame.</span>
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

          {error && <p className="form-error">{error}</p>}
          <div className="publish-foot">
            <p className="muted">
              By publishing you make the bundle public: anyone can run it, read it and remix it. Apache-2.0-style openness is the
              point.
            </p>
            <button type="submit" className="cta cta-primary" disabled={!file || !!info?.problem || !category || busy}>
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
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspection | null>(null);
  const [notes, setNotes] = useState('');
  const [thumb, setThumb] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
      if (remember) rememberKey(slug, key.trim());
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        forgetKey(slug);
        setError('That edit key does not open this app.');
      } else setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const takeFile = async (f: File) => {
    setFile(f);
    setError(null);
    setInfo(inspectBundle(new Uint8Array(await f.arrayBuffer())));
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
          <div className="empty">
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
            <a href={app.urls.remix}>remix it</a> — it will credit where it came from.
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
            />
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Keep it in this browser
            </label>
          </label>
          {key && !keyOk && <p className="form-error">An edit key is 40 hex characters.</p>}
        </section>

        {done && <div className="notice notice-ok">{done}</div>}
        {error && <p className="form-error">{error}</p>}

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
          <BundleDrop file={file} info={info} onFiles={(files) => void takeFile(files[0])} />
          <label className="field">
            <span className="field-label">What changed</span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={400} placeholder="Shown under the version on the app page" />
          </label>
          <button
            type="button"
            className="cta cta-primary"
            disabled={!keyOk || !file || !!info?.problem || busy !== null}
            onClick={() =>
              withKey('version', async (k) => {
                if (!file) return;
                const a = await addVersion(slug, k, file, notes.trim());
                setApp(a);
                setFile(null);
                setInfo(null);
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
