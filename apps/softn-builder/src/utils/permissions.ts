/**
 * What a Builder project declares it needs, and the permission.json that says so.
 *
 * A bundle without a permission.json declares nothing, and the runtime gives
 * it nothing: an app whose logic calls `softn.storage` or `softn.net.fetch`
 * fails closed at every call. Builder exported exactly that for every project,
 * so a Builder app could not use the network or its server storage however
 * its author wrote it. The declaration lives on the project now, is written
 * into every export, and is read back from every bundle opened.
 *
 * The names are the capability schema's; the storage policies are the
 * schema's too, and Builder knows the collections, so it can declare a
 * policy for each.
 *
 * A file holds more than that: the app's identity (`app.id`, which its sync
 * rooms are scoped by), the limits a capability is declared with
 * (`ai.allowedSources`, `mic.maxSeconds`, ...), and capabilities a newer
 * schema has. The Builder wrote only what it models, so an export of an app
 * nobody had touched took all of that out of it. The file is kept as it was
 * read, and written back as it came, or with only what the Builder models
 * changed in it.
 */

import { CAPABILITIES, inspectDeclaration, type Capability, type StoragePolicy } from '@softn/core';

export interface PermissionDeclaration {
  /** Capabilities the app asks for, in schema order. */
  capabilities: Capability[];
  /** Hosts `net` may reach; empty means any host, after consent. */
  allowedHosts: string[];
  /** Plain-HTTP servers allowed for `net`, for a development server on localhost. */
  allowHttp: boolean;
  /** A storage policy per collection (`*` for the rest); absent collections are public. */
  storagePolicies: Record<string, StoragePolicy>;
  /**
   * The project has a permission.json, whatever it declares: the bundle it
   * was opened from came with one. A file that declares nothing is still a
   * file, and is written back as one (buildPermissionJson).
   */
  file?: boolean;
  /** The file as it was read, which is written back with only what is declared here changed in it. */
  source?: string;
}

export function emptyDeclaration(): PermissionDeclaration {
  return { capabilities: [], allowedHosts: [], allowHttp: false, storagePolicies: {} };
}

/**
 * The permission.json for a declaration, or null when nothing is declared
 * and the project has no such file.
 *
 * A declaration is empty when it enables nothing: a file with no
 * `permissions`, with an empty one, or with every entry switched off. It
 * was not written at all, so a bundle that came with `{ "permissions": {} }`
 * (Studio writes one into every app, as the place to say what the app may
 * use) left without the file, and was then told it had none. A file the
 * bundle came with goes back as a file: `{ "permissions": {} }`, which
 * declares what the file it replaces declared.
 */
export function buildPermissionJson(decl: PermissionDeclaration): string | null {
  if (decl.source !== undefined) {
    const kept = keptPermissionJson(decl.source, decl);
    if (kept !== null) return kept;
  }
  const permissions: Record<string, Record<string, unknown>> = {};
  for (const name of CAPABILITIES) {
    if (!decl.capabilities.includes(name)) continue;
    const entry: Record<string, unknown> = { enabled: true };
    if (name === 'net') {
      const hosts = decl.allowedHosts.map((h) => h.trim()).filter(Boolean);
      if (hosts.length > 0) entry.allowed_hosts = hosts;
      if (decl.allowHttp) entry.allow_http = true;
    }
    if (name === 'storage') {
      const policies = Object.fromEntries(Object.entries(decl.storagePolicies).filter(([, p]) => p && p !== 'public'));
      if (Object.keys(policies).length > 0) entry.collections = policies;
    }
    permissions[name] = entry;
  }
  if (Object.keys(permissions).length === 0 && !decl.file) return null;
  return JSON.stringify({ permissions }, null, 2);
}

/** The parts of a declaration the Builder models, in one spelling, for comparing two. */
function modelled(decl: PermissionDeclaration): string {
  return JSON.stringify([
    [...decl.capabilities].sort(),
    decl.allowedHosts.map((host) => host.trim()).filter(Boolean),
    decl.allowHttp,
    Object.entries(decl.storagePolicies).filter(([, policy]) => policy && policy !== 'public').sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The file `source` with `decl` written into it: as it is when it declares
 * what `decl` does, else with the capabilities `decl` asks for, `net`'s
 * hosts and `storage`'s policies changed, and everything else in it kept.
 * Null for a file that is not a JSON object, which is written anew.
 */
function keptPermissionJson(source: string, decl: PermissionDeclaration): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (modelled(readPermissionJson(source)) === modelled(decl)) return source;

  const was = isRecord(parsed.permissions) ? parsed.permissions : {};
  const permissions: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(was)) {
    // A capability not asked for is not written, as the Builder writes none it does not ask for.
    if ((CAPABILITIES as readonly string[]).includes(name) && !decl.capabilities.includes(name as Capability)) continue;
    permissions[name] = entry;
  }
  for (const name of CAPABILITIES) {
    if (!decl.capabilities.includes(name)) continue;
    const entry: Record<string, unknown> = { ...(isRecord(permissions[name]) ? permissions[name] : {}), enabled: true };
    if (name === 'net') {
      const hosts = decl.allowedHosts.map((h) => h.trim()).filter(Boolean);
      if (hosts.length > 0) entry.allowed_hosts = hosts;
      else delete entry.allowed_hosts;
      if (decl.allowHttp) entry.allow_http = true;
      else if ('allow_http' in entry) entry.allow_http = false;
    }
    if (name === 'storage') {
      const named = isRecord(entry.collections) ? entry.collections : {};
      // A collection the file names as public stays named while it is.
      const policies = Object.fromEntries(Object.entries(decl.storagePolicies).filter(([collection, p]) => p && (p !== 'public' || collection in named)));
      if (Object.keys(policies).length > 0) entry.collections = policies;
      else delete entry.collections;
    }
    permissions[name] = entry;
  }
  return JSON.stringify({ ...parsed, permissions }, null, 2);
}

/** A declaration read back from a bundle's permission.json; unknown or malformed parts are dropped from it, and kept in the file. */
export function readPermissionJson(text: string): PermissionDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyDeclaration();
  }
  // Read from a file, so the project has one to write back (PermissionDeclaration.file).
  const report = inspectDeclaration(parsed);
  const net = (parsed as { permissions?: { net?: { allowed_hosts?: unknown; allow_http?: unknown } } })?.permissions?.net;
  const allowedHosts = Array.isArray(net?.allowed_hosts) ? net.allowed_hosts.filter((h): h is string => typeof h === 'string') : [];
  return {
    capabilities: report.requested,
    allowedHosts,
    allowHttp: net?.allow_http === true,
    storagePolicies: report.storagePolicies,
    file: true,
    source: text,
  };
}

