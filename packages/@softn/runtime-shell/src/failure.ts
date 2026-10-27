/**
 * What a host says when an app will not open: what went wrong, in words, and
 * what to do next.
 *
 * The web runtime's error card used to say "Unable to complete this action"
 * over whatever the thrower wrote — "Invalid ZIP: missing
 * end-of-central-directory" for a damaged download — which named the failure
 * in the parser's terms and left the person to work out whether the file, the
 * network or the runtime was at fault. The thrower's own words are kept as
 * the detail, because for an author they are the useful part ("logic/main.py
 * imports torch, which an app asks for in manifest.json …"); the title and
 * the hint are worked out here. The single-app shell keeps its own plain
 * sentence and shows the same detail behind its toggle; the two used to read
 * the message each their own way.
 */

export interface FailureView {
  /** One line: what happened, in the person's terms. */
  title: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** The underlying reason, as the thrower wrote it; empty when it gave none. */
  detail: string;
  /** The failure was the file itself, so choosing another file is an answer. */
  offerAnotherFile: boolean;
}

interface Rule {
  test: RegExp;
  title: string;
  hint?: string;
  anotherFile?: boolean;
  /** Replace the detail with the part of the message after the match's first group. */
  detailFrom?: number;
}

const RULES: Rule[] = [
  {
    // First: an import or a data copy that changed nothing says why in words
    // of its own, which can match a rule below. "Nothing was imported … the
    // file is corrupt." was taken for a damaged .softn file, told to download
    // it again and offered the .softn picker, and so was any import into an
    // app whose name holds "corrupt".
    test: /^Nothing was imported|could not be brought forward|^Nothing was changed/,
    title: 'Nothing was changed',
  },
  {
    test: /^Invalid manifest\.json:\s*(.*)$/s,
    title: 'This app’s manifest is broken',
    hint: 'The file opened, but its manifest.json can’t be used. If you made this app, fix it in Studio or Builder and export it again; otherwise ask whoever shared it for a new copy.',
    anotherFile: true,
    detailFrom: 1,
  },
  {
    test: /Invalid ZIP|end-of-central-directory|not a zip|corrupt/i,
    title: 'This isn’t a readable .softn file',
    hint: 'It may be damaged or only partly downloaded. Download or export it again, then open the new copy.',
    anotherFile: true,
  },
  {
    // A sound archive of a kind the reader refuses: nothing is damaged, and
    // downloading it again gives the same file.
    test: /^(?:Encrypted|ZIP64) bundles are not supported/,
    title: 'This kind of archive can’t be opened',
    hint: 'A .softn file is a plain ZIP: not password-protected, and not in the ZIP64 format very large archives use. Export the app again from Studio or Builder, or ask whoever shared it for a new copy.',
    anotherFile: true,
  },
  {
    test: /imports \S+, which an app asks for in manifest\.json/,
    title: 'This app uses a Python package it doesn’t declare',
    hint: 'Its author needs to list the package under config.python.packages in manifest.json and export the app again.',
    anotherFile: true,
  },
  {
    // A host with a single-page fallback (a dev server, most static hosts)
    // answers an address it has nothing at with its own page and a 200: the
    // not-found case as such a host reports it.
    test: /is not a bundle — the server returned a web page/,
    title: 'This app wasn’t found',
    hint: 'The server sent back a web page instead of an app, so nothing is published at that address. Check the link, or look for the app in the directory. Apps you have opened before are under Your apps on the home screen.',
  },
  {
    test: /only \.softn bundles can be opened by URL/,
    title: 'That address isn’t a .softn file',
    hint: 'Only a .softn app opens from a link. Check the link, or open the app from its page in the directory.',
  },
  {
    // The URL rule refusing, before anything was fetched, or a download that
    // landed somewhere else: not a fault of the connection or of a file.
    test: /only bundles served from this site can be opened by URL|redirected to \S+, which is not this site/,
    title: 'Only apps from this site open from a link',
    hint: 'A link can open an app this site serves, and nothing else. To run an app from somewhere else, download its .softn file and open it here.',
  },
  {
    test: /^Refusing to open|^Cannot open ".*": it is not a valid path/,
    title: 'That link can’t open an app',
    hint: 'Check the link, or open the app from its page in the directory.',
  },
  {
    test: /larger than the \d+ MB limit|too large to open/,
    title: 'This app is too large to open here',
    anotherFile: true,
  },
  {
    // Nothing is published at the address: a deep link to an app that does
    // not exist, or a link with a typo. Saying "check your connection" sent
    // people to their router for a mistyped name.
    test: /^Could not fetch \S+ \(HTTP (?:404|410)\b/,
    title: 'This app wasn’t found',
    hint: 'Nothing is published at that address. Check the link, or look for the app in the directory. Apps you have opened before are under Your apps on the home screen.',
  },
  {
    test: /^Could not fetch|Failed to fetch|NetworkError|Load failed/,
    title: 'The app couldn’t be downloaded',
    hint: 'Check your connection and the address, then try again. Apps you have opened before are under Your apps on the home screen.',
  },
  {
    test: /^Choose a \.softn/,
    title: 'That isn’t a .softn file',
    anotherFile: true,
  },
  {
    test: /could not be read\./,
    title: 'The file couldn’t be read',
    anotherFile: true,
  },
  {
    test: /^Stop “/,
    title: 'Stop the app first',
  },
  {
    test: /bundle is no longer available/,
    title: 'The bundle couldn’t be downloaded',
  },
];

/** The message a failure carries: an Error's, a thrown string, or nothing. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'string') return error;
  return '';
}

export function describeFailure(error: unknown): FailureView {
  const message = messageOf(error);
  for (const rule of RULES) {
    const match = message.match(rule.test);
    if (!match) continue;
    return {
      title: rule.title,
      hint: rule.hint,
      detail: rule.detailFrom !== undefined ? match[rule.detailFrom] || message : message,
      offerAnotherFile: Boolean(rule.anotherFile),
    };
  }
  return { title: 'Something went wrong', detail: message, offerAnotherFile: false };
}
