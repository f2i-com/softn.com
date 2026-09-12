import { MAX_ZIP_INPUT_BYTES } from '@softn/core';

/** Check before allocating: ZIP validation cannot protect the initial file read. */
export async function readLocalBundle(file: File): Promise<Uint8Array> {
  if (!/\.softn$/i.test(file.name)) {
    throw new Error('Choose a .softn app file to open it in the runtime.');
  }
  if (file.size > MAX_ZIP_INPUT_BYTES) {
    throw new Error(`This app is too large to open. Choose a .softn file under ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB.`);
  }
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`“${file.name}” could not be read. Try selecting the file again or copying it to a local folder first.`);
  }
}
