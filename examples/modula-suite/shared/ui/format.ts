/**
 * Lightweight, zero-Intl formatting utilities so every compiled React child app
 * stays on `zipp-javascript-lite.wasm` (~788 KB Brotli) for instant boot.
 */

export function formatMoney(amount: number, symbol = '$'): string {
  const neg = amount < 0;
  const abs = Math.abs(Number.isFinite(amount) ? amount : 0);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
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
    const rounded = Math.round(abs);
    out = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

export function initialsOf(name: string): string {
  const parts = String(name || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
