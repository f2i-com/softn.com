/**
 * Container Sandbox Session Controller.
 *
 * Runs inside a Dedicated Web Worker (`worker-entry.ts`), and can also be
 * instantiated over an in-memory message channel in Node/JSDOM Vitest tests.
 *
 * Responsibilities:
 * - Boots the selected tiered ZIPP WASM engine (`lite` / `javascript` / `typescript` / `python`)
 * - Installs synchronous Worker-local bridges (`localStorage`, `db`, `vfs.fetch`, `esm.resolve`)
 * - Pre-links the ES module graph and handles dynamic `import()` (`esm.load`) on demand
 * - Executes classic `<script>`, `<script type="module">`, TypeScript, and Python entry scripts
 * - Flushes batched `ShellOp[]` DOM & Canvas2D & Split-Realm 3D mutations after every turn
 */

import { shellPrelude } from '../../core/src/document-shell/shell-source';
import { bytesToBase64, mimeTypeFor, piecesSize, piecesToBytes, readRunnableModule, resolveVfsPath, VIRTUAL_ORIGIN } from './archive';
import { matchBackendTarget, type BackendRoutingConfig, type ParsedBackendTarget } from './backend-transport';
import { encodePng, replayCanvasCommands } from './canvas-replay';
import { canvasSide } from './host-policy';
import {
  CLASSIC_GLOBALS_HELPER,
  ESM_REGISTRY_PREAMBLE,
  MAX_RUNTIME_MODULE_BYTES,
  classicImportsRewritten,
  classicScriptAsFunction,
  looksLikeModule,
  resolveModuleSpecifier,
  safeVendorName,
  scriptForEval,
  typeScriptScriptPublished,
  tooLongForEval,
  transformEsModule,
  utf8Length,
} from './esm-linker';
import { GUEST_EXTENSIONS_SOURCE } from './guest-canvas-and-ext';
import { BUILTIN_VENDOR_MODULES } from './guest-vendors';
import { transformJsx } from './jsx-transform';
import { GUEST_BROWSER_GLOBALS_SOURCE } from './guest-browser-globals';
import { GUEST_WEB_APIS_SOURCE } from './guest-web-apis';
import { GUEST_INDEXEDDB_SOURCE } from './guest-indexeddb';
import { GUEST_WORKER_SCOPE_SOURCE } from './guest-worker-scope';
import { blobWithin } from './capped-body';
import { isExternalUrlAllowed, sameSite } from './sanitize';
import { loadZippEngine, type LoadedZippBindings, type ZippEngineInstance } from './zipp-loader';
import { WebGLWorkerHost } from './webgl-worker-host';
import { ThreeWorkerHost } from './three-worker-host';
import { GUEST_THREE_NATIVE_SOURCE } from './guest-three-native';
import type {
  Canvas2DCmd,
  ContainerPermissions,
  ExtractedScript,
  HostToWorkerMsg,
  ShellOp,
  WorkerToHostMsg,
} from './types';
import type { Capability } from '@softn/bundle-format/capabilities';

/** A socket the Worker holds open for the app, and what has arrived on it that the app has not taken yet. */
interface OpenSocket {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
  bytes: number;
  /** The app's standing call for the next events, answered when there are some. */
  waiting: number | null;
  /** Closed, or being closed for holding too much: nothing more is taken from it. */
  over: boolean;
}

/** A request as the app's side hands it over: a body of bytes comes as base64, the bridge carries text. */
interface StreamRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  /** A body in parts, put together here: the words of a form around a file's bytes, which the app's side never had to make bytes of. */
  bodyParts?: BodyPiece[];
  /** A body that came ahead of the request in pieces (`stream.body`), by the name it came under. */
  bodyId?: string;
  cache?: string;
}

/** A request's body arriving in pieces, ahead of the request: its parts so far and their size, or -1 once it is past what is sent. */
interface PendingBody {
  parts: Array<string | Uint8Array>;
  bytes: number;
}

/** The Worker's own copy of a canvas of the app's. */
interface MirrorCanvas {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** A picture from the network was drawn into it: it is not read back. */
  unreadable: boolean;
  /** A picture drawn into it was not here to draw (not decoded yet, or none the Worker can have): what is read back lacks it. */
  missing: boolean;
  /** Made again after the Worker let go of the copy before it: what was drawn before then is not in it. */
  partial: boolean;
}

/** A picture the app draws into a canvas, as the Worker has it. */
/** A Worker of the app's own, run in an engine of its own (startAppWorker). */
interface AppWorker {
  id: string;
  engine: ZippEngineInstance | null;
  timers: Map<number, ReturnType<typeof setTimeout>>;
  /** The modules its engine has, apart from the app's. */
  defined: Set<string>;
  over: boolean;
  /** Messages for it that came before it started, what they hold, and whether the app was told some were not sent. */
  waiting: string[];
  waitingChars: number;
  toldWaiting: boolean;
  started: boolean;
  /** Messages waiting to be handed over once it has started (both ways), and whether the app was told some were not sent. */
  queuedChars: number;
  toldQueued: boolean;
  /** The crypto keys and the blob addresses it made: let go of when it ends. */
  keys: Set<string>;
  blobs: Set<string>;
  /** A drain of its engine under way, and whether an answer given in it asks for another round. */
  draining: boolean;
  drainAgain: boolean;
}

/** The ids of the keys in an answer of crypto.subtle (`$k`), into `into`. */
function collectKeyIds(value: unknown, into: Set<string>, depth: number): void {
  if (depth > 16 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeyIds(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const key = record.$k as { id?: unknown } | undefined;
  if (key && typeof key === 'object' && typeof key.id === 'string') into.add(key.id);
  for (const item of Object.values(record)) collectKeyIds(item, into, depth + 1);
}

interface MirrorPicture {
  src: string;
  /** The page's address the picture's own address is read from. */
  basePath: string;
  bitmap: ImageBitmap | null;
  /** Its pixels, counted against what the Worker keeps of pictures. */
  pixels: number;
  foreign: boolean;
  /** Asked for with CORS (`crossorigin`): fetched from its site, without cookies, and readable when the site allows it. */
  cors: boolean;
  /** Settles when it is decoded or cannot be; null when it is not being decoded. */
  decoding: Promise<void> | null;
  /** It could not be decoded: not tried again. */
  failed: boolean;
}

/**
 * What the Worker keeps for its copies of the app's canvases. Past each, what was used least
 * lately is let go of. (A table held to a count, and never let go of, gave the 65th canvas
 * ever drawn on no copy at all, and kept every picture and every blob as long as the app.)
 */
const MAX_MIRROR_PIXELS = 32 * 1024 * 1024;
/** The most Workers of its own an app runs at once. */
const MAX_APP_WORKERS = 8;
/** What each part a commit writes or removes is counted as beyond its name and text, and the most parts one commit holds. */
const STAGED_PART_CHARS = 32;
const MAX_STAGED_PARTS = 200_000;
/** The most of a script from another site read (one past what eval compiles is refused all the same). */
const MAX_REMOTE_SCRIPT_BYTES = 4 * 1024 * 1024;
/** How long one drain goes round for an app that keeps asking what is answered at once, before the rest is left for a task of its own. */
const MAX_DRAIN_MS = 50;
/** What the messages posted to a Worker before it has started may hold in all (characters of their copies). */
const MAX_WAITING_CHARS = 32 * 1024 * 1024;
/** The numbers the runtime answers an app Worker's calls by, apart from any call of the app's own. */
const WORKER_CALL_BASE = 2 ** 40;
/** What an app Worker asks of the runtime at once: its files read, a module's address, bytes made. */
const WORKER_SYNC_KINDS = new Set(['esm.resolve', 'vfs.fetch', 'bytes.decode']);
/** What it asks to be answered later, answered as the app's own is (its network, its keys). */
const WORKER_ROUTED_KINDS = new Set(['stream.open', 'stream.body', 'stream.next', 'stream.close', 'net.fetch', 'bundle.read', 'subtle', 'subtle.drop', 'ws.open', 'ws.next', 'ws.send', 'ws.close', 'esm.load', 'esm.forget']);
/** Of those, the ones answered never: their numbers are let go of at once. */
const WORKER_UNANSWERED_KINDS = new Set(['stream.body', 'stream.close', 'ws.send', 'ws.close']);

/** The modules every engine's program defines eagerly (guest-canvas-and-ext.ts), the app's and each of its Workers'. */
const BUILTIN_MODULES = [
  'softn:db',
  'softn:storage',
  'softn:net',
  'softn:backend',
  'softn:api',
  'softn:sqlite',
  'softn-vendor:react',
  'softn-vendor:react-dom',
  'softn-vendor:react-dom/client',
  'softn-vendor:react/jsx-runtime',
  'softn-vendor:react/jsx-dev-runtime',
];

/** The name of a part of one of the app's IndexedDB databases: its description, a store's list of pages, a page. Nothing else is read, written or listed. */
const IDB_PART_NAME = /^[msp]\[/;

/** The most of a part of the app's IndexedDB read in one answer: its JSON (quotes escaped) stays under the 16 MB the bridge carries. */
const IDB_READ_PIECE = 6_000_000;

/** The largest picture from another site fetched for the copies. */
const MAX_REMOTE_PICTURE_BYTES = 32 * 1024 * 1024;
const MAX_PICTURE_PIXELS = 32 * 1024 * 1024;
const MAX_MIRROR_PICTURES = 1024;
/** The most characters of the pictures' names and addresses kept in all (a `data:` address is megabytes). */
const MAX_PICTURE_ADDRESS_CHARS = 64 * 1024 * 1024;
/** The most names of pictures let go of that are remembered as such. */
const MAX_FORGOTTEN_PICTURES = 4096;
/** The most copies of canvases the Worker keeps, whatever their size; and the most it remembers having let go of. */
const MAX_MIRRORS = 1024;
const MAX_REMEMBERED_MIRRORS = 65_536;
/** The most pictures decoded at once for the copies. */
const MAX_DECODING = 3;
/** The blobs kept for pictures drawn from their addresses: what the page keeps of the app's blobs. */
const MAX_MIRROR_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_MIRROR_BLOBS = 512;
/** The largest picture, as a file, decoded for the copies as soon as its address is set rather than when it is first drawn. */
const MAX_EARLY_PICTURE_BYTES = 4 * 1024 * 1024;
/**
 * The longest an image's load waits for the Worker to decode the picture before the app hears
 * of it, and the most the page's events may wait for pictures in all in any two seconds: what
 * the person does waits behind a held load, and loads held one after another kept a click
 * waiting for seconds.
 */
const MAX_PICTURE_WAIT_MS = 500;
const HOLD_WINDOW_MS = 2000;
const MAX_HELD_IN_WINDOW_MS = 600;
/** The most pixels in one answer of getImageData's (as numbers, four a pixel): the bridge carries 16 MB of text. */
const MAX_PIXELS_AN_ANSWER = 900_000;
/** The longest `data:` address handed back, for the same reason. */
const MAX_DATA_URL_LENGTH = 15 * 1024 * 1024;

/** How much of the program, in characters, the parts loaded on demand may bring it to (the engine takes 16 MB). */
/** What a Worker of the app's may compile ahead (the modules its import() names), after its own code and the layers. */
function workerAheadBytes(code: string): number {
  return Math.max(0, Math.min(MAX_AHEAD_BYTES, MAX_PROGRAM_BYTES - PROGRAM_SLACK_BYTES - fixedProgramBytes() - utf8Length(code)));
}

/** How many of the app's long script files that do not compile are stood in for, each a compile again, before all of them are let go of. */
const MAX_STANDBY_FAILURES = 3;
/** What the engine compiles at the start (16 MiB of UTF-8), room kept for what is written around the app's code, and the most compiled ahead of being asked for. */
const MAX_PROGRAM_BYTES = 16 * 1024 * 1024;
const PROGRAM_SLACK_BYTES = 512 * 1024;
const MAX_AHEAD_BYTES = 10 * 1024 * 1024;

let fixedBytes = 0;
/** The bytes of the layers every program has. */
function fixedProgramBytes(): number {
  if (fixedBytes === 0) {
    fixedBytes = [ESM_REGISTRY_PREAMBLE, GUEST_EXTENSIONS_SOURCE, GUEST_BROWSER_GLOBALS_SOURCE, GUEST_WEB_APIS_SOURCE, GUEST_INDEXEDDB_SOURCE, GUEST_WORKER_SCOPE_SOURCE, CLASSIC_GLOBALS_HELPER, WARNINGS_MARKED].reduce((sum, part) => sum + utf8Length(part), 0);
  }
  return fixedBytes;
}

/** The line breaks in a text, as JavaScript counts them (a CR and LF together are one). */
function lineBreaks(text: string): number {
  return text.match(/\r\n|[\r\n\u2028\u2029]/g)?.length ?? 0;
}

/** What a person and a host are told when the engine has stopped, in words. */
function stoppedBecause(message: string): string {
  if (/per-compilation limit/i.test(message)) {
    return `The app stopped: it compiled more code at once than the engine takes while an app runs (64 KB), in an eval or a part of the app loaded on demand. (${message})`;
  }
  return `The app stopped: ${message}`;
}

/** The longest name a part of an IndexedDB database is kept under (the database's and the store's names, written out). */
const MAX_IDB_NAME_LENGTH = 1024;

/** The most bodies waiting for their requests at once, and the largest a body sent in pieces may be. */
const MAX_PENDING_BODIES = 8;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The most of all the bodies waiting for their requests at once. */
const MAX_PENDING_BODY_BYTES = 96 * 1024 * 1024;

/** What the app's crypto.subtle does, each by the Worker's own; and those that make keys, which an app holds so many of at once. */
const SUBTLE_OPS = new Set(['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']);
const MAKES_KEYS = new Set(['generateKey', 'deriveKey', 'importKey', 'unwrapKey']);
const MAX_CRYPTO_KEYS = 10_000;
const MAX_CRYPTO_KEY_BYTES = 64 * 1024 * 1024;
/** The most one key may hold, and (in bits, eight times this) the most derived at once. */
const MAX_ONE_KEY_BYTES = 1024 * 1024;

/** What a key asks to hold, in bytes, by the algorithm it is made with: its length, or an RSA modulus (its private key holds about five of those). */
function askedKeyBytes(algorithm: unknown): number {
  if (!algorithm || typeof algorithm !== 'object') return 0;
  const told = algorithm as { length?: unknown; modulusLength?: unknown };
  const bits = Math.max(Number(told.length) || 0, (Number(told.modulusLength) || 0) * 5);
  return Number.isFinite(bits) && bits > 0 ? Math.ceil(bits / 8) : 0;
}
/** A part of a body: words, or base64 and (for a part of a file) which of its bytes are the part's. */
interface BodyPiece {
  text?: unknown;
  base64?: unknown;
  skip?: unknown;
  take?: unknown;
}

/** A body part's bytes, or its words. */
function bodyPiece(part: BodyPiece | null | undefined): string | Uint8Array {
  if (typeof part?.base64 !== 'string') return String(part?.text ?? '');
  const bytes = base64ToBytes(part.base64);
  const skip = typeof part.skip === 'number' && part.skip > 0 ? Math.floor(part.skip) : 0;
  const take = typeof part.take === 'number' && part.take >= 0 ? Math.floor(part.take) : bytes.length - skip;
  // A copy of the part kept: a view kept the whole of what was decoded, and counted the part.
  return skip === 0 && take >= bytes.length ? bytes : bytes.slice(skip, skip + take);
}

/** The body of a request, from the way the app's side handed it over. */
function requestBody(opts: StreamRequest): BodyInit | undefined {
  if (Array.isArray(opts.bodyParts)) return new Blob(opts.bodyParts.map((part) => bodyPiece(part)) as BlobPart[]);
  return typeof opts.bodyBase64 === 'string' ? base64ToBytes(opts.bodyBase64) : opts.body;
}

/** The host of the page the app is embedded in: the Worker's own origin, which is the page's. */
function embeddingHost(): string {
  try {
    const here = (globalThis as { location?: { origin?: string; href?: string } }).location;
    if (!here) return '';
    const origin = here.origin && here.origin !== 'null' ? here.origin : new URL(String(here.href)).origin;
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * What an app may say about the browser's copy of an earlier answer: not to use it. Never to
 * use it more than a request does by itself (`force-cache`, `only-if-cached`): the copy may
 * be one the embedding page fetched with the person's cookies, and a request made for an
 * app goes without them.
 */
const CACHE_MODES: Readonly<Record<string, RequestCache>> = { 'no-store': 'no-store', reload: 'reload', 'no-cache': 'reload' };

/**
 * How a request made for an app uses the browser's copy of an earlier answer.
 *
 * To the site the app is embedded in, not at all. The browser keeps one copy of an answer
 * for a page whoever asked for it and however: the embedding page asks its own site with
 * the person's cookies, and a copy it was given that way would answer the app's request,
 * which goes without them. Any other site's answers are used as a request uses them by
 * itself, unless the app says not to.
 */
function cacheModeFor(url: string, asked: string | undefined): RequestCache | undefined {
  try {
    if (sameSite(new URL(url).hostname, embeddingHost())) return 'no-store';
  } catch {
    // Not an address: the request is refused before this matters.
  }
  return typeof asked === 'string' && Object.hasOwn(CACHE_MODES, asked) ? CACHE_MODES[asked] : undefined;
}

/** A request the Worker is reading for the app as it arrives, and what has arrived that the app has not taken yet. */
interface OpenStream {
  events: Array<Record<string, unknown>>;
  bytes: number;
  waiting: number | null;
  over: boolean;
  abort: AbortController;
  /** Called when the app has taken what was waiting: the read goes on. */
  drained: (() => void) | null;
}

/**
 * The most requests one app has open at once, and the most kept for it unread on one before
 * the read waits. The app's own side has forty-eight open at most and queues the rest, so
 * this one is not met by an app that asks as the web's own `fetch` does.
 */
const MAX_STREAMS = 64;
const MAX_STREAM_QUEUE_BYTES = 2 * 1024 * 1024;

/** The most sockets one app holds open, and the most that is kept for it unread on one. */
const MAX_SOCKETS = 8;
const MAX_SOCKET_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_SOCKET_QUEUE_EVENTS = 10_000;
/** The longest message an app sends, in characters as the bridge carries it (text, or base64). */
const MAX_SOCKET_MESSAGE_CHARS = 8 * 1024 * 1024;

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const DB_SYNC_OPS = [
  'db.query',
  'db.get',
  'db.create',
  'db.update',
  'db.delete',
  'db.hardDelete',
  'db.startSync',
  'db.stopSync',
  'db.getSyncStatus',
  'db.getSavedSyncRoom',
];

/**
 * What `console.warn` writes ahead of its line, between two invisible separators, so that a
 * warning can be told from an error on the one stream the engine gives both. An app that
 * writes it itself only calls its own error a warning.
 */
const WARNING_MARK = '⁣softn:warn⁣';

/** A warning and an error are one stream to the engine: a warning is written with a mark in front, which the console drain reads and takes off. */
const WARNINGS_MARKED = `(function () { var c = globalThis.console; if (!c || typeof c.error !== 'function') return; var error = c.error; c.warn = function () { var a = Array.prototype.slice.call(arguments); a.unshift(${JSON.stringify(WARNING_MARK)}); return error.apply(c, a); }; })();`;

const LS_SYNC_OPS = ['ls.getItem', 'ls.setItem', 'ls.removeItem', 'ls.clear'];
const APP_SYNC_OPS = ['app.esm.resolve', 'app.vfs.fetch', 'app.xdb.watch', 'app.idb.keys', 'app.idb.read', 'app.idb.write', 'app.idb.remove', 'app.canvas.image', 'app.canvas.dataurl', 'app.canvas.pixels', 'app.webgl', 'app.three', 'app.session', 'app.bytes.decode', 'app.idb.begin', 'app.idb.end', 'app.script.prepare', 'app.scripts.placed'];

interface DbRecord {
  id: string;
  created_at: string;
  updated_at: string;
  _deleted?: boolean;
  [key: string]: unknown;
}

/** Keep the original flat web fields while giving each row the XDB data view used by Studio. */
function guestRecord(record: DbRecord): DbRecord {
  const { id: _id, created_at: _created, updated_at: _updated, _deleted, deleted: _tombstone, collection: _collection, data, ...fields } = record;
  if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data))) return record;
  return { ...record, data: { ...data as Record<string, unknown>, ...fields } };
}

export class ContainerWorkerSession {
  private readonly postToHost: (msg: WorkerToHostMsg, transfer?: Transferable[]) => void;
  private readonly webglHost = new WebGLWorkerHost();
  private readonly threeHost = new ThreeWorkerHost();
  private externalThreeLoaded = false;
  private readonly fallbackGlueFactory?: () => Promise<Record<string, unknown>>;

  private engine: ZippEngineInstance | null = null;
  private textFiles: Record<string, string> = {};
  private binaryFiles: Record<string, Uint8Array> = {};
  private importMap: Record<string, string> = {};
  private vendorModules: Record<string, string> = {};
  private runtimeUrl = '/runtime/';
  private permissions: ContainerPermissions = {};
  private grantedCapabilities = new Set<Capability>();
  private instructionsPerTurn = 100_000_000;
  private storageQuotaBytes = 5 * 1024 * 1024;
  /** Sizes of persisted JSON snapshots, in UTF-16 bytes. Untouched bundled seeds take no quota. */
  private readonly savedCollectionBytes = new Map<string, number>();
  private recordBytesKept = 0;
  private language: 'javascript' | 'typescript' | 'python' = 'javascript';

  private readonly localStore = new Map<string, string>();
  private localStoreBytes = 0;
  private readonly dbCollections = new Map<string, Map<string, DbRecord>>();
  private dbRecordSeq = 1;
  private readonly watchedCollections = new Set<string>();
  private readonly changedCollections = new Set<string>();
  private notifyDbTimer?: ReturnType<typeof setTimeout>;
  /**
   * The Worker's own copy of each canvas the app draws on, for the app to read back at once
   * (`toDataURL`, `getImageData`): kept only for an app whose own code names one of the two.
   * And the pictures the app draws into canvases, made ready here as the app first draws each.
   */
  private mirrorCanvases = false;
  private namesReadBack = false;
  /** The copies, the pictures and the blobs, each the least lately used first. */
  private readonly mirrors = new Map<number, MirrorCanvas>();
  private mirrorPixels = 0;
  /** Canvases whose copy was let go of. */
  private readonly lostMirrors = new Set<number>();
  /** Canvases whose copy was let go of while it could not be read back. */
  private readonly unreadableMirrors = new Set<number>();
  /** Pictures being decoded now, and those waiting for their turn. */
  private decodingNow = 0;
  private readonly decodeWaiting: Array<() => void> = [];
  private readonly mirrorPictures = new Map<string, MirrorPicture>();
  private picturePixels = 0;
  private pictureChars = 0;
  /** Pictures let go of, by name: drawn again, what is read back says it lacks them. */
  private readonly forgottenPictures = new Set<string>();
  private readonly mirrorBlobs = new Map<string, { type: string; bytes: Uint8Array }>();
  private mirrorBlobBytes = 0;
  /** What has been said once to the app's console. */
  private readonly warned = new Set<string>();
  /** The page's events and changes in the order they came, while one waits for a picture to be decoded here. */
  private readonly turnsWaiting: Array<{ run: () => void; waitFor: Promise<void> | null }> = [];
  /** The hold in force, by its number (0: none); and what holding has cost lately. */
  private holding = 0;
  private holdSeq = 0;
  private holdWindowStart = Number.NEGATIVE_INFINITY;
  private heldInWindow = 0;
  /** What the app's IndexedDB databases are kept as, each part a text by its name, and what they take of the quota. */
  private readonly idbStore = new Map<string, string>();
  private idbBytes = 0;
  /** Whether the page keeps them apart from the app's localStorage (its own IndexedDB), held to their own quota. */
  private idbApart = false;
  private idbQuotaBytes = 0;
  /** The parts written in this turn, sent to the page together when it is over. */
  private idbWrites: Map<string, string | null> | null = null;
  /** Parts being written in pieces, and the characters they hold so far. */
  private readonly idbPieces = new Map<string, { count: number; pieces: string[]; chars: number }>();
  private idbPieceChars = 0;
  /** The batches of parts sent to the page: the last one's number, the last the page answered, those it did not keep, what each part was before each, and the transactions waiting to know. */
  private idbBatchId = 0;
  private idbAcked = 0;
  private readonly idbRefused = new Set<number>();
  private readonly idbBatchPrev = new Map<number, Map<string, string | undefined>>();
  private idbKeptWaiters: Array<{ id: number; callId: number }> = [];
  /** A commit's writes, kept when it ends (all or none); null when none is under way. */
  private idbStaged: Map<string, string | null> | null = null;
  private idbStagedChars = 0;

  private readonly definedModules = new Set<string>();
  /** The engine's bindings, for an app Worker's engine; the app's Workers by the id its side knows each by; and their calls the runtime is answering. */
  private bindings: LoadedZippBindings | null = null;
  private readonly appWorkers = new Map<string, AppWorker>();
  private nextWorkerCall = WORKER_CALL_BASE;
  private readonly workerCalls = new Map<number, { worker: AppWorker; callId: number; kind: string }>();
  /** The app's own script files compiled with it as functions (path → function), for scripts it adds that name them. */
  private readonly standbyScripts = new Map<string, string>();
  /** The same functions by the text of their files, and why a file that was to be compiled was not. */
  private readonly standbyByText = new Map<string, string>();
  private readonly standbyRefused = new Map<string, string>();
  /** The page's own scripts, handed to the app's side once at the start (scripts.placed). */
  private placedScripts: unknown[] = [];
  /** Module scripts of text the app added, each at an address of its own. */
  private addedModules = 0;
  /** A drain under way (drainTurn), and whether an answer given in it asks for another round. */
  private draining = false;
  private drainAgain = false;
  /** Work handed over in tasks of its own, in order (messages between the app and its Workers). */
  private readonly tasks: Array<() => void> = [];
  private taskChannel: MessageChannel | null = null;
  private tasksPending = false;
  private tasksYielded = 0;
  /** The app's side's synchronous calls (installBridges): an app Worker's engine takes some of them. */
  private appSyncCall: ((kind: unknown, args: unknown) => unknown) | null = null;
  /** The app's keys for crypto.subtle, by the id its side knows each by. */
  private readonly cryptoKeys = new Map<string, CryptoKey>();
  private nextCryptoKey = 1;
  /** Keys being made now, and what the keys kept hold (counted by the call that made them). */
  private cryptoMaking = 0;
  private cryptoKeyBytes = 0;
  private readonly cryptoKeyWeights = new Map<string, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The host says the app is not on screen: its timers wait (`heldTimers`: timer id to its callback), and no frame is asked for. */
  private paused = false;
  private readonly sockets = new Map<string, OpenSocket>();
  private readonly streams = new Map<string, OpenStream>();
  private readonly bodies = new Map<string, PendingBody>();
  private readonly heldTimers = new Map<number, number>();
  private backendRouting?: BackendRoutingConfig;
  private hasSqlite = false;
  private pageBaseUrl = `${VIRTUAL_ORIGIN}/`;
  /** High base so Worker-initiated host requests never collide with guest callback IDs. */
  private nextHostReqId = 1_000_000_000;
  private readonly pendingHostReqs = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private disposed = false;

  constructor(
    postToHost: (msg: WorkerToHostMsg, transfer?: Transferable[]) => void,
    fallbackGlueFactory?: () => Promise<Record<string, unknown>>
  ) {
    this.postToHost = postToHost;
    this.fallbackGlueFactory = fallbackGlueFactory;
  }

  async handleMessage(msg: HostToWorkerMsg): Promise<void> {
    if (this.disposed && msg.type !== 'dispose') return;

    switch (msg.type) {
      case 'init':
        await this.handleInit(msg);
        break;
      case 'event':
        this.queueTurn(() => this.handleEvent(msg.turnId, msg.nodeId, msg.eventType, msg.props, msg.syncChanges), this.pictureLoading(msg.eventType, msg.nodeId, msg.props));
        break;
      case 'sync':
        this.queueTurn(() => this.handleSync(msg.changes), null);
        break;
      case 'raf':
        this.handleRaf(msg.timestamp);
        break;
      case 'permissions-updated':
        this.grantedCapabilities = new Set(msg.grantedCapabilities);
        break;
      case 'host-reply': {
        const pending = this.pendingHostReqs.get(msg.requestId);
        if (pending) {
          this.pendingHostReqs.delete(msg.requestId);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error || 'Host request failed'));
        } else {
          this.resolveCallbackAndFlush(msg.requestId, msg.ok ? msg.result : { error: msg.error });
        }
        break;
      }
      case 'ws-event': {
        const socket = this.sockets.get(msg.id);
        if (!socket || socket.over) break;
        const ev = msg.event;
        if (ev.type === 'open') {
          (socket.ws as { readyState: number }).readyState = 1;
          socket.events.push({ t: 'open', protocol: ev.protocol ?? '', extensions: '' });
        } else if (ev.type === 'message') {
          if (typeof ev.data === 'string') {
            socket.events.push({ t: 'message', data: ev.data });
            socket.bytes += ev.data.length * 2;
          } else {
            const b64 = bytesToBase64(ev.data);
            socket.events.push({ t: 'message', base64: b64 });
            socket.bytes += ev.data.byteLength * 2;
          }
        } else if (ev.type === 'error') {
          socket.events.push({ t: 'error' });
        } else if (ev.type === 'close') {
          (socket.ws as { readyState: number }).readyState = 3;
          socket.events.push({
            t: 'close',
            code: ev.code ?? 1000,
            reason: ev.reason ?? '',
            wasClean: ev.wasClean ?? true,
          });
          socket.over = true;
        }
        if (socket.bytes > MAX_SOCKET_QUEUE_BYTES || socket.events.length > MAX_SOCKET_QUEUE_EVENTS) {
          socket.events = [{ t: 'close', code: 1009, reason: 'Too much arrived unread', wasClean: false }];
          socket.over = true;
          try { socket.ws.close(1009, 'Too much arrived unread'); } catch { /* ignore */ }
        }
        this.pumpSocket(msg.id);
        break;
      }
      case 'storage-changed':
        this.queueTurn(() => this.storageChanged(msg.area, msg.key, msg.value), null);
        break;
      case 'idb-kept':
        this.queueTurn(() => this.idbKept(msg.id, msg.ok === true), null);
        break;
      case 'idb-held':
        // What other tabs kept in the database since, taken in before the app's side writes to it.
        this.queueTurn(() => {
          this.takeIdbParts(msg.parts);
          this.resolveCallbackAndFlush(msg.id, { ok: true });
        }, null);
        break;
      case 'idb-changed':
        // What another tab kept, taken in together.
        this.queueTurn(() => this.takeIdbParts(msg.parts), null);
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.resume();
        break;
      case 'dispose':
        this.dispose();
        break;
    }
  }

  private async handleInit(msg: Extract<HostToWorkerMsg, { type: 'init' }>): Promise<void> {
    // No prototype: a file may be called `constructor`, and `in` below asks about the app's files alone.
    this.textFiles = Object.assign(Object.create(null), msg.textFiles);
    this.binaryFiles = Object.assign(Object.create(null), msg.binaryFiles);
    this.importMap = { ...msg.manifest.importMap };
    this.vendorModules = { ...(msg.vendorModules ?? {}) };
    this.runtimeUrl = msg.runtimeUrl || '/runtime/';
    this.permissions = msg.permissions;
    this.grantedCapabilities = new Set(msg.grantedCapabilities);
    this.backendRouting = msg.backendRouting;
    this.hasSqlite = Boolean(msg.hasSqlite);
    this.pageBaseUrl = msg.seed.url || `${VIRTUAL_ORIGIN}/`;
    this.instructionsPerTurn = msg.limits.instructionsPerTurn;
    this.storageQuotaBytes = msg.limits.storageQuotaBytes;
    this.idbApart = msg.idbApart === true;
    this.idbQuotaBytes = msg.limits.idbQuotaBytes;

    // Seed localStorage
    for (const [k, v] of Object.entries(msg.initialStorage)) {
      this.localStore.set(k, v);
      this.localStoreBytes += (k.length + v.length) * 2;
    }

    // A canvas of the Worker's own beside each of the app's, where the app's code reads one back at once.
    this.namesReadBack = Object.values(this.textFiles).some((text) => /toDataURL|getImageData/.test(text));
    this.mirrorCanvases = typeof OffscreenCanvas === 'function' && this.namesReadBack;

    // What its IndexedDB databases were kept as.
    for (const [name, text] of Object.entries(msg.initialIdb ?? {})) {
      if (typeof text !== 'string' || !IDB_PART_NAME.test(name)) continue;
      this.idbStore.set(name, text);
      this.idbBytes += (name.length + text.length) * 2;
    }

    // Seed DB from `.xdb` files inside the bundle + persisted host DB records
    this.seedDatabase(msg.initialDbRecords);
    // What the page holds of the app's records already, which its localStorage shares a quota with.
    for (const [name, rows] of Object.entries(msg.initialDbRecords)) {
      const size = JSON.stringify({ [name]: rows }).length * 2;
      this.recordBytesKept = this.bytesAfterSaving(name, size);
      this.savedCollectionBytes.set(name, size);
    }

    try {
      const bindings = await loadZippEngine({
        tier: msg.engineTier,
        runtimeUrl: this.runtimeUrl,
        explicitSource: msg.engineModule,
        fallbackGlueFactory: this.fallbackGlueFactory,
      });

      if (this.disposed) return;
      this.bindings = bindings;

      let engine = new bindings.Engine();
      this.engine = engine;
      this.installBridges(engine);

      // Python project execution path
      const pyScripts = msg.scripts.filter((s) => s.language === 'python');
      if (pyScripts.length > 0 && msg.scripts.every((s) => s.language === 'python')) {
        this.language = 'python';
        engine.setSyncHostCapabilities([]);
        engine.setInstructionBudget(this.instructionsPerTurn);
        const pyFiles: Record<string, string> = {};
        for (const [p, content] of Object.entries(this.textFiles)) {
          if (/\.py$/i.test(p)) pyFiles[p] = content;
        }
        const entry = pyScripts[pyScripts.length - 1];
        // A script written in the page has no file of its own, and the name the page gives it
        // (`index.html.inline-1.py`) is not one Python can import: the engine answered "Python
        // project: no modules" and the app never started. It joins the project under a name
        // that is a module's.
        const entryFile = entry.src ? entry.originPath : '__softn_page__.py';
        pyFiles[entryFile] = entry.code;
        if (engine.initPythonProject) {
          engine.initPythonProject(pyFiles, entryFile, []);
        } else {
          engine.initSource(entry.code, 'python');
        }
        this.drainConsole();
        this.postToHost({ type: 'ready' });
        return;
      }

      this.language = msg.engineTier === 'typescript' ? 'typescript' : 'javascript';

      // Pre-register built-in capability & core runtime module names.
      // Optional hosted vendor libraries (`preact`, `htm`, `marked`, `three`) are NOT
      // pre-registered here so plain JS / Vite apps pay zero VM evaluation cost for unused
      // vendor shims; they are linked on demand by `collectModuleGraph` and `esm.load`.
      for (const builtin of BUILTIN_MODULES) {
        this.definedModules.add(builtin);
      }

      // Pre-link all reachable VFS & inline-supplied vendor ES modules
      const factoryBlocks: string[] = [];
      const namedOnDemand: Array<{ spec: string; from: string }> = [];
      for (const s of msg.scripts) {
        if (s.kind === 'module') {
          const entryUrl = `${VIRTUAL_ORIGIN}/${s.originPath.replace(/^\/+/, '')}`;
          await this.collectModuleGraph(s.code, s.originPath, entryUrl, factoryBlocks, undefined, namedOnDemand);
        }
      }
      // A classic script's import() calls, made the app's modules' (the engine's own refused
      // every module), resolved against its address; the modules it names as text with the rest.
      const classicCode = new Map<ExtractedScript, string>();
      for (const s of msg.scripts) {
        if (s.kind !== 'classic') continue;
        const rewritten = classicImportsRewritten(s.code, `${VIRTUAL_ORIGIN}/${s.originPath.replace(/^\/+/, '')}`);
        classicCode.set(s, rewritten.code);
        for (const spec of rewritten.named) namedOnDemand.push({ spec, from: s.originPath });
      }
      const seedJson = JSON.stringify(msg.seed)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      const prelude = shellPrelude(seedJson);
      // What the program may still take for what is compiled ahead (the parts loaded on demand
      // that could not be compiled later, the app's long script files), in the bytes the engine
      // counts, 16 MiB in all: what is left after the layers, the seed (written twice), and the
      // page's own modules and scripts. (Counted in characters, and without those, a program of
      // an app that started before went past it, and the app did not start.)
      const programBytes =
        fixedProgramBytes() +
        utf8Length(prelude) +
        utf8Length(JSON.stringify(msg.seed.body)) +
        factoryBlocks.reduce((sum, block) => sum + utf8Length(block), 0) +
        msg.scripts.reduce((sum, s) => sum + utf8Length(s.code ?? ''), 0);
      const aheadBytes = Math.max(0, Math.min(MAX_AHEAD_BYTES, MAX_PROGRAM_BYTES - PROGRAM_SLACK_BYTES - programBytes));
      const onDemand = this.collectOnDemand(namedOnDemand, factoryBlocks, aheadBytes);

      // If any reachable module (static or dynamic/on-demand) imports external `'three'`
      // (`softn-vendor:three`) and this Worker has `OffscreenCanvas`, load SoftN's external
      // Native V8 `/runtime/vendor/three.js` into `ThreeWorkerHost` and link `'softn-vendor:three'`
      // backed by Native V8 GPU rendering & raycasting!
      const importsThreeVendor = factoryBlocks.some((block) =>
        /(?:__import|__softnModules\.import)\(\s*["'](?:softn-vendor:)?three["']/.test(block)
      );
      if (importsThreeVendor && typeof OffscreenCanvas === 'function') {
        const [nativeLoaded, threeVendorSource] = await Promise.all([
          this.threeHost.ensureLoaded(this.runtimeUrl),
          this.fetchExternalVendorModuleSource('three'),
        ]);
        if (nativeLoaded && threeVendorSource && !this.disposed) {
          this.mirrorCanvases = true;
          this.externalThreeLoaded = true;
          const transformedThree = transformEsModule(threeVendorSource, 'softn-vendor:three');
          const closingIdx = transformedThree.factoryCode.lastIndexOf('});');
          const patchedFactory =
            closingIdx >= 0
              ? `${transformedThree.factoryCode.slice(0, closingIdx)}\nif (typeof globalThis.__softnPatchThreeNative === 'function') globalThis.__softnPatchThreeNative(__exports);\n});`
              : transformedThree.factoryCode;
          // Replace the lightweight built-in three proxy block if collectModuleGraph already added it.
          const existingIdx = factoryBlocks.findIndex((b) => b.startsWith('__softnModules.define("softn-vendor:three"'));
          if (existingIdx >= 0) {
            factoryBlocks[existingIdx] = patchedFactory;
          } else {
            factoryBlocks.unshift(patchedFactory);
            // Shift `onDemand` indices by +1 because we prepended one block
            const shifted = new Map<number, string>();
            for (const [idx, url] of onDemand) shifted.set(idx + 1, url);
            onDemand.clear();
            for (const [idx, url] of shifted) onDemand.set(idx, url);
          }
        }
      }

      // The app's own script files that a script it adds may name, past what eval compiles while
      // it runs: compiled with the program as functions, each run when a script the app adds names
      // it (a webpack build's parts, a library a loader adds). Not a module, nor one of the page's
      // own scripts, and within what is left of the budget.
      const standbyBlocks: string[] = [];
      const standbyFiles: string[] = [];
      this.standbyScripts.clear();
      this.standbyByText.clear();
      this.standbyRefused.clear();
      {
        let left = aheadBytes;
        for (const index of onDemand.keys()) left -= utf8Length(factoryBlocks[index]);
        const started = new Set(msg.scripts.map((s) => s.originPath));
        for (const [path, text] of Object.entries(this.textFiles)) {
          if (left <= 0) break;
          // One of fewer characters than that is taken by eval whatever it is; one that starts
          // with #! is run by a shell, not added as a script.
          if (text.length < 16_000 || !/\.(?:js|cjs)$/i.test(path) || started.has(path) || this.definedModules.has(`${VIRTUAL_ORIGIN}/${path}`) || text.startsWith('#!')) continue;
          const url = `${VIRTUAL_ORIGIN}/${path}`;
          const code = classicImportsRewritten(text, url).code;
          const size = utf8Length(code);
          if (size > left || !tooLongForEval(scriptForEval(code)) || looksLikeModule(code)) continue;
          const fn = `__softnStandby${standbyBlocks.length}`;
          standbyBlocks.push(classicScriptAsFunction(code, fn).source);
          standbyFiles.push(path);
          this.standbyScripts.set(path, fn);
          this.standbyByText.set(text, fn);
          left -= size;
        }
      }
      // The page's own scripts, for its document: asked for once by the app's side (scripts.placed).
      // Written into the program, the text of a page's templates and data counted against it.
      this.placedScripts = Array.isArray(msg.placed) ? msg.placed : [];

      // Build ordered execution steps for classic & module `<script>` tags.
      //
      // A classic script runs as a script of its own in the page's one global scope, as a
      // browser runs it: by indirect eval, so its `var`s and functions are the page's and the
      // next script can call them. (Each used to be the body of a function of its own, where
      // everything it declared was local: a page with a library in one `<script>` and the code
      // that calls it in the next found nothing defined.) Its `let`, `const` and `class`
      // declarations, which eval keeps to itself, are made the page's too (scriptForEval).
      //
      // A script that throws, or does not parse, says so and the next one still runs.
      const bootSteps: string[] = [];
      const classicBlocks: string[] = [];
      /** Each long classic script's file, by its block. */
      const classicFiles: string[] = [];
      // In the order a browser runs them: the page's scripts as they come, then the deferred
      // ones (a module, a script by its address with defer), in their order.
      const runOrder = [...msg.scripts.filter((s) => !s.defer), ...msg.scripts.filter((s) => s.defer)];
      for (const s of runOrder) {
        if (s.kind === 'classic') {
          // TypeScript is compiled with this program, so a classic TypeScript script stays
          // written into it (text handed to eval at run time would arrive untranslated), with
          // what it declares at its top made the page's.
          let body: string;
          const code = classicCode.get(s) ?? s.code;
          const evaluated = s.language === 'typescript' ? '' : scriptForEval(code);
          if (s.language === 'typescript') {
            body = `\n${typeScriptScriptPublished(code)}\n`;
          } else if (tooLongForEval(evaluated)) {
            // Past what the engine compiles at run time: written into the program as a
            // function, run in its turn, with what it declares at its top made global.
            const fn = `__softnClassic${classicBlocks.length}`;
            const { source, trusted } = classicScriptAsFunction(code, fn);
            classicBlocks.push(source);
            classicFiles.push(s.src ? s.originPath : 'a script in the page');
            body = ` ${fn}.call(globalThis); `;
            if (!trusted) body = ` console.warn('[SoftN] A long script could not be read for the names it declares: what it declares at its top is not global here.');${body}`;
          } else {
            body = ` (0, eval)(${JSON.stringify(evaluated)}); `;
          }
          // Its element is document.currentScript while it runs (webpack finds where its parts are by it).
          bootSteps.push(`__softnBoot = __softnBoot.then(function () { __softnScriptRunning(${Number(s.id)});${body}__softnScriptRunning(null); }).then(undefined, function (err) { __softnScriptRunning(null); __softnScriptFailed(err); });`);
        } else if (s.kind === 'module') {
          const entryUrl = `${VIRTUAL_ORIGIN}/${s.originPath.replace(/^\/+/, '')}`;
          bootSteps.push(
            `__softnBoot = __softnBoot.then(function () { return __softnModules.import(${JSON.stringify(entryUrl)}, ${JSON.stringify(entryUrl)}); }).then(undefined, __softnScriptFailed);`
          );
        }
      }

      // The program, with each long classic script that would not compile written as one
      // that says so in its turn: as a browser runs a page whose script does not parse, the
      // others run. (Written into the program, one that did not parse stopped the whole app.)
      // A part loaded on demand that would not compile is one whose import() fails with why,
      // as it did when it was compiled when it was asked for.
      const program = (broken: ReadonlyMap<string, string>) => {
        const blocks = classicBlocks.map((block, index) =>
          broken.has(`classic:${index}`)
            ? `function __softnClassic${index}() { console.error('[SoftN] Script startup error:', ${JSON.stringify(`${classicFiles[index]}: ${broken.get(`classic:${index}`)}`)}); }`
            : block
        );
        const standby = standbyBlocks.map((block, index) =>
          broken.has(`standby:${index}`)
            ? `function __softnStandby${index}() { throw new SyntaxError(${JSON.stringify(`${standbyFiles[index]}: ${broken.get(`standby:${index}`)}`)}); }`
            : block
        );
        const modules = factoryBlocks.map((block, index) => {
          const url = onDemand.get(index);
          const why = broken.get(`module:${index}`);
          return url !== undefined && why !== undefined
            ? `__softnModules.define(${JSON.stringify(url)}, async function () { throw new SyntaxError(${JSON.stringify(`${url.startsWith(VIRTUAL_ORIGIN + '/') ? url.slice(VIRTUAL_ORIGIN.length + 1) : url}: ${why}`)}); });`
            : block;
        });
        const parts = [
        ESM_REGISTRY_PREAMBLE,
        // Whether a canvas is read back at once, and if not, why not (what the app is told).
        `globalThis.__softnCanvasMirror = ${this.mirrorCanvases ? 'true' : JSON.stringify(this.namesReadBack ? 'this browser has no OffscreenCanvas for the app’s Worker' : 'the app’s code was not seen to name toDataURL or getImageData')};`,
        // Whether the app's crypto.subtle is there: the Worker's own does its work.
        `globalThis.__softnSubtle = ${typeof crypto !== 'undefined' && typeof crypto.subtle === 'object' && crypto.subtle !== null};`,
        `globalThis.__softnInitSessionStorage = ${JSON.stringify(msg.initialSessionStorage ?? {}).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};`,
        prelude,
        GUEST_EXTENSIONS_SOURCE,
        ...(this.externalThreeLoaded ? [GUEST_THREE_NATIVE_SOURCE] : []),
        // After both: `window` becomes the global object, with what each of them put on it.
        GUEST_BROWSER_GLOBALS_SOURCE,
        // Blob, XMLHttpRequest, WebSocket, images, customElements: over what the three above set up.
        GUEST_WEB_APIS_SOURCE,
        // IndexedDB, kept through the Worker's own store.
        GUEST_INDEXEDDB_SOURCE,
        ...modules,
        // What a classic script declares, made the page's (both kinds use it); and the scripts
        // too long for eval, each a function run in its turn below.
        CLASSIC_GLOBALS_HELPER,
        ...blocks,
        // The app's own script files a script it adds may name, compiled as functions.
        ...standby,
        // Top-level entry slots callable via `engine.callFunction(name, args)` in O(1)
        `function __softnContainerTake(failed) { return globalThis.__softnDocTake(failed); }`,
        `function __softnContainerSync(changes) { return globalThis.__softnDocSync(changes); }`,
        // The last argument: a box the code's cancelling unticks is told to the page, which
        // ticked it a thread away and hears the answer too late to hold it back.
        `function __softnContainerEvent(id, type, props) { return globalThis.__softnDocEvent(id, type, props, [], true); }`,
        `function __softnContainerRaf(ts) { return globalThis.__softnRunRaf(ts); }`,
        `function __softnContainerWantsRaf() { return globalThis.__softnWantsRaf(); }`,
        `function __softnContainerIdbChanged(name) { if (typeof globalThis.__softnIdbChanged === 'function') globalThis.__softnIdbChanged(name); }`,
        `function __softnContainerStorage(key, oldValue, newValue) { if (typeof globalThis.__softnStorageChanged === 'function') globalThis.__softnStorageChanged(key, oldValue, newValue); }`,
        `function __softnContainerWorkerMessage(id, packed) { if (typeof globalThis.__softnWorkerFromWorker === 'function') globalThis.__softnWorkerFromWorker(id, packed); }`,
        `function __softnContainerWorkerError(id, message) { if (typeof globalThis.__softnWorkerFailedAt === 'function') globalThis.__softnWorkerFailedAt(id, message); }`,
        `function __softnContainerDbChanged(names) { return globalThis.__softnDbChanged(names); }`,
        `function __softnScriptFailed(err) { console.error('[SoftN] Script startup error:', err && err.stack ? err.stack : String(err)); }`,
        // A warning and an error are one stream to the engine. A warning is written with a
        // mark in front, which drainConsole reads and takes off, so a host hears each as it is.
        WARNINGS_MARKED,
        // The page's own scripts, in its document where they were (inert), and which is running.
        `globalThis.__softnScriptRunning = globalThis.__softnScriptRunning || function () {};`,
        `if (typeof globalThis.__softnPlaceScripts === 'function') globalThis.__softnPlaceScripts(host.callSync('scripts.placed'));`,
        `var __softnBoot = Promise.resolve();`,
        ...bootSteps,
        `__softnBoot.then(function () { globalThis.__softnDocReady(); }, function (err) { __softnScriptFailed(err); globalThis.__softnDocReady(); });`,
        ];
        // The lines each block that may be stood in for is on, as the engine counts them in what it reports.
        const firstModule = modules.length > 0 ? parts.indexOf(modules[0]) : -1;
        const firstBlock = blocks.length > 0 ? parts.indexOf(blocks[0]) : -1;
        const firstStandby = standby.length > 0 ? parts.indexOf(standby[0]) : -1;
        const lines: Array<{ key: string; from: number; to: number }> = [];
        let line = 1;
        parts.forEach((part, index) => {
          const end = line + lineBreaks(part);
          if (firstBlock >= 0 && index >= firstBlock && index < firstBlock + blocks.length) lines.push({ key: `classic:${index - firstBlock}`, from: line, to: end });
          if (firstStandby >= 0 && index >= firstStandby && index < firstStandby + standby.length) lines.push({ key: `standby:${index - firstStandby}`, from: line, to: end });
          if (firstModule >= 0 && index >= firstModule && index < firstModule + modules.length && onDemand.has(index - firstModule)) lines.push({ key: `module:${index - firstModule}`, from: line, to: end });
          line = end + 1;
        });
        return { source: parts.join('\n'), lines };
      };

      // What is compiled ahead let go of, all of it or the app's long script files: each is then
      // compiled when asked for, or refused in words (one that did not compile says why).
      const dropAhead = (modulesToo: boolean) => {
        standbyBlocks.length = 0;
        standbyFiles.length = 0;
        this.standbyScripts.clear();
        this.standbyByText.clear();
        if (modulesToo) {
          for (const [index, url] of [...onDemand].sort((a, b) => b[0] - a[0])) {
            factoryBlocks.splice(index, 1);
            this.definedModules.delete(url);
          }
          onDemand.clear();
        }
      };
      const broken = new Map<string, string>();
      let standbyFailures = 0;
      for (;;) {
        const { source, lines } = program(broken);
        engine.setSyncHostCapabilities([...DB_SYNC_OPS, ...LS_SYNC_OPS, ...APP_SYNC_OPS]);
        engine.setInstructionBudget(this.instructionsPerTurn);
        try {
          engine.initSource(source, this.language);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const at = /:(\d+):\d+/.exec(message);
          const failed = at ? lines.find(({ from, to }) => Number(at[1]) >= from && Number(at[1]) <= to)?.key : undefined;
          if (failed === undefined && /exceeds the \d+-byte limit/.test(message) && (standbyBlocks.length > 0 || onDemand.size > 0) && !this.disposed) {
            // Past what the engine takes at the start all the same: again without what is compiled ahead.
            dropAhead(true);
            for (const key of [...broken.keys()]) if (key.startsWith('module:') || key.startsWith('standby:')) broken.delete(key);
          } else if (failed !== undefined && failed.startsWith('standby:') && !broken.has(failed) && !this.disposed) {
            // One of the app's long script files that does not compile (JSX, top-level await): a
            // stand-in that says why, for a few of them; past that all of them are let go of at
            // once, a compile again for each costing more than they are worth.
            const file = standbyFiles[Number(failed.slice('standby:'.length))];
            if (file !== undefined) this.standbyRefused.set(file, message.split('\n')[0]);
            if (++standbyFailures <= MAX_STANDBY_FAILURES) broken.set(failed, message.split('\n')[0]);
            else dropAhead(false);
          } else {
            if (failed === undefined || broken.has(failed) || this.disposed) throw err;
            broken.set(failed, message.split('\n')[0]);
          }
          // An engine that could not compile its program has stopped: a new one, set up as this one was.
          engine = new bindings.Engine();
          this.engine = engine;
          this.installBridges(engine);
        }
      }

      this.drainTurn();
      this.postToHost({ type: 'ready' });
    } catch (err) {
      this.drainFailedConsole();
      const message = err instanceof Error ? err.message : String(err);
      this.postToHost({ type: 'error', message, phase: 'init', fatal: true });
    }
  }

  /**
   * Compile a module and the modules it imports, each once: their registrations go into
   * `outBlocks`, dependencies first. `collected` is told each module it took, and `named`
   * each `import()` that names its module as text, with the file it is in.
   */
  private transformModuleByPath(code: string, filePath: string, moduleUrl: string): ReturnType<typeof transformEsModule> {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.css')) {
      const safeCss = JSON.stringify(code);
      const isCssModule = lower.endsWith('.module.css');
      let classMapLiteral = '{}';
      if (isCssModule) {
        const names: Record<string, string> = {};
        const re = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) names[m[1]] = m[1];
        classMapLiteral = JSON.stringify(names);
      }
      const factoryCode = `__softnModules.define(${JSON.stringify(moduleUrl)}, async function (__exports) {
  if (typeof document !== 'undefined') {
    var __s = document.createElement('style');
    __s.textContent = ${safeCss};
    (document.head || document.documentElement).appendChild(__s);
  }
  __exports.default = ${classMapLiteral};
});`;
      return { factoryCode, staticImports: [], dynamicImports: [] };
    }
    if (lower.endsWith('.json')) {
      let parsedJson = 'null';
      try {
        parsedJson = JSON.stringify(JSON.parse(code));
      } catch {
        parsedJson = JSON.stringify(code);
      }
      const factoryCode = `__softnModules.define(${JSON.stringify(moduleUrl)}, async function (__exports) {
  __exports.default = ${parsedJson};
});`;
      return { factoryCode, staticImports: [], dynamicImports: [] };
    }
    const isCompiledSidecar = code !== this.textFiles[filePath];
    const source = !isCompiledSidecar && /\.(?:tsx|jsx)$/i.test(lower) ? transformJsx(code) : code;
    return transformEsModule(source, moduleUrl);
  }

  private async collectModuleGraph(
    code: string,
    filePath: string,
    moduleUrl: string,
    outBlocks: string[],
    collected?: string[],
    named?: Array<{ spec: string; from: string }>,
    defined: Set<string> = this.definedModules
  ): Promise<void> {
    if (defined.has(moduleUrl)) return;
    defined.add(moduleUrl);
    collected?.push(moduleUrl);

    const { factoryCode, staticImports, dynamicImports } = this.transformModuleByPath(code, filePath, moduleUrl);
    if (named) for (const spec of dynamicImports) named.push({ spec, from: filePath });

    for (const spec of staticImports) {
      const resolved = resolveModuleSpecifier(spec, filePath, this.importMap, (p) => p in this.textFiles);
      if (resolved.kind === 'vfs' && !defined.has(resolved.url)) {
        const depCode = readRunnableModule(resolved.path, (path) => this.textFiles[path]);
        if (depCode !== null) {
          await this.collectModuleGraph(depCode, resolved.path, resolved.url, outBlocks, collected, named, defined);
        }
      } else if (resolved.kind === 'vendor' && !defined.has(resolved.url)) {
        const vendorSource = await this.fetchVendorModuleSource(resolved.name);
        if (vendorSource !== null) {
          await this.collectModuleGraph(vendorSource, `vendor/${resolved.name}.js`, resolved.url, outBlocks, collected, named, defined);
        }
      }
    }

    outBlocks.push(factoryCode);
  }

  /**
   * The parts of the app loaded on demand that cannot be compiled when they are asked for,
   * compiled with the program now: each part past what the engine compiles at once while the
   * app runs (64 KB), and, in a TypeScript app, every part (types are read only in the
   * program compiled at the start; a part compiled later was read as JavaScript, and did not
   * load). Found through each `import()` that names its module as text, from the program's
   * own modules on, and held to a budget of the program's size.
   */
  private collectOnDemand(named: Array<{ spec: string; from: string }>, outBlocks: string[], budget: number, defined: Set<string> = this.definedModules): Map<number, string> {
    // Which of the blocks are these parts, by their place among the blocks: each one's address.
    const added = new Map<number, string>();
    const seen = new Set<string>();
    const queue = named.slice();
    let left = budget;
    while (queue.length > 0) {
      const { spec, from } = queue.shift()!;
      const resolved = resolveModuleSpecifier(spec, from, this.importMap, (p) => p in this.textFiles);
      if (resolved.kind !== 'vfs' || seen.has(resolved.url)) continue;
      seen.add(resolved.url);
      const code = readRunnableModule(resolved.path, (path) => this.textFiles[path]);
      if (code === null) continue;
      const { factoryCode, staticImports, dynamicImports } = this.transformModuleByPath(code, resolved.path, resolved.url);
      // What it imports is loaded on demand with it: looked through too.
      for (const next of [...staticImports, ...dynamicImports]) queue.push({ spec: next, from: resolved.path });
      if (defined.has(resolved.url)) continue;
      const size = utf8Length(factoryCode);
      const now = this.language === 'typescript' || size > MAX_RUNTIME_MODULE_BYTES;
      if (!now || size > left) continue;
      defined.add(resolved.url);
      added.set(outBlocks.length, resolved.url);
      outBlocks.push(factoryCode);
      left -= size;
    }
    return added;
  }

  /**
   * The answer to a module asked for while the app runs: the registrations to compile, each
   * held to what the engine compiles at once then. One past that is refused in words, and
   * the modules taken for it are let go, so that asking again is refused the same way.
   */
  private moduleReply(url: string, blocks: string[], collected: string[], kind: 'vfs' | 'vendor' | 'remote', defined: Set<string> = this.definedModules): { url: string; blocks: string[]; urls: string[] } | { error: string } {
    for (const block of blocks) {
      const bytes = utf8Length(block);
      if (bytes <= MAX_RUNTIME_MODULE_BYTES) continue;
      for (const taken of collected) defined.delete(taken);
      const name = url.startsWith(VIRTUAL_ORIGIN + '/') ? url.slice(VIRTUAL_ORIGIN.length + 1) : url.replace(/^softn-vendor:/, '');
      const size = `${Math.ceil(bytes / 1024)} KB`;
      return {
        error:
          kind === 'vfs'
            ? `A part of the app (${name}, ${size}) was asked for while it runs, and is more than the engine compiles at once then (64 KB). A part named in an import() written as text ("import('./part.js')") is compiled when the app starts; this one was named some other way.`
            : `A module (${name}, ${size}) was asked for while the app runs, and is more than the engine compiles at once then (64 KB). One imported at the top of a module ("import ... from '${name}'") is compiled when the app starts.`,
      };
    }
    // The modules taken for it, for the app's side to say if it could not compile them.
    return { url, blocks, urls: collected };
  }

  private async fetchExternalVendorModuleSource(name: string): Promise<string | null> {
    if (Object.prototype.hasOwnProperty.call(this.vendorModules, name)) {
      const given = this.vendorModules[name];
      return typeof given === 'string' ? given : null;
    }
    if (!safeVendorName(name)) return null;
    const base = this.runtimeUrl.replace(/\/?$/, '/');
    try {
      const resp = await fetch(`${base}vendor/${name}.js`, { credentials: 'omit', redirect: 'error' });
      if (resp.ok) return await resp.text();
    } catch {
      // Vendor file not hosted externally
    }
    return null;
  }

  private async fetchVendorModuleSource(name: string): Promise<string | null> {
    // The host's own copy, by its own name (not one the object has from Object.prototype).
    if (Object.prototype.hasOwnProperty.call(this.vendorModules, name)) {
      const given = this.vendorModules[name];
      return typeof given === 'string' ? given : null;
    }
    // Built-in on-demand vendor shims (marked, preact, htm, three proxy) — zero VM cost unless imported.
    if (Object.prototype.hasOwnProperty.call(BUILTIN_VENDOR_MODULES, name)) {
      return BUILTIN_VENDOR_MODULES[name];
    }
    return this.fetchExternalVendorModuleSource(name);
  }

  private handleEvent(
    turnId: number,
    nodeId: number,
    eventType: string,
    props: Record<string, unknown>,
    syncChanges?: unknown[]
  ): void {
    if (!this.engine || this.language === 'python') return;
    try {
      this.engine.renewInstructionBudget();
      if (syncChanges && syncChanges.length > 0) {
        this.callGuest('__softnContainerSync', [syncChanges]);
      }
      const bitsRaw = this.callGuest('__softnContainerEvent', [nodeId, eventType, props]);
      const eventBits = typeof bitsRaw === 'number' ? bitsRaw : 0;
      this.drainTurn(turnId, eventBits);
    } catch (err) {
      this.reportGuestError('event', err);
    }
  }

  /**
   * Run what the page sent in the order it came. An image's load waits, at most a second, for
   * the Worker to decode the picture for its copies of the app's canvases: an app drawing the
   * picture in its load handler and reading the canvas back at once had a copy without it.
   * What came after it waits behind it.
   */
  private queueTurn(run: () => void, waitFor: Promise<void> | null): void {
    if (!waitFor && !this.holding && this.turnsWaiting.length === 0) {
      run();
      return;
    }
    this.turnsWaiting.push({ run, waitFor });
    this.pumpTurns();
  }

  private pumpTurns(): void {
    while (!this.holding && this.turnsWaiting.length > 0 && !this.disposed) {
      const next = this.turnsWaiting[0];
      if (next.waitFor) {
        const waitFor = next.waitFor;
        next.waitFor = null;
        const now = performance.now();
        if (now - this.holdWindowStart > HOLD_WINDOW_MS) {
          this.holdWindowStart = now;
          this.heldInWindow = 0;
        }
        const allowance = Math.min(MAX_PICTURE_WAIT_MS, MAX_HELD_IN_WINDOW_MS - this.heldInWindow);
        // Held long enough lately: this one goes now (a read-back may lack its picture, and says so).
        if (allowance <= 0) continue;
        // Each hold its own: a late answer to one ended before does not end the next.
        const hold = ++this.holdSeq;
        this.holding = hold;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const go = () => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (this.holding !== hold) return;
          this.holding = 0;
          this.heldInWindow += performance.now() - now;
          this.pumpTurns();
        };
        timer = setTimeout(go, allowance);
        waitFor.then(go, go);
        return;
      }
      this.turnsWaiting.shift();
      next.run();
    }
  }

  /** The decoding an event of the page's is about, when the Worker is decoding that picture: an image's load, on the page or apart. */
  private pictureLoading(eventType: string, nodeId: number, props: Record<string, unknown> | undefined): Promise<void> | null {
    if (!this.mirrorCanvases) return null;
    if (eventType === 'load' && nodeId >= 0) return this.mirrorPictures.get(`node:${nodeId}`)?.decoding ?? null;
    if (eventType === 'softn:image' && typeof props?.src === 'string') {
      for (const picture of this.mirrorPictures.values()) if (picture.src === props.src && picture.decoding) return picture.decoding;
    }
    return null;
  }

  /**
   * Parts of the app's IndexedDB as kept now, taken in together: every value first, then the
   * app's side is told of each, in one turn. (Told a part at a time, with a turn of the app's
   * between, a read could take a page in with the list of pages from before it.)
   */
  private takeIdbParts(parts: unknown): void {
    if (!parts || typeof parts !== 'object') return;
    const names: string[] = [];
    for (const [name, value] of Object.entries(parts as Record<string, unknown>)) {
      if (!IDB_PART_NAME.test(name) || (value !== null && typeof value !== 'string')) continue;
      const before = this.idbStore.get(name);
      this.idbBytes += (value === null ? 0 : (name.length + value.length) * 2) - (before === undefined ? 0 : (name.length + before.length) * 2);
      if (value === null) this.idbStore.delete(name);
      else this.idbStore.set(name, value);
      names.push(name);
    }
    if (names.length === 0 || !this.engine || this.disposed || this.language === 'python') return;
    try {
      this.engine.renewInstructionBudget();
      for (const name of names) this.callGuest('__softnContainerIdbChanged', [name]);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('storage', err);
    }
  }

  /** What another tab kept for the same app: this copy and its count follow, and the app's IndexedDB reads that part again. */
  private storageChanged(area: 'ls' | 'idb', key: string, value: string | null): void {
    if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) return;
    const kept = area === 'ls' ? this.localStore : this.idbStore;
    const before = kept.get(key);
    const delta = (value === null ? 0 : (key.length + value.length) * 2) - (before === undefined ? 0 : (key.length + before.length) * 2);
    if (value === null) kept.delete(key);
    else kept.set(key, value);
    if (area === 'ls') this.localStoreBytes += delta;
    else this.idbBytes += delta;
    if (!this.engine || this.disposed || this.language === 'python') return;
    // localStorage changed elsewhere is heard as a browser hears it: a storage event at the
    // window (an app signs out in every tab, or follows a setting changed in another).
    if (area === 'ls' && (before ?? null) === value) return;
    try {
      this.engine.renewInstructionBudget();
      if (area === 'idb') this.callGuest('__softnContainerIdbChanged', [key]);
      else this.callGuest('__softnContainerStorage', [key, before ?? null, value]);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('storage', err);
    }
  }

  private handleSync(changes: unknown[]): void {
    if (!this.engine || this.language === 'python' || changes.length === 0) return;
    try {
      this.engine.renewInstructionBudget();
      this.callGuest('__softnContainerSync', [changes]);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('sync', err);
    }
  }

  /**
   * The app is shown again: the timers that came due while it was not are run, in the order
   * they were set. A repeating timer is armed again by its own turn, so one that ran every
   * 16 ms for an hour unseen runs once here, not 225,000 times.
   */
  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const held = [...this.heldTimers.values()];
    this.heldTimers.clear();
    for (const callId of held) {
      if (this.disposed || this.paused) break;
      this.resolveCallbackAndFlush(callId, { ok: true });
    }
    // What arrived on its sockets while it was not shown.
    for (const id of [...this.sockets.keys()]) this.pumpSocket(id);
  }

  private handleRaf(timestamp: number): void {
    if (!this.engine || this.language === 'python') return;
    try {
      this.engine.renewInstructionBudget();
      this.callGuest('__softnContainerRaf', [timestamp]);
      this.drainTurn(undefined, undefined, true);
    } catch (err) {
      this.reportGuestError('raf', err);
    }
  }

  private callGuest(fnName: string, args: unknown[]): unknown {
    if (!this.engine) return undefined;
    if (typeof this.engine.callFunction === 'function') {
      return this.engine.callFunction(fnName, args);
    }
    const argJson = args.map((a) => JSON.stringify(a)).join(', ');
    return this.engine.evalInContext(`${fnName}(${argJson})`);
  }

  private drainTurn(turnId?: number, eventBits?: number, rafReply = false): void {
    if (!this.engine || this.disposed) return;
    // Inside a drain (an answer given at once to a call it is carrying out): the drain under way
    // runs the app's next turn once it has carried out the calls made before it. (A drain of its
    // own here carried out the calls that answer's callback made first, ahead of those made
    // before them, so messages went out of order, and each such answer went a level deeper.)
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    const began = performance.now();
    try {
      do {
        this.drainAgain = false;
        this.engine.pump();
        this.drainConsole();
        this.drainPendingHostCalls();
        if (this.disposed || !this.engine) return;
      } while (this.drainAgain && performance.now() - began < MAX_DRAIN_MS);
    } finally {
      this.draining = false;
    }
    // An app that keeps asking what is answered at once: the rest in a task of its own, so
    // that what the page sends is heard between.
    if (this.drainAgain) {
      this.drainAgain = false;
      this.postTask(() => this.drainTurn());
    }

    // Drain paged ShellOp batches
    const allOps: ShellOp[] = [];
    for (;;) {
      const page = this.callGuest('__softnContainerTake', [false]);
      if (!Array.isArray(page) || page.length === 0) break;
      allOps.push(...(page as ShellOp[]));
    }

    if (this.mirrorCanvases) this.mirrorOps(allOps);

    const wantsRaf = Boolean(this.callGuest('__softnContainerWantsRaf', []));

    if (allOps.length > 0 || turnId !== undefined || wantsRaf || rafReply) {
      this.postToHost({
        type: 'ops',
        ops: allOps,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(eventBits !== undefined ? { eventBits } : {}),
        ...(wantsRaf ? { wantsRaf: true } : {}),
        ...(rafReply ? { rafReply: true } : {}),
      });
    }
    if (this.webglHost.hasActiveContexts()) {
      for (const frame of this.webglHost.takeDirtyFrames()) {
        this.postToHost(
          {
            type: 'webgl-frame',
            canvasId: frame.canvasId,
            bitmap: frame.bitmap,
            width: frame.width,
            height: frame.height,
          },
          [frame.bitmap]
        );
      }
    }
    if (this.threeHost.hasActiveRenderers()) {
      for (const frame of this.threeHost.takeDirtyFrames()) {
        this.postToHost(
          {
            type: 'webgl-frame',
            canvasId: frame.canvasId,
            bitmap: frame.bitmap,
            width: frame.width,
            height: frame.height,
          },
          [frame.bitmap]
        );
      }
    }
  }

  private drainPendingHostCalls(): void {
    if (!this.engine || this.disposed) return;
    const pending = this.engine.drainPendingHostCalls();
    for (const req of pending) {
      void this.fulfillHostCall(req.id, req.kind, req.args);
    }
  }

  private async fulfillHostCall(callId: number, kind: string, args: string[]): Promise<void> {
    if (this.disposed || !this.engine) return;

    switch (kind) {
      case 'backend.call':
        this.postToHost({ type: 'host-request', requestId: callId, kind, payload: { action: args[0], input: args[1] } });
        return;

      case 'timer.set': {
        const timerId = Number(args[0]);
        const delayMs = Math.max(0, Math.min(Number(args[1]) || 0, 86_400_000));
        const handle = setTimeout(() => {
          this.timers.delete(timerId);
          // Due while the app is not shown: kept, and run when it is shown again.
          if (this.paused) this.heldTimers.set(timerId, callId);
          else this.resolveCallbackAndFlush(callId, { ok: true });
        }, delayMs);
        this.timers.set(timerId, handle);
        return;
      }

      case 'timer.clear': {
        const timerId = Number(args[0]);
        const existing = this.timers.get(timerId);
        if (existing) {
          clearTimeout(existing);
          this.timers.delete(timerId);
        }
        this.heldTimers.delete(timerId);
        return;
      }

      case 'bundle.read': {
        const rawUrl = args[0] ?? '';
        const vfs = resolveVfsPath(rawUrl);
        if (vfs && vfs in this.textFiles) {
          this.resolveCallbackAndFlush(callId, {
            ok: true,
            status: 200,
            headers: { 'content-type': mimeTypeFor(vfs) },
            body: this.textFiles[vfs],
          });
        } else {
          this.resolveCallbackAndFlush(callId, {
            ok: false,
            status: 404,
            error: `Not found in bundle: ${rawUrl}`,
          });
        }
        return;
      }

      case 'esm.load': {
        // Asked by a Worker of the app's: against the modules its engine has.
        const defined = this.workerCalls.get(callId)?.worker.defined ?? this.definedModules;
        const specifier = args[0] ?? '';
        const importerUrl = args[1] ?? '';
        const importerPath = importerUrl.startsWith(VIRTUAL_ORIGIN + '/')
          ? importerUrl.slice(VIRTUAL_ORIGIN.length + 1)
          : 'index.html';
        const resolved = resolveModuleSpecifier(
          specifier,
          importerPath,
          this.importMap,
          (p) => p in this.textFiles
        );

        try {
          if (resolved.kind === 'builtin' && defined.has(resolved.url)) {
            this.resolveCallbackAndFlush(callId, { url: resolved.url });
            return;
          }
          // The registrations go to the app's side, which compiles each with its own eval:
          // compiled here (evalInContext) they were one compilation of 64 KB at most for a
          // whole graph, out of 256 calls and 1 MB the engine allows that path in an app's life.
          if (resolved.kind === 'vfs') {
            const blocks: string[] = [];
            const collected: string[] = [];
            const src = readRunnableModule(resolved.path, (path) => this.textFiles[path]);
            if (src === null) throw new Error(`Module not found in container: ${resolved.path}`);
            await this.collectModuleGraph(src, resolved.path, resolved.url, blocks, collected, undefined, defined);
            this.resolveCallbackAndFlush(callId, this.moduleReply(resolved.url, blocks, collected, 'vfs', defined));
            return;
          }
          if (resolved.kind === 'vendor') {
            const blocks: string[] = [];
            const collected: string[] = [];
            if (!defined.has(resolved.url)) {
              const vendorSrc = await this.fetchVendorModuleSource(resolved.name);
              if (vendorSrc === null) {
                throw new Error(`Hosted vendor library "${resolved.name}" is not available`);
              }
              await this.collectModuleGraph(vendorSrc, `vendor/${resolved.name}.js`, resolved.url, blocks, collected, undefined, defined);
            }
            this.resolveCallbackAndFlush(callId, this.moduleReply(resolved.url, blocks, collected, 'vendor', defined));
            return;
          }
          if (resolved.kind === 'remote') {
            if (
              !isExternalUrlAllowed(
                resolved.url,
                this.permissions.permissions?.net,
                this.grantedCapabilities.has('net')
              )
            ) {
              throw new Error(`Remote module import denied by net permission: ${resolved.url}`);
            }
            const blocks: string[] = [];
            const collected: string[] = [];
            if (!defined.has(resolved.url)) {
              // No redirects, as for the app's own fetches: a host the app was granted could
              // answer with a redirect to one it was not, whose script would then be run.
              const resp = await fetch(resolved.url, { credentials: 'omit', redirect: 'error', cache: cacheModeFor(resolved.url, undefined) });
              if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${resolved.url}`);
              const remoteSrc = await resp.text();
              await this.collectModuleGraph(remoteSrc, 'index.html', resolved.url, blocks, collected, undefined, defined);
            }
            this.resolveCallbackAndFlush(callId, this.moduleReply(resolved.url, blocks, collected, 'remote', defined));
            return;
          }
          // A built-in module there is none of ('softn:' and a name no engine defines): refused
          // in words, where the import waited for good.
          throw new Error(`There is no module ${specifier} here`);
        } catch (err) {
          this.resolveCallbackAndFlush(callId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'script.load': {
        // A script the app added to its page, by its address: its code made ready to run, the
        // name it was compiled with (a file of the app's too long for eval), or why not.
        try {
          this.resolveCallbackAndFlush(callId, await this.loadScript(args[0] ?? ''));
        } catch (err) {
          this.resolveCallbackAndFlush(callId, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      case 'esm.inline': {
        // A module script of text the app added: a module of the page's, at an address of its own beside the page.
        const page = args[1] ?? '';
        const pagePath = (page.startsWith(VIRTUAL_ORIGIN + '/') ? page.slice(VIRTUAL_ORIGIN.length + 1).split(/[?#]/)[0] : '') || 'index.html';
        const url = `${VIRTUAL_ORIGIN}/${pagePath}.added-${++this.addedModules}.js`;
        try {
          const blocks: string[] = [];
          const collected: string[] = [];
          await this.collectModuleGraph(args[0] ?? '', pagePath, url, blocks, collected);
          this.resolveCallbackAndFlush(callId, this.moduleReply(url, blocks, collected, 'vfs'));
        } catch (err) {
          this.resolveCallbackAndFlush(callId, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      case 'net.fetch': {
        const url = args[0] ?? '';
        const rawOpts = args[1] ? (JSON.parse(args[1]) as RequestInit & StreamRequest) : {};
        const backendTarget = matchBackendTarget(url, this.backendRouting, {
          baseUrl: this.pageBaseUrl,
          method: rawOpts.method ?? 'GET',
          isStaticVfsFile: (p) => p in this.textFiles || p in this.binaryFiles,
        });
        if (backendTarget) {
          try {
            const headersObj: Record<string, string> = {};
            if (rawOpts.headers && typeof rawOpts.headers === 'object') {
              for (const [k, v] of Object.entries(rawOpts.headers as Record<string, string>)) {
                headersObj[k] = String(v);
              }
            }
            const bodyBase64 = await this.encodeRequestBodyBase64(rawOpts);
            const reply = (await this.requestHost('backend.fetch', {
              method: rawOpts.method ?? 'GET',
              path: backendTarget.path,
              query: backendTarget.query,
              headers: headersObj,
              bodyBase64,
            })) as {
              ok: boolean;
              status: number;
              statusText: string;
              headers: Record<string, string>;
              base64: string;
            };
            this.resolveCallbackAndFlush(callId, reply);
          } catch (err) {
            this.resolveCallbackAndFlush(callId, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        if (
          !isExternalUrlAllowed(
            url,
            this.permissions.permissions?.net,
            this.grantedCapabilities.has('net')
          )
        ) {
          this.resolveCallbackAndFlush(callId, {
            error: `Network access to ${url} is not permitted by this container`,
          });
          return;
        }
        try {
          // A body of bytes (a blob, a form with a file in it) comes as base64: the bridge carries text.
          const resp = await fetch(url, {
            method: rawOpts.method ?? 'GET',
            headers: rawOpts.headers,
            body: requestBody(rawOpts as StreamRequest),
            cache: cacheModeFor(url, undefined),
            credentials: 'omit',
            redirect: 'error',
          });
          const headersObj: Record<string, string> = {};
          resp.headers.forEach((v, k) => {
            headersObj[k] = v;
          });
          const bytes = new Uint8Array(await resp.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          this.resolveCallbackAndFlush(callId, {
            ok: resp.ok,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersObj,
            base64: btoa(bin),
          });
        } catch (err) {
          this.resolveCallbackAndFlush(callId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case 'stream.open': {
        const id = args[0] ?? '';
        const url = args[1] ?? '';
        let opts: StreamRequest = {};
        try {
          const parsed: unknown = JSON.parse(args[2] ?? '{}');
          if (parsed && typeof parsed === 'object') opts = parsed as StreamRequest;
        } catch {
          opts = {};
        }
        // A body that came ahead in pieces is this request's, whatever becomes of the request:
        // let go of here first, so a request that is refused takes its body with it.
        const body = typeof opts.bodyId === 'string' ? this.bodies.get(opts.bodyId) : undefined;
        if (typeof opts.bodyId === 'string') this.bodies.delete(opts.bodyId);
        const backendTarget = matchBackendTarget(url, this.backendRouting, {
          baseUrl: this.pageBaseUrl,
          method: opts.method ?? 'GET',
          isStaticVfsFile: (p) => p in this.textFiles || p in this.binaryFiles,
        });
        if (!backendTarget && !isExternalUrlAllowed(url, this.permissions.permissions?.net, this.grantedCapabilities.has('net'))) {
          this.resolveCallbackAndFlush(callId, { error: `Network access to ${url} is not permitted by this container`, denied: true });
          return;
        }
        let sent: BodyInit | undefined;
        if (typeof opts.bodyId === 'string') {
          if (!body || body.bytes < 0) {
            this.resolveCallbackAndFlush(callId, { error: 'The body of this request is larger than a container sends' });
            return;
          }
          // Words that came in several pieces are one text again before they are made bytes.
          const parts: Array<string | Uint8Array> = [];
          for (const part of body.parts) {
            const last = parts.length - 1;
            if (typeof part === 'string' && typeof parts[last] === 'string') parts[last] = (parts[last] as string) + part;
            else parts.push(part);
          }
          sent = new Blob(parts as BlobPart[]);
        }
        if (this.streams.has(id) || this.streams.size >= MAX_STREAMS) {
          this.resolveCallbackAndFlush(callId, { error: `This container has ${MAX_STREAMS} requests open already` });
          return;
        }
        const stream: OpenStream = { events: [], bytes: 0, waiting: null, over: false, abort: new AbortController(), drained: null };
        this.streams.set(id, stream);
        this.resolveCallbackAndFlush(callId, { ok: true });
        if (backendTarget) {
          void this.readBackendStream(id, stream, backendTarget, opts, sent);
        } else {
          void this.readStream(id, stream, url, opts, sent);
        }
        return;
      }

      case 'stream.body': {
        // Allow buffered request bodies when either embedded backend routing OR net capability is enabled.
        if (!this.backendRouting?.enabled && (!this.permissions.permissions?.net?.enabled || !this.grantedCapabilities.has('net'))) return;
        const id = args[0] ?? '';
        let body = this.bodies.get(id);
        if (!body) {
          if (this.bodies.size >= MAX_PENDING_BODIES) return;
          body = { parts: [], bytes: 0 };
          this.bodies.set(id, body);
        }
        if (body.bytes < 0) return;
        try {
          const part = bodyPiece(JSON.parse(args[1] ?? '{}') as BodyPiece | null);
          const size = typeof part === 'string' ? part.length * 2 : part.byteLength;
          let pending = 0;
          for (const other of this.bodies.values()) if (other.bytes > 0) pending += other.bytes;
          if (body.bytes + size > MAX_BODY_BYTES || pending + size > MAX_PENDING_BODY_BYTES) throw new Error('too large');
          body.parts.push(part);
          body.bytes += size;
        } catch {
          // Past what is sent, or not what a piece is: the request it belongs to is refused.
          body.parts = [];
          body.bytes = -1;
        }
        return;
      }

      case 'stream.next': {
        const id = args[0] ?? '';
        const stream = this.streams.get(id);
        if (!stream) {
          this.resolveCallbackAndFlush(callId, { error: 'No such request' });
          return;
        }
        stream.waiting = callId;
        this.pumpStream(id);
        return;
      }

      case 'stream.close': {
        const stream = this.streams.get(args[0] ?? '');
        if (!stream) return;
        stream.over = true;
        this.streams.delete(args[0] ?? '');
        stream.abort.abort();
        stream.drained?.();
        // What the app was waiting on is answered, with nothing: it is not left waiting for good.
        if (stream.waiting !== null) {
          const waiting = stream.waiting;
          stream.waiting = null;
          this.resolveCallbackAndFlush(waiting, { events: [] });
        }
        return;
      }

      case 'ws.open': {
        const id = args[0] ?? '';
        const url = args[1] ?? '';
        let protocols: string[] = [];
        try {
          const parsed: unknown = JSON.parse(args[2] ?? '[]');
          if (Array.isArray(parsed)) protocols = parsed.filter((p): p is string => typeof p === 'string').slice(0, 16);
        } catch {
          protocols = [];
        }
        // The rule a request is held to: the network granted, and a host the app declared.
        // A socket's scheme is read as the page scheme it is carried over (wss as https).
        const asPage = /^wss:/i.test(url) ? `https:${url.slice(4)}` : /^ws:/i.test(url) ? `http:${url.slice(3)}` : '';
        const wsBackendTarget = matchBackendTarget(url, this.backendRouting, {
          baseUrl: this.pageBaseUrl,
          method: 'GET',
        });
        if (wsBackendTarget) {
          if (this.sockets.has(id) || this.sockets.size >= MAX_SOCKETS) {
            this.resolveCallbackAndFlush(callId, { error: `This container has ${MAX_SOCKETS} sockets open already` });
            return;
          }
          // Full-duplex backend WebSocket bridged through Host -> BackendTransport.openWebSocket
          const virtualWsState = {
            readyState: 0,
            protocol: protocols[0] ?? '',
            extensions: '',
            send: (payload: string | Uint8Array) => {
              if (virtualWsState.readyState !== 1) return;
              const isBin = payload instanceof Uint8Array;
              void this.requestHost('backend.ws.send', {
                id,
                data: isBin ? bytesToBase64(payload) : String(payload),
                binary: isBin,
              }).catch(() => undefined);
            },
            close: (code = 1000, reason = '') => {
              if (virtualWsState.readyState === 3) return;
              virtualWsState.readyState = 3;
              void this.requestHost('backend.ws.close', { id, code, reason }).catch(() => undefined);
              if (!socket.over) {
                socket.events.push({ t: 'close', code, reason, wasClean: true });
                socket.over = true;
                this.pumpSocket(id);
              }
            },
          };
          const virtualWs = virtualWsState as unknown as WebSocket;
          const socket: OpenSocket = {
            ws: virtualWs,
            events: [],
            bytes: 0,
            waiting: null,
            over: false,
          };
          this.sockets.set(id, socket);
          const wsPath = wsBackendTarget.query
            ? `${wsBackendTarget.path}?${wsBackendTarget.query}`
            : wsBackendTarget.path;
          void this.requestHost('backend.ws.open', { id, path: wsPath, protocols }).catch((err) => {
            if (socket.over) return;
            virtualWsState.readyState = 3;
            socket.events.push({ t: 'error' });
            socket.events.push({
              t: 'close',
              code: 1006,
              reason: err instanceof Error ? err.message : String(err),
              wasClean: false,
            });
            socket.over = true;
            this.pumpSocket(id);
          });
          this.resolveCallbackAndFlush(callId, { ok: true });
          return;
        }
        if (!asPage || !isExternalUrlAllowed(asPage, this.permissions.permissions?.net, this.grantedCapabilities.has('net'))) {
          this.resolveCallbackAndFlush(callId, { error: `Network access to ${url} is not permitted by this container` });
          return;
        }
        if (this.sockets.has(id) || this.sockets.size >= MAX_SOCKETS) {
          this.resolveCallbackAndFlush(callId, { error: `This container has ${MAX_SOCKETS} sockets open already` });
          return;
        }
        if (typeof WebSocket !== 'function') {
          this.resolveCallbackAndFlush(callId, { error: 'There are no sockets here' });
          return;
        }
        let ws: WebSocket;
        try {
          ws = protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
        } catch (err) {
          this.resolveCallbackAndFlush(callId, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        ws.binaryType = 'arraybuffer';
        const socket: OpenSocket = { ws, events: [], bytes: 0, waiting: null, over: false };
        this.sockets.set(id, socket);
        const heard = (event: Record<string, unknown>, size = 0) => {
          if (socket.over) return;
          socket.events.push(event);
          socket.bytes += size;
          // An app that is not listening (or is hidden for a long while) is not kept bytes for without end.
          if (socket.bytes > MAX_SOCKET_QUEUE_BYTES || socket.events.length > MAX_SOCKET_QUEUE_EVENTS) {
            socket.events = [{ t: 'close', code: 1009, reason: 'Too much arrived unread', wasClean: false }];
            socket.over = true;
            try {
              ws.close();
            } catch {
              // Already closing
            }
          }
          this.pumpSocket(id);
        };
        ws.onopen = () => heard({ t: 'open', protocol: ws.protocol, extensions: ws.extensions });
        ws.onmessage = (e: MessageEvent) => {
          if (typeof e.data === 'string') heard({ t: 'message', data: e.data }, e.data.length * 2);
          else if (e.data instanceof ArrayBuffer) heard({ t: 'message', base64: bytesToBase64(new Uint8Array(e.data)) }, e.data.byteLength * 2);
        };
        ws.onerror = () => heard({ t: 'error' });
        ws.onclose = (e: CloseEvent) => {
          heard({ t: 'close', code: e.code, reason: e.reason, wasClean: e.wasClean });
          socket.over = true;
        };
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'ws.next': {
        const id = args[0] ?? '';
        const socket = this.sockets.get(id);
        if (!socket) {
          this.resolveCallbackAndFlush(callId, { error: 'No such socket' });
          return;
        }
        socket.waiting = callId;
        this.pumpSocket(id);
        return;
      }

      case 'ws.send': {
        const socket = this.sockets.get(args[0] ?? '');
        if (!socket || socket.ws.readyState !== 1) return;
        const data = args[2] ?? '';
        if (data.length > MAX_SOCKET_MESSAGE_CHARS) return;
        try {
          socket.ws.send(args[1] === 'base64' ? base64ToBytes(data) : args[1] === 'pieces' ? (piecesToBytes(JSON.parse(data)) ?? new Uint8Array(0)) : data);
        } catch {
          // The socket closed between the check and the send: its close is told as it comes.
        }
        return;
      }

      case 'ws.close': {
        const socket = this.sockets.get(args[0] ?? '');
        if (!socket) return;
        const code = Number(args[1]);
        try {
          if (Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999))) socket.ws.close(code, (args[2] ?? '').slice(0, 123));
          else socket.ws.close();
        } catch {
          // Already closed
        }
        return;
      }

      case 'esm.forget': {
        // Modules the app's side could not compile: asked for again, they are sent again.
        try {
          const urls: unknown = JSON.parse(args[0] ?? '[]');
          const defined = this.workerCalls.get(callId)?.worker.defined ?? this.definedModules;
          if (Array.isArray(urls)) for (const url of urls) if (typeof url === 'string') defined.delete(url);
        } catch {
          // Not a list: nothing to let go of.
        }
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'subtle':
        void this.runSubtle(args[0] ?? '').then((reply) => this.resolveCallbackAndFlush(callId, reply));
        return;

      case 'subtle.drop': {
        // Keys the app's side no longer holds.
        try {
          const ids: unknown = JSON.parse(args[0] ?? '[]');
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.dropCryptoKey(id);
        } catch {
          // Not a list: nothing to let go of.
        }
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'idb.hold': {
        // Answered when the page holds the database for this tab (idb-held), with what other
        // tabs kept in it since taken in first. A name past a database's length (the app's code
        // may ask for anything) holds nothing across tabs.
        const name = String(args[0] ?? '');
        if (name.length > 1024) {
          this.resolveCallbackAndFlush(callId, { ok: true });
          return;
        }
        this.postToHost({ type: 'idb-hold', id: callId, name });
        return;
      }

      case 'idb.kept': {
        // A commit waits for the page to have kept what it wrote (the batch its idb.end named):
        // answered when the page says. (Answered by the last batch, a commit that wrote
        // nothing took a refused one's answer, and was undone with it.)
        this.flushIdbWrites();
        const asked = Math.floor(Number(args[0]));
        const id = asked > 0 && asked <= this.idbBatchId ? asked : this.idbBatchId;
        if (id <= this.idbAcked) this.resolveCallbackAndFlush(callId, { ok: !this.idbRefused.has(id) });
        else this.idbKeptWaiters.push({ id, callId });
        return;
      }

      case 'idb.release': {
        // After what was written before it, which is sent when its turn is over.
        const name = String(args[0] ?? '');
        queueMicrotask(() => queueMicrotask(() => {
          if (!this.disposed) this.postToHost({ type: 'idb-release', name });
        }));
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'worker.start':
        void this.startAppWorker(callId, args[0] ?? '');
        return;

      case 'worker.post': {
        // A message for a Worker of the app's: kept until it has started, and handed over in a
        // task of its own, as a browser hands it over. (Handed over at once, inside the turn
        // that sent it, a Worker that answered every message and an app that answered every
        // answer went deeper with each, and stopped at the bottom of the stack.)
        const worker = this.appWorkers.get(args[0] ?? '');
        const packed = args[1] ?? '';
        if (worker && !worker.over) {
          if (worker.started) this.queueForWorker(worker, packed);
          else if (!worker.toldWaiting && worker.waitingChars + packed.length <= MAX_WAITING_CHARS) {
            // All of them, to what a Worker's start may take to come (they were cut at 1,024 without a word).
            worker.waiting.push(packed);
            worker.waitingChars += packed.length;
          } else if (!worker.toldWaiting) {
            // And none after the first that did not fit: one that fitted after it went ahead of it.
            worker.toldWaiting = true;
            this.postTask(() => this.toApp('__softnContainerWorkerError', [worker.id, `Messages for a Worker that has not started yet came to more than ${MAX_WAITING_CHARS / 1024 / 1024} M characters: the rest were not sent.`]));
          }
        }
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'worker.end': {
        const worker = this.appWorkers.get(args[0] ?? '');
        if (worker) this.endAppWorker(worker);
        this.resolveCallbackAndFlush(callId, { ok: true });
        return;
      }

      case 'sqlite.op': {
        if (!this.hasSqlite) {
          this.resolveCallbackAndFlush(callId, { error: 'SQLite is not enabled in this container' });
          return;
        }
        const op = String(args[0] ?? '');
        let opArgs: unknown[] = [];
        try {
          const parsed = JSON.parse(args[1] ?? '[]');
          if (Array.isArray(parsed)) opArgs = parsed;
        } catch {
          opArgs = [];
        }
        void this.requestHost('sqlite.op', { op, args: opArgs }).then(
          (result) => this.resolveCallbackAndFlush(callId, { ok: true, result }),
          (err) => this.resolveCallbackAndFlush(callId, { error: err instanceof Error ? err.message : String(err) })
        );
        return;
      }

      case 'idb.tick':
        // A turn later for the app's IndexedDB, given while the app is not shown as well: a
        // transaction under way finishes then, as a request under way does. (On the app's own
        // timers, which wait while it is not shown, a save made just before it was hidden
        // waited too, and was lost if the app was closed before it was shown again.)
        setTimeout(() => this.resolveCallbackAndFlush(callId, { ok: true }), 0);
        return;

      default:
        this.resolveCallbackAndFlush(callId, { error: `Unsupported host call: ${kind}` });
    }
  }

  private requestHost(kind: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Container worker is disposed'));
    const requestId = this.nextHostReqId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingHostReqs.set(requestId, { resolve, reject });
      this.postToHost({ type: 'host-request', requestId, kind, payload });
    });
  }

  private async encodeRequestBodyBase64(opts: StreamRequest, sent?: BodyInit): Promise<string | undefined> {
    if (sent instanceof Blob) {
      return bytesToBase64(new Uint8Array(await sent.arrayBuffer()));
    }
    if (typeof opts.bodyBase64 === 'string') return opts.bodyBase64;
    if (typeof opts.body === 'string') return bytesToBase64(new TextEncoder().encode(opts.body));
    const built = requestBody(opts);
    if (built === undefined) return undefined;
    if (typeof built === 'string') return bytesToBase64(new TextEncoder().encode(built));
    if (built instanceof Uint8Array) return bytesToBase64(built);
    if (built instanceof Blob) return bytesToBase64(new Uint8Array(await built.arrayBuffer()));
    return undefined;
  }

  /** Serve a `stream.open` request through the container's `BackendTransport` with zero external egress. */
  private async readBackendStream(
    id: string,
    stream: OpenStream,
    target: ParsedBackendTarget,
    opts: StreamRequest,
    sent?: BodyInit
  ): Promise<void> {
    const push = (event: Record<string, unknown>, size = 0) => {
      if (this.streams.get(id) !== stream) return;
      stream.events.push(event);
      stream.bytes += size;
      this.pumpStream(id);
    };
    try {
      const bodyBase64 = await this.encodeRequestBodyBase64(opts, sent);
      const reply = (await this.requestHost('backend.fetch', {
        method: opts.method ?? 'GET',
        path: target.path,
        query: target.query,
        headers: opts.headers ?? {},
        bodyBase64,
      })) as {
        ok: boolean;
        status: number;
        statusText: string;
        headers: Record<string, string>;
        base64: string;
      };
      push({
        t: 'head',
        ok: reply.ok,
        status: reply.status,
        statusText: reply.statusText,
        headers: reply.headers ?? {},
      });
      if (reply.base64 && reply.base64.length > 0 && !stream.over) {
        push({ t: 'chunk', base64: reply.base64 }, reply.base64.length);
      }
      push({ t: 'end' });
    } catch (err) {
      push({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    stream.over = true;
  }

  /**
   * Read a request's answer as it arrives, for the app to take a piece at a time: the head
   * first, then each piece, then the end. Held to the rule every request is (no credentials
   * of the page's, no redirect followed), and not read further ahead than the app keeps up.
   */
  private async readStream(id: string, stream: OpenStream, url: string, opts: StreamRequest, sent?: BodyInit): Promise<void> {
    const push = (event: Record<string, unknown>, size = 0) => {
      if (this.streams.get(id) !== stream) return;
      stream.events.push(event);
      stream.bytes += size;
      this.pumpStream(id);
    };
    try {
      const resp = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: sent ?? requestBody(opts),
        cache: cacheModeFor(url, opts.cache),
        credentials: 'omit',
        redirect: 'error',
        signal: stream.abort.signal,
      });
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      push({ t: 'head', ok: resp.ok, status: resp.status, statusText: resp.statusText, headers });
      const reader = resp.body?.getReader();
      while (reader && !stream.over) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) push({ t: 'chunk', base64: bytesToBase64(value) }, value.byteLength * 2);
        // Not read ahead of the app without end: wait for it to take what is here.
        while (stream.bytes > MAX_STREAM_QUEUE_BYTES && !stream.over) {
          await new Promise<void>((resolve) => {
            stream.drained = resolve;
          });
        }
      }
      push({ t: 'end' });
    } catch (err) {
      push({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    stream.over = true;
  }

  /** Hand a request's waiting pieces to the app, when it has asked for them and is shown. */
  private pumpStream(id: string): void {
    const stream = this.streams.get(id);
    // Whether the app is shown or not: a request under way finishes, as it always has. (Its
    // timers and its frames wait while it is not shown; an answer it asked for does not.)
    if (!stream || stream.waiting === null || stream.events.length === 0 || this.disposed) return;
    const callId = stream.waiting;
    stream.waiting = null;
    const events = stream.events;
    stream.events = [];
    stream.bytes = 0;
    if (events.some((event) => event.t === 'end' || event.t === 'error')) this.streams.delete(id);
    const drained = stream.drained;
    stream.drained = null;
    drained?.();
    this.resolveCallbackAndFlush(callId, { events });
  }

  /** Hand a socket's waiting events to the app, when it has asked for them and is shown. */
  private pumpSocket(id: string): void {
    const socket = this.sockets.get(id);
    // Held while the app is hidden, but not a Worker's (its name is its id and the socket's): a Worker runs on while hidden.
    if (!socket || socket.waiting === null || socket.events.length === 0 || (this.paused && !/^w\d+:/.test(id)) || this.disposed) return;
    const callId = socket.waiting;
    socket.waiting = null;
    const events = socket.events;
    socket.events = [];
    socket.bytes = 0;
    if (events.some((event) => event.t === 'close')) this.sockets.delete(id);
    this.resolveCallbackAndFlush(callId, { events });
  }

  /**
   * A call of the app's crypto.subtle, done by the Worker's own: its arguments as the app's side
   * wrote them (bytes as base64, a key by its id), its answer the same way back (bytes as
   * numbers, which the app's side reads at once; a key as its id and what it is).
   */
  private async runSubtle(text: string): Promise<unknown> {
    const failed = (name: string, message: string) => ({ error: { name, message } });
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    if (!subtle) return failed('NotSupportedError', 'crypto.subtle is not available where this app runs.');
    let asked: { op?: unknown; args?: unknown };
    try {
      asked = JSON.parse(text) as { op?: unknown; args?: unknown };
    } catch {
      return failed('TypeError', 'The call to crypto.subtle could not be read.');
    }
    const { op, args } = asked;
    if (typeof op !== 'string' || !SUBTLE_OPS.has(op) || !Array.isArray(args)) return failed('TypeError', 'crypto.subtle has no such operation.');
    // What a key asks to hold, read before it is made: a key's size may be a number in the call
    // (an HMAC or a derived key's length, an RSA modulus), and keys of 24 MB each passed a
    // budget that weighed each by the size of its call. Bits derived are held to it too.
    const asks = op === 'generateKey' ? askedKeyBytes(args[0]) : op === 'deriveKey' ? askedKeyBytes(args[2]) : 0;
    if (asks > MAX_ONE_KEY_BYTES) return failed('QuotaExceededError', `A key here holds at most ${MAX_ONE_KEY_BYTES / 1024 / 1024} MB.`);
    if (op === 'deriveBits' && args[2] !== undefined && args[2] !== null) {
      // As the browser reads it, an unsigned long: a negative length wrapped round to billions
      // of bits, past a cap that compared the number as it was written. Missing or null (ECDH's
      // whole secret) is the algorithm's own.
      const written = Number(args[2]);
      const bits = Number.isFinite(written) ? ((Math.trunc(written) % 2 ** 32) + 2 ** 32) % 2 ** 32 : 0;
      if (bits > MAX_ONE_KEY_BYTES * 8) return failed('OperationError', `At most ${MAX_ONE_KEY_BYTES * 8} bits are derived at once here.`);
      args[2] = bits;
    }
    // Keys held to a number and to what they hold, those being made counted with those made:
    // calls made together all passed a count of the keys made so far.
    const weight = MAKES_KEYS.has(op) ? Math.max(1024, text.length, asks) : 0;
    if (MAKES_KEYS.has(op) && (this.cryptoKeys.size + this.cryptoMaking >= MAX_CRYPTO_KEYS || this.cryptoKeyBytes + weight > MAX_CRYPTO_KEY_BYTES)) {
      return failed('QuotaExceededError', `An app holds at most ${MAX_CRYPTO_KEYS} keys, of ${MAX_CRYPTO_KEY_BYTES / 1024 / 1024} MB in all, at once in a web container.`);
    }
    if (weight > 0) {
      this.cryptoMaking++;
      this.cryptoKeyBytes += weight;
    }
    let made = 0;
    try {
      const given = args.map((arg) => this.subtleArgument(arg, 0));
      const run = (subtle as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[op];
      const result = await run.apply(subtle, given);
      if (this.disposed) return { ok: false };
      const before = this.cryptoKeys.size;
      const value = this.subtleAnswer(result, 0);
      made = this.cryptoKeys.size - before;
      return { ok: true, value };
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown } | null;
      return failed(typeof e?.name === 'string' ? e.name : 'OperationError', typeof e?.message === 'string' ? e.message : String(err));
    } finally {
      if (weight > 0) {
        this.cryptoMaking--;
        // What a key holds is counted while it is kept (subtle.drop gives it back), and not at all for one not made.
        if (made === 0) this.cryptoKeyBytes -= weight;
        else this.cryptoKeyWeights.set(`k${this.nextCryptoKey - 1}`, weight);
      }
    }
  }

  /** An argument as the app's side wrote it, made what crypto.subtle takes. */
  private subtleArgument(value: unknown, depth: number): unknown {
    if (depth > 16) throw new TypeError('An argument to crypto.subtle is nested too deeply.');
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.subtleArgument(item, depth + 1));
    const told = value as Record<string, unknown>;
    if (typeof told.$b === 'string') return base64ToBytes(told.$b);
    if (typeof told.$k === 'string') {
      const key = this.cryptoKeys.get(told.$k);
      if (!key) throw new DOMException('The key was let go of.', 'InvalidAccessError');
      return key;
    }
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(told)) if (name !== '__proto__') out[name] = this.subtleArgument(item, depth + 1);
    return out;
  }

  /** An answer of crypto.subtle, as the app's side reads it: a key kept here and named. */
  private subtleAnswer(value: unknown, depth: number): unknown {
    if (depth > 16 || value === null || value === undefined || typeof value !== 'object') return value ?? null;
    // Told by what each is, not by instanceof: what Web Crypto answers with need not be of the realm this code runs in.
    const kind = Object.prototype.toString.call(value);
    // As base64, which the app's side reads in pieces: as numbers, an answer of more than two
    // million bytes was more than the engine takes in at once, and never came.
    if (kind === '[object ArrayBuffer]') return { $b64: bytesToBase64(new Uint8Array(value as ArrayBuffer)) };
    if (ArrayBuffer.isView(value)) return { $u64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (Array.isArray(value)) return value.map((item) => this.subtleAnswer(item, depth + 1));
    if (kind === '[object CryptoKey]') {
      const key = value as CryptoKey;
      const id = `k${this.nextCryptoKey++}`;
      this.cryptoKeys.set(id, key);
      return { $k: { id, type: key.type, extractable: key.extractable, algorithm: this.subtleAnswer(key.algorithm, depth + 1), usages: [...key.usages] } };
    }
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) out[name] = this.subtleAnswer(item, depth + 1);
    // A key pair's two halves are its own properties only in some browsers.
    for (const name of ['publicKey', 'privateKey']) {
      const half = (value as Record<string, unknown>)[name];
      if (!(name in out) && half !== undefined) out[name] = this.subtleAnswer(half, depth + 1);
    }
    return out;
  }

  private resolveCallbackAndFlush(callId: number, result: unknown): void {
    // A call of an app Worker's, answered here as the app's own are: the answer is the Worker's.
    const routed = this.workerCalls.get(callId);
    if (routed) {
      this.workerCalls.delete(callId);
      // The keys it was given are its own, let go of when it ends.
      if (routed.kind === 'subtle') collectKeyIds(result, routed.worker.keys, 0);
      this.answerAppWorker(routed.worker, routed.callId, result);
      return;
    }
    if (callId >= WORKER_CALL_BASE) {
      // A call of a Worker that has ended since: answered to no one (the app's engine has no
      // such call), and the keys it was given, which no one holds, let go of.
      const orphaned = new Set<string>();
      collectKeyIds(result, orphaned, 0);
      for (const id of orphaned) this.dropCryptoKey(id);
      return;
    }
    if (this.disposed || !this.engine) return;
    try {
      this.engine.renewInstructionBudget();
      this.engine.resolveHostCallback(callId, result);
      this.drainTurn();
    } catch (err) {
      // An answer the engine would not take in (too large to hand over): the app is answered
      // with why, where it waited for good.
      if (/conversion|exceeds/i.test(err instanceof Error ? err.message : String(err)) && !this.engine.disposed) {
        try {
          this.engine.resolveHostCallback(callId, { error: 'The answer was more than can be handed to the app at once.' });
          this.drainTurn();
          return;
        } catch {
          // Reported below.
        }
      }
      this.reportGuestError('async-callback', err);
    }
  }

  private installBridges(engine: ZippEngineInstance): void {
    // 1. Worker-local synchronous `localStorage` (zipp-wasm JSON-encodes return values automatically)
    engine.setLocalStorageBridge({
      getItem: (keyRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const val = this.localStore.get(key);
        return val === undefined ? null : val;
      },
      setItem: (keyRaw: unknown, valRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const val = String(valRaw ?? '');
        const prev = this.localStore.get(key);
        const delta = (key.length + val.length) * 2 - (prev !== undefined ? (key.length + prev.length) * 2 : 0);
        // One quota for what the app keeps: its records take from it too (`recordBytesKept`).
        // They were left out here, so an app with its records at the quota could keep as much
        // again this way; the page now refuses that, and the app must be told, not left
        // believing a value was kept that is gone at the next visit.
        if (this.localStoreBytes + delta + this.recordBytesKept + this.idbSharedBytes() > this.storageQuotaBytes) {
          throw new Error('QuotaExceededError: container localStorage quota exceeded');
        }
        this.localStore.set(key, val);
        this.localStoreBytes += delta;
        this.postToHost({ type: 'storage-write', op: 'set', key, value: val });
      },
      removeItem: (keyRaw: unknown) => {
        const key = String(keyRaw ?? '');
        const prev = this.localStore.get(key);
        if (prev !== undefined) {
          this.localStore.delete(key);
          this.localStoreBytes -= (key.length + prev.length) * 2;
          this.postToHost({ type: 'storage-write', op: 'remove', key });
        }
      },
      clear: () => {
        this.localStore.clear();
        this.localStoreBytes = 0;
        this.postToHost({ type: 'storage-write', op: 'clear' });
      },
    });

    // 2. Worker-local synchronous `db.*` (100% off the main thread!)
    const getCollection = (name: string): Map<string, DbRecord> => {
      let col = this.dbCollections.get(name);
      if (!col) {
        col = new Map();
        this.dbCollections.set(name, col);
      }
      return col;
    };
    // The app's records count against the same quota as its localStorage: both are kept in
    // the embedding page's storage, which is the page's to run out of. (Only localStorage was
    // counted, so an app could write records until the page's own keys had no room.) Counted
    // as the page counts them, by the one text they are kept as, so that the two agree on
    // the write that does not fit.
    const persistCollection = (name: string) => {
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid collection name.');
      const records = [...getCollection(name).values()];
      const size = JSON.stringify({ [name]: records }).length * 2;
      const total = this.bytesAfterSaving(name, size);
      if (this.localStoreBytes + total + this.idbSharedBytes() > this.storageQuotaBytes) {
        throw new Error('QuotaExceededError: container storage quota exceeded');
      }
      this.postToHost({ type: 'db-write', collection: name, records });
      this.recordBytesKept = total;
      this.savedCollectionBytes.set(name, size);
      if (this.watchedCollections.has(name)) this.notifyCollectionChanged(name);
    };
    /**
     * Keep a change to a collection, or take it back: a change the quota refuses is undone
     * before the app hears of it. It used to stay in the Worker's own copy, where the app
     * went on reading a record the page had not kept, and where every later change, a
     * delete included, was refused in turn because the copy was still over the quota.
     */
    const commit = (name: string, undo: () => void): void => {
      try {
        persistCollection(name);
      } catch (err) {
        undo();
        throw err;
      }
    };

    engine.setDbBridge({
      query: (collectionRaw: unknown, optsRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const col = getCollection(collection);
        const opts =
          optsRaw && typeof optsRaw === 'object'
            ? (optsRaw as { filter?: Record<string, unknown> })
            : typeof optsRaw === 'string' && optsRaw
              ? (JSON.parse(optsRaw) as { filter?: Record<string, unknown> } | null)
              : null;
        const filter = opts?.filter && typeof opts.filter === 'object' ? opts.filter : opts;
        const wanted = Object.entries(filter ?? {});
        return [...col.values()].filter((r) => !r._deleted && !r.deleted &&
          wanted.every(([field, value]) => Object.hasOwn(r, field) && r[field] === value)
        ).map(guestRecord);
      },
      get: (collectionRaw: unknown, idRaw: unknown) => {
        const rec = getCollection(String(collectionRaw ?? '')).get(String(idRaw ?? ''));
        return rec && !rec._deleted && !rec.deleted ? guestRecord(rec) : null;
      },
      create: (collectionRaw: unknown, dataRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const data =
          dataRaw && typeof dataRaw === 'object'
            ? (dataRaw as Record<string, unknown>)
            : typeof dataRaw === 'string' && dataRaw
              ? (JSON.parse(dataRaw) as Record<string, unknown>)
              : {};
        const now = new Date().toISOString();
        const id =
          typeof data.id === 'string' && data.id
            ? data.id
            : `rec_${Date.now().toString(36)}_${(this.dbRecordSeq++).toString(36)}`;
        const rec: DbRecord = { ...data, id, created_at: now, updated_at: now };
        const col = getCollection(collection);
        const before = col.get(id);
        col.set(id, rec);
        commit(collection, () => {
          if (before) col.set(id, before);
          else col.delete(id);
        });
        return guestRecord(rec);
      },
      update: (idRaw: unknown, dataRaw: unknown) => {
        const id = String(idRaw ?? '');
        const patch =
          dataRaw && typeof dataRaw === 'object'
            ? (dataRaw as Record<string, unknown>)
            : typeof dataRaw === 'string' && dataRaw
              ? (JSON.parse(dataRaw) as Record<string, unknown>)
              : {};
        for (const [colName, col] of this.dbCollections) {
          const existing = col.get(id);
          if (existing && !existing._deleted && !existing.deleted) {
            const updated: DbRecord = {
              ...existing,
              ...patch,
              id: existing.id,
              updated_at: new Date().toISOString(),
            };
            col.set(id, updated);
            commit(colName, () => col.set(id, existing));
            return guestRecord(updated);
          }
        }
        return null;
      },
      delete: (idRaw: unknown) => {
        const id = String(idRaw ?? '');
        for (const [colName, col] of this.dbCollections) {
          const existing = col.get(id);
          if (existing && !existing._deleted && !existing.deleted) {
            // A new record in the old one's place, so that the old one is there to put back.
            col.set(id, { ...existing, _deleted: true, updated_at: new Date().toISOString() });
            commit(colName, () => col.set(id, existing));
            break;
          }
        }
      },
      hardDelete: (collectionRaw: unknown, idRaw: unknown) => {
        const collection = String(collectionRaw ?? '');
        const col = getCollection(collection);
        const existing = col.get(String(idRaw ?? ''));
        if (existing && col.delete(existing.id)) commit(collection, () => col.set(existing.id, existing));
      },
      startSync: () => undefined,
      stopSync: () => undefined,
      getSyncStatus: () => ({ connected: false, peers: 0 }),
      getSavedSyncRoom: () => null,
    });

    // 3. Synchronous VFS & ES Module Resolver bridge (`call(kind, args)` per zipp-wasm setAppBridge contract)
    const appCall = (kindRaw: unknown, argsRaw: unknown) => {
        const kind = String(kindRaw ?? '');
        const args = Array.isArray(argsRaw) ? argsRaw : [];
        if (kind === 'xdb.watch') {
          const name = String(args[0] ?? '');
          if (args[1] === '1') this.watchedCollections.add(name);
          else this.watchedCollections.delete(name);
          return null;
        }
        if (kind === 'esm.resolve') {
          const specifier = String(args[0] ?? '');
          const importerUrl = String(args[1] ?? '');
          const importerPath = importerUrl.startsWith(VIRTUAL_ORIGIN + '/')
            ? importerUrl.slice(VIRTUAL_ORIGIN.length + 1)
            : 'index.html';
          const res = resolveModuleSpecifier(
            specifier,
            importerPath,
            this.importMap,
            (p) => p in this.textFiles
          );
          return res.url;
        }
        if (kind === 'vfs.fetch') {
          const rawUrl = String(args[0] ?? '');
          const basePath = String(args[1] || '/index.html').replace(/^\/+/, '') || 'index.html';
          if (
            matchBackendTarget(rawUrl, this.backendRouting, {
              baseUrl: `${VIRTUAL_ORIGIN}/${basePath}`,
              method: 'GET',
              isStaticVfsFile: (p) => p in this.textFiles || p in this.binaryFiles,
            })
          ) {
            return { backend: true };
          }
          const vfsPath = resolveVfsPath(rawUrl, basePath);
          if (!vfsPath) {
            return { ok: false, status: 400, statusText: 'Bad Path', headers: {} };
          }
          if (vfsPath in this.textFiles) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': mimeTypeFor(vfsPath) },
              body: this.textFiles[vfsPath],
            };
          }
          if (vfsPath in this.binaryFiles) {
            return {
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': mimeTypeFor(vfsPath) },
              // Written out here, off the page's thread, and only for a file a script reads.
              base64: bytesToBase64(this.binaryFiles[vfsPath]),
            };
          }
          return { ok: false, status: 404, statusText: 'Not Found', headers: {} };
        }
        if (kind === 'scripts.placed') {
          // The page's own scripts, for its document: once.
          const placed = this.placedScripts;
          this.placedScripts = [];
          return placed;
        }
        if (kind === 'script.prepare') {
          // A script of text the app added to its page (or a blob or data: address it named): run at once by its side.
          const address = String(args[1] ?? '');
          return this.scriptReady(String(args[0] ?? ''), address, /^(blob|data):/i.test(address) ? address.slice(0, 80) : 'a script of text the app added');
        }
        if (kind === 'bytes.decode') {
          // Bytes from base64 for the app's side, as numbers, which it reads at once: made there
          // a byte at a time, a few megabytes took more than a turn has, and stopped the app.
          try {
            return Array.from(base64ToBytes(String(args[0] ?? '')));
          } catch {
            return null;
          }
        }
        if (kind === 'webgl') {
          const sub = String(args[0] ?? '');
          if (sub === 'init') {
            let attrs: Record<string, unknown> | undefined;
            try { attrs = args[5] ? (JSON.parse(String(args[5])) as Record<string, unknown>) : undefined; } catch { attrs = undefined; }
            const res = this.webglHost.init(Number(args[1]) || 0, String(args[2] ?? 'webgl2'), Number(args[3]) || 300, Number(args[4]) || 150, attrs);
            if (res) this.mirrorCanvases = true;
            return res;
          }
          if (sub === 'ext') {
            return this.webglHost.getExtension(Number(args[1]) || 0, String(args[2] ?? ''));
          }
          if (sub === 'exec') {
            let cmds: unknown[] = [];
            let syncCmd: unknown[] | null = null;
            try { cmds = args[2] ? (JSON.parse(String(args[2])) as unknown[]) : []; } catch { cmds = []; }
            try { syncCmd = args[3] ? (JSON.parse(String(args[3])) as unknown[]) : null; } catch { syncCmd = null; }
            return this.webglHost.exec(Number(args[1]) || 0, cmds, syncCmd, {
              getCanvas2DMirror: (cid, w, h, pendingCmds) => {
                if (pendingCmds.length > 0) this.drawMirror(cid, w, h, pendingCmds as Canvas2DCmd[]);
                return this.mirrorOf(cid, w, h)?.canvas ?? null;
              },
              getImageBitmap: (ref) => this.mirrorPictures.get(ref)?.bitmap ?? null,
            });
          }
          if (sub === 'dispose') {
            const cid = Number(args[1]) || 0;
            if (args[2] === 'canvas') {
              this.webglHost.disposeCanvas(cid);
              this.threeHost.disposeCanvas(cid);
            } else {
              this.webglHost.disposeContext(cid);
            }
            return true;
          }
          return null;
        }
        if (kind === 'three') {
          const sub = String(args[0] ?? '');
          if (sub === 'init') {
            let opts: Record<string, unknown> | undefined;
            try { opts = args[4] ? (JSON.parse(String(args[4])) as Record<string, unknown>) : undefined; } catch { opts = undefined; }
            const res = this.threeHost.init(Number(args[1]) || 0, Number(args[2]) || 300, Number(args[3]) || 150, opts);
            if (res) this.mirrorCanvases = true;
            return res;
          }
          if (sub === 'frame') {
            let ops: unknown[] = [];
            try { ops = args[2] ? (JSON.parse(String(args[2])) as unknown[]) : []; } catch { ops = []; }
            return this.threeHost.frame(Number(args[1]) || 0, ops, String(args[3] ?? ''), {
              getCanvas2DMirror: (cid, w, h, pendingCmds) => {
                if (pendingCmds.length > 0) this.drawMirror(cid, w, h, pendingCmds as Canvas2DCmd[]);
                return this.mirrorOf(cid, w, h)?.canvas ?? null;
              },
              getImageBitmap: (ref) => this.mirrorPictures.get(ref)?.bitmap ?? null,
              getArchiveBytes: (relPath) => {
                const norm = String(relPath || '').replace(/^\.\/+/, '').replace(/^\/+/, '');
                if (!norm) return null;
                const bin = this.binaryFiles[norm];
                if (bin) return bin;
                const txt = this.textFiles[norm];
                if (typeof txt === 'string') return new TextEncoder().encode(txt);
                return null;
              },
              onAsyncDirty: () => {
                if (this.disposed || !this.threeHost.hasActiveRenderers()) return;
                for (const frame of this.threeHost.takeDirtyFrames()) {
                  this.postToHost(
                    {
                      type: 'webgl-frame',
                      canvasId: frame.canvasId,
                      bitmap: frame.bitmap,
                      width: frame.width,
                      height: frame.height,
                    },
                    [frame.bitmap]
                  );
                }
              },
            });
          }
          if (sub === 'raycast') {
            let payload: unknown[] = [];
            try { payload = args[2] ? (JSON.parse(String(args[2])) as unknown[]) : []; } catch { payload = []; }
            if (payload.length < 6) return [];
            return this.threeHost.raycast(
              Number(args[1]) || 0,
              payload[0] as [number, number, number],
              payload[1] as [number, number, number],
              Number(payload[2]) || 0,
              Number(payload[3]) || Infinity,
              Array.isArray(payload[4]) ? (payload[4] as number[]) : [],
              Boolean(payload[5]),
              Number(payload[6]) || 0
            );
          }
          if (sub === 'dispose') {
            const id = Number(args[1]) || 0;
            if (args[2] === 'canvas') this.threeHost.disposeCanvas(id);
            else this.threeHost.disposeRenderer(id);
            return true;
          }
          return null;
        }
        if (kind === 'session') {
          const sub = String(args[0] ?? '');
          if (sub === 'route') {
            const urlPath = String(args[1] ?? '');
            if (urlPath.startsWith('/')) {
              this.postToHost({ type: 'session-route', urlPath });
            }
            return true;
          }
          if (sub === 'ss') {
            const op = String(args[1] ?? '');
            if (op === 'set' || op === 'remove' || op === 'clear') {
              this.postToHost({
                type: 'session-storage-write',
                op,
                ...(op !== 'clear' ? { key: String(args[2] ?? '') } : {}),
                ...(op === 'set' ? { value: String(args[3] ?? '') } : {}),
              });
            }
            return true;
          }
          return null;
        }
        if (kind === 'canvas.image') {
          this.loadMirrorPicture(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] || '/index.html'), args[3] === 'early' ? 'early' : args[3] === 'none' ? 'none' : 'drawn', args[4] === 'cors');
          return true;
        }
        if (kind === 'canvas.dataurl' || kind === 'canvas.pixels') {
          // Answered, never thrown out of: what was drawn here is drawn whatever the answer,
          // and the app's side marks it so only when an answer comes.
          try {
            return this.readMirror(kind, args);
          } catch {
            return { refused: 'error' };
          }
        }
        // The app's IndexedDB databases: kept here as the texts the app's side makes of them,
        // read and written at once (a transaction is over when its data is kept), and held
        // to the one quota with everything else the app keeps.
        if (kind === 'idb.keys') return [...this.idbStore.keys()].filter((name) => IDB_PART_NAME.test(name));
        if (kind === 'idb.read') {
          if (!IDB_PART_NAME.test(String(args[0] ?? ''))) return null;
          const text = this.idbStore.get(String(args[0] ?? ''));
          if (text === undefined) return null;
          // Past what one answer carries: its size, then a piece at a time from where it is asked.
          if (args[1] !== undefined) {
            const from = Math.max(0, Math.floor(Number(args[1])) || 0);
            return text.slice(from, from + IDB_READ_PIECE);
          }
          return text.length <= IDB_READ_PIECE ? text : { size: text.length };
        }
        if (kind === 'idb.write') {
          const name = String(args[0] ?? '');
          // Only a name the app's IndexedDB writes: a database's description, a store's list of
          // pages, a page. Checked before any piece is kept: pieces under any name at all were
          // kept, without a limit, and filled the page's memory.
          if (!IDB_PART_NAME.test(name)) throw new Error('Not a part of an IndexedDB database');
          if (name.length > MAX_IDB_NAME_LENGTH) throw new Error('QuotaExceededError: container storage quota exceeded');
          let text = String(args[1] ?? '');
          if (args[2] !== undefined) {
            // A part in pieces: kept when the last has come.
            const index = Math.floor(Number(args[2]));
            const count = Math.floor(Number(args[3]));
            if (!(index >= 0) || !(count > index) || count > 4096) throw new Error('Not a piece of a part');
            const room = (this.idbApart ? this.idbQuotaBytes : this.storageQuotaBytes) / 2;
            let pending = this.idbPieces.get(name);
            if (index === 0 || !pending || pending.count !== count || pending.pieces.length !== index) {
              // One part in pieces at a time, as the app's side writes them: another left
              // unfinished is let go of.
              this.idbPieces.clear();
              this.idbPieceChars = 0;
              pending = { count, pieces: [], chars: 0 };
              this.idbPieces.set(name, pending);
            }
            if (this.idbPieceChars + text.length > room) {
              this.idbPieces.delete(name);
              this.idbPieceChars -= pending.chars;
              throw new Error('QuotaExceededError: container storage quota exceeded');
            }
            pending.pieces.push(text);
            pending.chars += text.length;
            this.idbPieceChars += text.length;
            if (pending.pieces.length < count) return true;
            this.idbPieces.delete(name);
            this.idbPieceChars -= pending.chars;
            text = pending.pieces.join('');
          }
          if (this.idbStaged) {
            // Part of a commit: kept with the rest of it, or not at all, when it ends.
            this.stageIdbPart(name, text);
            return true;
          }
          const before = this.idbStore.get(name);
          const delta = (name.length + text.length) * 2 - (before === undefined ? 0 : (name.length + before.length) * 2);
          const over = this.idbApart ? this.idbBytes + delta > this.idbQuotaBytes : this.localStoreBytes + this.recordBytesKept + this.idbBytes + delta > this.storageQuotaBytes;
          if (name.length > MAX_IDB_NAME_LENGTH || over) {
            throw new Error('QuotaExceededError: container storage quota exceeded');
          }
          this.idbStore.set(name, text);
          this.idbBytes += delta;
          this.idbWritten(name, text, before);
          return true;
        }
        if (kind === 'idb.begin') {
          // A commit begins: what it writes is kept when it ends, all of it or none.
          this.idbStaged = new Map();
          this.idbStagedChars = 0;
          return true;
        }
        if (kind === 'idb.end') {
          const staged = this.idbStaged;
          this.idbStaged = null;
          this.idbStagedChars = 0;
          if (!staged || args[0] === 'cancel') return true;
          let delta = 0;
          for (const [name, text] of staged) {
            const before = this.idbStore.get(name);
            delta += (text === null ? 0 : (name.length + text.length) * 2) - (before === undefined ? 0 : (name.length + before.length) * 2);
          }
          const over = this.idbApart ? this.idbBytes + delta > this.idbQuotaBytes : this.localStoreBytes + this.recordBytesKept + this.idbBytes + delta > this.storageQuotaBytes;
          if (over && delta > 0) throw new Error('QuotaExceededError: container storage quota exceeded');
          let wrote = 0;
          for (const [name, text] of staged) {
            const before = this.idbStore.get(name);
            if (text === null) {
              if (before === undefined) continue;
              this.idbStore.delete(name);
            } else this.idbStore.set(name, text);
            this.idbWritten(name, text, before);
            wrote = this.idbBatchId;
          }
          this.idbBytes += delta;
          // The batch its writes went into, for the commit to wait on that one alone (none: nothing to wait on).
          return { batch: wrote };
        }
        if (kind === 'idb.remove') {
          const name = String(args[0] ?? '');
          if (!IDB_PART_NAME.test(name)) return true;
          if (name.length > MAX_IDB_NAME_LENGTH) throw new Error('QuotaExceededError: container storage quota exceeded');
          if (this.idbStaged) {
            this.stageIdbPart(name, null);
            return true;
          }
          const before = this.idbStore.get(name);
          if (before !== undefined) {
            this.idbStore.delete(name);
            this.idbBytes -= (name.length + before.length) * 2;
            this.idbWritten(name, null, before);
          }
          return true;
        }
        throw new Error(`Unknown sync app operation: ${kind}`);
    };
    this.appSyncCall = appCall;
    engine.setAppBridge({ call: appCall });
  }

  // ---------------------------------------------------------------- Workers of the app's own
  //
  // An app's `new Worker(url)` runs in an engine of its own here, with the layers of the app's
  // page (made a worker's global scope by GUEST_WORKER_SCOPE_SOURCE). Its calls that are
  // answered later are answered as the app's own are, by numbers of their own (workerCalls);
  // its requests and sockets go by names of their own (its id in front). It runs while the app
  // is hidden, as a browser's does.

  /** Start a Worker the app made: its script one of the app's files, or the text of a blob it made. */
  private async startAppWorker(callId: number, specText: string): Promise<void> {
    const refuse = (error: string) => this.resolveCallbackAndFlush(callId, { error });
    let spec: { id?: unknown; url?: unknown; code?: unknown; type?: unknown; name?: unknown };
    try {
      spec = JSON.parse(specText) as typeof spec;
    } catch {
      refuse('Not a Worker to start');
      return;
    }
    const id = typeof spec.id === 'string' ? spec.id : '';
    if (!/^w\d{1,9}$/.test(id) || this.appWorkers.has(id)) {
      refuse('Not a Worker to start');
      return;
    }
    if (this.appWorkers.size >= MAX_APP_WORKERS) {
      refuse(`An app runs at most ${MAX_APP_WORKERS} Workers of its own at once here`);
      return;
    }
    if (!this.bindings || this.language === 'python') {
      refuse('No engine for a Worker here');
      return;
    }
    const url = typeof spec.url === 'string' ? spec.url : '';
    let code: string;
    let path: string;
    if (typeof spec.code === 'string') {
      code = spec.code;
      path = 'index.html';
    } else {
      // Its own files only, as a browser holds a Worker's script to the page's own site.
      if (!url.startsWith(`${VIRTUAL_ORIGIN}/`)) {
        refuse(`A Worker's script is one of the app's own files: ${url} is not`);
        return;
      }
      try {
        path = decodeURIComponent(url.slice(VIRTUAL_ORIGIN.length + 1).split(/[?#]/)[0]);
      } catch {
        refuse(`There is no file at ${url} for a Worker to run`);
        return;
      }
      const text = this.textFiles[path];
      if (text === undefined) {
        refuse(`There is no file ${path} for a Worker to run`);
        return;
      }
      code = text;
    }
    // Its program defines the built-in modules, as the app's does: not taken again for it.
    const worker: AppWorker = { id, engine: null, timers: new Map(), defined: new Set(BUILTIN_MODULES), over: false, waiting: [], waitingChars: 0, toldWaiting: false, started: false, queuedChars: 0, toldQueued: false, keys: new Set(), blobs: new Set(), draining: false, drainAgain: false };
    this.appWorkers.set(id, worker);
    try {
      const workerName = typeof spec.name === 'string' ? spec.name : '';
      const workerHref = url || `${VIRTUAL_ORIGIN}/${path}`;
      const bindings = this.bindings;
      const made = () => {
        const engine = new bindings.Engine();
        engine.setAppBridge({
          call: (kindRaw: unknown, argsRaw: unknown) => {
            const kind = String(kindRaw ?? '');
            if (!WORKER_SYNC_KINDS.has(kind) || !this.appSyncCall) throw new Error(`${kind} is not available in a Worker of the app's`);
            return this.appSyncCall(kind, argsRaw);
          },
        });
        engine.setSyncHostCapabilities([...WORKER_SYNC_KINDS].map((kind) => `app.${kind}`));
        engine.setInstructionBudget(this.instructionsPerTurn);
        return engine;
      };
      const definedBefore = new Set(worker.defined);
      let program = await this.appWorkerProgram(worker, code, path, spec.type === 'module', workerName, workerHref);
      if (worker.over || this.disposed) return;
      let engine = made();
      worker.engine = engine;
      try {
        engine.initSource(program.source, this.language);
      } catch (err) {
        // The modules it names, compiled with it, did not compile: started again without them
        // (each is then compiled when asked for, or refused in words).
        if (program.onDemand === 0) throw err;
        worker.defined.clear();
        for (const url of definedBefore) worker.defined.add(url);
        program = await this.appWorkerProgram(worker, code, path, spec.type === 'module', workerName, workerHref, false);
        if (worker.over || this.disposed) return;
        engine = made();
        worker.engine = engine;
        engine.initSource(program.source, this.language);
      }
      // What came for it before it started goes first, each in its turn, then what comes after.
      for (const packed of worker.waiting.splice(0)) this.queueForWorker(worker, packed);
      worker.waitingChars = 0;
      worker.started = true;
      this.drainAppWorker(worker);
      this.resolveCallbackAndFlush(callId, { ok: true });
    } catch (err) {
      this.endAppWorker(worker);
      refuse(`The Worker did not start: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }

  /** The program an app Worker runs: the layers of the app's page, a worker's scope, and its script. */
  private async appWorkerProgram(worker: AppWorker, code: string, path: string, module: boolean, name: string, href: string, withOnDemand = true): Promise<{ source: string; onDemand: number }> {
    const onDemand: string[] = [];
    const parts: string[] = [
      `globalThis.__softnWorkerSpec = ${JSON.stringify({ name, href })};`,
      ESM_REGISTRY_PREAMBLE,
      `globalThis.__softnCanvasMirror = ${JSON.stringify('a Worker of the app’s has no canvas to read back')};`,
      `globalThis.__softnSubtle = ${typeof crypto !== 'undefined' && typeof crypto.subtle === 'object' && crypto.subtle !== null};`,
      shellPrelude(JSON.stringify({ body: [], next: 2, url: href })),
      GUEST_EXTENSIONS_SOURCE,
      GUEST_BROWSER_GLOBALS_SOURCE,
      GUEST_WEB_APIS_SOURCE,
      GUEST_INDEXEDDB_SOURCE,
      GUEST_WORKER_SCOPE_SOURCE,
      WARNINGS_MARKED,
      CLASSIC_GLOBALS_HELPER,
      `function __softnContainerWorkerMessage(packed) { return globalThis.__softnWorkerIncoming(packed); }`,
      `function __softnContainerTake(failed) { return globalThis.__softnDocTake(failed); }`,
    ];
    // The modules it names in an import() written as text: those that cannot be compiled when
    // asked for (past 64 KB, or any in a TypeScript app) are compiled with it, as the page's are.
    const named: Array<{ spec: string; from: string }> = [];
    if (module) {
      const entryUrl = href.startsWith(`${VIRTUAL_ORIGIN}/`) ? href : `${VIRTUAL_ORIGIN}/${path}`;
      const blocks: string[] = [];
      await this.collectModuleGraph(code, path, entryUrl, blocks, undefined, named, worker.defined);
      parts.push(...blocks);
      if (withOnDemand) this.collectOnDemand(named, onDemand, workerAheadBytes(code), worker.defined);
      parts.push(...onDemand);
      parts.push(`__softnModules.import(${JSON.stringify(entryUrl)}, ${JSON.stringify(entryUrl)}).then(undefined, function (err) { globalThis.__softnWorkerFailed(err); });`);
    } else {
      // The scripts it names to importScripts as text are compiled with it, whatever their size.
      const imported: string[] = [];
      const seen = new Set<string>();
      for (const found of code.matchAll(/importScripts\s*\(([^)]*)\)/g)) {
        for (const literal of found[1].matchAll(/(["'])((?:(?!\1)[^\\\n])*)\1/g)) {
          let full: string;
          try {
            full = new URL(literal[2], href.startsWith('blob:') ? `${VIRTUAL_ORIGIN}/${path}` : href).href;
          } catch {
            continue;
          }
          if (seen.has(full) || !full.startsWith(`${VIRTUAL_ORIGIN}/`)) continue;
          seen.add(full);
          let filePath: string;
          try {
            filePath = decodeURIComponent(full.slice(VIRTUAL_ORIGIN.length + 1).split(/[?#]/)[0]);
          } catch {
            continue;
          }
          const file = this.textFiles[filePath];
          if (file === undefined) continue;
          const fn = `__softnImported${imported.length}`;
          const rewrittenFile = classicImportsRewritten(file, full);
          for (const spec of rewrittenFile.named) named.push({ spec, from: filePath });
          parts.push(classicScriptAsFunction(rewrittenFile.code, fn).source);
          imported.push(`${JSON.stringify(full)}: ${fn}`);
        }
      }
      parts.push(`globalThis.__softnImportedScripts = { ${imported.join(', ')} };`);
      // At the top of its own program: what it declares is its global scope's, as in a worker.
      // Its import() calls ask its modules, as a classic worker's do in a browser.
      const rewritten = classicImportsRewritten(code, href.startsWith(`${VIRTUAL_ORIGIN}/`) ? href : `${VIRTUAL_ORIGIN}/${path}`);
      for (const spec of rewritten.named) named.push({ spec, from: path });
      if (withOnDemand) this.collectOnDemand(named, onDemand, workerAheadBytes(code), worker.defined);
      parts.push(...onDemand);
      parts.push(rewritten.code);
    }
    return { source: parts.join('\n'), onDemand: onDemand.length };
  }

  /** After a turn of an app Worker's: what it printed, what it asked, and the blobs it made addresses for (the page keeps those). */
  private drainAppWorker(worker: AppWorker): void {
    const engine = worker.engine;
    if (!engine || worker.over || this.disposed) return;
    // As the app's drain: never one inside another (drainTurn says why).
    if (worker.draining) {
      worker.drainAgain = true;
      return;
    }
    worker.draining = true;
    const began = performance.now();
    try {
      do {
        worker.drainAgain = false;
        engine.pump();
        for (;;) {
          const entries = engine.takeConsole();
          if (!Array.isArray(entries) || entries.length === 0) break;
          for (const entry of entries) {
            const text = String(entry.text ?? '');
            if (entry.stream !== 'stderr') this.postToHost({ type: 'console', level: 'log', text });
            else if (text.startsWith(WARNING_MARK)) this.postToHost({ type: 'console', level: 'warn', text: text.slice(WARNING_MARK.length).replace(/^ /, '') });
            else this.postToHost({ type: 'console', level: 'error', text });
          }
        }
        for (const req of engine.drainPendingHostCalls()) {
          if (worker.over) break;
          this.appWorkerCall(worker, req.id, req.kind, req.args);
        }
        if (worker.over || this.disposed) return;
      } while (worker.drainAgain && performance.now() - began < MAX_DRAIN_MS);
    } finally {
      worker.draining = false;
    }
    if (worker.drainAgain) {
      worker.drainAgain = false;
      this.postTask(() => this.drainAppWorker(worker));
    }
    const ops: ShellOp[] = [];
    for (let pages = 0; pages < 64; pages++) {
      const page = engine.callFunction?.('__softnContainerTake', [false]);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const op of page as ShellOp[]) {
        if (op[0] !== 'blob' && op[0] !== 'unblob') continue;
        ops.push(op);
        // What it made addresses for, let go of when it ends, as a browser lets them go.
        if (typeof op[1] === 'string') {
          if (op[0] === 'blob') worker.blobs.add(op[1]);
          else worker.blobs.delete(op[1]);
        }
      }
    }
    if (ops.length > 0) {
      if (this.mirrorCanvases) this.mirrorOps(ops);
      this.postToHost({ type: 'ops', ops });
    }
  }

  /** A call an app Worker's engine made, answered later. */
  private appWorkerCall(worker: AppWorker, callId: number, kind: string, args: string[]): void {
    // Ended (in the turn it asked, or since): nothing of it is carried out.
    if (worker.over) return;
    switch (kind) {
      case 'timer.set': {
        const timerId = Number(args[0]);
        const delayMs = Math.max(0, Math.min(Number(args[1]) || 0, 86_400_000));
        const handle = setTimeout(() => {
          worker.timers.delete(timerId);
          this.answerAppWorker(worker, callId, { ok: true });
        }, delayMs);
        worker.timers.set(timerId, handle);
        return;
      }
      case 'timer.clear': {
        const handle = worker.timers.get(Number(args[0]));
        if (handle !== undefined) clearTimeout(handle);
        worker.timers.delete(Number(args[0]));
        return;
      }
      case 'worker.post': {
        // A message for the Worker object in the app's page script, in a task of its own.
        const packed = String(args[0] ?? '');
        if (this.mayQueue(worker, packed)) {
          this.postTask(() => {
            worker.queuedChars -= packed.length;
            this.toApp('__softnContainerWorkerMessage', [worker.id, packed]);
          });
        }
        this.answerAppWorker(worker, callId, { ok: true });
        return;
      }
      case 'worker.error': {
        const message = String(args[0] ?? '');
        this.postTask(() => this.toApp('__softnContainerWorkerError', [worker.id, message]));
        this.answerAppWorker(worker, callId, { ok: true });
        return;
      }
      case 'worker.close':
        this.endAppWorker(worker);
        return;
      default:
        if (WORKER_ROUTED_KINDS.has(kind)) {
          // Its requests and sockets by names of their own: its id in front of the name it gave,
          // and in front of the name of the body a request of its sends (kept by that name).
          const named = (kind.startsWith('stream.') || kind.startsWith('ws.')) && args.length > 0 ? [`${worker.id}:${args[0]}`, ...args.slice(1)] : args.slice();
          if (kind === 'stream.open' && named.length > 2) {
            try {
              const options = JSON.parse(named[2] ?? '{}') as { bodyId?: unknown };
              if (options && typeof options.bodyId === 'string') named[2] = JSON.stringify({ ...options, bodyId: `${worker.id}:${options.bodyId}` });
            } catch {
              // Not options: refused as it is.
            }
          }
          const routed = this.nextWorkerCall++;
          this.workerCalls.set(routed, { worker, callId, kind });
          void this.fulfillHostCall(routed, kind, named);
          if (WORKER_UNANSWERED_KINDS.has(kind)) this.workerCalls.delete(routed);
          return;
        }
        this.answerAppWorker(worker, callId, { error: `${kind} is not available in a Worker of the app's` });
    }
  }

  /** An answer for an app Worker's call, and the turn it makes. */
  private answerAppWorker(worker: AppWorker, callId: number, result: unknown): void {
    if (!worker.engine || worker.over || this.disposed) return;
    try {
      worker.engine.renewInstructionBudget();
      worker.engine.resolveHostCallback(callId, result);
      this.drainAppWorker(worker);
    } catch (err) {
      this.appWorkerFailed(worker, err);
    }
  }

  /** A message from the app's page script for its Worker. */
  private toAppWorker(worker: AppWorker, packed: string): void {
    if (!worker.engine || worker.over || this.disposed) return;
    try {
      worker.engine.renewInstructionBudget();
      worker.engine.callFunction?.('__softnContainerWorkerMessage', [packed]);
      this.drainAppWorker(worker);
    } catch (err) {
      this.appWorkerFailed(worker, err);
    }
  }

  /**
   * Messages between the app and a started Worker waiting to be handed over, both ways, held to
   * what they may hold: a loop that posts and never waits held the Worker's memory without a
   * limit. Past it, the app is told once, and those messages are not sent.
   */
  private mayQueue(worker: AppWorker, packed: string): boolean {
    if (worker.queuedChars + packed.length > MAX_WAITING_CHARS) {
      if (!worker.toldQueued) {
        worker.toldQueued = true;
        this.postTask(() => this.toApp('__softnContainerWorkerError', [worker.id, `Messages waiting to be handed over between the app and its Worker came to more than ${MAX_WAITING_CHARS / 1024 / 1024} M characters: the rest were not sent.`]));
      }
      return false;
    }
    worker.queuedChars += packed.length;
    return true;
  }

  private queueForWorker(worker: AppWorker, packed: string): void {
    if (!this.mayQueue(worker, packed)) return;
    this.postTask(() => {
      worker.queuedChars -= packed.length;
      this.toAppWorker(worker, packed);
    });
  }

  /** What went wrong in an app Worker's turn, told to the Worker object as an error (in its turn, after its messages); one whose engine stopped is ended. */
  private appWorkerFailed(worker: AppWorker, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.postTask(() => this.toApp('__softnContainerWorkerError', [worker.id, message]));
    if (!worker.engine || worker.engine.disposed) this.endAppWorker(worker);
  }

  /** End an app Worker: its engine, its timers, its requests and sockets. */
  private endAppWorker(worker: AppWorker): void {
    if (worker.over) return;
    worker.over = true;
    this.appWorkers.delete(worker.id);
    for (const handle of worker.timers.values()) clearTimeout(handle);
    worker.timers.clear();
    const prefix = `${worker.id}:`;
    for (const [name, stream] of [...this.streams]) {
      if (!name.startsWith(prefix)) continue;
      stream.over = true;
      stream.abort.abort();
      this.streams.delete(name);
    }
    for (const [name, socket] of [...this.sockets]) {
      if (!name.startsWith(prefix)) continue;
      try {
        socket.ws.close();
      } catch {
        // Closed already.
      }
      this.sockets.delete(name);
    }
    for (const [routed, entry] of [...this.workerCalls]) if (entry.worker === worker) this.workerCalls.delete(routed);
    // Bodies its requests were sending, its keys, and the addresses it made for blobs.
    for (const name of [...this.bodies.keys()]) if (name.startsWith(prefix)) this.bodies.delete(name);
    for (const id of worker.keys) this.dropCryptoKey(id);
    worker.keys.clear();
    if (worker.blobs.size > 0) {
      const gone: ShellOp[] = [...worker.blobs].map((id) => ['unblob', id] as ShellOp);
      worker.blobs.clear();
      if (this.mirrorCanvases) this.mirrorOps(gone);
      if (!this.disposed) this.postToHost({ type: 'ops', ops: gone });
    }
    try {
      worker.engine?.dispose();
    } catch {
      // Stopped already.
    }
    worker.engine = null;
  }

  /**
   * A script's text made ready for eval: what it declares at its top made the page's, its
   * import() asking the app's modules. Refused, in words, past what the engine compiles at once
   * while the app runs (passing that would stop the app altogether).
   */
  private scriptReady(text: string, url: string, from = url): { code: string } | { fn: string } | { error: string } {
    const code = scriptForEval(classicImportsRewritten(text, url).code);
    if (tooLongForEval(code)) {
      // The text of one of the app's long files, read and handed back (jQuery's $.getScript): its compiled function.
      const compiled = this.standbyByText.get(text);
      if (compiled) return { fn: compiled };
      return { error: `A script (${from}) is more than the engine compiles at once while the app runs (64 KB). One of the app's own script files is compiled with the app when it starts, and runs when a script the app adds names it, or is given its text; this one is not one of those.` };
    }
    return { code };
  }

  /** A script the app added, by its address: one of its own files (compiled with it if too long for eval), or one from a site it may reach. */
  private async loadScript(url: string): Promise<{ code: string } | { fn: string } | { error: string }> {
    if (url.startsWith(`${VIRTUAL_ORIGIN}/`)) {
      let path: string;
      try {
        path = decodeURIComponent(url.slice(VIRTUAL_ORIGIN.length + 1).split(/[?#]/)[0]);
      } catch {
        return { error: `There is no script at ${url}` };
      }
      const compiled = this.standbyScripts.get(path);
      if (compiled) return { fn: compiled };
      const refused = this.standbyRefused.get(path);
      if (refused) return { error: `The script ${path} did not compile when the app started: ${refused}` };
      const text = this.textFiles[path];
      if (text === undefined) return { error: `There is no script at ${url}` };
      return this.scriptReady(text, url);
    }
    if (!/^https?:/i.test(url)) return { error: `A script is not loaded from ${url} here` };
    if (!isExternalUrlAllowed(url, this.permissions.permissions?.net, this.grantedCapabilities.has('net'))) {
      return { error: `Network access to ${url} is not permitted by this container` };
    }
    // As a module from another site is: without the person's cookies, and not by a redirect
    // (a host the app was granted could send it on to one it was not).
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: cacheModeFor(url, undefined) });
    if (!response.ok) return { error: `HTTP ${response.status} loading ${url}` };
    const text = await (await blobWithin(response, MAX_REMOTE_SCRIPT_BYTES)).text();
    return this.scriptReady(text, url);
  }

  /**
   * A part written or removed in a commit, kept with the rest of it until it ends: held, names
   * and all, to the room a commit has, and refused before it is kept. (Only the text was
   * counted, after it was kept: removes of long names, never ended, held the Worker's memory
   * without a limit.)
   */
  private stageIdbPart(name: string, text: string | null): void {
    const staged = this.idbStaged;
    if (!staged) return;
    const before = staged.get(name);
    const weight = (value: string | null | undefined) => (value === undefined ? 0 : name.length + STAGED_PART_CHARS + (value === null ? 0 : value.length));
    const after = this.idbStagedChars + weight(text) - weight(before);
    const room = (this.idbApart ? this.idbQuotaBytes : this.storageQuotaBytes) / 2;
    if (after > room || (before === undefined && staged.size >= MAX_STAGED_PARTS)) throw new Error('QuotaExceededError: container storage quota exceeded');
    staged.set(name, text);
    this.idbStagedChars = after;
  }

  /** A key let go of, and what it held given back to the budget. */
  private dropCryptoKey(id: string): void {
    this.cryptoKeys.delete(id);
    const weight = this.cryptoKeyWeights.get(id);
    if (weight === undefined) return;
    this.cryptoKeyBytes -= weight;
    this.cryptoKeyWeights.delete(id);
  }

  /**
   * Work done in a task of its own, after what is under way: handed over in the same turn, a
   * message and its answer went deeper with each, and the app's own calls ran out of order.
   * A few at a time, for a few milliseconds, so that what the page sends is heard between.
   */
  private postTask(work: () => void): void {
    if (this.disposed) return;
    this.tasks.push(work);
    // One run at a time, scheduled or under way: a run takes what is added while it runs.
    // (Scheduled each time the list was empty, a message and its answer scheduled a run at
    // every step, two thousand of them for a thousand round trips.)
    if (this.tasksPending) return;
    this.tasksPending = true;
    this.scheduleTasks();
  }

  private scheduleTasks(): void {
    if (this.disposed) return;
    const now = performance.now();
    // A timer's turn at least every 16 ms: through a port alone, a run of messages kept the
    // app's timers waiting till it ended (Node takes up to a thousand messages of a port
    // before it looks at its timers). Through timers alone, a browser waits 4 ms for each.
    if (now - this.tasksYielded > 16 || typeof MessageChannel !== 'function') {
      this.tasksYielded = now;
      setTimeout(() => this.runTasks(), 0);
      return;
    }
    if (!this.taskChannel) {
      this.taskChannel = new MessageChannel();
      this.taskChannel.port1.onmessage = () => this.runTasks();
      // A process (a test's) is not held open by it.
      (this.taskChannel.port1 as MessagePort & { unref?: () => void }).unref?.();
      (this.taskChannel.port2 as MessagePort & { unref?: () => void }).unref?.();
    }
    this.taskChannel.port2.postMessage(null);
  }

  private runTasks(): void {
    const began = performance.now();
    while (this.tasks.length > 0 && !this.disposed) {
      const work = this.tasks.shift()!;
      try {
        work();
      } catch (err) {
        this.reportGuestError('worker', err);
      }
      if (performance.now() - began > 8) break;
    }
    if (this.tasks.length > 0 && !this.disposed) this.scheduleTasks();
    else this.tasksPending = false;
  }

  /** A call into the app's page script, and the turn it makes. */
  private toApp(fn: string, args: unknown[]): void {
    if (!this.engine || this.disposed) return;
    try {
      this.engine.renewInstructionBudget();
      this.callGuest(fn, args);
      this.drainTurn();
    } catch (err) {
      this.reportGuestError('worker', err);
    }
  }

  /**
   * A part written: sent to the page with the rest the turn writes, once the turn is over, and
   * kept there together. (Sent one by one, a transaction was kept a part at a time.)
   */
  private idbWritten(name: string, value: string | null, before: string | undefined): void {
    if (!this.idbWrites) {
      this.idbWrites = new Map();
      this.idbBatchPrev.set(++this.idbBatchId, new Map());
      queueMicrotask(() => this.flushIdbWrites());
    }
    // What it was before the batch: put back if the page does not keep the batch.
    const prev = this.idbBatchPrev.get(this.idbBatchId);
    if (prev && !prev.has(name)) prev.set(name, before);
    this.idbWrites.set(name, value);
  }

  private flushIdbWrites(): void {
    const written = this.idbWrites;
    this.idbWrites = null;
    if (!written || this.disposed) return;
    this.postToHost({ type: 'idb-writes', id: this.idbBatchId, parts: Object.fromEntries(written) });
  }

  /**
   * The page kept a batch of parts, or could not (its storage full or closed to it). Not kept,
   * the parts are put back as they were, and the app's side reads them again; a transaction
   * waiting to know (`idb.kept`) is told, and is undone.
   */
  private idbKept(id: number, ok: boolean): void {
    if (!Number.isInteger(id) || id <= this.idbAcked) return;
    this.idbAcked = id;
    const prev = this.idbBatchPrev.get(id);
    this.idbBatchPrev.delete(id);
    if (!ok) {
      this.idbRefused.add(id);
      if (this.idbRefused.size > 256) this.idbRefused.delete(this.idbRefused.values().next().value as number);
      // What the parts were is what they are again, before the app's side hears anything.
      for (const [name, before] of prev ?? []) {
        const now = this.idbStore.get(name);
        this.idbBytes += (before === undefined ? 0 : (name.length + before.length) * 2) - (now === undefined ? 0 : (name.length + now.length) * 2);
        if (before === undefined) this.idbStore.delete(name);
        else this.idbStore.set(name, before);
      }
    }
    // The transactions waiting are told first (one not kept is undone, and puts itself back as
    // it was); then the app's side reads again the parts put back.
    const answered = this.idbKeptWaiters.filter((waiter) => waiter.id <= this.idbAcked);
    this.idbKeptWaiters = this.idbKeptWaiters.filter((waiter) => waiter.id > this.idbAcked);
    for (const waiter of answered) this.resolveCallbackAndFlush(waiter.callId, { ok: !this.idbRefused.has(waiter.id) });
    if (!ok && this.engine && !this.disposed && this.language !== 'python') {
      for (const name of prev?.keys() ?? []) {
        try {
          this.engine.renewInstructionBudget();
          this.callGuest('__softnContainerIdbChanged', [name]);
          this.drainTurn();
        } catch (err) {
          this.reportGuestError('storage', err);
        }
      }
    }
  }

  /** What the app's IndexedDB takes of the quota it shares with its localStorage: nothing where it is kept apart. */
  private idbSharedBytes(): number {
    return this.idbApart ? 0 : this.idbBytes;
  }

  /** Say once, to the app's console. */
  private warnOnce(key: string, text: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.postToHost({ type: 'console', level: 'warn', text: `[SoftN] ${text}` });
  }

  /** A read of a canvas the app asked for at once: what it drew since, on every canvas, drawn on the copies first. */
  private readMirror(kind: string, args: string[]): unknown {
    if (!this.mirrorCanvases) return { refused: 'error' };
    let batches: unknown = [];
    try {
      batches = JSON.parse(String(args[3] ?? '[]'));
    } catch {
      batches = [];
    }
    if (Array.isArray(batches)) {
      for (const batch of batches) {
        if (!Array.isArray(batch)) continue;
        const [id, width, height, cmds] = batch as [unknown, unknown, unknown, unknown];
        if (typeof id !== 'number' || typeof width !== 'number' || typeof height !== 'number') continue;
        this.drawMirror(id, width, height, cmds === null ? null : Array.isArray(cmds) ? (cmds as Canvas2DCmd[]) : []);
      }
    }
    const mirror = this.mirrorOf(Number(args[0]), Number(args[1]), Number(args[2]));
    if (!mirror) return { refused: 'size' };
    if (mirror.unreadable) return { tainted: true };
    const lacking = mirror.partial ? 'partial' : mirror.missing ? 'missing' : undefined;
    const { width, height } = mirror.canvas;
    if (kind === 'canvas.dataurl') {
      // Made only as far as an answer carries: past it there is no answer, and no use making all of it.
      const png = encodePng(width, height, mirror.ctx.getImageData(0, 0, width, height).data, Math.floor(((MAX_DATA_URL_LENGTH - 22) * 3) / 4) - 64);
      if (!png) return { refused: 'large' };
      const url = `data:image/png;base64,${bytesToBase64(png)}`;
      return url.length > MAX_DATA_URL_LENGTH ? { refused: 'large' } : { url, lacking };
    }
    const w = Math.max(1, Math.floor(Number(args[6]) || 0));
    const h = Math.max(1, Math.floor(Number(args[7]) || 0));
    if (w * h > MAX_PIXELS_AN_ANSWER) return { refused: 'large' };
    const data = mirror.ctx.getImageData(Math.floor(Number(args[4]) || 0), Math.floor(Number(args[5]) || 0), w, h).data;
    // As numbers, which the app's side reads at once (as base64, it read them a byte at a time).
    return { pixels: Array.from(data), lacking };
  }

  /** The Worker's copy of a canvas, made when the app first draws on it or reads it; the most lately used kept longest. */
  private mirrorOf(id: number, width: number, height: number): MirrorCanvas | null {
    if (!Number.isInteger(id)) return null;
    const w = canvasSide(width);
    const h = canvasSide(height);
    if (w <= 0 || h <= 0) return null;
    let mirror = this.mirrors.get(id);
    if (mirror) {
      this.mirrors.delete(id);
      if (mirror.canvas.width !== w || mirror.canvas.height !== h) {
        this.mirrorPixels -= mirror.canvas.width * mirror.canvas.height;
        if (!this.makeRoomForMirror(w * h)) {
          this.lostMirrors.add(id);
          return null;
        }
        mirror.canvas.width = w;
        mirror.canvas.height = h;
        mirror.missing = false;
        this.mirrorPixels += w * h;
      }
      this.mirrors.set(id, mirror);
      return mirror;
    }
    if (!this.makeRoomForMirror(w * h)) return null;
    // Held to a count as well as to pixels: a copy of a canvas of one pixel is a canvas still.
    for (const [oldest, other] of this.mirrors) {
      if (this.mirrors.size < MAX_MIRRORS) break;
      this.letGoOfMirror(oldest, other);
    }
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      // A copy made again for a canvas that could not be read back cannot be either: what was
      // drawn into it is drawn into it still.
      mirror = { canvas, ctx, unreadable: this.unreadableMirrors.has(id), missing: false, partial: this.lostMirrors.has(id) };
      this.mirrors.set(id, mirror);
      this.mirrorPixels += w * h;
      return mirror;
    } catch {
      return null;
    }
  }

  /** Let go of the copies least lately used until `pixels` more fit; false when one canvas is past all of it. */
  private makeRoomForMirror(pixels: number): boolean {
    if (pixels > MAX_MIRROR_PIXELS) return false;
    for (const [id, other] of this.mirrors) {
      if (this.mirrorPixels + pixels <= MAX_MIRROR_PIXELS) break;
      this.letGoOfMirror(id, other);
    }
    return this.mirrorPixels + pixels <= MAX_MIRROR_PIXELS;
  }

  /** A copy let go of, least lately used first: its memory given back now, and what it was remembered. */
  private letGoOfMirror(id: number, other: MirrorCanvas): void {
    {
      this.mirrors.delete(id);
      this.mirrorPixels -= other.canvas.width * other.canvas.height;
      // Its memory now, not when it is collected.
      other.canvas.width = 1;
      other.canvas.height = 1;
      this.lostMirrors.add(id);
      if (other.unreadable) this.unreadableMirrors.add(id);
      // Remembered within a count: ids are the app's to make.
      for (const set of [this.lostMirrors, this.unreadableMirrors]) if (set.size > MAX_REMEMBERED_MIRRORS) set.delete(set.values().next().value as number);
      this.warnOnce(
        'mirror-let-go',
        `The Worker let go of its copy of a canvas the app had not drawn on lately, to keep its copies of canvases within ${MAX_MIRROR_PIXELS} pixels and ${MAX_MIRRORS} canvases: if the app reads that canvas back, what was drawn on it before then is not in the answer.`
      );
    }
  }

  /** Draw on the Worker's copy what the app drew on its canvas; null commands clear it (the app set its size). */
  private drawMirror(id: number, width: number, height: number, cmds: readonly Canvas2DCmd[] | null): MirrorCanvas | null {
    if (cmds === null) {
      // No copy yet: nothing to clear, and the next drawing makes one at this size.
      if (!this.mirrors.has(id)) return null;
      const mirror = this.mirrorOf(id, width, height);
      if (mirror) {
        // Set even to the size it has: setting it is what clears a canvas, its state too.
        const { width: same } = mirror.canvas;
        mirror.canvas.width = same;
        mirror.missing = false;
      }
      return mirror;
    }
    const mirror = this.mirrorOf(id, width, height);
    if (!mirror || !Array.isArray(cmds) || cmds.length === 0) return mirror;
    try {
      replayCanvasCommands(mirror.ctx, cmds, (ref) => {
        // Another canvas of the app's: its copy here. (One with no copy has had nothing drawn on it.)
        if (ref.startsWith('node:')) {
          const other = this.mirrors.get(Number(ref.slice(5)));
          if (other) {
            if (other.unreadable) mirror.unreadable = true;
            if (other.missing || other.partial) mirror.missing = true;
            return other.canvas;
          }
        }
        const picture = this.mirrorPictures.get(ref);
        if (!picture) {
          // A picture never named here, or one let go of: what is read back lacks it.
          if (!ref.startsWith('node:') || this.forgottenPictures.has(ref)) mirror.missing = true;
          return null;
        }
        this.mirrorPictures.delete(ref);
        this.mirrorPictures.set(ref, picture);
        // A picture from the network is the page's to show and not the app's to read: as on the page.
        if (picture.foreign) {
          mirror.unreadable = true;
          return null;
        }
        if (picture.bitmap) return picture.bitmap;
        // Not decoded yet, or let go of: decoded (again) for the next time it is drawn.
        mirror.missing = true;
        if (!picture.decoding && !picture.failed) this.decodePicture(ref, picture);
        return null;
      });
    } catch {
      // A command the context would not take: the copy is as far as it got.
    }
    return mirror;
  }

  /** What a turn drew, drawn on the copies; and the blobs the app made addresses for, kept for the pictures drawn from them. */
  private mirrorOps(ops: readonly ShellOp[]): void {
    for (const op of ops) {
      if (op[0] === 'k2d') {
        if (op[5] !== 'mirrored') this.drawMirror(op[1], op[2], op[3], op[4]);
      } else if (op[0] === 'k2dreset') {
        if (op[4] !== 'mirrored') this.drawMirror(op[1], op[2], op[3], null);
      } else if (op[0] === 'k2dgone') {
        // The app let go of the canvas: so does the Worker, of its copy.
        const gone = this.mirrors.get(op[1]);
        if (gone) {
          this.mirrors.delete(op[1]);
          this.mirrorPixels -= gone.canvas.width * gone.canvas.height;
          gone.canvas.width = 1;
          gone.canvas.height = 1;
        }
        this.lostMirrors.delete(op[1]);
        this.unreadableMirrors.delete(op[1]);
      } else if (op[0] === 'blob') {
        this.keepMirrorBlob(op[1], op[2], op[3]);
      } else if (op[0] === 'unblob' && typeof op[1] === 'string') {
        const gone = this.mirrorBlobs.get(op[1]);
        if (gone) {
          this.mirrorBlobs.delete(op[1]);
          this.mirrorBlobBytes -= gone.bytes.byteLength;
        }
      }
    }
  }

  /** A blob the app made an address for, kept while it may be a picture drawn into a canvas: an image's, or one of no kind. */
  private keepMirrorBlob(id: unknown, type: unknown, given: unknown): void {
    // An id by the page's rule for one: any other names no address the page made.
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return;
    const kind = typeof type === 'string' ? type.toLowerCase() : '';
    if (kind !== '' && !kind.startsWith('image/')) return;
    if (piecesSize(given) > MAX_MIRROR_BLOB_BYTES) return;
    let bytes: Uint8Array | null;
    try {
      bytes = piecesToBytes(given);
    } catch {
      return;
    }
    if (!bytes) return;
    const before = this.mirrorBlobs.get(id);
    if (before) {
      this.mirrorBlobs.delete(id);
      this.mirrorBlobBytes -= before.bytes.byteLength;
    }
    for (const [oldest, kept] of this.mirrorBlobs) {
      if (this.mirrorBlobBytes + bytes.byteLength <= MAX_MIRROR_BLOB_BYTES && this.mirrorBlobs.size < MAX_MIRROR_BLOBS) break;
      this.mirrorBlobs.delete(oldest);
      this.mirrorBlobBytes -= kept.bytes.byteLength;
    }
    this.mirrorBlobs.set(id, { type: kind, bytes });
    this.mirrorBlobBytes += bytes.byteLength;
    // Pictures whose address is this blob's, set before its bytes came: decoded now.
    const address = `blob:${VIRTUAL_ORIGIN}/${id}`;
    for (const [ref, picture] of this.mirrorPictures) {
      if (picture.src === address && !picture.bitmap && !picture.decoding && !picture.failed) this.decodePicture(ref, picture, true);
    }
  }

  /**
   * Make a picture the app draws into a canvas ready here, from when its address is set: a
   * file of the app's own, a blob it made an address for, data written into the address. One
   * from the network is not fetched here; a canvas it is drawn into is not read back, here as
   * on the page.
   */
  private loadMirrorPicture(ref: string, src: string, basePath: string, how: 'early' | 'drawn' | 'none', cors = false): void {
    if (!this.mirrorCanvases || !ref || ref.length + src.length + basePath.length > MAX_PICTURE_ADDRESS_CHARS / 4 || basePath.length > 4096) return;
    // What the copies cannot have (a video's frame): known as such, so a read-back says it lacks it.
    if (how === 'none') {
      if (!this.mirrorPictures.has(ref)) this.setPicture(ref, { src: '', basePath, bitmap: null, pixels: 0, foreign: false, cors: false, decoding: null, failed: true });
      return;
    }
    // The same picture under another name (its node, once it is on the page; its address,
    // while it is on none): one decoding for both.
    if (!this.mirrorPictures.has(ref)) {
      for (const [otherRef, other] of this.mirrorPictures) {
        if (otherRef === ref || other.src !== src || other.basePath !== basePath || other.cors !== cors) continue;
        this.setPicture(ref, other);
        return;
      }
    }
    const known = this.mirrorPictures.get(ref);
    if (known) {
      if (known.src === src && known.cors === cors) {
        this.mirrorPictures.delete(ref);
        this.mirrorPictures.set(ref, known);
        if (!known.bitmap && !known.decoding && !known.failed && !known.foreign) this.decodePicture(ref, known);
        return;
      }
      this.deletePicture(ref);
    }
    const picture: MirrorPicture = { src, basePath, bitmap: null, pixels: 0, foreign: false, cors, decoding: null, failed: false };
    this.setPicture(ref, picture);
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(blob|data):/i.test(src) && !src.startsWith(`${VIRTUAL_ORIGIN}/`)) {
      // From another site: a canvas it is drawn into cannot be read back, as in a browser,
      // unless it was asked for with CORS from a site the app may reach that allows it.
      // (Fetched as it loads, as the app's own pictures are decoded: one asked for with CORS
      // is one the app means to read back, and it reads it back as soon as it has drawn it.)
      if (!cors || !this.mayReadRemotePicture(src)) {
        picture.foreign = true;
        return;
      }
    }
    this.decodePicture(ref, picture, how === 'early');
  }

  /**
   * Whether a picture from another site may be fetched here for the copies, with CORS and
   * without cookies: an address of http(s) the app was allowed to reach, and not of the
   * embedding page's own site (where the page's request carries the person's cookies).
   */
  private mayReadRemotePicture(src: string): boolean {
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (typeof location !== 'undefined' && url.origin === location.origin) return false;
    return isExternalUrlAllowed(url.href, this.permissions.permissions?.net, this.grantedCapabilities.has('net'));
  }

  /** A picture under a name, within what is kept of pictures by count and by the length of their names and addresses. */
  private setPicture(ref: string, picture: MirrorPicture): void {
    if (this.mirrorPictures.has(ref)) this.deletePicture(ref, false);
    this.mirrorPictures.set(ref, picture);
    this.pictureChars += ref.length + picture.src.length + picture.basePath.length;
    this.forgottenPictures.delete(ref);
    for (const oldest of [...this.mirrorPictures.keys()]) {
      if (this.mirrorPictures.size <= MAX_MIRROR_PICTURES && this.pictureChars <= MAX_PICTURE_ADDRESS_CHARS) break;
      if (oldest !== ref) this.deletePicture(oldest);
    }
  }

  /** A picture's name let go of; its bitmap too when no other name has it. */
  private deletePicture(ref: string, remember = true): void {
    const picture = this.mirrorPictures.get(ref);
    if (!picture) return;
    this.mirrorPictures.delete(ref);
    this.pictureChars -= ref.length + picture.src.length + picture.basePath.length;
    let shared = false;
    for (const other of this.mirrorPictures.values()) if (other === picture) shared = true;
    if (!shared) this.forgetPicture(picture);
    // Remembered by a name of an address's length at most: the names are the app's to choose.
    if (!remember || ref.length > 2048) return;
    this.forgottenPictures.add(ref);
    if (this.forgottenPictures.size > MAX_FORGOTTEN_PICTURES) {
      const oldest = this.forgottenPictures.values().next().value;
      if (oldest !== undefined) this.forgottenPictures.delete(oldest);
    }
  }

  private forgetPicture(picture: MirrorPicture): void {
    if (!picture.bitmap) return;
    this.picturePixels -= picture.pixels;
    picture.bitmap.close();
    picture.bitmap = null;
    picture.pixels = 0;
  }

  /** The bytes a picture is decoded from, read from its address as the Worker has them. */
  private pictureBytes(picture: MirrorPicture): { bytes: Uint8Array; type: string } | null {
    const src = picture.src;
    const blobPrefix = `blob:${VIRTUAL_ORIGIN}/`;
    if (src.startsWith(blobPrefix)) {
      const blob = this.mirrorBlobs.get(src.slice(blobPrefix.length));
      return blob ? { bytes: blob.bytes, type: blob.type } : null;
    }
    if (/^data:/i.test(src)) {
      const found = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(src);
      if (!found) return null;
      try {
        return { bytes: found[2] ? base64ToBytes(found[3]) : new TextEncoder().encode(decodeURIComponent(found[3])), type: found[1] };
      } catch {
        return null;
      }
    }
    const path = resolveVfsPath(src, picture.basePath.replace(/^\/+/, '') || 'index.html');
    return path && path in this.binaryFiles ? { bytes: this.binaryFiles[path], type: mimeTypeFor(path) } : null;
  }

  /** Decode a picture for the copies; past what the Worker keeps of pictures, the least lately drawn are let go of (and decoded again if drawn again). */
  private decodePicture(ref: string, picture: MirrorPicture, early = false): void {
    const took = (bitmap: ImageBitmap) => {
      picture.decoding = null;
      if (this.disposed || this.mirrorPictures.get(ref) !== picture) {
        bitmap.close();
        return;
      }
      // One picture past all the Worker keeps of pictures is not kept at all.
      if (bitmap.width * bitmap.height > MAX_PICTURE_PIXELS) {
        bitmap.close();
        picture.failed = true;
        this.warnOnce('picture-large', `A picture of ${bitmap.width} by ${bitmap.height} is more than the Worker keeps of pictures for its copies of the app's canvases (${MAX_PICTURE_PIXELS} pixels): a canvas it is drawn into is read back without it.`);
        return;
      }
      picture.bitmap = bitmap;
      picture.pixels = bitmap.width * bitmap.height;
      this.picturePixels += picture.pixels;
      for (const other of this.mirrorPictures.values()) {
        if (this.picturePixels <= MAX_PICTURE_PIXELS) break;
        if (other !== picture) this.forgetPicture(other);
      }
    };
    const lost = () => {
      picture.decoding = null;
      picture.failed = true;
    };
    if (picture.cors && /^https?:/i.test(picture.src) && !picture.src.startsWith(`${VIRTUAL_ORIGIN}/`)) {
      // Asked for with CORS: fetched as the page fetches it, and readable only if its site allows it.
      if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') {
        picture.failed = true;
        return;
      }
      // Never from the browser's copy of an earlier answer (one fetched with cookies may be there).
      picture.decoding = this.decodeInTurn(() => fetch(picture.src, { mode: 'cors', credentials: 'omit', cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // Where a redirect took it: read only from a site the app may read from.
          if (response.redirected && !this.mayReadRemotePicture(response.url)) throw new Error('redirected elsewhere');
          // Read a part at a time and held to its size as it comes (a size said first is not always there, nor true).
          return createImageBitmap(await blobWithin(response, MAX_REMOTE_PICTURE_BYTES));
        })
        .then(took, lost));
      return;
    }
    const found = this.pictureBytes(picture);
    if (!found || typeof createImageBitmap !== 'function') {
      // A blob the app made an address for, whose bytes have not come yet: an address is set
      // in the turn it is made, and the blob comes with that turn's end. Decoded when it comes
      // (keepMirrorBlob); taken for a failure, a thumbnail made from it was blank.
      if (!found && typeof createImageBitmap === 'function' && picture.src.startsWith(`blob:${VIRTUAL_ORIGIN}/`)) return;
      picture.failed = true;
      return;
    }
    // Before it is drawn, an image on the page only of a sprite's or an icon's size: a gallery
    // of photographs whose code names getImageData was every photograph decoded here too, and
    // a larger one is decoded when it is first drawn. An image on no page (new Image()) is
    // made to be drawn, and is decoded whatever its size.
    if (early && ref.startsWith('node:') && found.bytes.byteLength > MAX_EARLY_PICTURE_BYTES) return;
    const copy = new Uint8Array(found.bytes.byteLength);
    copy.set(found.bytes);
    picture.decoding = this.decodeInTurn(() => createImageBitmap(new Blob([copy], { type: found.type })).then(took, lost));
  }

  /**
   * Work that decodes a picture, a few at a time: started now if there is room, else when one
   * before it is done. (Every picture of a gallery was decoded at once.)
   */
  private decodeInTurn(work: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = () => {
        if (this.disposed) {
          resolve();
          return;
        }
        this.decodingNow++;
        void work()
          .catch(() => undefined)
          .then(() => {
            this.decodingNow--;
            resolve();
            this.decodeWaiting.shift()?.();
          });
      };
      if (this.decodingNow < MAX_DECODING) start();
      else this.decodeWaiting.push(start);
    });
  }
  private bytesAfterSaving(name: string, size: number): number {
    // When joining two JSON objects, their adjacent braces become one comma (two bytes less).
    const replacedBytes = this.savedCollectionBytes.get(name) ?? (this.savedCollectionBytes.size ? 2 : 0);
    return this.recordBytesKept - replacedBytes + size;
  }

  private seedDatabase(persisted: Record<string, unknown[]>): void {
    // 1. Seed from `.xdb` files in the container archive first
    for (const [path, content] of Object.entries(this.textFiles)) {
      if (!/\.xdb$/i.test(path)) continue;
      try {
        const parsed = JSON.parse(content) as { collection?: string; records?: unknown[] } | unknown[];
        const baseName = path.slice(path.lastIndexOf('/') + 1).replace(/\.xdb$/i, '');
        const colName = !Array.isArray(parsed) && typeof parsed.collection === 'string' ? parsed.collection : baseName;
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
        const col = new Map<string, DbRecord>();
        for (const item of list) {
          if (item && typeof item === 'object') {
            const rec = item as DbRecord;
            const id = rec.id || `seed_${this.dbRecordSeq++}`;
            const envelopeData =
              rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
                ? (rec.data as Record<string, unknown>)
                : undefined;
            col.set(id, envelopeData ? { ...envelopeData, ...rec, id } : { ...rec, id });
          }
        }
        this.dbCollections.set(colName, col);
      } catch {
        // Ignore malformed seed file
      }
    }
    // Each saved collection is a complete snapshot. Merging seeds back into one would
    // resurrect a hard-deleted starter record every time its app reopened.
    for (const [colName, list] of Object.entries(persisted)) {
      if (!Array.isArray(list)) continue;
      const col = new Map<string, DbRecord>();
      for (const item of list) {
        if (item && typeof item === 'object' && 'id' in item) {
          const rec = item as DbRecord;
          col.set(rec.id, rec);
        }
      }
      this.dbCollections.set(colName, col);
    }
  }

  private notifyCollectionChanged(name: string): void {
    this.changedCollections.add(name);
    if (this.notifyDbTimer !== undefined) return;
    this.notifyDbTimer = setTimeout(() => {
      this.notifyDbTimer = undefined;
      if (this.disposed || !this.engine) return;
      const names = [...this.changedCollections];
      this.changedCollections.clear();
      try {
        this.engine.renewInstructionBudget();
        this.callGuest('__softnContainerDbChanged', [names]);
        this.drainTurn();
      } catch (err) {
        this.reportGuestError('db-subscription', err);
      }
    }, 0);
  }

  private drainConsole(): void {
    if (!this.engine) return;
    for (;;) {
      const entries = this.engine.takeConsole();
      if (!Array.isArray(entries) || entries.length === 0) break;
      for (const entry of entries) {
        // The engine says which stream a line was written to, not which console method wrote
        // it: `{ stream: "stdout" | "stderr", text }`. This read a `level` the engine never
        // gave, so every line an app printed, its errors too, reached the host as a plain
        // log: nothing a host shows or counts as an error (Studio's check of an app) saw one.
        const text = String(entry.text ?? '');
        if (entry.stream !== 'stderr') this.postToHost({ type: 'console', level: 'log', text });
        else if (text.startsWith(WARNING_MARK)) this.postToHost({ type: 'console', level: 'warn', text: text.slice(WARNING_MARK.length).replace(/^ /, '') });
        else this.postToHost({ type: 'console', level: 'error', text });
      }
    }
  }

  private drainFailedConsole(): void {
    if (!this.engine) return;
    try {
      for (;;) {
        const entries = this.engine.takeFailedConsole();
        if (!Array.isArray(entries) || entries.length === 0) break;
        for (const entry of entries) {
          const text = String(entry.text ?? '');
          this.postToHost({ type: 'console', level: 'error', text: text.startsWith(WARNING_MARK) ? text.slice(WARNING_MARK.length).replace(/^ /, '') : text });
        }
      }
    } catch {
      // Engine already freed
    }
  }

  /** Whether the engine has stopped: a ceiling it keeps was passed, and nothing more runs on it. */
  private engineStopped(): boolean {
    if (!this.engine) return true;
    try {
      return Boolean(this.engine.disposed);
    } catch {
      return true;
    }
  }

  /**
   * Tell the host of an error. One the engine stopped with ends the session: its timers,
   * frames, sockets and requests end with it, and the host hears once, in words, why. (The
   * console of a stopped engine is read from the one stream it still answers; it was read
   * from the other, which threw, and the report never went: the app froze without a word.)
   */
  private reportGuestError(phase: string, err: unknown): void {
    if (this.disposed) return;
    const stopped = this.engineStopped();
    try {
      if (stopped) this.drainFailedConsole();
      else this.drainConsole();
    } catch {
      // Nothing more to read from it.
    }
    const message = err instanceof Error ? err.message : String(err);
    this.postToHost({ type: 'error', message: stopped ? stoppedBecause(message) : message, phase, fatal: stopped });
    if (stopped) this.dispose();
  }

  dispose(): void {
    clearTimeout(this.notifyDbTimer);
    if (this.disposed) return;
    for (const worker of [...this.appWorkers.values()]) this.endAppWorker(worker);
    this.disposed = true;
    this.tasks.length = 0;
    this.taskChannel?.port1.close();
    this.taskChannel = null;
    this.cryptoKeys.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets.values()) {
      socket.over = true;
      try {
        socket.ws.close();
      } catch {
        // Already closed
      }
    }
    this.sockets.clear();
    for (const stream of this.streams.values()) {
      stream.over = true;
      stream.abort.abort();
      stream.drained?.();
    }
    this.streams.clear();
    this.bodies.clear();
    for (const p of this.pendingHostReqs.values()) {
      p.reject(new Error('Container worker disposed'));
    }
    this.pendingHostReqs.clear();
    this.webglHost.disposeAll();
    this.threeHost.disposeAll();
    this.mirrors.clear();
    this.mirrorPixels = 0;
    for (const picture of this.mirrorPictures.values()) picture.bitmap?.close();
    this.mirrorPictures.clear();
    this.picturePixels = 0;
    this.pictureChars = 0;
    this.forgottenPictures.clear();
    this.mirrorBlobs.clear();
    this.mirrorBlobBytes = 0;
    this.turnsWaiting.length = 0;
    if (this.engine) {
      try {
        this.engine.dispose();
      } catch {
        // Ignore
      }
      try {
        this.engine.free?.();
      } catch {
        // Ignore
      }
      this.engine = null;
    }
  }
}
