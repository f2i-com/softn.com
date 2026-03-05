/**
 * App Component
 *
 * Root wrapper for SoftN applications.
 * Provides app-level theming and context with CSS variables.
 */

import React from 'react';

export interface AppProps {
  /** App content */
  children?: React.ReactNode;
  /** Theme name to apply */
  theme?: 'light' | 'dark' | string;
  /** Additional CSS class */
  className?: string;
  /** Inline styles */
  style?: React.CSSProperties;
}

// CSS variables for themes
const darkThemeVars = `
  --color-bg: #0c0c0e;
  --color-text: #ececf0;
  --color-text-muted: #8b8b96;
  --color-text-faint: #5a5a66;
  --color-surface: #16161a;
  --color-surface-hover: #1e1e23;
  --color-surface-raised: #1e1e23;
  --color-border: rgba(255, 255, 255, 0.08);
  --color-border-hover: rgba(255, 255, 255, 0.14);
  --color-border-subtle: rgba(255, 255, 255, 0.04);
  --color-overlay: rgba(0, 0, 0, 0.6);
  --color-primary: #6366f1;
  --color-primary-50: rgba(99, 102, 241, 0.08);
  --color-primary-100: rgba(99, 102, 241, 0.14);
  --color-primary-500: #6366f1;
  --color-primary-600: #4f46e5;
  --color-primary-700: #4338ca;
  --color-primary-text: white;
  --color-success-500: #22c55e;
  --color-success-600: #16a34a;
  --color-error-500: #ef4444;
  --color-error-600: #dc2626;
  --color-warning-500: #f59e0b;
  --color-gray-50: #1e1e23;
  --color-gray-100: #28282f;
  --color-gray-200: #3a3a44;
  --color-gray-300: #5a5a66;
  --color-gray-400: #8b8b96;
  --color-gray-500: #8b8b96;
  --color-gray-600: #c5c5cd;
  --color-gray-700: #dcdce3;
  --color-gray-800: #ececf0;
  --color-gray-900: #f7f7f8;
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.25);
  --shadow-lg: 0 8px 30px rgba(0, 0, 0, 0.35);
  --shadow-xl: 0 20px 60px rgba(0, 0, 0, 0.5);
  --duration-fast: 120ms;
  --duration-normal: 200ms;
  --duration-slow: 320ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.16, 1, 0.3, 1);
  --btn-secondary-bg: linear-gradient(to bottom, #28282f, #1e1e23);
  --btn-secondary-bg-hover: linear-gradient(to bottom, #3a3a44, #28282f);
  --btn-secondary-bg-active: #28282f;
  --btn-secondary-text: #ececf0;
  --btn-secondary-border: #3a3a44;
  --btn-secondary-border-hover: #5a5a66;
  --btn-ghost-text: #c5c5cd;
  --btn-ghost-bg-hover: rgba(255, 255, 255, 0.06);
  --btn-ghost-bg-active: rgba(255, 255, 255, 0.1);
  --nav-item-hover-bg: rgba(255, 255, 255, 0.06);
  --nav-item-hover-text: rgba(255, 255, 255, 0.9);
  --nav-tooltip-bg: #1e1e23;
  --nav-tooltip-text: white;
  --nav-tooltip-border: rgba(255, 255, 255, 0.1);
`;

const lightThemeVars = `
  --color-bg: #f8f8fa;
  --color-text: #1a1a2e;
  --color-text-muted: #6b6b80;
  --color-text-faint: #9b9bac;
  --color-surface: #ffffff;
  --color-surface-hover: #f3f3f6;
  --color-surface-raised: #ffffff;
  --color-border: rgba(0, 0, 0, 0.08);
  --color-border-hover: rgba(0, 0, 0, 0.14);
  --color-border-subtle: rgba(0, 0, 0, 0.04);
  --color-overlay: rgba(0, 0, 0, 0.4);
  --color-primary: #6366f1;
  --color-primary-50: rgba(99, 102, 241, 0.06);
  --color-primary-100: rgba(99, 102, 241, 0.12);
  --color-primary-500: #6366f1;
  --color-primary-600: #4f46e5;
  --color-primary-700: #4338ca;
  --color-primary-text: white;
  --color-success-500: #22c55e;
  --color-success-600: #16a34a;
  --color-error-500: #ef4444;
  --color-error-600: #dc2626;
  --color-warning-500: #f59e0b;
  --color-gray-50: #f3f3f6;
  --color-gray-100: #e8e8ee;
  --color-gray-200: #d4d4dd;
  --color-gray-300: #b5b5c3;
  --color-gray-400: #9b9bac;
  --color-gray-500: #6b6b80;
  --color-gray-600: #4a4a5e;
  --color-gray-700: #33334a;
  --color-gray-800: #1f1f36;
  --color-gray-900: #1a1a2e;
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 8px 30px rgba(0, 0, 0, 0.1);
  --shadow-xl: 0 20px 60px rgba(0, 0, 0, 0.15);
  --duration-fast: 120ms;
  --duration-normal: 200ms;
  --duration-slow: 320ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out: cubic-bezier(0.16, 1, 0.3, 1);
  --btn-secondary-bg: linear-gradient(to bottom, #ffffff, #f3f3f6);
  --btn-secondary-bg-hover: linear-gradient(to bottom, #f3f3f6, #e8e8ee);
  --btn-secondary-bg-active: #e8e8ee;
  --btn-secondary-text: #1a1a2e;
  --btn-secondary-border: #d4d4dd;
  --btn-secondary-border-hover: #b5b5c3;
  --btn-ghost-text: #4a4a5e;
  --btn-ghost-bg-hover: rgba(0, 0, 0, 0.04);
  --btn-ghost-bg-active: rgba(0, 0, 0, 0.08);
  --nav-item-hover-bg: rgba(0, 0, 0, 0.04);
  --nav-item-hover-text: #1a1a2e;
  --nav-tooltip-bg: #ffffff;
  --nav-tooltip-text: #1a1a2e;
  --nav-tooltip-border: rgba(0, 0, 0, 0.08);
`;

const globalStyles = `
  .softn-app *, .softn-app *::before, .softn-app *::after {
    box-sizing: border-box;
  }
  .softn-app {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  .softn-app ::-webkit-scrollbar { width: 6px; height: 6px; }
  .softn-app ::-webkit-scrollbar-track { background: transparent; }
  .softn-app ::-webkit-scrollbar-thumb {
    background: var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: 3px;
  }
  .softn-app ::-webkit-scrollbar-thumb:hover {
    background: var(--color-border-hover, rgba(255, 255, 255, 0.14));
  }
  .softn-app ::selection {
    background: var(--color-primary-100, rgba(99, 102, 241, 0.14));
    color: inherit;
  }
  .softn-app *:focus-visible {
    outline: 2px solid var(--color-primary-500, #6366f1);
    outline-offset: 2px;
  }
  .softn-app input:focus-visible,
  .softn-app textarea:focus-visible,
  .softn-app select:focus-visible {
    outline: none;
    border-color: var(--color-primary-500, #6366f1) !important;
    box-shadow: 0 0 0 3px var(--color-primary-50, rgba(99, 102, 241, 0.08)) !important;
  }
`;

export function App({ children, theme = 'light', className, style }: AppProps): React.ReactElement {
  const themeVars = theme === 'light' ? lightThemeVars : darkThemeVars;

  const containerStyle: React.CSSProperties = {
    height: 'calc(100vh - var(--softn-tab-bar-height, 0px))',
    width: '100%',
    overflow: 'hidden',
    background: 'var(--color-bg)',
    color: 'var(--color-text)',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    lineHeight: 1.5,
    letterSpacing: '-0.011em',
    ...style,
  };

  return (
    <>
      <style>{`.softn-theme-${theme} { ${themeVars} } ${globalStyles}`}</style>
      <div className={`softn-app softn-theme-${theme} ${className || ''}`} style={containerStyle}>
        {children}
      </div>
    </>
  );
}

export default App;
