import React, { useEffect, useRef, useState } from 'react';
import type { Category } from '../../lib/api';
import { navigate } from '../../lib/router';

export const SORTS: Array<{ id: string; name: string }> = [
  { id: 'trending', name: 'Trending' },
  { id: 'newest', name: 'Newest' },
  { id: 'top', name: 'Top rated' },
  { id: 'remixed', name: 'Most remixed' },
  { id: 'runs', name: 'Most played' },
  { id: 'name', name: 'A to Z' },
];

/** The search box. Submitting goes to the directory with the words. */
export function SearchBox({
  initial = '',
  autoFocus = false,
  onSearch,
  placeholder = 'Search apps — games, tools, anything',
}: {
  initial?: string;
  autoFocus?: boolean;
  onSearch?: (q: string) => void;
  placeholder?: string;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (onSearch) onSearch(q);
        else navigate(q ? `/apps?q=${encodeURIComponent(q)}` : '/apps');
      }}
    >
      <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search apps"
        autoFocus={autoFocus}
        autoComplete="off"
        enterKeyHint="search"
      />
      <button type="submit" className="search-go">
        Search
      </button>
    </form>
  );
}

/** Category pills, with a visitor's suggested ones set apart. */
export function CategoryChips({
  categories,
  selected,
  hrefFor,
  onSelect,
  limit,
}: {
  categories: Category[];
  selected: string;
  hrefFor: (id: string) => string;
  onSelect?: (id: string) => void;
  limit?: number;
}): React.ReactElement {
  const shown = limit ? categories.filter((c) => !c.suggested || c.apps > 0).slice(0, limit) : categories;
  const pill = (id: string, label: string, extra?: string) => (
    <a
      key={id}
      className={`pill ${selected === id ? 'on' : ''} ${extra ?? ''}`}
      href={hrefFor(id)}
      aria-current={selected === id ? 'page' : undefined}
      onClick={
        onSelect
          ? (e) => {
              e.preventDefault();
              onSelect(id);
            }
          : undefined
      }
    >
      {label}
    </a>
  );
  return (
    <div className="pills">
      {pill('all', 'All')}
      {shown.map((c) => pill(c.id, `${c.emoji ? `${c.emoji} ` : ''}${c.name}${c.apps ? ` · ${c.apps}` : ''}`, c.suggested ? 'pill-suggested' : undefined))}
    </div>
  );
}

export function SortSelect({ value, onChange }: { value: string; onChange: (id: string) => void }): React.ReactElement {
  return (
    <label className="sort">
      <span className="sort-label">Sort</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Sort apps">
        {SORTS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Pagination({ page, pages, hrefFor, onPage }: { page: number; pages: number; hrefFor: (p: number) => string; onPage?: (p: number) => void }): React.ReactElement | null {
  if (pages <= 1) return null;
  const items: Array<number | '…'> = [];
  const push = (n: number) => {
    if (n >= 1 && n <= pages && !items.includes(n)) items.push(n);
  };
  push(1);
  if (page - 2 > 2) items.push('…');
  for (let n = page - 2; n <= page + 2; n++) push(n);
  if (page + 2 < pages - 1) items.push('…');
  push(pages);
  const link = (p: number, label: React.ReactNode, cls = '') => (
    <a
      key={`p${p}${cls}`}
      className={`page-link ${cls} ${p === page ? 'on' : ''}`}
      href={hrefFor(p)}
      aria-current={p === page ? 'page' : undefined}
      onClick={
        onPage
          ? (e) => {
              e.preventDefault();
              onPage(p);
            }
          : undefined
      }
    >
      {label}
    </a>
  );
  return (
    <nav className="pagination" aria-label="Pages">
      {page > 1 && link(page - 1, '‹ Prev', 'page-prev')}
      {items.map((it, i) => (typeof it === 'number' ? link(it, it) : <span key={`e${i}`} className="page-ellipsis">…</span>))}
      {page < pages && link(page + 1, 'Next ›', 'page-next')}
    </nav>
  );
}

/** A small popover anchored to whatever renders it; closes on outside click or Escape. */
export function Popover({ open, onClose, children, align = 'right' }: { open: boolean; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right' }): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`popover popover-${align}`} ref={ref} role="menu">
      {children}
    </div>
  );
}
