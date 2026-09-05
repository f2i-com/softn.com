/**
 * @softn/brand — the one look the four SoftN apps share.
 *
 * Import `@softn/brand/tokens.css` for the colours and type, `@softn/brand/fonts`
 * for the faces, `@softn/brand/bar.css` for the product bar's styles, and the
 * components and theme helpers from here.
 */
export { ProductBar, DEFAULT_URLS } from './ProductBar';
export type { ProductBarProps, ProductUrls, Product } from './ProductBar';
export { Mark } from './Mark';
export { ThemeToggle } from './ThemeToggle';
export {
  THEME_KEY,
  THEME_EVENT,
  PRE_PAINT_SCRIPT,
  readChoice,
  resolve,
  currentTheme,
  apply,
  store,
  setTheme,
  watchSystem,
  subscribeTheme,
} from './theme';
export type { Theme, ThemeChoice } from './theme';
