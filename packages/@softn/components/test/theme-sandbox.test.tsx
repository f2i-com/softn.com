import { mount } from './dom';
import { it, expect } from 'vitest';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
function Child() { const { isDarkMode } = useTheme(); return <p>{isDarkMode ? 'Dark app' : 'Light app'}</p>; }
it('renders the host theme when sandboxed storage access throws', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Sandbox', 'SecurityError'); } });
  try {
    const {container, unmount} = mount(<ThemeProvider defaultDarkMode><Child /></ThemeProvider>);
    expect(container.textContent).toContain('Dark app'); unmount();
  } finally { Object.defineProperty(window, 'localStorage', original); }
});
