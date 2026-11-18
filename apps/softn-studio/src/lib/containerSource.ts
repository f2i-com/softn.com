import type { VFSFile } from '../types/studio';
import { isPrivatePath } from './paths';

/** Only these project files reach the web app's sandbox or component compiler. */
export function containerSource(files: ReadonlyMap<string, VFSFile>): Record<string, string | Uint8Array> {
  return Object.fromEntries([...files].filter(([path]) => !isPrivatePath(path)).map(([path, file]) => [path, file.content]));
}
