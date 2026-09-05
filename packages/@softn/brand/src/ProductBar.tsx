import React from 'react';
import { Mark } from './Mark';
import { ThemeToggle } from './ThemeToggle';

/** The five places the bar can take you, plus where the source lives. */
export interface ProductUrls {
  home: string;
  apps: string;
  runtime: string;
  studio: string;
  builder: string;
  publish: string;
  repo: string;
}

/**
 * The production layout: one origin, the site at `/`, each app in its own
 * directory. `npm run dev` proxies the same paths, so these work there too;
 * an app run on its own port overrides what it knows.
 */
export const DEFAULT_URLS: ProductUrls = {
  home: '/',
  apps: '/apps',
  runtime: '/web/',
  studio: '/studio/',
  builder: '/builder/',
  publish: '/publish',
  repo: 'https://github.com/f2i-com/softn.com',
};

export type Product = 'home' | 'apps' | 'runtime' | 'studio' | 'builder' | 'publish';

const PRODUCTS: Array<{ id: Exclude<Product, 'home'>; label: string }> = [
  { id: 'apps', label: 'Apps' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'studio', label: 'Studio' },
  { id: 'builder', label: 'Builder' },
  { id: 'publish', label: 'Publish' },
];

export interface ProductBarProps {
  /** Which product this bar sits on, so it can be marked. */
  current: Product | null;
  urls?: Partial<ProductUrls>;
  /** `site`: measured and guttered. `app`: edge to edge over a tool. */
  layout?: 'site' | 'app';
  /** Stick to the top while the page scrolls. The tool apps do not scroll. */
  sticky?: boolean;
  /** Controls that belong to this product, placed before the theme switch. */
  children?: React.ReactNode;
}

/**
 * The strip at the top of every SoftN surface. It is the same element in the
 * site, the runtime, Studio and Builder — the same mark, the same five
 * destinations, the same theme switch — so that moving between them feels
 * like moving around one product rather than leaving it.
 */
export function ProductBar({ current, urls, layout = 'site', sticky = layout === 'site', children }: ProductBarProps): React.ReactElement {
  const href: ProductUrls = { ...DEFAULT_URLS, ...urls };
  return (
    <nav className="softn-bar" data-layout={layout} data-sticky={sticky ? 'true' : 'false'} aria-label="SoftN">
      <div className="softn-bar-inner">
        <a className="softn-bar-mark" href={href.home} aria-current={current === 'home' ? 'page' : undefined}>
          <Mark size={22} radius={6} />
          softn
        </a>
        <div className="softn-bar-links">
          {PRODUCTS.map((p) => (
            <a key={p.id} href={href[p.id]} aria-current={current === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </div>
        {children && <div className="softn-bar-extra">{children}</div>}
        <ThemeToggle />
        <a className="softn-bar-repo" href={href.repo} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
    </nav>
  );
}
