import { MAX_ZIP_INPUT_BYTES } from '@softn/core/web-host';

/** Check before allocating: ZIP validation cannot protect the initial file read. */
export async function readLocalBundle(file: File): Promise<Uint8Array> {
  if (!/\.(?:softn|zip)$/i.test(file.name)) {
    throw new Error('Choose a .softn or .zip app file to open it in the runtime.');
  }
  if (file.size > MAX_ZIP_INPUT_BYTES) {
    throw new Error(`This app is too large to open. Choose an archive of ${MAX_ZIP_INPUT_BYTES / 1024 / 1024} MB or less.`);
  }
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`“${file.name}” could not be read. Try selecting the file again or copying it to a local folder first.`);
  }
}
