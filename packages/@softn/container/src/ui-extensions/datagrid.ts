/**
 * `<softn-datagrid>`: Zero-React, lazy-loaded Custom Element for sortable/searchable tabular data.
 * Accepts data via `rows` JSON attribute or `.rows` property, and emits `CustomEvent('row-click')`.
 */

const MAX_GRID_ROWS = 5000;
const MAX_GRID_COLS = 64;
const BLOCKED_GRID_COLS = new Set(['__proto__', 'constructor', 'prototype']);

function safeCellValue(row: Record<string, unknown>, col: string): unknown {
  if (!row || typeof row !== 'object' || BLOCKED_GRID_COLS.has(col)) return undefined;
  return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : undefined;
}

export function defineSoftnDataGrid(): void {
  if (typeof customElements === 'undefined' || customElements.get('softn-datagrid')) return;

  class SoftnDataGrid extends HTMLElement {
    static get observedAttributes(): string[] {
      return ['rows', 'columns', 'searchable'];
    }

    private _rows: Array<Record<string, unknown>> = [];
    private _filtered: Array<Record<string, unknown>> = [];
    private _sortKey = '';
    private _sortDir: 1 | -1 = 1;
    private _query = '';
    private _mounted = false;
    private readonly root: ShadowRoot;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      // Single delegated listener instead of attaching up to 5,000 per-row click listeners on every render.
      this.root.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        const th = target.closest('th[data-col]');
        if (th) {
          const col = th.getAttribute('data-col') ?? '';
          if (this._sortKey === col) this._sortDir = this._sortDir === 1 ? -1 : 1;
          else {
            this._sortKey = col;
            this._sortDir = 1;
          }
          this.render();
          return;
        }
        const tr = target.closest('tr[data-idx]');
        if (tr) {
          const idx = Number(tr.getAttribute('data-idx'));
          const row = this._filtered[idx];
          if (row) {
            this.dispatchEvent(new CustomEvent('row-click', { detail: row, bubbles: true }));
          }
        }
      });
    }

    get rows(): Array<Record<string, unknown>> {
      return this._rows;
    }

    set rows(val: Array<Record<string, unknown>>) {
      this._rows = Array.isArray(val)
        ? val.slice(0, MAX_GRID_ROWS).filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && !Array.isArray(r)))
        : [];
      this.render();
    }

    connectedCallback(): void {
      this.syncRowsFromAttr();
      this.render();
    }

    attributeChangedCallback(name: string): void {
      if (name === 'rows') this.syncRowsFromAttr();
      this.render();
    }

    private syncRowsFromAttr(): void {
      const raw = this.getAttribute('rows');
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this._rows = parsed
            .slice(0, MAX_GRID_ROWS)
            .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && !Array.isArray(r)));
        }
      } catch {
        // Ignore invalid JSON
      }
    }

    private render(): void {
      const colAttr = this.getAttribute('columns');
      const cols = (
        colAttr
          ? colAttr.split(',').map((c) => c.trim()).filter(Boolean)
          : this._rows.length > 0
            ? Object.keys(this._rows[0]).filter((k) => !k.startsWith('_'))
            : []
      )
        .filter((c) => !BLOCKED_GRID_COLS.has(c))
        .slice(0, MAX_GRID_COLS);

      const q = this._query.toLowerCase();
      const filtered = q
        ? this._rows.filter((r) => cols.some((c) => String(safeCellValue(r, c) ?? '').toLowerCase().includes(q)))
        : [...this._rows];

      if (this._sortKey && !BLOCKED_GRID_COLS.has(this._sortKey)) {
        const k = this._sortKey;
        const dir = this._sortDir;
        filtered.sort((a, b) => {
          const av = safeCellValue(a, k);
          const bv = safeCellValue(b, k);
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
          return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
        });
      }

      this._filtered = filtered;
      const searchable = this.hasAttribute('searchable');

      if (!this._mounted) {
        this._mounted = true;
        this.root.innerHTML = `
          <style>
            :host { display: block; font-family: inherit; }
            .toolbar { margin-bottom: 0.5rem; }
            input { padding: 0.4rem 0.65rem; border: 1px solid var(--softn-border, #cbd5e1); border-radius: 6px; width: 100%; max-width: 280px; background: inherit; color: inherit; }
            table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
            th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--softn-border, #e2e8f0); }
            th { cursor: pointer; user-select: none; font-weight: 600; color: var(--softn-muted, #64748b); }
            tr:hover td { background: rgba(148, 163, 184, 0.08); }
          </style>
          <div class="toolbar" hidden><input type="search" placeholder="Search..."></div>
          <table><thead></thead><tbody></tbody></table>
        `;
        const searchInput = this.root.querySelector('input');
        searchInput?.addEventListener('input', () => {
          this._query = searchInput.value;
          this.render();
        });
      }

      const toolbar = this.root.querySelector('.toolbar') as HTMLElement | null;
      if (toolbar) toolbar.hidden = !searchable;
      const searchInput = this.root.querySelector('input');
      if (searchInput && searchInput.value !== this._query) searchInput.value = this._query;

      const thead = this.root.querySelector('thead');
      const tbody = this.root.querySelector('tbody');
      if (thead) {
        thead.innerHTML = `<tr>${cols.map((c) => `<th data-col="${escapeAttr(c)}">${escapeHtml(c)}${this._sortKey === c ? (this._sortDir === 1 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
      }
      if (tbody) {
        tbody.innerHTML = filtered
          .map((row, idx) => `<tr data-idx="${idx}">${cols.map((c) => `<td>${escapeHtml(String(safeCellValue(row, c) ?? ''))}</td>`).join('')}</tr>`)
          .join('');
      }
    }
  }

  customElements.define('softn-datagrid', SoftnDataGrid);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
