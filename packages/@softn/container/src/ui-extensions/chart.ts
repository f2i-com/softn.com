/**
 * `<softn-chart>`: Zero-React SVG chart Custom Element (bar & line charts) loaded on demand.
 */

const MAX_CHART_VALUES = 5000;
const SAFE_CHART_COLOR_RE =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]{3,24})$/i;

function sanitizeChartColor(raw: string | null): string {
  const trimmed = (raw ?? '').trim();
  return SAFE_CHART_COLOR_RE.test(trimmed) ? trimmed : '#3b82f6';
}

export function defineSoftnChart(): void {
  if (typeof customElements === 'undefined' || customElements.get('softn-chart')) return;

  class SoftnChart extends HTMLElement {
    static get observedAttributes(): string[] {
      return ['type', 'values', 'labels', 'color'];
    }

    private _values: number[] = [];
    private readonly root: ShadowRoot;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
    }

    set data(val: number[]) {
      this._values = Array.isArray(val)
        ? val.slice(0, MAX_CHART_VALUES).map(Number).filter(Number.isFinite)
        : [];
      this.render();
    }

    connectedCallback(): void {
      this.syncAttrs();
      this.render();
    }

    attributeChangedCallback(): void {
      this.syncAttrs();
      this.render();
    }

    private syncAttrs(): void {
      const raw = this.getAttribute('values');
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this._values = parsed.slice(0, MAX_CHART_VALUES).map(Number).filter(Number.isFinite);
        }
      } catch {
        this._values = raw
          .split(',')
          .slice(0, MAX_CHART_VALUES)
          .map((n) => Number(n.trim()))
          .filter(Number.isFinite);
      }
    }

    private render(): void {
      const kind = (this.getAttribute('type') ?? 'bar').toLowerCase();
      const color = sanitizeChartColor(this.getAttribute('color'));
      const vals = this._values;
      const w = 400;
      const h = 160;
      const pad = 16;

      if (vals.length === 0) {
        this.root.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block"></svg>`;
        return;
      }

      let max = 1;
      let min = 0;
      for (let i = 0; i < vals.length; i++) {
        if (vals[i] > max) max = vals[i];
        if (vals[i] < min) min = vals[i];
      }
      const span = max - min || 1;

      let shapes = '';
      if (kind === 'line') {
        const pts = vals
          .map((v, i) => {
            const x = pad + (vals.length === 1 ? (w - 2 * pad) / 2 : (i / (vals.length - 1)) * (w - 2 * pad));
            const y = h - pad - ((v - min) / span) * (h - 2 * pad);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        shapes = `<polyline fill="none" stroke="${escapeAttr(color)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />`;
      } else {
        const slot = (w - 2 * pad) / vals.length;
        const barW = Math.max(4, slot * 0.72);
        shapes = vals
          .map((v, i) => {
            const bh = Math.max(2, ((v - min) / span) * (h - 2 * pad));
            const x = pad + i * slot + (slot - barW) / 2;
            const y = h - pad - bh;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${escapeAttr(color)}" />`;
          })
          .join('');
      }

      this.root.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block">${shapes}</svg>`;
    }
  }

  customElements.define('softn-chart', SoftnChart);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
