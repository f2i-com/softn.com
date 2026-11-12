/**
 * What a line typed under "Revise the plan" asks of the plan's pages.
 *
 * The review read one shape, "add a … page", and filed everything else as a
 * note for the AI. So "Remove the watering page" was kept as a note while the
 * plan went on listing the page, and "Add a page for plants and a page for
 * watering" became one page named "Plants And A Page For Watering". A line
 * that adds pages names every page it adds; a line that removes pages names
 * pages the plan has; anything else is a note, as before.
 */

export type PlanRequest =
  /** Pages to add, by name, and the ones asked for that the plan already has. */
  | { kind: 'add'; names: string[]; already: string[] }
  /** Pages to remove, by the names the plan gives them. */
  | { kind: 'remove'; names: string[] }
  | { kind: 'note' };

/** Words that say "a page" rather than name one: "add another page", "add a new page". */
const UNNAMED = /^(?:a|an|another|one|one more|more|new|extra|second|third|other|some|a few|few|several)$/i;

const ARTICLE = '(?:a|an|another|one more|a new|new)';
const PAGE = '(?:page|screen|view)';
const PAGES = '(?:pages|screens|views)';
const NAMED = '(?:called|named|for|titled)';

/** "Add two pages": how many. Past six it is a note: nobody plans by the dozen in one line. */
const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };

/** A page's name as the plan writes it, or null when the words name none. */
function titled(raw: string): string | null {
  const name = raw.replace(/^["'“‘]|["'”’]$/g, '').replace(/[^\p{L}\p{N}\s&'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  if (!name || UNNAMED.test(name)) return null;
  return name.split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** "X, Y and Z" as its parts. */
function listed(text: string): string[] {
  return text.split(/\s*,\s*(?:and\s+)?|\s+(?:and|&|plus)\s+/i).map((part) => part.trim()).filter(Boolean);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One page a line asks to add: its name, null for a page it does not name
 * ("another page"), or undefined when the words do not ask for a page.
 */
function onePage(item: string): string | null | undefined {
  // "a page called X", "a screen named X", "a page for X"
  const called = new RegExp(`^(?:${ARTICLE}\\s+)?${PAGE}\\s+(${NAMED})\\s+(.+)$`, 'i').exec(item);
  // "a page for the archive" is the Archive page; "a page called The Team" keeps its name.
  if (called) return titled(/^for$/i.test(called[1]) ? called[2].replace(/^(?:the|a|an)\s+/i, '') : called[2]);
  // "a settings page", "another page", "an about screen"
  const before = new RegExp(`^(?:${ARTICLE}\\s+)?(.*?)\\s*${PAGE}$`, 'i').exec(item);
  if (before) return titled(before[1]);
  return undefined;
}

/** The pages a line asks to add (null for each it does not name), or null when it asks for none. */
function pagesToAdd(text: string): Array<string | null> | null {
  const lead = /^(?:please\s+)?(?:add|include|create|make)\s+(.+)$/i.exec(text);
  if (!lead) return null;
  const rest = lead[1].trim();

  // "pages for plants, watering and notes", "two pages called A and B"
  const namedAfter = new RegExp(`^(?:\\S+\\s+)?${PAGES}\\s+${NAMED}\\s+(.+)$`, 'i').exec(rest);
  if (namedAfter) {
    const names = listed(namedAfter[1]).map((part) => titled(part.replace(/^(?:the|a|an)\s+/i, '')));
    return names.some((name) => name === null) ? null : names;
  }
  // "settings and about pages", "two pages", "2 more pages"
  const pluralBefore = new RegExp(`^(.*?)\\s*${PAGES}$`, 'i').exec(rest);
  if (pluralBefore) {
    const what = pluralBefore[1].trim();
    const count = COUNTS[what.replace(/\s+(?:more|new|extra|other)$/i, '').toLowerCase()];
    if (count) return Array.from({ length: count }, () => null);
    const names = listed(what).map((part) => titled(part.replace(/^(?:the|a|an)\s+/i, '')));
    return names.length === 0 || names.some((name) => name === null) ? null : names;
  }
  // "a settings page, a profile page and a help page": a joiner followed by an article starts
  // the next page. "a terms and conditions page" has no article after its "and", and is one page.
  const items = rest.split(new RegExp(`\\s*(?:,\\s*(?:and\\s+)?|\\s(?:and|&|plus)\\s+)(?=${ARTICLE}\\s)`, 'i')).map((item) => item.trim()).filter(Boolean);
  if (items.length > 1) {
    const pages = items.map(onePage);
    if (pages.every((page) => page !== undefined)) return pages as Array<string | null>;
  }
  // One page, read whole, as it always was.
  const one = onePage(rest);
  return one === undefined ? null : [one];
}

const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The plan's page a line means by `wanted`: the page of that name, or, when the line said
 * "page", the one page whose name holds those words ("the watering page" of a plan with
 * Watering Schedule). Null when no page, or more than one, fits.
 */
function planPage(wanted: string, existing: readonly string[], loose: boolean): string | null {
  const want = plain(wanted);
  if (!want) return null;
  const exact = existing.find((name) => plain(name) === want);
  if (exact) return exact;
  if (!loose) return null;
  const holding = existing.filter((name) => ` ${plain(name)} `.includes(` ${want} `));
  return holding.length === 1 ? holding[0] : null;
}

/**
 * The plan's pages a line asks to remove, or null when it does not ask that, or names
 * something the plan has no page for (which is then a note: "remove the delete button from
 * the home page" is about a button).
 */
function pagesToRemove(text: string, existing: readonly string[]): string[] | null {
  const lead = /^(?:please\s+)?(?:(?:remove|delete|drop|lose|cut|take\s+out|take\s+away|get\s+rid\s+of)|(?:i\s+)?(?:do\s*n['’]?t|do\s+not)\s+(?:need|want)|no|without)\s+(.+)$/i.exec(text);
  if (!lead) return null;
  const rest = lead[1].trim().replace(/^(?:the|a|an|that|my)\s+/i, '');
  // "the page called X", "the pages for X and Y"
  const after = new RegExp(`^(?:${PAGE}|${PAGES})\\s+(?:${NAMED}\\s+)?(.+)$`, 'i').exec(rest);
  // "the X page", "the X and Y pages"
  const before = new RegExp(`^(.+?)\\s*(?:${PAGE}|${PAGES})$`, 'i').exec(rest);
  const saidPage = Boolean(after || before);
  const names = listed(after ? after[1] : before ? before[1] : rest)
    .map((part) => part.replace(/^(?:the|a|an)\s+/i, '').replace(new RegExp(`\\s*(?:${PAGE}|${PAGES})$`, 'i'), '').trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const found: string[] = [];
  for (const name of names) {
    const page = planPage(name, existing, saidPage);
    if (page === null) return null;
    if (!found.includes(page)) found.push(page);
  }
  return found;
}

/** What `note` asks of a plan whose pages are `existing`. */
export function planRequest(note: string, existing: readonly string[]): PlanRequest {
  const text = note.trim().replace(/[.!]+$/, '').trim();
  if (!text) return { kind: 'note' };

  const removed = pagesToRemove(text, existing);
  if (removed) return { kind: 'remove', names: removed };

  const added = pagesToAdd(text);
  if (!added) return { kind: 'note' };
  const names: string[] = [];
  const already: string[] = [];
  const taken = (name: string) => existing.some((other) => same(other, name)) || names.some((other) => same(other, name));
  let number = existing.length;
  for (const asked of added) {
    if (asked === null) {
      // A page the line does not name is the next numbered one the plan does not have.
      let name = `Page ${++number}`;
      while (taken(name)) name = `Page ${++number}`;
      names.push(name);
    } else if (taken(asked)) {
      if (!already.some((other) => same(other, asked))) already.push(asked);
    } else {
      names.push(asked);
      number += 1;
    }
  }
  return { kind: 'add', names, already };
}
