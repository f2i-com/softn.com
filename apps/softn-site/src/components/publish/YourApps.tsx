import React, { useEffect, useState } from 'react';
import { ApiError, getApp, replaceKey, type AppDetail } from '../../lib/api';
import { forgetKey, rememberKey, savedKeys, savedKeysUnreadable } from '../../lib/keyStore';
import { formatDate, runsLabel } from '../../lib/format';
import { Thumb } from '../directory/AppCard';
import { KeyBackupDownload, ReplaceKey } from './keys';
import { errorText } from './shared';

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
 * row too, with a button to forget its key on purpose.
 *
 * A key is printed only when the person asks for it ("Show key"). Every row
 * that was gone or could not be checked used to print its key in full, which
 * during an outage was every key this browser held, on screen for anyone
 * looking or recording it. A row that loaded can have its key replaced.
 */
export function YourApps({ lookup }: { lookup?: typeof getApp } = {}): React.ReactElement | null {
  const [apps, setApps] = useState<OwnedApp[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [keys, setKeys] = useState<Record<string, string>>(() => savedKeys());
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [shownKeys, setShownKeys] = useState<string[]>([]);
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
                        v{a.version} · {runsLabel(a.runs)} · updated {formatDate(a.updatedAt)}
                      </span>
                      <ReplaceKey
                        compact
                        run={async () => {
                          const r = await replaceKey(a.slug, key);
                          const kept = rememberKey(a.slug, r.editKey);
                          setKeys(savedKeys());
                          return { key: r.editKey, kept };
                        }}
                      />
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
                        Its key is kept in this browser.{' '}
                        {shownKeys.includes(entry.slug) && (
                          <>
                            <code className="batch-key">{key}</code>{' '}
                          </>
                        )}
                        <button
                          type="button"
                          className="link-btn"
                          aria-expanded={shownKeys.includes(entry.slug)}
                          onClick={() => setShownKeys((shown) => (shown.includes(entry.slug) ? shown.filter((s) => s !== entry.slug) : [...shown, entry.slug]))}
                        >
                          {shownKeys.includes(entry.slug) ? 'Hide key' : 'Show key'}
                        </button>{' '}
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
