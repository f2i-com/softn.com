/**
 * The rules the Files panel holds a file to when a person makes, names or
 * brings one in (lib/fileRules.ts): what a name comes to, what a clash
 * becomes, how much an app may carry, and whether a file from the computer is
 * kept as text or as bytes.
 */

import { readFileSync } from 'node:fs';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_APP_BYTES,
  MAX_APP_FILES,
  MAX_FILE_BYTES,
  appLimitReason,
  belongsAtTheTop,
  cleanFileName,
  emptyFileProblem,
  freeName,
  keptContent,
  newPathProblem,
  pastedName,
  shortSize,
  sizeWords,
  starterContent,
  takenKeys,
  tooLargeReason,
  typedName,
} from '../src/lib/fileRules';

describe('a name as the project keeps it', () => {
  it('keeps an ordinary name as it is', () => {
    expect(cleanFileName('logo.png')).toBe('logo.png');
    expect(cleanFileName('Team_Photo-2.JPG')).toBe('Team_Photo-2.JPG');
  });

  it('makes spaces hyphens, as the Builder does, so the path is one word', () => {
    expect(cleanFileName('team photo  final.png')).toBe('team-photo-final.png');
  });

  it('takes out what a bundle cannot hold and what asset("…") cannot be read back with', () => {
    expect(cleanFileName('a"b\'c`d<e>f|g?h*i:j.png')).toBe('abcdefghij.png');
    expect(cleanFileName(`tab${String.fromCharCode(9)}bed${String.fromCharCode(0)}.txt`)).toBe('tabbed.txt');
    // Two dots in a row are a way out of the bundle to every SoftN reader.
    expect(cleanFileName('version..2...png')).toBe('version.2.png');
    expect(cleanFileName('..hidden')).toBe('hidden');
  });

  it('keeps only the last part of a path from another computer', () => {
    expect(cleanFileName('C:\\Users\\me\\Pictures\\logo.png')).toBe('logo.png');
    expect(cleanFileName('photos/2024/beach.jpg')).toBe('beach.jpg');
  });

  it('is never empty', () => {
    expect(cleanFileName('')).toBe('file');
    expect(cleanFileName('   ')).toBe('file');
    expect(cleanFileName('...')).toBe('file');
  });
});

describe('a name that is typed', () => {
  it('says the name the file will have, and whether it is what was typed', () => {
    expect(typedName('brand.png')).toEqual({ ok: true, name: 'brand.png', changed: false });
    expect(typedName('  brand.png ')).toEqual({ ok: true, name: 'brand.png', changed: false });
    expect(typedName('my brand.png')).toEqual({ ok: true, name: 'my-brand.png', changed: true });
  });

  it('refuses a slash with the way to move a file, never dropping the folder without a word', () => {
    const verdict = typedName('icons/brand.png');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(/cannot hold a slash/);
    expect(typedName('icons\\brand.png').ok).toBe(false);
  });

  it('refuses nothing, and a name with nothing in it to name a file by', () => {
    expect(typedName('   ')).toEqual({ ok: false, reason: 'Type a name.' });
    expect(typedName('...').ok).toBe(false);
    expect(typedName('??').ok).toBe(false);
    // A file really called "file" is fine.
    expect(typedName('file')).toEqual({ ok: true, name: 'file', changed: false });
  });
});

describe('a name that is taken', () => {
  const taken = takenKeys(['assets/logo.png', 'assets/logo-2.png', 'assets/icons/home.svg', 'index.html'], ['drafts']);

  it('is numbered before its ending, as the Builder numbers it', () => {
    expect(freeName(taken, 'assets', 'logo.png')).toBe('logo-3.png');
    expect(freeName(taken, 'assets', 'new.png')).toBe('new.png');
    expect(freeName(taken, '', 'index.html')).toBe('index-2.html');
  });

  it('is taken in any case: the project may be unpacked on a disk that folds it', () => {
    expect(freeName(taken, 'assets', 'LOGO.PNG')).toBe('LOGO-3.PNG');
    expect(freeName(taken, 'Assets', 'logo.png')).toBe('logo-3.png');
  });

  it('is taken by a folder too: a disk holds a file or a folder of one name, not both', () => {
    expect(freeName(taken, 'assets', 'icons')).toBe('icons-2');
    expect(freeName(taken, '', 'assets', true)).toBe('assets-2');
    // A folder the person made and has not filled yet has its name as well.
    expect(freeName(taken, '', 'drafts', true)).toBe('drafts-2');
  });

  it('numbers a folder at its end, whatever dots it has', () => {
    const versions = takenKeys(['v1.2/notes.txt']);
    expect(freeName(versions, '', 'v1.2', true)).toBe('v1.2-2');
    expect(freeName(versions, '', 'v1.2', false)).toBe('v1-2.2');
  });
});

describe('what a new file may be', () => {
  it('is not one of Studio’s own notes', () => {
    expect(newPathProblem('builder/notes.md')).toMatch(/Studio keeps its own notes/);
    expect(newPathProblem('Builder/notes.md')).toMatch(/Studio keeps its own notes/);
    expect(newPathProblem('assets/notes.md')).toBeNull();
  });

  it('has a name Python can import when it is a Python module', () => {
    expect(newPathProblem('my-module.py')).toMatch(/cannot be a Python module/);
    expect(newPathProblem('helpers.py')).toBeNull();
  });

  it('cannot be a picture that starts as nothing', () => {
    expect(emptyFileProblem('assets/logo.png')).toMatch(/a picture, which cannot start empty\. Use Add files/);
    expect(emptyFileProblem('assets/song.mp3')).toMatch(/a sound/);
    expect(emptyFileProblem('notes.txt')).toBeNull();
    // An SVG is markup: it can be written.
    expect(emptyFileProblem('assets/icon.svg')).toBeNull();
  });

  it('starts as valid JSON where it has to be JSON, and empty otherwise', () => {
    expect(JSON.parse(starterContent('data/settings.json'))).toEqual({});
    expect(starterContent('pages/about.html')).toBe('');
  });
});

describe('how much an app may carry', () => {
  // The reader keeps two of its three numbers to itself; these are held to its source.
  const reader = readFileSync(new URL('../../../packages/@softn/bundle-format/src/zip.ts', import.meta.url), 'utf8');
  const constant = (name: string): number => {
    const match = new RegExp(`const ${name} = ([0-9_* ]+);`).exec(reader);
    if (!match) throw new Error(`${name} is not in the reader`);
    return match[1].split('*').reduce((product, part) => product * Number(part.replace(/_/g, '').trim()), 1);
  };

  it('is what every SoftN reader opens: its own numbers', () => {
    expect(MAX_FILE_BYTES).toBe(constant('MAX_ZIP_FILE_BYTES'));
    expect(MAX_APP_FILES).toBe(constant('MAX_ZIP_ENTRIES'));
    expect(MAX_APP_BYTES).toBe(MAX_ZIP_INPUT_BYTES);
    expect(MAX_APP_BYTES).toBe(constant('MAX_ZIP_INPUT_BYTES'));
  });

  it('refuses one file that is too large, saying the limit', () => {
    expect(tooLargeReason('film.mp4', MAX_FILE_BYTES)).toBeNull();
    expect(tooLargeReason('film.mp4', MAX_FILE_BYTES + 1)).toBe('film.mp4 is 51 MB, and one file of an app can be 50 MB at most.');
  });

  it('refuses what would take the app past the size of a bundle, saying the limit', () => {
    expect(appLimitReason(10, 1000, 1, 2000)).toBeNull();
    expect(appLimitReason(10, MAX_APP_BYTES - 10, 1, 10)).toBeNull();
    expect(appLimitReason(10, MAX_APP_BYTES - 10, 1, 11)).toBe('That would make the app 201 MB, and an app can be 200 MB at most.');
  });

  it('refuses one file more than a bundle holds, saying the limit', () => {
    expect(appLimitReason(MAX_APP_FILES - 1, 0, 1, 0)).toBeNull();
    expect(appLimitReason(MAX_APP_FILES, 0, 1, 0)).toBe('An app can hold 10,000 files at most, and this one has 10,000.');
  });

  it('says a size in words and beside a name', () => {
    expect(sizeWords(1)).toBe('1 byte');
    expect(sizeWords(812)).toBe('812 bytes');
    expect(sizeWords(47514)).toBe('46.4 KB');
    expect(shortSize(812)).toBe('812 B');
    expect(shortSize(47514)).toBe('46 KB');
    expect(shortSize(2.3 * 1024 * 1024)).toBe('2.3 MB');
    expect(shortSize(48 * 1024 * 1024)).toBe('48 MB');
  });
});

describe('a file from the computer, as the project keeps it', () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);

  it('keeps a page, logic, JSON and an SVG as text, so they can be read and edited', () => {
    expect(keptContent('pages/about.html', utf8('<h1>About</h1>'))).toEqual({ ok: true, content: '<h1>About</h1>' });
    expect(keptContent('main.js', utf8('let n = 1'))).toEqual({ ok: true, content: 'let n = 1' });
    expect(keptContent('assets/icon.svg', utf8('<svg/>'))).toEqual({ ok: true, content: '<svg/>' });
  });

  it('keeps a picture as the bytes it is', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const kept = keptContent('assets/logo.png', png);
    expect(kept.ok && kept.content).toBe(png);
  });

  it('keeps a file of a kind nothing names as text when its bytes are text, and as bytes when they are not', () => {
    expect(keptContent('assets/notes.custom', utf8('plain words'))).toEqual({ ok: true, content: 'plain words' });
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const kept = keptContent('assets/blob.custom', bytes);
    expect(kept.ok && kept.content).toBe(bytes);
  });

  it('refuses a page that is not UTF-8, where reading it as text would lose what did not decode', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const kept = keptContent('pages/menu.html', latin1);
    expect(kept.ok).toBe(false);
    expect(kept.ok ? '' : kept.reason).toBe('menu.html is not UTF-8 text, which a file of its kind has to be. Save it as UTF-8 and add it again.');
  });
});

describe('where a file goes when no folder was pointed at', () => {
  it('is the top of the project for the app’s own source and settings', () => {
    for (const path of ['about.html', 'card.ui', 'main.js', 'helpers.py', 'site.css', 'data.json', 'books.xdb']) {
      expect(belongsAtTheTop(path), path).toBe(true);
    }
  });

  it('is with the assets for what the app shows or serves', () => {
    for (const path of ['logo.png', 'icon.svg', 'song.mp3', 'clip.mp4', 'body.woff2', 'guide.pdf', 'notes.txt', 'table.csv']) {
      expect(belongsAtTheTop(path), path).toBe(false);
    }
  });
});

describe('a picture pasted from the clipboard', () => {
  const now = 1_800_000_000_000;

  it('is named for what it is when the clipboard called it image.png a moment ago', () => {
    expect(pastedName({ name: 'image.png', type: 'image/png', lastModified: now - 200 }, now)).toBe('pasted-picture.png');
    expect(pastedName({ name: '', type: 'image/jpeg', lastModified: now }, now)).toBe('pasted-picture.jpg');
  });

  it('keeps the name of a file that was copied from a folder', () => {
    expect(pastedName({ name: 'beach.jpg', type: 'image/jpeg', lastModified: now - 86_400_000 }, now)).toBe('beach.jpg');
    // A file that really is called image.png, made long ago, is that file.
    expect(pastedName({ name: 'image.png', type: 'image/png', lastModified: now - 86_400_000 }, now)).toBe('image.png');
  });
});
