/**
 * Archives no writer produces, each of which used to open.
 *
 * Two kinds. An archive that costs more than it declares: a deflate stream
 * that goes on past the size its entry gives. And an archive that reads one
 * way here and another way in the directory's reader (PHP's ZipArchive, which
 * is libzip): a second central directory, an entry named twice in two fields,
 * a name that only this reader normalises. The directory shows visitors a
 * bundle's name, its declared capabilities and its source from its own
 * reading; the browser runs this reader's. Each fixture below was opened with
 * both and the two disagreed.
 *
 * The honest archives at the end are the other half: what a zip tool writes
 * that looks a little like one of these, and has to keep opening.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync, zipSync } from 'fflate';
import { inflateEntries, openBundleArchive, readBundleEntries } from '../src/zip';
import { concat, craftEnd, craftRecords, craftZip, craftZip64End, crc32, dec, enc, unicodePathExtra } from './craft';

const manifest = (name: string) => enc(JSON.stringify({ name, version: '1.0.0', main: 'main.ui' }));
const CAMERA = enc('{"permissions":{"camera":{"enabled":true}}}');

/** Bytes fflate cannot compress, so a level-0 stream of them is stored blocks of a known layout. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * A deflate stream of 200 KB in stored blocks whose third block header is
 * not a block type at all. A reader that stops when the entry's declared
 * size is passed never gets that far; one that inflates the whole stream
 * trips over it.
 */
function streamWithABadTail(): { payload: Uint8Array; plain: Uint8Array } {
  const plain = noise(200 * 1024);
  const payload = deflateSync(plain, { level: 0 });
  const thirdBlock = 2 * (5 + 65535);
  expect(payload.length).toBeGreaterThan(thirdBlock + 5);
  payload[thirdBlock] = 0x07;
  return { payload, plain };
}

describe('a deflate stream longer than its entry declares', () => {
  it('is refused rather than cut to the declared size', () => {
    // The size and the checksum both sit in the central directory, so an
    // archive can declare the first 16 bytes of a longer stream and give
    // their CRC. fflate fills the buffer it is handed and drops the rest
    // without a word; what came back was 16 bytes with the right checksum.
    const whole = enc('<div>shown</div>' + '<Button onClick={hidden()} />'.repeat(4));
    const shown = whole.subarray(0, 16);
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Overflow') },
      { name: 'main.ui', method: 8, data: whole, uncompressedSize: shown.length, crc: crc32(shown) },
    ]).bytes;
    expect(() => readBundleEntries(zip)).toThrow(/size mismatch for main\.ui: its stream inflates past the size it declares/);
    expect(() => inflateEntries(zip, ['main.ui'])).toThrow(/size mismatch for main\.ui: its stream inflates past the size it declares/);
  });

  it('stops inflating where the declared size is passed', () => {
    const { payload, plain } = streamWithABadTail();
    const zip = craftZip([{ name: 'a.bin', method: 8, payload, uncompressedSize: 1000, crc: crc32(plain.subarray(0, 1000)) }]).bytes;
    // "could not decompress" would mean the reader went on to the bad block,
    // 130 KB of output past the 1000 bytes the entry declared.
    expect(() => readBundleEntries(zip)).toThrow(/size mismatch for a\.bin: its stream inflates past the size it declares/);
  });

  it('lets a few streams fail and then reads nothing more', () => {
    // A stream that fails can have cost a slice of input at deflate's best
    // ratio before it did, whatever its entry declared, and it need not be
    // caught running long: one that ends in a bad block fails as "could not
    // decompress" having done the same work. So the allowance is on failed
    // streams of either kind. One corrupt entry leaves the rest of a bundle
    // readable, as it always has; a bundle made of them is not charged for
    // one at a time.
    const long = (name: string) => {
      const { payload, plain } = streamWithABadTail();
      return { name, method: 8, payload, uncompressedSize: 1000, crc: crc32(plain.subarray(0, 1000)) };
    };
    const unreadable = (name: string) => ({ name, method: 8, payload: new Uint8Array(64).fill(0xff), uncompressedSize: 10, crc: 0 });
    const zip = craftZip([
      { name: 'held.txt', method: 8, data: enc('read first') },
      long('bad1.bin'),
      unreadable('bad2.bin'),
      { name: 'between.txt', method: 8, data: enc('read between') },
      unreadable('bad3.bin'),
      long('bad4.bin'),
      unreadable('bad5.bin'),
      { name: 'after.txt', method: 8, data: enc('never read') },
    ]).bytes;
    const archive = openBundleArchive(zip);
    expect(dec(archive.read('held.txt'))).toBe('read first');
    expect(() => archive.read('bad1.bin')).toThrow(/size mismatch for bad1\.bin: its stream inflates past the size it declares/);
    expect(() => archive.read('bad2.bin')).toThrow(/could not decompress bad2\.bin/);
    expect(dec(archive.read('between.txt'))).toBe('read between');
    expect(() => archive.read('bad3.bin')).toThrow(/could not decompress bad3\.bin/);
    expect(() => archive.read('bad4.bin')).toThrow(/size mismatch for bad4\.bin: its stream inflates past the size it declares/);
    // The fifth is not looked at, and neither is an entry with nothing wrong with it.
    expect(() => archive.read('bad5.bin')).toThrow(/4 of its entries did not inflate/);
    expect(() => archive.read('after.txt')).toThrow(/4 of its entries did not inflate/);
    // What was read stays read, and an entry that failed still says why.
    expect(dec(archive.read('held.txt'))).toBe('read first');
    expect(dec(archive.read('between.txt'))).toBe('read between');
    expect(() => archive.read('bad1.bin')).toThrow(/size mismatch for bad1\.bin: its stream inflates past the size it declares/);
    expect(archive.heldBytes()).toBe('read first'.length + 'read between'.length);
  });

  it('does not count an entry whose bytes inflate and then fail their checksum', () => {
    // That entry cost what it declared, which the size caps already cover.
    const wrong = (name: string) => ({ name, method: 8, data: enc(`contents of ${name}`), crc: 1 });
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
    const archive = openBundleArchive(craftZip([...names.map(wrong), { name: 'fine.txt', method: 8, data: enc('fine') }]).bytes);
    for (const name of names) expect(() => archive.read(name)).toThrow(/checksum mismatch/);
    expect(dec(archive.read('fine.txt'))).toBe('fine');
  });

  it('reads a large honest stream in slices to the same bytes', () => {
    const plain = noise(300 * 1024);
    for (const level of [0, 6] as const) {
      const zip = zipSync({ 'big.bin': plain, 'zeros.bin': new Uint8Array(400 * 1024) }, { level });
      const files = readBundleEntries(zip);
      expect(files.get('big.bin')).toEqual(plain);
      expect(files.get('zeros.bin')).toEqual(new Uint8Array(400 * 1024));
      // A worker transfers each entry's buffer; it has to be the entry and nothing more.
      for (const bytes of files.values()) expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
    }
  });

  it('ignores bytes after a long stream’s last block, as it does after a short one’s', () => {
    // The compressed size may cover more than the stream. Feeding the rest to
    // the inflater a slice at a time would have it copy an ever longer
    // remainder in front of each slice.
    const plain = noise(150 * 1024);
    const padded = concat(deflateSync(plain, { level: 0 }), new Uint8Array(1024 * 1024).fill(0xaa));
    const short = concat(deflateSync(enc('hello')), new Uint8Array(64).fill(0xaa));
    const zip = craftZip([
      { name: 'long.bin', method: 8, data: plain, payload: padded },
      { name: 'short.txt', method: 8, data: enc('hello'), payload: short },
    ]).bytes;
    const files = readBundleEntries(zip);
    expect(files.get('long.bin')).toEqual(plain);
    expect(dec(files.get('short.txt'))).toBe('hello');
  });

  it('still refuses a stream that stops short of its declared size', () => {
    const plain = noise(100 * 1024);
    const zip = craftZip([{ name: 'a.bin', method: 8, data: plain, uncompressedSize: plain.length + 1 }]).bytes;
    expect(() => readBundleEntries(zip)).toThrow(/size mismatch for a\.bin/);
    const small = craftZip([{ name: 'a.txt', method: 8, data: enc('hello'), uncompressedSize: 6 }]).bytes;
    expect(() => readBundleEntries(small)).toThrow(/size mismatch for a\.txt/);
  });
});

describe('an entry flagged as encrypted', () => {
  it('is refused at open', () => {
    // The directory refuses an encrypted entry and so does every reader that
    // would ask for a password. This one never looked at the flag, so plain
    // bytes behind it were a permission.json only the browser could read.
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Encrypted') },
      { name: 'permission.json', data: CAMERA, flags: 1 },
    ]).bytes;
    expect(() => openBundleArchive(zip)).toThrow(/encrypted/i);
  });
});

describe('an archive with two central directories', () => {
  const shown = [
    { name: 'manifest.json', data: manifest('Shown to the directory') },
    { name: 'main.ui', data: enc('<div>harmless</div>') },
  ];
  const run = [
    { name: 'manifest.json', data: manifest('Run in the browser') },
    { name: 'main.ui', data: enc('<div>something else</div>') },
    { name: 'permission.json', data: CAMERA },
  ];

  it('is refused when a ZIP64 end record names the other one', () => {
    // libzip 1.7 (the PHP zip extension on Ubuntu 24.04) and Python take the
    // directory from a ZIP64 end record whenever its locator sits before the
    // ordinary end record, whatever the ordinary one says. This reader took
    // the ordinary one: the directory listed "Shown to the directory" with no
    // capabilities, the browser ran the other with the camera declared.
    const a = craftRecords(shown);
    const b = craftRecords(run, a.body.length);
    const runDirAt = a.body.length + b.body.length;
    const shownDirAt = runDirAt + b.directory.length;
    const zip64At = shownDirAt + a.directory.length;
    const zip = concat(
      a.body,
      b.body,
      b.directory,
      a.directory,
      craftZip64End(shown.length, a.directory.length, shownDirAt, zip64At),
      craftEnd(run.length, b.directory.length, runDirAt)
    );
    expect(() => openBundleArchive(zip)).toThrow(/ZIP64/);
  });

  it('is refused when each has an end record of its own', () => {
    // libzip 1.7 weighs every end record in the last 64 KB and keeps the one
    // whose entries reach furthest into the file; this reader kept the last.
    // [first entries][second entries][second directory][second end, its
    // comment covering the rest][first directory][first end].
    const first = craftRecords(shown);
    const second = craftRecords(run, first.body.length);
    const secondDirAt = first.body.length + second.body.length;
    const firstDirAt = secondDirAt + second.directory.length + 22;
    const zip = concat(
      first.body,
      second.body,
      second.directory,
      craftEnd(run.length, second.directory.length, secondDirAt, new Uint8Array(0), { commentLength: first.directory.length + 22 }),
      first.directory,
      craftEnd(shown.length, first.directory.length, firstDirAt)
    );
    expect(() => openBundleArchive(zip)).toThrow(/more than one end-of-central-directory/);
  });

  it('is refused when the second end record hides in the first one’s comment', () => {
    const first = craftRecords(shown);
    const second = craftRecords(run, first.body.length);
    const firstDirAt = first.body.length + second.body.length;
    const secondDirAt = firstDirAt + first.directory.length;
    const zip = concat(
      first.body,
      second.body,
      first.directory,
      second.directory,
      craftEnd(shown.length, first.directory.length, firstDirAt, new Uint8Array(0), { commentLength: 22 }),
      craftEnd(run.length, second.directory.length, secondDirAt)
    );
    expect(() => openBundleArchive(zip)).toThrow(/more than one end-of-central-directory/);
  });
});

describe('a central directory whose size and count disagree', () => {
  const entries = [
    { name: 'manifest.json', data: manifest('Count') },
    { name: 'main.ui', data: enc('<div/>') },
    { name: 'permission.json', data: CAMERA },
  ];

  it('is refused when the count stops short of the size', () => {
    // Python's zipfile reads records until the size is used up and found
    // three; this reader counted two and never saw permission.json.
    const zip = craftZip(entries, { entriesThisDisk: 2, entriesTotal: 2 }).bytes;
    expect(() => openBundleArchive(zip)).toThrow(/central directory size and entry count disagree/);
  });

  it('is refused when the count runs past the size', () => {
    const zip = craftZip(entries, { entriesThisDisk: 4, entriesTotal: 4 }).bytes;
    expect(() => openBundleArchive(zip)).toThrow(/central directory size and entry count disagree/);
  });
});

describe('a central directory that stops short of the end record', () => {
  it('is refused: some readers move every offset by the gap', () => {
    // Python's zipfile and Info-ZIP's unzip take a gap between the directory
    // and the end record to mean the archive has bytes in front of it, and
    // add the gap to the directory's offset and to every entry's. This reader
    // and libzip use the offsets as written. With a second directory in the
    // gap, of the same size, `unzip` shows one app and the browser runs
    // another.
    const here = craftRecords([
      { name: 'manifest.json', data: manifest('Read at the offset') },
      { name: 'main.ui', data: enc('<div>at the offset</div>') },
    ]);
    const gap = here.directory.length;
    const shifted = craftRecords(
      [
        { name: 'manifest.json', data: manifest('Read after shift') },
        { name: 'main.ui', data: enc('<div>after shift</div>') },
      ],
      here.body.length - gap
    );
    expect(shifted.directory.length).toBe(gap);
    const zip = concat(here.body, shifted.body, here.directory, shifted.directory, craftEnd(2, gap, here.body.length + shifted.body.length));
    expect(() => openBundleArchive(zip)).toThrow(/central directory does not end at the end-of-central-directory record/);
  });

  it('is refused whatever fills the gap', () => {
    const zip = craftZip([{ name: 'a.txt', data: enc('hello') }], { beforeEnd: new Uint8Array(8) }).bytes;
    expect(() => openBundleArchive(zip)).toThrow(/central directory does not end at the end-of-central-directory record/);
  });
});

describe('an entry named twice', () => {
  it('is refused when an Info-ZIP Unicode Path field gives it another name', () => {
    // libzip, and so the directory, takes the name from this extra field when
    // the field's checksum matches the header name. Read that way the archive
    // below has an empty permission.json; read by the header names it has one
    // that asks for the camera.
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Unicode path') },
      { name: 'permission.json', data: CAMERA, centralExtra: unicodePathExtra('permission.json', 'notes/readme.txt') },
      { name: 'declared.json', data: enc('{"permissions":{}}'), centralExtra: unicodePathExtra('declared.json', 'permission.json') },
    ]).bytes;
    expect(() => openBundleArchive(zip)).toThrow(/an entry is named both permission\.json and notes\/readme\.txt/);
  });

  it('keeps a byte order mark in front of a name as part of the name', () => {
    // TextDecoder drops a leading U+FEFF unless told not to, so the bytes
    // EF BB BF "permission.json" were this reader's permission.json and
    // nobody else's.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Bom') },
      { name: concat(bom, enc('permission.json')), data: CAMERA },
    ]).bytes;
    const archive = openBundleArchive(zip);
    expect(archive.has('permission.json')).toBe(false);
    expect(archive.names()).toEqual(['manifest.json', '\ufeffpermission.json']);
  });
});

describe('a directory entry that climbs out', () => {
  it('is reported with the other unsafe names', () => {
    // Directory entries were dropped before the unsafe-name check, so the
    // inspector passed an archive the directory refuses for "../outside/".
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Dir') },
      { name: 'assets/' },
      { name: '../outside/' },
      { name: 'C:/Users/' },
    ]).bytes;
    const archive = openBundleArchive(zip);
    expect(archive.names()).toEqual(['manifest.json']);
    expect(archive.unsafeNames()).toEqual(['../outside/', 'C:/Users/']);
  });
});

describe('entries that overlap', () => {
  it('cannot claim more compressed bytes between them than the file holds', () => {
    // The first entry's data is the second entry whole, header and all, so
    // one megabyte is counted twice over. This was already refused; it is
    // here because it is what keeps the sum of what can be inflated tied to
    // the size of the file.
    const inner = craftRecords([{ name: 'b.bin', data: new Uint8Array(1024 * 1024) }], 30 + 'a.bin'.length);
    const outer = craftRecords([{ name: 'a.bin', payload: inner.body, data: inner.body }]);
    const directory = concat(outer.directory, inner.directory);
    const zip = concat(outer.body, directory, craftEnd(2, directory.length, outer.body.length));
    expect(() => openBundleArchive(zip)).toThrow(/entries claim more data than the file holds/);
  });
});

describe('honest archives keep opening', () => {
  it('with a data descriptor, timestamps in extra fields and an archive comment', () => {
    // What `zip -r` and macOS write: bit 3 set with the sizes after the data,
    // "UT" and "ux" extra fields, a directory entry per folder.
    const ut = new Uint8Array([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    const body = enc('<div>hello</div>');
    const descriptor = new Uint8Array(16);
    const view = new DataView(descriptor.buffer);
    view.setUint32(0, 0x08074b50, true);
    view.setUint32(4, crc32(body), true);
    view.setUint32(8, deflateSync(body).length, true);
    view.setUint32(12, body.length, true);
    const zip = craftZip(
      [
        { name: 'manifest.json', data: manifest('Honest'), centralExtra: ut, localExtra: ut },
        { name: 'ui/' },
        { name: 'ui/main.ui', method: 8, flags: 0x8, payload: concat(deflateSync(body), descriptor), compressedSize: deflateSync(body).length, data: body },
      ],
      { comment: enc('made by hand') }
    ).bytes;
    const files = readBundleEntries(zip);
    expect([...files.keys()]).toEqual(['manifest.json', 'ui/main.ui']);
    expect(dec(files.get('ui/main.ui'))).toBe('<div>hello</div>');
  });

  it('with a Unicode Path field left over from another name', () => {
    // The field carries the CRC of the header name it was written for. When
    // the entry has been renamed since, the CRC no longer matches and libzip
    // ignores the field, as this reader always did: nobody reads a second
    // name there.
    const stale = unicodePathExtra('old-name.txt', 'old-name.txt');
    const zip = craftZip([
      { name: 'manifest.json', data: manifest('Stale') },
      { name: 'notes.txt', data: enc('renamed since'), centralExtra: stale },
    ]).bytes;
    expect([...readBundleEntries(zip).keys()]).toEqual(['manifest.json', 'notes.txt']);
  });

  it('with a Unicode Path field that says what the header says', () => {
    const zip = craftZip([{ name: 'café.ui', data: enc('<div/>'), flags: 0x800, centralExtra: unicodePathExtra('café.ui', 'café.ui') }]).bytes;
    expect([...readBundleEntries(zip).keys()]).toEqual(['café.ui']);
  });

  it('with another archive stored inside, end record and all', () => {
    const inner = zipSync({ 'inner.txt': enc('inside') });
    const zip = zipSync({ 'manifest.json': manifest('Nested'), 'assets/pack.zip': inner, 'assets/empty.zip': craftZip([]).bytes }, { level: 0 });
    const files = readBundleEntries(zip);
    expect(files.get('assets/pack.zip')).toEqual(inner);
    expect(dec(readBundleEntries(files.get('assets/pack.zip')!).get('inner.txt'))).toBe('inside');
  });

  it('with nothing in it', () => {
    expect(readBundleEntries(craftZip([]).bytes).size).toBe(0);
    expect(readBundleEntries(zipSync({})).size).toBe(0);
  });

  it('with bytes before the first entry and after the end record', () => {
    const zip = craftZip([{ name: 'a.txt', data: enc('hello') }], { prefix: enc('#!/bin/sh\n'), trailing: enc('\n') }).bytes;
    expect(dec(readBundleEntries(zip).get('a.txt'))).toBe('hello');
  });
});
