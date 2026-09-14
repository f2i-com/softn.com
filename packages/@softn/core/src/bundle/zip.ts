/**
 * The archive reader lives in @softn/bundle-format; this path stays because
 * it is a public entry of this package (`@softn/core/bundle`, built on its own
 * for a host's inflate worker) and because everything inside core imports it
 * from here.
 */
// Relative on purpose: tsup inlines a relative source file into both the
// JavaScript and the typings of the published package, where a bare
// specifier for a private workspace package would be left for consumers to
// resolve and could not be.
export * from '../../../bundle-format/src/zip';
