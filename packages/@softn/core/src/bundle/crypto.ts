/**
 * Lives in @softn/bundle-format: the digest and the random id, kept working
 * where a browser withholds Web Crypto (a page outside a secure context).
 * Not part of core's public surface; core's own modules import it from here.
 */
// Relative on purpose: tsup inlines a relative source file into both the
// JavaScript and the typings of the published package, where a bare
// specifier for a private workspace package would be left for consumers to
// resolve and could not be.
export { randomUUID, sha256Hex } from '../../../bundle-format/src/crypto';
