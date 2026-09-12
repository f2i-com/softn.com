import { act, useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { mount, type } from './dom';
import { App } from '../src/layout/App';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

it('changes a running app with the host theme while preserving unfinished input', async () => {
  document.documentElement.setAttribute('data-theme', 'light');
  localStorage.setItem('softn-theme-preference', 'dark');
  let starts = 0;
  function RunningApp() {
    const [draft, setDraft] = useState('');
    useEffect(() => { starts += 1; }, []);
    return <App><input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} /></App>;
  }
  const view = mount(<ThemeProvider followHost followSystem><RunningApp /></ThemeProvider>);
  try {
    const input = view.container.querySelector('input')!;
    const app = view.container.querySelector('.softn-app')!;
    expect(app.classList.contains('softn-theme-light')).toBe(true);
    type(input, 'Keep my unfinished task');
    await act(async () => { document.documentElement.setAttribute('data-theme', 'dark'); });
    expect(app.classList.contains('softn-theme-dark')).toBe(true);
    expect((app as HTMLElement).style.colorScheme).toBe('dark');
    expect(view.container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Keep my unfinished task');
    await act(async () => { document.documentElement.setAttribute('data-theme', 'light'); });
    expect(app.classList.contains('softn-theme-light')).toBe(true);
    expect(starts).toBe(1);
  } finally { view.unmount(); }
});

it('lets editor preview controls override a saved preference and change in place', () => {
  localStorage.setItem('softn-theme-preference', 'dark');
  const view = mount(<ThemeProvider darkMode={false}><App theme="system"><input defaultValue="Unsaved" /></App></ThemeProvider>);
  try {
    const input = view.container.querySelector('input');
    expect(view.container.querySelector('.softn-theme-light')).not.toBeNull();
    view.rerender(<ThemeProvider darkMode><App theme="system"><input defaultValue="Unsaved" /></App></ThemeProvider>);
    expect(view.container.querySelector('.softn-theme-dark')).not.toBeNull();
    expect(view.container.querySelector('input')).toBe(input);
  } finally { view.unmount(); }
});

it('preserves a bundle author’s explicit light or dark appearance', () => {
  const view = mount(<ThemeProvider darkMode><App theme="light">Light app</App></ThemeProvider>);
  try {
    expect(view.container.querySelector('.softn-app')?.classList.contains('softn-theme-light')).toBe(true);
    view.rerender(<ThemeProvider darkMode={false}><App theme="dark">Dark app</App></ThemeProvider>);
    expect(view.container.querySelector('.softn-app')?.classList.contains('softn-theme-dark')).toBe(true);
  } finally { view.unmount(); }
});

it('keeps an explicit preference when the operating system changes', () => {
  const media = new EventTarget() as MediaQueryList;
  Object.assign(media, { matches: true });
  vi.spyOn(window, 'matchMedia').mockReturnValue(media);
  localStorage.setItem('softn-theme-preference', 'dark');
  function Status() { return <p>{useTheme().isDarkMode ? 'Dark' : 'Light'}</p>; }
  const view = mount(<ThemeProvider followSystem><Status /></ThemeProvider>);
  try {
    Object.assign(media, { matches: false });
    act(() => { media.dispatchEvent(new Event('change')); });
    expect(view.container.querySelector('p')?.textContent).toBe('Dark');
  } finally { view.unmount(); }
});
