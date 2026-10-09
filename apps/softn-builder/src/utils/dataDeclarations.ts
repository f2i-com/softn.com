/**
 * A page's `<data>` block, kept in step with the collections designed in
 * Data.
 *
 * A page reads a collection only if its `<data>` block declares it. A page
 * the canvas made is written with that block from the schema each time, so
 * it follows the schema; a page that came with its own source keeps its
 * source, and nothing told it when the schema changed. Open an app, rename
 * `tasks` to `todos` in Data and add `projects`: the export carried
 * `todos.xdb` and `projects.xdb`, and a page that still declared `tasks`, so
 * the running app saw an empty `tasks` and neither of the others.
 *
 * What is done here is the one change that was made, to the text of the
 * block: a declaration is added, renamed or taken out, and everything else
 * in the file (the other declarations, their filters, the spacing) is left
 * as it was written.
 */

import { parse } from '@softn/core';
import { frameSource } from './sourceFrame';

export type CollectionChange =
  | { kind: 'add'; name: string; alias: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'alias'; name: string; from: string; to: string }
  | { kind: 'remove'; name: string };

const DATA_BLOCK = /<data\b[^>]*>([\s\S]*?)<\/data>/i;
const DECLARATION = /<collection\b[^>]*?(?:\/>|>\s*<\/collection>)/gi;
/** Stands where a declaration was, until its line is taken out with it. */
const REMOVED = '<removed-collection />';
const REMOVED_LINE = new RegExp(`\\n[ \\t]*${REMOVED}[ \\t]*(?=\\n)`, 'g');

function attribute(tag: string, name: string): { value: string; replaced: (next: string) => string } | null {
  const match = new RegExp(`(\\b${name}\\s*=\\s*)(["'])(.*?)\\2`).exec(tag);
  if (!match) return null;
  return {
    value: match[3],
    replaced: (next) => `${tag.slice(0, match.index)}${match[1]}${match[2]}${next}${match[2]}${tag.slice(match.index + match[0].length)}`,
  };
}

/**
 * `source` after `change`, or `source` itself when the change does not touch
 * it. An added collection is declared only where `declareNew` says so: the
 * entry page, which is where an app's collections are listed.
 */
export function changeDataDeclarations(source: string, change: CollectionChange, declareNew = false): string {
  const block = DATA_BLOCK.exec(source);

  if (change.kind === 'add') {
    if (!declareNew) return source;
    const line = `<collection name="${change.name}" as="${change.alias}" />`;
    if (block) {
      const declared = (block[1].match(DECLARATION) ?? []).some((tag) => attribute(tag, 'name')?.value === change.name);
      if (declared) return source;
      const close = block.index + block[0].lastIndexOf('</data>');
      const before = source.slice(0, close).replace(/[ \t]*$/, '');
      const indent = /\n([ \t]*)<collection\b/.exec(block[1])?.[1] ?? '  ';
      return `${before}${before.endsWith('\n') ? '' : '\n'}${indent}${line}\n${source.slice(close)}`;
    }
    // No block yet: one goes before the template.
    let at = 0;
    try {
      at = frameSource(source, parse(source))?.bodyStart ?? 0;
    } catch {
      at = 0;
    }
    return `${source.slice(0, at)}<data>\n  ${line}\n</data>\n\n${source.slice(at)}`;
  }

  if (!block) return source;
  const inner = block[1].replace(DECLARATION, (tag) => {
    const name = attribute(tag, 'name');
    if (!name) return tag;
    if (change.kind === 'rename') return name.value === change.from ? name.replaced(change.to) : tag;
    if (change.kind === 'remove') return name.value === change.name ? REMOVED : tag;
    // The alias of the collection, where the page had not chosen one of its own.
    const alias = attribute(tag, 'as');
    return name.value === change.name && alias?.value === change.from ? alias.replaced(change.to) : tag;
  });
  // A declaration that was taken out takes its own line with it.
  const cleaned = inner.replace(REMOVED_LINE, '').split(REMOVED).join('');
  if (cleaned === block[1]) return source;
  const start = block.index + block[0].indexOf(block[1]);
  return `${source.slice(0, start)}${cleaned}${source.slice(start + block[1].length)}`;
}
