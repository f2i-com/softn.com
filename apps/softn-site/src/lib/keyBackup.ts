/**
 * A backup file of the edit keys, with or without a passphrase.
 *
 * The backup used to be plain JSON only: anyone who found the file — in a
 * download folder, a shared drive, a chat where it was pasted — held every
 * key in it, and a key is the whole of what proves an app is its owner's.
 * With a passphrase the file is encrypted here, in the browser, and opens
 * only with that passphrase; the site never sees it and cannot recover it.
 * Without one the file is what it was, and the page says what that exposes.
 *
 * Version 2 of the format:
 *
 *   { format: 'softn-edit-keys', version: 2, encrypted: true,
 *     kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations },
 *     cipher: 'AES-GCM', salt, iv, ciphertext }
 *
 * with the three byte fields as base64. The key is PBKDF2-SHA-256 over the
 * passphrase with a random 16-byte salt and 310,000 iterations (OWASP's
 * floor for SHA-256 at the time of writing); the plaintext is a version 1
 * file, sealed with AES-GCM under a random 12-byte IV. GCM authenticates,
 * so a wrong passphrase and an altered file are refused the same way, and
 * nothing is imported from either.
 *
 * Version 1 files (plain) still import; `importKeys` in lib/api.ts takes
 * them and refuses an encrypted one, so no caller can mistake the sealed
 * form for a key map.
 */

import { exportKeys, importKeys, type KeyImportResult } from './api';

export const BACKUP_FORMAT = 'softn-edit-keys';
export const PBKDF2_ITERATIONS = 310_000;
/** A file asking for more than this is refused rather than left to pin the CPU: no file of ours asks for it. */
const MAX_ITERATIONS = 5_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBackup {
  format: typeof BACKUP_FORMAT;
  version: 2;
  encrypted: true;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  cipher: 'AES-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
}

/** The shape test alone, on a parsed file. Not a promise that it decrypts. */
export function isEncryptedBackup(parsed: unknown): parsed is EncryptedBackup {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const p = parsed as Record<string, unknown>;
  return p.format === BACKUP_FORMAT && p.version === 2 && p.encrypted === true;
}

/** Whether this file text is the encrypted form. Malformed text is simply not. */
export function isEncryptedBackupText(text: string): boolean {
  try {
    return isEncryptedBackup(JSON.parse(text));
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new BackupError('unsupported', 'This browser has no WebCrypto, so an encrypted backup cannot be made or opened here.');
  return c.subtle;
}

export type BackupErrorKind =
  /** Not a version 2 file at all, or one with a field missing or mangled. */
  | 'malformed'
  /** The file did not open: the passphrase is wrong, or the file has been altered since it was written. */
  | 'cannot-decrypt'
  /** No WebCrypto here. */
  | 'unsupported';

export class BackupError extends Error {
  constructor(
    public readonly kind: BackupErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const s = subtle();
  const material = await s.importKey('raw', new TextEncoder().encode(passphrase) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Seal a plain (version 1) backup under a passphrase. */
export async function encryptBackup(plainJson: string, passphrase: string): Promise<string> {
  if (passphrase === '') throw new BackupError('malformed', 'A passphrase is needed to encrypt the backup.');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS, 'encrypt');
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plainJson) as BufferSource);
  const file: EncryptedBackup = {
    format: BACKUP_FORMAT,
    version: 2,
    encrypted: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS },
    cipher: 'AES-GCM',
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(sealed)),
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Open a sealed backup. What comes back is the plaintext exactly as it was
 * sealed — a version 1 file, to be handed to `importKeys`, which validates
 * it entry by entry like any other.
 */
export async function decryptBackup(text: string, passphrase: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('malformed', 'The file is not JSON.');
  }
  if (!isEncryptedBackup(parsed)) throw new BackupError('malformed', 'The file is not an encrypted key backup.');
  const kdf = parsed.kdf as unknown;
  const iterations = kdf && typeof kdf === 'object' ? (kdf as { iterations?: unknown }).iterations : undefined;
  const kdfOk =
    kdf && typeof kdf === 'object' && (kdf as { name?: unknown }).name === 'PBKDF2' && (kdf as { hash?: unknown }).hash === 'SHA-256' && Number.isInteger(iterations) && (iterations as number) > 0 && (iterations as number) <= MAX_ITERATIONS;
  const salt = fromBase64(parsed.salt);
  const iv = fromBase64(parsed.iv);
  const ciphertext = fromBase64(parsed.ciphertext);
  if (!kdfOk || parsed.cipher !== 'AES-GCM' || !salt || salt.length < 8 || !iv || iv.length < 12 || iv.length > 16 || !ciphertext || ciphertext.length < 16) {
    throw new BackupError('malformed', 'The backup file is damaged: a field it needs is missing or not what it should be.');
  }
  const key = await deriveKey(passphrase, salt, iterations as number, 'decrypt');
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource);
  } catch {
    throw new BackupError('cannot-decrypt', 'That passphrase does not open this backup — or the file has been altered since it was made. Nothing was changed.');
  }
  return new TextDecoder().decode(plain);
}

/** The backup file to hand the visitor: plain without a passphrase, sealed with one. */
export async function exportKeyBackup(passphrase = ''): Promise<string> {
  const plain = exportKeys();
  return passphrase === '' ? plain : encryptBackup(plain, passphrase);
}

export type KeyBackupImport =
  /** The file went in, entry by entry, as `importKeys` reports it. */
  | { kind: 'imported'; result: KeyImportResult }
  /** The file is encrypted and no passphrase was given: ask, then call again with it. Nothing was changed. */
  | { kind: 'needs-passphrase' }
  /** The passphrase did not open it, or the file is damaged. Nothing was changed. */
  | { kind: 'refused'; error: BackupErrorKind; message: string };

/**
 * Take a backup file back in, whichever form it is. A plain file goes
 * straight to `importKeys`; a sealed one is opened first, and only its
 * plaintext ever reaches the key map — a wrong passphrase touches nothing.
 */
export async function importKeyBackup(text: string, passphrase?: string): Promise<KeyBackupImport> {
  if (!isEncryptedBackupText(text)) return { kind: 'imported', result: importKeys(text) };
  if (passphrase === undefined || passphrase === '') return { kind: 'needs-passphrase' };
  try {
    return { kind: 'imported', result: importKeys(await decryptBackup(text, passphrase)) };
  } catch (err) {
    if (err instanceof BackupError) return { kind: 'refused', error: err.kind, message: err.message };
    throw err;
  }
}
