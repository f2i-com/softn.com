/**
 * Which component names a document renders before anything has happened.
 *
 * The renderer preloads these the moment a parse succeeds, so a feature the
 * first screen needs — a scene, a chart — is fetched while the VM is still
 * initialising rather than discovered on first render. The walk stays out
 * of every conditional branch on purpose: `{#if page === 'game'}` is how a
 * document expresses a later route, and a Scene3D behind it is exactly the
 * download a minimal first screen must not pay for. Whatever appears later
 * is resolved at runtime by the registry's wrapper on its first render.
 */

import type { IfBlock, SoftNDocument, TemplateNode } from '../parser/ast';

/**
 * Element tag names reachable from the template root without entering a
 * conditional branch. Element children count, and so do the bodies of
 * `#each` blocks and their `#empty` fallbacks — a list either has records or
 * does not, and the first screen shows one of the two; neither is a route.
 * An element with an inline `if={…}` is a conditional branch of its own and
 * is skipped with everything under it. HTML tags come back too; the caller
 * ignores names it has no loader for.
 */
export function collectFirstScreenTags(doc: SoftNDocument): Set<string> {
  const tags = new Set<string>();
  const visit = (nodes: TemplateNode[] | undefined): void => {
    if (!nodes) return;
    for (const node of nodes) {
      switch (node.type) {
        case 'Element':
          if (node.conditionalIf) break;
          tags.add(node.tag);
          visit(node.children);
          break;
        case 'EachBlock':
          visit(node.body);
          visit(node.emptyFallback);
          break;
        case 'Slot':
          visit(node.fallback);
          break;
        case 'TemplateSlot':
          visit(node.children);
          break;
        case 'IfBlock':
        case 'Text':
        case 'Expression':
          break;
      }
    }
  };
  visit(doc.template);
  return tags;
}

/**
 * Every element tag name anywhere in the template, conditional branches
 * included: each arm of an `#if`/`#elseif`/`#else` chain, an element with an
 * inline `if={…}` and everything under it, `#each` bodies and fallbacks,
 * slot fallbacks and template-slot children.
 *
 * This is the other question a host asks of a document. The first-screen
 * walk above answers "what must be fetched now", and stays out of every
 * branch because a branch is a later route. An offline install answers
 * "what could ever be needed", and a route the user has not visited yet is
 * exactly what has to be there when the network is not — an app that opens
 * offline and then fails on its game page was not installed, whatever the
 * first screen said. HTML tags come back too; the caller keeps the names it
 * has a loader for.
 */
export function collectAllComponentTags(doc: SoftNDocument): Set<string> {
  const tags = new Set<string>();
  const visit = (nodes: TemplateNode[] | undefined): void => {
    if (!nodes) return;
    for (const node of nodes) {
      switch (node.type) {
        case 'Element':
          tags.add(node.tag);
          visit(node.children);
          break;
        case 'IfBlock':
          visitIf(node);
          break;
        case 'EachBlock':
          visit(node.body);
          visit(node.emptyFallback);
          break;
        case 'Slot':
          visit(node.fallback);
          break;
        case 'TemplateSlot':
          visit(node.children);
          break;
        case 'Text':
        case 'Expression':
          break;
      }
    }
  };
  // `alternate` is either the `#else` body or the next `#elseif` block, so a
  // chain is walked link by link rather than recursed into as a list.
  const visitIf = (block: IfBlock): void => {
    visit(block.consequent);
    if (!block.alternate) return;
    if (Array.isArray(block.alternate)) visit(block.alternate);
    else visitIf(block.alternate);
  };
  visit(doc.template);
  return tags;
}
