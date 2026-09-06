/** Numbers and dates the way a card has room for. */

import { describeCapability } from './capabilities';

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)} d ago`;
  if (d < 30) return `${Math.floor(d / 7)} w ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} y ago`;
}

export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The capabilities an app declared, as the one line a visitor reads first.
 * "safe" means nothing declared reaches towards the person — their network,
 * camera, microphone or files — not that the app is harmless.
 */
export function capabilitySummary(capabilities: string[]): { label: string; safe: boolean } {
  if (capabilities.length === 0) return { label: 'Sandboxed · No capabilities', safe: true };
  const described = capabilities.map(describeCapability);
  const listed = described.map((c) => c.label);
  const safe = !described.some((c) => c.sensitive);
  return { label: `Sandboxed · ${listed.join(' · ')}${capabilities.includes('net') ? '' : ' · No network'}`, safe };
}
