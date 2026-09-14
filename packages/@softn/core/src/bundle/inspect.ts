/** Lives in @softn/bundle-format; re-exported here so core's public surface is unchanged. */
// Relative on purpose: tsup inlines a relative source file into both the
// JavaScript and the typings of the published package, where a bare
// specifier for a private workspace package would be left for consumers to
// resolve and could not be.
export * from '../../../bundle-format/src/inspect';
