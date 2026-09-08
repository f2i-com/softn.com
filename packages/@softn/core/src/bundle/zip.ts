/**
 * Validated reading of a .softn bundle.
 *
 * A bundle is untrusted input: it arrives by download, drag-and-drop or sync.
 * fflate decompresses to whatever size the archive *declares* and verifies
 * nothing, so without these checks a crafted bundle can hand one reader a
 * truncated file while every other reader sees the whole one — and can inflate
 * far beyond what its compressed size suggests.
 *
 * The walk over the central directory below is not a preflight in front of
 * `unzipSync`; it *is* the index every read goes through. It used to be a
 * preflight, and that split was the bug: the two halves disagreed about which
 * archive they were looking at. `unzipSync` takes its entry count from EOCD+8
 * ("entries on this disk") while the checks read EOCD+10 ("total entries"), so
 * a two-byte edit made the checks inspect one entry while fflate inflated every
 * one of them — and by the time control came back the whole archive was
 * already in memory, with the caps, the checksums and the size declarations
 * all unverified. Owning the loop means every byte allocated has been charged
 * against a budget first.
 *
 * Reading is split in two: `openBundleArchive` validates the central directory
 * and returns an index, and each entry's bytes are produced — and checked — on
 * the read that first asks for them. `readBundleEntries` is that index read in
 * full, so the eager readers (the inspector, the builder, the studio importer)
 * and the demand-driven hosts (softn-web, softn-single) go through one
 * interpretation of headers, names, sizes and checksums. A worker that inflates
 * ahead of the main thread calls `inflateEntries`, which is the same index and
 * the same read, and whatever it hands back is verified again on the main
 * thread before it is accepted.
 *
 * This lives in core because it was previously duplicated: softn-web and
 * softn-loader each carried a hardened copy, while the builder opened bundles
 * through a bare `unzipSync` with none of it. Opening a hostile .softn in the
 * builder therefore bypassed every defence the other two paths had.
 */

import { inflateSync } from 'fflate';

export const MAX_ZIP_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * How much declared payload one warm-up step inflates before yielding. Two
 * megabytes inflate in a few milliseconds and checksum in fewer, so the main
 * thread's share of a warm-up — the synchronous fallback, or verifying what a
 * worker produced — stays under a frame per step.
 */
const WARM_CHUNK_BYTES = 2 * 1024 * 1024;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** What the central directory claims about one entry, and where its bytes are. */
interface DeclaredEntry {
  name: string;
  crc32: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
}

/**
 * CRC-32 — the only field in a ZIP that actually attests to an entry's bytes.
 *
 * fflate decompresses to the *declared* size and verifies nothing, so a bundle
 * that understates a size is silently truncated to it. Comparing the length
 * back against the declaration does not help: the lie is self-consistent. Only
 * the checksum catches it, and without it the same file reads differently here
 * than in any other reader.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function readCentralDirectory(data: Uint8Array): DeclaredEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const CEN_SIGNATURE = 0x02014b50;
  const LFH_SIGNATURE = 0x04034b50;
  const MAX_COMMENT = 0xffff;
  const eocdMinOffset = Math.max(0, data.byteLength - (22 + MAX_COMMENT));

  let eocdOffset = -1;
  for (let i = data.byteLength - 22; i >= eocdMinOffset; i--) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    // Binary payloads — images especially — contain these four bytes often
    // enough that the signature alone is not proof. A real EOCD is preceded by
    // the central directory it describes, so require that to fit.
    const candidateSize = view.getUint32(i + 12, true);
    const candidateOffset = view.getUint32(i + 16, true);
    if (candidateOffset + candidateSize <= i) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP: missing end-of-central-directory');
  }

  // The two entry counts are separate 16-bit fields and nothing in the format
  // forces them to agree. Different readers pick different ones, so an archive
  // whose fields disagree is one that does not have a single meaning — reject
  // it rather than choose.
  const entriesThisDisk = view.getUint16(eocdOffset + 8, true);
  const entriesTotal = view.getUint16(eocdOffset + 10, true);
  if (entriesThisDisk !== entriesTotal) {
    throw new Error('Corrupt ZIP: end-of-central-directory entry counts disagree');
  }
  const entryCount = entriesThisDisk;
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('Bundle has too many files');
  }

  const declared: DeclaredEntry[] = [];
  const seenLocalHeaders = new Set<number>();
  const seenNames = new Set<string>();
  const decoder = new TextDecoder();
  let offset = centralDirOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP central directory entry');
    }

    const method = view.getUint16(offset + 10, true);
    const declaredCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('ZIP64 bundles are not supported');
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`Unsupported compression method in bundle: ${method}`);
    }
    // A stored entry is its own compressed form, so the two sizes describing it
    // have to be the same number. Letting them differ meant the budget was
    // charged one figure while the extraction copied the other.
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
      throw new Error('Corrupt ZIP: stored entry declares two different sizes');
    }
    if (uncompressedSize > MAX_ZIP_FILE_BYTES) {
      throw new Error('File too large in bundle');
    }

    // Two entries pointing at one local header is how a small archive claims a
    // large payload many times over: the budget below is charged once per
    // entry, but the bytes are extracted once per entry too.
    if (seenLocalHeaders.has(localHeaderOffset)) {
      throw new Error('Corrupt ZIP: two entries share a local header');
    }
    seenLocalHeaders.add(localHeaderOffset);

    // The compressed bytes have to actually exist in the file. A stored entry
    // extracts `compressedSize` bytes regardless of what it claims uncompressed,
    // so budgeting only the uncompressed figure left that path unbounded.
    totalCompressed += compressedSize;
    if (totalCompressed > data.byteLength) {
      throw new Error('Corrupt ZIP: entries claim more data than the file holds');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Bundle contents too large');
    }

    if (localHeaderOffset + 30 > data.byteLength) {
      throw new Error('Corrupt ZIP: local header out of bounds');
    }
    if (view.getUint32(localHeaderOffset, true) !== LFH_SIGNATURE) {
      throw new Error('Corrupt ZIP: invalid local file header');
    }

    // The name and extra field of the *local* header may differ in length from
    // the central directory's copy, so the payload can only be located here.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > data.byteLength) {
      throw new Error('Corrupt ZIP: entry data out of bounds');
    }

    const nameBytes = data.slice(offset + 46, offset + 46 + fileNameLength);
    const name = decoder.decode(nameBytes).replace(/\\/g, '/');

    // Two records under one name mean the archive has no single meaning. Names
    // take part in no checksum, so both records pass every integrity check, and
    // which one wins is reader-dependent — .NET keeps the first, this reader and
    // fflate keep the last. A bundle could therefore show an inspector one
    // manifest.json and hand the runtime another. Refuse it rather than pick.
    if (seenNames.has(name)) {
      throw new Error(`Corrupt ZIP: two entries share the name ${name}`);
    }
    seenNames.add(name);

    declared.push({
      name,
      crc32: declaredCrc,
      method,
      compressedSize,
      uncompressedSize,
      dataOffset,
    });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return declared;
}

/**
 * Produce one entry's bytes, allocating no more than it declared.
 *
 * fflate writes into the buffer it is handed and never grows it, and a write
 * past the end of a typed array is discarded rather than resized — so an entry
 * whose deflate stream expands beyond its declared size costs the declared size
 * and no more. What comes back is then short or wrong, and the checksum below
 * refuses it.
 */
function extractEntry(data: Uint8Array, entry: DeclaredEntry): Uint8Array {
  const raw = data.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === METHOD_STORED) {
    return raw.slice();
  }
  try {
    return inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) });
  } catch {
    throw new Error(`Corrupt bundle: could not decompress ${entry.name}`);
  }
}

/**
 * Check what came out against what the archive claimed. Without this a crafted
 * bundle silently hands this reader a truncated file while every other reader
 * sees the whole one. The same check stands between a worker's output and the
 * memo: bytes produced off the main thread are accepted on exactly the terms
 * bytes produced on it are.
 */
function verifyEntry(content: Uint8Array, entry: DeclaredEntry): Uint8Array {
  if (content.byteLength !== entry.uncompressedSize) {
    throw new Error(`Corrupt bundle: size mismatch for ${entry.name}`);
  }
  if (crc32(content) !== entry.crc32) {
    throw new Error(`Corrupt bundle: checksum mismatch for ${entry.name}`);
  }
  return content;
}

/** Names that cannot refer to a file inside a bundle, and are only ever escapes. */
function isUnsafeEntryName(path: string): boolean {
  if (
    path.startsWith('/') ||
    path.includes('..') ||
    path.includes('\0') ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return true;
  }
  // `.` and empty segments survive the substring checks above but still make a
  // path that names the same file two ways.
  return path.split('/').some((segment) => segment === '.' || segment === '');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Bundle warm-up aborted', 'AbortError');
}

/** Entries grouped so each group's declared payload is about one warm-up step. */
function chunkByDeclaredSize(entries: DeclaredEntry[]): DeclaredEntry[][] {
  const chunks: DeclaredEntry[][] = [];
  let current: DeclaredEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (current.length > 0 && bytes + entry.uncompressedSize > WARM_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entry.uncompressedSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface BundleWarmOptions {
  /** Stops the warm-up at the next step boundary; `warm` rejects with its reason. */
  signal?: AbortSignal;
  /**
   * Produces the bytes of entries not yet read, typically in a worker. It is
   * handed a step's worth of names at a time and may return fewer than asked;
   * whatever it returns is size- and checksum-verified here before it is kept,
   * and whatever it omits is read synchronously. If it rejects, the rest of the
   * warm-up runs synchronously — an extractor that fails is abandoned, not
   * retried.
   */
  extract?: (names: string[]) => Promise<Map<string, Uint8Array>>;
}

/**
 * A validated bundle: the central directory checked in full, each entry's
 * bytes produced on the first read that asks for them.
 *
 * Every read is charged against the same running budget the eager reader
 * charged — before its buffer is allocated — and verified against the same
 * declared size and CRC-32, so a corrupt entry throws the same "Corrupt
 * bundle: …" error it always did, on the read that touches it rather than at
 * open. Bytes once produced are kept, so a template that asks for one image
 * fifty times inflates it once. `release()` drops them, and the archive with
 * them; after that `read`, `readAll` and `warm` throw, while the index —
 * `names`, `has`, `declaredSize` — still answers, so a host can tell "was never
 * in the bundle" from "is no longer held".
 *
 * Two things keep the memory this costs to what is in use. A caller that has
 * taken what it needs from an entry — a host that decoded a text entry into
 * the string it will keep — can `forget()` it, which drops the bytes and
 * refunds the budget; while the archive still has the bundle, a later read
 * inflates the entry again. And once every entry has been produced at least
 * once, the archive drops its reference to the bundle bytes of its own accord
 * (`compact()`, also callable): nothing left to inflate means nothing that
 * needs the compressed form, and for a bundle of already-compressed media
 * keeping it was a second copy of the whole thing. After that, an entry that
 * is held is still read from the memo, and one that was forgotten cannot be
 * produced again and says so.
 */
export class BundleArchive {
  private data: Uint8Array | null;
  /**
   * `open` while the bundle bytes are held; `compact` once they have been
   * dropped because every entry was produced; `released` after `release()`.
   * Kept apart from `data` being null so `released` keeps its meaning — a
   * compacted archive still serves the reads it holds.
   */
  private lifecycle: 'open' | 'compact' | 'released' = 'open';
  /** Kept entries in central-directory order; directory and unsafe names are already gone. */
  private readonly entries = new Map<string, DeclaredEntry>();
  private readonly memo = new Map<string, Uint8Array>();
  /**
   * Entries whose own bytes failed verification, remembered so a renderer
   * asking for a broken image on every frame does not inflate it on every
   * frame. Only the archive's own bytes count: a rejected `extract` result
   * says nothing about the entry, and is not recorded here.
   */
  private readonly failures = new Map<string, Error>();
  /**
   * Every entry whose bytes have been produced and verified at least once,
   * held now or forgotten since. With `failures` it says when the bundle
   * bytes have nothing left to give: the two are disjoint, because a memo hit
   * answers before a failure is recorded and a failure is never memoised.
   */
  private readonly produced = new Set<string>();
  private held = 0;

  constructor(data: Uint8Array) {
    if (data.byteLength > MAX_ZIP_INPUT_BYTES) {
      throw new Error('Bundle too large');
    }
    this.data = data;
    for (const entry of readCentralDirectory(data)) {
      if (entry.name.endsWith('/')) continue;
      if (isUnsafeEntryName(entry.name)) continue;
      this.entries.set(entry.name, entry);
    }
  }

  /** Every file the bundle holds, in central-directory order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The size the central directory declares for an entry; what `read` will hold. */
  declaredSize(name: string): number | undefined {
    return this.entries.get(name)?.uncompressedSize;
  }

  /** Whether `read(name)` would return without inflating. */
  isRead(name: string): boolean {
    return this.memo.has(name);
  }

  /** Declared bytes of every entry currently held — what the memo costs. */
  heldBytes(): number {
    return this.held;
  }

  get released(): boolean {
    return this.lifecycle === 'released';
  }

  /** Whether the bundle bytes have been dropped because every entry was produced. */
  get compacted(): boolean {
    return this.lifecycle === 'compact';
  }

  /**
   * One entry's verified bytes, produced on the first call and kept after it.
   * Undefined for a name the bundle does not hold. Synchronous on purpose: the
   * `asset(path)` an app's templates call is synchronous, and this is what it
   * reads from.
   */
  read(name: string): Uint8Array | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const cached = this.memo.get(name);
    if (cached) return cached;
    const failed = this.failures.get(name);
    if (failed) throw failed;
    if (this.lifecycle === 'released') throw new Error('Bundle archive released');
    if (!this.data) {
      throw new Error(`Bundle archive compacted: ${name} was forgotten and cannot be read again`);
    }

    this.charge(entry);
    let content: Uint8Array;
    try {
      content = verifyEntry(extractEntry(this.data, entry), entry);
    } catch (err) {
      this.held -= entry.uncompressedSize;
      this.failures.set(name, err as Error);
      this.compactIfComplete();
      throw err;
    }
    this.memo.set(name, content);
    this.produced.add(name);
    this.compactIfComplete();
    return content;
  }

  /** Every entry, in central-directory order: the eager reader's result. */
  readAll(): Map<string, Uint8Array> {
    if (this.lifecycle === 'released') throw new Error('Bundle archive released');
    const files = new Map<string, Uint8Array>();
    for (const name of this.entries.keys()) {
      files.set(name, this.read(name) as Uint8Array);
    }
    return files;
  }

  /**
   * Fill the memo for the named entries ahead of the reads that will want
   * them, a step at a time so the main thread is never held for long. Names
   * the bundle lacks and entries already read are skipped. Resolves once every
   * named entry is held; rejects with the first entry that fails verification
   * — from the archive's own bytes or from `extract` — or with the signal's
   * reason. A concurrent synchronous `read` of an entry being warmed is fine:
   * whichever lands first fills the memo and the other finds it.
   */
  async warm(names: Iterable<string>, options: BundleWarmOptions = {}): Promise<void> {
    if (this.lifecycle === 'released') throw new Error('Bundle archive released');
    const { signal } = options;
    let extract = options.extract;

    const wanted: DeclaredEntry[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = this.entries.get(name);
      if (entry && !this.memo.has(name) && !this.failures.has(name)) wanted.push(entry);
    }

    for (const step of chunkByDeclaredSize(wanted)) {
      if (signal?.aborted) throw abortReason(signal);
      // Released while a step was in flight: the host is done with the bundle,
      // and there is nothing left to fill. (Compacted while in flight is the
      // opposite — every entry landed, by the app's own reads — and the memo
      // checks below find nothing pending.)
      if (this.released) return;
      const pending = step.filter((entry) => !this.memo.has(entry.name)).map((e) => e.name);
      if (pending.length === 0) continue;

      if (extract) {
        let produced: Map<string, Uint8Array> | undefined;
        try {
          produced = await extract(pending);
        } catch {
          extract = undefined;
        }
        if (signal?.aborted) throw abortReason(signal);
        if (this.released) return;
        if (produced) {
          for (const name of pending) {
            const bytes = produced.get(name);
            if (bytes && !this.memo.has(name)) this.accept(name, bytes);
          }
        }
        for (const name of pending) {
          if (!this.memo.has(name)) this.read(name);
        }
        continue;
      }

      for (const name of pending) this.read(name);
      await yieldToEventLoop();
    }
  }

  /**
   * Drop one entry's held bytes and refund its budget: for a caller that has
   * taken what it needs from them — a host keeping the decoded string of a
   * text entry, not the bytes it came from — and would otherwise hold the
   * entry twice. Nothing else changes: a later `read` inflates it again from
   * the bundle bytes while the archive has them, and the entry still counts
   * as produced, so forgetting never keeps the archive from compacting. A
   * name not held, or not in the bundle, is a no-op.
   */
  forget(name: string): void {
    const entry = this.entries.get(name);
    if (!entry || !this.memo.delete(name)) return;
    this.held -= entry.uncompressedSize;
  }

  /**
   * Drop the reference to the bundle bytes if every entry has been produced
   * once (held, forgotten since, or failed for good), and say whether they
   * are gone. This runs by itself at the read that completes the set; it is
   * public so a host can ask, and so tests can. For a bundle of media that
   * was already compressed, the bundle bytes are about the size of everything
   * inflated from them, so holding both once everything is out doubles what
   * the tab keeps for no read that could ever need it. Held entries read as
   * before; a forgotten one cannot be produced again. False while incomplete
   * and after `release()`.
   */
  compact(): boolean {
    if (this.lifecycle === 'compact') return true;
    if (this.lifecycle === 'released') return false;
    if (this.produced.size + this.failures.size < this.entries.size) return false;
    this.data = null;
    this.lifecycle = 'compact';
    return true;
  }

  /**
   * Drop every byte held and the archive itself. The index stays, so a host
   * can still ask what the bundle contained; nothing can be read from it.
   */
  release(): void {
    this.data = null;
    this.lifecycle = 'released';
    this.memo.clear();
    this.failures.clear();
    this.held = 0;
  }

  /**
   * Keep bytes something else produced for an entry — a worker running
   * `inflateEntries` on its own copy — on the same terms as bytes produced
   * here: charged to the budget, checked against the declared size and CRC.
   * A worker is a peer, not an authority, and nothing it says is believed
   * without the checksum agreeing.
   */
  private accept(name: string, bytes: Uint8Array): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    verifyEntry(bytes, entry);
    this.charge(entry);
    this.memo.set(name, bytes);
    this.produced.add(name);
    this.compactIfComplete();
  }

  /** The automatic half of `compact()`: called wherever an entry's outcome is settled. */
  private compactIfComplete(): void {
    if (this.lifecycle === 'open') this.compact();
  }

  /**
   * Charged before the buffer is allocated, not after it is filled: this is
   * the whole point of extracting entry by entry, so the cap bounds what the
   * bundle can make this process hold rather than describing it afterwards.
   * The central directory walk has already refused a bundle whose declared
   * total exceeds the cap, so this second line is defence in depth: it holds
   * even if that walk is ever loosened.
   */
  private charge(entry: DeclaredEntry): void {
    this.held += entry.uncompressedSize;
    if (this.held > MAX_ZIP_TOTAL_BYTES) {
      this.held -= entry.uncompressedSize;
      throw new Error('Bundle contents too large');
    }
  }
}

/**
 * Validate a bundle's central directory and return its index, reading no
 * entry yet. Directory entries, absolute paths, paths containing `..` or NUL,
 * and drive-letter paths are dropped rather than indexed: none of them can
 * name a file inside a bundle, and all of them are escape attempts.
 */
export function openBundleArchive(data: Uint8Array): BundleArchive {
  return new BundleArchive(data);
}

/**
 * Read every file in a bundle, rejecting anything that does not check out.
 *
 * Returns normalized path -> bytes. The same index and the same per-entry
 * verification as `openBundleArchive(data).read(name)`, applied to every entry
 * in central-directory order — which is exactly what it is.
 */
export function readBundleEntries(data: Uint8Array): Map<string, Uint8Array> {
  return openBundleArchive(data).readAll();
}

/**
 * The named entries' verified bytes, for a thread that holds its own copy of
 * the archive. Names the bundle lacks are left out; a corrupt entry throws.
 * Every returned view owns its whole buffer — a fresh allocation per entry —
 * so a worker can put each `.buffer` in a transfer list rather than copy it.
 * The main thread verifies what arrives all over again (`BundleArchive.warm`),
 * so this is a speed-up for the reads it would otherwise make itself, never a
 * shortcut past them.
 */
export function inflateEntries(data: Uint8Array, names: Iterable<string>): Map<string, Uint8Array> {
  const archive = openBundleArchive(data);
  const out = new Map<string, Uint8Array>();
  for (const name of names) {
    if (out.has(name)) continue;
    const bytes = archive.read(name);
    if (bytes) out.set(name, bytes);
  }
  return out;
}
