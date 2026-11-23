/**
 * Zero-Intl formatting & color helpers so every BaseGrid React container
 * stays on `zipp-javascript-lite.wasm` for instant cold boot.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMoney(amount: number, symbol = '$'): string {
  const neg = amount < 0;
  const abs = Math.abs(Number.isFinite(amount) ? amount : 0);
  const fixed = abs.toFixed(0);
  const withCommas = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${symbol}${withCommas}`;
}

export function formatMoneyExact(amount: number, symbol = '$'): string {
  const neg = amount < 0;
  const abs = Math.abs(Number.isFinite(amount) ? amount : 0);
  const [intPart, decPart] = abs.toFixed(2).split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${symbol}${withCommas}.${decPart}`;
}

export function formatCompactMoney(amount: number, symbol = '$'): string {
  const neg = amount < 0;
  const abs = Math.abs(Number.isFinite(amount) ? amount : 0);
  let out: string;
  if (abs >= 1_000_000) {
    out = `${(abs / 1_000_000).toFixed(2)}M`;
  } else if (abs >= 10_000) {
    out = `${(abs / 1_000).toFixed(1)}k`;
  } else {
    out = String(Math.round(abs)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return `${neg ? '-' : ''}${symbol}${out}`;
}

export function formatNumber(n: number, decimals = 0): string {
  const val = Number.isFinite(n) ? n : 0;
  const fixed = val.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

export function formatPercent(n: number): string {
  const val = Number.isFinite(n) ? Math.round(n) : 0;
  return `${val}%`;
}

export function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return iso;
  const m = Number(parts[1]) - 1;
  const d = Number(parts[2]);
  if (m < 0 || m > 11 || !Number.isFinite(d)) return iso;
  return `${MONTHS[m]} ${d}, ${parts[0]}`;
}

export function initialsOf(name: string): string {
  const parts = String(name || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface PillTheme {
  bg: string;
  fg: string;
  dot: string;
  border: string;
}

const PILL_PALETTE: Record<string, PillTheme> = {
  blue: { bg: '#dbeafe', fg: '#1d4ed8', dot: '#2563eb', border: '#bfdbfe' },
  sky: { bg: '#e0f2fe', fg: '#0369a1', dot: '#0ea5e9', border: '#bae6fd' },
  teal: { bg: '#ccfbf1', fg: '#0f766e', dot: '#14b8a6', border: '#99f6e4' },
  green: { bg: '#dcfce7', fg: '#15803d', dot: '#16a34a', border: '#bbf7d0' },
  amber: { bg: '#fef3c7', fg: '#b45309', dot: '#d97706', border: '#fde68a' },
  orange: { bg: '#ffedd5', fg: '#c2410c', dot: '#ea580c', border: '#fed7aa' },
  red: { bg: '#fee2e2', fg: '#b91c1c', dot: '#dc2626', border: '#fecaca' },
  pink: { bg: '#fce7f3', fg: '#be185d', dot: '#db2777', border: '#fbcfe8' },
  purple: { bg: '#ede9fe', fg: '#6d28d9', dot: '#7c3aed', border: '#ddd6fe' },
  slate: { bg: '#f1f5f9', fg: '#334155', dot: '#64748b', border: '#e2e8f0' },
};

const PALETTE_KEYS = Object.keys(PILL_PALETTE);

const SEMANTIC_MAP: Record<string, string> = {
  'launched': 'green',
  'done': 'green',
  'complete': 'green',
  'completed': 'green',
  'published': 'green',
  'approved': 'green',
  'active': 'green',
  'synced': 'green',
  'succeeded': 'green',
  'won': 'green',
  'low': 'green',
  'low risk': 'green',
  'in progress': 'blue',
  'building': 'blue',
  'design': 'sky',
  'series b': 'purple',
  'series c': 'blue',
  'series a': 'teal',
  'seed': 'amber',
  'enterprise': 'purple',
  'tier 1': 'orange',
  'tier 2': 'amber',
  'tier 3': 'sky',
  'review': 'purple',
  'in review': 'purple',
  'reviewing': 'purple',
  'scheduled': 'sky',
  'beta': 'teal',
  'planning': 'amber',
  'planned': 'amber',
  'draft': 'slate',
  'backlog': 'slate',
  'new': 'blue',
  'paused': 'amber',
  'at risk': 'red',
  'high risk': 'red',
  'blocked': 'red',
  'critical': 'red',
  'high': 'orange',
  'urgent': 'red',
  'medium': 'amber',
  'failed': 'red',
  'p0': 'red',
  'p1': 'orange',
  'p2': 'amber',
  'p3': 'sky',
  'blog': 'blue',
  'video': 'pink',
  'webinar': 'purple',
  'social': 'teal',
  'email': 'amber',
  'case study': 'green',
  'product': 'purple',
  'marketing': 'pink',
  'engineering': 'blue',
  'sales': 'orange',
  'operations': 'teal',
  'design & ux': 'sky',
};

export function getPillTheme(value: string, explicitColor?: string): PillTheme {
  if (explicitColor && PILL_PALETTE[explicitColor]) {
    return PILL_PALETTE[explicitColor];
  }
  const key = String(value || '').trim().toLowerCase();
  if (SEMANTIC_MAP[key]) {
    return PILL_PALETTE[SEMANTIC_MAP[key]];
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE_KEYS.length;
  return PILL_PALETTE[PALETTE_KEYS[idx]];
}

export function csvEscape(val: unknown): string {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
