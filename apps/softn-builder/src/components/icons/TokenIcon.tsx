type TokenKind = 'layout' | 'form' | 'display' | 'data' | 'chart' | 'smart' | 'utility';

function resolveKind(token?: string): TokenKind {
  const key = (token || '').toLowerCase();
  if (['layout', 'layers', 'square', 'grid', 'maximize', 'minimize', 'columns', 'panel'].includes(key)) {
    return 'layout';
  }
  if (['form', 'input', 'checkbox', 'toggle', 'radio', 'calendar', 'slider', 'palette'].includes(key)) {
    return 'form';
  }
  if (['text', 'heading', 'badge', 'image', 'alert', 'toast', 'modal', 'inbox', 'markdown'].includes(key)) {
    return 'display';
  }
  if (['table', 'list', 'tree', 'pagination', 'tabs', 'menu', 'breadcrumb'].includes(key)) {
    return 'data';
  }
  if (['chart', 'line', 'bar', 'pie', 'area', 'radar', 'gauge'].includes(key)) {
    return 'chart';
  }
  if (['smart', 'sparkles', 'repeat', 'clock', 'code', 'keyboard', 'cube'].includes(key)) {
    return 'smart';
  }
  return 'utility';
}

interface TokenIconProps {
  token?: string;
  size?: number;
  color?: string;
}

export function TokenIcon({ token, size = 14, color = '#334155' }: TokenIconProps) {
  const kind = resolveKind(token);
  const stroke = { stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  if (kind === 'layout') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2" {...stroke} />
        <path d="M8 2v12M2 8h12" {...stroke} />
      </svg>
    );
  }

  if (kind === 'form') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" {...stroke} />
        <path d="M4.5 6h7M4.5 10h4.5" {...stroke} />
      </svg>
    );
  }

  if (kind === 'display') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 4h10M3 8h10M3 12h6" {...stroke} />
      </svg>
    );
  }

  if (kind === 'data') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.2" y="2.5" width="11.6" height="11" rx="1.6" {...stroke} />
        <path d="M2.2 6.2h11.6M6 2.5v11M10 2.5v11" {...stroke} />
      </svg>
    );
  }

  if (kind === 'chart') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 13.5h11" {...stroke} />
        <rect x="4" y="8" width="2" height="4.5" rx="0.6" fill={color} opacity="0.8" />
        <rect x="7" y="6" width="2" height="6.5" rx="0.6" fill={color} opacity="0.8" />
        <rect x="10" y="4.5" width="2" height="8" rx="0.6" fill={color} opacity="0.8" />
      </svg>
    );
  }

  if (kind === 'smart') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8.8 2.1 5.1 7.5h2.7l-.4 6.4 3.7-5.4H8.4l.4-6.4Z" {...stroke} />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" {...stroke} />
      <path d="M8 4.7v3.6l2.3 2.1" {...stroke} />
    </svg>
  );
}
