const ICON_MAP: Record<string, string> = {
  layout: 'LY',
  layers: 'LA',
  square: 'SQ',
  grid: 'GD',
  maximize: 'MX',
  minimize: 'MN',
  divide: 'DV',
  panel: 'PN',
  columns: 'CL',
  form: 'FM',
  input: 'IN',
  checkbox: 'CB',
  toggle: 'TG',
  radio: 'RD',
  calendar: 'CA',
  slider: 'SL',
  palette: 'PL',
  text: 'TX',
  heading: 'H1',
  badge: 'BD',
  image: 'IM',
  alert: 'AL',
  info: 'IF',
  toast: 'TS',
  modal: 'MD',
  inbox: 'IB',
  table: 'TB',
  list: 'LS',
  tree: 'TR',
  pagination: 'PG',
  tabs: 'TB',
  menu: 'MN',
  breadcrumb: 'BC',
  tooltip: 'TT',
  repeat: 'RP',
  move: 'MV',
  'move-horizontal': 'MH',
  'list-ordered': 'OL',
  sparkles: 'SP',
  chart: 'CH',
  line: 'LN',
  bar: 'BR',
  pie: 'PI',
  area: 'AR',
  radar: 'RA',
  gauge: 'GG',
  code: '</>',
  markdown: 'MD',
  keyboard: 'KB',
  cube: '3D',
  smart: 'AI',
  clock: 'TM',
};

function fallbackIcon(token: string): string {
  if (!token) return 'UI';
  if (token.includes('chart')) return 'CH';
  if (token.includes('smart')) return 'AI';
  if (token.includes('grid')) return 'GD';
  if (token.includes('list')) return 'LS';
  if (token.includes('form')) return 'FM';
  if (token.includes('table')) return 'TB';
  if (token.includes('image')) return 'IM';
  return token.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'UI';
}

export function getIconGlyph(token?: string): string {
  const key = (token || '').trim().toLowerCase();
  if (!key) return 'UI';
  return ICON_MAP[key] || fallbackIcon(key);
}