import { useEffect, useState } from 'react';
import { DEFAULT_URLS } from '@softn/brand';
import { listApps, type AppCard } from '../../../softn-site/src/lib/api';

/** Use the site's API client so this shelf and the directory show the same apps. */
export function DirectoryShelf({ onOpen }: { onOpen: (bundle: string) => void }) {
  const [apps, setApps] = useState<AppCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    listApps({ sort: 'trending', perPage: 6 }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.items)) throw new Error('Invalid directory response');
        setApps(
          result.items.filter(
            (app) => app && typeof app.slug === 'string' && typeof app.name === 'string'
          )
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="softn-launcher-section softn-explore" aria-labelledby="softn-explore-title">
      <div className="softn-launcher-section-head">
        <div>
          <h2 className="softn-launcher-section-title" id="softn-explore-title">
            Explore apps
          </h2>
          <p className="softn-explore-description">
            From the Softn directory, ready to open in your workspace.
          </p>
        </div>
        <a className="softn-explore-link" href={DEFAULT_URLS.apps}>
          Browse all apps <span aria-hidden="true">↗</span>
        </a>
      </div>
      {loading ? (
        <div className="softn-explore-message" role="status">
          Loading apps from the directory…
        </div>
      ) : error ? (
        <div className="softn-explore-message" role="status">
          <div>
            <strong>The directory is unavailable right now.</strong>
            <p>You can still open a file or use your saved apps.</p>
          </div>
          <button
            className="softn-explore-secondary"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry directory
          </button>
        </div>
      ) : apps.length === 0 ? (
        <div className="softn-explore-message">
          <div>
            <strong>No published apps yet on this site.</strong>
            <p>Create an app in Studio or Builder, then publish it to share it here.</p>
          </div>
          <a className="softn-explore-secondary" href={DEFAULT_URLS.publish}>
            Publish an app
          </a>
        </div>
      ) : (
        <div className="softn-launcher-grid">
          {apps.map((app) => {
            const slug = encodeURIComponent(app.slug);
            const external = app.external ? webUrl(app.external.url) : null;
            const bundle = !app.external ? webUrl(app.urls?.bundle, true) : null;
            const picture = webUrl(app.thumbnail);
            return (
              <article className="softn-explore-card" key={app.slug}>
                <a
                  className="softn-explore-picture"
                  href={`/app/${slug}`}
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <span>{app.name.charAt(0).toUpperCase()}</span>
                  {picture && (
                    <img
                      src={picture}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  )}
                </a>
                <div className="softn-explore-card-body">
                  <h3>
                    <a href={`/app/${slug}`}>{app.name}</a>
                  </h3>
                  <p>{typeof app.description === 'string' ? app.description : ''}</p>
                  <div className="softn-explore-card-actions">
                    {external ? (
                      <a
                        className="softn-explore-primary"
                        href={external}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${app.name} in a new tab`}
                      >
                        Visit app <span aria-hidden="true">↗</span>
                      </a>
                    ) : bundle ? (
                      <button
                        type="button"
                        className="softn-explore-primary"
                        onClick={() => onOpen(bundle)}
                        aria-label={`Run ${app.name}`}
                      >
                        Run app <span aria-hidden="true">→</span>
                      </button>
                    ) : (
                      <span className="softn-explore-description">View details to open</span>
                    )}
                    <a
                      className="softn-explore-link"
                      href={`/app/${slug}`}
                      aria-label={`About ${app.name}`}
                    >
                      Details
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="softn-explore-create" aria-label="Create with Softn">
        <div>
          <strong>Make it your own.</strong>
          <span>Start an app, then bring it here to run.</span>
        </div>
        <a className="softn-explore-secondary" href={DEFAULT_URLS.studio}>
          Create in Studio
        </a>
        <a className="softn-explore-secondary" href={DEFAULT_URLS.builder}>
          Open Builder
        </a>
      </div>
    </section>
  );
}

function webUrl(value: unknown, sameOrigin = false): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (sameOrigin && url.origin !== window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}
