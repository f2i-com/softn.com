import { openBundleArchive } from '@softn/bundle-format/zip';
import { parse } from '../../packages/@softn/core/src/parser/parser';
import { collectAllComponentTags } from '../../packages/@softn/core/src/renderer/document-tags';
import { hasPageHandlers } from '../../packages/@softn/core/src/document-shell/names';

// Only the updating worker of an older classic installation imports this script.
// The old installer recorded tags for its main document, before it considered linked pages.
export function scan(bytes: Uint8Array, tags: Record<string, string>): string[] {
  const archive = openBundleArchive(bytes);
  const decoder = new TextDecoder();
  const names = new Map(Object.entries(tags).map(([tag, group]) => [tag.toLowerCase(), group]));
  const groups = new Set<string>();
  try {
    for (const path of archive.names()) {
      if (!/\.(ui|html?)$/i.test(path)) continue;
      const source = decoder.decode(archive.read(path));
      archive.forget(path);
      try {
        const page = parse(source);
        for (const tag of collectAllComponentTags(page)) {
          const group = names.get(tag.toLowerCase());
          if (group) groups.add(group);
        }
        if (page.script || page.logic || hasPageHandlers(page.template)) groups.add('script');
      } catch {
        // A fragment may only parse in its parent. The original install's saved names
        // cover the composed page; a fragment alone cannot establish another group.
      }
    }
  } finally {
    archive.release();
  }
  return [...groups];
}
