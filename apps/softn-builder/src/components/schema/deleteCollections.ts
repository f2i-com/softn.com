/**
 * The one question asked before collections are deleted, from the
 * collection editor's "Delete collection" button and from Delete or
 * Backspace on the diagram alike: a collection takes its records with it,
 * and the Data view has no undo to bring them back.
 *
 * Delete on a focused card used to remove the collection and every record
 * it held at once, while the button beside it asked first.
 */

import { askConfirm } from '../../utils/confirm';

/** Ask whether the collections named are to go, records and all. One question however many there are. */
export function askDeleteCollections(names: string[]): Promise<boolean> {
  const quoted = names.map((name) => `"${name}"`);
  const message =
    names.length === 1
      ? `Delete the collection ${quoted[0]} and its records?`
      : `Delete the ${names.length} collections ${quoted.join(', ')} and their records?`;
  return askConfirm(message, {
    title: names.length === 1 ? 'Delete collection' : 'Delete collections',
    confirmLabel: 'Delete',
    danger: true,
  });
}

/**
 * What the diagram may delete of what Delete or Backspace picked. Nothing
 * while the key is not the diagram's (`ours` false: a dialog is open, or the
 * focus is elsewhere). Relationships alone go at once: they are links on the
 * diagram, and the fields and records they joined stay. Collections are asked
 * about first, all in one question, and nothing goes when the answer is no.
 */
export async function allowSchemaDelete(
  picked: { nodes: { id: string }[]; edges: { id: string }[] },
  ours: boolean,
  nameOf: (id: string) => string
): Promise<boolean> {
  if (!ours) return false;
  if (picked.nodes.length === 0) return true;
  return askDeleteCollections(picked.nodes.map((node) => nameOf(node.id)));
}
