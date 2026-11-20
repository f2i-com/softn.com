import { useEffect, useMemo, useState } from 'react';
import { publicPath } from '../lib/appUrl';

export interface BusinessDemoEntry {
  slug: string;
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  file: string;
  bytes: number;
  sha256?: string;
  backend?: string;
  icon?: string | null;
}

function safeFile(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[^/\\]+\.softn$/i.test(value) || value.includes('..')) {
    return null;
  }
  return value;
}

function safeIcon(value: unknown): string | null {
  if (typeof value !== 'string' || !/^icons\/[a-z0-9-]+\.svg$/i.test(value) || value.includes('..')) {
    return null;
  }
  return value;
}

/**
 * Full-stack business demo apps hosted by SoftN Web, each running its own
 * PHP 8 (Slim 4) backend and XDB SQLite database locally inside the user's
 * browser sandbox (persisted to IndexedDB — zero external backend required).
 */
export function BusinessDemosShelf({ onOpen }: { onOpen: (bundle: string) => void }) {
  const [demos, setDemos] = useState<BusinessDemoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>('All');
  const [query, setQuery] = useState<string>('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(publicPath('business-demos/index.json', import.meta.env.BASE_URL), {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data: unknown) => {
        if (controller.signal.aborted || !data || typeof data !== 'object') return;
        const raw = Array.isArray((data as { demos?: unknown }).demos)
          ? ((data as { demos: unknown[] }).demos)
          : [];
        const valid: BusinessDemoEntry[] = [];
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const entry = item as Record<string, unknown>;
          const file = safeFile(entry.file);
          if (!file || typeof entry.slug !== 'string' || typeof entry.name !== 'string') continue;
          valid.push({
            slug: entry.slug,
            id: typeof entry.id === 'string' ? entry.id : entry.slug,
            name: entry.name,
            version: typeof entry.version === 'string' ? entry.version : '1.0.0',
            category: typeof entry.category === 'string' ? entry.category : 'Operations',
            description: typeof entry.description === 'string' ? entry.description : '',
            file,
            bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
            sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
            backend: typeof entry.backend === 'string' ? entry.backend : 'PHP 8 (Slim 4) + SQLite (XDB)',
            icon: safeIcon(entry.icon),
          });
        }
        setDemos(valid);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDemos([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const d of demos) set.add(d.category);
    return ['All', ...[...set].sort()];
  }, [demos]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return demos.filter((d) => {
      if (category !== 'All' && d.category !== category) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        d.slug.toLowerCase().includes(q)
      );
    });
  }, [demos, category, query]);

  if (!loading && demos.length === 0) return null;

  return (
    <section
      className="softn-launcher-section softn-demos"
      aria-labelledby="softn-business-demos-title"
    >
      <div className="softn-launcher-section-head">
        <div>
          <h2 className="softn-launcher-section-title" id="softn-business-demos-title">
            Sandboxed business demos
          </h2>
          <p className="softn-demos-sub">
            Full-stack PHP (Slim 4) + SQLite apps running locally inside your browser sandbox. No external server — your database stays in this browser.
          </p>
        </div>
        {!loading && (
          <span className="softn-launcher-section-count">
            {filtered.length === demos.length ? `${demos.length} apps` : `${filtered.length} of ${demos.length}`}
          </span>
        )}
      </div>

      {!loading && demos.length > 0 && (
        <div className="softn-demos-controls">
          <input
            type="search"
            className="softn-demos-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter business apps (cafe, clinic, finance, trades…)"
            aria-label="Filter sandboxed business demos"
          />
          <div className="softn-demos-pills" role="tablist" aria-label="Demo categories">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={category === cat}
                className="softn-demos-pill"
                data-active={category === cat ? 'true' : undefined}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="softn-explore-message" role="status">
          Loading sandboxed business demos…
        </div>
      ) : filtered.length === 0 ? (
        <div className="softn-explore-message" role="status">
          <div>
            <strong>No business demos match “{query}”.</strong>
            <p>Clear the search or pick another category.</p>
          </div>
          <button
            type="button"
            className="softn-explore-secondary"
            onClick={() => {
              setQuery('');
              setCategory('All');
            }}
          >
            Show all {demos.length}
          </button>
        </div>
      ) : (
        <div className="softn-demos-grid">
          {filtered.map((demo) => {
            const bundleHref = publicPath(`business-demos/${demo.file}`, import.meta.env.BASE_URL);
            const iconHref = demo.icon
              ? publicPath(`business-demos/${demo.icon}`, import.meta.env.BASE_URL)
              : null;
            return (
              <article className="softn-demo-card" key={demo.slug} data-demo-slug={demo.slug}>
                <div className="softn-demo-icon" aria-hidden="true">
                  {iconHref ? (
                    <img src={iconHref} alt="" loading="lazy" />
                  ) : (
                    <span>{demo.name.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <div className="softn-demo-body">
                  <div className="softn-demo-head">
                    <h3>{demo.name}</h3>
                    <span className="softn-demo-badge" title="PHP 8 (Slim 4) backend + XDB SQLite persisted in IndexedDB">
                      PHP + SQLite
                    </span>
                  </div>
                  <p>{demo.description}</p>
                  <div className="softn-demo-meta">
                    <span>{demo.category}</span>
                    {demo.bytes > 0 && <span>· {Math.round(demo.bytes / 1024)} KB</span>}
                  </div>
                </div>
                <div className="softn-demo-actions">
                  <button
                    type="button"
                    className="softn-explore-primary"
                    onClick={() => onOpen(bundleHref)}
                    aria-label={`Run ${demo.name}`}
                  >
                    Run <span aria-hidden="true">→</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
