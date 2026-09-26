/**
 * What Builder and Studio share and neither owns.
 *
 * The two editors grew the same plumbing twice — handing a bundle to the
 * runtime or the publish page, opening a bundle from a same-origin link,
 * giving a modal keyboard ownership, and the private channel FormLogic
 * drives an embedded editor through — and the copies drifted: one had the
 * redirect check, the other the "don't replace unsaved work" question. The
 * merged versions live here; each editor keeps a thin module with its own
 * signature so its call sites and tests are untouched.
 *
 * Nothing here depends on the engine: the bundle contract comes from
 * @softn/bundle-format and the only runtime dependency is React (for the
 * focus hook).
 */
export * from './handoff';
export * from './remoteOpen';
export * from './useModalFocus';
export * from './hostedEditor';
export * from './useHostedSaveLabel';
