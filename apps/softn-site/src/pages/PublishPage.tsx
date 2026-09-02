import React, { useCallback, useEffect, useRef, useState } from 'react';
import { unzipSync } from 'fflate';
import { ApiError, getApp, publish, suggestCategory, type AppCard, type Category, type Published } from '../lib/api';
import { copyText } from '../lib/share';
import { formatBytes } from '../lib/format';
import { type Route } from '../lib/router';

const AUTHOR_KEY = 'softn.site.author';

interface Inspection {
  name: string;
  version: string;
  description: string;
  main: string;
  files: number;
  capabilities: string[];
  execution: string;
  iconDataUrl: string | null;
  problem: string | null;
}

/** What the bundle says about itself, read in the browser before anything is sent. */
function inspect(bytes: Uint8Array): Inspection {
  const empty: Inspection = { name: '', version: '', description: '', main: '', files: 0, capabilities: [], execution: 'main', iconDataUrl: null, problem: null };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ...empty, problem: 'That file is not a .softn bundle (it does not open as an archive).' };
  }
  const decoder = new TextDecoder();
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) return { ...empty, files: Object.keys(entries).length, problem: 'The bundle has no manifest.json.' };
  let manifest: { name?: string; version?: string; description?: string; main?: string; icon?: string; config?: { execution?: string } };
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch {
    return { ...empty, problem: 'The manifest.json is not valid JSON.' };
  }
  const capabilities: string[] = [];
  const perm = entries['permission.json'];
  if (perm) {
    try {
      const p = JSON.parse(decoder.decode(perm)) as { permissions?: Record<string, { enabled?: boolean }> };
      for (const [k, v] of Object.entries(p.permissions ?? {})) if (v?.enabled) capabilities.push(k);
    } catch {
      /* an unreadable permission file is the server's to refuse */
    }
  }
  let iconDataUrl: string | null = null;
  if (manifest.icon && entries[manifest.icon] && entries[manifest.icon].length < 512 * 1024) {
    const ext = manifest.icon.split('.').pop()?.toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : null;
    if (mime) {
      let bin = '';
      const data = entries[manifest.icon];
      for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
      iconDataUrl = `data:${mime};base64,${btoa(bin)}`;
    }
  }
  return {
    name: manifest.name ?? '',
    version: manifest.version ?? '',
    description: manifest.description ?? '',
    main: manifest.main ?? '',
    files: Object.keys(entries).filter((k) => !k.endsWith('/')).length,
    capabilities,
    execution: manifest.config?.execution === 'worker' ? 'worker' : 'main',
    iconDataUrl,
    problem: !manifest.name ? 'The manifest has no name.' : !manifest.main ? 'The manifest names no entry file.' : null,
  };
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

export function PublishPage({ route, categories, onCategories, apiDown }: { route: Route; categories: Category[]; onCategories: (c: Category[]) => void; apiDown: string | null }): React.ReactElement {
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
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    const i = inspect(bytes);
    setInfo(i);
    if (!i.problem) {
      setName((n) => n || i.name);
      setDescription((d) => d || i.description);
    }
  }, []);

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
      setResult(r);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof ApiError && err.retryAfter ? `${err.message} Try again in about ${Math.ceil(err.retryAfter / 60)} minutes.` : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
                proves the app is yours. Keep it somewhere safe. It is not shown again.
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
                To publish a new version later: <code>curl -F bundle=@app.softn -H &quot;X-Edit-Key: …&quot; {window.location.origin}/api/apps/{app.slug}/versions</code>
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
          A <code>.softn</code> bundle from <a href="/studio/">Studio</a>, <a href="/builder/">Builder</a> or your own editor. No account:
          you get an edit key when it is published, and that key is what lets you update it.
        </p>
        {apiDown && (
          <div className="notice">
            <strong>The directory is not answering.</strong> {apiDown}
          </div>
        )}

        <form className="publish-form" onSubmit={submit}>
          <div
            className={`dropzone ${dragging ? 'over' : ''} ${file ? 'has-file' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void takeFile(f);
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
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void takeFile(f);
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
                <strong>Drop a .softn here</strong> or click to choose one
              </>
            )}
          </div>

          {info && !info.problem && (
            <div className="capabilities-preview">
              <span className="muted">Its page will say:</span>
              <span className="badge badge-safe">
                <span className="badge-dot" aria-hidden="true" />
                Sandboxed
              </span>
              {info.capabilities.length === 0 ? <span className="badge">No capabilities</span> : info.capabilities.map((c) => <span key={c} className="badge">{c}</span>)}
              {!info.capabilities.includes('net') && <span className="badge">No network</span>}
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
            <span className="field-label">Screenshot (optional)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void takeThumb(f);
              }}
            />
            <span className="muted">Without one, the card shows the bundle's icon. Resized in your browser before upload.</span>
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
