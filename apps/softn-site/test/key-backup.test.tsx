/**
 * A key backup under a passphrase opens only with that passphrase, and a
 * file that does not open changes nothing.
 *
 * The backup was plain JSON only: whoever found the file held every key in
 * it. Pinned here: a backup made with a passphrase is a sealed version 2
 * file that round-trips; a wrong passphrase, a tampered ciphertext and a
 * damaged field are each refused with the stored map byte-for-byte as it
 * was; the plain (version 1) file still imports; the synchronous
 * `importKeys` never reads a sealed file as a key map; and the update
 * page's import prompts for the passphrase, refuses a wrong one in place,
 * and restores the keys with the right one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { importKeys, rememberKey, savedKeys } from '../src/lib/api';
import { PBKDF2_ITERATIONS, decryptBackup, encryptBackup, exportKeyBackup, importKeyBackup, isEncryptedBackupText, type EncryptedBackup } from '../src/lib/keyBackup';
import { KeyImport } from '../src/pages/PublishPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS = 'softn.site.editKeys';
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const PASS = 'correct horse battery staple';

function bytesOf(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

beforeEach(() => {
  localStorage.clear();
});

describe('the sealed backup', () => {
  it('round-trips under its passphrase as a version 2 file with fresh salt and IV', async () => {
    expect(rememberKey('notes', KEY_A)).toBe('stored');
    expect(rememberKey('snake', KEY_B)).toBe('stored');
    const text = await exportKeyBackup(PASS);
    const file = JSON.parse(text) as EncryptedBackup;
    expect(file).toMatchObject({ format: 'softn-edit-keys', version: 2, encrypted: true, cipher: 'AES-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS } });
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(310_000);
    expect(bytesOf(file.salt).length).toBe(16);
    expect(bytesOf(file.iv).length).toBe(12);
    // The keys are nowhere in the file as written.
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain('notes');
    // Two backups of the same keys never share salt, IV or ciphertext.
    const again = JSON.parse(await exportKeyBackup(PASS)) as EncryptedBackup;
    expect(again.salt).not.toBe(file.salt);
    expect(again.iv).not.toBe(file.iv);
    expect(again.ciphertext).not.toBe(file.ciphertext);

    localStorage.clear();
    const outcome = await importKeyBackup(text, PASS);
    expect(outcome).toMatchObject({ kind: 'imported', result: { added: ['notes', 'snake'], rejected: [], stored: 'stored' } });
    expect(savedKeys()).toEqual({ notes: KEY_A, snake: KEY_B });
  });

  it('refuses a wrong passphrase with a clear message and leaves the stored map untouched', async () => {
    rememberKey('notes', KEY_A);
    const text = await exportKeyBackup(PASS);
    localStorage.setItem(KEYS, JSON.stringify({ notes: KEY_B, other: KEY_B }));
    const before = localStorage.getItem(KEYS);

    const outcome = await importKeyBackup(text, 'wrong passphrase');
    expect(outcome).toMatchObject({ kind: 'refused', error: 'cannot-decrypt' });
    expect((outcome as { message: string }).message).toMatch(/passphrase/);
    expect(localStorage.getItem(KEYS)).toBe(before);

    // No passphrase at all: the caller is told to ask, and nothing moves.
    expect(await importKeyBackup(text)).toEqual({ kind: 'needs-passphrase' });
    expect(await importKeyBackup(text, '')).toEqual({ kind: 'needs-passphrase' });
    expect(localStorage.getItem(KEYS)).toBe(before);
  });

  it('is never read as a key map by the plain importer', async () => {
    rememberKey('notes', KEY_A);
    const text = await exportKeyBackup(PASS);
    localStorage.setItem(KEYS, JSON.stringify({ other: KEY_B }));
    const before = localStorage.getItem(KEYS);
    const result = importKeys(text);
    expect(result.encrypted).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(localStorage.getItem(KEYS)).toBe(before);
    expect(isEncryptedBackupText(text)).toBe(true);
    expect(isEncryptedBackupText('{"keys":{}}')).toBe(false);
    expect(isEncryptedBackupText('not json')).toBe(false);
  });

  it('rejects a tampered ciphertext and a damaged field, changing nothing', async () => {
    rememberKey('notes', KEY_A);
    const file = JSON.parse(await exportKeyBackup(PASS)) as EncryptedBackup;
    localStorage.setItem(KEYS, JSON.stringify({ other: KEY_B }));
    const before = localStorage.getItem(KEYS);

    const cipher = bytesOf(file.ciphertext);
    cipher[3] ^= 0x01;
    const tampered = { ...file, ciphertext: btoa(String.fromCharCode(...cipher)) };
    expect(await importKeyBackup(JSON.stringify(tampered), PASS)).toMatchObject({ kind: 'refused', error: 'cannot-decrypt' });
    expect(localStorage.getItem(KEYS)).toBe(before);

    // A different salt derives a different key: refused the same way.
    const resalted = { ...file, salt: btoa(String.fromCharCode(...new Uint8Array(16))) };
    expect(await importKeyBackup(JSON.stringify(resalted), PASS)).toMatchObject({ kind: 'refused', error: 'cannot-decrypt' });

    // Fields that are not what they should be are refused before any work.
    expect(await importKeyBackup(JSON.stringify({ ...file, salt: '***' }), PASS)).toMatchObject({ kind: 'refused', error: 'malformed' });
    expect(await importKeyBackup(JSON.stringify({ ...file, kdf: { ...file.kdf, iterations: 1e9 } }), PASS)).toMatchObject({ kind: 'refused', error: 'malformed' });
    expect(await importKeyBackup(JSON.stringify({ ...file, cipher: 'AES-CBC' }), PASS)).toMatchObject({ kind: 'refused', error: 'malformed' });
    await expect(decryptBackup('{"format":"softn-edit-keys","version":1,"keys":{}}', PASS)).rejects.toMatchObject({ kind: 'malformed' });
    expect(localStorage.getItem(KEYS)).toBe(before);
  });

  it('still imports a plain version 1 file, and exports one when no passphrase is given', async () => {
    const plain = JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: { notes: KEY_A } });
    expect(await importKeyBackup(plain)).toMatchObject({ kind: 'imported', result: { added: ['notes'] } });
    expect(savedKeys()).toEqual({ notes: KEY_A });
    // A passphrase given for a plain file is simply not needed.
    expect(await importKeyBackup(plain, 'whatever')).toMatchObject({ kind: 'imported', result: { unchanged: ['notes'] } });

    const exported = await exportKeyBackup();
    expect(JSON.parse(exported)).toEqual({ format: 'softn-edit-keys', version: 1, keys: { notes: KEY_A } });
    expect(await exportKeyBackup('')).toBe(exported);
    await expect(encryptBackup(exported, '')).rejects.toMatchObject({ kind: 'malformed' });
  });
});

describe('the import control on the update page', () => {
  let container: HTMLElement;
  let root: Root;

  /** jsdom's File has no text(); FileReader does the job. */
  function textOf(this: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  }

  beforeEach(() => {
    Object.defineProperty(File.prototype, 'text', { value: textOf, configurable: true, writable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (File.prototype as unknown as { text?: unknown }).text;
  });

  /**
   * Let the component finish what a file or a click started. A sealed
   * backup is opened with a real key derivation — 310,000 PBKDF2 rounds —
   * whose time is the machine's, not the event loop's: eight turns of the
   * loop were enough here and not on the CI runner. So this waits for what
   * the test is about to assert, up to a generous ceiling, and only then
   * returns; without a condition it settles a few turns as before.
   */
  async function settle(until?: () => boolean, timeoutMs = 15000): Promise<void> {
    const started = Date.now();
    for (let i = 0; ; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, until ? 25 : 0));
      });
      if (until ? until() : i >= 7) return;
      if (Date.now() - started > timeoutMs) throw new Error('settle: the condition did not become true in time');
    }
  }

  const give = (file: File) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('asks for the passphrase, refuses a wrong one in place, and restores with the right one', async () => {
    rememberKey('notes', KEY_A);
    const sealed = new File([await exportKeyBackup(PASS)], 'softn-edit-keys.json', { type: 'application/json' });
    localStorage.setItem(KEYS, JSON.stringify({ other: KEY_B }));
    const before = localStorage.getItem(KEYS);
    const onImported = vi.fn();
    act(() => {
      root.render(<KeyImport onImported={onImported} />);
    });

    give(sealed);
    await settle(() => container.textContent?.includes('is encrypted') ?? false);
    expect(container.textContent).toContain('softn-edit-keys.json is encrypted');
    const passphrase = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Open the backup')!;
    expect(open.disabled).toBe(true);

    type(passphrase, 'nope');
    expect(open.disabled).toBe(false);
    act(() => open.click());
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/passphrase/);
    expect(localStorage.getItem(KEYS)).toBe(before);
    expect(onImported).not.toHaveBeenCalled();
    // The prompt is still there for another go.
    expect(container.querySelector('input[type="password"]')).toBe(passphrase);

    type(passphrase, PASS);
    act(() => open.click());
    await settle(() => container.querySelector('[role="status"]') !== null);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 key restored');
    expect(savedKeys()).toEqual({ other: KEY_B, notes: KEY_A });
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('takes a plain file without asking', async () => {
    act(() => {
      root.render(<KeyImport />);
    });
    give(new File([JSON.stringify({ format: 'softn-edit-keys', version: 1, keys: { notes: KEY_A } })], 'keys.json'));
    await settle(() => container.querySelector('[role="status"]') !== null);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 key restored');
    expect(savedKeys()).toEqual({ notes: KEY_A });
  });
});
