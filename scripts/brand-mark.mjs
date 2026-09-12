/** Canonical mark geometry for website, PWA and native application icons. */
export const GRID = 32;
export const CORAL = '#FF8A4C';
export const MINT = '#35E0C0';
export const CORNER = 7;
export const STROKE = 2.4;
export const DOT_R = 2.8;
export const BRACKETS = [
  [[9, 11.5], [5.5, 16], [9, 20.5]],
  [[23, 11.5], [26.5, 16], [23, 20.5]],
];

export function markSvg(ground = '#101317', { foreground = false, monochrome = false } = {}) {
  if (!/^#[0-9a-fA-F]{6}$/.test(ground)) throw new Error(`Icon ground must be #rrggbb, got ${ground}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}">
${foreground ? '' : `  <rect width="${GRID}" height="${GRID}" rx="${CORNER}" fill="${ground}"/>\n`}${BRACKETS.map(
    ([a, b, c]) =>
      `  <path d="M${a[0]} ${a[1]} ${b[0]} ${b[1]} ${c[0]} ${c[1]}" fill="none" stroke="${monochrome ? '#FFFFFF' : CORAL}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join('\n')}
  <circle cx="${GRID / 2}" cy="${GRID / 2}" r="${DOT_R}" fill="${monochrome ? '#FFFFFF' : MINT}"/>
</svg>
`;
}
