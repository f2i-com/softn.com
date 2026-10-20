import React, { useCallback, useEffect, useState } from 'react';
import { ApiError, addVersion, getApp, replaceKey, setThumbnail, unpublish, updateListing, type AppDetail, type Category } from '../../lib/api';
import { forgetKey, isEditKey, rememberKey, savedKey } from '../../lib/keyStore';
import { formatBytes, formatDate, runsLabel } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Thumb } from '../directory/AppCard';
import { CategoriesNotice } from '../directory/Controls';
import { BundleDrop } from './BundleDrop';
import { KeyImport, ReplaceKey } from './keys';
import { errorText, singleItem, useDroppedBundles, useSelection, useThumbnail, type CategoriesStatus } from './shared';

/**
 * The other half of publishing: with the edit key, change the listing, push
 * a new version, replace the screenshot, or take the app down.
 */
export function UpdatePage({ slug, categories, categoriesError, onRetryCategories }: { slug: string; categories: Category[] } & CategoriesStatus): React.ReactElement {
  const [app, setApp] = useState<AppDetail | null>(null);
  /** Why the app did not load; `missing` is the directory saying 404, the one failure a retry cannot fix. */
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [key, setKey] = useState(() => savedKey(slug) ?? '');
  /**
   * Whether the key is shown as text. It starts hidden, as on Your apps: a
   * key kept in this browser was filled in here in plain text, on screen for
   * anyone looking or recording it.
   */
  const [keyShown, setKeyShown] = useState(false);
  const [remember, setRemember] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [selection, selector] = useSelection();
  const single = singleItem(selection);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { thumb, take: takeThumb, clear: clearThumb } = useThumbnail(setError);
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
        if (!ac.signal.aborted) setLoadError({ message: e instanceof Error ? e.message : String(e), missing: e instanceof ApiError && e.status === 404 });
      });
    return () => ac.abort();
  }, [slug, loadAttempt]);

  const keyOk = isEditKey(key.trim());
  /**
   * Run an owner action with the key in the field, then keep that key in
   * this browser if asked to. An action after which there is no key to keep
   * says so with `{ keep: false }`: unpublishing forgot the app's key and
   * this then wrote it straight back.
   */
  const withKey = async (label: string, fn: (k: string) => Promise<{ keep: false } | void>) => {
    if (!keyOk || busy) return;
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const outcome = await fn(key.trim());
      if (remember && outcome?.keep !== false) {
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
  const takeFile = useCallback(
    async (f: File) => {
      setError(null);
      const outcome = await selector.select([f]);
      if (outcome.outcome === 'rejected') setError(outcome.reason);
    },
    [selector],
  );
  // A bundle dropped beside the zone is stashed by the page-wide handler,
  // whose overlay says it goes into the form. This form takes one bundle, so
  // the first is the new version; the rest are let go rather than left for
  // the new-app form to find the next time it opens.
  const takeDropped = useCallback(
    ([first]: File[]) => {
      void takeFile(first);
    },
    [takeFile],
  );
  useDroppedBundles(takeDropped);

  if (loadError) {
    return (
      <main className="publish">
        <div className="wrap wrap-narrow">
          <div className="empty" role="alert">
            <p className="eyebrow">{loadError.missing ? 'Not here' : 'Not loaded'}</p>
            <h1 className="page-title">Could not load that app.</h1>
            <p className="muted">{loadError.message}</p>
            <p className="app-actions">
              {!loadError.missing && (
                <button
                  type="button"
                  className="cta cta-primary"
                  onClick={() => {
                    setLoadError(null);
                    setLoadAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              )}
              <a className={loadError.missing ? 'cta cta-primary' : 'cta'} href="/apps">
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
          v{app.version} · published {formatDate(app.createdAt)} · {runsLabel(app.runs)}. Everything here needs the edit key publishing handed out.
        </p>
        <CategoriesNotice error={categoriesError} onRetry={onRetryCategories} what="so the listing cannot be moved to another yet" />

        <section className="update-section">
          {/* Two controls, two labels: a label inside a label gives the key
              field the checkbox's words as part of its name. */}
          <div className="field">
            <label className="field">
              <span className="field-label">Edit key</span>
              <input
                type={keyShown ? 'text' : 'password'}
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
            <span className="muted">
              <button type="button" className="link-btn" aria-expanded={keyShown} onClick={() => setKeyShown((shown) => !shown)}>
                {keyShown ? 'Hide key' : 'Show key'}
              </button>
            </span>
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
              ; otherwise leave it, in case the directory was the problem. A key that was replaced (from another browser, say) is refused
              everywhere: use the new one, or ask the site owner for one.
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
                    clearThumb();
                    setDone('The screenshot is replaced.');
                  })
                }
              >
                {busy === 'thumb' ? 'Uploading…' : 'Use this picture'}
              </button>
            </div>
          </div>
        </section>

        <section className="update-section">
          <h2 className="section-title">Replace the key</h2>
          <p className="muted">
            If this key may have been seen by anyone else (copied from this browser, pasted somewhere, in a backup someone else has),
            replace it. The new key does everything this one did, and this one stops working everywhere.
          </p>
          <ReplaceKey
            disabled={!keyOk || busy !== null}
            run={async () => {
              const r = await replaceKey(slug, key.trim());
              // The new key goes where the old one was kept, and is kept if
              // asked to; the old one opens nothing now, wherever it is.
              const kept = remember || savedKey(slug) !== null ? rememberKey(slug, r.editKey) : null;
              setKey(r.editKey);
              setRefusedSavedKey(false);
              return { key: r.editKey, kept };
            }}
          />
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
                    return { keep: false };
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
