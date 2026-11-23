/**
 * Lightweight, zero-Intl Australian formatting helpers so every compiled React
 * SoftN child app runs on `zipp-javascript-lite.wasm` (~788 KB Brotli) for instant boot.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatAud(amount: number, symbol = '$'): string {
  const n = Number(amount);
  const neg = n < 0;
  const abs = Math.abs(Number.isFinite(n) ? n : 0);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${symbol}${withCommas}.${decPart}`;
}

export function formatCompactAud(amount: number, symbol = '$'): string {
  const n = Number(amount);
  const neg = n < 0;
  const abs = Math.abs(Number.isFinite(n) ? n : 0);
  let out: string;
  if (abs >= 1_000_000) {
    out = `${(abs / 1_000_000).toFixed(2)}M`;
  } else if (abs >= 10_000) {
    out = `${(abs / 1_000).toFixed(1)}k`;
  } else {
    const rounded = Math.round(abs);
    out = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return `${neg ? '-' : ''}${symbol}${out}`;
}

export function formatAuDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!match) return String(iso);
  const year = match[1];
  const monthIdx = Math.max(0, Math.min(11, parseInt(match[2], 10) - 1));
  const day = parseInt(match[3], 10);
  return `${day} ${MONTHS[monthIdx]} ${year}`;
}

export function formatNumber(n: number, decimals = 0): string {
  const val = Number.isFinite(Number(n)) ? Number(n) : 0;
  const fixed = val.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

export function formatPercent(n: number, decimals = 1): string {
  const val = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `${val.toFixed(decimals)}%`;
}

export function formatAbn(raw: string | null | undefined): string {
  if (!raw) return '—';
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length !== 11) return String(raw);
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 11)}`;
}

export function initialsOf(name: string): string {
  const parts = String(name || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
