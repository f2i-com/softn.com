/**
 * `<softn-chart>`: Zero-React SVG chart Custom Element (bar & line charts) loaded on demand.
 */

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
      this._values = Array.isArray(val) ? val.map(Number) : [];
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
        if (Array.isArray(parsed)) this._values = parsed.map(Number);
      } catch {
        this._values = raw.split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
      }
    }

    private render(): void {
      const kind = (this.getAttribute('type') ?? 'bar').toLowerCase();
      const color = this.getAttribute('color') ?? '#3b82f6';
      const vals = this._values;
      const w = 400;
      const h = 160;
      const pad = 16;

      if (vals.length === 0) {
        this.root.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block"></svg>`;
        return;
      }

      const max = Math.max(...vals, 1);
      const min = Math.min(...vals, 0);
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
