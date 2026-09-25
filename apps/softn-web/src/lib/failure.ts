/**
 * What the error card says: what went wrong, in words, and what to do next.
 *
 * The card used to say "Unable to complete this action" over whatever the
 * thrower wrote — "Invalid ZIP: missing end-of-central-directory" for a
 * damaged download — which named the failure in the parser's terms and left
 * the person to work out whether the file, the network or the runtime was at
 * fault. The thrower's own words are kept as the detail, because for an
 * author they are the useful part ("logic/main.py imports torch, which an app
 * asks for in manifest.json …"); the title and the hint are worked out here.
 */

export interface FailureView {
  /** One line: what happened, in the person's terms. */
  title: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** The underlying reason, as the thrower wrote it. */
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
    test: /imports \S+, which an app asks for in manifest\.json/,
    title: 'This app uses a Python package it doesn’t declare',
    hint: 'Its author needs to list the package under config.python.packages in manifest.json and export the app again.',
    anotherFile: true,
  },
  {
    test: /is not a bundle — the server returned a web page/,
    title: 'That address isn’t a .softn file',
    hint: 'The server sent back a web page instead of an app. Check the link, or open the app from its page in the directory.',
  },
  {
    test: /larger than the \d+ MB limit|too large to open/,
    title: 'This app is too large to open here',
    anotherFile: true,
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
    test: /^Nothing was imported|could not be brought forward|^Nothing was changed/,
    title: 'Nothing was changed',
  },
  {
    test: /bundle is no longer available/,
    title: 'The bundle couldn’t be downloaded',
  },
];

export function describeFailure(error: Error): FailureView {
  const message = error.message || String(error);
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
