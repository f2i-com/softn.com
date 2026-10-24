/**
 * `softn.files.*`: the files the person chooses for an app, and the files an
 * app gives them. Each is gated on `files`: an app that may open the
 * person's files may also give them one.
 */

import { sha256Hex } from '../../bundle/crypto';
import { getFileByRef, registerFileRef } from '../file-registry';
import type { PendingHostCall } from '../script-runtime-types';
import { readZipText as readZipEntries } from '../zip-text';
import type { HostGate } from './permissions';

/**
 * Kinds of file a double-click runs rather than opens: programs, scripts,
 * installers and packages, shortcuts, and the shell's own formats that run
 * something (a help file, a management console, a troubleshooter, a saved
 * search or library, a disk image that mounts and shows its programs).
 */
const RUNS_WHEN_OPENED =
  /\.(?:exe|com|bat|cmd|msi|msix|msixbundle|appx|appxbundle|appinstaller|msp|scr|pif|lnk|url|hta|js|jse|vbs|vbe|wsf|wsh|ws|wsc|ps1|psm1|reg|cpl|msc|chm|diagcab|library-ms|search-ms|settingcontent-ms|xll|xbap|jnlp|iso|img|vhd|vhdx|jar|app|dmg|pkg|command|desktop|appimage|deb|rpm|apk|sh|scf|inf|gadget|application|appref-ms)$/i;

/**
 * The name a file an app saves is offered under. A leaf, never a path, so an
 * app cannot suggest "../.bashrc"; no control characters, and none of the
 * invisible ones that turn text around (`report\u202efdp.exe` reads as
 * `reportexe.pdf`); not a name Windows keeps for a device; and a kind of file
 * that runs when it is opened is saved as text, so a click in an app is never
 * a program on the person's desktop.
 */
export function downloadName(raw: unknown): string {
  let name = String(raw || 'download')
    // The control characters are the point of the pattern, not a slip.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 200);
  if (!name) name = 'download';
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)) name = `_${name}`;
  if (RUNS_WHEN_OPENED.test(name)) name = `${name}.txt`;
  return name;
}

export async function pickFile(gate: HostGate, call: PendingHostCall): Promise<unknown> {
  gate.checkPermission('files');
  const options = call.args[0] ? JSON.parse(call.args[0]) : {};
  return new Promise<unknown>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.accept) input.accept = options.accept;
    if (options.multiple) input.multiple = true;
    input.onchange = () => {
      // Chosen after the app closed: registered then, the file was owned by
      // a gate nothing would release again, and kept for the page's life.
      if (gate.disposed()) {
        resolve([]);
        return;
      }
      const files = Array.from(input.files || []);
      const result = files.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        // Owned by the app's gate, so closing the app lets them go.
        ref: registerFileRef(f, gate),
      }));
      resolve(result);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function readText(gate: HostGate, call: PendingHostCall): Promise<unknown> {
  gate.checkPermission('files');
  const [fileRef] = call.args;
  const file = getFileByRef(fileRef);
  if (!file) throw new Error(`File not found: ${fileRef}`);
  return await file.text();
}

export async function readBase64(gate: HostGate, call: PendingHostCall): Promise<unknown> {
  gate.checkPermission('files');
  const [fileRef] = call.args;
  const file = getFileByRef(fileRef);
  if (!file) throw new Error(`File not found: ${fileRef}`);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Save a file the app produced: the content becomes a Blob and the browser's
 * own download handles the rest, so where it lands and whether it is
 * confirmed is the user's setting, not the app's. Text by default; with
 * `base64: true` the content is decoded to bytes first, which is how an
 * app hands over an image or a zip. Gated with the other file calls: an
 * app that may open the user's files may also give them one.
 */
export async function saveFile(gate: HostGate, call: PendingHostCall): Promise<unknown> {
  gate.checkPermission('files');
  const [rawName, content, optionsJson] = call.args;
  let options: { mime?: string; base64?: boolean } = {};
  if (optionsJson) {
    try {
      options = JSON.parse(optionsJson) as { mime?: string; base64?: boolean };
    } catch {
      return { error: 'The save options are not valid JSON.' };
    }
  }
  // A download the person asked for, with a click or a key: not one an app
  // starts on a timer, as many as it likes, attributed to the host's site.
  const activation = typeof navigator === 'undefined' ? undefined : (navigator as { userActivation?: { isActive?: boolean } }).userActivation;
  if (activation && activation.isActive === false) {
    return { error: 'A file is saved when the person asks for it: call files.saveFile from a click or a key press.' };
  }
  const name = downloadName(rawName);
  // A type the content says it is, or bytes.
  const mime =
    typeof options.mime === 'string' && /^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/.test(options.mime)
      ? options.mime
      : options.base64
        ? 'application/octet-stream'
        : 'text/plain;charset=utf-8';
  let blob: Blob;
  if (options.base64) {
    let buffer: ArrayBuffer;
    try {
      const bin = atob(String(content || '').replace(/^data:[^,]*,/, ''));
      buffer = new ArrayBuffer(bin.length);
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return { error: 'The content is not valid base64.' };
    }
    blob = new Blob([buffer], { type: mime });
  } else {
    blob = new Blob([String(content ?? '')], { type: mime });
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { error: 'Saving files is not available here.' };
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // The click has started the download; the URL only needs to outlive it.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return { ok: true, name, size: blob.size };
}

/** The text files in a ZIP the person chose, with the archive's SHA-256. */
export async function readZipText(gate: HostGate, call: PendingHostCall): Promise<unknown> {
  gate.checkPermission('files');
  const file = getFileByRef(call.args[0]);
  if (!file || file.size > 262144) throw Error('Choose a ZIP smaller than 256 KiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = readZipEntries(bytes);
  return { files, hash: await sha256Hex(bytes) };
}
