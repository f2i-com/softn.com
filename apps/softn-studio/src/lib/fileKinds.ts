/**
 * Which of a project's files are bytes and which are text.
 *
 * Two places decide, and they have to agree: the tool that writes a file
 * the model sends as text, and the import that reads a bundle back. They
 * did not. The writer learned to write a .csv, a README and any other text
 * it was sent; the importer still asked core's registry, whose answer for an
 * extension it does not know is "bytes". So a file the AI wrote was exported
 * as it was written and came back, from that same export, as bytes it could
 * no longer read or edit.
 */

import { ASSET_CLASSIFICATIONS } from '@softn/core';

/** Archives and compiled code: bytes too, though core's registry, which lists what a bundle serves, does not name them. */
const ARCHIVE_OR_COMPILED = /\.(zip|gz|tgz|tar|bz2|xz|7z|rar|jar|wasm)$/i;

/**
 * Whether a path's type is one the project keeps as bytes — a picture, a
 * sound, a video, a font, a model, an archive — so a file of it cannot be
 * written from text.
 *
 * Everything else is the text it is written as. This used to ask whether
 * core's registry lists the extension as text, and the registry's answer for
 * an extension it does not know is "bytes": right for a reader, which must not
 * decode what it cannot name, and wrong for a writer, which refused a .csv, a
 * README and a .ts file as "a binary format".
 */
export function keptAsBytes(path: string): boolean {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // An SVG is markup. The registry carries it as bytes for the runtime's icon paths; import
  // decodes it so that it can be read and edited here, and so it can be written here.
  if (extension === 'svg') return false;
  if (ARCHIVE_OR_COMPILED.test(path)) return true;
  return Object.hasOwn(ASSET_CLASSIFICATIONS, extension) && ASSET_CLASSIFICATIONS[extension].binary;
}

/**
 * Whether bytes of a type nothing names are text: valid UTF-8 with no NUL in
 * it. A file written as text is, and reads back as the same text; a binary
 * file of an unknown kind is not, and is kept as the bytes it is rather than
 * decoded into something that no longer encodes back to them.
 */
export function readsAsText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
