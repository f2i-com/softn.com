/** Whether the page runs a development build: there the renderer says what it refused, and why. */
export const isDevelopment = (() => {
  try {
    // `import.meta.env` is Vite's, not the language's. A cast rather than a
    // `@ts-expect-error` because whether the property is declared depends on
    // who is compiling: core's own tsconfig has never heard of it, while a root
    // typecheck that also covers an app referencing `vite/client` has — and a
    // suppression that is unnecessary in one of those is itself an error.
    const meta = import.meta as unknown as { env?: { DEV?: boolean } } | undefined;
    if (meta?.env?.DEV) {
      return true;
    }
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
})();
