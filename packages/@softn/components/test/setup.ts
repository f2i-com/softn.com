/**
 * jsdom gaps.
 *
 * These are APIs every real browser has and jsdom does not. The components
 * themselves are correct — each call sits inside an effect, so it never runs
 * during server rendering — but jsdom runs effects, so the stubs are needed to
 * get past mount.
 */

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
