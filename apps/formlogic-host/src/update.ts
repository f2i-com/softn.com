/**
 * A newer version of an app's files, handed to the frame while the app runs.
 *
 * Until now a frame took one `formlogic:init` and nothing after it: a parent
 * that had a newer version of the app made a new frame, and the app started
 * from nothing with whatever the person had on screen gone. A parent that saw
 * `update: 1` in `formlogic:ready` may instead post
 * `{ type: 'formlogic:update', id, client, assets? }` on the app's port:
 * `client` is the app's text files as `init` carries them, all of them, and
 * `assets` its media, left out where the media has not changed. The frame
 * answers `{ type: 'updated', id, outcome, … }` on the same port, once for
 * every update: what core's live app made of the version (`updated`,
 * `restarted`, `kept`, `unchanged`; docs/engineering/LIVE_APPS.md), or
 * `reopen` where this frame cannot take it and the parent has to make a new
 * one, as it did for every change before.
 *
 * This module is the deciding: what a message has to be, which changes a
 * frame cannot take, one version at a time with the newest winning, what the
 * app's logic and page are answered from afterwards, and what is said back.
 * Core's composer and live app, the frame's media types and its engine's
 * languages are passed in, so it runs alone under `node --test`.
 *
 * An update never touches what the app has stored. Its seed records were
 * added once, before it first drew (seed.ts), and are not added again: a
 * `.xdb` file that an update adds or changes is carried with the files and
 * read by nothing until the app is next opened.
 *
 * An app may be showing another of its page files when a version comes, after
 * a link to it (place.ts). It stays on that page while the version has it:
 * the version is composed with that page as its main one, as it was when the
 * link was followed, and handed over like any other. A version without the
 * page is opened at its main page, and answered `restarted`.
 */

/** What became of an update: core's four answers, and `reopen` for a change only a new frame can take. */
export type UpdateOutcome = 'updated' | 'restarted' | 'kept' | 'unchanged' | 'reopen';

/** What the frame posts on the port for each update. Only the fields that say something are there. */
export interface UpdateReply {
  type: 'updated';
  /** The parent's own id for the update, as it came; null where it sent none the frame could echo. */
  id: number | string | null;
  outcome: UpdateOutcome;
  /**
   * What of the app the version changed: the renderer's parts (`page`, `styles`, `logic`), and the
   * frame's own two, `media` (its media is not what it was) and `theme` (the side its project declares).
   */
  changed?: string[];
  /** restarted: why it started again. reopen: why this frame cannot take the version. */
  reason?: string;
  /** restarted: its variables were carried into the new start. */
  carried?: boolean;
  /** kept: what is wrong with the version, while the last one that worked stays on screen. */
  problem?: string;
}

/** What core's `live.update` answers (its AppUpdateResult), as far as it is read here. */
export interface LiveAnswer {
  outcome: 'updated' | 'restarted' | 'kept' | 'unchanged';
  changed?: readonly string[];
  reason?: string;
  carried?: boolean;
  problem?: string;
}

/**
 * How much one update may carry, and how many may wait.
 *
 * `init` holds the parent to no size: it is the page that made the frame, and
 * a frame that cannot open is replaced. An update reaches an app a person is
 * using, so one from a parent gone wrong (a list that grows with every save, a
 * loop that posts without waiting) is refused before any of it is composed,
 * with `reopen`, which costs that parent what every change cost it before.
 * The figures are what a SoftN bundle may hold (bundle-format's inspector:
 * 4,000 entries, 128 MB unpacked), well above what FormLogic keeps for an app.
 */
export interface UpdateLimits {
  /** Text files in one update. */
  files: number;
  /** Characters of text in one update, the files' paths included. */
  text: number;
  /** Media files in one update. */
  assets: number;
  /**
   * Characters of media in one update, as base64. A file sent as bytes counts as the base64 it
   * would be, four characters for every three bytes, so the limit is the same either way.
   */
  media: number;
  /** Characters of an id that is a string. */
  id: number;
  /** Updates that may wait while one is being dealt with. */
  waiting: number;
}

export const UPDATE_LIMITS: Readonly<UpdateLimits> = Object.freeze({
  files: 4000,
  text: 32 * 1024 * 1024,
  assets: 4000,
  // 128 MiB of media, in base64.
  media: Math.ceil((128 * 1024 * 1024) / 3) * 4,
  id: 64,
  waiting: 32,
});

/**
 * How many of an update's media files are compared at once with what the page has for them. One at
 * a time, each of a game's thousand pictures would wait for the one before it to be read back; all
 * at once, every file of the app would be held twice over.
 */
const COMPARED_AT_ONCE = 8;

/** One line a person can act on: the first line, 300 characters at most, never a stack (main.tsx's reasonOf). */
export function sentence(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return text.split('\n')[0].slice(0, 300);
}

/**
 * What one media file of an update weighs against its limit: base64 text by its characters, and
 * bytes (a Uint8Array or an ArrayBuffer, which media.ts takes as well) by the base64 they would be.
 * Null for anything else, which is no file.
 */
function mediaWeight(value: unknown): number | null {
  if (typeof value === 'string') return value.length;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Math.ceil(value.byteLength / 3) * 4;
  return null;
}

/** An object as a message carries one: not a list, a Map or a buffer. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/** The id a message names, where it is one the frame echoes: a number, or a short string. */
function updateId(data: unknown, limits: UpdateLimits): number | string | null {
  if (!isRecord(data)) return null;
  const id = data.id;
  if (typeof id === 'number') return Number.isFinite(id) ? id : null;
  return typeof id === 'string' && id.length > 0 && id.length <= limits.id ? id : null;
}

/** An update as the frame takes it. */
export interface ReadUpdate {
  id: number | string;
  /** The app's text files, path to text. */
  client: Map<string, string>;
  /** Its media as it came, path to base64 text or bytes; undefined where the parent sent none, which leaves the media as it is. */
  assets: Record<string, unknown> | undefined;
}

/** An update the frame does not take, and why. */
export interface RefusedUpdate {
  id: number | string | null;
  refused: string;
}

/**
 * A `formlogic:update` message, held to its shape and its size before
 * anything is made of it. What `init` assumes of `client` (an object of text
 * under paths) is checked here, because a refusal has somewhere to go: the
 * parent opens a new frame, and that frame says what is wrong with the files.
 */
export function readUpdate(data: unknown, limits: UpdateLimits = UPDATE_LIMITS): ReadUpdate | RefusedUpdate {
  const id = updateId(data, limits);
  const refuse = (refused: string): RefusedUpdate => ({ id, refused });
  if (!isRecord(data)) return refuse('The update is not a message this frame reads.');
  if (id === null) return refuse(`The update names no id to answer it by (a number, or text of up to ${limits.id} characters).`);
  if (!isRecord(data.client)) return refuse('The update carries no files (client: the app\'s text files, each under its path).');
  const paths = Object.keys(data.client);
  if (paths.length > limits.files) return refuse(`The update carries ${paths.length} files, and a frame takes ${limits.files} at most where it stands.`);
  const client = new Map<string, string>();
  let text = 0;
  for (const path of paths) {
    const content = data.client[path];
    if (typeof content !== 'string') return refuse(`The update's file ${path.slice(0, 80)} is not text.`);
    text += path.length + content.length;
    if (text > limits.text) return refuse(`The update carries more text than a frame takes where it stands (${limits.text} characters at most).`);
    client.set(path, content);
  }
  // No media named, or named as nothing: the media stays as it is.
  if (data.assets === undefined || data.assets === null) return { id, client, assets: undefined };
  if (!isRecord(data.assets)) return refuse('The update\'s media (assets) is not an object of files under their paths.');
  const names = Object.keys(data.assets);
  if (names.length > limits.assets) return refuse(`The update carries ${names.length} media files, and a frame takes ${limits.assets} at most where it stands.`);
  let media = 0;
  for (const name of names) {
    // Each file is base64 text or bytes. Text that is not base64, or a file of a type the page is
    // not given, is left out where the media is read, as in init (media.ts); anything else is a
    // message gone wrong.
    const weight = mediaWeight(data.assets[name]);
    if (weight === null) return refuse(`The update's media file ${name.slice(0, 80)} is neither base64 text nor bytes.`);
    media += weight;
    if (media > limits.media) return refuse(`The update carries more media than a frame takes where it stands (${limits.media} characters of base64 at most, three bytes counting as four).`);
  }
  return { id, client, assets: data.assets };
}

/** A value as text that is the same for the same content, whatever order its keys were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!isRecord(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) sorted[key] = inner[key];
    return sorted;
  }) ?? '';
}

/** A field of a field of … an object read from JSON, or undefined where the way there is not objects. */
function field(value: unknown, ...names: string[]): unknown {
  let at = value;
  for (const name of names) {
    if (!isRecord(at)) return undefined;
    at = at[name];
  }
  return at;
}

/** The manifest of a set of files, where it is a JSON object. */
function manifestOf(files: ReadonlyMap<string, string>): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(files.get('manifest.json') ?? '');
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an app asks permission for, as text to compare: its permission.json
 * (read as JSON where it is JSON, so a file written out again with other
 * spacing asks for nothing new) and the older `permissions` block of its
 * manifest. An empty file is no file, as every host reads it.
 */
function asked(files: ReadonlyMap<string, string>, manifest: Record<string, unknown> | undefined): string {
  const text = files.get('permission.json') ?? '';
  let declared = text.trim();
  try {
    if (declared) declared = canonical(JSON.parse(declared));
  } catch {
    // Not JSON: compared as it is written.
  }
  return `${declared}\n${canonical(manifest?.permissions ?? null)}`;
}

/**
 * What a frame makes of a newer set of files: nothing it can take where it
 * stands (`reopen`), a version with a problem that is kept back (`problem`),
 * or the manifest to compose it by.
 */
export type UpdatePlan =
  | { reopen: string }
  | { problem: string }
  | { manifest: Record<string, unknown>; main: string; logic: readonly string[] };

/**
 * Whether the app running from `had` can be handed `next` where it stands.
 *
 * The frame answers for what it reads itself. A frame's engine is chosen and
 * configured once, for the languages the app's file names declared then, so
 * files in other languages need a frame whose engine was chosen for them;
 * the same goes for the Python packages the engine is given. What the app
 * asks permission for is the parent's to grant before an app opens. And the
 * main page is which app this is. Everything else of the manifest is taken:
 * its list of logic files is composed like the pages, the side it declares
 * is drawn, its seed files are left alone (see the header), and what this
 * frame never read (a name, a window size, a sync server) changes nothing
 * here. What the parent decides from the files on its own side, such as the
 * engine it offers, is the parent's to notice, and it needs no answer from
 * the frame to make a new one.
 *
 * A manifest that cannot be read, or names no main page, is a version with a
 * problem: a new frame could not open it either, so the one that works stays.
 */
export function planUpdate(
  had: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  languages: (paths: Iterable<string>) => readonly string[],
): UpdatePlan {
  if (!next.has('manifest.json')) return { problem: 'It has no manifest.json.' };
  const manifest = manifestOf(next);
  if (!manifest) return { problem: 'Its manifest.json is not valid JSON.' };
  if (typeof manifest.main !== 'string' || manifest.main === '') return { problem: 'Its manifest names no main page (main).' };
  const before = manifestOf(had);
  if (before?.main !== manifest.main) return { reopen: 'Its manifest names another main page, so it has to be opened again.' };
  if (asked(had, before) !== asked(next, manifest)) return { reopen: 'What it asks permission for changed, so it has to be opened again.' };
  if (canonical(field(before, 'config', 'python', 'packages') ?? null) !== canonical(field(manifest, 'config', 'python', 'packages') ?? null)) {
    return { reopen: 'The Python packages it asks for changed, so it has to be opened again.' };
  }
  const was = [...languages(had.keys())].sort().join(' and ');
  const now = [...languages(next.keys())].sort().join(' and ');
  if (was !== now) {
    return { reopen: `Its logic is now written in ${now}, where it was ${was}, and a frame's engine is chosen when it opens, so it has to be opened again.` };
  }
  // As init hands them to the composer, so a version composes here as it would in a new frame.
  return { manifest, main: manifest.main, logic: (field(manifest, 'files', 'logic') || []) as readonly string[] };
}

/** Where a version's logic has its `import` lines answered from: that version's own files. */
export type ImportResolver = (path: string) => Promise<string | null>;

export function importsFrom(files: ReadonlyMap<string, string>): ImportResolver {
  return async path => files.get(path.replace(/^\//, '')) ?? null;
}

/** Whether there is a running app to hand a version to, and if not, why not. */
export type UpdateState = 'opening' | 'running' | 'failed' | 'closed';

const NOT_RUNNING: Record<Exclude<UpdateState, 'running'>, string> = {
  opening: 'The app had not opened when the update came, so it has to be opened again with these files.',
  failed: 'This frame reported that the app failed to load, so it has to be opened again.',
  closed: 'This frame has closed.',
};

/** Said with `restarted` where a version no longer has the page file the app was showing. */
export const PAGE_GONE = 'The page it was showing is not in this version, so it was opened at its main page.';

export interface UpdaterOptions<Composed extends object> {
  /** Sends a reply on the app's port. */
  post(reply: UpdateReply): void;
  /** Whether the app's first page has been drawn and it is still there to update. */
  state(): UpdateState;
  /** The languages a set of files is written in, from their names (engineInit's bundleLanguages). */
  languages(paths: Iterable<string>): readonly string[];
  /** Core's composeBundleSource. */
  compose(files: ReadonlyMap<string, string>, main: string, logic: readonly string[]): Composed;
  /** The address a media file is served to the page as, or null for one it is not given (media.ts). */
  mediaUrl(path: string, value: unknown): string | null;
  /**
   * Whether the address the page has for a media file still serves what a version sends for it
   * (media.ts's sameMedia): a file sent again as it was keeps its address, so nothing showing it is
   * loaded again. A frame that leaves it out compares the addresses themselves, which tells a
   * `data:` URL, made from the file, and no other kind.
   */
  sameMedia?(url: string, path: string, value: unknown): boolean | Promise<boolean>;
  /**
   * Lets go of a media address (media.ts's releaseMedia): one no version on screen has and the
   * page was never given. One the page was given stays while the frame does, because the app may
   * keep it in a variable, and a file let go from under it would no longer load. A frame that
   * leaves it out lets go of nothing.
   */
  releaseMedia?(url: string): void;
  /**
   * The address one of the app's own text files is served to the page as, or null for one it is
   * not given (media.ts's textFileUrl): data the page reads by name, `fetch('data/levels.json')`.
   * Media come first. A frame that leaves this out serves media alone.
   */
  textUrl?(path: string, text: string): string | null;
  /** The side a manifest declares the app is drawn in (appTheme.ts). */
  themeOf(manifest: unknown): unknown;
  /**
   * Whether a set of files has `path` as a page other than its main one (place.ts's isOtherPage,
   * over core's bundlePageAt): asked of a version for the page file the app is showing. A frame
   * that follows no links leaves it out, and no page but the main one is then stayed on.
   */
  hasPage?(files: ReadonlyMap<string, string>, main: string, path: string): boolean;
  limits?: UpdateLimits;
}

/** The app once it is open, as `init` opened it. */
export interface OpenApp<Composed extends object> {
  /** Its text files, path to text. */
  files: ReadonlyMap<string, string>;
  /** Its media, path to the address the page is given. */
  media: ReadonlyMap<string, string>;
  /** Hands the running app a version and answers what became of it: core's `live.update`. */
  update(revision: Composed & { importResolver: ImportResolver }): Promise<LiveAnswer>;
  /**
   * Draws the frame's tree again, by the manifest the app now runs by: called when its media or
   * the side it declares is no longer what the tree was last drawn with.
   */
  redraw(manifest: Record<string, unknown>): void;
  /**
   * The page file the app is showing in place of its main page, after a link to it, by its path
   * in the bundle; null on its main page. `update` then hands a version to that page, and is given
   * the version composed with it as the main one. Left out by an app that shows no other page.
   */
  page?(): string | null;
  /**
   * The page file it was showing is not in the version: opens the app at its main page from
   * `revision`, afresh, as a link back to the main page opens it. Without it, such a version is
   * answered `reopen`.
   */
  leave?(revision: Composed & { importResolver: ImportResolver }): void;
}

export interface Updater<Composed extends object> {
  /** The app is open. Until it is, and until its first page is drawn, every update answers `reopen`. */
  open(app: OpenApp<Composed>): void;
  /** A `formlogic:update` message from the port. Each one is answered, through `post`. */
  receive(data: unknown): void;
  /**
   * The address the page is given for a media file, from the media the app has now, or for one of
   * its own data files from the text it has now (`textUrl`); '' for one it has not.
   */
  asset(path: string): string;
  /** The text files of the version on screen: what another page of the app is composed from when a link goes to it. */
  files(): ReadonlyMap<string, string>;
}

/** What became of an update, before it is addressed to the ids that asked. */
type Answer = Omit<UpdateReply, 'type' | 'id'>;

export function createUpdater<Composed extends object>(options: UpdaterOptions<Composed>): Updater<Composed> {
  const limits = options.limits ?? UPDATE_LIMITS;
  let app: OpenApp<Composed> | undefined;
  // The version on screen: the last one that was taken. A version kept back changes none of these.
  let files: ReadonlyMap<string, string> = new Map();
  let media: ReadonlyMap<string, string> = new Map();
  // Every media address made and not let go of yet, and those of them the page has been given (`asset`).
  const held = new Set<string>();
  const handedOut = new Set<string>();
  // The addresses of the version's own data files, made as the page asks for them (`asset`).
  const textUrls = new WeakMap<ReadonlyMap<string, string>, Map<string, string>>();
  // Media the parent sent with a version that was not taken. Media left out means "as I last sent
  // it", so it goes with the next version that leaves its media out, and is let go once one is taken.
  let unread: Record<string, unknown> | undefined;
  let busy = false;
  // The updates that came while one was being dealt with, gathered as they came: every id, and the
  // newest files alone, so a parent that posts faster than the app can follow is held as one version.
  let waiting: { ids: Array<number | string>; client: Map<string, string>; assets: Record<string, unknown> | undefined } | null = null;

  const answer = (id: number | string | null, result: Answer): void => {
    try {
      options.post({ type: 'updated', id, ...result });
    } catch {
      // A port that has closed takes no answer.
    }
  };

  /** Why there is no app to hand a version to, or null when there is one. */
  const notRunning = (): Answer | null => {
    const state = app ? options.state() : 'opening';
    return state === 'running' ? null : { outcome: 'reopen', reason: NOT_RUNNING[state] };
  };

  /**
   * The media an update carries, as the page is given it. The same Map where
   * nothing differs, so "is it the same media" is one comparison; and where a
   * file holds what it held, the address the page already has for it, so
   * nothing showing it is loaded again. An address is a `blob:` URL
   * (media.ts), a new one each time one is made, so each file is first
   * compared with what the page's address for it holds (`sameMedia`, a few
   * files at a time), and an address is made only for one that differs.
   * What an update replaces is let go of once it is dealt with (`sweep`).
   */
  const mediaOf = async (assets: Record<string, unknown>, had: ReadonlyMap<string, string>): Promise<ReadonlyMap<string, string>> => {
    const paths = Object.keys(assets);
    const kept = new Set<string>();
    const compare = options.sameMedia;
    if (compare) {
      let cursor = 0;
      const comparing = async (): Promise<void> => {
        while (cursor < paths.length) {
          const path = paths[cursor++];
          const was = had.get(path);
          if (was === undefined) continue;
          try {
            if ((await compare(was, path, assets[path])) === true) kept.add(path);
          } catch {
            // A file that cannot be read back is given an address of its own.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(COMPARED_AT_ONCE, paths.length) }, comparing));
    }
    const next = new Map<string, string>();
    let same = true;
    for (const path of paths) {
      const was = had.get(path);
      if (was !== undefined && kept.has(path)) {
        next.set(path, was);
        continue;
      }
      const url = options.mediaUrl(path, assets[path]);
      if (!url) continue;
      if (was === url) next.set(path, was);
      else {
        held.add(url);
        next.set(path, url);
        same = false;
      }
    }
    return same && next.size === had.size ? had : next;
  };

  /**
   * Once an update is dealt with: lets go of every media address made that
   * the media on screen does not have, which is what a version replaced or
   * took away, and what was made for one that was not taken. An address the
   * page was given is not let go of, and is not looked at again: the app may
   * hold it, and it stays as long as the frame does.
   */
  const sweep = (): void => {
    const showing = new Set(media.values());
    for (const url of held) {
      if (showing.has(url)) continue;
      held.delete(url);
      if (!handedOut.delete(url)) options.releaseMedia?.(url);
    }
  };

  const take = async (client: Map<string, string>, assets: Record<string, unknown> | undefined): Promise<Answer> => {
    const absent = notRunning();
    if (absent || !app) return absent ?? { outcome: 'reopen', reason: NOT_RUNNING.opening };
    const running = app;
    const given = assets ?? unread;
    unread = given;
    const plan = planUpdate(files, client, options.languages);
    if ('reopen' in plan) return { outcome: 'reopen', reason: plan.reopen };
    if ('problem' in plan) return { outcome: 'kept', changed: [], problem: plan.problem };
    // The version's media, ready before anything is decided of where the app stands: telling the
    // files that are the same reads them back, and the app goes on meanwhile.
    const hadMedia = media;
    const nextMedia = given === undefined ? hadMedia : await mediaOf(given, hadMedia);
    const meanwhile = notRunning();
    if (meanwhile) return meanwhile;
    // Where the app stands: on its main page, or on another of its page files after a link to it.
    // That page is what the version is composed with while the version has it. One without it is
    // opened at its main page, which only an app that can leave a page does where it stands.
    const stood = running.page?.() ?? null;
    const stays = stood !== null && options.hasPage?.(client, plan.main, stood) === true ? stood : null;
    const leaves = stood !== null && stays === null;
    if (leaves && !running.leave) return { outcome: 'reopen', reason: 'The page it was showing is not in this version, so it has to be opened again.' };
    // Files that do not compose (a page that is missing, Python and JavaScript mixed) are a version
    // with a problem, not a reason for a new frame: a new frame could not open them either, and
    // would show only its error where this one still shows the last version that worked.
    let composed: Composed;
    try {
      composed = options.compose(client, stays ?? plan.main, plan.logic);
    } catch (error) {
      return { outcome: 'kept', changed: [], problem: sentence(error) || 'Its files could not be put together.' };
    }
    const before = manifestOf(files);
    const themeChanged = canonical(options.themeOf(before) ?? null) !== canonical(options.themeOf(plan.manifest) ?? null);
    // A main page opened afresh has no last version of its own to go back to, so the one problem
    // the composer names (a page that does not parse) keeps the version back before anything is
    // changed, and the page that was showing stays, on the version it has.
    const unparsed = leaves ? sentence((composed as { parseProblem?: unknown }).parseProblem) : '';
    if (unparsed) return { outcome: 'kept', changed: [], problem: unparsed };
    // The new media first, so logic that starts again reads it as it starts. It goes back if the version is kept back.
    media = nextMedia;
    const mediaChanged = media !== hadMedia;
    if (leaves) {
      files = client;
      unread = undefined;
      running.leave?.({ ...composed, importResolver: importsFrom(client) });
      if (mediaChanged || themeChanged) running.redraw(plan.manifest);
      // Another page altogether, whatever else of the version differs from the last.
      return { outcome: 'restarted', changed: ['page', ...(mediaChanged ? ['media'] : []), ...(themeChanged ? ['theme'] : [])], reason: PAGE_GONE, carried: false };
    }
    let result: LiveAnswer;
    try {
      // Its own resolver, over its own files: the logic of the version that is running is answered
      // from that version, whichever one that turns out to be.
      result = await running.update({ ...composed, importResolver: importsFrom(client) });
    } catch (error) {
      result = { outcome: 'kept', problem: sentence(error) };
    }
    // Closed, or replaced by its own failure, while the version was being taken: nothing is left to draw.
    const gone = notRunning();
    if (gone) return gone;
    if (result.outcome === 'kept') {
      // A link was followed while the version was being taken: the page that was handed it is no
      // longer there to take it, and the page now showing was composed from the version before.
      // It is handed the version in its turn, composed with that page.
      if ((running.page?.() ?? null) !== stood) {
        media = hadMedia;
        return take(client, assets);
      }
      if (mediaChanged) {
        media = hadMedia;
        running.redraw(before ?? plan.manifest);
      }
      return { outcome: 'kept', changed: [], problem: sentence(result.problem) || 'It has a problem, and the last version that worked is still showing.' };
    }
    files = client;
    unread = undefined;
    if (mediaChanged || themeChanged) running.redraw(plan.manifest);
    const changed = [...(result.changed ?? []).filter((part): part is string => typeof part === 'string')];
    if (mediaChanged) changed.push('media');
    if (themeChanged) changed.push('theme');
    if (result.outcome === 'restarted') {
      const problem = sentence(result.problem);
      return { outcome: 'restarted', changed, reason: sentence(result.reason), carried: result.carried === true, ...(problem ? { problem } : {}) };
    }
    // Text the renderer found unchanged, with other media or another side: the page was drawn again all the same.
    return { outcome: changed.length > 0 ? 'updated' : 'unchanged', changed };
  };

  /**
   * One at a time, in order. Those that came while one was being dealt with are gathered, as
   * core's live app gathers: the newest is the one taken, and every id hears what became of it.
   */
  const run = async (): Promise<void> => {
    busy = true;
    try {
      while (waiting) {
        const gathered = waiting;
        waiting = null;
        let result: Answer;
        try {
          result = await take(gathered.client, gathered.assets);
        } catch (error) {
          result = { outcome: 'reopen', reason: sentence(error) || 'The update could not be taken where the app stands.' };
        }
        sweep();
        for (const id of gathered.ids) answer(id, result);
      }
    } finally {
      busy = false;
    }
  };

  return {
    open(opened) {
      app = opened;
      files = opened.files;
      media = opened.media;
      for (const url of media.values()) held.add(url);
    },
    receive(data) {
      const update = readUpdate(data, limits);
      if ('refused' in update) {
        answer(update.id, { outcome: 'reopen', reason: update.refused });
        return;
      }
      if (!waiting) waiting = { ids: [update.id], client: update.client, assets: update.assets };
      else if (waiting.ids.length >= limits.waiting) {
        answer(update.id, { outcome: 'reopen', reason: 'Too many updates are waiting for this frame, so the app has to be opened again.' });
        return;
      } else {
        waiting.ids.push(update.id);
        waiting.client = update.client;
        // Media left out means "as I last sent it", and the last sent may be one of these: the
        // media last sent among them goes with the newest files.
        if (update.assets !== undefined) waiting.assets = update.assets;
      }
      if (!busy) void run();
    },
    asset: path => {
      const name = path.replace(/^\.\//, '');
      const found = media.get(name);
      if (found) {
        // The app may keep it from now on, so it is never let go of while the frame lives (`sweep`).
        handedOut.add(found);
        return found;
      }
      const text = files.get(name);
      if (text === undefined || !options.textUrl) return '';
      // Made once for each version's file: a page that asks for it on every frame of a game does not
      // copy a large file each time. The cache goes with the version it was made from.
      let made = textUrls.get(files);
      if (!made) textUrls.set(files, made = new Map());
      let url = made.get(name);
      if (url === undefined) made.set(name, url = options.textUrl(name, text) ?? '');
      return url;
    },
    files: () => files,
  };
}
